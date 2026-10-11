// GitHub (spec §3.2, §7): open (clone, or a local workspace before the repo exists), create (private, at first
// delivery), diff, merge; deliver (push to `main` for a new repo, a PR from the run's branch for an existing repo),
// CI checks and delivery notes. One git worktree per run. Reads the run's pinned `workdir` and `github.*` settings;
// the GitHub identity (PAT, bot or App) is never visible to agents.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expandHome, type Obj } from "../core/settings.ts";
import type { CiStatus, Delivery, DeliveryContext, Diff, Finding, PrRef, RepoRef, RunCtx, Workspace } from "../core/types.ts";
import { git, gitOut } from "./git.ts";
import type { GitHubHost, Identity } from "./host.ts";

const OK_CONCLUSIONS = ["success", "neutral", "skipped"];

const identityOf = (rc: RunCtx): Identity => (rc.config.github?.identity ?? {}) as Identity;
const workdirOf = (rc: RunCtx): string => expandHome(rc.config.workdir ?? "~/factory/work");
const cloneOf = (workdir: string, ref: RepoRef): string => join(workdir, "repos", ref.replace("/", "__"));

/** Rules on the `github` settings section; problems are relative to the section. */
export function githubProblems(github: Obj): string[] {
	const id = github?.identity ?? {};
	const problems: string[] = [];
	if (id.kind === "app" && (!id.appId || !id.installationId || !id.privateKeyRef))
		problems.push("identity.kind app needs identity.appId, identity.installationId and identity.privateKeyRef");
	return problems;
}

