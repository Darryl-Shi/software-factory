// Messages to the agent a run is with (`message`, spec §3.6): routing, holds, steers, side turns, spec revision at
// the gate, re-review of changes made after a message, cost of message turns, and the policy switch.
import { afterEach, describe, expect, test } from "vitest";
import { messageTarget } from "../src/core/messages.ts";
import type { FactoryCore, FactoryEvent, RunView } from "../src/core/types.ts";
import { git } from "../src/github/git.ts";
import { inState, makeFactory, type TestEnv, until } from "./helpers.ts";

let t: TestEnv | undefined;
afterEach(async () => {
	await t?.factory.close().catch(() => {});
	t = undefined;
});

const done = inState("DELIVERED", "FAILED", "CANCELLED");
const states = (v: RunView) => v.history.map((h) => h.to);

async function setup(settings: [string, unknown][] = []) {
	t = await makeFactory();
	await t.factory.createProject("p", "me/p");
	for (const [path, value] of settings) await t.factory.setSetting({ project: "p" }, path, value);
	return { web: t.factory.as("web") as FactoryCore };
}
async function remoteFileText(repo: string, ref: string, path: string) {
	const r = await git(t!.host.bare(repo), ["show", `${ref}:${path}`], { allowFail: true });
	return r.code === 0 ? r.stdout : undefined;
}
const start = (body = "make hello") => t!.factory.startRun("p", { source: "test", title: "hello", body });
/** Wait until a conversation's transcript satisfies `pred`. */
async function transcript(run: string, conv: string, pred: (items: Awaited<ReturnType<FactoryCore["getConversation"]>>) => boolean, ms = 15_000) {
	const deadline = Date.now() + ms;
	for (;;) {
		const tv = await t!.factory.getConversation(run, conv);
		if (pred(tv)) return tv;
		if (Date.now() > deadline) throw new Error(`timeout waiting on conversation ${conv}: ${JSON.stringify(tv.items.slice(-4))}`);
		await new Promise((r) => setTimeout(r, 50));
	}
}
const repliedAfter = (msgId: string) => (tv: { items: { role?: string; msgId?: string; text?: string }[]; busy: boolean }) => {
	const i = tv.items.findIndex((x) => x.msgId === msgId);
	return i >= 0 && !tv.busy && tv.items.slice(i + 1).some((x) => x.role === "assistant" && !!x.text);
};

describe("routing and validation", () => {
	test("messageTarget follows the run: architect through the spec gate, the reviewer while reviewing, else the builder", () => {
		const conversations = { architect: "a", builder: "b", reviewers: [{ id: "r1", seq: 1 }, { id: "r2", seq: 2 }] };
		const at = (state: string, gate?: string, reviewSeq = 2) => messageTarget({ state, gate, conversations, counters: { reviewSeq } } as never);
		expect(at("RECEIVED")).toEqual({ role: "architect", conversationId: "a" });
		expect(at("DISCUSSING")).toEqual({ role: "architect", conversationId: "a" });
		expect(at("AWAITING_APPROVAL", "spec")).toEqual({ role: "architect", conversationId: "a" });
		expect(at("BUILDING")).toEqual({ role: "builder", conversationId: "b" });
		expect(at("REVIEWING", undefined, 1)).toEqual({ role: "reviewer", conversationId: "r1" });
		expect(at("REVIEWING", undefined, 3)).toEqual({ role: "reviewer", conversationId: "r2" });
		expect(at("AWAITING_APPROVAL", "delivery")).toEqual({ role: "builder", conversationId: "b" });
		expect(at("ESCALATED")).toEqual({ role: "builder", conversationId: "b" });
		expect(messageTarget({ state: "PREPARING", conversations: { reviewers: [] }, counters: { reviewSeq: 0 } } as never)).toEqual({ role: "architect" });
	});

	test("invalid, not_found and conflict cases; a pending discussion question takes an answer, not a message", async () => {
		const { web } = await setup([["policy.approvals", ["spec"]]]);
		t!.control.askFirst = true;
		await expect(web.message("nope", "hi")).rejects.toMatchObject({ code: "not_found" });
		const run = await start();
		await expect(web.message(run, "   ")).rejects.toMatchObject({ code: "invalid" });
		await until(t!.factory, run, (v) => v.pendingAsk?.question.kind === "discussion");
		await expect(web.message(run, "hello")).rejects.toMatchObject({ code: "conflict" });
		await t!.factory.cancelRun(run);
		await until(t!.factory, run, inState("CANCELLED"));
		await expect(web.message(run, "hello")).rejects.toMatchObject({ code: "conflict" });
	});

	test("policy.messages turns messages to a role off", async () => {
		const { web } = await setup([["policy.approvals", ["spec"]], ["policy.messages", ["builder"]]]);
		const run = await start();
		await until(t!.factory, run, inState("AWAITING_APPROVAL"));
		await expect(web.message(run, "hi")).rejects.toMatchObject({ code: "conflict", message: expect.stringContaining("policy.messages") });
		await expect(t!.factory.setSetting({ project: "p" }, "policy.messages", ["nobody"])).rejects.toMatchObject({ code: "invalid" });
	});
});

