// Legacy runs (bundles spec §1.1): a run that had begun delivering the old way when the factory upgraded finishes the old way.
import { describe, expect, test } from "vitest";
import { isLegacyDelivery, type RunDocState } from "../src/core/run-doc.ts";
import { inState, makeFactory, until } from "./helpers.ts";

const doc = (over: Partial<RunDocState>): RunDocState =>
	({ id: "run-x", state: "BUILDING", artifacts: {}, ...over }) as unknown as RunDocState;

describe("isLegacyDelivery", () => {
	test("runs started before bundles that had begun delivering", () => {
		expect(isLegacyDelivery(doc({ state: "DELIVERING" }))).toBe(true);
		expect(isLegacyDelivery(doc({ state: "AWAITING_CI" }))).toBe(true);
		expect(isLegacyDelivery(doc({ state: "AWAITING_APPROVAL", gate: "merge" }))).toBe(true);
		expect(isLegacyDelivery(doc({ state: "ESCALATED", escalation: { from: "AWAITING_CI", reason: "", cap: "ciFix", findings: [] } }))).toBe(true);
		// a CI fix round in progress: the run has its own PR
		expect(isLegacyDelivery(doc({ state: "BUILDING", artifacts: { delivery: { kind: "pr", url: "u", ref: "r", sha: "s" } } }))).toBe(true);
	});
	test("runs that had not begun delivering take the new flow; new runs and finished runs are never legacy", () => {
		expect(isLegacyDelivery(doc({ state: "BUILDING" }))).toBe(false);
		expect(isLegacyDelivery(doc({ state: "REVIEWING" }))).toBe(false);
		expect(isLegacyDelivery(doc({ state: "AWAITING_APPROVAL", gate: "delivery" }))).toBe(false);
		expect(isLegacyDelivery(doc({ state: "ESCALATED", escalation: { from: "REVIEWING", reason: "", cap: "review", findings: [] } }))).toBe(false);
		expect(isLegacyDelivery(doc({ state: "DELIVERING", flowVersion: 2 }))).toBe(false);
		expect(isLegacyDelivery(doc({ state: "DELIVERED" }))).toBe(false);
	});
});


test("on upgrade, a run that had begun delivering is marked legacy and finishes with its own PR; a run still building takes the new flow", async () => {
	const t = await makeFactory({ storage: "sqlite" });
	try {
		await t.host.seedRepo("me/p", { "README.md": "# p\n" });
		await t.factory.createProject("p", "me/p");
		await t.factory.setSetting({ project: "p" }, "policy.approvals", ["delivery"]);
		const old = await t.factory.startRun("p", { source: "t", title: "old", body: "x" });
		const fresh = await t.factory.startRun("p", { source: "t", title: "fresh", body: "y" });
		await Promise.all([until(t.factory, old, inState("AWAITING_APPROVAL")), until(t.factory, fresh, inState("AWAITING_APPROVAL"))]);
		// as written by a factory before bundles: no flowVersion; `old` already had its own PR (a CI fix round was going on)
		await t.factory.patchRunForTests(old, (d) => {
			delete d.flowVersion;
			d.artifacts.delivery = { kind: "pr", url: "local://me/p/pull/0", ref: `factory/${old}`, sha: "0".repeat(40) };
		});
		await t.factory.patchRunForTests(fresh, (d) => {
			delete d.flowVersion;
		});
		await t.factory.close();
		const f = await t.reopen();
		expect((await f.runDocument(old)).legacy).toBe(true);
		expect((await f.runDocument(fresh)).legacy).toBeUndefined();
		expect((await f.runDocument(fresh)).flowVersion).toBe(2);
		await f.approve(old, "delivery");
		await f.approve(fresh, "delivery");
		const o = await until(f, old, inState("DELIVERED", "FAILED"));
		expect(o.state).toBe("DELIVERED");
		expect(o.history.map((h) => h.to).slice(-3)).toEqual(["DELIVERING", "AWAITING_CI", "DELIVERED"]);
		expect(o.artifacts.delivery?.kind).toBe("pr");
		expect(o.bundle).toBeUndefined();
		expect(o.notices.some((n) => /began delivering before bundles existed/.test(n.text))).toBe(true);
		const n = await until(f, fresh, inState("READY", "FAILED"));
		expect(n.state).toBe("READY");
		expect(t.host.state().prs.map((p) => p.head)).toEqual([`factory/${old}`]);
	} finally {
		await t.factory.close().catch(() => {});
	}
});
