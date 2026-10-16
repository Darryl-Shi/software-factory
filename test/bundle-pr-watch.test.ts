// PRs merged or closed outside the factory (docs/specs/run-mv99uglw-4rys.md §1): the PR watcher notices them in every
// bundle state with a PR (ESCALATED, FIXING mid-turn, FAILED, ...), the externalEnd marker survives a crash, and
// checkBundlePr asks GitHub at once.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { BundleView } from "../src/core/types.ts";
import { GitHub } from "../src/github/github.ts";
import { bundleIn, inState, makeFactory, type TestEnv, until, untilBundle } from "./helpers.ts";

let t: TestEnv | undefined;
afterEach(async () => {
	vi.restoreAllMocks();
	await t?.factory.close().catch(() => {});
	t = undefined;
});

const SEED = { "README.md": "# p\n", "AGENTS.md": "Test: true\n" };
const RED = [{ name: "test", status: "completed", conclusion: "failure", summary: "boom" }] as never;
const start = (title: string) => t!.factory.startRun("p", { source: "test", title, body: `make ${title}` });

async function twoReady(opts: { sqlite?: boolean } = {}) {
	t = opts.sqlite ? await makeFactory({ storage: "sqlite", dir: mkdtempSync(join(tmpdir(), "sf-prwatch-")) }) : await makeFactory();
	await t.host.seedRepo("me/p", SEED);
	await t.factory.createProject("p", "me/p");
	await t.factory.setSetting({ project: "p" }, "ci.fixRounds", 1);
	const a = await start("alpha");
	const b = await start("beta");
	await Promise.all([until(t.factory, a, inState("READY")), until(t.factory, b, inState("READY"))]);
	return { a, b };
}

