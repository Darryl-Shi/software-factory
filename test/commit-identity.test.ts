// Commits authored by the GitHub identity's account (docs/specs/run-mv6dwfsi-7xli.md), acceptance behaviours 1, 4, 5
// and 6 end to end: every factory-made commit (host-side and in-sandbox) carries the account's no-reply identity, a
// failed lookup fails the step before any commit, lookups are cached per identity, and old environment records (no
// commitIdentity) get it when reopened after a restart.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { BundleView, RunView } from "../src/core/types.ts";
import { git } from "../src/github/git.ts";
import { LocalGitHubHost } from "../src/github/host.ts";
import { bundleIn, inState, makeFactory, newControl, type TestEnv, until, untilBundle } from "./helpers.ts";

let t: TestEnv | undefined;
afterEach(async () => {
	await t?.factory.close().catch(() => {});
	t = undefined;
});

const OCTOCAT = "octocat <583231+octocat@users.noreply.github.com>";
const GITHUB_SIDE = "GitHub <noreply@github.com>";
const SEED = { "README.md": "# p\n", "AGENTS.md": "Test: true\n" };

const start = (title: string, project = "p") => t!.factory.startRun(project, { source: "test", title, body: `make ${title}` });
const ready = (run: string) => until(t!.factory, run, inState("READY", "FAILED", "CANCELLED"));

/** `git log` of `ref` in `cwd`: one entry per commit (subject, author, committer). */
async function log(cwd: string, ref: string) {
	const out = (await git(cwd, ["log", "--format=%s%x1f%an <%ae>%x1f%cn <%ce>", ref])).stdout.trim();
	return out.split("\n").map((l) => {
		const [subject, author, committer] = l.split("\x1f");
		return { subject: subject!, author: author!, committer: committer! };
	});
}

