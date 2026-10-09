// GitHub access for the `GitHub` class (./github.ts).
// - GhApiHost: the real thing, over `gh api` (REST) and git over HTTPS, with a PAT, a bot PAT or a GitHub App identity.
// - LocalGitHubHost: a fake GitHub for tests and dry runs: bare git remotes on disk, PRs and check runs in a JSON
//   file, and a CI runner that executes the `run:` steps of .github/workflows/*.yml at the pushed commit.
import { createSign } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { expandHome, resolveSecret } from "../core/settings.ts";
import { baseEnv, git, run } from "./git.ts";

export interface PrInfo {
	number: number;
	url: string;
	head: string;
	base: string;
	state: "open" | "closed" | "merged";
	body: string;
}

export interface CheckRun {
	name: string;
	status: "queued" | "in_progress" | "completed";
	conclusion?: string;
	summary?: string;
}

export interface Identity {
	kind?: "pat" | "bot" | "app";
	tokenRef?: string;
	appId?: number;
	installationId?: number;
	privateKeyRef?: string;
}

export interface GitHubHost {
	readonly name: string;
	repoExists(repo: string, id: Identity): Promise<boolean>;
	createRepo(repo: string, opts: { private: boolean }, id: Identity): Promise<void>;
	defaultBranch(repo: string, id: Identity): Promise<string>;
	remoteUrl(repo: string): string;
	webUrl(repo: string): string;
	/** Extra `git -c ...` args and env that authenticate git for this repo (credentials never touch .git/config). */
	gitAuth(id: Identity): Promise<{ extraArgs: string[]; env: Record<string, string> }>;
	findPr(repo: string, head: string, id: Identity): Promise<PrInfo | undefined>;
	createPr(repo: string, pr: { head: string; base: string; title: string; body: string }, id: Identity): Promise<PrInfo>;
	updatePr(repo: string, number: number, body: string, id: Identity): Promise<void>;
	getPr(repo: string, number: number, id: Identity): Promise<PrInfo>;
	mergePr(repo: string, number: number, how: "merge" | "squash" | "rebase", id: Identity): Promise<void>;
	checks(repo: string, sha: string, id: Identity): Promise<CheckRun[]>;
}

// ------------------------------------------------------------------ secrets (references only, resolved at use)
export { resolveSecret } from "../core/settings.ts";

// ------------------------------------------------------------------ real GitHub over `gh api`
export class GhApiHost implements GitHubHost {
	readonly name = "github.com";
	private appToken?: { token: string; expires: number };

	constructor(private apiBase = "https://api.github.com") {}

