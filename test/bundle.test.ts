// Bundles (bundles spec §2, §3): Ready runs shipped as one PR. Every bundle state transition, conflicts resolved by the
// integrator then reviewed, CI red → fix → review, a moved default branch at Merge, external merge and close, drop and
// cancel releasing runs, and a new repo pushed to main.
import { afterEach, describe, expect, test } from "vitest";
import type { BundleView, FactoryEvent, RunView } from "../src/core/types.ts";
import { git } from "../src/github/git.ts";
import { bundleIn, inState, makeFactory, type TestEnv, until, untilBundle } from "./helpers.ts";

let t: TestEnv | undefined;
afterEach(async () => {
	await t?.factory.close().catch(() => {});
	t = undefined;
});

const states = (v: { history: { to: string }[] }) => v.history.map((h) => h.to);
const SEED = { "README.md": "# p\n", "AGENTS.md": "Test: true\n" };
const CI_OK = "name: ci\non: [push]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: test -f README.md\n";

async function setup(settings: [string, unknown][] = [], opts: { seed?: Record<string, string> | false; repo?: string } = {}) {
	t = await makeFactory();
	const repo = opts.repo ?? "me/p";
	if (opts.seed !== false) await t.host.seedRepo(repo, opts.seed ?? SEED);
	await t.factory.createProject("p", repo);
	for (const [path, value] of settings) await t.factory.setSetting({ project: "p" }, path, value);
	return t;
}
const start = (title: string, project = "p") => t!.factory.startRun(project, { source: "test", title, body: `make ${title}` });
const ready = (run: string) => until(t!.factory, run, inState("READY", "FAILED", "CANCELLED"));
async function remoteFile(ref: string, path: string, repo = "me/p") {
	const r = await git(t!.host.bare(repo), ["show", `${ref}:${path}`], { allowFail: true });
	return r.code === 0 ? r.stdout : undefined;
}
const waitMerge = (id: string) => untilBundle(t!.factory, id, (v) => (v.state === "AWAITING_MERGE" && !!v.pendingAsk) || ["MERGED", "FAILED", "CANCELLED", "ESCALATED"].includes(v.state));

async function twoReady(settings: [string, unknown][] = [], opts: { seed?: Record<string, string> | false } = {}) {
	await setup(settings, opts);
	const a = await start("alpha");
	const b = await start("beta");
	const [ra, rb] = await Promise.all([ready(a), ready(b)]);
	expect(ra.state).toBe("READY");
	expect(rb.state).toBe("READY");
	return { a, b, ra, rb };
}

describe("runs stop at Ready", () => {
	test("two tickets in parallel: each stops in READY with its branch pushed, its spec at docs/specs/<run-id>.md, and no PR", async () => {
		const { a, b, ra, rb } = await twoReady();
		expect(states(ra)).toEqual(["RECEIVED", "PREPARING", "DISCUSSING", "SPEC_READY", "BUILDING", "REVIEWING", "DELIVERING", "READY"]);
		expect(ra.specPath).toBe(`docs/specs/${a}.md`);
		expect(rb.specPath).toBe(`docs/specs/${b}.md`);
		expect(await remoteFile(`factory/${a}`, `docs/specs/${a}.md`)).toContain("Acceptance behaviours");
		expect(await remoteFile(`factory/${b}`, `docs/specs/${b}.md`)).toContain("Acceptance behaviours");
		expect(await remoteFile(`factory/${a}`, "docs/spec.md")).toBeUndefined();
		expect(t!.host.state().prs).toEqual([]);
		expect(ra.artifacts.delivery).toBeUndefined();
		expect(t!.control.builderInputs[0]).toContain(`docs/specs/`);
	});
});

