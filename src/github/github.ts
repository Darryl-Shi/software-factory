// GitHub (spec §3.2, §7): open (clone, or a local workspace before the repo exists), create (private, at first
// delivery), diff, merge; deliver (push to `main` for a new repo, a PR from the run's branch for an existing repo),
// CI checks and delivery notes. One git worktree per run. Reads the run's pinned `workdir` and `github.*` settings;
// the GitHub identity (PAT, bot or App) is never visible to agents.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expandHome, type Obj } from "../core/settings.ts";
import type { CiStatus, Delivery, DeliveryContext, Diff, Finding, PrRef, QaStatus, RepoRef, RunCtx, Workspace } from "../core/types.ts";
import { git, gitOut } from "./git.ts";
import type { GitHubHost, Identity } from "./host.ts";

const OK_CONCLUSIONS = ["success", "neutral", "skipped"];

const identityOf = (rc: RunCtx): Identity => (rc.config.github?.identity ?? {}) as Identity;
const workdirOf = (rc: RunCtx): string => expandHome(rc.config.workdir ?? "~/factory/work");
const cloneOf = (workdir: string, ref: RepoRef): string => join(workdir, "repos", ref.replace("/", "__"));
const gitReason = (r: { stderr: string; stdout: string }) => r.stderr.trim() || r.stdout.trim() || "no output from git";

/**
 * Remove a checkout and its manifest: the git worktree (from `ws.repo`'s clone, if that clone exists), the directory
 * and the local branch. Every step is best effort; a branch that can't be deleted is reset by the next `open` of a
 * discussion (`worktree add -B`), so it is never reattached as it was.
 */
async function discard(ws: Workspace, workdir: string, manifest: string): Promise<void> {
	const clone = cloneOf(workdir, ws.repo);
	const hasClone = existsSync(join(clone, ".git"));
	if (hasClone) await git(clone, ["worktree", "remove", "--force", ws.path], { allowFail: true });
	rmSync(ws.path, { recursive: true, force: true });
	if (hasClone) {
		await git(clone, ["worktree", "prune"], { allowFail: true });
		await git(clone, ["branch", "-D", ws.branch], { allowFail: true });
	}
	rmSync(manifest, { force: true });
}

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
		`The spec (v${ctx.spec.version ?? 1}) is in \`${ctx.spec.path ?? "docs/spec.md"}\` and is the contract this change was built and reviewed against.`,
		"",
		...findingLines("Advisory findings (non-blocking)", ctx.advisory),
		...findingLines("Open blocking findings accepted as is by a human", ctx.acceptedBlocking),
		...(ctx.qaStatus ? [`**AQ testing (QA status):** ${QA_STATUS_TEXT[ctx.qaStatus] ?? ctx.qaStatus}.`, ""] : []),
		...(all.some((f) => f.screenshots?.length) ? ["Screenshots cited by QA findings are in the factory's run view; they are not committed or uploaded.", ""] : []),
		...notes.map((n) => `> ${n}`),
	].join("\n");
}

/**
 * One git operation at a time on a project's shared clone: runs, discussions and bundles of one project clone, fetch,
 * add worktrees and push from it in parallel, and git's ref and config locks don't wait.
 */
const cloneLocks = new Map<string, Promise<unknown>>();
function withClone<T>(clone: string, f: () => Promise<T>): Promise<T> {
	const prev = cloneLocks.get(clone) ?? Promise.resolve();
	const next = prev.catch(() => undefined).then(f);
	cloneLocks.set(clone, next);
	void next.finally(() => {
		if (cloneLocks.get(clone) === next) cloneLocks.delete(clone);
	}).catch(() => undefined);
	return next;
}

export class GitHub {
	constructor(readonly host: GitHubHost) {}

	/** A run's (or, with `area: "discussions"`, a discussion's) checkout under `<workdir>/<area>/<rc.runId>`. */
	open(ref: RepoRef, rc: RunCtx, area: "runs" | "discussions" = "runs"): Promise<Workspace> {
		return withClone(cloneOf(workdirOf(rc), ref), () => this.openLocked(ref, rc, area));
	}

