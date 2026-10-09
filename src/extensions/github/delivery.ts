// Delivery extension `github-delivery` (spec §3.2, §7): push to `main` for a new repo, open a PR from the run's branch
// for an existing repo. Writes advisory findings into the PR description or docs/delivery-notes.md. Owns `ci` (§6).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseDuration } from "../../core/settings.ts";
import type { CiStatus, Delivery, DeliveryContext, DeliveryExtension, Finding, StageCallOptions, Workspace } from "../../core/types.ts";
import { git, gitOut } from "../git.ts";
import type { GitHubHost } from "./host.ts";
import { identityOf } from "./repo.ts";

const OK_CONCLUSIONS = ["success", "neutral", "skipped"];

function findingLines(title: string, fs: Finding[]): string[] {
	if (!fs.length) return [];
	return [
		`## ${title}`,
		"",
		...fs.map((f) => `- **${f.severity}**${f.specRef ? ` (spec: ${f.specRef})` : ""}: ${f.description}${f.evidence ? `\n  <details><summary>evidence</summary>\n\n  \`\`\`\n  ${f.evidence.slice(0, 1500).replace(/\n/g, "\n  ")}\n  \`\`\`\n  </details>` : ""}`),
		"",
	];
}

export function report(ctx: Pick<DeliveryContext, "request" | "advisory" | "acceptedBlocking" | "runId" | "spec">, notes: string[] = []): string {
	return [
		`Delivered by the software factory (run \`${ctx.runId}\`).`,
		"",
		`**Request:** ${ctx.request.title}`,
		"",
		`The spec (v${ctx.spec.version ?? 1}) is in \`docs/spec.md\` and is the contract this change was built and reviewed against.`,
		"",
		...findingLines("Advisory findings (non-blocking)", ctx.advisory),
		...findingLines("Open blocking findings accepted as is by a human", ctx.acceptedBlocking),
		...notes.map((n) => `> ${n}`),
	].join("\n");
}

export function githubDelivery(host: GitHubHost): DeliveryExtension {
	const authFor = (settings: Record<string, any>) => host.gitAuth(identityOf(settings));
	// The delivery extension uses the repo extension's identity (`stages.repo.identity`) from the run's pinned stages.
	const repoCfgOf = (o?: { stages?: Record<string, any> }) => (o?.stages?.repo ?? {}) as Record<string, any>;
	const ext: DeliveryExtension = {
		kind: "delivery",
		name: "github-delivery",
		settings: {
			schema: {
				newRepo: { type: "enum", values: ["push-main"], default: "push-main", description: "Delivery for a new repo" },
				existingRepo: { type: "enum", values: ["pull-request"], default: "pull-request", description: "Delivery for an existing repo" },
				ci: {
					type: "object",
					description: "CI on the delivered commit (owned by the delivery extension)",
					fields: {
						mode: { type: "enum", values: ["off", "if-present", "required"], default: "if-present", description: "off | if-present | required" },
						fixRounds: { type: "number", default: 2, min: 0, max: 3, description: "CI fix rounds before escalation (0–3)" },
						checks: { type: "list", of: { type: "string", description: "check name" }, default: [], description: "Names of the checks that count; empty = all" },
						noChecksTimeout: { type: "string", default: "2m", description: "If no checks appear by then, the repo has no CI (e.g. 2m, 90s)" },
					},
				},
			},
			validate(value) {
				const v = value as Record<string, any>;
				const t = v?.ci?.noChecksTimeout;
				const problems: string[] = [];
				if (t !== undefined && !(parseDuration(t) >= 0)) problems.push(`ci.noChecksTimeout: "${t}" is not a duration (e.g. 2m, 90s, 500ms)`);
				const fr = v?.ci?.fixRounds;
				if (fr !== undefined && !Number.isInteger(fr)) problems.push("ci.fixRounds must be a whole number");
				return problems;
			},
		},

		async deliver(ws: Workspace, ctx: DeliveryContext): Promise<Delivery> {
			const repoCfg = repoCfgOf(ctx);
			const id = identityOf(repoCfg);
			const auth = await authFor(repoCfg);
			// Commit whatever the builder left uncommitted, so the delivered commit is the reviewed tree.
			await git(ws.path, ["add", "-A"]);
			if ((await git(ws.path, ["diff", "--cached", "--quiet"], { allowFail: true })).code !== 0)
				await git(ws.path, ["commit", "-q", "-m", "factory: commit uncommitted builder changes"]);
			const remotes = await gitOut(ws.path, ["remote"]);
			if (!remotes.split("\n").includes("origin")) await git(ws.path, ["remote", "add", "origin", host.remoteUrl(ws.repo)]);

			if (ctx.mode === "push-main") {
				const note = join(ws.path, "docs", "delivery-notes.md");
				mkdirSync(dirname(note), { recursive: true });
				writeFileSync(note, `# Delivery notes\n\n${report(ctx)}\n`);
				await git(ws.path, ["add", "docs/delivery-notes.md"]);
				if ((await git(ws.path, ["diff", "--cached", "--quiet"], { allowFail: true })).code !== 0)
					await git(ws.path, ["commit", "-q", "-m", "docs: delivery notes"]);
				await git(ws.path, ["push", "-q", "origin", "HEAD:refs/heads/main"], auth);
				const sha = await gitOut(ws.path, ["rev-parse", "HEAD"]);
				return { kind: "repo", url: host.webUrl(ws.repo), ref: "main", sha };
			}
			await git(ws.path, ["push", "-q", "--force", "origin", `HEAD:refs/heads/${ws.branch}`], auth);
			const sha = await gitOut(ws.path, ["rev-parse", "HEAD"]);
			const base = await host.defaultBranch(ws.repo, id);
			const body = report(ctx);
			let pr = await host.findPr(ws.repo, ws.branch, id);
			if (pr && pr.state === "open") await host.updatePr(ws.repo, pr.number, body, id);
			else pr = await host.createPr(ws.repo, { head: ws.branch, base, title: ctx.request.title, body }, id);
			return { kind: "pr", url: pr.url, ref: ws.branch, sha, pr: { repo: ws.repo, number: pr.number, url: pr.url } };
		},

		async checks(d: Delivery, names?: string[], opts?: StageCallOptions): Promise<CiStatus> {
			const repo = d.pr?.repo ?? d.url.replace(/^.*?:\/\/(github\.com\/)?/, "");
			const runs = await host.checks(repo, d.sha, identityOf(repoCfgOf(opts)));
			const counted = names?.length ? runs.filter((r) => names.includes(r.name)) : runs;
			const checks = counted.map((r) => ({ name: r.name, state: r.status === "completed" ? (r.conclusion ?? "unknown") : r.status }));
			if (counted.length === 0) return { state: "none", checks };
			if (counted.some((r) => r.status !== "completed")) return { state: "pending", checks };
			const failed = counted.filter((r) => !OK_CONCLUSIONS.includes(r.conclusion ?? ""));
			if (failed.length) return { state: "red", failures: failed.map((r) => `${r.name}: ${r.conclusion}${r.summary ? `\n${r.summary}` : ""}`), checks };
			return { state: "green", checks };
		},

		async annotate(d: Delivery, ws: Workspace, note: string, opts: StageCallOptions): Promise<void> {
			const repoCfg = repoCfgOf(opts);
			const id = identityOf(repoCfg);
			if (d.kind === "pr" && d.pr) {
				const pr = await host.getPr(d.pr.repo, d.pr.number, id);
				if (!pr.body.includes(note)) await host.updatePr(d.pr.repo, d.pr.number, `${pr.body}\n\n> ${note}`, id);
				return;
			}
			const file = join(ws.path, "docs", "delivery-notes.md");
			const cur = existsSync(file) ? readFileSync(file, "utf8") : "# Delivery notes\n";
			if (cur.includes(note)) return;
			writeFileSync(file, `${cur.trimEnd()}\n\n> ${note}\n`);
			await git(ws.path, ["add", "docs/delivery-notes.md"]);
			await git(ws.path, ["commit", "-q", "-m", "docs: delivery notes (no CI)"]);
			await git(ws.path, ["push", "-q", "origin", "HEAD:refs/heads/main"], await authFor(repoCfg));
		},
	};
	return ext;
}