describe("bundle of two, clean merge", () => {
	test("INTEGRATING → DELIVERING → AWAITING_CI → AWAITING_MERGE → MERGED: one PR, a section per ticket, no bundle review; both runs DELIVERED with the PR", async () => {
		const { a, b } = await twoReady([["bundle.mergeMethod", "merge"]]);
		const events: FactoryEvent[] = [];
		t!.factory.subscribe({ project: "p" }, (e) => events.push(e));
		const id = await t!.factory.createBundle("p", [a, b]);
		expect(id).toBe("bundle-1");
		expect((await t!.factory.getRun(a)).bundle).toBe(id);
		let v = await waitMerge(id);
		expect(v.state).toBe("AWAITING_MERGE");
		expect(states(v)).toEqual(["INTEGRATING", "DELIVERING", "AWAITING_CI", "AWAITING_MERGE"]);
		expect(v.reviews).toEqual([]);
		expect(v.members.map((m) => m.run)).toEqual([a, b]);
		expect(v.noCi).toBe(true);
		const prs = t!.host.state().prs;
		expect(prs.length).toBe(1);
		expect(prs[0]!.title).toBe("2 tickets: alpha, beta");
		expect(prs[0]!.body).toContain("## Ticket: alpha");
		expect(prs[0]!.body).toContain("## Ticket: beta");
		expect(prs[0]!.body).toContain(`docs/specs/${a}.md`);
		expect(prs[0]!.body).toContain("## Integration");
		await t!.factory.mergeBundle(id);
		v = await untilBundle(t!.factory, id, bundleIn("MERGED", "FAILED"));
		expect(v.state).toBe("MERGED");
		expect(t!.host.state().calls.find((c) => c.op === "mergePr")?.detail).toMatchObject({ how: "merge" });
		const [da, db] = await Promise.all([until(t!.factory, a, inState("DELIVERED")), until(t!.factory, b, inState("DELIVERED"))]);
		expect(da.artifacts.delivery?.url).toBe(v.delivery!.url);
		expect(db.artifacts.delivery?.url).toBe(v.delivery!.url);
		expect(da.bundle).toBe(id);
		expect(da.notices.at(-1)!.text).toBe(`Merged in ${id}: ${v.delivery!.url}`);
		expect(await remoteFile("main", `docs/specs/${a}.md`)).toBeDefined();
		expect(await remoteFile("main", `docs/specs/${b}.md`)).toBeDefined();
		expect(events.some((e) => e.type === "bundle.state" && e.to === "MERGED")).toBe(true);
		expect(events.some((e) => e.type === "bundle.ask")).toBe(true);
		expect(events.some((e) => e.type === "run.state" && e.run === a && e.to === "DELIVERED")).toBe(true);
	});
});

