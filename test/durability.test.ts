// Crash/resume durability (spec §4, §8.3): kill -9 the process mid-build and at a pending approval; reopening the
// storage resumes the run from its last committed step, at the same round, with the same builder Conversation.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { BundleView, DiscussionView, FactoryEvent, RunView } from "../src/core/types.ts";
import { bundleIn, makeFactory, newControl, shipAndMerge, type TestEnv, untilBundle } from "./helpers.ts";

let t: TestEnv | undefined;
afterEach(async () => {
	await t?.factory.close().catch(() => {});
	t = undefined;
});

/** `run`: the id the child wrote (a discussion's for the "disc-" modes); `before`: its view when it was killed. */
async function crashChild<V = RunView>(dir: string, mode: string): Promise<{ run: string; before: V; bundle?: string }> {
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
	const bundle = existsSync(join(dir, "bundle-id")) ? readFileSync(join(dir, "bundle-id"), "utf8") : undefined;
	return { run: readFileSync(join(dir, "run-id"), "utf8"), before: JSON.parse(readFileSync(join(dir, "ready"), "utf8")), ...(bundle ? { bundle } : {}) };
}

test("kill -9 mid-build: the run resumes at the same round with the same builder conversation", async () => {
	const dir = mkdtempSync(join(tmpdir(), "sf-crash-"));
	const { run, before } = await crashChild(dir, "mid-build");
	expect(before.state).toBe("BUILDING");
	expect(before.reviewRound).toBe(2);
	const control = newControl();
	control.reviews = ["pass"];
	t = await makeFactory({ dir, storage: "sqlite", control });
	const resumed = await t.factory.getRun(run);
	expect(resumed.state).toBe("BUILDING");
	expect(resumed.reviewRound).toBe(2);
	expect(resumed.conversations.builder).toBe(before.conversations.builder);
	const r = await t.factory.waitForState(run, (x) => ["READY", "FAILED"].includes(x.state));
	expect(r.state).toBe("READY");
	await t.factory.createProject("todo", "me/todo"); // makeFactory rewrote config.yaml: add the project back
	const v = await shipAndMerge(t.factory, run);
	expect(v.state).toBe("DELIVERED");
	expect(v.reviewRound).toBe(2);
	expect(v.conversations.builder).toBe(before.conversations.builder);
	// nothing before the crash was redone: one discussion, one spec, two builds, two reviews
	expect(v.history.map((h) => h.to)).toEqual(["RECEIVED", "PREPARING", "DISCUSSING", "SPEC_READY", "BUILDING", "REVIEWING", "BUILDING", "REVIEWING", "DELIVERING", "READY", "DELIVERED"]);
	// the builder's round-2 input was admitted once (idempotent submission), and the resumed generation answered it
	const tr = await t.factory.getConversation(run, v.conversations.builder!);
	expect(tr.items.filter((i) => i.role === "user").length).toBe(2);
	expect(control.builderInputs.length).toBe(1);
	expect(v.cost.filter((c) => c.role === "builder").map((c) => c.round)).toEqual([1, 2]);
});

test("kill -9 at a pending approval: the pending ask survives the restart and can be answered", async () => {
	const dir = mkdtempSync(join(tmpdir(), "sf-crash-"));
	const { run, before } = await crashChild(dir, "approval");
	expect(before.pendingAsk?.question.kind).toBe("approval");
	t = await makeFactory({ dir, storage: "sqlite" });
	const v0 = await t.factory.getRun(run);
	expect(v0.state).toBe("AWAITING_APPROVAL");
	expect(v0.pendingAsk?.id).toBe(before.pendingAsk!.id);
	await t.factory.approve(run, "spec");
	const r = await t.factory.waitForState(run, (x) => ["READY", "FAILED"].includes(x.state));
	expect(r.state).toBe("READY");
	await t.factory.createProject("todo", "me/todo"); // makeFactory rewrote config.yaml: add the project back
	const v = await shipAndMerge(t.factory, run);
	expect(v.state).toBe("DELIVERED");
	expect(v.history.map((h) => h.to).slice(-4)).toEqual(["REVIEWING", "DELIVERING", "READY", "DELIVERED"]);
});

