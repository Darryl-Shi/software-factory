// Disk cleanup (docs/specs/run-mv58bn4q-q2zs.md): finished runs', bundles' and discussions' worktrees, manifests, local
// and remote branches, scratch dirs and environment records are deleted as soon as nothing uses them; the startup
// sweep and `gc` backfill old records, retry failed cleanups and remove orphans. Acceptance behaviours 1-15.
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { afterEach, describe, expect, test, vi } from "vitest";
import { Cleaner, cleanupScope, ownerOfEnvName } from "../src/core/cleanup.ts";
import { formatGc, gcCommand, requestGc } from "../src/gc.ts";
import { git } from "../src/github/git.ts";
import { GitHub } from "../src/github/github.ts";
import { startWebServer } from "../src/web/server.ts";
import { bundleIn, inState, makeFactory, type TestEnv, until, untilBundle } from "./helpers.ts";

let t: TestEnv | undefined;
afterEach(async () => {
	vi.restoreAllMocks();
	await t?.factory.cleanupsSettledForTests().catch(() => {});
	await t?.factory.close().catch(() => {});
	t = undefined;
});

const SEED = { "README.md": "# p\n", "AGENTS.md": "Test: true\n" };
let logs: string[] = [];

async function setup(opts: { storage?: "memory" | "sqlite"; sharedFile?: boolean } = {}) {
	logs = [];
	t = await makeFactory({ storage: opts.storage, log: (m) => logs.push(m) });
	if (opts.sharedFile) t.control.sharedFile = true;
	await t.host.seedRepo("me/p", SEED);
	await t.factory.createProject("p", "me/p");
	return t;
}
const start = (title: string) => t!.factory.startRun("p", { source: "test", title, body: `make ${title}` });
const ready = (run: string) => until(t!.factory, run, inState("READY", "FAILED", "CANCELLED"));
const waitMerge = (id: string) => untilBundle(t!.factory, id, (v) => (v.state === "AWAITING_MERGE" && !!v.pendingAsk) || ["MERGED", "FAILED", "CANCELLED", "ESCALATED"].includes(v.state));

async function waitFor(what: string, cond: () => Promise<boolean> | boolean, ms = 30_000) {
	const deadline = Date.now() + ms;
	while (!(await cond())) {
		if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 50));
	}
}

const AREA = (id: string) => (id.startsWith("run-") ? "runs" : id.startsWith("bundle-") ? "bundles" : "discussions");

/** What is on disk of an owner (in `work`, default the test's workdir). */
async function things(id: string, work = join(t!.dir, "work")) {
	const clone = join(work, "repos", "me__p");
	const local = existsSync(join(clone, ".git")) && (await git(clone, ["rev-parse", "--verify", "-q", `refs/heads/factory/${id}`], { allowFail: true })).code === 0;
	const remote = (await git(t!.host.bare("me/p"), ["rev-parse", "--verify", "-q", `refs/heads/factory/${id}`], { allowFail: true })).code === 0;
	const scratchDir = join(work, "scratch");
	const scratch = existsSync(scratchDir) ? readdirSync(scratchDir).filter((n) => ownerOfEnvName(n) === id) : [];
	const envDir = join(t!.dir, "state", "environments");
	const env = existsSync(envDir) ? readdirSync(envDir).filter((n) => ownerOfEnvName(n.replace(/\.json$/, "")) === id) : [];
	return {
		worktree: existsSync(join(work, AREA(id), id)),
		manifest: existsSync(join(work, AREA(id), `${id}.json`)),
		local,
		remote,
		scratch,
		env,
	};
}
const GONE = { worktree: false, manifest: false, local: false, remote: false, scratch: [], env: [] };

const runDoc = (id: string) => t!.factory.runDocument(id);
const bundleDoc = (id: string) => t!.factory.bundleDocument(id);
const discDoc = (id: string) => (t!.factory as any).discussionDoc(id) as Promise<{ cleanedUp?: { scope: string }; taskId?: string }>;

/** A run that pushed its branch and then FAILED at DELIVERING (the push went through, then an error). */
async function failedAfterPush(title: string) {
	const orig = GitHub.prototype.pushBranch;
	const spy = vi.spyOn(GitHub.prototype, "pushBranch").mockImplementationOnce(async function (this: GitHub, ws, rc) {
		await orig.call(this, ws, rc);
		throw new Error("the host went away after the push");
	});
	const run = await start(title);
	const v = await ready(run);
	spy.mockRestore();
	expect(v.state).toBe("FAILED");
	expect(v.failure!.state).toBe("DELIVERING");
	return run;
}