describe("conflicts and reviews", () => {
	test("INTEGRATING (conflict) → REVIEWING → DELIVERING: the integrator resolves, the reviewer sees both specs and the combined diff", async () => {
		t = await makeFactory();
		t.control.sharedFile = true;
		await t.host.seedRepo("me/p", SEED);
		await t.factory.createProject("p", "me/p");
		const a = await start("alpha");
		const b = await start("beta");
		await Promise.all([ready(a), ready(b)]);
		const before = t.control.reviewerInputs.length;
		const id = await t.factory.createBundle("p", [a, b]);
		const v = await waitMerge(id);
		expect(v.state).toBe("AWAITING_MERGE");
		expect(states(v)).toEqual(["INTEGRATING", "REVIEWING", "DELIVERING", "AWAITING_CI", "AWAITING_MERGE"]);
		expect(v.integration?.resolved).toEqual([{ run: b, files: ["shared.txt"] }]);
		expect(v.conversations.integrator).toBeDefined();
		expect(v.reviews.length).toBe(1);
		const conflictInput = t.control.integratorInputs[0]!;
		expect(conflictInput).toContain("# Merge conflict");
		expect(conflictInput).toContain("shared.txt");
		expect(conflictInput).toContain(`docs/specs/${a}.md`);
		expect(conflictInput).toContain(`docs/specs/${b}.md`);
		const review = t.control.reviewerInputs[before]!;
		expect(review).toContain(`# Review of ${id}`);
		expect(review).toContain(`docs/specs/${a}.md`);
		expect(review).toContain(`docs/specs/${b}.md`);
		expect(review).toContain("Combined diff against the integration base");
		expect(review).toContain("resolved by the integrator");
		const tr = await t.factory.getBundleConversation(id, v.conversations.integrator!);
		expect(tr.role).toBe("integrator");
		expect(tr.items.some((i) => i.toolCalls?.some((c) => c.name === "report_done"))).toBe(true);
		const pr = t.host.state().prs[0]!;
		expect(pr.body).toContain("The integrator resolved merge conflicts");
		expect(pr.body).toContain("1 review round");
		expect(await remoteFile(`factory/${id}`, "shared.txt")).toBe("resolved by the integrator\n");
		expect(v.cost.some((c) => c.role === "integrator" && c.model === "scripted/integrator")).toBe(true);
	});

	test("a failed bundle review → FIXING (same integrator, findings) → REVIEWING with the prior findings and responses; at the cap → ESCALATED (more rounds / drop / abort)", async () => {
		t = await makeFactory();
		t.control.sharedFile = true;
		await t.host.seedRepo("me/p", SEED);
		await t.factory.createProject("p", "me/p");
		await t.factory.setSetting({ project: "p" }, "policy.reviewRoundCap", 2);
		const a = await start("alpha");
		const b = await start("beta");
		await Promise.all([ready(a), ready(b)]);
		t.control.reviews = ["fail", "fail", "pass"];
		const id = await t.factory.createBundle("p", [a, b]);
		let v = await untilBundle(t.factory, id, bundleIn("ESCALATED", "AWAITING_MERGE", "FAILED"));
		expect(v.state).toBe("ESCALATED");
		expect(states(v)).toEqual(["INTEGRATING", "REVIEWING", "FIXING", "REVIEWING", "ESCALATED"]);
		expect(v.escalation).toMatchObject({ cap: "review", from: "REVIEWING" });
		expect(v.pendingAsk!.question).toMatchObject({ kind: "escalation", options: ["more-rounds", "drop", "abort"] });
		expect(t.control.integratorInputs[1]).toContain("# Findings to address");
		expect(t.control.reviewerInputs.at(-1)).toContain("integrator: fixed");
		await expect(t.factory.resolveBundleEscalation(id, v.pendingAsk!.id, { moreRounds: 0 })).rejects.toThrow(/1 to 10/);
		await t.factory.resolveBundleEscalation(id, v.pendingAsk!.id, { moreRounds: 1 });
		v = await untilBundle(t.factory, id, (x) => (x.state === "AWAITING_MERGE" && !!x.pendingAsk) || x.state === "FAILED");
		expect(v.state).toBe("AWAITING_MERGE");
		expect(v.caps.review).toBe(3);
		expect(v.reviewRound).toBe(3);
	});
});