describe("at the spec gate", () => {
	test("a question starts a side turn: the architect replies, the ask stays pending, the turn's cost is recorded", async () => {
		const { web } = await setup([["policy.approvals", ["spec"]]]);
		const events: FactoryEvent[] = [];
		t!.factory.subscribe({}, (e) => events.push(e));
		const run = await start();
		const before = await until(t!.factory, run, inState("AWAITING_APPROVAL"));
		const out = await web.message(run, "Why plain text output?");
		expect(out).toMatchObject({ to: "architect", conversationId: String(before.conversations.architect) });
		const tv = await transcript(run, before.conversations.architect!, repliedAfter(out.message));
		const human = tv.items.find((x) => x.msgId === out.message)!;
		expect(human).toMatchObject({ role: "user", author: "human", by: "web", text: "Why plain text output?" });
		const v = await until(t!.factory, run, (x) => x.cost.some((c) => c.trigger === "message"));
		expect(v.state).toBe("AWAITING_APPROVAL");
		expect(v.pendingAsk?.id).toBe(before.pendingAsk!.id);
		expect(v.messages).toEqual([expect.objectContaining({ id: out.message, to: "architect", by: "web", conversationId: String(before.conversations.architect) })]);
		expect(v.artifacts.spec?.version).toBe(1);
		const mc = v.cost.find((c) => c.trigger === "message")!;
		expect(mc.role).toBe("architect");
		expect(String(mc.conversationId)).toBe(String(before.conversations.architect));
		expect(mc.totalTokens).toBeGreaterThan(0);
		expect(events.some((e) => e.type === "run.askResolved")).toBe(false);
		expect(events.filter((e) => e.type === "run.message").map((e: any) => e.message.id)).toContain(out.message);
		// the run still moves on the human's decision
		await web.approve(run, "spec");
		expect(states(await until(t!.factory, run, done))).toContain("DELIVERED");
	});

	test("a change request makes the architect revise the spec: v2 replaces the pending version and needs approval", async () => {
		const { web } = await setup([["policy.approvals", ["spec"]]]);
		const events: FactoryEvent[] = [];
		t!.factory.subscribe({}, (e) => events.push(e));
		const run = await start();
		const v1 = await until(t!.factory, run, inState("AWAITING_APPROVAL"));
		await web.message(run, "REVISE: also print the date");
		const v2 = await until(t!.factory, run, (x) => x.state === "AWAITING_APPROVAL" && x.artifacts.spec?.version === 2);
		expect(v2.pendingAsk!.id).not.toBe(v1.pendingAsk!.id);
		expect(v2.artifacts.spec!.text).toContain("also print the date");
		expect(states(v2).slice(-2)).toEqual(["SPEC_READY", "AWAITING_APPROVAL"]);
		expect(events).toContainEqual(expect.objectContaining({ type: "run.askResolved", ask: v1.pendingAsk!.id, by: "architect" }));
		expect(v2.notices.some((n) => /revised the spec to v2/.test(n.text))).toBe(true);
		// the old ask is closed: approving it is refused only by gate state, the new one approves
		await web.approve(run, "spec");
		const end = await until(t!.factory, run, done);
		expect(end.state).toBe("DELIVERED");
	});
});

describe("while agents work", () => {
	test("a message to a busy builder is steered into its run; it neither moves the run nor ends the build", async () => {
		const { web } = await setup();
		t!.control.hangAtInput = 1;
		const run = await start();
		const v = await until(t!.factory, run, (x) => x.state === "BUILDING" && x.conversations.builder !== undefined);
		await until(t!.factory, run, () => t!.control.builderHang);
		const out = await web.message(run, "keep functions small");
		expect(out).toMatchObject({ to: "builder", conversationId: String(v.conversations.builder) });
		t!.control.builderHang = false;
		const end = await until(t!.factory, run, done);
		expect(end.state).toBe("DELIVERED");
		const tv = await t!.factory.getConversation(run, v.conversations.builder!);
		expect(tv.items.some((x) => x.author === "human" && x.text === "keep functions small")).toBe(true);
		expect(t!.control.builderInputs).toHaveLength(1);
		expect(end.cost.filter((c) => c.role === "builder" && c.trigger !== "message")).toHaveLength(1);
	});

	test("a message sent before the architect starts is held and delivered with its first input", async () => {
		const { web } = await setup([["policy.approvals", ["spec"]]]);
		const run = await start();
		const out = await web.message(run, "use tabs, not spaces");
		expect(out.to).toBe("architect");
		const v = await until(t!.factory, run, inState("AWAITING_APPROVAL"));
		expect(v.messages[0]).toMatchObject({ id: out.message, conversationId: String(v.conversations.architect) });
		const tv = await t!.factory.getConversation(run, v.conversations.architect!);
		const i = tv.items.findIndex((x) => x.msgId === out.message);
		expect(i).toBeGreaterThan(tv.items.findIndex((x) => x.author === "factory"));
		expect(t!.control.architectInputs).toHaveLength(1);
	});

	test("files the builder changes after a message at the delivery gate go back through review before delivery", async () => {
		const { web } = await setup([["policy.approvals", ["delivery"]]]);
		const run = await start();
		const gate = await until(t!.factory, run, inState("AWAITING_APPROVAL"));
		expect(gate.gate).toBe("delivery");
		const reviewsBefore = gate.conversations.reviewers.length;
		const out = await web.message(run, "EDIT: add a CHANGELOG");
		await transcript(run, gate.conversations.builder!, repliedAfter(out.message));
		await web.approve(run, "delivery");
		// the change was never reviewed: the run goes back through review and to the gate again
		const again = await until(t!.factory, run, (x) => x.state === "AWAITING_APPROVAL" && x.conversations.reviewers.length === reviewsBefore + 1);
		expect(again.notices.some((n) => /changed after the last review/.test(n.text))).toBe(true);
		expect(states(again).slice(-3)).toEqual(["DELIVERING", "REVIEWING", "AWAITING_APPROVAL"]);
		await web.approve(run, "delivery");
		const end = await until(t!.factory, run, done);
		expect(end.state).toBe("DELIVERED");
		expect(await remoteFileText("me/p", "main", "CHANGELOG.md")).toBe("add a CHANGELOG\n");
	});
});