/** A two-ticket bundle brought to `state` with its PR open. */
async function bundleIn_(state: "ESCALATED" | "FIXING" | "FAILED", opts: { sqlite?: boolean } = {}) {
	const { a, b } = await twoReady(opts);
	const f = t!.factory;
	if (state === "ESCALATED") t!.host.forceChecks("me/p", RED, RED);
	if (state === "FIXING") {
		t!.host.forceChecks("me/p", RED);
		t!.control.integratorHang = true;
	}
	if (state === "FAILED") vi.spyOn(GitHub.prototype, "defaultHead").mockRejectedValueOnce(new Error("GitHub is down"));
	const id = await f.createBundle("p", [a, b]);
	let v: BundleView;
	if (state === "FAILED") {
		v = await untilBundle(f, id, (x) => (x.state === "AWAITING_MERGE" && !!x.pendingAsk) || bundleIn("MERGED", "FAILED", "CANCELLED", "ESCALATED")(x));
		expect(v.state).toBe("AWAITING_MERGE");
		await f.mergeBundle(id);
		v = await untilBundle(f, id, bundleIn("FAILED", "MERGED", "CANCELLED"));
	} else if (state === "FIXING") {
		v = await untilBundle(f, id, bundleIn("FIXING", "ESCALATED", "MERGED", "FAILED", "CANCELLED"));
		const deadline = Date.now() + 10_000;
		while (t!.control.integratorInputs.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
		expect(t!.control.integratorInputs.length).toBe(1);
	} else v = await untilBundle(f, id, bundleIn("ESCALATED", "AWAITING_MERGE", "MERGED", "FAILED", "CANCELLED"));
	expect(v.state).toBe(state);
	expect(v.delivery?.pr).toBeDefined();
	return { a, b, id, v, pr: v.delivery!.pr!.number };
}

const closeCalls = () => t!.host.state().calls.filter((c) => c.op === "closePr").length;

describe("the PR watcher", () => {
	for (const state of ["ESCALATED", "FIXING", "FAILED"] as const) {
		test(`a PR merged on GitHub while ${state} ends the bundle MERGED: members DELIVERED with the PR, the PR not closed, cleanup done`, async () => {
			const { a, b, id, v, pr } = await bundleIn_(state);
			const f = t!.factory;
			await t!.host.mergePr("me/p", pr, "merge");
			const closesBefore = closeCalls();
			if (state === "FIXING") setTimeout(() => (t!.control.integratorHang = false), 500);
			const end = await untilBundle(f, id, bundleIn("MERGED", "CANCELLED"), 20_000);
			expect(end.state).toBe("MERGED");
			expect(end.pendingAsk).toBeUndefined();
			expect(end.notices.some((n) => n.text === `The PR was merged on GitHub (while ${state})`)).toBe(true);
			for (const run of [a, b]) {
				const r = await until(f, run, inState("DELIVERED", "CANCELLED", "FAILED"));
				expect(r.state).toBe("DELIVERED");
				expect(r.bundle).toBe(id);
				expect(r.artifacts.delivery?.url).toBe(v.delivery!.url);
			}
			expect(t!.host.state().prs.find((p) => p.number === pr)!.state).toBe("merged");
			expect(closeCalls()).toBe(closesBefore);
			await f.cleanupsSettledForTests();
			await new Promise((r) => setTimeout(r, 300));
			expect((await f.bundleDocument(id)).cleanedUp).toBeDefined();
			if (state === "FIXING") expect(t!.control.integratorInputs.length).toBe(1); // the integrator got no further task
		});

		test(`a PR closed on GitHub while ${state} cancels the bundle; its tickets are back in Ready`, async () => {
			const { a, b, id, pr } = await bundleIn_(state);
			const f = t!.factory;
			await t!.host.closePr("me/p", pr);
			if (state === "FIXING") setTimeout(() => (t!.control.integratorHang = false), 500);
			const end = await untilBundle(f, id, bundleIn("MERGED", "CANCELLED"), 20_000);
			expect(end.state).toBe("CANCELLED");
			expect(end.failure?.reason).toBe("the PR was closed without merging");
			for (const run of [a, b]) {
				const r = await until(f, run, (x) => x.bundle === undefined);
				expect(r.state).toBe("READY");
			}
		});
	}

	test("a failed PR lookup is logged and tried again; it never fails the bundle", async () => {
		const { id, pr } = await bundleIn_("ESCALATED");
		const spy = vi.spyOn(GitHub.prototype, "prState").mockRejectedValueOnce(new Error("rate limited"));
		await new Promise((r) => setTimeout(r, 300));
		expect(spy).toHaveBeenCalled();
		expect((await t!.factory.getBundle(id)).state).toBe("ESCALATED");
		await t!.host.mergePr("me/p", pr, "merge");
		expect((await untilBundle(t!.factory, id, bundleIn("MERGED", "CANCELLED", "FAILED"))).state).toBe("MERGED");
	});

	test("kill -9 after the marker commit: the resumed bundle finishes MERGED", async () => {
		const { a, b, id, pr } = await bundleIn_("ESCALATED", { sqlite: true });
		const f = t!.factory;
		f.haltPrWatchAfterMarkerForTests = true;
		await t!.host.mergePr("me/p", pr, "merge");
		const deadline = Date.now() + 10_000;
		while (!(await f.bundleDocument(id)).externalEnd && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
		expect((await f.bundleDocument(id)).externalEnd).toMatchObject({ how: "merged", from: "ESCALATED" });
		await new Promise((r) => setTimeout(r, 200));
		expect((await f.getBundle(id)).state).toBe("ESCALATED"); // nothing after the commit happened
		const closes = closeCalls();
		await f.close();
		await t!.reopen();
		const end = await untilBundle(t!.factory, id, bundleIn("MERGED", "CANCELLED"));
		expect(end.state).toBe("MERGED");
		expect((await until(t!.factory, a, inState("DELIVERED"))).state).toBe("DELIVERED");
		expect((await until(t!.factory, b, inState("DELIVERED"))).state).toBe("DELIVERED");
		expect(closeCalls()).toBe(closes);
	});
});

describe("checkBundlePr", () => {
	test("open changes nothing; merged acts at once; conflict once MERGED; not_found", async () => {
		const { id, pr } = await bundleIn_("ESCALATED");
		const f = t!.factory;
		expect(await f.checkBundlePr(id)).toEqual({ pr: "open", state: "ESCALATED" });
		expect((await f.getBundle(id)).state).toBe("ESCALATED");
		// GitHub reports merged now, before the watcher's next tick
		await t!.host.mergePr("me/p", pr, "merge");
		const r = await f.checkBundlePr(id);
		expect(r.pr).toBe("merged");
		expect(["ESCALATED", "MERGED"]).toContain(r.state);
		expect((await untilBundle(f, id, bundleIn("MERGED", "CANCELLED"))).state).toBe("MERGED");
		await expect(f.checkBundlePr(id)).rejects.toMatchObject({ code: "conflict" });
		await expect(f.checkBundlePr("bundle-99")).rejects.toMatchObject({ code: "not_found" });
	});

	test("closed on a FAILED bundle: CANCELLED in the same call, tickets back in Ready", async () => {
		const { a, id, pr } = await bundleIn_("FAILED");
		const f = t!.factory;
		f.haltPrWatchAfterMarkerForTests = true; // irrelevant to FAILED (no marker): the call ends it itself
		vi.spyOn(GitHub.prototype, "prState").mockResolvedValueOnce("open");
		expect(await f.checkBundlePr(id)).toEqual({ pr: "open", state: "FAILED" });
		await t!.host.closePr("me/p", pr);
		expect(await f.checkBundlePr(id)).toEqual({ pr: "closed", state: "CANCELLED" });
		expect((await until(f, a, (x) => x.bundle === undefined)).state).toBe("READY");
	});

	test("conflict for a bundle with no PR (a new repo pushed to main)", async () => {
		t = await makeFactory();
		await t.factory.createProject("p", "me/p");
		const a = await start("alpha");
		await until(t.factory, a, inState("READY"));
		const id = await t.factory.createBundle("p", [a]);
		const v = await untilBundle(t.factory, id, bundleIn("MERGED", "FAILED", "CANCELLED"));
		expect(v.delivery?.kind).toBe("repo");
		await expect(t.factory.checkBundlePr(id)).rejects.toMatchObject({ code: "conflict" });
	});
});
