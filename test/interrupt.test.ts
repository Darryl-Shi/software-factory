// Interrupting agents, stopping single tool calls, live cost and tool-call timing (docs/specs/run-mv8t6vsz-pmy8.md):
// stopToolCall on a running bash and its refusals, durationMs on finished tool rows, interruptAgent's durable pause
// (resumed by the next message, across a restart, cancellable), interruptBundleAgent on a bundle's reviewer, the live
// cost of runs (helpers included) and discussions, and `cost.updated`.
import { afterEach, describe, expect, test } from "vitest";
import type { FactoryCore, FactoryEvent, RunView, TranscriptView } from "../src/core/types.ts";
import { bundleIn, inState, makeFactory, type TestEnv, until, untilBundle, untilDiscussion } from "./helpers.ts";

let t: TestEnv | undefined;
afterEach(async () => {
	if (t) {
		t.control.helperHang = false;
		t.control.discussantHang = false;
		t.control.discussantHangLater = false;
		t.control.builderHang = false;
	}
	await t?.factory.close().catch(() => {});
	t = undefined;
});

const SLOW = "sleep 30; echo SLOW-DONE";
const done = inState("READY", "DELIVERED", "FAILED", "CANCELLED");
// The live-cost tests compare tokens (exact integers); usd follows the same code path and is checked to be > 0 (the
// scripted provider prices responses from their token usage).
const sum = (v: { cost: { totalTokens: number }[] }) => v.cost.reduce((s, c) => s + (c.totalTokens ?? 0), 0);

async function setup(opts: { settings?: [string, unknown][]; storage?: "memory" | "sqlite"; seed?: boolean } = {}) {
	const logs: string[] = [];
	t = await makeFactory({ storage: opts.storage, log: (m) => logs.push(m) });
	if (opts.seed) await t.host.seedRepo("me/p", { "README.md": "# p\n", "AGENTS.md": "Test: true\n" });
	await t.factory.createProject("p", "me/p");
	for (const [path, value] of opts.settings ?? []) await t.factory.setSetting({ project: "p" }, path, value);
	return { web: t.factory.as("web") as FactoryCore, logs };
}
const start = (title = "hello") => t!.factory.startRun("p", { source: "test", title, body: `make ${title}` });