	private async openLocked(ref: RepoRef, rc: RunCtx, area: "runs" | "discussions"): Promise<Workspace> {
		const host = this.host;
		const workdir = workdirOf(rc);
		const m = join(workdir, area, `${rc.runId}.json`);
		if (existsSync(m)) {
			const ws = JSON.parse(readFileSync(m, "utf8")) as Workspace;
			if (ws.repo === ref && existsSync(ws.path)) return ws;
			// A manifest for another repo is stale (the id was reused, e.g. after the factory's storage was reset): start over.
			if (ws.repo !== ref) await discard(ws, workdir, m);
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
			// A run's branch holds its work and is reattached; a discussion's checkout is read-only, so its branch is
			// (re)started at the base.
			const has = area === "runs" && (await git(clone, ["rev-parse", "--verify", "-q", `refs/heads/${branch}`], { allowFail: true })).code === 0;
			await git(clone, has ? ["worktree", "add", "-q", worktree, branch] : ["worktree", "add", "-q", area === "runs" ? "-b" : "-B", branch, worktree, base]);
		}
		const ws: Workspace = { repo: ref, path: worktree, baseRef: base, branch, newRepo: !exists };
		writeFileSync(m, JSON.stringify(ws, null, 2));
		return ws;
	}

	/**
	 * Bring a discussion's checkout up to date with the repo (spec discussion-flow §1.4). The checkout is read-only, so
	 * it is resynced, not merged: an existing repo's worktree is reset to `origin/<default>` (a force-pushed default
	 * branch or stray local changes don't matter) and cleaned. A missing checkout or manifest, a missing clone, or a
	 * worktree git can't reset is made again with `open`; so is a new-repo workspace whose repo now exists (the empty
	 * local workspace becomes a checkout of the repo). Fails only when git does (e.g. the remote is gone).
	 */
	refresh(ws: Workspace, rc: RunCtx): Promise<Workspace> {
		return withClone(cloneOf(workdirOf(rc), ws.repo), () => this.refreshLocked(ws, rc));
	}