	async token(id: Identity): Promise<string> {
		if (id.kind === "app") {
			if (this.appToken && this.appToken.expires > Date.now() + 60_000) return this.appToken.token;
			const key = resolveSecret(id.privateKeyRef);
			if (!key || !id.appId || !id.installationId) throw new Error("GitHub App identity needs appId, installationId and privateKeyRef");
			const now = Math.floor(Date.now() / 1000);
			const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
			const unsigned = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ iat: now - 60, exp: now + 540, iss: String(id.appId) })}`;
			const sig = createSign("RSA-SHA256").update(unsigned).sign(key).toString("base64url");
			const res = await fetch(`${this.apiBase}/app/installations/${id.installationId}/access_tokens`, {
				method: "POST",
				headers: { authorization: `Bearer ${unsigned}.${sig}`, accept: "application/vnd.github+json" },
			});
			if (!res.ok) throw new Error(`GitHub App token request failed: ${res.status} ${await res.text()}`);
			const body = (await res.json()) as { token: string; expires_at: string };
			this.appToken = { token: body.token, expires: Date.parse(body.expires_at) };
			return body.token;
		}
		const t = resolveSecret(id.tokenRef ?? "env:GH_TOKEN");
		if (!t) throw new Error(`no GitHub token: set ${id.tokenRef ?? "env:GH_TOKEN"} (github.identity.tokenRef)`);
		return t;
	}

	private async api(id: Identity, method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
		const token = await this.token(id);
		const args = ["api", "-X", method, "-H", "Accept: application/vnd.github+json", "--include", path];
		if (body !== undefined) args.push("--input", "-");
		const r = await run("gh", args, { env: baseEnv({ GH_TOKEN: token, GH_PROMPT_DISABLED: "1" }), input: body === undefined ? undefined : JSON.stringify(body) });
		const text = r.stdout;
		const status = Number(/^HTTP\/[\d.]+ (\d+)/m.exec(text)?.[1] ?? (r.code === 0 ? 200 : 500));
		const split = text.indexOf("\r\n\r\n") >= 0 ? text.indexOf("\r\n\r\n") + 4 : text.indexOf("\n\n") + 2;
		const payload = text.slice(split).trim();
		let json: any;
		try {
			json = payload ? JSON.parse(payload) : undefined;
		} catch {
			json = payload;
		}
		return { status, json };
	}

	private async ok(id: Identity, method: string, path: string, body?: unknown) {
		const r = await this.api(id, method, path, body);
		if (r.status >= 300) throw new Error(`GitHub ${method} ${path}: ${r.status} ${JSON.stringify(r.json)?.slice(0, 500)}`);
		return r.json;
	}

	async repoExists(repo: string, id: Identity) {
		const r = await this.api(id, "GET", `/repos/${repo}`);
		if (r.status === 404) return false;
		if (r.status >= 300) throw new Error(`GitHub GET /repos/${repo}: ${r.status}`);
		return true;
	}

	async createRepo(repo: string, opts: { private: boolean }, id: Identity) {
		if (await this.repoExists(repo, id)) return;
		const [owner, name] = repo.split("/");
		const body = { name, private: opts.private, auto_init: false };
		const org = await this.api(id, "POST", `/orgs/${owner}/repos`, body);
		if (org.status < 300) return;
		if (org.status !== 404) throw new Error(`GitHub create ${repo}: ${org.status} ${JSON.stringify(org.json)?.slice(0, 300)}`);
		await this.ok(id, "POST", `/user/repos`, body);
	}

	async defaultBranch(repo: string, id: Identity) {
		return (await this.ok(id, "GET", `/repos/${repo}`)).default_branch ?? "main";
	}

	remoteUrl(repo: string) {
		return `https://github.com/${repo}.git`;
	}
	webUrl(repo: string) {
		return `https://github.com/${repo}`;
	}

	async gitAuth(id: Identity) {
		const token = await this.token(id);
		// The token goes to git through an env var read by an inline credential helper; never into .git/config.
		return {
			extraArgs: ["-c", "credential.helper=", "-c", `credential.helper=!f() { echo username=x-access-token; echo "password=$FACTORY_GIT_TOKEN"; }; f`],
			env: { FACTORY_GIT_TOKEN: token },
		};
	}

	private pr(j: any): PrInfo {
		return { number: j.number, url: j.html_url, head: j.head?.ref, base: j.base?.ref, state: j.merged_at ? "merged" : j.state, body: j.body ?? "" };
	}

	async findPr(repo: string, head: string, id: Identity) {
		const owner = repo.split("/")[0];
		const list = await this.ok(id, "GET", `/repos/${repo}/pulls?state=all&head=${owner}:${encodeURIComponent(head)}`);
		const open = (list as any[]).find((p) => p.state === "open") ?? (list as any[])[0];
		return open ? this.pr(open) : undefined;
	}

	async createPr(repo: string, pr: { head: string; base: string; title: string; body: string }, id: Identity) {
		return this.pr(await this.ok(id, "POST", `/repos/${repo}/pulls`, pr));
	}

	async updatePr(repo: string, number: number, body: string, id: Identity) {
		await this.ok(id, "PATCH", `/repos/${repo}/pulls/${number}`, { body });
	}

	async getPr(repo: string, number: number, id: Identity) {
		return this.pr(await this.ok(id, "GET", `/repos/${repo}/pulls/${number}`));
	}

	async mergePr(repo: string, number: number, how: "merge" | "squash" | "rebase", id: Identity) {
		const pr = await this.getPr(repo, number, id);
		if (pr.state === "merged") return;
		await this.ok(id, "PUT", `/repos/${repo}/pulls/${number}/merge`, { merge_method: how });
	}

	async checks(repo: string, sha: string, id: Identity): Promise<CheckRun[]> {
		const runs = await this.ok(id, "GET", `/repos/${repo}/commits/${sha}/check-runs?per_page=100`);
		const status = await this.ok(id, "GET", `/repos/${repo}/commits/${sha}/status`);
		const out: CheckRun[] = (runs.check_runs ?? []).map((c: any) => ({
			name: c.name,
			status: c.status === "completed" ? "completed" : c.status === "queued" ? "queued" : "in_progress",
			...(c.conclusion ? { conclusion: c.conclusion } : {}),
			...(c.output?.summary ? { summary: c.output.summary } : {}),
		}));
		for (const s of status.statuses ?? [])
			out.push({
				name: s.context,
				status: s.state === "pending" ? "in_progress" : "completed",
				...(s.state !== "pending" ? { conclusion: s.state === "success" ? "success" : "failure" } : {}),
				...(s.description ? { summary: s.description } : {}),
			});
		return out;
	}
}

