// Clearing Done runs from the board (docs/spec.md): `clearRuns` archives terminal runs (a flag on the RunDoc),
// all or nothing; listRuns hides them unless `includeCleared`; retryRun refuses them; a `run.cleared` event; durable.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { FactoryEvent } from "../src/core/types.ts";
import { inState, makeFactory, type TestEnv, until } from "./helpers.ts";

let t: TestEnv | undefined;
afterEach(async () => {
	await t?.factory.close().catch(() => {});
	t = undefined;
});

const start = (project = "p", title = "hello") => t!.factory.startRun(project, { source: "test", title, body: "make hello" });

/** A DELIVERED run and a CANCELLED run (cancelled at its spec gate), plus a live run waiting at its spec gate. */
async function setup(opts: { storage?: "memory" | "sqlite"; dir?: string } = {}) {
	t = await makeFactory(opts);
	await t.factory.createProject("p", "me/p");
	const delivered = await start();
	await until(t.factory, delivered, inState("DELIVERED"));
	await t.factory.setSetting({ project: "p" }, "policy.approvals", ["spec"]);
	const cancelled = await start();
	await until(t.factory, cancelled, inState("AWAITING_APPROVAL"));
	await t.factory.cancelRun(cancelled);
	await until(t.factory, cancelled, inState("CANCELLED"));
	const live = await start();
	await until(t.factory, live, inState("AWAITING_APPROVAL"));
	return { delivered, cancelled, live };
}

describe("clearRuns", () => {
	test("validation: invalid, not_found, conflict; all or nothing", async () => {
		const { delivered, cancelled, live } = await setup();
		const f = t!.factory;
		for (const bad of [[], undefined, "x", 5, [5], [""]])
			await expect(f.clearRuns(bad as never)).rejects.toMatchObject({ code: "invalid" });
		await expect(f.clearRuns([delivered, "nope"])).rejects.toMatchObject({ code: "not_found" });
		const err = await f.clearRuns([delivered, cancelled, live]).catch((e) => e);
		expect(err).toMatchObject({ code: "conflict" });
		expect(err.message).toContain(live);
		expect(err.message).toContain("AWAITING_APPROVAL");
		// nothing was cleared by the refused calls
		for (const id of [delivered, cancelled, live]) expect((await f.getRun(id)).cleared).toBeUndefined();
		expect((await f.listRuns()).map((r) => r.id).sort()).toEqual([delivered, cancelled, live].sort());
	});

	test("clears terminal runs; idempotent; attributed to the calling interface", async () => {
		const { delivered, cancelled, live } = await setup();
		const web = t!.factory.as("web");
		expect(await web.clearRuns([delivered])).toEqual({ cleared: [delivered] });
		const v = await t!.factory.getRun(delivered);
		expect(v.cleared).toMatchObject({ by: "web" });
		expect(typeof v.cleared!.at).toBe("number");
		// already cleared: skipped, not an error, not listed
		expect(await t!.factory.clearRuns([delivered, cancelled, delivered])).toEqual({ cleared: [cancelled] });
		expect(await t!.factory.clearRuns([delivered])).toEqual({ cleared: [] });
		expect((await t!.factory.getRun(delivered)).cleared).toEqual(v.cleared);
		expect((await t!.factory.getRun(live)).cleared).toBeUndefined();
	});

	test("listRuns leaves cleared runs out unless includeCleared; getRun still returns them", async () => {
		const { delivered, cancelled, live } = await setup();
		const f = t!.factory;
		await f.clearRuns([delivered]);
		expect((await f.listRuns()).map((r) => r.id).sort()).toEqual([cancelled, live].sort());
		expect((await f.listRuns({ includeCleared: false })).map((r) => r.id).sort()).toEqual([cancelled, live].sort());
		const all = await f.listRuns({ includeCleared: true });
		expect(all.map((r) => r.id).sort()).toEqual([delivered, cancelled, live].sort());
		expect(all.find((r) => r.id === delivered)!.cleared).toBeDefined();
		expect(all.filter((r) => r.cleared)).toHaveLength(1);
		expect((await f.listRuns({ project: "p", states: ["DELIVERED"] })).map((r) => r.id)).toEqual([]);
		expect((await f.listRuns({ project: "p", states: ["DELIVERED"], includeCleared: true })).map((r) => r.id)).toEqual([delivered]);
		await expect(f.listRuns({ includeCleared: "yes" as never })).rejects.toMatchObject({ code: "invalid" });
		expect((await f.getRun(delivered)).state).toBe("DELIVERED");
	});

	test("retryRun refuses a cleared run; conversations stay readable", async () => {
		const { cancelled } = await setup();
		const f = t!.factory;
		await f.clearRuns([cancelled]);
		const err = await f.retryRun(cancelled).catch((e) => e);
		expect(err).toMatchObject({ code: "conflict" });
		expect(err.message).toMatch(/was cleared/);
		const v = await f.getRun(cancelled);
		expect(v.state).toBe("CANCELLED");
		expect((await f.getConversation(cancelled, v.conversations.architect!)).items.length).toBeGreaterThan(0);
	});

	test("emits run.cleared once per newly cleared run, to project and run subscriptions", async () => {
		const { delivered, cancelled } = await setup();
		const f = t!.factory;
		await f.createProject("q", "me/q");
		const byProject: FactoryEvent[] = [];
		const byRun: FactoryEvent[] = [];
		const other: FactoryEvent[] = [];
		const all: FactoryEvent[] = [];
		const offs = [
			f.subscribe({ project: "p" }, (e) => byProject.push(e)),
			f.subscribe({ run: delivered }, (e) => byRun.push(e)),
			f.subscribe({ project: "q" }, (e) => other.push(e)),
			f.subscribe({}, (e) => all.push(e)),
		];
		await f.clearRuns([delivered, cancelled]);
		await f.clearRuns([delivered]);
		await new Promise((r) => setTimeout(r, 200));
		for (const off of offs) off();
		const cleared = (es: FactoryEvent[]) => es.filter((e) => e.type === "run.cleared");
		expect(cleared(byProject)).toEqual([
			{ type: "run.cleared", run: delivered, project: "p" },
			{ type: "run.cleared", run: cancelled, project: "p" },
		]);
		expect(cleared(byRun)).toEqual([{ type: "run.cleared", run: delivered, project: "p" }]);
		expect(cleared(other)).toEqual([]);
		expect(cleared(all)).toHaveLength(2);
	});

	test("the flag survives a restart", async () => {
		const dir = mkdtempSync(join(tmpdir(), "sf-clear-"));
		const { delivered, cancelled } = await setup({ storage: "sqlite", dir });
		await t!.factory.clearRuns([delivered]);
		const before = (await t!.factory.getRun(delivered)).cleared;
		await t!.factory.close();
		await t!.reopen();
		expect((await t!.factory.getRun(delivered)).cleared).toEqual(before);
		expect((await t!.factory.listRuns()).map((r) => r.id)).not.toContain(delivered);
		expect((await t!.factory.listRuns()).map((r) => r.id)).toContain(cancelled);
		expect(await t!.factory.clearRuns([delivered])).toEqual({ cleared: [] });
	});
});