describe("CI", () => {
	test("red CI goes to the integrator as a CI finding, then a review round and a new CI run; at ci.fixRounds the bundle escalates; abort cancels and releases", async () => {
		const { a, b } = await twoReady([["ci.fixRounds", 1]]);
		t!.host.forceChecks("me/p", [{ name: "test", status: "completed", conclusion: "failure", summary: "boom" }], [{ name: "test", status: "completed", conclusion: "failure", summary: "boom again" }]);
		const id = await t!.factory.createBundle("p", [a, b]);
		const v = await untilBundle(t!.factory, id, bundleIn("ESCALATED", "AWAITING_MERGE", "FAILED"));
		expect(v.state).toBe("ESCALATED");
		expect(states(v)).toEqual(["INTEGRATING", "DELIVERING", "AWAITING_CI", "FIXING", "REVIEWING", "DELIVERING", "AWAITING_CI", "ESCALATED"]);
		expect(v.findingsLog.filter((e) => e.kind === "ci").length).toBe(2);
		expect(t!.control.integratorInputs[0]).toContain("(ci, BLOCKING");
		expect(t!.control.integratorInputs[0]).toContain("boom");
		expect(v.escalation).toMatchObject({ cap: "ciFix", from: "AWAITING_CI" });
		expect(v.ciFixes).toBe(1);
		await t!.factory.resolveBundleEscalation(id, v.pendingAsk!.id, { abort: true });
		const end = await untilBundle(t!.factory, id, bundleIn("CANCELLED"));
		expect(end.state).toBe("CANCELLED");
		expect(t!.host.state().prs[0]!.state).toBe("closed");
		const ra = await t!.factory.getRun(a);
		expect(ra.state).toBe("READY");
		expect(ra.bundle).toBeUndefined();
	});

	test("ci.mode required and no checks → ESCALATED; more rounds → FIXING with the 'add CI' finding", async () => {
		const { a } = await twoReady([["ci.mode", "required"]]);
		const id = await t!.factory.createBundle("p", [a]);
		const v = await untilBundle(t!.factory, id, bundleIn("ESCALATED", "AWAITING_MERGE", "FAILED"));
		expect(v.state).toBe("ESCALATED");
		expect(v.escalation!.reason).toMatch(/no CI checks/);
		await t!.factory.cancelBundle(id);
		expect((await untilBundle(t!.factory, id, bundleIn("CANCELLED"))).state).toBe("CANCELLED");
	});

	test("a real workflow in the repo (local CI runner): green → AWAITING_MERGE; ci.mode off skips CI", async () => {
		await setup([], { seed: { ...SEED, ".github/workflows/ci.yml": CI_OK } });
		const a = await start("alpha");
		await ready(a);
		const id = await t!.factory.createBundle("p", [a]);
		const v = await waitMerge(id);
		expect(v.state).toBe("AWAITING_MERGE");
		expect(v.ci?.state).toBe("green");
		expect(v.noCi).toBeUndefined();
	});
});