// ------------------------------------------------------------------ fake GitHub on the local disk
type LocalState = {
	prs: { repo: string; number: number; head: string; base: string; title: string; body: string; state: "open" | "closed" | "merged" }[];
	checks: Record<string, CheckRun[]>; // `${repo}@${sha}`
	forced: Record<string, CheckRun[][]>; // repo → queue of check results for the next new commits
	created: string[];
	calls: { op: string; repo: string; at: number; detail?: unknown }[];
};

export class LocalGitHubHost implements GitHubHost {
	readonly name = "local";
	private running = new Set<string>();

	constructor(
		readonly root: string,
		private opts: { ciDelayMs?: number } = {},
	) {
		mkdirSync(root, { recursive: true });
		if (!existsSync(this.statePath)) this.save({ prs: [], checks: {}, forced: {}, created: [], calls: [] });
	}

	get statePath() {
		return join(this.root, "github-state.json");
	}
	state(): LocalState {
		return JSON.parse(readFileSync(this.statePath, "utf8"));
	}
	private save(s: LocalState) {
		writeFileSync(this.statePath, JSON.stringify(s, null, 2));
	}
	private mutate<T>(f: (s: LocalState) => T): T {
		const s = this.state();
		const r = f(s);
		this.save(s);
		return r;
	}
	private log(op: string, repo: string, detail?: unknown) {
		this.mutate((s) => s.calls.push({ op, repo, at: Date.now(), ...(detail !== undefined ? { detail } : {}) }));
	}
	bare(repo: string) {
		return join(this.root, "remotes", `${repo}.git`);
	}

	/** Test control: the next new commit(s) checked in `repo` get these check results instead of running workflows. */
	forceChecks(repo: string, ...results: CheckRun[][]) {
		this.mutate((s) => {
			s.forced[repo] = [...(s.forced[repo] ?? []), ...results];
		});
	}

	/** Test/dry-run setup: an existing repo with some content on main. */
	async seedRepo(repo: string, files: Record<string, string>) {
		await this.createRepo(repo, { private: true });
		const work = mkdtempSync(join(tmpdir(), "seed-"));
		await git(work, ["init", "-q", "-b", "main"]);
		for (const [p, c] of Object.entries(files)) {
			mkdirSync(join(work, p, ".."), { recursive: true });
			writeFileSync(join(work, p), c);
		}
		await git(work, ["add", "-A"]);
		await git(work, ["commit", "-q", "-m", "seed"]);
		await git(work, ["push", "-q", this.bare(repo), "main"]);
		rmSync(work, { recursive: true, force: true });
	}

	async repoExists(repo: string) {
		return existsSync(this.bare(repo));
	}
	async createRepo(repo: string, opts: { private: boolean }) {
		if (existsSync(this.bare(repo))) return;
		mkdirSync(this.bare(repo), { recursive: true });
		await git(this.bare(repo), ["init", "-q", "--bare", "-b", "main"]);
		this.mutate((s) => s.created.push(repo));
		this.log("createRepo", repo, { private: opts.private });
	}
	async defaultBranch() {
		return "main";
	}
	remoteUrl(repo: string) {
		return this.bare(repo);
	}
	webUrl(repo: string) {
		return `local://${repo}`;
	}
	async gitAuth() {
		return { extraArgs: [], env: {} };
	}
	async findPr(repo: string, head: string) {
		const p = this.state().prs.find((x) => x.repo === repo && x.head === head && x.state === "open");
		return p ? this.toPr(p) : undefined;
	}
	private toPr(p: LocalState["prs"][number]): PrInfo {
		return { number: p.number, url: `local://${p.repo}/pull/${p.number}`, head: p.head, base: p.base, state: p.state, body: p.body };
	}
	async createPr(repo: string, pr: { head: string; base: string; title: string; body: string }) {
		const created = this.mutate((s) => {
			const number = s.prs.filter((x) => x.repo === repo).length + 1;
			const rec = { repo, number, ...pr, state: "open" as const };
			s.prs.push(rec);
			return rec;
		});
		this.log("createPr", repo, { number: created.number });
		return this.toPr(created);
	}
	async updatePr(repo: string, number: number, body: string) {
		this.mutate((s) => {
			const p = s.prs.find((x) => x.repo === repo && x.number === number);
			if (p) p.body = body;
		});
	}
	async getPr(repo: string, number: number) {
		const p = this.state().prs.find((x) => x.repo === repo && x.number === number);
		if (!p) throw new Error(`no PR ${repo}#${number}`);
		return this.toPr(p);
	}
	async mergePr(repo: string, number: number, how: "merge" | "squash" | "rebase") {
		const pr = await this.getPr(repo, number);
		if (pr.state === "merged") return;
		const work = mkdtempSync(join(tmpdir(), "merge-"));
		try {
			await git(work, ["clone", "-q", this.bare(repo), "."]);
			await git(work, ["fetch", "-q", "origin", pr.head]);
			if (how === "squash") {
				await git(work, ["merge", "-q", "--squash", "FETCH_HEAD"]);
				await git(work, ["commit", "-q", "-m", `Merge PR #${number} (squash)`]);
			} else await git(work, ["merge", "-q", "--no-ff", "-m", `Merge PR #${number}`, "FETCH_HEAD"]);
			await git(work, ["push", "-q", "origin", `HEAD:${pr.base}`]);
		} finally {
			rmSync(work, { recursive: true, force: true });
		}
		this.mutate((s) => {
			const p = s.prs.find((x) => x.repo === repo && x.number === number)!;
			p.state = "merged";
		});
		this.log("mergePr", repo, { number, how });
	}

