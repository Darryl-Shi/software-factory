// AQ testing (spec §2, §3.7): a QA agent uses the product in a boat.dev VM (here the LocalBoatBackend fake) in parallel
// with the review; QA status ran / off / skipped / unavailable; screenshots as evidence; VM lifecycle and startup sweep.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { git } from "../src/github/git.ts";
import type { RunView } from "../src/core/types.ts";
import { inState, makeFactory, type TestEnv, until } from "./helpers.ts";

let t: TestEnv | undefined;
afterEach(async () => {
	await t?.factory.close().catch(() => {});
	t = undefined;
});
const done = inState("DELIVERED", "FAILED", "CANCELLED", "ESCALATED");
const states = (v: RunView) => v.history.map((h) => h.to);

async function setup(settings: [string, unknown][] = [], opts: { runScript?: boolean } = { runScript: true }) {
	t = await makeFactory();
	t.control.runScript = opts.runScript ?? true;
	await t.factory.createProject("p", "me/p");
	await t.factory.setSetting({ project: "p" }, "qa.enabled", true);
	for (const [path, value] of settings) await t.factory.setSetting({ project: "p" }, path, value);
	return t;
}
const start = () => t!.factory.startRun("p", { source: "test", title: "hello", body: "make hello" });
const liveVms = () => t!.boat.state().calls.filter((c) => c.op === "create").map((c) => c.id).filter((id) => !t!.boat.state().vms[id!]!.deleted);