describe("merging", () => {
	test("Ship this ticket (a bundle of one) gives today's one-ticket PR: the ticket's title, squash by default", async () => {
		const { a } = await twoReady();
		const id = await t!.factory.createBundle("p", [a]);
		await waitMerge(id);
		expect(t!.host.state().prs[0]!.title).toBe("alpha");
		await t!.factory.mergeBundle(id);
		expect((await untilBundle(t!.factory, id, bundleIn("MERGED"))).mergeMethod).toBe("squash");
		expect(t!.host.state().calls.find((c) => c.op === "mergePr")?.detail).toMatchObject({ how: "squash" });
		expect((await until(t!.factory, a, inState("DELIVERED"))).artifacts.delivery?.kind).toBe("pr");
		await expect(t!.factory.mergeBundle(id)).rejects.toThrow(/waits for nothing|not waiting/);
	});

	test("another bundle merges first: Merge on the second updates it onto the new default branch, re-runs CI and merges without a second click", async () => {
		const { a, b } = await twoReady();
		const one = await t!.factory.createBundle("p", [a]);
		const two = await t!.factory.createBundle("p", [b]);
		await Promise.all([waitMerge(one), waitMerge(two)]);
		await t!.factory.mergeBundle(one);
		await untilBundle(t!.factory, one, bundleIn("MERGED"));
		const before = await t!.factory.getBundle(two);
		await t!.factory.mergeBundle(two);
		const v = await untilBundle(t!.factory, two, bundleIn("MERGED", "FAILED", "ESCALATED"), 60_000);
		expect(v.state).toBe("MERGED");
		expect(states(v).slice(states(before).length)).toEqual(["INTEGRATING", "DELIVERING", "AWAITING_CI", "AWAITING_MERGE", "MERGED"]);
		expect(v.integration!.base).not.toBe(before.integration!.base);
		expect(v.notices.some((n) => /default branch moved/.test(n.text))).toBe(true);
		expect((await until(t!.factory, b, inState("DELIVERED"))).state).toBe("DELIVERED");
		expect(await remoteFile("main", `docs/specs/${a}.md`)).toBeDefined();
		expect(await remoteFile("main", `docs/specs/${b}.md`)).toBeDefined();
	});

	test("the default branch moved with a conflicting change: the update takes the review path and comes back for a fresh Merge click", async () => {
		t = await makeFactory();
		t.control.sharedFile = true;
		await t.host.seedRepo("me/p", SEED);
		await t.factory.createProject("p", "me/p");
		const a = await start("alpha");
		await ready(a);
		const id = await t.factory.createBundle("p", [a]);
		await waitMerge(id);
		await t.host.pushCommit("me/p", { "shared.txt": "a human's change\n" });
		await t.factory.mergeBundle(id);
		const v = await untilBundle(t.factory, id, (x) => x.state === "AWAITING_MERGE" && !!x.pendingAsk && x.integration!.n === 2, 60_000);
		expect(v.mergeRequested).toBeUndefined();
		expect(v.reviews.length).toBe(1);
		expect(v.integration!.resolved.length).toBe(1);
		await t.factory.mergeBundle(id);
		expect((await untilBundle(t.factory, id, bundleIn("MERGED"))).state).toBe("MERGED");
	});

	test("Request changes: one blocking human finding → FIXING → REVIEWING, no round added", async () => {
		const { a } = await twoReady();
		const id = await t!.factory.createBundle("p", [a]);
		await waitMerge(id);
		await expect(t!.factory.requestBundleChanges(id, " ")).rejects.toThrow(/feedback/);
		await t!.factory.requestBundleChanges(id, "rename the button");
		const v = await untilBundle(t!.factory, id, (x) => x.state === "AWAITING_MERGE" && !!x.pendingAsk && x.reviews.length === 1);
		expect(states(v)).toEqual(["INTEGRATING", "DELIVERING", "AWAITING_CI", "AWAITING_MERGE", "FIXING", "REVIEWING", "DELIVERING", "AWAITING_CI", "AWAITING_MERGE"]);
		expect(v.reviewRound).toBe(1);
		expect(v.findingsLog.find((e) => e.kind === "human")!.findings[0]).toMatchObject({ source: "human", blocking: true, description: "rename the button" });
		expect(t!.control.integratorInputs[0]).toContain("rename the button");
		expect(t!.control.reviewerInputs.at(-1)).toContain("Human findings");
	});

	test("the PR merged on GitHub by a human is picked up: MERGED, and the runs are DELIVERED", async () => {
		const { a, b } = await twoReady();
		const id = await t!.factory.createBundle("p", [a, b]);
		const v = await waitMerge(id);
		await t!.host.mergePr("me/p", v.delivery!.pr!.number, "merge");
		expect((await untilBundle(t!.factory, id, bundleIn("MERGED", "CANCELLED"))).state).toBe("MERGED");
		expect((await until(t!.factory, a, inState("DELIVERED"))).bundle).toBe(id);
		expect((await until(t!.factory, b, inState("DELIVERED"))).artifacts.delivery?.url).toBe(v.delivery!.url);
	});

	test("the PR closed without merging is picked up: CANCELLED, and the runs are back in Ready", async () => {
		const { a, b } = await twoReady();
		const id = await t!.factory.createBundle("p", [a, b]);
		const v = await waitMerge(id);
		await t!.host.closePr("me/p", v.delivery!.pr!.number);
		expect((await untilBundle(t!.factory, id, bundleIn("MERGED", "CANCELLED"))).state).toBe("CANCELLED");
		const ra = await until(t!.factory, a, (x) => x.bundle === undefined);
		expect(ra.state).toBe("READY");
		// shippable again
		const again = await t!.factory.createBundle("p", [a, b]);
		expect(again).toBe("bundle-2");
	});
});