test("graceful close and reopen mid-discussion keeps the pending discussion question", async () => {
	const dir = mkdtempSync(join(tmpdir(), "sf-reopen-"));
	const control = newControl();
	control.askFirst = true;
	t = await makeFactory({ dir, storage: "sqlite", control });
	await t.factory.createProject("p", "me/p");
	const run = await t.factory.startRun("p", { source: "t", title: "x", body: "x" });
	const v1 = await t.factory.waitForState(run, (x) => !!x.pendingAsk);
	await t.factory.close();
	await t.reopen();
	const v2 = await t.factory.getRun(run);
	expect(v2.pendingAsk).toEqual(v1.pendingAsk);
	await t.factory.answer(run, v2.pendingAsk!.id, "TypeScript");
	expect((await t.factory.waitForState(run, (x) => x.state === "READY")).conversations.architect).toBe(v1.conversations.architect);
	const v = await shipAndMerge(t.factory, run);
	expect(v.state).toBe("DELIVERED");
	expect(v.conversations.architect).toBe(v1.conversations.architect);
});

test("kill -9 while a helper is mid-task, after its write landed: the file survives, the same helper Conversation carries on, the run goes on to review", async () => {
	const dir = mkdtempSync(join(tmpdir(), "sf-crash-"));
	const { run, before } = await crashChild(dir, "helper");
	const helper = (before as any).helper as string;
	expect(before.state).toBe("BUILDING");
	expect(existsSync(join(before.workspace!.path, "helper.txt"))).toBe(true);
	const control = newControl();
	control.builderSubagent = true;
	control.reviews = ["pass"];
	t = await makeFactory({ dir, storage: "sqlite", control });
	const r = await t.factory.waitForState(run, (x) => ["READY", "FAILED"].includes(x.state));
	expect(r.state).toBe("READY");
	await t.factory.createProject("todo", "me/todo"); // makeFactory rewrote config.yaml: add the project back
	const v = await shipAndMerge(t.factory, run);
	expect(v.state).toBe("DELIVERED");
	expect(v.history.map((h) => h.to)).toEqual(["RECEIVED", "PREPARING", "DISCUSSING", "SPEC_READY", "BUILDING", "REVIEWING", "DELIVERING", "READY", "DELIVERED"]);
	// the same helper Conversation resumed from its transcript: it did not start over (no new first turn)
	const tr = await t.factory.getConversation(run, v.conversations.builder!);
	expect(tr.helpers.map(String)).toEqual([helper]);
	expect(control.helperRuns).toBe(0);
	const h = await t.factory.getConversation(run, helper);
	expect(h.items.filter((i) => i.toolResult?.name === "write").map((i) => i.toolResult!.isError)).toEqual([false]);
	expect(readFileSync(join(v.workspace!.path, "helper.txt"), "utf8")).toBe("x");
	expect(control.reviewerInputs[0]).toContain("helper.txt");
});