describe("AQ testing runs beside the review", () => {
	test("QA ran: a VM per round with the product running, a screenshot as evidence, VM deleted after, status in the delivery note", async () => {
		await setup();
		const run = await start();
		const v = await until(t!.factory, run, done);
		expect(v.state).toBe("DELIVERED");
		expect(v.reviews).toHaveLength(1);
		expect(v.reviews[0]).toMatchObject({ seq: 1, round: 1, qaStatus: "ran", submitted: { review: true, qa: true }, screenshots: ["r1-s1"] });
		expect(v.qaStatus).toBe("ran");
		expect(v.conversations.qa).toHaveLength(1);
		// the VM: created with noEnv and named for the run and round, the product booted from the reviewed build, then deleted
		const created = t!.boat.state().calls.find((c) => c.op === "create")!;
		expect(created.detail).toMatchObject({ name: `factory-${run}-1`, noEnv: true, size: "default", ttlSeconds: 3600 });
		expect(t!.boat.state().calls.some((c) => c.op === "delete" && c.id === created.id)).toBe(true);
		expect(liveVms()).toEqual([]);
		expect(v.reviews[0]!.vm?.state).toBe("disposed");
		expect(t!.control.qaInputs[0]).toContain("product up");
		expect(t!.control.qaInputs[0]).toContain("run script is running");
		// the QA advisory finding is delivered with its screenshot id; the screenshot itself stays a run artifact
		expect(v.advisory.map((f) => [f.source, f.description, f.screenshots])).toEqual([["qa", "the font is small", ["r1-s1"]]]);
		const shot = await t!.factory.getScreenshot(run, "r1-s1");
		expect(shot.mime).toBe("image/png");
		expect(Buffer.from(shot.bytes).subarray(1, 4).toString()).toBe("PNG");
		await expect(t!.factory.getScreenshot(run, "../x")).rejects.toThrow(/invalid screenshot id/);
		await expect(t!.factory.getScreenshot(run, "r9-s9")).rejects.toThrow(/no screenshot/);
		const notes = (await git(t!.host.bare("me/p"), ["show", "main:docs/delivery-notes.md"])).stdout;
		expect(notes).toMatch(/QA status.*ran/);
		expect(notes).toContain("the font is small");
		expect(notes).toMatch(/run view/);
		const tree = (await git(t!.host.bare("me/p"), ["ls-tree", "-r", "--name-only", "main"])).stdout;
		expect(tree).not.toMatch(/\.png/);
		expect(v.notices.at(-1)).toMatchObject({ final: true, qaStatus: "ran" });
		// cost: the QA agent's tokens and the VM's machine time, as qa records of round 1
		const qaCost = v.cost.filter((c) => c.role === "qa");
		expect(qaCost.map((c) => c.round)).toEqual([1, 1]);
		expect(qaCost.some((c) => (c.vmSeconds ?? 0) > 0)).toBe(true);
		// the QA agent's fixed tool set
		const agent = await (await t!.factory.harnessForTests.conversation(v.conversations.qa[0]!.id as never, {} as never))!.agent({} as never);
		expect(agent.tools.map((x) => x.name).sort()).toEqual(["bash", "computer", "read", "submit_qa", "web_search"]);
		expect(agent.model).toEqual({ provider: "scripted", modelId: "qa" });
	});

	test("a QA fail fails the round: the same builder gets both sets with the screenshots as images; the next QA agent sees its prior findings", async () => {
		await setup();
		t!.control.qa = ["fail", "pass"];
		const run = await start();
		const v = await until(t!.factory, run, done);
		expect(v.state).toBe("DELIVERED");
		expect(states(v)).toEqual(["RECEIVED", "PREPARING", "DISCUSSING", "SPEC_READY", "BUILDING", "REVIEWING", "BUILDING", "REVIEWING", "DELIVERING", "AWAITING_CI", "DELIVERED"]);
		expect(v.reviewRound).toBe(2);
		expect(v.findingsLog.map((e) => [e.kind, e.reviewSeq])).toEqual([["review", 1], ["qa", 1], ["review", 2], ["qa", 2]]);
		const qaFinding = v.findingsLog[1]!.findings[0]!;
		expect(qaFinding).toMatchObject({ source: "qa", blocking: true, screenshots: ["r1-s1"] });
		const tr = await t!.factory.getConversation(run, v.conversations.builder!);
		const second = tr.items.filter((i) => i.role === "user")[1]!.text!;
		expect(second).toContain(`[${qaFinding.id}] (qa, BLOCKING, major)`);
		expect(second).toContain("screenshots: r1-s1");
		expect(second).toContain("Screenshot r1-s1 (QA):");
		// the second QA agent got its own prior finding and the builder's response; the reviewer did not
		expect(t!.control.qaInputs[1]).toContain("the hello screen is blank");
		expect(t!.control.qaInputs[1]).toContain("builder: fixed");
		expect(t!.control.reviewerInputs[1]).not.toContain("the hello screen is blank");
		// two rounds, two VMs, both deleted; one round counts once toward the cap
		expect(t!.boat.state().calls.filter((c) => c.op === "create")).toHaveLength(2);
		expect(liveVms()).toEqual([]);
		expect(v.reviews.map((r) => r.screenshots)).toEqual([["r1-s1"], ["r2-s1"]]);
	});

	test("submit_qa rejects a finding without a screenshot; the QA agent then submits a valid verdict", async () => {
		await setup();
		t!.control.qa = ["no-screenshot-then-pass"];
		const run = await start();
		const v = await until(t!.factory, run, done);
		expect(v.state).toBe("DELIVERED");
		const tr = await t!.factory.getConversation(run, v.conversations.qa[0]!.id);
		const results = tr.items.filter((i) => i.toolResult?.name === "submit_qa").map((i) => i.toolResult!);
		expect(results.map((r) => r.isError)).toEqual([true, false]);
		expect(results[0]!.text).toMatch(/cite at least one screenshot/);
	});
});