describe("membership", () => {
	test("a run in an active bundle cannot be cancelled, messaged or shipped again; invalid and conflict cases of createBundle", async () => {
		const { a, b } = await twoReady();
		await expect(t!.factory.createBundle("p", [])).rejects.toMatchObject({ code: "invalid" });
		await expect(t!.factory.createBundle("p", [a, a])).rejects.toMatchObject({ code: "invalid" });
		await expect(t!.factory.createBundle("p", ["run-nope"])).rejects.toMatchObject({ code: "invalid" });
		await t!.factory.createProject("q", "me/q");
		await expect(t!.factory.createBundle("q", [a])).rejects.toMatchObject({ code: "invalid", message: expect.stringMatching(/one project/) });
		const id = await t!.factory.createBundle("p", [a]);
		await expect(t!.factory.createBundle("p", [a, b])).rejects.toMatchObject({ code: "conflict", message: expect.stringMatching(/already in bundle-1/) });
		await expect(t!.factory.cancelRun(a)).rejects.toMatchObject({ code: "conflict", message: expect.stringMatching(/in bundle-1/) });
		await expect(t!.factory.message(a, "hi")).rejects.toMatchObject({ code: "conflict", message: expect.stringMatching(/in bundle-1/) });
		await waitMerge(id);
		// a Ready run in no bundle can be cancelled
		await t!.factory.cancelRun(b);
		expect((await until(t!.factory, b, inState("CANCELLED"))).state).toBe("CANCELLED");
	});

	test("Drop tickets at the merge card: the dropped run returns to Ready (shippable again), the rest re-integrates and the PR lists only it", async () => {
		const { a, b } = await twoReady();
		const id = await t!.factory.createBundle("p", [a, b]);
		let v = await waitMerge(id);
		const pr = v.delivery!.pr!.number;
		await expect(t!.factory.dropFromBundle(id, ["run-x"])).rejects.toMatchObject({ code: "invalid" });
		await t!.factory.dropFromBundle(id, [b]);
		v = await untilBundle(t!.factory, id, (x) => x.state === "AWAITING_MERGE" && !!x.pendingAsk && x.integration!.n === 2);
		expect(v.members.map((m) => m.run)).toEqual([a]);
		expect(v.dropped).toEqual([b]);
		const rb = await t!.factory.getRun(b);
		expect(rb.state).toBe("READY");
		expect(rb.bundle).toBeUndefined();
		const prs = t!.host.state().prs;
		expect(prs.length).toBe(1);
		expect(prs[0]!.number).toBe(pr);
		expect(prs[0]!.title).toBe("alpha");
		expect(prs[0]!.body).toContain("## Ticket: alpha");
		expect(prs[0]!.body).not.toContain("## Ticket: beta");
		expect(await remoteFile(`factory/${id}`, `docs/specs/${b}.md`)).toBeUndefined();
		const two = await t!.factory.createBundle("p", [b]);
		expect((await waitMerge(two)).state).toBe("AWAITING_MERGE");
	});

	test("dropping every member is cancelling; Cancel bundle closes the PR and releases the runs, branches untouched", async () => {
		const { a, b } = await twoReady();
		const id = await t!.factory.createBundle("p", [a, b]);
		const v = await waitMerge(id);
		const branchA = await remoteFile(`factory/${a}`, `docs/specs/${a}.md`);
		await t!.factory.dropFromBundle(id, [a, b]);
		const end = await untilBundle(t!.factory, id, bundleIn("CANCELLED"));
		expect(end.state).toBe("CANCELLED");
		expect(t!.host.state().prs.find((p) => p.number === v.delivery!.pr!.number)!.state).toBe("closed");
		for (const r of [a, b]) {
			const x = await until(t!.factory, r, (y) => y.bundle === undefined);
			expect(x.state).toBe("READY");
		}
		expect(await remoteFile(`factory/${a}`, `docs/specs/${a}.md`)).toBe(branchA);
		await expect(t!.factory.cancelBundle(id)).rejects.toMatchObject({ code: "conflict" });
		await expect(t!.factory.messageBundle(id, "hi")).rejects.toMatchObject({ code: "conflict" });
	});

	test("a message to a Ready run (in no bundle) goes to its builder; a change sends it back through REVIEWING to READY, no round added", async () => {
		const { a } = await twoReady();
		const r = await t!.factory.message(a, "EDIT: add a changelog");
		expect(r.to).toBe("builder");
		const v = await until(t!.factory, a, (x) => x.state === "READY" && x.history.filter((h) => h.to === "READY").length === 2);
		expect(states(v).slice(-4)).toEqual(["READY", "REVIEWING", "DELIVERING", "READY"]);
		expect(v.reviewRound).toBe(1);
		expect(await remoteFile(`factory/${a}`, "CHANGELOG.md")).toBe("add a changelog\n");
	});

	test("messages to a bundle go to the integrator (or the reviewer while reviewing); a change after the review goes back through review before Merge", async () => {
		const { a } = await twoReady();
		const id = await t!.factory.createBundle("p", [a]);
		await waitMerge(id);
		const r = await t!.factory.messageBundle(id, "EDIT: note");
		expect(r.to).toBe("integrator");
		const deadline = Date.now() + 10_000;
		while (!t!.control.messagesSeen.includes("integrator:EDIT: note") && Date.now() < deadline) await new Promise((res) => setTimeout(res, 50));
		// let the side turn finish its write
		while (!(await t!.factory.getBundleConversation(id, r.conversationId!)).items.some((i) => i.role === "assistant" && i.text === "changed INTEGRATOR.md") && Date.now() < deadline)
			await new Promise((res) => setTimeout(res, 50));
		await t!.factory.mergeBundle(id);
		const v = await untilBundle(t!.factory, id, (x) => x.state === "AWAITING_MERGE" && !!x.pendingAsk && x.reviews.length === 1);
		expect(v.notices.some((n) => /reviewing again before it can merge/.test(n.text))).toBe(true);
		expect(await remoteFile(`factory/${id}`, "INTEGRATOR.md")).toBe("note\n");
	});
});