test("kill -9 while the QA agent works: the run resumes in REVIEWING with the same VM and QA Conversation, keeps the reviewer's submission, and leaves no VM", async () => {
	const dir = mkdtempSync(join(tmpdir(), "sf-crash-"));
	const { run, before } = await crashChild(dir, "qa");
	expect(before.state).toBe("REVIEWING");
	expect(before.reviews[0]!.submitted).toEqual({ review: true, qa: false });
	const control = newControl();
	control.runScript = true;
	t = await makeFactory({ dir, storage: "sqlite", control });
	const r = await t.factory.waitForState(run, (x) => ["READY", "FAILED"].includes(x.state));
	expect(r.state).toBe("READY");
	await t.factory.createProject("todo", "me/todo"); // makeFactory rewrote config.yaml: add the project back
	const v = await shipAndMerge(t.factory, run);
	expect(v.state).toBe("DELIVERED");
	expect(v.history.map((h) => h.to).slice(-4)).toEqual(["REVIEWING", "DELIVERING", "READY", "DELIVERED"]);
	expect(v.conversations.qa.map((x) => x.id)).toEqual(before.conversations.qa.map((x) => x.id));
	expect(control.reviewerInputs).toEqual([]); // the review submitted before the crash was kept
	expect(control.qaInputs).toEqual([]); // the QA agent carried on from its transcript
	const creates = t.boat.state().calls.filter((c) => c.op === "create");
	expect(creates).toHaveLength(1); // same VM (same idempotency key)
	expect(v.reviews[0]).toMatchObject({ qaStatus: "ran", screenshots: ["r1-s1"], vm: { attempt: 1, state: "disposed" } });
	expect((await t.boat.list()).filter((x) => x.name?.includes(run))).toEqual([]);
});

test("a QA VM deleted by hand while the factory is down is replaced on resume, and the QA agent is told", async () => {
	const dir = mkdtempSync(join(tmpdir(), "sf-crash-"));
	const { run, before } = await crashChild(dir, "qa");
	const { LocalBoatBackend } = await import("../src/boat/backend.ts");
	const boat = new LocalBoatBackend(join(dir, "boat"));
	const vm = (await boat.list()).find((x) => x.name === `factory-${run}-1`)!;
	await boat.delete(vm.id);
	const control = newControl();
	control.runScript = true;
	t = await makeFactory({ dir, storage: "sqlite", control });
	const r = await t.factory.waitForState(run, (x) => ["READY", "FAILED"].includes(x.state));
	expect(r.state).toBe("READY");
	await t.factory.createProject("todo", "me/todo"); // makeFactory rewrote config.yaml: add the project back
	const v = await shipAndMerge(t.factory, run);
	expect(v.state).toBe("DELIVERED");
	expect(v.history.map((h) => h.to).slice(-4)).toEqual(["REVIEWING", "DELIVERING", "READY", "DELIVERED"]);
	expect(t.boat.state().calls.filter((c) => c.op === "create")).toHaveLength(2);
	expect(v.reviews[0]!.vm).toMatchObject({ attempt: 2, state: "disposed" });
	expect(v.conversations.qa.map((x) => x.id)).toEqual(before.conversations.qa.map((x) => x.id));
	const tr = await t.factory.getConversation(run, v.conversations.qa[0]!.id);
	expect(tr.items.some((i) => i.role === "user" && /has been replaced/.test(i.text ?? ""))).toBe(true);
	expect((await t.boat.list()).filter((x) => x.name?.includes(run))).toEqual([]);
});