describe("QA status", () => {
	test("skipped: QA on but nothing to launch (no run script); the round is the review alone, no VM", async () => {
		await setup([], { runScript: false });
		const v = await until(t!.factory, await start(), done);
		expect(v.state).toBe("DELIVERED");
		expect(v.reviews[0]!.qaStatus).toBe("skipped");
		expect(v.conversations.qa).toEqual([]);
		expect(t!.boat.state().calls).toEqual([]);
	});

	test("off: qa.enabled false for the project; no VM, no QA Conversation, and no boat key needed", async () => {
		await setup([["qa.enabled", false], ["boat.apiKey", "env:SF_NO_SUCH_KEY"]]);
		const v = await until(t!.factory, await start(), done);
		expect(v.state).toBe("DELIVERED");
		expect(v.reviews[0]!.qaStatus).toBe("off");
		expect(t!.boat.state().calls).toEqual([]);
		expect(v.notices.at(-1)!.qaStatus).toBe("off");
	});

	test("unavailable: boat cannot provide a VM after retries; the run neither fails nor escalates and says so", async () => {
		await setup();
		const { writeFileSync } = await import("node:fs");
		writeFileSync(join(t!.dir, "boat", "fail-create"), "");
		const v = await until(t!.factory, await start(), done);
		expect(v.state).toBe("DELIVERED");
		expect(v.reviews[0]!.qaStatus).toBe("unavailable");
		expect(v.notices.some((n) => /AQ testing unavailable/.test(n.text))).toBe(true);
		const notes = (await git(t!.host.bare("me/p"), ["show", "main:docs/delivery-notes.md"])).stdout;
		expect(notes).toMatch(/QA status.*unavailable/);
	});

	test("QA on and the boat key does not resolve: the run fails at PREPARING, naming both fixes", async () => {
		await setup([["boat.apiKey", "env:SF_NO_SUCH_KEY"]]);
		const v = await until(t!.factory, await start(), done);
		expect(v.state).toBe("FAILED");
		expect(v.failure?.state).toBe("PREPARING");
		expect(v.failure?.reason).toMatch(/SF_NO_SUCH_KEY/);
		expect(v.failure?.reason).toMatch(/qa\.enabled: false/);
		expect(v.workspace).toBeUndefined();
	});
});

describe("VM lifecycle", () => {
	test("cancel while the QA agent works deletes its VM", async () => {
		await setup();
		t!.control.qaHang = true;
		const run = await start();
		await until(t!.factory, run, (v) => v.reviews[0]?.submitted.review === true && t!.control.qaInputs.length === 1);
		expect(liveVms()).toHaveLength(1);
		await t!.factory.cancelRun(run, "test");
		await until(t!.factory, run, inState("CANCELLED"));
		t!.control.qaHang = false;
		for (let i = 0; i < 50 && liveVms().length; i++) await new Promise((r) => setTimeout(r, 50));
		expect(liveVms()).toEqual([]);
	});

	test("startup sweep: VMs named for a run that is not in REVIEWING for that round are deleted", async () => {
		await setup();
		const run = await start();
		await until(t!.factory, run, done);
		// an orphan of a crash: a VM named for that run's round 1, left behind
		await t!.boat.create({ name: `factory-${run}-1`, idempotencyKey: "orphan", size: "default", ttlSeconds: 60 });
		await t!.boat.create({ name: "someone-else", idempotencyKey: "other", size: "default", ttlSeconds: 60 });
		expect(await t!.factory.sweepForTests()).toEqual([`factory-${run}-1`]);
		expect((await t!.boat.list()).map((x) => x.name)).toEqual(["someone-else"]);
	});

	test("a VM the ttl stopped while the QA agent works is resumed and the product restarted on its next tool call", async () => {
		await setup();
		t!.control.qaHang = true;
		const run = await start();
		await until(t!.factory, run, () => t!.control.qaInputs.length === 1);
		// give the screenshot call time to finish, then stop the VM and let the agent go on with a bash call
		await new Promise((r) => setTimeout(r, 300));
		const id = liveVms()[0]!;
		t!.boat.stop(id);
		const { env } = { env: (t!.factory as any).opts.boat.env({ envId: `${run}-qa-1` }) };
		let out = "";
		const r = await env.exec("echo still-here", { onOutput: (s: string) => (out += s) }, {} as never);
		expect(r.ok).toBe(true);
		expect(out).toMatch(/stopped \(boat\.ttl\) and was resumed/);
		expect(out).toContain("still-here");
		expect(t!.boat.state().calls.some((c) => c.op === "resume" && c.id === id)).toBe(true);
		t!.control.qaHang = false;
		expect((await until(t!.factory, run, done)).state).toBe("DELIVERED");
	});
});

test("screenshots live under the artifacts dir, outside the worktree", async () => {
	await setup();
	const run = await start();
	const v = await until(t!.factory, run, done);
	expect(existsSync(join(t!.dir, "state", "artifacts", run, "screenshots", "r1-s1.png"))).toBe(true);
	expect(existsSync(join(v.workspace!.path, "r1-s1.png"))).toBe(false);
});