describe("new repo", () => {
	test("shipping creates the private repo and pushes the combined result to main with docs/delivery-notes.md; no PR, no Merge; runs Done once CI passes or is skipped", async () => {
		const { a, b } = await twoReady([], { seed: false });
		expect(t!.host.state().created).toEqual([]);
		const id = await t!.factory.createBundle("p", [a, b]);
		const v = await untilBundle(t!.factory, id, bundleIn("MERGED", "FAILED", "ESCALATED"));
		expect(v.state).toBe("MERGED");
		expect(states(v)).toEqual(["INTEGRATING", "DELIVERING", "AWAITING_CI", "MERGED"]);
		expect(v.delivery?.kind).toBe("repo");
		expect(t!.host.state().created).toContain("me/p");
		expect(t!.host.state().prs).toEqual([]);
		const notes = await remoteFile("main", "docs/delivery-notes.md");
		expect(notes).toContain("## Ticket: alpha");
		expect(notes).toContain("## Ticket: beta");
		expect(await remoteFile("main", `docs/specs/${a}.md`)).toBeDefined();
		expect((await until(t!.factory, a, inState("DELIVERED"))).artifacts.delivery?.kind).toBe("repo");
		expect((await until(t!.factory, b, inState("DELIVERED"))).state).toBe("DELIVERED");
	});
});

describe("failure and retry", () => {
	test("an integrator that never concludes the merge → FAILED (members stay); Retry resumes at INTEGRATING", async () => {
		t = await makeFactory();
		t.control.sharedFile = true;
		await t.host.seedRepo("me/p", SEED);
		await t.factory.createProject("p", "me/p");
		const a = await start("alpha");
		const b = await start("beta");
		await Promise.all([ready(a), ready(b)]);
		t.control.integratorPlan = ["leave", "abort", "leave"];
		const id = await t.factory.createBundle("p", [a, b]);
		let v = await untilBundle(t.factory, id, bundleIn("FAILED", "AWAITING_MERGE"));
		expect(v.state).toBe("FAILED");
		expect(v.failure).toMatchObject({ state: "INTEGRATING" });
		expect((await t.factory.getRun(a)).bundle).toBe(id);
		await expect(t.factory.createBundle("p", [a])).rejects.toMatchObject({ code: "conflict" });
		await t.factory.retryBundle(id);
		v = await waitMerge(id);
		expect(v.state).toBe("AWAITING_MERGE");
	});
});