test("kill -9 while the integrator is resolving a conflict: the bundle resumes in INTEGRATING with the same integrator Conversation, then reviews, delivers one PR and merges", async () => {
	const dir = mkdtempSync(join(tmpdir(), "sf-crash-"));
	const { run, before, bundle } = await crashChild<BundleView>(dir, "bundle-conflict");
	const [a, b] = run.split(",") as [string, string];
	expect(bundle).toBe(before.id);
	expect(before.state).toBe("INTEGRATING");
	expect(before.integration?.conflict).toEqual({ run: b, files: ["shared.txt"] });
	expect(before.conversations.integrator).toBeDefined();
	const control = newControl();
	t = await makeFactory({ dir, storage: "sqlite", control });
	const id = bundle!;
	const resumed = await t.factory.getBundle(id);
	expect(resumed.state).toBe("INTEGRATING");
	expect(resumed.conversations.integrator).toBe(before.conversations.integrator);
	expect(resumed.members.map((m) => m.run)).toEqual([a, b]);
	const v = await untilBundle(t.factory, id, (x) => (x.state === "AWAITING_MERGE" && !!x.pendingAsk) || ["MERGED", "FAILED", "CANCELLED", "ESCALATED"].includes(x.state));
	expect(v.state).toBe("AWAITING_MERGE");
	expect(v.history.map((h) => h.to)).toEqual(["INTEGRATING", "REVIEWING", "DELIVERING", "AWAITING_CI", "AWAITING_MERGE"]);
	expect(v.conversations.integrator).toBe(before.conversations.integrator);
	expect(v.integration?.resolved).toEqual([{ run: b, files: ["shared.txt"] }]);
	expect(v.integration?.conflict).toBeUndefined();
	expect(v.reviews.length).toBe(1);
	expect(t.host.state().prs.length).toBe(1);
	// the conflict input was admitted once (idempotent submission), and the resumed generation answered it
	const tr = await t.factory.getBundleConversation(id, v.conversations.integrator!);
	const users = tr.items.filter((i) => i.role === "user");
	expect(users.length).toBe(1);
	expect(users[0]!.text).toContain("# Merge conflict");
	expect(control.integratorInputs.length).toBe(1);
	expect(tr.items.filter((i) => i.toolCalls?.some((c) => c.name === "report_done")).length).toBe(1);
	await t.factory.mergeBundle(id);
	expect((await untilBundle(t.factory, id, bundleIn("MERGED", "FAILED"))).state).toBe("MERGED");
	for (const r of [a, b]) {
		const x = await t.factory.waitForState(r, (y) => y.state === "DELIVERED");
		expect(x.bundle).toBe(id);
		expect(x.artifacts.delivery?.url).toBe(v.delivery!.url);
	}
}, 60_000);

test("kill -9 while a clean two-ticket combination is being reviewed: the bundle resumes in REVIEWING with the same review number and round, then delivers and merges", async () => {
	const dir = mkdtempSync(join(tmpdir(), "sf-crash-"));
	const { run, before, bundle } = await crashChild<BundleView>(dir, "bundle-clean-review");
	const [a, b] = run.split(",") as [string, string];
	expect(before.state).toBe("REVIEWING");
	expect(before.history.map((h) => h.to)).toEqual(["INTEGRATING", "REVIEWING"]);
	expect(before.integration).toMatchObject({ changed: false, resolved: [], reviewCombination: true });
	expect(before.reviews.length).toBe(1);
	const control = newControl();
	t = await makeFactory({ dir, storage: "sqlite", control });
	const id = bundle!;
	const resumed = await t.factory.getBundle(id);
	expect(resumed.state).toBe("REVIEWING");
	expect(resumed.reviews.map((r) => [r.seq, r.round])).toEqual(before.reviews.map((r) => [r.seq, r.round]));
	expect(resumed.reviewRound).toBe(before.reviewRound);
	expect(resumed.members.map((m) => m.run)).toEqual([a, b]);
	const v = await untilBundle(t.factory, id, (x) => (x.state === "AWAITING_MERGE" && !!x.pendingAsk) || ["MERGED", "FAILED", "CANCELLED", "ESCALATED"].includes(x.state));
	expect(v.state).toBe("AWAITING_MERGE");
	// nothing before the crash was redone: one integration, one review of the combination
	expect(v.history.map((h) => h.to)).toEqual(["INTEGRATING", "REVIEWING", "DELIVERING", "AWAITING_CI", "AWAITING_MERGE"]);
	expect(v.reviews.map((r) => [r.seq, r.round])).toEqual(before.reviews.map((r) => [r.seq, r.round]));
	expect(v.notices.filter((n) => /reviewing the combination/.test(n.text)).length).toBe(1);
	expect(t.host.state().prs.length).toBe(1);
	await t.factory.mergeBundle(id);
	expect((await untilBundle(t.factory, id, bundleIn("MERGED", "FAILED"))).state).toBe("MERGED");
}, 60_000);

