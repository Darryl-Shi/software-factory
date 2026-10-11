// Discussions (spec docs/superpowers/specs/2026-10-11-discussion-flow-design.md): the workspace, the life cycle and
// chat turns, drafting, ...
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { BridgeDoc } from "../src/core/bridge.ts";
import { draftInstructions } from "../src/core/discussion-task.ts";
import type { DiscussionView, FactoryEvent, RunCtx } from "../src/core/types.ts";
import { git, gitOut } from "../src/github/git.ts";
import { GitHub } from "../src/github/github.ts";
import { makeFactory, type TestEnv, until, untilDiscussion } from "./helpers.ts";

let t: TestEnv | undefined;
afterEach(async () => {
	vi.restoreAllMocks();
	if (t) t.control.discussantHang = false;
	await t?.factory.close().catch(() => {});
	t = undefined;
});

/** Commit `path` with `content` on the remote's default branch (creating the remote if needed); returns the new head. */
async function pushCommit(repo: string, path: string, content: string): Promise<string> {
	await t!.host.createRepo(repo, { private: true });
	const work = mkdtempSync(join(tmpdir(), "push-"));
	try {
		await git(work, ["clone", "-q", t!.host.bare(repo), "."]);
		await git(work, ["checkout", "-q", "-B", "main"]);
		writeFileSync(join(work, path), content);
		await git(work, ["add", "-A"]);
		await git(work, ["commit", "-q", "-m", `add ${path}`]);
		await git(work, ["push", "-q", "origin", "HEAD:refs/heads/main"]);
		return await gitOut(work, ["rev-parse", "HEAD"]);
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
}
/** Create the remote repo with a first commit holding `path` on main. */
const createRemoteWith = (repo: string, path: string, content: string) => pushCommit(repo, path, content);

describe("workspace", () => {
	let gh: GitHub;
	let rc: RunCtx;
	beforeEach(async () => {
		t = await makeFactory();
		await t.host.seedRepo("me/p", { "README.md": "# p\n" });
		await t.factory.createProject("p", "me/p");
		gh = new GitHub(t.host);
		rc = { runId: "disc-1", config: t.factory.config.effective({ project: "p" }) } as RunCtx;
	});

	test("open(…, 'discussions') checks out under <workdir>/discussions/<id>", async () => {
		const ws = await gh.open("me/p", rc, "discussions");
		expect(ws.path).toBe(join(t!.dir, "work", "discussions", "disc-1"));
		expect(existsSync(join(t!.dir, "work", "discussions", "disc-1.json"))).toBe(true);
		expect(readFileSync(join(ws.path, "README.md"), "utf8")).toBe("# p\n");
	});

	test("refresh fast-forwards to the default branch", async () => {
		const ws = await gh.open("me/p", rc, "discussions");
		const head = await pushCommit("me/p", "NEW.md", "new\n");
		const ws2 = await gh.refresh(ws, rc);
		expect(ws2.baseRef).toBe(head);
		expect(readFileSync(join(ws2.path, "NEW.md"), "utf8")).toBe("new\n");
		expect(JSON.parse(readFileSync(`${ws2.path}.json`, "utf8")).baseRef).toBe(head);
	});

	test("refresh of a new-repo workspace before the repo exists changes nothing", async () => {
		const ws = await gh.open("me/new", rc, "discussions");
		expect(ws.newRepo).toBe(true);
		expect(await gh.refresh(ws, rc)).toEqual(ws);
	});

	test("refresh of a new-repo workspace after the repo was created gives the delivered code", async () => {
		const ws = await gh.open("me/new", rc, "discussions");
		expect(ws.newRepo).toBe(true);
		await createRemoteWith("me/new", "README.md", "delivered\n");
		const ws2 = await gh.refresh(ws, rc);
		expect(ws2.newRepo).toBe(false);
		expect(ws2.path).toBe(ws.path);
		expect(readFileSync(join(ws2.path, "README.md"), "utf8")).toBe("delivered\n");
	});

	test("a failed fast-forward throws with git's output", async () => {
		const ws = await gh.open("me/p", rc, "discussions");
		writeFileSync(join(ws.path, "LOCAL.md"), "local\n");
		await git(ws.path, ["add", "-A"]);
		await git(ws.path, ["commit", "-q", "-m", "diverge"]);
		await pushCommit("me/p", "NEW.md", "new\n");
		await expect(gh.refresh(ws, rc)).rejects.toThrow(/^could not fast-forward the discussion's checkout to origin\/main: /);
	});

	test("the run area is unchanged by default", async () => {
		const ws = await gh.open("me/p", rc);
		expect(ws.path).toBe(join(t!.dir, "work", "runs", "disc-1"));
		expect(existsSync(join(t!.dir, "work", "runs", "disc-1.json"))).toBe(true);
	});
});

/** A discussion that is OPEN with no turn running. */
const open = (v: DiscussionView) => v.state === "OPEN" && v.turn === null;

async function setup() {
	t = await makeFactory();
	await t.host.seedRepo("me/p", { "README.md": "# p\n" });
	await t.factory.createProject("p", "me/p");
}

describe("life cycle", () => {
	beforeEach(setup);

	test("start → OPEN; the first input carries the project context and the first message; the model read the repo", async () => {
		const id = await t!.factory.startDiscussion("p", { title: "auth?", message: "how should login work?" });
		expect(id).toBe("disc-1");
		const v = await t!.factory.waitForDiscussion(id, open);
		expect(v.model).toEqual({ model: "scripted/discussant", thinking: "high" }); // thinking falls back to the architect's default
		expect(t!.control.discussantInputs[0]).toMatch(
			/^# Discussion\nTitle: auth\?[\s\S]*# Project\nProject: p; repo binding: me\/p[\s\S]*# The human's first message\nhow should login work\?/,
		);
		const tv = await t!.factory.getDiscussionConversation(id);
		expect(tv.role).toBe("discussant");
		expect(tv.items.some((i) => i.toolResult?.name === "bash" && !i.toolResult.isError)).toBe(true);
		expect(tv.items.at(-1)).toMatchObject({ role: "assistant", text: "first reply" });
		expect(v.turnCosts).toHaveLength(1);
		expect(v.turnCosts[0]).toMatchObject({ turn: 1, kind: "say" });
		expect(v.cost.totalTokens).toBeGreaterThan(0);
		expect(v.workspace!.path).toBe(join(t!.dir, "work", "discussions", id));
		expect((await t!.factory.listDiscussions({ project: "p" })).map((x) => x.id)).toEqual([id]);
		expect(await t!.factory.listDiscussions({ states: ["CLOSED"] })).toEqual([]);
	});

	test("reopen fast-forwards the checkout and keeps the Conversation", async () => {
		const id = await t!.factory.startDiscussion("p", { title: "t", message: "m" });
		const v1 = await t!.factory.waitForDiscussion(id, open);
		await expect(t!.factory.reopenDiscussion(id)).rejects.toMatchObject({ code: "conflict" });
		await t!.factory.closeDiscussion(id);
		await t!.factory.waitForDiscussion(id, (v) => v.state === "CLOSED");
		await expect(t!.factory.closeDiscussion(id)).rejects.toMatchObject({ code: "conflict" });
		const head = await pushCommit("me/p", "NEW.md", "new\n");
		await t!.factory.reopenDiscussion(id);
		const v2 = await t!.factory.waitForDiscussion(id, open);
		expect(v2.workspace!.baseRef).toBe(head);
		expect(readFileSync(join(v2.workspace!.path, "NEW.md"), "utf8")).toBe("new\n");
		expect(v2.conversationId).toEqual(v1.conversationId);
		expect(v2.turnCosts).toHaveLength(1); // no second first turn
		await t!.factory.say(id, "back again");
		await untilDiscussion(t!.factory, id, open);
		const items = (await t!.factory.getDiscussionConversation(id)).items;
		expect(items.at(-1)).toMatchObject({ role: "assistant", text: "re: back again" });
	});

	test("a failed start goes to FAILED; retry recovers", async () => {
		const spy = vi.spyOn(GitHub.prototype, "open").mockRejectedValueOnce(new Error("GitHub is down"));
		const id = await t!.factory.startDiscussion("p", { title: "t", message: "m" });
		const v = await t!.factory.waitForDiscussion(id, (x) => x.state === "FAILED");
		expect(v.error).toContain("GitHub is down");
		expect(spy).toHaveBeenCalledTimes(1);
		await expect(t!.factory.say(id, "x")).rejects.toMatchObject({ code: "conflict" });
		await t!.factory.retryDiscussion(id);
		const v2 = await t!.factory.waitForDiscussion(id, open);
		expect(v2.error).toBeUndefined();
		expect(v2.turnCosts).toHaveLength(1);
		await expect(t!.factory.retryDiscussion(id)).rejects.toMatchObject({ code: "conflict" });
	});

	test("refusals: unknown id, unknown project, empty text, unknown model", async () => {
		await expect(t!.factory.getDiscussion("disc-99")).rejects.toMatchObject({ code: "not_found" });
		await expect(t!.factory.say("disc-99", "x")).rejects.toMatchObject({ code: "not_found" });
		await expect(t!.factory.startDiscussion("nope", { title: "t", message: "m" })).rejects.toMatchObject({ code: "not_found" });
		await expect(t!.factory.startDiscussion("p", { title: " ", message: "m" })).rejects.toMatchObject({ code: "invalid" });
		await expect(t!.factory.startDiscussion("p", { title: "t", message: "" })).rejects.toMatchObject({ code: "invalid" });
		await expect(t!.factory.startDiscussion("p", { title: "t", message: "m", model: { model: "scripted/nope", thinking: "low" } })).rejects.toMatchObject({
			code: "invalid",
		});
		await expect(t!.factory.startDiscussion("p", { title: "t", message: "m", model: { model: "scripted/discussant", thinking: "max" } })).rejects.toMatchObject({
			code: "invalid",
		});
		expect(await t!.factory.listDiscussions()).toEqual([]);
		const id = await t!.factory.startDiscussion("p", { title: "t", message: "m", model: { model: "scripted/discussant-b", thinking: "low" } });
		expect((await t!.factory.waitForDiscussion(id, open)).model).toEqual({ model: "scripted/discussant-b", thinking: "low" });
		await expect(t!.factory.say(id, "  ")).rejects.toMatchObject({ code: "invalid" });
		await expect(t!.factory.stopTurn(id)).rejects.toMatchObject({ code: "conflict" });
	});

	test("events: discussion.state and discussion.updated reach project and discussion subscribers, not run subscribers", async () => {
		const byProject: FactoryEvent[] = [];
		const byDiscussion: FactoryEvent[] = [];
		const byRun: FactoryEvent[] = [];
		const byOtherProject: FactoryEvent[] = [];
		t!.factory.subscribe({ project: "p" }, (e) => byProject.push(e));
		t!.factory.subscribe({ discussion: "disc-1" }, (e) => byDiscussion.push(e));
		t!.factory.subscribe({ run: "run-x" }, (e) => byRun.push(e));
		t!.factory.subscribe({ project: "q" }, (e) => byOtherProject.push(e));
		const id = await t!.factory.startDiscussion("p", { title: "t", message: "m" });
		await t!.factory.waitForDiscussion(id, open);
		await new Promise((r) => setTimeout(r, 300)); // conversation.updated is throttled
		for (const got of [byProject, byDiscussion]) {
			const states = got.filter((e) => e.type === "discussion.state");
			expect(states).toEqual([
				{ type: "discussion.state", discussion: id, project: "p", from: null, to: "PREPARING" },
				{ type: "discussion.state", discussion: id, project: "p", from: "PREPARING", to: "OPEN" },
			]);
			const updated = got.flatMap((e) => (e.type === "discussion.updated" ? [e.what] : []));
			expect(updated).toEqual(["turn.started", "turn.ended"]);
			expect(got.some((e) => e.type === "discussion.conversation.updated" && e.discussion === id)).toBe(true);
		}
		expect(byRun).toEqual([]);
		expect(byOtherProject).toEqual([]);
	});
});

describe("turns", () => {
	let id: string;
	beforeEach(async () => {
		await setup();
		id = await t!.factory.startDiscussion("p", { title: "auth?", message: "how should login work?" });
		await t!.factory.waitForDiscussion(id, open);
	});

	test("say gets a reply shown as a human message; say during a turn and on a closed discussion is refused", async () => {
		await t!.factory.as("web").say(id, "what about SSO?");
		const v = await t!.factory.waitForDiscussion(id, open);
		const items = (await t!.factory.getDiscussionConversation(id)).items;
		expect(items.find((i) => i.author === "human")).toMatchObject({ by: "web", text: "what about SSO?" });
		expect(items.at(-1)).toMatchObject({ role: "assistant", text: "re: what about SSO?" });
		expect(t!.control.discussantHeard).toEqual(["what about SSO?"]);
		expect(v.turnCosts.map((c) => c.turn)).toEqual([1, 2]);
		t!.control.discussantHang = true;
		await t!.factory.say(id, "slow");
		await expect(t!.factory.say(id, "again")).rejects.toMatchObject({ code: "conflict" });
		await expect(t!.factory.closeDiscussion(id)).rejects.toMatchObject({ code: "conflict" });
		t!.control.discussantHang = false;
		await t!.factory.waitForDiscussion(id, open);
		await t!.factory.closeDiscussion(id);
		await t!.factory.waitForDiscussion(id, (x) => x.state === "CLOSED");
		await expect(t!.factory.say(id, "x")).rejects.toMatchObject({ code: "conflict" });
	});

	test("Stop aborts a running turn and adds a stopped notice", async () => {
		t!.control.discussantHang = true;
		await t!.factory.say(id, "slow");
		await new Promise((r) => setTimeout(r, 300));
		// the scripted provider cannot observe the abort signal; release it shortly after the abort is marked
		const stopping = t!.factory.as("web").stopTurn(id);
		setTimeout(() => (t!.control.discussantHang = false), 300);
		await stopping;
		const v = await t!.factory.waitForDiscussion(id, open);
		expect(v.state).toBe("OPEN");
		expect(v.notices.at(-1)).toMatchObject({ kind: "stopped", text: "Stopped by web" });
		expect(v.turnCosts).toHaveLength(2);
		const items = (await t!.factory.getDiscussionConversation(id)).items;
		expect(items.some((i) => i.role === "assistant" && i.text === "re: slow")).toBe(false);
		await t!.factory.say(id, "after");
		await t!.factory.waitForDiscussion(id, open);
		expect((await t!.factory.getDiscussionConversation(id)).items.at(-1)).toMatchObject({ role: "assistant", text: "re: after" });
	});

	test("a provider error ends the turn with an error notice; the discussion stays OPEN", async () => {
		// a non-retryable message: pi-ai retries "rate limited" with backoff
		t!.control.discussantFail = "invalid api key";
		await t!.factory.say(id, "hi");
		const v = await t!.factory.waitForDiscussion(id, open);
		expect(v.notices.at(-1)).toMatchObject({ kind: "error", text: expect.stringContaining("invalid api key") });
		expect(v.state).toBe("OPEN");
	});

	test("a late Stop does not abort the next turn", async () => {
		t!.control.discussantHang = true;
		await t!.factory.say(id, "slow");
		await new Promise((r) => setTimeout(r, 300));
		// hold stopTurn between its commit and the abort until the next turn is running
		const harness = (t!.factory as any).harness;
		const original = harness.conversation.bind(harness);
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		vi.spyOn(harness, "conversation").mockImplementationOnce(async (...args: unknown[]) => {
			await gate;
			return original(...args);
		});
		const stopping = t!.factory.stopTurn(id);
		await new Promise((r) => setTimeout(r, 300));
		t!.control.discussantHang = false;
		const v1 = await t!.factory.waitForDiscussion(id, open);
		expect(v1.notices.at(-1)!.kind).toBe("stopped");
		t!.control.discussantHang = true;
		await t!.factory.say(id, "next");
		await new Promise((r) => setTimeout(r, 300));
		release();
		// (an abort waits for the scripted step, which cannot observe it: release the step shortly after)
		setTimeout(() => (t!.control.discussantHang = false), 300);
		await stopping;
		const v2 = await t!.factory.waitForDiscussion(id, open);
		expect(v2.notices.filter((n) => n.kind === "stopped")).toHaveLength(1);
		expect((await t!.factory.getDiscussionConversation(id)).items.at(-1)).toMatchObject({ role: "assistant", text: "re: next" });
	});

	test("the discussant has no write tools", async () => {
		await t!.factory.say(id, "WRITE: try");
		await t!.factory.waitForDiscussion(id, open);
		const res = (await t!.factory.getDiscussionConversation(id)).items.find((i) => i.toolResult?.name === "write");
		expect(res?.toolResult?.isError).toBe(true);
		expect(existsSync(join((await t!.factory.getDiscussion(id)).workspace!.path, "x.txt"))).toBe(false);
	});

	test("the pinned model is kept when discussion.model changes later", async () => {
		await t!.factory.setSetting({ project: "p" }, "discussion.model.model", "scripted/discussant-b");
		await t!.factory.say(id, "still you?");
		await t!.factory.waitForDiscussion(id, open);
		expect(t!.control.discussantModels.at(-1)).toBe("discussant");
		const id2 = await t!.factory.startDiscussion("p", { title: "t2", message: "m" });
		expect(id2).toBe("disc-2");
		expect((await t!.factory.waitForDiscussion(id2, open)).model.model).toBe("scripted/discussant-b");
		expect(t!.control.discussantModels.at(-1)).toBe("discussant-b");
	});
});

describe("drafting", () => {
	let id: string;
	beforeEach(async () => {
		await setup();
		id = await t!.factory.startDiscussion("p", { title: "auth?", message: "how should login work?" });
		await t!.factory.waitForDiscussion(id, open);
	});
	/** Request drafts and wait for the turn to end. */
	const draft = async (instructions?: string) => {
		await t!.factory.requestDrafts(id, instructions);
		return t!.factory.waitForDiscussion(id, open);
	};
	const ok = [
		{ id: "D1", title: "API", body: "B1", edited: false, batch: 1 },
		{ id: "D2", title: "UI", body: "B2", edited: false, batch: 1 },
	];

	test("requestDrafts stores the summary and drafts; instructions reach the model", async () => {
		await t!.factory.requestDrafts(id, "split API and UI");
		const v = await t!.factory.waitForDiscussion(id, open);
		expect(v.summary).toBe("S: settled X; open Y");
		expect(v.drafts).toEqual(ok);
		expect(t!.control.discussantInputs.at(-1)).toMatch(/^# Draft tickets[\s\S]*split API and UI/);
		expect(v.turnCosts.at(-1)).toMatchObject({ turn: 2, kind: "draft" });
	});

	test("an invalid submission gets the problems back and the next one counts", async () => {
		t!.control.draftPlan = ["invalid-then-ok"];
		const v = await draft();
		expect(v.drafts).toHaveLength(2);
		expect(v.summary).toBe("S: settled X; open Y");
		const items = (await t!.factory.getDiscussionConversation(id)).items;
		const errors = items.filter((i) => i.toolResult?.name === "submit_tickets" && i.toolResult.isError);
		expect(errors).toHaveLength(1);
		expect(errors[0]!.toolResult!.text).toContain("summary is required");
	});

	test("no submission after 2 reminders: notice, drafts unchanged", async () => {
		const before = await draft();
		expect(before.drafts).toEqual(ok);
		t!.control.draftPlan = ["none"];
		const v = await draft();
		expect(v.notices.at(-1)).toMatchObject({ kind: "no_submission", text: "The model did not submit draft tickets; the drafts are unchanged" });
		expect(v.drafts).toEqual(ok);
		expect(v.summary).toBe(before.summary);
		const items = (await t!.factory.getDiscussionConversation(id)).items;
		expect(items.filter((i) => i.role === "user" && /You stopped without calling submit_tickets/.test(i.text ?? ""))).toHaveLength(2);
	});

	test("a redraft replaces every unconverted draft, edited or not", async () => {
		await draft();
		await t!.factory.updateDraft(id, "D1", { title: "API v2" });
		t!.control.draftPlan = ["one"];
		const v = await draft();
		expect(v.drafts).toEqual([{ id: "D3", title: "Only", body: "B", edited: false, batch: 2 }]);
	});

	test("updateDraft and deleteDraft; refused during a draft turn and for unknown drafts", async () => {
		await draft();
		await t!.factory.updateDraft(id, "D1", { body: "edited" });
		expect((await t!.factory.getDiscussion(id)).drafts[0]).toMatchObject({ title: "API", body: "edited", edited: true });
		await t!.factory.updateDraft(id, "D1", { title: " API 2 " });
		expect((await t!.factory.getDiscussion(id)).drafts[0]).toMatchObject({ title: "API 2", body: "edited", edited: true });
		await expect(t!.factory.updateDraft(id, "D1", { title: " " })).rejects.toMatchObject({ code: "invalid" });
		await expect(t!.factory.updateDraft(id, "D1", { body: "" })).rejects.toMatchObject({ code: "invalid" });
		await expect(t!.factory.updateDraft(id, "D1", { title: "x".repeat(201) })).rejects.toMatchObject({ code: "invalid" });
		await expect(t!.factory.updateDraft(id, "D1", {})).rejects.toMatchObject({ code: "invalid" });
		await expect(t!.factory.updateDraft(id, "D9", { body: "x" })).rejects.toMatchObject({ code: "not_found" });
		await expect(t!.factory.deleteDraft(id, "D9")).rejects.toMatchObject({ code: "not_found" });
		await expect(t!.factory.deleteDraft("disc-99", "D1")).rejects.toMatchObject({ code: "not_found" });
		await t!.factory.deleteDraft(id, "D2");
		expect((await t!.factory.getDiscussion(id)).drafts.map((d) => d.id)).toEqual(["D1"]);
		t!.control.discussantHang = true; // the drafting script also waits on discussantHang at turn 0
		await t!.factory.requestDrafts(id);
		await expect(t!.factory.requestDrafts(id)).rejects.toMatchObject({ code: "conflict" });
		await expect(t!.factory.say(id, "x")).rejects.toMatchObject({ code: "conflict" });
		await expect(t!.factory.updateDraft(id, "D1", { body: "x" })).rejects.toMatchObject({ code: "conflict" });
		await expect(t!.factory.deleteDraft(id, "D1")).rejects.toMatchObject({ code: "conflict" });
		t!.control.discussantHang = false;
		await t!.factory.waitForDiscussion(id, open);
		await t!.factory.closeDiscussion(id);
		await t!.factory.waitForDiscussion(id, (x) => x.state === "CLOSED");
		await expect(t!.factory.requestDrafts(id)).rejects.toMatchObject({ code: "conflict" });
	});

	test("edits are allowed during a say turn", async () => {
		await draft();
		t!.control.discussantHang = true;
		await t!.factory.say(id, "slow");
		await t!.factory.updateDraft(id, "D1", { body: "during say" });
		t!.control.discussantHang = false;
		expect((await t!.factory.waitForDiscussion(id, open)).drafts[0]).toMatchObject({ body: "during say", edited: true });
	});

	test("Stop during drafting leaves drafts unchanged; Stop with no turn is refused without a notice", async () => {
		const before = await draft();
		await expect(t!.factory.stopTurn(id)).rejects.toMatchObject({ code: "conflict" });
		expect((await t!.factory.getDiscussion(id)).notices).toHaveLength(before.notices.length);
		t!.control.draftPlan = ["one"];
		t!.control.discussantHang = true;
		await t!.factory.requestDrafts(id);
		await t!.factory.stopTurn(id);
		t!.control.discussantHang = false;
		const v = await t!.factory.waitForDiscussion(id, open);
		expect(v.drafts).toEqual(before.drafts);
		expect(v.summary).toBe(before.summary);
		expect(v.notices.at(-1)!.kind).toBe("stopped");
	});

	test("a submission recorded after Stop was requested is not applied", async () => {
		const before = await draft();
		t!.control.draftPlan = ["one"];
		t!.control.discussantHang = true;
		await t!.factory.requestDrafts(id);
		await new Promise((r) => setTimeout(r, 300));
		// hold stopTurn's abort so that the model's submit_tickets lands after the Stop was committed
		const harness = (t!.factory as any).harness;
		const original = harness.conversation.bind(harness);
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		vi.spyOn(harness, "conversation").mockImplementationOnce(async (...args: unknown[]) => {
			await gate;
			return original(...args);
		});
		const stopping = t!.factory.stopTurn(id);
		await new Promise((r) => setTimeout(r, 300));
		t!.control.discussantHang = false;
		const v = await t!.factory.waitForDiscussion(id, open);
		release();
		await stopping;
		const items = (await t!.factory.getDiscussionConversation(id)).items;
		expect(items.some((i) => i.toolResult?.name === "submit_tickets" && !i.toolResult.isError && i.toolResult.text === "Tickets submitted.")).toBe(true);
		expect(v.drafts).toEqual(before.drafts);
		expect(v.summary).toBe(before.summary);
		expect(v.notices.at(-1)!.kind).toBe("stopped");
		// the turn's expectation is gone: the bridge refuses a late submission
		const b = await (t!.factory as any).harness.snapshot(BridgeDoc, v.conversationId, (t!.factory as any).ctx);
		expect(b.expect ?? null).toBeNull();
	});

	test("draftInstructions starts with # Draft tickets and appends the human's instructions", () => {
		expect(draftInstructions()).toMatch(/^# Draft tickets\n/);
		expect(draftInstructions()).toContain("one ticket per piece of work that can be specified, built and reviewed on its own");
		expect(draftInstructions()).not.toContain("# The human's instructions");
		expect(draftInstructions("  ")).toBe(draftInstructions());
		expect(draftInstructions("only the API")).toMatch(/only the API$/);
	});
});

describe("handoff", () => {
	let id: string;
	beforeEach(async () => {
		await setup();
		id = await t!.factory.startDiscussion("p", { title: "auth?", message: "how should login work?" });
		await t!.factory.waitForDiscussion(id, open);
		await t!.factory.requestDrafts(id);
		await t!.factory.waitForDiscussion(id, (v) => open(v) && v.drafts.length === 2); // D1 "API", D2 "UI"
	});

	test("createTicket starts a run whose architect gets the summary and the sibling titles", async () => {
		const run = await t!.factory.createTicket(id, "D1");
		const r = await t!.factory.getRun(run);
		expect(r.request).toMatchObject({
			source: "discussion",
			title: "API",
			body: "B1",
			meta: { discussion: { id, title: "auth?", draftId: "D1", summary: "S: settled X; open Y", siblings: ["UI"] } },
		});
		await until(t!.factory, run, (v) => v.conversations.architect !== undefined && t!.control.architectInputs.length > 0);
		expect(t!.control.architectInputs.at(-1)).toMatch(
			/# Prior discussion\n[\s\S]*S: settled X; open Y[\s\S]*- UI[\s\S]*Treat points the summary marks as settled as settled/,
		);
		expect(t!.control.architectInputs.at(-1)).toMatch(/Treat points the summary marks as settled as settled; ask only about what is still open\.\n\nDiscuss the architecture/);
		expect((await t!.factory.getDiscussion(id)).drafts[0]!.runId).toBe(run);
		expect((await t!.factory.getDiscussion(id)).runs).toEqual([{ id: run, state: expect.any(String) }]);
	});

	test("a second createTicket on the same draft is refused; two at once give one run", async () => {
		const results = await Promise.allSettled([t!.factory.createTicket(id, "D2"), t!.factory.createTicket(id, "D2")]);
		expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
		expect((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason).toMatchObject({ code: "conflict" });
		expect((await t!.factory.listRuns()).filter((r) => (r.request.meta as any)?.discussion?.draftId === "D2")).toHaveLength(1);
		await expect(t!.factory.createTicket(id, "D2")).rejects.toMatchObject({ code: "conflict" });
		await expect(t!.factory.createTicket(id, "D9")).rejects.toMatchObject({ code: "not_found" });
		await expect(t!.factory.createTicket("disc-99", "D1")).rejects.toMatchObject({ code: "not_found" });
	});

	test("createTicket is refused while a draft turn runs", async () => {
		t!.control.discussantHang = true;
		await t!.factory.requestDrafts(id);
		await expect(t!.factory.createTicket(id, "D1")).rejects.toMatchObject({ code: "conflict" });
		t!.control.discussantHang = false;
		await t!.factory.waitForDiscussion(id, open);
	});

	test("createTicket works on a CLOSED discussion; converted drafts are read-only and survive a redraft", async () => {
		await t!.factory.closeDiscussion(id);
		await t!.factory.waitForDiscussion(id, (x) => x.state === "CLOSED");
		const run = await t!.factory.createTicket(id, "D1");
		await expect(t!.factory.updateDraft(id, "D1", { body: "x" })).rejects.toMatchObject({ code: "conflict" });
		await expect(t!.factory.deleteDraft(id, "D1")).rejects.toMatchObject({ code: "conflict" });
		await t!.factory.reopenDiscussion(id);
		await t!.factory.waitForDiscussion(id, open);
		t!.control.draftPlan = ["one"];
		await t!.factory.requestDrafts(id);
		const v = await t!.factory.waitForDiscussion(id, (x) => open(x) && x.drafts.some((d) => d.id === "D3"));
		expect(v.drafts).toEqual([
			{ id: "D1", title: "API", body: "B1", edited: false, batch: 1, runId: run },
			{ id: "D3", title: "Only", body: "B", edited: false, batch: 2 },
		]);
		// siblings are the drafts of the same submission only
		const run3 = await t!.factory.createTicket(id, "D3");
		expect((await t!.factory.getRun(run3)).request.meta).toMatchObject({ discussion: { draftId: "D3", siblings: [] } });
		expect((await t!.factory.getDiscussion(id)).runs.map((r) => r.id)).toEqual([run, run3]);
	});

	test("runs without a discussion keep the old architect input", async () => {
		const run = await t!.factory.startRun("p", { source: "t", title: "x", body: "x" });
		await until(t!.factory, run, (v) => v.conversations.architect !== undefined && t!.control.architectInputs.length > 0);
		expect(t!.control.architectInputs.at(-1)).not.toContain("# Prior discussion");
		expect(t!.control.architectInputs.at(-1)).toMatch(/\n\nDiscuss the architecture with the human/);
	});
});
