// Bulk cancel (docs/specs/run-mv545v95-rg77.md): `cancelRuns` checks the whole call (invalid, not_found, conflict for
// a terminal run or a member of an active or failed bundle) before it changes anything, sets every cancelReason in one
// commit, then aborts each run's task; each run reaches CANCELLED through the run task's own cancellation path.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { FactoryEvent } from "../src/core/types.ts";
import { GitHub } from "../src/github/github.ts";
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

	test("a subset of an active bundle's members → conflict naming the bundle and the missing ticket; nothing changes", async () => {
		t = await makeFactory();
		await t.host.seedRepo("me/p", SEED);
		await t.factory.createProject("p", "me/p");
		const a = await start("alpha");
		const b = await start("beta");
		await Promise.all([until(t.factory, a, inState("READY")), until(t.factory, b, inState("READY"))]);
		await t.factory.setSetting({ project: "p" }, "policy.approvals", ["spec"]);
		const live = await start("gamma");
		await until(t.factory, live, inState("AWAITING_APPROVAL"));
		const id = await t.factory.createBundle("p", [a, b]);
		const err = await t.factory.cancelRuns([live, a]).catch((e) => e);
		expect(err).toMatchObject({ code: "conflict" });
		expect(err.message).toContain(id);
		expect(err.message).toContain(b);
		expect(err.message).toContain("P-2");
		await new Promise((r) => setTimeout(r, 200));
		expect((await t.factory.getRun(live)).state).toBe("AWAITING_APPROVAL");
		expect((await t.factory.getRun(a)).bundle).toBe(id);
		expect((await t.factory.getRun(a)).failure).toBeUndefined();
		expect((await t.factory.bundleDocument(id)).cancelReason).toBeUndefined();
		expect(["MERGED", "CANCELLED"]).not.toContain((await t.factory.getBundle(id)).state);
	});

	test("a subset of a FAILED bundle's members → conflict", async () => {
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
		expect(err.message).toContain(b);
		expect((await t.factory.getRun(a)).state).toBe("READY");
		expect((await t.factory.getBundle(id)).state).toBe("FAILED");
	});

	test("every member of a live bundle with an ordinary run: the bundle CANCELLED with its PR closed, every run CANCELLED", async () => {
		t = await makeFactory();
		await t.host.seedRepo("me/p", SEED);
		await t.factory.createProject("p", "me/p");
		const f = t.factory;
		const a = await start("alpha");
		const b = await start("beta");
		await Promise.all([until(f, a, inState("READY")), until(f, b, inState("READY"))]);
		await f.setSetting({ project: "p" }, "policy.approvals", ["spec"]);
		const live = await start("gamma");
		await until(f, live, inState("AWAITING_APPROVAL"));
		const id = await f.createBundle("p", [a, b]);
		const v = await untilBundle(f, id, (x) => (x.state === "AWAITING_MERGE" && !!x.pendingAsk) || bundleIn("MERGED", "FAILED", "CANCELLED", "ESCALATED")(x));
		expect(v.state).toBe("AWAITING_MERGE");
		const out = await f.as("web").cancelRuns([live, a, b]);
		expect(out.cancelled.sort()).toEqual([live, a, b].sort());
		const end = await untilBundle(f, id, bundleIn("CANCELLED", "MERGED", "FAILED"));
		expect(end.state).toBe("CANCELLED");
		expect(end.failure?.reason).toBe("cancelled by web");
		expect(t.host.state().prs.find((p) => p.number === v.delivery!.pr!.number)!.state).toBe("closed");
		for (const run of [live, a, b]) {
			const r = await until(f, run, done);
			expect(r.state, run).toBe("CANCELLED");
			expect(r.failure?.reason, run).toBe("cancelled by web");
		}
	});

	test("every member of a FAILED bundle (with a PR): the bundle CANCELLED, its PR closed, the members CANCELLED", async () => {
		t = await makeFactory();
		await t.host.seedRepo("me/p", SEED);
		await t.factory.createProject("p", "me/p");
		const f = t.factory;
		const a = await start("alpha");
		const b = await start("beta");
		await Promise.all([until(f, a, inState("READY")), until(f, b, inState("READY"))]);
		vi.spyOn(GitHub.prototype, "defaultHead").mockRejectedValueOnce(new Error("GitHub is down"));
		const id = await f.createBundle("p", [a, b]);
		const v = await untilBundle(f, id, (x) => (x.state === "AWAITING_MERGE" && !!x.pendingAsk) || bundleIn("MERGED", "FAILED", "CANCELLED", "ESCALATED")(x));
		await f.mergeBundle(id);
		expect((await untilBundle(f, id, bundleIn("FAILED", "MERGED", "CANCELLED"))).state).toBe("FAILED");
		expect(await f.cancelRuns([b, a], "bulk")).toEqual({ cancelled: [b, a] });
		expect((await f.getBundle(id)).state).toBe("CANCELLED");
		expect(t.host.state().prs.find((p) => p.number === v.delivery!.pr!.number)!.state).toBe("closed");
		for (const run of [a, b]) {
			const r = await until(f, run, done);
			expect(r.state).toBe("CANCELLED");
			expect(r.failure?.reason).toBe("bulk");
		}
	});

	test("kill -9 right after the intent commit: on restart the bundle and every listed run end CANCELLED", async () => {
		const dir = mkdtempSync(join(tmpdir(), "sf-cancel-runs-"));
		t = await makeFactory({ storage: "sqlite", dir });
		await t.host.seedRepo("me/p", SEED);
		await t.factory.createProject("p", "me/p");
		const a = await start("alpha");
		const b = await start("beta");
		await Promise.all([until(t.factory, a, inState("READY")), until(t.factory, b, inState("READY"))]);
		await t.factory.setSetting({ project: "p" }, "policy.approvals", ["spec"]);
		const live = await start("gamma");
		await until(t.factory, live, inState("AWAITING_APPROVAL"));
		const id = await t.factory.createBundle("p", [a, b]);
		const v = await untilBundle(t.factory, id, (x) => (x.state === "AWAITING_MERGE" && !!x.pendingAsk) || bundleIn("MERGED", "FAILED", "CANCELLED", "ESCALATED")(x));
		expect(v.state).toBe("AWAITING_MERGE");
		t.factory.haltCancelRunsAfterCommitForTests = true;
		await t.factory.cancelRuns([live, a, b]);
		await new Promise((r) => setTimeout(r, 200));
		expect((await t.factory.getBundle(id)).state).toBe("AWAITING_MERGE"); // nothing after the commit happened
		expect((await t.factory.getRun(live)).state).toBe("AWAITING_APPROVAL");
		await t.factory.close();
		await t.reopen();
		const f = t.factory;
		expect((await untilBundle(f, id, bundleIn("CANCELLED", "MERGED", "FAILED"))).state).toBe("CANCELLED");
		expect(t.host.state().prs.find((p) => p.number === v.delivery!.pr!.number)!.state).toBe("closed");
		for (const run of [live, a, b]) expect((await until(f, run, done)).state, run).toBe("CANCELLED");
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
