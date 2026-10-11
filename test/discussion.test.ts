// Discussions (spec docs/superpowers/specs/2026-10-11-discussion-flow-design.md): the workspace, the life cycle and
// chat turns, ...
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { DiscussionView, FactoryEvent, RunCtx } from "../src/core/types.ts";
import { git, gitOut } from "../src/github/git.ts";
import { GitHub } from "../src/github/github.ts";
import { makeFactory, type TestEnv, untilDiscussion } from "./helpers.ts";

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
		t!.control.discussantFail = "rate limited";
		await t!.factory.say(id, "hi");
		const v = await t!.factory.waitForDiscussion(id, open);
		expect(v.notices.at(-1)).toMatchObject({ kind: "error", text: expect.stringContaining("rate limited") });
		expect(v.state).toBe("OPEN");
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
