// Bulk cancel (docs/specs/run-mv545v95-rg77.md): `cancelRuns` checks the whole call (invalid, not_found, conflict for
// a terminal run or a member of an active or failed bundle) before it changes anything, sets every cancelReason in one
// commit, then aborts each run's task; each run reaches CANCELLED through the run task's own cancellation path.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { FactoryEvent } from "../src/core/types.ts";
import { Sandbox } from "../src/sandbox/sandbox.ts";
import { bundleIn, inState, makeFactory, type TestEnv, until, untilBundle } from "./helpers.ts";

let t: TestEnv | undefined;
afterEach(async () => {
	vi.restoreAllMocks();
	await t?.factory.close().catch(() => {});
	t = undefined;
});

const SEED = { "README.md": "# p\n", "AGENTS.md": "Test: true\n" };
const start = (title = "hello") => t!.factory.startRun("p", { source: "test", title, body: `make ${title}` });
const done = inState("DELIVERED", "FAILED", "CANCELLED");

describe("cancelRuns", () => {
	test("validation: invalid, not_found, conflict for a terminal run; nothing changes", async () => {
		t = await makeFactory();
		await t.factory.createProject("p", "me/p");
		await t.factory.setSetting({ project: "p" }, "policy.approvals", ["spec"]);
		const live = await start();
		await until(t.factory, live, inState("AWAITING_APPROVAL"));
		const gone = await start();
		await until(t.factory, gone, inState("AWAITING_APPROVAL"));
		await t.factory.cancelRun(gone);
		await until(t.factory, gone, inState("CANCELLED"));
		const f = t.factory;
		for (const bad of [[], undefined, "x", 5, [5], [""], [live, null]])
			await expect(f.cancelRuns(bad as never)).rejects.toMatchObject({ code: "invalid" });
		await expect(f.cancelRuns([live, "run-nope"])).rejects.toMatchObject({ code: "not_found" });
		const err = await f.cancelRuns([live, gone]).catch((e) => e);
		expect(err).toMatchObject({ code: "conflict" });
		expect(err.message).toContain(gone);
		expect(err.message).toContain("CANCELLED");
		await new Promise((r) => setTimeout(r, 200));
		const v = await f.getRun(live);
		expect(v.state).toBe("AWAITING_APPROVAL");
		expect(v.failure).toBeUndefined();
		// still cancellable afterwards: the refused calls left no cancelReason behind
		expect(await f.cancelRuns([live, live], "bulk")).toEqual({ cancelled: [live] });
		expect((await until(f, live, done)).failure).toMatchObject({ state: "AWAITING_APPROVAL", reason: "bulk" });
	});

	test("a member of an active bundle → conflict naming the bundle; no other run in the call is cancelled", async () => {
		t = await makeFactory();
		await t.host.seedRepo("me/p", SEED);
		await t.factory.createProject("p", "me/p");
		const a = await start("alpha");
		expect((await until(t.factory, a, inState("READY"))).state).toBe("READY");
		await t.factory.setSetting({ project: "p" }, "policy.approvals", ["spec"]);
		const live = await start("beta");
		await until(t.factory, live, inState("AWAITING_APPROVAL"));
		const id = await t.factory.createBundle("p", [a]);
		const err = await t.factory.cancelRuns([live, a]).catch((e) => e);
		expect(err).toMatchObject({ code: "conflict" });
		expect(err.message).toContain(a);
		expect(err.message).toContain(id);
		await new Promise((r) => setTimeout(r, 200));
		expect((await t.factory.getRun(live)).state).toBe("AWAITING_APPROVAL");
		expect((await t.factory.getRun(a)).bundle).toBe(id);
	});

	test("a member of a FAILED bundle → conflict", async () => {
		t = await makeFactory();
		t.control.sharedFile = true;
		await t.host.seedRepo("me/p", SEED);
		await t.factory.createProject("p", "me/p");
		const a = await start("alpha");
		const b = await start("beta");
		await Promise.all([until(t.factory, a, inState("READY")), until(t.factory, b, inState("READY"))]);
		t.control.integratorPlan = ["leave", "leave", "leave"];
		const id = await t.factory.createBundle("p", [a, b]);
		expect((await untilBundle(t.factory, id, bundleIn("FAILED", "AWAITING_MERGE"))).state).toBe("FAILED");
		const err = await t.factory.cancelRuns([a]).catch((e) => e);
		expect(err).toMatchObject({ code: "conflict" });
		expect(err.message).toContain(id);
		expect((await t.factory.getRun(a)).state).toBe("READY");
	});

	test("DISCUSSING and BUILDING runs end CANCELLED with their environments disposed; result, attribution and events", async () => {
		const dir = mkdtempSync(join(tmpdir(), "sf-cancel-runs-"));
		t = await makeFactory({ storage: "sqlite", dir });
		await t.factory.createProject("p", "me/p");
		const dispose = vi.spyOn(Sandbox.prototype, "dispose");
		t.control.askFirst = true;
		const discussing = await start("one");
		await until(t.factory, discussing, (x) => x.state === "DISCUSSING" && !!x.pendingAsk);
		t.control.askFirst = false;
		t.control.builderHang = true;
		const building = await start("two");
		await until(t.factory, building, inState("BUILDING"));
		await new Promise((r) => setTimeout(r, 300));
		const events: FactoryEvent[] = [];
		const off = t.factory.subscribe({ project: "p" }, (e) => events.push(e));
		// the scripted provider cannot observe the abort signal; release it shortly after the abort is marked
		const cancelling = t.factory.as("web").cancelRuns([discussing, building]);
		setTimeout(() => (t!.control.builderHang = false), 300);
		expect(await cancelling).toEqual({ cancelled: [discussing, building] });
		const vd = await until(t.factory, discussing, done);
		const vb = await until(t.factory, building, done);
		await new Promise((r) => setTimeout(r, 200));
		off();
		expect(vd.state).toBe("CANCELLED");
		expect(vd.failure).toMatchObject({ state: "DISCUSSING", reason: "cancelled by web" });
		expect(vb.state).toBe("CANCELLED");
		expect(vb.failure).toMatchObject({ state: "BUILDING", reason: "cancelled by web" });
		for (const run of [discussing, building]) {
			expect(dispose.mock.calls.some((c) => String(c[0]).startsWith(`${run}-`)), run).toBe(true);
			expect(events.some((e) => e.type === "run.state" && e.run === run && e.to === "CANCELLED"), run).toBe(true);
		}
		// durable across a restart
		await t.factory.close();
		await t.reopen();
		expect((await t.factory.getRun(discussing)).state).toBe("CANCELLED");
		expect((await t.factory.getRun(building)).state).toBe("CANCELLED");
	});
});