describe("delivered commits are the account's (pat identity)", () => {
	test("new repo: the spec, the builder's own commits, the uncommitted builder changes, the integration merges, the integrator's conflict commit and the delivery notes on main are all octocat's", async () => {
		t = await makeFactory();
		t.host.setAccount({ id: 583231, login: "octocat" });
		t.control.sharedFile = true;
		t.control.builderCommits = true;
		await t.factory.createProject("p", "me/p");
		const a = await start("alpha");
		const b = await start("beta");
		const [ra, rb] = await Promise.all([ready(a), ready(b)]);
		expect(ra.state).toBe("READY");
		expect(rb.state).toBe("READY");
		// the builder committed inside its environment as the account
		expect(t.control.builderCommitOutputs!.length).toBeGreaterThanOrEqual(2);
		for (const o of t.control.builderCommitOutputs!) expect(o).toContain(`${OCTOCAT}|${OCTOCAT}`);
		const id = await t.factory.createBundle("p", [a, b]);
		const v = await untilBundle(t.factory, id, bundleIn("MERGED", "FAILED", "ESCALATED", "CANCELLED"));
		expect(v.state).toBe("MERGED");
		expect(v.integration?.resolved).toEqual([{ run: b, files: ["shared.txt"] }]);
		expect(t.control.integratorInputs[0]).toContain("# Merge conflict");

		const bare = t.host.bare("me/p");
		const commits = await log(bare, "main");
		// only the account, as author and as committer
		expect(new Set(commits.map((c) => `${c.author}|${c.committer}`))).toEqual(new Set([`${OCTOCAT}|${OCTOCAT}`]));
		const subjects = commits.map((c) => c.subject);
		expect(subjects).toContain("factory: initial commit");
		expect(subjects).toContain(`docs: spec v1 (factory run ${a})`);
		expect(subjects).toContain(`docs: spec v1 (factory run ${b})`);
		expect(subjects.filter((s) => s === "builder: round 1").length).toBe(2);
		expect(subjects.filter((s) => s === "factory: commit uncommitted builder changes").length).toBe(2);
		expect(subjects.some((s) => s.startsWith(`Merge factory/${a} (alpha) into`))).toBe(true);
		expect(subjects.some((s) => s.startsWith(`Merge factory/${b} (beta) into`))).toBe(true);
		expect(subjects).toContain("docs: delivery notes");
		// the integrator's conflict commit: the merge of b, committed inside the integrator's environment, with its resolution
		const merges = (await git(bare, ["log", "--merges", "--format=%H %s", "main"])).stdout.trim().split("\n");
		const conflictMerge = merges.find((l) => l.includes(`Merge factory/${b} (beta)`))!.split(" ")[0]!;
		expect((await git(bare, ["show", `${conflictMerge}:shared.txt`])).stdout).toBe("resolved by the integrator\n");
		expect((await git(bare, ["log", "-1", "--format=%an <%ae>|%cn <%ce>", conflictMerge])).stdout.trim()).toBe(`${OCTOCAT}|${OCTOCAT}`);
		// the uncommitted leftover went in with the factory's commit
		expect((await git(bare, ["show", "main:leftover.txt"])).stdout).toBe("left for the factory to commit (round 1)\n");
		expect(commits.some((c) => /factory-|@factory\.local|factory@localhost|software-factory/.test(`${c.author} ${c.committer}`))).toBe(false);
	});

	test("existing repo: everything on main but GitHub's own commits (the seed, the PR merge) is octocat's", async () => {
		t = await makeFactory();
		t.host.setAccount({ id: 583231, login: "octocat" });
		t.control.builderCommits = true;
		await t.host.seedRepo("me/p", SEED);
		await t.factory.createProject("p", "me/p");
		await t.factory.setSetting({ project: "p" }, "bundle.mergeMethod", "merge");
		const a = await start("alpha");
		expect((await ready(a)).state).toBe("READY");
		const id = await t.factory.createBundle("p", [a]);
		let v: BundleView = await untilBundle(t.factory, id, (x) => (x.state === "AWAITING_MERGE" && !!x.pendingAsk) || ["MERGED", "FAILED", "ESCALATED"].includes(x.state));
		expect(v.state).toBe("AWAITING_MERGE");
		await t.factory.mergeBundle(id);
		v = await untilBundle(t.factory, id, bundleIn("MERGED", "FAILED"));
		expect(v.state).toBe("MERGED");
		const commits = await log(t.host.bare("me/p"), "main");
		const github = commits.filter((c) => c.author === GITHUB_SIDE);
		expect(github.map((c) => c.subject).sort()).toEqual(["Merge PR #1", "seed"].sort());
		const ours = commits.filter((c) => c.author !== GITHUB_SIDE);
		expect(ours.length).toBeGreaterThanOrEqual(4);
		for (const c of ours) expect(`${c.author}|${c.committer}`).toBe(`${OCTOCAT}|${OCTOCAT}`);
		const subjects = ours.map((c) => c.subject);
		expect(subjects).toContain(`docs: spec v1 (factory run ${a})`);
		expect(subjects).toContain("builder: round 1");
		expect(subjects).toContain("factory: commit uncommitted builder changes");
		expect(subjects.some((s) => s.startsWith(`Merge factory/${a} (alpha) into`))).toBe(true);
	});
});