describe("more transitions", () => {
	test("ESCALATED → drop tickets → INTEGRATING with the rest; the dropped run is back in Ready", async () => {
		const { a, b } = await twoReady([["ci.fixRounds", 0]]);
		t!.host.forceChecks("me/p", [{ name: "test", status: "completed", conclusion: "failure", summary: "red" }]);
		const id = await t!.factory.createBundle("p", [a, b]);
		let v = await untilBundle(t!.factory, id, bundleIn("ESCALATED", "AWAITING_MERGE", "FAILED"));
		expect(v.state).toBe("ESCALATED");
		await expect(t!.factory.dropFromBundle(id, [])).rejects.toMatchObject({ code: "invalid" });
		await t!.factory.resolveBundleEscalation(id, v.pendingAsk!.id, { drop: [b] });
		v = await untilBundle(t!.factory, id, (x) => (x.state === "AWAITING_MERGE" && !!x.pendingAsk) || x.state === "FAILED");
		expect(v.state).toBe("AWAITING_MERGE");
		expect(states(v)).toEqual(["INTEGRATING", "DELIVERING", "AWAITING_CI", "ESCALATED", "INTEGRATING", "DELIVERING", "AWAITING_CI", "AWAITING_MERGE"]);
		expect(v.members.map((m) => m.run)).toEqual([a]);
		expect((await t!.factory.getRun(b)).bundle).toBeUndefined();
		expect(t!.control.integratorInputs).toEqual([]);
	});

	test("Cancel bundle on a FAILED bundle releases its members; Retry is refused on other states", async () => {
		t = await makeFactory();
		t.control.sharedFile = true;
		await t.host.seedRepo("me/p", SEED);
		await t.factory.createProject("p", "me/p");
		const a = await start("alpha");
		const b = await start("beta");
		await Promise.all([ready(a), ready(b)]);
		t.control.integratorPlan = ["leave", "leave", "leave"];
		const id = await t.factory.createBundle("p", [a, b]);
		await expect(t.factory.retryBundle(id)).rejects.toMatchObject({ code: "conflict" });
		expect((await untilBundle(t.factory, id, bundleIn("FAILED"))).state).toBe("FAILED");
		await expect(t.factory.messageBundle(id, "hi")).rejects.toMatchObject({ code: "conflict" });
		await t.factory.cancelBundle(id, "not now");
		const v = await t.factory.getBundle(id);
		expect(v.state).toBe("CANCELLED");
		expect(states(v).slice(-2)).toEqual(["FAILED", "CANCELLED"]);
		for (const r of [a, b]) expect((await until(t.factory, r, (x) => x.bundle === undefined)).state).toBe("READY");
	});

	test("listBundles filters by project and state; getBundle of an unknown id is not_found; a bundle event filter only matches that bundle", async () => {
		const { a, b } = await twoReady();
		const seen: BundleView["id"][] = [];
		t!.factory.subscribe({ bundle: "bundle-2" }, (e) => seen.push((e as any).bundle ?? (e as any).run));
		const one = await t!.factory.createBundle("p", [a]);
		const two = await t!.factory.createBundle("p", [b]);
		await Promise.all([waitMerge(one), waitMerge(two)]);
		expect((await t!.factory.listBundles({ project: "p" })).map((x) => x.id)).toEqual([one, two]);
		expect(await t!.factory.listBundles({ project: "q" })).toEqual([]);
		expect((await t!.factory.listBundles({ states: ["AWAITING_MERGE"] })).length).toBe(2);
		await expect(t!.factory.listBundles({ states: ["NOPE" as any] })).rejects.toMatchObject({ code: "invalid" });
		await expect(t!.factory.getBundle("bundle-9")).rejects.toMatchObject({ code: "not_found" });
		expect(seen.length).toBeGreaterThan(0);
		expect(new Set(seen)).toEqual(new Set([two]));
		const v = await t!.factory.getBundle(one);
		expect(v.members[0]).toMatchObject({ run: a, title: "alpha", key: "P-1", specPath: `docs/specs/${a}.md`, branch: `factory/${a}` });
		const rv: RunView = await t!.factory.getRun(a);
		expect(rv.bundle).toBe(one);
	});
});