	private async refreshLocked(ws: Workspace, rc: RunCtx): Promise<Workspace> {
		const host = this.host;
		const id = identityOf(rc);
		const workdir = workdirOf(rc);
		const clone = cloneOf(workdir, ws.repo);
		const manifest = join(workdir, "discussions", `${rc.runId}.json`);
		const again = async () => {
			await discard(ws, workdir, manifest);
			return this.openLocked(ws.repo, rc, "discussions");
		};
		if (ws.newRepo) {
			if (await host.repoExists(ws.repo, id)) return again();
			return existsSync(join(ws.path, ".git")) && existsSync(manifest) ? ws : again();
		}
		if (![join(ws.path, ".git"), manifest, join(clone, ".git")].every((p) => existsSync(p))) return again();
		const def = await host.defaultBranch(ws.repo, id);
		const fetched = await git(clone, ["fetch", "-q", "origin", "--prune"], { ...(await host.gitAuth(id)), allowFail: true });
		if (fetched.code !== 0) throw new Error(`could not fetch ${ws.repo} to update the discussion's checkout: ${gitReason(fetched)}`);
		const reset = await git(ws.path, ["checkout", "-q", "-f", "-B", ws.branch, `origin/${def}`], { allowFail: true });
		if (reset.code !== 0) return again();
		await git(ws.path, ["clean", "-q", "-f", "-d"]);
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

	// ------------------------------------------------------------------ Ready runs and bundles (bundles spec §1.1, §2)

	/** Commit whatever is uncommitted in the worktree (untracked files included). Returns whether it committed. */
	async commitAll(ws: Workspace, message: string): Promise<boolean> {
		await git(ws.path, ["add", "-A"]);
		if ((await git(ws.path, ["diff", "--cached", "--quiet"], { allowFail: true })).code === 0) return false;
		await git(ws.path, ["commit", "-q", "-m", message]);
		return true;
	}

	/** Push the workspace's branch (`factory/<id>`) to origin, replacing what is there. */
	pushBranch(ws: Workspace, rc: RunCtx): Promise<string> {
		return withClone(cloneOf(workdirOf(rc), ws.repo), () => this.pushBranchLocked(ws, rc));
	}

	private async pushBranchLocked(ws: Workspace, rc: RunCtx): Promise<string> {
		const host = this.host;
		const remotes = await gitOut(ws.path, ["remote"]);
		if (!remotes.split("\n").includes("origin")) await git(ws.path, ["remote", "add", "origin", host.remoteUrl(ws.repo)]);
		await git(ws.path, ["push", "-q", "--force", "origin", `HEAD:refs/heads/${ws.branch}`], await host.gitAuth(identityOf(rc)));
		return gitOut(ws.path, ["rev-parse", "HEAD"]);
	}

	/**
	 * A bundle's worktree `<workdir>/bundles/<bundle-id>` on branch `factory/<bundle-id>`, from the project's shared clone
	 * (where the member runs' branches are local branches). Made at the clone's current HEAD; `integrateStart` resets it.
	 */
	openBundle(ref: RepoRef, rc: RunCtx): Promise<Workspace> {
		return withClone(cloneOf(workdirOf(rc), ref), () => this.openBundleLocked(ref, rc));
	}

	private async openBundleLocked(ref: RepoRef, rc: RunCtx): Promise<Workspace> {
		const workdir = workdirOf(rc);
		const m = join(workdir, "bundles", `${rc.runId}.json`);
		if (existsSync(m)) {
			const ws = JSON.parse(readFileSync(m, "utf8")) as Workspace;
			if (ws.repo === ref && existsSync(ws.path)) return ws;
			if (ws.repo !== ref) await discard(ws, workdir, m);
		}
		const clone = cloneOf(workdir, ref);
		if (!existsSync(join(clone, ".git"))) throw new Error(`the project's clone of ${ref} is missing (${clone}); its runs' branches live there`);
		const worktree = join(workdir, "bundles", rc.runId);
		const branch = `factory/${rc.runId}`;
		const exists = await this.host.repoExists(ref, identityOf(rc));
		const start = exists && (await git(clone, ["rev-parse", "--verify", "-q", "refs/remotes/origin/HEAD"], { allowFail: true })).code === 0 ? "origin/HEAD" : "HEAD";
		if (!existsSync(worktree)) {
			mkdirSync(dirname(worktree), { recursive: true });
			await git(clone, ["worktree", "prune"]);
			await git(clone, ["worktree", "add", "-q", "-B", branch, worktree, start]);
		}
		const ws: Workspace = { repo: ref, path: worktree, baseRef: await gitOut(worktree, ["rev-parse", "HEAD"]), branch, newRepo: !exists };
		writeFileSync(m, JSON.stringify(ws, null, 2));
		return ws;
	}

	/**
	 * The commit a bundle integrates on: `origin/<default>` after a fetch, or, for a repo that doesn't exist yet, the
	 * clone's local `main`. Also says whether the repo exists now.
	 */
	integrationBase(ws: Workspace, rc: RunCtx): Promise<{ base: string; newRepo: boolean }> {
		return withClone(cloneOf(workdirOf(rc), ws.repo), () => this.integrationBaseLocked(ws, rc));
	}

	private async integrationBaseLocked(ws: Workspace, rc: RunCtx): Promise<{ base: string; newRepo: boolean }> {
		const host = this.host;
		const id = identityOf(rc);
		const exists = await host.repoExists(ws.repo, id);
		if (!exists) return { base: await gitOut(ws.path, ["rev-parse", "refs/heads/main"]), newRepo: true };
		const remotes = await gitOut(ws.path, ["remote"]);
		if (!remotes.split("\n").includes("origin")) await git(ws.path, ["remote", "add", "origin", host.remoteUrl(ws.repo)]);
		const def = await host.defaultBranch(ws.repo, id);
		const fetched = await git(ws.path, ["fetch", "-q", "origin", "--prune"], { ...(await host.gitAuth(id)), allowFail: true });
		if (fetched.code !== 0) throw new Error(`could not fetch ${ws.repo}: ${gitReason(fetched)}`);
		return { base: await gitOut(ws.path, ["rev-parse", `refs/remotes/origin/${def}`]), newRepo: false };
	}

	/** Reset the bundle's branch to `base` with a clean tree (an unfinished merge is aborted; earlier integration commits are discarded). */
	async integrateStart(ws: Workspace, base: string): Promise<void> {
		await git(ws.path, ["merge", "--abort"], { allowFail: true });
		await git(ws.path, ["checkout", "-q", "-f", "-B", ws.branch, base]);
		await git(ws.path, ["reset", "-q", "--hard", base]);
		await git(ws.path, ["clean", "-q", "-f", "-d"]);
	}

	/** Whether `branch`'s tip is already in HEAD (merged before a crash). */
	async contains(ws: Workspace, branch: string): Promise<boolean> {
		return (await git(ws.path, ["merge-base", "--is-ancestor", `refs/heads/${branch}`, "HEAD"], { allowFail: true })).code === 0;
	}

	/** The merge in progress in the worktree, if any, and its conflicted (unmerged) files. */
	async mergeState(ws: Workspace): Promise<{ inProgress: boolean; conflicted: string[] }> {
		const inProgress = (await git(ws.path, ["rev-parse", "-q", "--verify", "MERGE_HEAD"], { allowFail: true })).code === 0;
		const conflicted = (await gitOut(ws.path, ["diff", "--name-only", "--diff-filter=U"])).split("\n").filter(Boolean);
		return { inProgress, conflicted };
	}

	/**
	 * `git merge --no-ff` of a member's local branch into the bundle's branch. On a conflict the conflicted merge is left
	 * in the worktree for the integrator; any other failure throws.
	 */
	async mergeMember(ws: Workspace, branch: string, message: string): Promise<{ clean: true } | { clean: false; files: string[] }> {
		if ((await git(ws.path, ["rev-parse", "--verify", "-q", `refs/heads/${branch}`], { allowFail: true })).code !== 0)
			throw new Error(`branch ${branch} does not exist in the project's clone`);
		const r = await git(ws.path, ["merge", "--no-ff", "--no-edit", "-m", message, `refs/heads/${branch}`], { allowFail: true });
		if (r.code === 0) return { clean: true };
		const st = await this.mergeState(ws);
		if (!st.inProgress || st.conflicted.length === 0) throw new Error(`merging ${branch} failed: ${gitReason(r)}`);
		return { clean: false, files: st.conflicted };
	}

	/** Conclude a merge whose conflicts are all resolved (the integrator staged but did not commit). */
	async concludeMerge(ws: Workspace): Promise<void> {
		await git(ws.path, ["add", "-A"]);
		await git(ws.path, ["commit", "-q", "--no-edit"]);
	}

	/** The head of the repo's default branch on the remote right now (after a fetch). */
	async defaultHead(ws: Workspace, rc: RunCtx): Promise<string> {
		return (await this.integrationBase(ws, rc)).base;
	}

	/**
	 * Deliver a bundle (bundles spec §2.2 DELIVERING). Existing repo: push `factory/<bundle-id>` and open or update one PR
	 * (title and description rewritten). New repo: create it, commit docs/delivery-notes.md and push to `main`.
	 */
	async deliverBundle(ws: Workspace, ctx: BundleDeliveryContext, rc: RunCtx): Promise<Delivery> {
		const host = this.host;
		const id = identityOf(rc);
		await this.commitAll(ws, "factory: commit uncommitted integrator changes");
		const body = bundleReport(ctx, rc.runId);
		if (ctx.mode === "push-main") {
			await host.createRepo(ws.repo, { private: (rc.config.github?.visibility ?? "private") === "private" }, id);
			const remotes = await gitOut(ws.path, ["remote"]);
			if (!remotes.split("\n").includes("origin")) await git(ws.path, ["remote", "add", "origin", host.remoteUrl(ws.repo)]);
			const note = join(ws.path, "docs", "delivery-notes.md");
			mkdirSync(dirname(note), { recursive: true });
			writeFileSync(note, `# Delivery notes\n\n${body}\n`);
			await git(ws.path, ["add", "docs/delivery-notes.md"]);
			if ((await git(ws.path, ["diff", "--cached", "--quiet"], { allowFail: true })).code !== 0) await git(ws.path, ["commit", "-q", "-m", "docs: delivery notes"]);
			await git(ws.path, ["push", "-q", "origin", "HEAD:refs/heads/main"], await host.gitAuth(id));
			return { kind: "repo", url: host.webUrl(ws.repo), ref: "main", sha: await gitOut(ws.path, ["rev-parse", "HEAD"]) };
		}
		const sha = await this.pushBranch(ws, rc);
		const base = await host.defaultBranch(ws.repo, id);
		const title = bundleTitle(ctx.members);
		let pr = ctx.pr ? await host.getPr(ctx.pr.repo, ctx.pr.number, id).catch(() => undefined) : await host.findPr(ws.repo, ws.branch, id);
		if (pr && pr.state === "open") await host.updatePr(ws.repo, pr.number, body, id, title);
		else pr = await host.createPr(ws.repo, { head: ws.branch, base, title, body }, id);
		return { kind: "pr", url: pr.url, ref: ws.branch, sha, pr: { repo: ws.repo, number: pr.number, url: pr.url } };
	}

	/** Rewrite an open PR's description (bundle membership changed). */
	async describe(pr: PrRef, ctx: BundleDeliveryContext, rc: RunCtx): Promise<void> {
		await this.host.updatePr(pr.repo, pr.number, bundleReport(ctx, rc.runId), identityOf(rc), bundleTitle(ctx.members));
	}

	async prState(pr: PrRef, rc: RunCtx): Promise<"open" | "closed" | "merged"> {
		return (await this.host.getPr(pr.repo, pr.number, identityOf(rc))).state;
	}

	async closePr(pr: PrRef, rc: RunCtx): Promise<void> {
		await this.host.closePr(pr.repo, pr.number, identityOf(rc));
	}

	/** Remove a bundle's worktree (its branch stays in the clone). */
	async disposeBundle(ws: Workspace, rc: RunCtx): Promise<void> {
		const workdir = workdirOf(rc);
		const clone = cloneOf(workdir, ws.repo);
		if (existsSync(join(clone, ".git"))) await git(clone, ["worktree", "remove", "--force", ws.path], { allowFail: true });
		rmSync(ws.path, { recursive: true, force: true });
		if (existsSync(join(clone, ".git"))) await git(clone, ["worktree", "prune"], { allowFail: true });
		rmSync(join(workdir, "bundles", `${rc.runId}.json`), { force: true });
	}
}

/** What a bundle's PR description (or delivery note) is written from. */
export interface BundleDeliveryContext {
	mode: "push-main" | "pull-request";
	/** The open PR to update, if the bundle has one. */
	pr?: PrRef;
	members: {
		run: string;
		title: string;
		specPath: string;
		specVersion?: number;
		advisory: Finding[];
		acceptedBlocking: Finding[];
		qaStatus?: QaStatus;
	}[];
	integration: {
		resolved: { run: string; files: string[] }[];
		reviewRounds: number;
		advisory: Finding[];
		acceptedBlocking: Finding[];
		qaStatus?: QaStatus;
	};
	noCi?: boolean;
}

/** The ticket's title for one member; otherwise "<N> tickets: <title 1>, <title 2>, …" (truncated). */
export function bundleTitle(members: { title: string }[]): string {
	if (members.length === 1) return members[0]!.title;
	const full = `${members.length} tickets: ${members.map((m) => m.title).join(", ")}`;
	return full.length > 120 ? `${full.slice(0, 119).trimEnd()}…` : full;
}

export function bundleReport(ctx: BundleDeliveryContext, bundleId: string): string {
	const shots = [...ctx.members.flatMap((m) => [...m.advisory, ...m.acceptedBlocking]), ...ctx.integration.advisory, ...ctx.integration.acceptedBlocking].some((f) => f.screenshots?.length);
	const lines = [
		`Delivered by the software factory (bundle \`${bundleId}\`, ${ctx.members.length} ticket${ctx.members.length === 1 ? "" : "s"}).`,
		"",
	];
	for (const m of ctx.members) {
		lines.push(
			`## Ticket: ${m.title}`,
			"",
			`Run \`${m.run}\`. The spec (v${m.specVersion ?? 1}) is in \`${m.specPath}\` and is the contract this ticket was built and reviewed against.`,
			"",
			...findingLines("Advisory findings (non-blocking)", m.advisory).map((l) => l.replace(/^## /, "### ")),
			...findingLines("Open blocking findings accepted as is by a human", m.acceptedBlocking).map((l) => l.replace(/^## /, "### ")),
			...(m.qaStatus ? [`**AQ testing (QA status):** ${QA_STATUS_TEXT[m.qaStatus] ?? m.qaStatus}.`, ""] : []),
		);
	}
	const it = ctx.integration;
	lines.push(
		"## Integration",
		"",
		it.resolved.length
			? `The integrator resolved merge conflicts: ${it.resolved.map((r) => `${r.run} (${r.files.join(", ")})`).join("; ")}.`
			: "The tickets' branches merged cleanly on the default branch; no conflicts were resolved.",
		"",
		it.reviewRounds > 0 ? `The combined result was reviewed in ${it.reviewRounds} review round${it.reviewRounds === 1 ? "" : "s"} against every ticket's spec.` : "The combined result had no review of its own: the merge was clean and each ticket was reviewed on its own branch.",
		"",
		...findingLines("Advisory findings of the combined review", it.advisory).map((l) => l.replace(/^## /, "### ")),
		...findingLines("Open blocking findings of the combined result accepted as is by a human", it.acceptedBlocking).map((l) => l.replace(/^## /, "### ")),
		...(it.qaStatus ? [`**AQ testing of the combined result (QA status):** ${QA_STATUS_TEXT[it.qaStatus] ?? it.qaStatus}.`, ""] : []),
		...(shots ? ["Screenshots cited by QA findings are in the factory's view; they are not committed or uploaded.", ""] : []),
		...(ctx.noCi ? ["> No CI checks appeared within ci.noChecksTimeout: the repo has no CI, so CI did not run."] : []),
	);
	return lines.join("\n");
}