describe("a failed lookup fails the step before any commit", () => {
	const SECRET = "ghp_SECRET_TOKEN_VALUE_4242";

	test("a new run fails in PREPARING naming the identity and GET /user; no clone, no commit, no repo, no secret", async () => {
		process.env.SF_TEST_ID_TOKEN = SECRET;
		t = await makeFactory();
		await t.factory.setSetting({ global: true }, "github.identity.tokenRef", "env:SF_TEST_ID_TOKEN");
		await t.factory.createProject("p", "me/p");
		t.host.failIdentity("401 Bad credentials");
		const a = await start("alpha");
		const r = await until(t.factory, a, inState("FAILED", "READY", "CANCELLED"));
		expect(r.state).toBe("FAILED");
		expect(r.failure?.state).toBe("PREPARING");
		const reason = r.failure!.reason;
		expect(reason).toContain("cannot resolve the commit identity");
		expect(reason).toContain("kind pat");
		expect(reason).toContain("tokenRef env:SF_TEST_ID_TOKEN");
		expect(reason).toContain("GET /user");
		expect(reason).toContain("401 Bad credentials");
		expect(reason).not.toContain(SECRET);
		expect(JSON.stringify(r)).not.toContain(SECRET);
		// no clone (so no initial commit), no workspace, no remote repo
		expect(r.workspace).toBeUndefined();
		expect(existsSync(join(t.dir, "work", "repos", "me__p"))).toBe(false);
		expect(existsSync(t.host.bare("me/p"))).toBe(false);
		expect(t.host.state().created).toEqual([]);
		expect(t.host.state().calls.filter((c) => c.op === "commitIdentity").length).toBeGreaterThanOrEqual(1);
	});

	test("a bundle created by a fresh process whose lookup fails: FAILED in INTEGRATING with the message, no new commits; once the lookup works again, Retry delivers", async () => {
		process.env.SF_TEST_ID_TOKEN = SECRET;
		t = await makeFactory({ storage: "sqlite" });
		await t.factory.setSetting({ global: true }, "github.identity.tokenRef", "env:SF_TEST_ID_TOKEN");
		await t.host.seedRepo("me/p", SEED);
		await t.factory.createProject("p", "me/p");
		const a = await start("alpha");
		expect((await ready(a)).state).toBe("READY");
		const bare = t.host.bare("me/p");
		const clone = join(t.dir, "work", "repos", "me__p");
		const refs = async (cwd: string) => (await git(cwd, ["for-each-ref", "--format=%(refname) %(objectname)"])).stdout;
		const bareBefore = await refs(bare);
		const cloneBefore = await refs(clone);
		const lookups = t.host.state().calls.filter((c) => c.op === "commitIdentity").length;
		// a new process: the cache is per process, so the bundle needs a lookup of its own
		await t.factory.close();
		t.host.failIdentity("401 Bad credentials");
		await t.reopen();
		const id = await t.factory.createBundle("p", [a]);
		let v = await untilBundle(t.factory, id, bundleIn("FAILED", "MERGED", "AWAITING_MERGE", "ESCALATED"));
		expect(v.state).toBe("FAILED");
		expect(v.failure?.state).toBe("INTEGRATING");
		expect(v.failure!.reason).toContain("cannot resolve the commit identity");
		expect(v.failure!.reason).toContain("kind pat");
		expect(v.failure!.reason).toContain("tokenRef env:SF_TEST_ID_TOKEN");
		expect(v.failure!.reason).toContain("GET /user failed: 401 Bad credentials");
		expect(JSON.stringify(v)).not.toContain(SECRET);
		expect(v.workspace).toBeUndefined();
		expect(t.host.state().calls.filter((c) => c.op === "commitIdentity").length).toBeGreaterThan(lookups);
		expect(await refs(bare)).toBe(bareBefore);
		expect(await refs(clone)).toBe(cloneBefore);
		expect(t.host.state().prs).toEqual([]);
		// failures are not cached: the lookup works again and Retry goes through
		t.host.failIdentity(undefined);
		await t.factory.retryBundle(id);
		v = await untilBundle(t.factory, id, (x) => (x.state === "AWAITING_MERGE" && !!x.pendingAsk) || ["MERGED", "FAILED", "ESCALATED"].includes(x.state));
		expect(v.state).toBe("AWAITING_MERGE");
	});
});

describe("lookups are cached per identity", () => {
	test("a run and a bundle with the same identity: one lookup; a project with another github.identity: one more", async () => {
		t = await makeFactory();
		const lookups = () => t!.host.state().calls.filter((c) => c.op === "commitIdentity");
		await t.factory.createProject("p", "me/p");
		const a = await start("alpha");
		expect((await ready(a)).state).toBe("READY");
		const id = await t.factory.createBundle("p", [a]);
		expect((await untilBundle(t.factory, id, bundleIn("MERGED", "FAILED", "ESCALATED"))).state).toBe("MERGED");
		expect(lookups().length).toBe(1);
		expect(lookups()[0]!.detail).toMatchObject({ kind: "pat", tokenRef: "env:GH_TOKEN" });
		// another project with its own github.identity
		await t.factory.createProject("q", "me/q");
		await t.factory.setSetting({ project: "q" }, "github.identity.tokenRef", "env:SF_TEST_OTHER_TOKEN");
		const b = await start("beta", "q");
		expect((await ready(b)).state).toBe("READY");
		const id2 = await t.factory.createBundle("q", [b]);
		expect((await untilBundle(t.factory, id2, bundleIn("MERGED", "FAILED", "ESCALATED"))).state).toBe("MERGED");
		// and project p again: still cached
		const c = await start("gamma");
		expect((await ready(c)).state).toBe("READY");
		expect(lookups().length).toBe(2);
		expect(lookups()[1]!.detail).toMatchObject({ kind: "pat", tokenRef: "env:SF_TEST_OTHER_TOKEN" });
	});
});