test("kill -9 while a legacy run waits for CI: after the restart it finishes the old way, with its own PR and no bundle", async () => {
	const dir = mkdtempSync(join(tmpdir(), "sf-crash-"));
	const { run, before } = await crashChild(dir, "legacy-ci");
	expect(before.state).toBe("AWAITING_CI");
	const sha = before.artifacts.delivery!.sha;
	expect(before.artifacts.delivery?.kind).toBe("pr");
	// CI finishes green while the factory is down (the fake GitHub's state file is the "server")
	const statePath = join(dir, "github", "github-state.json");
	const gh = JSON.parse(readFileSync(statePath, "utf8"));
	expect(gh.checks[`me/todo@${sha}`]).toEqual([{ name: "ci", status: "in_progress" }]);
	gh.checks[`me/todo@${sha}`] = [{ name: "ci", status: "completed", conclusion: "success" }];
	writeFileSync(statePath, JSON.stringify(gh, null, 2));
	t = await makeFactory({ dir, storage: "sqlite" });
	const v = await t.factory.waitForState(run, (x) => ["DELIVERED", "FAILED", "READY"].includes(x.state));
	expect(v.state).toBe("DELIVERED");
	expect(v.history.map((h) => h.to).slice(-5)).toEqual(["REVIEWING", "AWAITING_APPROVAL", "DELIVERING", "AWAITING_CI", "DELIVERED"]);
	expect(v.artifacts.delivery).toMatchObject({ kind: "pr", sha, url: before.artifacts.delivery!.url });
	expect(v.notices.some((n) => n.text === `CI green on ${sha.slice(0, 12)}`)).toBe(true);
	expect(v.bundle).toBeUndefined();
	expect(t.host.state().prs.map((p) => p.head)).toEqual([`factory/${run}`]);
	expect(await t.factory.listBundles()).toEqual([]);
});