	async checks(repo: string, sha: string): Promise<CheckRun[]> {
		const key = `${repo}@${sha}`;
		const s = this.state();
		if (s.checks[key]) return s.checks[key]!;
		const forced = s.forced[repo]?.length ? s.forced[repo]!.shift()! : undefined;
		if (forced) {
			this.save({ ...s, checks: { ...s.checks, [key]: forced } });
			return forced;
		}
		if (this.running.has(key)) return [{ name: "ci", status: "in_progress" }];
		const workflows = await this.workflowsAt(repo, sha);
		if (workflows.length === 0) return [];
		this.running.add(key);
		const jobs = workflows.flatMap((w) => Object.entries(w.jobs ?? {}).map(([k, j]: [string, any]) => ({ name: j?.name ?? k, steps: (j?.steps ?? []) as any[] })));
		this.mutate((st) => {
			st.checks[key] = jobs.map((j) => ({ name: j.name, status: "in_progress" as const }));
		});
		void this.runJobs(repo, sha, jobs).finally(() => this.running.delete(key));
		return jobs.map((j) => ({ name: j.name, status: "in_progress" as const }));
	}

	private async workflowsAt(repo: string, sha: string): Promise<any[]> {
		const ls = await git(this.bare(repo), ["ls-tree", "--name-only", sha, ".github/workflows/"], { allowFail: true });
		if (ls.code !== 0) return [];
		const out: any[] = [];
		for (const f of ls.stdout.split("\n").filter((x) => /\.ya?ml$/.test(x))) {
			const body = await git(this.bare(repo), ["show", `${sha}:${f}`], { allowFail: true });
			try {
				out.push(YAML.parse(body.stdout));
			} catch {
				out.push({ jobs: { [f]: { steps: [{ run: "echo invalid workflow yaml; exit 1" }] } } });
			}
		}
		return out;
	}

	private async runJobs(repo: string, sha: string, jobs: { name: string; steps: any[] }[]) {
		const key = `${repo}@${sha}`;
		if (this.opts.ciDelayMs) await new Promise((r) => setTimeout(r, this.opts.ciDelayMs));
		const results: CheckRun[] = [];
		for (const job of jobs) {
			const work = mkdtempSync(join(tmpdir(), "ci-"));
			let conclusion = "success";
			let summary = "";
			try {
				await git(work, ["clone", "-q", this.bare(repo), "."]);
				await git(work, ["checkout", "-q", sha]);
				for (const step of job.steps) {
					if (typeof step?.run !== "string") continue; // `uses:` steps (checkout, setup-*) are assumed satisfied locally
					const r = await run("bash", ["-eo", "pipefail", "-c", step.run], { cwd: work, env: baseEnv({ CI: "true" }), timeoutMs: 10 * 60_000 });
					if (r.code !== 0) {
						conclusion = "failure";
						summary = `step "${step.name ?? step.run.split("\n")[0]}" exited ${r.code}:\n${(r.stdout + r.stderr).slice(-3000)}`;
						break;
					}
				}
			} catch (e) {
				conclusion = "failure";
				summary = String(e);
			} finally {
				rmSync(work, { recursive: true, force: true });
			}
			results.push({ name: job.name, status: "completed", conclusion, ...(summary ? { summary } : {}) });
		}
		this.mutate((s) => {
			s.checks[key] = results;
		});
		this.log("ciCompleted", repo, { sha, results: results.map((r) => `${r.name}:${r.conclusion}`) });
	}

	listRemotes(): string[] {
		const dir = join(this.root, "remotes");
		if (!existsSync(dir)) return [];
		return readdirSync(dir).flatMap((o) => readdirSync(join(dir, o)).map((n) => `${o}/${n.replace(/\.git$/, "")}`));
	}
}