function findingLines(title: string, fs: Finding[]): string[] {
	if (!fs.length) return [];
	return [
		`## ${title}`,
		"",
		...fs.map((f) => `- **${f.severity}**${f.source && f.source !== "reviewer" ? ` [${f.source}]` : ""}${f.specRef ? ` (spec: ${f.specRef})` : ""}: ${f.description}${f.screenshots?.length ? ` (screenshots ${f.screenshots.join(", ")}: see the run view)` : ""}${f.evidence ? `\n  <details><summary>evidence</summary>\n\n  \`\`\`\n  ${f.evidence.slice(0, 1500).replace(/\n/g, "\n  ")}\n  \`\`\`\n  </details>` : ""}`),
		"",
	];
}

const QA_STATUS_TEXT: Record<string, string> = {
	ran: "ran: a QA agent used the product in a boat.dev VM in the final review round",
	off: "off: AQ testing is turned off for this project (qa.enabled: false); the reviewer ran the product and its tests locally",
	skipped: "skipped: the product has nothing to launch (no run script), so no QA agent used it",
	unavailable: "unavailable: boat.dev could not provide a VM, so no QA agent used the product in the final round",
};

export function report(ctx: Pick<DeliveryContext, "request" | "advisory" | "acceptedBlocking" | "spec" | "qaStatus"> & { runId: string }, notes: string[] = []): string {
	const all = [...ctx.advisory, ...ctx.acceptedBlocking];
	return [
		`Delivered by the software factory (run \`${ctx.runId}\`).`,
		"",
		`**Request:** ${ctx.request.title}`,
		"",
		`The spec (v${ctx.spec.version ?? 1}) is in \`docs/spec.md\` and is the contract this change was built and reviewed against.`,
		"",
		...findingLines("Advisory findings (non-blocking)", ctx.advisory),
		...findingLines("Open blocking findings accepted as is by a human", ctx.acceptedBlocking),
		...(ctx.qaStatus ? [`**AQ testing (QA status):** ${QA_STATUS_TEXT[ctx.qaStatus] ?? ctx.qaStatus}.`, ""] : []),
		...(all.some((f) => f.screenshots?.length) ? ["Screenshots cited by QA findings are in the factory's run view; they are not committed or uploaded.", ""] : []),
		...notes.map((n) => `> ${n}`),
	].join("\n");
}

export class GitHub {
	constructor(readonly host: GitHubHost) {}

	/** A run's (or, with `area: "discussions"`, a discussion's) checkout under `<workdir>/<area>/<rc.runId>`. */
	async open(ref: RepoRef, rc: RunCtx, area: "runs" | "discussions" = "runs"): Promise<Workspace> {
		const host = this.host;
		const workdir = workdirOf(rc);
		const m = join(workdir, area, `${rc.runId}.json`);
		if (existsSync(m)) {
			const ws = JSON.parse(readFileSync(m, "utf8")) as Workspace;
			if (existsSync(ws.path)) return ws;
		}
		const id = identityOf(rc);
		const clone = cloneOf(workdir, ref);
		const worktree = join(workdir, area, rc.runId);
		const branch = `factory/${rc.runId}`;
		const exists = await host.repoExists(ref, id);
		const auth = await host.gitAuth(id);
		let base: string;
		if (exists) {
			const def = await host.defaultBranch(ref, id);
			if (!existsSync(join(clone, ".git"))) {
				rmSync(clone, { recursive: true, force: true });
				mkdirSync(dirname(clone), { recursive: true });
				await git(dirname(clone), ["clone", "-q", host.remoteUrl(ref), clone], auth);
			} else {
				const remotes = await gitOut(clone, ["remote"]);
				if (!remotes.split("\n").includes("origin")) await git(clone, ["remote", "add", "origin", host.remoteUrl(ref)]);
				await git(clone, ["fetch", "-q", "origin", "--prune"], auth);
			}
			base = await gitOut(clone, ["rev-parse", `origin/${def}`]);
		} else {
			if (!existsSync(join(clone, ".git"))) {
				mkdirSync(clone, { recursive: true });
				await git(clone, ["init", "-q", "-b", "main"]);
				await git(clone, ["commit", "-q", "--allow-empty", "-m", "factory: initial commit"]);
			}
			base = await gitOut(clone, ["rev-parse", "main"]);
		}
		if (!existsSync(worktree)) {
			mkdirSync(dirname(worktree), { recursive: true });
			await git(clone, ["worktree", "prune"]);
			const has = await git(clone, ["rev-parse", "--verify", "-q", `refs/heads/${branch}`], { allowFail: true });
			await git(clone, has.code === 0 ? ["worktree", "add", "-q", worktree, branch] : ["worktree", "add", "-q", "-b", branch, worktree, base]);
		}
		const ws: Workspace = { repo: ref, path: worktree, baseRef: base, branch, newRepo: !exists };
		writeFileSync(m, JSON.stringify(ws, null, 2));
		return ws;
	}

	/**
	 * Bring a discussion's checkout up to date with the repo (spec discussion-flow §1.4): fast-forward an existing
	 * repo's worktree to `origin/<default>`; for a new-repo workspace whose repo now exists, replace the local
	 * workspace with a checkout of the repo.
	 */
	async refresh(ws: Workspace, rc: RunCtx): Promise<Workspace> {
		const host = this.host;
		const id = identityOf(rc);
		const workdir = workdirOf(rc);
		const clone = cloneOf(workdir, ws.repo);
		const manifest = `${ws.path}.json`;
		if (ws.newRepo) {
			if (!(await host.repoExists(ws.repo, id))) return ws;
			await git(clone, ["worktree", "remove", "--force", ws.path], { allowFail: true });
			rmSync(ws.path, { recursive: true, force: true });
			await git(clone, ["worktree", "prune"]);
			await git(clone, ["branch", "-D", ws.branch], { allowFail: true });
			rmSync(manifest, { force: true });
			return this.open(ws.repo, rc, "discussions");
		}
		const def = await host.defaultBranch(ws.repo, id);
		await git(clone, ["fetch", "-q", "origin", "--prune"], await host.gitAuth(id));
		const ff = await git(ws.path, ["merge", "-q", "--ff-only", `origin/${def}`], { allowFail: true });
		if (ff.code !== 0) throw new Error(`could not fast-forward the discussion's checkout to origin/${def}: ${ff.stderr.trim() || ff.stdout.trim()}`);
		const next: Workspace = { ...ws, baseRef: await gitOut(ws.path, ["rev-parse", "HEAD"]) };
		writeFileSync(manifest, JSON.stringify(next, null, 2));
		return next;
	}

	async create(ref: RepoRef, rc: RunCtx): Promise<void> {
		await this.host.createRepo(ref, { private: (rc.config.github?.visibility ?? "private") === "private" }, identityOf(rc));
	}

	async diff(ws: Workspace, base: string, head?: string): Promise<Diff> {
		let patch: string;
		let stat: string;
		let names: string;
		if (head) {
			patch = await gitOut(ws.path, ["diff", base, head]);
			stat = await gitOut(ws.path, ["diff", "--stat", base, head]);
			names = await gitOut(ws.path, ["diff", "--name-status", base, head]);
		} else {
			// The working tree incl. uncommitted and untracked files, through a throwaway index (the real index is untouched).
			const index = join(ws.path, "..", `.${ws.branch.replace(/\//g, "_")}.diff-index`);
			rmSync(index, { force: true });
			const env = { GIT_INDEX_FILE: index };
			await git(ws.path, ["add", "-A"], { env });
			patch = (await git(ws.path, ["diff", "--cached", base], { env })).stdout;
			stat = (await git(ws.path, ["diff", "--cached", "--stat", base], { env })).stdout.trim();
			names = (await git(ws.path, ["diff", "--cached", "--name-status", base], { env })).stdout.trim();
			rmSync(index, { force: true });
		}
		const files = names
			.split("\n")
			.filter(Boolean)
			.map((l) => {
				const [status, ...p] = l.split("\t");
				return { status: status!, path: p.join("\t") };
			});
		return {
			base,
			head: head ?? (await gitOut(ws.path, ["rev-parse", "HEAD"])),
			files,
			stat,
			patch,
			fingerprint: createHash("sha256").update(patch).digest("hex"),
			empty: patch.length === 0,
		};
	}

	/**
	 * Record the working tree as it is now (committed or not, untracked files included) as a commit under
	 * `refs/factory/<run branch>/<name>`, without touching HEAD, the index or the files. The reviewer's "changes since
	 * the previous review" and the QA VM's copy of the reviewed build are taken from it. Returns the commit SHA.
	 */
	async snapshot(ws: Workspace, name: string): Promise<string> {
		const index = join(ws.path, "..", `.${ws.branch.replace(/\//g, "_")}.snap-index`);
		rmSync(index, { force: true });
		const env = { GIT_INDEX_FILE: index };
		await git(ws.path, ["add", "-A"], { env });
		const tree = (await git(ws.path, ["write-tree"], { env })).stdout.trim();
		rmSync(index, { force: true });
		const ref = `refs/factory/${ws.branch.replace(/^factory\//, "")}/${name}`;
		const existing = await git(ws.path, ["rev-parse", "--verify", "-q", ref], { allowFail: true });
		if (existing.code === 0 && (await gitOut(ws.path, ["rev-parse", `${existing.stdout.trim()}^{tree}`])) === tree) return existing.stdout.trim();
		const sha = (await git(ws.path, ["commit-tree", tree, "-p", "HEAD", "-m", `factory: ${name}`])).stdout.trim();
		await git(ws.path, ["update-ref", ref, sha]);
		return sha;
	}

	/** A git bundle of one snapshot (see `snapshot`), for a machine that has no access to the remote. */
	async bundle(ws: Workspace, name: string, out: string): Promise<{ ref: string; sha: string }> {
		const sha = await this.snapshot(ws, name);
		const ref = `refs/factory/${ws.branch.replace(/^factory\//, "")}/${name}`;
		mkdirSync(dirname(out), { recursive: true });
		await git(ws.path, ["bundle", "create", out, ref]);
		return { ref, sha };
	}

	/** Deviation (DEVIATIONS.md): commit a core artifact (docs/spec.md) into the workspace. Idempotent. */
	async writeArtifact(ws: Workspace, path: string, content: string, message: string): Promise<void> {
		const file = join(ws.path, path);
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, content);
		await git(ws.path, ["add", "--", path]);
		const staged = await git(ws.path, ["diff", "--cached", "--quiet", "--", path], { allowFail: true });
		if (staged.code !== 0) await git(ws.path, ["commit", "-q", "-m", message, "--", path]);
	}

	/** Writes advisory findings into the PR description (existing repo) or docs/delivery-notes.md (new repo). */
	async deliver(ws: Workspace, ctx: DeliveryContext, rc: RunCtx): Promise<Delivery> {
		const host = this.host;
		const id = identityOf(rc);
		const auth = await host.gitAuth(id);
		// Commit whatever the builder left uncommitted, so the delivered commit is the reviewed tree.
		await git(ws.path, ["add", "-A"]);
		if ((await git(ws.path, ["diff", "--cached", "--quiet"], { allowFail: true })).code !== 0)
			await git(ws.path, ["commit", "-q", "-m", "factory: commit uncommitted builder changes"]);
		const remotes = await gitOut(ws.path, ["remote"]);
		if (!remotes.split("\n").includes("origin")) await git(ws.path, ["remote", "add", "origin", host.remoteUrl(ws.repo)]);

		if (ctx.mode === "push-main") {
			const note = join(ws.path, "docs", "delivery-notes.md");
			mkdirSync(dirname(note), { recursive: true });
			writeFileSync(note, `# Delivery notes\n\n${report({ ...ctx, runId: rc.runId })}\n`);
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
		const body = report({ ...ctx, runId: rc.runId });
		let pr = await host.findPr(ws.repo, ws.branch, id);
		if (pr && pr.state === "open") await host.updatePr(ws.repo, pr.number, body, id);
		else pr = await host.createPr(ws.repo, { head: ws.branch, base, title: ctx.request.title, body }, id);
		return { kind: "pr", url: pr.url, ref: ws.branch, sha, pr: { repo: ws.repo, number: pr.number, url: pr.url } };
	}

	async checks(d: Delivery, names: string[] | undefined, rc: RunCtx): Promise<CiStatus> {
		const repo = d.pr?.repo ?? d.url.replace(/^.*?:\/\/(github\.com\/)?/, "");
		const runs = await this.host.checks(repo, d.sha, identityOf(rc));
		const counted = names?.length ? runs.filter((r) => names.includes(r.name)) : runs;
		const checks = counted.map((r) => ({ name: r.name, state: r.status === "completed" ? (r.conclusion ?? "unknown") : r.status }));
		if (counted.length === 0) return { state: "none", checks };
		if (counted.some((r) => r.status !== "completed")) return { state: "pending", checks };
		const failed = counted.filter((r) => !OK_CONCLUSIONS.includes(r.conclusion ?? ""));
		if (failed.length) return { state: "red", failures: failed.map((r) => `${r.name}: ${r.conclusion}${r.summary ? `\n${r.summary}` : ""}`), checks };
		return { state: "green", checks };
	}

	/** Deviation (DEVIATIONS.md): add a note (e.g. "no CI") to the PR description / delivery note. Idempotent. */
	async annotate(d: Delivery, ws: Workspace, note: string, rc: RunCtx): Promise<void> {
		const host = this.host;
		const id = identityOf(rc);
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
		await git(ws.path, ["push", "-q", "origin", "HEAD:refs/heads/main"], await host.gitAuth(id));
	}

	async merge(pr: PrRef, how: "merge" | "squash" | "rebase", rc: RunCtx): Promise<void> {
		await this.host.mergePr(pr.repo, pr.number, how, identityOf(rc));
	}
}