async function poll<T>(what: string, read: () => Promise<T>, pred: (x: T) => boolean, ms = 20_000): Promise<T> {
	const deadline = Date.now() + ms;
	for (;;) {
		const x = await read();
		if (pred(x)) return x;
		if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}: ${JSON.stringify(x).slice(0, 1500)}`);
		await new Promise((r) => setTimeout(r, 50));
	}
}
const runningBash = (tv: TranscriptView) => tv.running.find((r) => r.name === "bash" && r.status === "running");

/** A run whose builder is in its slow bash call (BUILDING): the run view and the builder's transcript. */
async function slowBuilder(run: string) {
	const v = await until(t!.factory, run, (x) => x.state === "BUILDING" && x.conversations.builder !== undefined);
	const builder = v.conversations.builder!;
	const tv = await poll("the slow bash to run", () => t!.factory.getConversation(run, builder), (x) => !!runningBash(x));
	return { builder, tv, callId: runningBash(tv)!.callId };
}

describe("stopToolCall", () => {
	test("stopping the builder's running bash: the running row has startedAt, the agent gets the aborted result and keeps working; the run reaches READY", async () => {
		const { web, logs } = await setup();
		t!.control.builderSlow = SLOW;
		const run = await start();
		const { builder, tv, callId } = await slowBuilder(run);
		const slot = runningBash(tv)!;
		expect(slot.startedAt).toBeTypeOf("number");
		expect(slot.startedAt!).toBeLessThanOrEqual(tv.now);
		expect(tv.now).toBeGreaterThan(Date.now() - 60_000);
		expect(tv.busy).toBe(true);
		const t0 = Date.now();
		await web.stopToolCall({ run, conversationId: builder, callId });
		const after = await poll(
			"the aborted result",
			() => t!.factory.getConversation(run, builder),
			(x) => x.items.some((i) => i.toolResult?.callId === callId),
		);
		expect(Date.now() - t0).toBeLessThan(20_000);
		const res = after.items.find((i) => i.toolResult?.callId === callId)!.toolResult!;
		expect(res).toMatchObject({ name: "bash", isError: true });
		expect(res.text).toContain("Tool bash was aborted");
		expect(res.durationMs).toBeTypeOf("number");
		expect(res.durationMs!).toBeLessThan(30_000);
		expect(after.running.some((r) => r.callId === callId)).toBe(false);
		expect(logs.some((l) => l.includes(`run ${run}: web stopped bash (${callId}) in conversation ${builder}`))).toBe(true);
		const end = await until(t!.factory, run, done);
		expect(end.state).toBe("READY");
		expect(end.history.map((h) => h.to)).not.toContain("FAILED");
		expect(t!.control.slowResults).toEqual([expect.stringContaining("Tool bash was aborted")]);
		// the stopped call is over: stopping it again is a conflict
		await expect(web.stopToolCall({ run, conversationId: builder, callId })).rejects.toMatchObject({ code: "conflict" });
	});

	test("refusals: a finished call (conflict), another run's Conversation (not_found), zero or two owners (invalid), a bridge tool (conflict)", async () => {
		const { web } = await setup();
		const other = await start("other");
		const ov = await until(t!.factory, other, done);
		expect(ov.state).toBe("READY");
		const otherBuilder = ov.conversations.builder!;
		const finished = (await t!.factory.getConversation(other, otherBuilder)).items.find((i) => i.toolResult)!.toolResult!;
		await expect(web.stopToolCall({ run: other, conversationId: otherBuilder, callId: finished.callId })).rejects.toMatchObject({
			code: "conflict",
			message: expect.stringContaining("is not running"),
		});
		await expect(web.stopToolCall({ run: other, conversationId: otherBuilder, callId: "call_nope" })).rejects.toMatchObject({ code: "conflict" });
		await expect(web.stopToolCall({ conversationId: otherBuilder, callId: finished.callId } as never)).rejects.toMatchObject({ code: "invalid" });
		await expect(web.stopToolCall({ run: other, bundle: "bundle-1", conversationId: otherBuilder, callId: finished.callId })).rejects.toMatchObject({ code: "invalid" });
		await expect(web.stopToolCall({ run: other, conversationId: otherBuilder } as never)).rejects.toMatchObject({ code: "invalid" });
		await expect(web.stopToolCall({ run: "run-nope", conversationId: otherBuilder, callId: "x" })).rejects.toMatchObject({ code: "not_found" });
		await expect(web.stopToolCall({ discussion: "disc-nope", conversationId: otherBuilder, callId: "x" })).rejects.toMatchObject({ code: "not_found" });

		// a round of write + slow bash + report_done: report_done waits behind the slow call (bridge tools run sequentially)
		t!.control.builderSlow = SLOW;
		t!.control.builderSlowBatch = true;
		const run = await start();
		const { builder, callId } = await slowBuilder(run);
		// another run's Conversation is not this run's
		await expect(web.stopToolCall({ run, conversationId: otherBuilder, callId })).rejects.toMatchObject({ code: "not_found" });
		await expect(web.stopToolCall({ run: other, conversationId: builder, callId })).rejects.toMatchObject({ code: "not_found" });
		const tv = await t!.factory.getConversation(run, builder);
		const report = tv.running.find((r) => r.name === "report_done");
		expect(report, JSON.stringify(tv.running)).toBeDefined();
		await expect(web.stopToolCall({ run, conversationId: builder, callId: report!.callId })).rejects.toMatchObject({
			code: "conflict",
			message: expect.stringContaining("report_done can't be stopped"),
		});
		await web.stopToolCall({ run, conversationId: builder, callId });
		const end = await until(t!.factory, run, done);
		expect(end.state).toBe("READY");
	});
});

describe("tool-call timing", () => {
	test("finished tool rows carry durationMs: the builder, its helper (subagent), the reviewer, and a discussion", async () => {
		await setup();
		t!.control.builderSubagent = true;
		const run = await start();
		const v = await until(t!.factory, run, done);
		expect(v.state).toBe("READY");
		const tr = await t!.factory.getConversation(run, v.conversations.builder!);
		const results = (x: TranscriptView) => x.items.filter((i) => i.toolResult).map((i) => i.toolResult!);
		expect(results(tr).length).toBeGreaterThan(0);
		for (const r of results(tr)) expect(r.durationMs, r.name).toBeTypeOf("number");
		expect(tr.running).toEqual([]);
		expect(tr.now).toBeTypeOf("number");
		expect(tr.helpers.length).toBe(1);
		const helper = await t!.factory.getConversation(run, tr.helpers[0]!);
		expect(results(helper).map((r) => r.name).sort()).toEqual(["bash", "write"]);
		for (const r of results(helper)) expect(r.durationMs).toBeTypeOf("number");
		// a helper's Conversation belongs to the run (stopToolCall finds it): its finished call is a conflict, not not_found
		await expect(t!.factory.stopToolCall({ run, conversationId: tr.helpers[0]!, callId: results(helper)[0]!.callId })).rejects.toMatchObject({ code: "conflict" });
		const rev = await t!.factory.getConversation(run, v.conversations.reviewers[0]!.id);
		for (const r of results(rev)) expect(r.durationMs).toBeTypeOf("number");

		const id = await t!.factory.startDiscussion("p", { title: "t", message: "hi" });
		await untilDiscussion(t!.factory, id, (x) => x.state === "OPEN" && !x.turn);
		const dv = await t!.factory.getDiscussionConversation(id);
		expect(results(dv).length).toBeGreaterThan(0);
		for (const r of results(dv)) expect(r.durationMs).toBeTypeOf("number");
		expect(dv.running).toEqual([]);
	});
});

describe("interruptAgent", () => {
	test("interrupting the builder in BUILDING pauses it; a message resumes the same Conversation; it reports and the run reaches READY", async () => {
		const { web } = await setup();
		t!.control.builderSlow = SLOW;
		const events: FactoryEvent[] = [];
		t!.factory.subscribe({}, (e) => events.push(e));
		const run = await start();
		const { builder, callId } = await slowBuilder(run);
		const t0 = Date.now();
		await web.interruptAgent(run);
		expect(Date.now() - t0).toBeLessThan(15_000);
		let v = await t!.factory.getRun(run);
		expect(v.state).toBe("BUILDING");
		expect(v.interrupted).toMatchObject({ role: "builder", conversationId: String(builder), by: "web" });
		expect(v.interrupted!.key).toBeTypeOf("string");
		expect(v.notices.some((n) => n.text.includes("interrupted"))).toBe(true);
		const tv = await poll("the aborted bash", () => t!.factory.getConversation(run, builder), (x) => x.items.some((i) => i.toolResult?.callId === callId) && !x.busy);
		expect(tv.items.find((i) => i.toolResult?.callId === callId)!.toolResult).toMatchObject({ isError: true, text: expect.stringContaining("was aborted") });
		// paused: nothing fails, nothing moves
		await new Promise((r) => setTimeout(r, 500));
		v = await t!.factory.getRun(run);
		expect(v.state).toBe("BUILDING");
		expect(v.interrupted).toBeDefined();
		expect(t!.control.slowResults ?? []).toEqual([]);
		await expect(web.interruptAgent(run)).rejects.toMatchObject({ code: "conflict" });

		const out = await web.message(run, "Continue.");
		expect(out).toMatchObject({ to: "builder", conversationId: String(builder) });
		v = await t!.factory.getRun(run);
		expect(v.interrupted).toBeUndefined();
		expect(v.messages.find((m) => m.id === out.message)).toMatchObject({ resume: expect.stringMatching(/:resume1$/) });
		const end = await until(t!.factory, run, done);
		expect(end.state).toBe("READY");
		expect(end.history.map((h) => h.to)).toEqual(expect.arrayContaining(["BUILDING", "REVIEWING", "READY"]));
		expect(end.conversations.builder).toBe(builder);
		expect(end.interrupted).toBeUndefined();
		// the same builder Conversation: the human's message comes after the aborted call, then report_done
		const items = (await t!.factory.getConversation(run, builder)).items;
		const iAbort = items.findIndex((i) => i.toolResult?.callId === callId);
		const iMsg = items.findIndex((i) => i.msgId === out.message);
		const iReport = items.findIndex((i) => i.toolResult?.name === "report_done" && !i.toolResult.isError);
		expect(iAbort).toBeGreaterThanOrEqual(0);
		expect(iMsg).toBeGreaterThan(iAbort);
		expect(iReport).toBeGreaterThan(iMsg);
		expect(items[iMsg]).toMatchObject({ author: "human", text: "Continue." });
		expect(t!.control.slowResults).toEqual([expect.stringContaining("was aborted")]);
		// the builder's turn used no nudge
		expect(t!.control.builderInputs.some((x) => x.startsWith("You stopped without calling"))).toBe(false);
		expect(events.some((e) => e.type === "run.state" && (e as any).to === "FAILED")).toBe(false);
	});

	test("an agent can be interrupted again after a resume: each message resumes its turn (resume1, resume2)", async () => {
		const { web } = await setup();
		t!.control.builderSlow = SLOW;
		t!.control.builderSlowTimes = 2;
		const run = await start();
		const first = await slowBuilder(run);
		await web.interruptAgent(run);
		const m1 = await web.message(run, "Continue.");
		// the builder runs the slow command again: a new call
		const tv = await poll("the second slow bash", () => t!.factory.getConversation(run, first.builder), (x) => !!runningBash(x) && runningBash(x)!.callId !== first.callId);
		const second = runningBash(tv)!.callId;
		await web.interruptAgent(run);
		const v = await t!.factory.getRun(run);
		expect(v.state).toBe("BUILDING");
		expect(v.interrupted).toMatchObject({ role: "builder", conversationId: String(first.builder) });
		const m2 = await web.message(run, "Go on.");
		const end = await until(t!.factory, run, done);
		expect(end.state).toBe("READY");
		expect(end.messages.find((m) => m.id === m1.message)!.resume).toMatch(/:resume1$/);
		expect(end.messages.find((m) => m.id === m2.message)!.resume).toMatch(/:resume2$/);
		expect(t!.control.slowResults).toEqual([expect.stringContaining("was aborted"), expect.stringContaining("was aborted")]);
		const items = (await t!.factory.getConversation(run, first.builder)).items;
		expect(items.findIndex((i) => i.msgId === m2.message)).toBeGreaterThan(items.findIndex((i) => i.toolResult?.callId === second));
		expect(end.notices.filter((n) => n.text.includes("interrupted")).length).toBe(2);
	});

	test("the pause is durable: after a restart the run is still paused in BUILDING; a message resumes it to READY", async () => {
		const { web } = await setup({ storage: "sqlite" });
		t!.control.builderSlow = SLOW;
		const run = await start();
		const { builder } = await slowBuilder(run);
		await web.interruptAgent(run);
		await poll("the builder to stop", () => t!.factory.getConversation(run, builder), (x) => !x.busy);
		await t!.factory.close();
		const f = await t!.reopen();
		let v = await f.getRun(run);
		expect(v.state).toBe("BUILDING");
		expect(v.interrupted).toMatchObject({ role: "builder", conversationId: String(builder) });
		await new Promise((r) => setTimeout(r, 1000));
		v = await f.getRun(run);
		expect(v.state).toBe("BUILDING");
		expect(v.interrupted).toBeDefined();
		const out = await (f.as("web") as FactoryCore).message(run, "Continue.");
		expect(out.conversationId).toBe(String(builder));
		const end = await until(f, run, done);
		expect(end.state).toBe("READY");
		expect(end.interrupted).toBeUndefined();
	});

	test("refusals: an idle agent (READY, the spec gate), a role not in policy.messages, unknown run; a paused run can be cancelled", async () => {
		const { web } = await setup({ settings: [["policy.approvals", ["spec"]]] });
		await expect(web.interruptAgent("run-nope")).rejects.toMatchObject({ code: "not_found" });
		const gated = await start("gated");
		await until(t!.factory, gated, inState("AWAITING_APPROVAL"));
		await expect(web.interruptAgent(gated)).rejects.toMatchObject({ code: "conflict", message: expect.stringContaining("not working") });
		await web.approve(gated, "spec");
		const ready = await until(t!.factory, gated, done);
		expect(ready.state).toBe("READY");
		await expect(web.interruptAgent(gated)).rejects.toMatchObject({ code: "conflict" });

		// a paused run can be cancelled
		await t!.factory.setSetting({ project: "p" }, "policy.approvals", []);
		t!.control.builderSlow = SLOW;
		const run = await start();
		await slowBuilder(run);
		await web.interruptAgent(run);
		expect((await t!.factory.getRun(run)).interrupted).toBeDefined();
		await web.cancelRun(run);
		const c = await until(t!.factory, run, done);
		expect(c.state).toBe("CANCELLED");
		expect(c.interrupted).toBeUndefined();
		await expect(web.interruptAgent(run)).rejects.toMatchObject({ code: "conflict" });
	});

	test("policy.messages without the builder: interruptAgent is a conflict (only a message could continue it)", async () => {
		const { web } = await setup({ settings: [["policy.messages", ["architect"]]] });
		t!.control.builderSlow = SLOW;
		const run = await start();
		const { builder, callId } = await slowBuilder(run);
		await expect(web.interruptAgent(run)).rejects.toMatchObject({ code: "conflict", message: expect.stringContaining("policy.messages") });
		expect((await t!.factory.getRun(run)).interrupted).toBeUndefined();
		// the view says which roles take messages, so interfaces show Interrupt only for those
		expect((await t!.factory.getRun(run)).messageRoles).toEqual(["architect"]);
		await web.stopToolCall({ run, conversationId: builder, callId });
		expect((await until(t!.factory, run, done)).state).toBe("READY");
	});

	test("a pause whose abort never reached the turn: the agent's bridge result is taken, and the message meant to resume it is still delivered", async () => {
		await setup();
		t!.control.builderSlow = "sleep 1; echo SLOW-DONE";
		const run = await start();
		const { builder } = await slowBuilder(run);
		expect((await t!.factory.getRun(run)).messageRoles).toEqual(["architect", "builder", "reviewer"]);
		// as if the interrupt's commit landed but its abort did not reach the turn (it ends on its own)
		await t!.factory.patchRunForTests(run, (d) => {
			d.interrupted = { role: "builder", conversationId: String(builder), key: d.driving!.key, at: Date.now(), by: "web" };
		});
		const sent = await t!.factory.as("web").message(run, "STRAY-HELLO");
		expect(sent.conversationId).toBe(String(builder));
		const v = await until(t!.factory, run, done);
		expect(v.state).toBe("READY");
		expect(v.interrupted).toBeUndefined();
		await poll("the message in the builder's transcript", () => t!.factory.getConversation(run, builder), (x) => x.items.some((i) => i.author === "human" && i.text === "STRAY-HELLO"));
	});
});

describe("interruptBundleAgent", () => {
	test("interrupting the bundle's reviewer in REVIEWING pauses it; Continue resumes it and it submits its review", async () => {
		const { web } = await setup({ seed: true });
		const a = await start("alpha");
		const b = await start("beta");
		const [ra, rb] = await Promise.all([until(t!.factory, a, done), until(t!.factory, b, done)]);
		expect([ra.state, rb.state]).toEqual(["READY", "READY"]);
		t!.control.reviewerSlow = SLOW;
		const id = await t!.factory.createBundle("p", [a, b]);
		const bv = await untilBundle(t!.factory, id, (v) => v.state === "REVIEWING" && v.conversations.reviewers.length === 1);
		const reviewer = bv.conversations.reviewers[0]!.id;
		const tv = await poll("the reviewer's slow bash", () => t!.factory.getBundleConversation(id, reviewer), (x) => !!runningBash(x));
		const callId = runningBash(tv)!.callId;
		await web.interruptBundleAgent(id);
		let v = await t!.factory.getBundle(id);
		expect(v.state).toBe("REVIEWING");
		expect(v.interrupted).toMatchObject({ role: "reviewer", conversationId: String(reviewer), by: "web" });
		expect(v.notices.some((n) => n.text.includes("interrupted"))).toBe(true);
		await poll("the aborted bash", () => t!.factory.getBundleConversation(id, reviewer), (x) => x.items.some((i) => i.toolResult?.callId === callId) && !x.busy);
		await new Promise((r) => setTimeout(r, 300));
		expect((await t!.factory.getBundle(id)).state).toBe("REVIEWING");
		await expect(web.interruptBundleAgent(id)).rejects.toMatchObject({ code: "conflict" });
		const out = await web.messageBundle(id, "Continue.");
		expect(out).toMatchObject({ to: "reviewer", conversationId: String(reviewer) });
		expect((await t!.factory.getBundle(id)).interrupted).toBeUndefined();
		v = await untilBundle(t!.factory, id, (x) => x.state !== "REVIEWING" && x.state !== "INTEGRATING");
		expect(v.state).not.toBe("FAILED");
		expect(v.reviews.length).toBe(1);
		expect(v.history.map((h) => h.to)).toContain("DELIVERING");
		const items = (await t!.factory.getBundleConversation(id, reviewer)).items;
		expect(items.findIndex((i) => i.toolResult?.name === "submit_review" && !i.toolResult.isError)).toBeGreaterThan(items.findIndex((i) => i.msgId === out.message));
		await untilBundle(t!.factory, id, bundleIn("AWAITING_MERGE", "MERGED", "FAILED", "ESCALATED"));
	});
});

describe("live cost", () => {
	test("while the builder works its live cost shows on the run and in cost.updated; at the turn's end the total does not drop and nothing is counted twice", async () => {
		const { web } = await setup();
		t!.control.builderSlow = SLOW;
		const run = await start();
		const events: FactoryEvent[] = [];
		t!.factory.subscribe({ run }, (e) => events.push(e));
		const { builder, callId } = await slowBuilder(run);
		const during = await poll("live cost", () => t!.factory.getRun(run), (x) => x.liveCost.totalTokens > 0);
		const entry = during.liveCost.byRole.find((r) => r.role === "builder");
		expect(entry).toMatchObject({ conversationId: String(builder) });
		expect(entry!.totalTokens).toBeGreaterThan(0);
		expect(entry!.usd).toBeGreaterThan(0);
		expect(during.liveCost.usd).toBeCloseTo(entry!.usd, 12);
		expect(during.liveCost.totalTokens).toBeCloseTo(during.liveCost.byRole.reduce((s, r) => s + r.totalTokens, 0), 12);
		const liveTotal = sum(during) + during.liveCost.totalTokens;
		// the builder's turn is not recorded yet
		expect(during.cost.some((c) => c.role === "builder")).toBe(false);
		const updated = await poll(
			"cost.updated",
			async () => events.filter((e): e is Extract<FactoryEvent, { type: "cost.updated" }> => e.type === "cost.updated"),
			(xs) => xs.some((e) => e.totalTokens >= liveTotal - 1e-12),
			10_000,
		);
		const ev = updated.find((e) => e.totalTokens >= liveTotal - 1e-12)!;
		expect(ev).toMatchObject({ project: "p", run });
		expect(ev.totalTokens).toBeCloseTo(liveTotal, 12);
		expect(ev.totalTokens).toBeGreaterThan(0);
		expect(ev.usd).toBeCloseTo(during.cost.reduce((s, c) => s + c.usd, 0) + during.liveCost.usd, 9);
		// no event of another owner reaches this run filter
		expect(events.filter((e) => e.type === "cost.updated").every((e: any) => e.run === run)).toBe(true);

		await web.stopToolCall({ run, conversationId: builder, callId });
		// watch the total while the run goes on: it never decreases
		let last = liveTotal;
		let v: RunView;
		for (;;) {
			v = await t!.factory.getRun(run);
			const total = sum(v) + v.liveCost.totalTokens;
			expect(total).toBeGreaterThanOrEqual(last - 1e-12);
			last = total;
			if (done(v)) break;
			await new Promise((r) => setTimeout(r, 20));
		}
		expect(v.state).toBe("READY");
		expect(v.liveCost).toEqual({ usd: 0, totalTokens: 0, byRole: [] });
		// the builder's turn record holds the live part seen during the turn, once
		const rec = v.cost.filter((c) => c.role === "builder" && String(c.conversationId) === String(builder));
		expect(rec.length).toBe(1);
		expect(rec[0]!.totalTokens).toBeGreaterThanOrEqual(entry!.totalTokens - 1e-12);
		const lastEvent = events.filter((e) => e.type === "cost.updated").at(-1) as any;
		expect(sum(v)).toBeGreaterThanOrEqual(lastEvent.totalTokens - 1e-12);
		// recorded = what the usage of the run's Conversations says (no double counting)
		const usageOf = async (cid: string) => {
			const { sumUsage } = await import("../src/core/usage.ts");
			const { UsageDoc } = await import("@earendil-works/pi-durable");
			return sumUsage((await t!.factory.harnessForTests.snapshot(UsageDoc as never, (/^\d+$/.test(cid) ? Number(cid) : cid) as never, {} as never)) as any).totalTokens;
		};
		const convs = [v.conversations.architect!, v.conversations.builder!, ...v.conversations.reviewers.map((r) => r.id)];
		let used = 0;
		for (const c of convs) used += await usageOf(String(c));
		expect(sum(v)).toBeCloseTo(used, 12);
	});

	test("a running helper's spend counts in the run's live cost; when the subagent returns the total does not drop", async () => {
		await setup();
		t!.control.builderSubagent = true;
		t!.control.helperHang = true;
		const run = await start();
		const v0 = await until(t!.factory, run, (x) => x.state === "BUILDING" && x.conversations.builder !== undefined);
		const builder = v0.conversations.builder!;
		await poll("the helper", () => t!.factory.getConversation(run, builder), (x) => x.helpers.length === 1);
		const tv = await t!.factory.getConversation(run, builder);
		const helper = tv.helpers[0]!;
		// the helper made its first response and ran its tools; it hangs on its next step
		await poll("the helper's tools", () => t!.factory.getConversation(run, helper), (x) => x.items.filter((i) => i.toolResult).length === 2);
		const usageOf = async (cid: string) => {
			const { sumUsage } = await import("../src/core/usage.ts");
			const { UsageDoc } = await import("@earendil-works/pi-durable");
			return sumUsage((await t!.factory.harnessForTests.snapshot(UsageDoc as never, (/^\d+$/.test(cid) ? Number(cid) : cid) as never, {} as never)) as any);
		};
		const helperTokens = (await usageOf(String(helper))).totalTokens;
		expect(helperTokens).toBeGreaterThan(0);
		const during = await poll("live cost with the helper", () => t!.factory.getRun(run), (x) => x.liveCost.totalTokens > 0);
		const b = during.liveCost.byRole.find((r) => r.role === "builder")!;
		expect(b).toMatchObject({ conversationId: String(builder) });
		// the builder's own unrecorded spend (a fresh Conversation: all of it, up to its subagent call) plus the helper's
		expect(during.cost.some((c) => String(c.conversationId) === String(builder))).toBe(false);
		const own = (await usageOf(String(builder))).totalTokens;
		expect(own).toBeGreaterThan(0);
		expect(b.totalTokens).toBe(own + helperTokens);
		expect(during.liveCost.byRole.some((r) => String(r.conversationId) === String(helper))).toBe(false);
		let last = sum(during) + during.liveCost.totalTokens;
		t!.control.helperHang = false;
		let v: RunView;
		for (;;) {
			v = await t!.factory.getRun(run);
			const total = sum(v) + v.liveCost.totalTokens;
			expect(total).toBeGreaterThanOrEqual(last - 1e-12);
			last = total;
			if (done(v)) break;
			await new Promise((r) => setTimeout(r, 20));
		}
		expect(v.state).toBe("READY");
		expect(v.liveCost.totalTokens).toBe(0);
	});

	test("a discussion's running turn has a live cost; its cost stays the recorded total; Stop still ends the turn", async () => {
		await setup();
		const events: FactoryEvent[] = [];
		const id = await t!.factory.startDiscussion("p", { title: "t", message: "hi" });
		t!.factory.subscribe({ discussion: id }, (e) => events.push(e));
		let d = await untilDiscussion(t!.factory, id, (x) => x.state === "OPEN" && !x.turn);
		expect(d.liveCost).toEqual({ usd: 0, totalTokens: 0 });
		const recorded = d.cost.totalTokens;
		expect(recorded).toBeGreaterThan(0);
		expect(recorded).toBeCloseTo(d.turnCosts.reduce((s, c) => s + c.totalTokens, 0), 12);
		// the reply reads a file (one model response), then hangs before its next step
		t!.control.discussantHangLater = true;
		await t!.factory.say(id, "READ: README.md");
		d = await poll("discussion live cost", () => t!.factory.getDiscussion(id), (x) => x.liveCost.totalTokens > 0);
		expect(d.cost.totalTokens).toBeCloseTo(recorded, 12);
		expect(d.liveCost.totalTokens).toBeGreaterThan(0);
		expect(d.liveCost.usd).toBeGreaterThan(0);
		const total = recorded + d.liveCost.totalTokens;
		const ev = await poll(
			"discussion cost.updated",
			async () => events.filter((e) => e.type === "cost.updated") as any[],
			(xs) => xs.some((e) => Math.abs(e.totalTokens - total) < 1e-12),
			10_000,
		);
		expect(ev.find((e) => Math.abs(e.totalTokens - total) < 1e-12)).toMatchObject({ project: "p", discussion: id });
		// Stop: the scripted provider can't observe the abort; release it shortly after the abort is marked
		const stopping = t!.factory.as("web").stopTurn(id);
		setTimeout(() => (t!.control.discussantHangLater = false), 300);
		await stopping;
		d = await untilDiscussion(t!.factory, id, (x) => x.state === "OPEN" && !x.turn);
		expect(d.notices.at(-1)).toMatchObject({ kind: "stopped" });
		expect(d.liveCost).toEqual({ usd: 0, totalTokens: 0 });
		expect(d.cost.totalTokens).toBeGreaterThanOrEqual(total - 1e-12);
		expect(d.cost.totalTokens).toBeCloseTo(d.turnCosts.reduce((s, c) => s + c.totalTokens, 0), 12);
	});
});