/** The crash child (test/fixtures/crash-child.ts): runs until it is ready, then gets SIGKILLed. */
async function crashChild(dir: string, mode: string): Promise<{ run: string; before: RunView }> {
	const child = spawn(process.execPath, ["--import", "tsx", join(__dirname, "fixtures/crash-child.ts"), dir, mode], { stdio: "pipe", cwd: join(__dirname, "..") });
	let err = "";
	child.stderr.on("data", (d) => (err += d));
	const deadline = Date.now() + 30_000;
	while (!existsSync(join(dir, "ready"))) {
		if (Date.now() > deadline || child.exitCode !== null) {
			child.kill("SIGKILL");
			throw new Error(`child did not get ready (exit ${child.exitCode}): ${err}`);
		}
		await new Promise((r) => setTimeout(r, 50));
	}
	child.kill("SIGKILL");
	await new Promise((r) => child.once("exit", r));
	return { run: readFileSync(join(dir, "run-id"), "utf8"), before: JSON.parse(readFileSync(join(dir, "ready"), "utf8")) };
}

describe("old environment records", () => {
	test("a run mid-build whose records lack commitIdentity: after a restart the records gain it and the run branch's commits are the account's", async () => {
		const dir = mkdtempSync(join(tmpdir(), "sf-cid-"));
		new LocalGitHubHost(join(dir, "github")).setAccount({ id: 583231, login: "octocat" });
		const { run, before } = await crashChild(dir, "mid-build");
		expect(before.state).toBe("BUILDING");
		expect(before.reviewRound).toBe(2);
		// as written before this change: no commitIdentity
		const envDir = join(dir, "state", "environments");
		const files = readdirSync(envDir).filter((f) => f.startsWith(run) && f.endsWith(".json"));
		expect(files.map((f) => f.slice(run.length + 1, -5)).sort()).toEqual(["architect", "builder", "reviewer"]);
		for (const f of files) {
			const rec = JSON.parse(readFileSync(join(envDir, f), "utf8"));
			expect(rec.commitIdentity).toEqual({ name: "octocat", email: "583231+octocat@users.noreply.github.com" });
			delete rec.commitIdentity;
			writeFileSync(join(envDir, f), JSON.stringify(rec, null, 2));
		}
		const control = newControl();
		control.reviews = ["pass"];
		control.builderCommits = true;
		t = await makeFactory({ dir, storage: "sqlite", control });
		const r = await t.factory.waitForState(run, (x) => ["READY", "FAILED"].includes(x.state));
		expect(r.state).toBe("READY");
		expect(r.reviewRound).toBe(2);
		// the reopened environments (the builder's, then the new reviewer's) got the identity back
		for (const role of ["builder", "reviewer"]) {
			const rec = JSON.parse(readFileSync(join(envDir, `${run}-${role}.json`), "utf8"));
			expect(rec.commitIdentity).toEqual({ name: "octocat", email: "583231+octocat@users.noreply.github.com" });
		}
		// the builder's in-sandbox commit after the restart is the account's
		expect(control.builderCommitOutputs).toHaveLength(1);
		expect(control.builderCommitOutputs![0]).toContain(`${OCTOCAT}|${OCTOCAT}`);
		const ws = r.workspace!;
		const commits = await log(ws.path, ws.branch);
		const subjects = commits.map((c) => c.subject);
		expect(subjects).toContain("builder: round 2");
		expect(subjects).toContain("factory: commit uncommitted builder changes");
		expect(subjects).toContain(`docs: spec v1 (factory run ${run})`);
		for (const c of commits) expect(`${c.author}|${c.committer}`).toBe(`${OCTOCAT}|${OCTOCAT}`);
		expect(commits.some((c) => /factory-(builder|integrator|architect|reviewer|helper|discussant)|@factory\.local/.test(`${c.author} ${c.committer}`))).toBe(false);
	});
});