describe("discussions", () => {
	/** A discussion that is OPEN with no turn running. */
	const open = (v: DiscussionView) => v.state === "OPEN" && v.turn === null;
	const ok = [
		{ id: "D1", title: "API", body: "B1", edited: false, batch: 1 },
		{ id: "D2", title: "UI", body: "B2", edited: false, batch: 1 },
	];

	test("restart while idle: still OPEN and say works at once", async () => {
		t = await makeFactory({ storage: "sqlite" });
		await t.host.seedRepo("me/p", { "README.md": "# p\n" });
		await t.factory.createProject("p", "me/p");
		const id = await t.factory.startDiscussion("p", { title: "t", message: "m" });
		const v1 = await t.factory.waitForDiscussion(id, open);
		await t.factory.close();
		await t.reopen();
		const v2 = await t.factory.getDiscussion(id);
		expect(v2.state).toBe("OPEN");
		expect(v2.conversationId).toBe(v1.conversationId);
		// the rebuilt cache: no spurious state change, and the Conversation maps back to the discussion
		const events: FactoryEvent[] = [];
		t.factory.subscribe({ discussion: id }, (e) => events.push(e));
		await t.factory.say(id, "after restart");
		expect((await t.factory.waitForDiscussion(id, open, 10_000)).turnCosts).toHaveLength(2);
		await new Promise((r) => setTimeout(r, 300)); // conversation events are throttled (150 ms)
		expect(events.filter((e) => e.type === "discussion.state")).toEqual([]);
		expect(events.some((e) => e.type === "discussion.conversation.updated" && e.conversationId === v1.conversationId)).toBe(true);
		expect(t.control.discussantHeard).toContain("after restart");
		expect((await t.factory.getDiscussionConversation(id)).items.at(-1)).toMatchObject({ role: "assistant", text: "re: after restart" });
	});

	test("kill -9 mid-turn: the turn resumes and finishes once", async () => {
		const dir = mkdtempSync(join(tmpdir(), "sf-crash-"));
		const { run: id, before } = await crashChild<DiscussionView>(dir, "disc-say");
		expect(before.turn).toMatchObject({ kind: "say" });
		t = await makeFactory({ dir, storage: "sqlite" });
		const v = await t.factory.waitForDiscussion(id, open);
		expect(v.state).toBe("OPEN");
		expect(v.conversationId).toBe(before.conversationId);
		expect(v.turnCosts.map((c) => c.turn)).toEqual([1, 2]);
		expect(v.notices).toEqual([]);
		const items = (await t.factory.getDiscussionConversation(id)).items;
		expect(items.filter((i) => i.author === "human" && i.text === "slow")).toHaveLength(1);
		expect(items.filter((i) => i.role === "assistant" && i.text === "re: slow")).toHaveLength(1);
		// say works at once after the resumed turn
		await t.factory.say(id, "next");
		expect((await t.factory.waitForDiscussion(id, open)).turnCosts).toHaveLength(3);
	});

	test("kill -9 after submit_tickets is recorded: the drafts are applied once", async () => {
		const dir = mkdtempSync(join(tmpdir(), "sf-crash-"));
		const { run: id, before } = await crashChild<DiscussionView>(dir, "disc-draft");
		expect(before.turn).toMatchObject({ kind: "draft" });
		expect(before.drafts).toEqual([]);
		t = await makeFactory({ dir, storage: "sqlite" });
		const v = await t.factory.waitForDiscussion(id, open);
		expect(v.drafts).toEqual(ok);
		expect(v.summary).toBe("S: settled X; open Y");
		expect(v.turnCosts.at(-1)).toMatchObject({ turn: 2, kind: "draft" });
		expect(v.notices).toEqual([]);
		// the model was not asked again: one drafting input, one submission, no reminders
		expect(t.control.discussantInputs).toEqual([]);
		const items = (await t.factory.getDiscussionConversation(id)).items;
		expect(items.filter((i) => i.toolResult?.name === "submit_tickets" && !i.toolResult.isError)).toHaveLength(1);
		expect(items.filter((i) => i.role === "user" && /You stopped without calling submit_tickets/.test(i.text ?? ""))).toEqual([]);
		// a later redraft numbers on from D2
		t.control.draftPlan = ["one"];
		await t.factory.requestDrafts(id);
		expect((await t.factory.waitForDiscussion(id, open)).drafts).toEqual([{ id: "D3", title: "Only", body: "B", edited: false, batch: 2 }]);
	});

	test("kill -9 right after createTicket commits: one run, linked, and it proceeds", async () => {
		const dir = mkdtempSync(join(tmpdir(), "sf-crash-"));
		const { run: id, before } = await crashChild<DiscussionView & { runId: string }>(dir, "disc-ticket");
		expect(before.drafts[0]!.runId).toBe(before.runId);
		t = await makeFactory({ dir, storage: "sqlite" });
		const runs = (await t.factory.listRuns()).filter((r) => (r.request.meta as any)?.discussion?.draftId === "D1");
		expect(runs.map((r) => r.id)).toEqual([before.runId]);
		const d = await t.factory.getDiscussion(id);
		expect(d.state).toBe("OPEN");
		expect(d.drafts[0]!.runId).toBe(before.runId);
		expect(d.drafts[1]!.runId).toBeUndefined();
		// it proceeds: the architect got its input and the run moved past DISCUSSING without failing
		const r = await t.factory.waitForState(before.runId, (x) => !["RECEIVED", "PREPARING", "DISCUSSING"].includes(x.state));
		expect(r.state).not.toBe("FAILED");
		expect(r.history.map((h) => h.to).slice(0, 3)).toEqual(["RECEIVED", "PREPARING", "DISCUSSING"]);
		expect((await t.factory.getDiscussion(id)).runs).toEqual([{ id: before.runId, state: expect.any(String) }]);
		// the other draft can still be turned into a ticket (makeFactory rewrote config.yaml: add the project back)
		await t.factory.createProject("p", "me/p");
		const run2 = await t.factory.createTicket(id, "D2");
		expect((await t.factory.listRuns()).map((x) => x.id).sort()).toEqual([before.runId, run2].sort());
	});
});
