// Crash/resume durability (spec §4, §8.3): kill -9 the process mid-build and at a pending approval; reopening the
// storage resumes the run from its last committed step, at the same round, with the same builder Conversation.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import type { RunView } from "../src/core/types.ts";
import { makeFactory, newControl, type TestEnv } from "./helpers.ts";

let t: TestEnv | undefined;
afterEach(async () => {
	await t?.factory.close().catch(() => {});
	t = undefined;
});

async function crashChild(dir: string, mode: string): Promise<{ run: string; before: RunView }> {
	const child = spawn(process.execPath, ["--import", "tsx", join(__dirname, "fixtures/crash-child.ts"), dir, mode], { stdio: "pipe", cwd: join(__dirname, "..") });
	let err = "";
	child.stderr.on("data", (d) => (err += d));
	const deadline = Date.now() + 30_000;
	while (!existsSync(join(dir, "ready"))) {
		if (Date.now() > deadline || child.exitCode !== null) throw new Error(`child did not get ready (exit ${child.exitCode}): ${err}`);
		await new Promise((r) => setTimeout(r, 50));
	}
	child.kill("SIGKILL");
	await new Promise((r) => child.once("exit", r));
	return { run: readFileSync(join(dir, "run-id"), "utf8"), before: JSON.parse(readFileSync(join(dir, "ready"), "utf8")) };
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
	const v = await t.factory.waitForState(run, (x) => ["DELIVERED", "FAILED"].includes(x.state));
	expect(v.state).toBe("DELIVERED");
	expect(v.reviewRound).toBe(2);
	expect(v.conversations.builder).toBe(before.conversations.builder);
	// nothing before the crash was redone: one discussion, one spec, two builds, two reviews
	expect(v.history.map((h) => h.to)).toEqual(["RECEIVED", "PREPARING", "DISCUSSING", "SPEC_READY", "BUILDING", "REVIEWING", "BUILDING", "REVIEWING", "DELIVERING", "AWAITING_CI", "DELIVERED"]);
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
	const v = await t.factory.waitForState(run, (x) => ["DELIVERED", "FAILED"].includes(x.state));
	expect(v.state).toBe("DELIVERED");
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
	expect((await t.factory.waitForState(run, (x) => x.state === "DELIVERED")).conversations.architect).toBe(v1.conversations.architect);
});