/** Wait until the owner's Task has ended (its finalize recorded its cleanup). */
async function taskEnded(taskId: string | undefined) {
	await waitFor("the task to end", async () => {
		if (taskId === undefined) return true;
		const task = await t!.factory.harnessForTests.getTask(taskId as never, BACKGROUND_CONTEXT);
		return !task || task.state.status === "terminal";
	});
}

describe("the rules", () => {
	test("cleanupScope: one pure function for every owner and state", () => {
		expect(cleanupScope({ kind: "run", state: "DELIVERED" })).toBe("full");
		expect(cleanupScope({ kind: "run", state: "FAILED", cleared: true })).toBe("full");
		expect(cleanupScope({ kind: "run", state: "CANCELLED", cleared: true })).toBe("full");
		expect(cleanupScope({ kind: "run", state: "FAILED" })).toBe("scratch");
		expect(cleanupScope({ kind: "run", state: "CANCELLED" })).toBe("scratch");
		for (const s of ["READY", "BUILDING", "REVIEWING", "DELIVERING", "RECEIVED"]) expect(cleanupScope({ kind: "run", state: s })).toBe("none");
		expect(cleanupScope({ kind: "bundle", state: "MERGED" })).toBe("full");
		expect(cleanupScope({ kind: "bundle", state: "CANCELLED" })).toBe("full");
		expect(cleanupScope({ kind: "bundle", state: "FAILED" })).toBe("scratch");
		expect(cleanupScope({ kind: "bundle", state: "AWAITING_MERGE" })).toBe("none");
		expect(cleanupScope({ kind: "discussion", state: "CLOSED" })).toBe("full");
		expect(cleanupScope({ kind: "discussion", state: "FAILED" })).toBe("full");
		expect(cleanupScope({ kind: "discussion", state: "OPEN" })).toBe("none");
		expect(cleanupScope({ kind: "discussion", state: "PREPARING" })).toBe("none");
	});

	test("deleteRemoteBranch deletes only factory/<owner id>, never the default branch, and skips a repo the host lacks", async () => {
		await setup();
		const gh = new GitHub(t!.host);
		const rc = (runId: string) => ({ runId, config: {} });
		await expect(gh.deleteRemoteBranch("me/p", "main", rc("run-1"))).rejects.toThrow(/refusing/);
		await expect(gh.deleteRemoteBranch("me/p", "factory/run-2", rc("run-1"))).rejects.toThrow(/refusing/);
		const def = vi.spyOn(t!.host, "defaultBranch").mockResolvedValueOnce("factory/run-1");
		await expect(gh.deleteRemoteBranch("me/p", "factory/run-1", rc("run-1"))).rejects.toThrow(/default branch/);
		def.mockRestore();
		expect(await gh.deleteRemoteBranch("me/nothere", "factory/run-1", rc("run-1"))).toBe(false);
		expect(await gh.deleteRemoteBranch("me/p", "factory/run-1", rc("run-1"))).toBe(false); // absent: already gone
		await git(t!.host.bare("me/p"), ["update-ref", "refs/heads/factory/run-1", "refs/heads/main"]);
		expect(await gh.deleteRemoteBranch("me/p", "factory/run-1", rc("run-1"))).toBe(true);
		expect((await git(t!.host.bare("me/p"), ["rev-parse", "--verify", "-q", "refs/heads/factory/run-1"], { allowFail: true })).code).not.toBe(0);
		expect((await git(t!.host.bare("me/p"), ["rev-parse", "--verify", "-q", "refs/heads/main"], { allowFail: true })).code).toBe(0);
	});

	test("Sandbox.removeScratch deletes exactly <id>-<role> dirs (bundle-1 never matches bundle-10-…) and keeps records; destroy deletes a record", async () => {
		const { mkdtempSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { Sandbox } = await import("../src/sandbox/sandbox.ts");
		const dir = mkdtempSync(join(tmpdir(), "sf-scratch-"));
		const sb = new Sandbox({ stateDir: join(dir, "env") });
		const work = join(dir, "work");
		for (const n of ["bundle-1-integrator", "bundle-1-reviewer", "bundle-10-integrator", "bundle-1-x"]) mkdirSync(join(work, "scratch", n, "home"), { recursive: true });
		mkdirSync(join(dir, "env"), { recursive: true });
		const elsewhere = join(dir, "other", "bundle-1-qa");
		mkdirSync(elsewhere, { recursive: true });
		writeFileSync(join(dir, "env", "bundle-1-qa.json"), JSON.stringify({ envId: "bundle-1-qa", scratch: elsewhere }));
		const r = sb.removeScratch("bundle-1", work);
		expect(r.failures).toEqual([]);
		expect(r.removed.sort()).toEqual([`scratch ${elsewhere}`, `scratch ${join(work, "scratch", "bundle-1-integrator")}`, `scratch ${join(work, "scratch", "bundle-1-reviewer")}`].sort());
		expect(readdirSync(join(work, "scratch")).sort()).toEqual(["bundle-1-x", "bundle-10-integrator"]);
		expect(existsSync(join(dir, "env", "bundle-1-qa.json"))).toBe(true);
		expect(sb.recordIds()).toEqual(["bundle-1-qa"]);
		expect(sb.destroy("bundle-1-qa")).toBe(true);
		expect(sb.destroy("bundle-1-qa")).toBe(false);
		expect(sb.recordIds()).toEqual([]);
	});

	test("scratch and record names match exact <id>-<role>", () => {
		expect(ownerOfEnvName("bundle-1-integrator")).toBe("bundle-1");
		expect(ownerOfEnvName("bundle-10-reviewer")).toBe("bundle-10");
		expect(ownerOfEnvName("run-abc-1x2y-qa")).toBe("run-abc-1x2y");
		expect(ownerOfEnvName("disc-3-discussant")).toBe("disc-3");
		expect(ownerOfEnvName("notes-builder")).toBeUndefined();
		expect(ownerOfEnvName("run-x-nobody")).toBeUndefined();
	});
});

describe("runs and bundles", () => {
	test("1, 2: a merged bundle deletes its members' and its own things; the views still load", async () => {
		await setup();
		const run = await start("alpha");
		expect((await ready(run)).state).toBe("READY");
		const before = await things(run);
		expect(before).toMatchObject({ worktree: true, manifest: true, local: true, remote: true });
		expect(before.scratch.length).toBeGreaterThan(0);
		expect(before.env.length).toBeGreaterThan(0);
		const id = await t!.factory.createBundle("p", [run]);
		const b = await waitMerge(id);
		expect(b.state).toBe("AWAITING_MERGE");
		expect(await things(id)).toMatchObject({ worktree: true, manifest: true, local: true, remote: true });
		await t!.factory.mergeBundle(id);
		await until(t!.factory, run, inState("DELIVERED"));
		await untilBundle(t!.factory, id, bundleIn("MERGED"));
		await waitFor("the run's marker", async () => (await runDoc(run)).cleanedUp?.scope === "full");
		await waitFor("the bundle's marker", async () => (await bundleDoc(id)).cleanedUp?.scope === "full");
		expect(await things(run)).toEqual(GONE);
		expect(await things(id)).toEqual(GONE);
		// views, conversations
		const v = await t!.factory.getRun(run);
		expect(v.state).toBe("DELIVERED");
		expect((await t!.factory.getConversation(run, v.conversations.builder!)).items.length).toBeGreaterThan(0);
		const bv = await t!.factory.getBundle(id);
		expect(bv.state).toBe("MERGED");
		const conv = bv.conversations.reviewers[0]?.id ?? bv.conversations.integrator;
		if (conv !== undefined) expect((await t!.factory.getBundleConversation(id, conv)).items).toBeDefined();
	});

	test("3: clearRuns on a FAILED and a CANCELLED run deletes everything; retry stays refused", async () => {
		await setup();
		const failed = await failedAfterPush("alpha");
		const cancelled = await start("beta");
		expect((await ready(cancelled)).state).toBe("READY");
		await t!.factory.cancelRun(cancelled);
		await until(t!.factory, cancelled, inState("CANCELLED"));
		for (const r of [failed, cancelled]) {
			await taskEnded((await runDoc(r)).taskId);
			// not cleared: only the scratch is gone
			expect(await things(r)).toMatchObject({ worktree: true, manifest: true, local: true, remote: true, scratch: [] });
			expect((await runDoc(r)).cleanedUp?.scope).toBe("scratch");
		}
		expect(await t!.factory.clearRuns([failed, cancelled])).toEqual({ cleared: [failed, cancelled] });
		await t!.factory.cleanupsSettledForTests();
		for (const r of [failed, cancelled]) {
			expect(await things(r)).toEqual(GONE);
			expect((await runDoc(r)).cleanedUp?.scope).toBe("full");
			await expect(t!.factory.retryRun(r)).rejects.toMatchObject({ code: "conflict" });
		}
	});

	test("4: an uncleared FAILED run keeps its work and loses only its scratch; retry resumes with its environments", async () => {
		await setup();
		const spy = vi.spyOn(GitHub.prototype, "snapshot").mockRejectedValueOnce(new Error("disk hiccup"));
		const run = await start("alpha");
		const v = await ready(run);
		spy.mockRestore();
		expect(v.state).toBe("FAILED");
		expect(v.failure!.state).toBe("REVIEWING");
		await taskEnded((await runDoc(run)).taskId);
		const after = await things(run);
		expect(after).toMatchObject({ worktree: true, manifest: true, local: true, scratch: [] });
		expect(after.env.length).toBeGreaterThan(0);
		expect((await runDoc(run)).cleanedUp).toMatchObject({ scope: "scratch" });
		await t!.factory.retryRun(run);
		expect((await runDoc(run)).cleanedUp).toBeUndefined();
		const reviewsBefore = t!.control.reviewerInputs.length;
		expect((await ready(run)).state).toBe("READY");
		expect(t!.control.reviewerInputs.length).toBeGreaterThan(reviewsBefore);
		const now = await things(run);
		expect(now.scratch).toContain(`${run}-reviewer`);
		expect(existsSync(join(t!.dir, "work", "scratch", `${run}-reviewer`, "home"))).toBe(true);
		expect(logs.some((l) => /unknown environment/.test(l))).toBe(false);
	});

	test("5: READY runs (in an open bundle or in none) keep everything through cleanups and sweeps", async () => {
		await setup();
		const inBundle = await start("alpha");
		const alone = await start("beta");
		await Promise.all([ready(inBundle), ready(alone)]);
		const id = await t!.factory.createBundle("p", [inBundle]);
		expect((await waitMerge(id)).state).toBe("AWAITING_MERGE");
		const snap = { a: await things(inBundle), b: await things(alone) };
		for (const s of Object.values(snap)) {
			expect(s).toMatchObject({ worktree: true, manifest: true, local: true, remote: true });
			expect(s.scratch.length).toBeGreaterThan(0);
			expect(s.env.length).toBeGreaterThan(0);
		}
		const r = await t!.factory.gc();
		expect(r.removed).toEqual([]);
		expect(await things(inBundle)).toEqual(snap.a);
		expect(await things(alone)).toEqual(snap.b);
		expect(await things(id)).toMatchObject({ worktree: true, manifest: true, local: true, remote: true });
	});

	test("6: a bundle cancelled while its Task is live deletes only its own things; its members ship again", async () => {
		await setup();
		const a = await start("alpha");
		const b = await start("beta");
		await Promise.all([ready(a), ready(b)]);
		const id = await t!.factory.createBundle("p", [a, b]);
		expect((await waitMerge(id)).state).toBe("AWAITING_MERGE");
		expect(await things(id)).toMatchObject({ worktree: true, manifest: true, local: true, remote: true });
		await t!.factory.cancelBundle(id, "not now");
		await untilBundle(t!.factory, id, bundleIn("CANCELLED"));
		await waitFor("the bundle's marker", async () => (await bundleDoc(id)).cleanedUp?.scope === "full");
		expect(await things(id)).toEqual(GONE);
		for (const r of [a, b]) {
			expect((await until(t!.factory, r, (x) => x.bundle === undefined)).state).toBe("READY");
			expect(await things(r)).toMatchObject({ worktree: true, manifest: true, local: true, remote: true });
		}
		const again = await t!.factory.createBundle("p", [a, b]);
		expect((await waitMerge(again)).state).toBe("AWAITING_MERGE");
		await t!.factory.mergeBundle(again);
		expect((await untilBundle(t!.factory, again, bundleIn("MERGED", "FAILED"))).state).toBe("MERGED");
	});

	test("7, 8: a FAILED bundle loses only its scratch and can be retried; cancelling a FAILED bundle deletes its own things", async () => {
		await setup();
		const a = await start("alpha");
		const b = await start("beta");
		await Promise.all([ready(a), ready(b)]);
		// 8: FAILED → retry → merge
		const spy = vi.spyOn(GitHub.prototype, "deliverBundle").mockRejectedValueOnce(new Error("GitHub is down"));
		const id = await t!.factory.createBundle("p", [a]);
		const failed = await untilBundle(t!.factory, id, bundleIn("FAILED", "AWAITING_MERGE"));
		spy.mockRestore();
		expect(failed.state).toBe("FAILED");
		await taskEnded((await bundleDoc(id)).taskId);
		const kept = await things(id);
		expect(kept).toMatchObject({ worktree: true, manifest: true, local: true, scratch: [] });
		expect(kept.env.length).toBeGreaterThan(0);
		expect((await bundleDoc(id)).cleanedUp?.scope).toBe("scratch");
		await t!.factory.retryBundle(id);
		expect((await bundleDoc(id)).cleanedUp).toBeUndefined();
		expect((await waitMerge(id)).state).toBe("AWAITING_MERGE");
		await t!.factory.mergeBundle(id);
		expect((await untilBundle(t!.factory, id, bundleIn("MERGED", "FAILED"))).state).toBe("MERGED");
		await until(t!.factory, a, inState("DELIVERED"));
		// 7: FAILED → Cancel bundle (no Task) → its own things go, the member keeps its own
		const spy2 = vi.spyOn(GitHub.prototype, "deliverBundle").mockRejectedValueOnce(new Error("GitHub is down"));
		const id2 = await t!.factory.createBundle("p", [b]);
		expect((await untilBundle(t!.factory, id2, bundleIn("FAILED", "AWAITING_MERGE"))).state).toBe("FAILED");
		spy2.mockRestore();
		await taskEnded((await bundleDoc(id2)).taskId);
		expect(await things(id2)).toMatchObject({ worktree: true, local: true });
		await t!.factory.cancelBundle(id2, "not now");
		await t!.factory.cleanupsSettledForTests();
		expect(await things(id2)).toEqual(GONE);
		expect((await bundleDoc(id2)).cleanedUp?.scope).toBe("full");
		expect((await until(t!.factory, b, (x) => x.bundle === undefined)).state).toBe("READY");
		expect(await things(b)).toMatchObject({ worktree: true, manifest: true, local: true, remote: true });
		const id3 = await t!.factory.createBundle("p", [b]);
		expect((await waitMerge(id3)).state).toBe("AWAITING_MERGE");
		await t!.factory.mergeBundle(id3);
		expect((await untilBundle(t!.factory, id3, bundleIn("MERGED", "FAILED"))).state).toBe("MERGED");
	});

	test("11: a failed deletion step is logged; the owner still ends; a later sweep finishes the job", async () => {
		await setup();
		const run = await start("alpha");
		await ready(run);
		const id = await t!.factory.createBundle("p", [run]);
		expect((await waitMerge(id)).state).toBe("AWAITING_MERGE");
		t!.host.failDeleteBranch = 2; // the run's and the bundle's remote branch
		await t!.factory.mergeBundle(id);
		await until(t!.factory, run, inState("DELIVERED"));
		await untilBundle(t!.factory, id, bundleIn("MERGED"));
		await taskEnded((await runDoc(run)).taskId);
		await taskEnded((await bundleDoc(id)).taskId);
		expect(t!.host.failDeleteBranch).toBe(0);
		expect((await runDoc(run)).cleanedUp).toBeUndefined();
		expect((await bundleDoc(id)).cleanedUp).toBeUndefined();
		expect(logs.some((l) => l.includes(`cleanup run ${run}: remote branch:`))).toBe(true);
		expect(logs.some((l) => l.includes(`cleanup bundle ${id}: remote branch:`))).toBe(true);
		// the other steps ran all the same
		expect(await things(run)).toMatchObject({ worktree: false, manifest: false, local: false, remote: true, scratch: [], env: [] });
		const r = await t!.factory.gc();
		expect(r.failures).toEqual([]);
		expect(r.removed).toEqual(expect.arrayContaining([`remote branch factory/${run} (me/p)`, `remote branch factory/${id} (me/p)`]));
		expect(await things(run)).toEqual(GONE);
		expect(await things(id)).toEqual(GONE);
		expect((await runDoc(run)).cleanedUp?.scope).toBe("full");
		expect((await bundleDoc(id)).cleanedUp?.scope).toBe("full");
	});

	test("11: a directory that can't be removed is a failure; the marker stays at the lower scope", async () => {
		await setup();
		const failed = await failedAfterPush("alpha");
		await taskEnded((await runDoc(failed)).taskId);
		const orig = GitHub.prototype.discard;
		const spy = vi.spyOn(GitHub.prototype, "discard").mockImplementationOnce(async () => ({ removed: [], failures: ["worktree: forced failure"] }));
		await t!.factory.clearRuns([failed]);
		await t!.factory.cleanupsSettledForTests();
		expect(spy).toHaveBeenCalled();
		expect(logs.some((l) => l.includes(`cleanup run ${failed}: worktree: forced failure`))).toBe(true);
		expect((await runDoc(failed)).cleanedUp?.scope).toBe("scratch");
		expect(await things(failed)).toMatchObject({ worktree: true, remote: false, env: [] });
		spy.mockImplementation(orig);
		await t!.factory.gc();
		expect(await things(failed)).toEqual(GONE);
		expect((await runDoc(failed)).cleanedUp?.scope).toBe("full");
	});
});

describe("discussions", () => {
	const open = (v: { state: string; turn: unknown }) => v.state === "OPEN" && v.turn === null;
	const lastReply = async (id: string) => (await t!.factory.getDiscussionConversation(id)).items.at(-1);

	test("9: CLOSED deletes the checkout, its branch, scratch and record; reopen re-creates it at the latest default branch", async () => {
		await setup();
		const id = await t!.factory.startDiscussion("p", { title: "t", message: "m" });
		await t!.factory.waitForDiscussion(id, open);
		expect(await things(id)).toMatchObject({ worktree: true, manifest: true, local: true });
		await t!.factory.closeDiscussion(id);
		await t!.factory.waitForDiscussion(id, (v) => v.state === "CLOSED");
		await waitFor("the discussion's marker", async () => (await discDoc(id)).cleanedUp?.scope === "full");
		expect(await things(id)).toEqual(GONE);
		await t!.host.pushCommit("me/p", { "NEW.md": "new\n" });
		await t!.factory.reopenDiscussion(id);
		expect((await discDoc(id)).cleanedUp).toBeUndefined();
		await t!.factory.waitForDiscussion(id, open);
		expect(await things(id)).toMatchObject({ worktree: true, manifest: true, local: true });
		await t!.factory.say(id, "READ: NEW.md");
		await t!.factory.waitForDiscussion(id, open);
		expect(await lastReply(id)).toMatchObject({ role: "assistant", text: expect.stringContaining("read ok: new") });
	});

	test("10: FAILED (task aborted, or a failed prepare) is cleaned the same way; retry re-creates the checkout", async () => {
		await setup();
		const id = await t!.factory.startDiscussion("p", { title: "t", message: "m" });
		await t!.factory.waitForDiscussion(id, open);
		// the abort path
		await t!.factory.harnessForTests.abortTask((await discDoc(id)).taskId as never, BACKGROUND_CONTEXT);
		await t!.factory.waitForDiscussion(id, (v) => v.state === "FAILED");
		await waitFor("the discussion's marker", async () => (await discDoc(id)).cleanedUp?.scope === "full");
		expect(await things(id)).toEqual(GONE);
		await t!.factory.retryDiscussion(id);
		await t!.factory.waitForDiscussion(id, open);
		await t!.factory.say(id, "READ: README.md");
		await t!.factory.waitForDiscussion(id, open);
		expect(await lastReply(id)).toMatchObject({ text: expect.stringContaining("read ok: # p") });
		// the failure path (PREPARING fails after the checkout was re-created)
		await t!.factory.closeDiscussion(id);
		await t!.factory.waitForDiscussion(id, (v) => v.state === "CLOSED");
		const { Sandbox } = await import("../src/sandbox/sandbox.ts");
		const spy = vi.spyOn(Sandbox.prototype, "provision").mockRejectedValueOnce(new Error("no environment today"));
		await t!.factory.reopenDiscussion(id);
		await t!.factory.waitForDiscussion(id, (v) => v.state === "FAILED");
		spy.mockRestore();
		await waitFor("the discussion's marker", async () => (await discDoc(id)).cleanedUp?.scope === "full");
		expect(await things(id)).toEqual(GONE);
		await t!.factory.retryDiscussion(id);
		await t!.factory.waitForDiscussion(id, open);
		await t!.factory.say(id, "READ: README.md");
		await t!.factory.waitForDiscussion(id, open);
		expect(await lastReply(id)).toMatchObject({ text: expect.stringContaining("read ok: # p") });
	});
});

describe("startup sweep and gc", () => {
	test("12-14: the sweep removes exactly what the rules allow, in each record's pinned workdir; a second start removes nothing", async () => {
		await setup({ storage: "sqlite" });
		const f = () => t!.factory;
		// Records as they were before this change: no cleanup at all while they are made.
		const off = vi.spyOn(Cleaner.prototype, "cleanup").mockResolvedValue({ removed: [], failures: ["cleanup off (test)"] });
		const delivered = await start("delivered");
		await ready(delivered);
		const merged = await f().createBundle("p", [delivered]);
		await waitMerge(merged);
		await f().mergeBundle(merged);
		await untilBundle(f(), merged, bundleIn("MERGED"));
		await until(f(), delivered, inState("DELIVERED"));
		const cleared = await failedAfterPush("cleared");
		const uncleared = await failedAfterPush("uncleared");
		const readyRun = await start("ready");
		const failedMember = await start("failed member");
		await Promise.all([ready(readyRun), ready(failedMember)]);
		const openBundle = await f().createBundle("p", [readyRun]);
		await waitMerge(openBundle);
		const spy = vi.spyOn(GitHub.prototype, "deliverBundle").mockRejectedValueOnce(new Error("GitHub is down"));
		const failedBundle = await f().createBundle("p", [failedMember]);
		await untilBundle(f(), failedBundle, bundleIn("FAILED"));
		spy.mockRestore();
		await f().clearRuns([cleared]);
		const closed = await f().startDiscussion("p", { title: "c", message: "m" });
		await f().waitForDiscussion(closed, (v) => v.state === "OPEN" && v.turn === null);
		await f().closeDiscussion(closed);
		await f().waitForDiscussion(closed, (v) => v.state === "CLOSED");
		const openDisc = await f().startDiscussion("p", { title: "o", message: "m" });
		await f().waitForDiscussion(openDisc, (v) => v.state === "OPEN" && v.turn === null);
		for (const id of [delivered, cleared, uncleared]) await taskEnded((await runDoc(id)).taskId);
		for (const id of [merged, failedBundle]) await taskEnded((await bundleDoc(id)).taskId);
		await f().cleanupsSettledForTests();
		off.mockRestore();
		const work = join(t!.dir, "work");
		for (const id of [delivered, cleared, uncleared]) expect((await things(id)).worktree).toBe(true);
		expect(await things(cleared)).toMatchObject({ remote: true });
		expect(await things(delivered)).toMatchObject({ remote: true });
		// orphans and a non-factory entry
		mkdirSync(join(work, "runs", "run-x", "node_modules"), { recursive: true });
		writeFileSync(join(work, "runs", "run-x.json"), "{}");
		mkdirSync(join(work, "scratch", "run-x-builder", "home"), { recursive: true });
		writeFileSync(join(t!.dir, "state", "environments", "run-x-builder.json"), "{}");
		await git(join(work, "repos", "me__p"), ["branch", "factory/run-x", "HEAD"]);
		mkdirSync(join(work, "runs", "notes"), { recursive: true });
		writeFileSync(join(work, "runs", "notes", "keep.txt"), "mine");
		// 14: the global workdir moves; the records keep their pinned one
		await f().setSetting({ global: true }, "workdir", join(t!.dir, "work2"));
		const keep = {
			readyRun: await things(readyRun),
			openBundle: await things(openBundle),
			openDisc: await things(openDisc),
			failedMember: await things(failedMember),
		};
		const before = { uncleared: await things(uncleared), failedBundle: await things(failedBundle) };
		expect(before.uncleared.scratch.length).toBeGreaterThan(0);
		expect(before.failedBundle.scratch.length).toBeGreaterThan(0);

		await f().close();
		logs = [];
		await t!.reopen();
		await t!.factory.cleanupsSettledForTests();

		for (const id of [delivered, cleared, merged, closed]) expect(await things(id), id).toEqual(GONE);
		expect(await things(uncleared)).toEqual({ ...before.uncleared, scratch: [] });
		expect(await things(failedBundle)).toEqual({ ...before.failedBundle, scratch: [] });
		expect(await things(readyRun)).toEqual(keep.readyRun);
		expect(await things(openBundle)).toEqual(keep.openBundle);
		expect(await things(openDisc)).toEqual(keep.openDisc);
		expect(await things(failedMember)).toEqual(keep.failedMember);
		expect(existsSync(join(work, "runs", "run-x"))).toBe(false);
		expect(existsSync(join(work, "runs", "run-x.json"))).toBe(false);
		expect(existsSync(join(work, "scratch", "run-x-builder"))).toBe(false);
		expect(existsSync(join(t!.dir, "state", "environments", "run-x-builder.json"))).toBe(false);
		expect((await git(join(work, "repos", "me__p"), ["rev-parse", "--verify", "-q", "refs/heads/factory/run-x"], { allowFail: true })).code).not.toBe(0);
		expect(existsSync(join(work, "runs", "notes", "keep.txt"))).toBe(true);
		const summary = logs.filter((l) => l.startsWith("disk sweep: removed"));
		expect(summary).toHaveLength(1);
		expect(summary[0]).toMatch(/^disk sweep: removed \d+ items \(runs \d+, bundles \d+, discussions \d+, scratch \d+, env records \d+, branches \d+ local \/ 3 remote\), 0 failures$/);
		for (const id of [delivered, cleared]) expect((await runDoc(id)).cleanedUp?.scope).toBe("full");
		expect((await runDoc(uncleared)).cleanedUp?.scope).toBe("scratch");
		expect((await bundleDoc(merged)).cleanedUp?.scope).toBe("full");
		expect((await bundleDoc(failedBundle)).cleanedUp?.scope).toBe("scratch");
		expect((await runDoc(readyRun)).cleanedUp).toBeUndefined();

		// 13: a second start removes nothing
		await t!.factory.close();
		logs = [];
		await t!.reopen();
		await t!.factory.cleanupsSettledForTests();
		expect(logs.filter((l) => l.startsWith("disk sweep: removed"))).toEqual([
			"disk sweep: removed 0 items (runs 0, bundles 0, discussions 0, scratch 0, env records 0, branches 0 local / 0 remote), 0 failures",
		]);
		expect(await things(readyRun)).toEqual(keep.readyRun);
	});

	test("15: gc over HTTP and `factory gc` print what was removed; with nothing left, that nothing was removed", async () => {
		await setup();
		const work = join(t!.dir, "work");
		mkdirSync(join(work, "scratch", "run-gone-builder"), { recursive: true });
		const { url, stop } = await startWebServer(t!.factory.as("web"), { host: "127.0.0.1", port: 0, tokenFile: join(t!.dir, "home", "web-token") });
		try {
			await t!.factory.cleanupsSettledForTests(); // the startup sweep
			const r = await requestGc(url);
			expect(r.removed).toEqual([`scratch ${join(work, "scratch", "run-gone-builder")}`]);
			expect(r.summary).toContain("removed 1 items");
			expect(formatGc(r).join("\n")).toContain("run-gone-builder");
			// `factory gc` reads the running factory's web-url next to the config
			writeFileSync(join(t!.dir, "web-url"), `${url}\n`);
			const out: string[] = [];
			expect(await gcCommand(t!.configPath, (s) => out.push(s), (s) => out.push(s))).toBe(0);
			expect(out.join("\n")).toContain("Nothing was removed.");
			expect(out[0]).toMatch(/^disk sweep: removed 0 items/);
		} finally {
			await stop();
		}
		const out: string[] = [];
		expect(await gcCommand(t!.configPath, (s) => out.push(s), (s) => out.push(s))).toBe(1);
		expect(out.join("\n")).toMatch(/no factory is running/);
		const none: string[] = [];
		expect(await gcCommand(join(t!.dir, "elsewhere", "config.yaml"), (s) => none.push(s), (s) => none.push(s))).toBe(1);
		expect(none.join("\n")).toMatch(/no factory is running/);
	});

	test("a second gc while one runs waits for it and returns its result", async () => {
		await setup();
		await t!.factory.cleanupsSettledForTests();
		const [a, b] = await Promise.all([t!.factory.gc(), t!.factory.gc()]);
		expect(a).toEqual(b);
	});
});

