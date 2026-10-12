// Findings/evidence enforcement (spec §2 "Findings", §3.4).
import { afterEach, describe, expect, test } from "vitest";
import { formatFinding, humanFindings, validateQa, validateResponses, validateReview, validateTickets } from "../src/core/findings.ts";
import { makeFactory, shipAndMerge, type TestEnv } from "./helpers.ts";

const ok = { severity: "major", blocking: true, specRef: "AB1", description: "broken", evidence: "$ npm test\n1 failing" };

test("validateTickets", () => {
	expect(validateTickets({ summary: "s", tickets: [{ title: " A ", body: "b" }] })).toEqual({ ok: true, payload: { summary: "s", tickets: [{ title: "A", body: "b" }] } });
	const bad = validateTickets({ summary: " ", tickets: [{ title: "x".repeat(201), body: "" }] });
	expect(bad.ok).toBe(false);
	expect((bad as any).problems).toEqual(
		expect.arrayContaining(["summary is required", "tickets[0]: title is longer than 200 characters", "tickets[0]: body is required"]),
	);
	expect((validateTickets({ summary: "s", tickets: [] }) as any).problems).toContain("give 1 to 20 tickets");
	expect((validateTickets({ summary: "s", tickets: Array(21).fill({ title: "t", body: "b" }) }) as any).problems).toContain("give 1 to 20 tickets");
});

describe("validateReview", () => {
	test("a valid fail and a valid pass", () => {
		expect(validateReview({ verdict: "fail", findings: [ok] })).toMatchObject({ ok: true, review: { verdict: "fail" } });
		expect(validateReview({ verdict: "pass", findings: [] })).toMatchObject({ ok: true });
		const adv = validateReview({ verdict: "pass", findings: [{ ...ok, blocking: false }] });
		expect(adv.ok && adv.review.findings[0]!.source).toBe("reviewer");
	});
	test("fail requires at least one blocking finding", () => {
		const r = validateReview({ verdict: "fail", findings: [{ ...ok, blocking: false }] });
		expect(r.ok).toBe(false);
		expect(!r.ok && r.problems.join()).toMatch(/requires at least one blocking finding/);
		expect(validateReview({ verdict: "fail", findings: [] }).ok).toBe(false);
	});
	test("pass with a blocking finding is rejected (fail iff a blocking finding exists)", () => {
		const r = validateReview({ verdict: "pass", findings: [ok] });
		expect(!r.ok && r.problems.join()).toMatch(/not allowed with blocking findings/);
	});
	test("every reviewer finding needs evidence; specRef is optional (code-quality and security findings often have none)", () => {
		const r = validateReview({ verdict: "fail", findings: [{ ...ok, evidence: "" }, { ...ok, specRef: undefined }, { ...ok, evidence: "   " }] });
		expect(r.ok).toBe(false);
		const p = !r.ok ? r.problems : [];
		expect(p.filter((x) => /evidence is required/.test(x)).length).toBe(2);
		expect(p.filter((x) => /specRef/.test(x)).length).toBe(0);
		// a blocking security finding with no spec clause fails the round on its own
		const sec = validateReview({ verdict: "fail", findings: [{ severity: "critical", blocking: true, description: "SQL injection in /search", evidence: "src/db.js:12-14 builds the query by string concatenation" }] });
		expect(sec.ok && sec.review.findings[0]).toMatchObject({ blocking: true, source: "reviewer" });
		expect(sec.ok && "specRef" in sec.review.findings[0]!).toBe(false);
	});
	test("severity, blocking and description are required; reviewers cannot pose as humans", () => {
		const r = validateReview({ verdict: "fail", findings: [{ blocking: "yes", evidence: "x", specRef: "x" }, { ...ok, source: "human" }] });
		const p = !r.ok ? r.problems.join("\n") : "";
		expect(p).toMatch(/severity is required/);
		expect(p).toMatch(/blocking must be true or false/);
		expect(p).toMatch(/description is required/);
		expect(p).toMatch(/source "reviewer"/);
		expect(validateReview({ verdict: "maybe", findings: [] }).ok).toBe(false);
		expect(validateReview({ verdict: "pass" }).ok).toBe(false);
	});
});

describe("validateQa", () => {
	const qa = { severity: "major", blocking: true, description: "the save button does nothing", evidence: "clicked Save; the list stayed empty", screenshots: ["r1-s1"] };
	test("a valid QA fail: source qa, screenshots kept", () => {
		const r = validateQa({ verdict: "fail", findings: [qa] }, ["r1-s1", "r1-s2"]);
		expect(r.ok && r.review.findings[0]).toMatchObject({ source: "qa", screenshots: ["r1-s1"] });
	});
	test("every QA finding needs evidence and at least one screenshot the agent took this round", () => {
		const r = validateQa({ verdict: "fail", findings: [{ ...qa, screenshots: [] }, { ...qa, evidence: "" }, { ...qa, screenshots: ["r0-s9"] }] }, ["r1-s1"]);
		const p = !r.ok ? r.problems.join("\n") : "";
		expect(p).toMatch(/findings\[0\]: cite at least one screenshot/);
		expect(p).toMatch(/findings\[1\]: evidence is required/);
		expect(p).toMatch(/findings\[2\]: screenshot r0-s9 is not one you took this round/);
		expect(validateQa({ verdict: "fail", findings: [{ ...qa, blocking: false }] }, ["r1-s1"]).ok).toBe(false);
		expect(validateQa({ verdict: "pass", findings: [{ ...qa, source: "reviewer" }] }, ["r1-s1"]).ok).toBe(false);
	});
	test("formatFinding lists screenshot ids", () => {
		expect(formatFinding({ ...qa, id: "F3", source: "qa" })).toContain("screenshots: r1-s1");
	});
});

describe("human findings and builder responses", () => {
	test("human findings are blocking, source human; specRef and evidence optional", () => {
		const r = humanFindings([{ severity: "major", description: "rename it" }]);
		expect(r).toEqual({ ok: true, findings: [{ severity: "major", description: "rename it", blocking: true, source: "human" }] });
		expect(humanFindings([]).ok).toBe(false);
		expect(humanFindings([{ severity: "", description: "" }]).ok).toBe(false);
	});
	test("the builder must answer every finding it was given: fixed, or wontfix with a reason", () => {
		expect(validateResponses(["F1", "F2"], [{ findingId: "F1", status: "fixed" }, { findingId: "F2", status: "wontfix", reason: "out of scope" }]).ok).toBe(true);
		const missing = validateResponses(["F1", "F2"], [{ findingId: "F1", status: "fixed" }]);
		expect(!missing.ok && missing.problems.join()).toMatch(/F2 has no response/);
		const noReason = validateResponses(["F1"], [{ findingId: "F1", status: "wontfix" }]);
		expect(!noReason.ok && noReason.problems.join()).toMatch(/requires a reason/);
		const unknown = validateResponses([], [{ findingId: "F9", status: "fixed" }]);
		expect(!unknown.ok && unknown.problems.join()).toMatch(/unknown finding F9/);
	});
});

describe("bridge enforcement in a live run", () => {
	let t: TestEnv | undefined;
	afterEach(async () => {
		await t?.factory.close().catch(() => {});
		t = undefined;
	});

	test("report_done must answer every blocking finding; wontfix needs a reason; the next reviewer sees the answers", async () => {
		t = await makeFactory();
		t.control.reviews = ["fail", "pass"];
		t.control.responsePlan = ["omit", "wontfix-noreason", "wontfix"];
		await t.factory.createProject("p", "me/p");
		const run = await t.factory.startRun("p", { source: "t", title: "x", body: "x" });
		// a run that passes review stops at READY (bundles spec §1.1)
		const v = await t.factory.waitForState(run, (x) => ["READY", "DELIVERED", "FAILED", "ESCALATED"].includes(x.state));
		expect(v.state).toBe("READY");
		const tr = await t.factory.getConversation(run, v.conversations.builder!);
		const results = tr.items.filter((i) => i.toolResult?.name === "report_done").map((i) => i.toolResult!);
		expect(results.map((r) => r.isError)).toEqual([false, true, true, false]);
		expect(results[1]!.text).toMatch(/F1 has no response/);
		expect(results[2]!.text).toMatch(/"wontfix" requires a reason/);
		expect(t.control.reviewerInputs[1]).toContain("builder: wontfix — out of scope for the spec");
		expect(v.findingsLog[0]!.responses).toEqual([{ findingId: "F1", status: "wontfix", reason: "out of scope for the spec" }]);
	});

	test("one submission per turn: a second submit_spec in the same turn is refused", async () => {
		t = await makeFactory();
		t.control.architectDouble = true;
		await t.factory.createProject("p", "me/p");
		const run = await t.factory.startRun("p", { source: "t", title: "x", body: "x" });
		const v = await t.factory.waitForState(run, (x) => ["READY", "FAILED", "ESCALATED"].includes(x.state));
		expect(v.state).toBe("READY");
		const tr = await t.factory.getConversation(run, v.conversations.architect!);
		const results = tr.items.filter((i) => i.toolResult?.name === "submit_spec").map((i) => i.toolResult!);
		expect(results.map((r) => r.isError)).toEqual([false, true]);
		expect(results[1]!.text).toMatch(/Already submitted/);
		expect(v.artifacts.spec!.text).toContain("Spec v1");
	});

	test("a spec without acceptance behaviours is refused by submit_spec", async () => {
		t = await makeFactory();
		t.control.architectNoAB = true;
		await t.factory.createProject("p", "me/p");
		const run = await t.factory.startRun("p", { source: "t", title: "x", body: "x" });
		const v = await t.factory.waitForState(run, (x) => ["READY", "FAILED", "ESCALATED"].includes(x.state));
		expect(v.state).toBe("READY");
		const tr = await t.factory.getConversation(run, v.conversations.architect!);
		const results = tr.items.filter((i) => i.toolResult?.name === "submit_spec").map((i) => i.toolResult!);
		expect(results.map((r) => r.isError)).toEqual([true, false]);
		expect(results[0]!.text).toMatch(/must end with an "Acceptance behaviours" section/);
	});
});

describe("helpers (subagent)", () => {
	let t: TestEnv | undefined;
	afterEach(async () => {
		await t?.factory.close().catch(() => {});
		t = undefined;
	});
	test("the builder's helper writes code in the builder's worktree: its model, write tools, no subagent, no bridge tools", async () => {
		t = await makeFactory();
		t.control.builderSubagent = true;
		await t.factory.createProject("p", "me/p");
		const run = await t.factory.startRun("p", { source: "t", title: "x", body: "x" });
		// shipped alone: the bundle (new repo) pushes the reviewed result to main
		const v = await shipAndMerge(t.factory, run);
		expect(v.state).toBe("DELIVERED");
		const tr = await t.factory.getConversation(run, v.conversations.builder!);
		expect(tr.helpers.length).toBe(1);
		const h = await t.factory.getConversation(run, tr.helpers[0]!);
		expect(h.role).toBe("helper");
		const results = h.items.filter((i) => i.toolResult).map((i) => [i.toolResult!.name, i.toolResult!.isError]);
		expect(results.sort()).toEqual([
			["bash", false],
			["write", false],
		]);
		const sub = tr.items.find((i) => i.toolResult?.name === "subagent")!.toolResult!;
		expect(sub.text).toMatch(/helper saw: (bash:ok, write:ok|write:ok, bash:ok)/);
		// the helper's file is in the round's diff, was reviewed, and is in the delivered repo
		expect(t.control.reviewerInputs[0]).toContain("helper.txt");
		const { git } = await import("../src/github/git.ts");
		expect((await git(t.host.bare("me/p"), ["show", "main:helper.txt"])).stdout).toBe("x");
		const agent = await (await t.factory.harnessForTests.conversation(tr.helpers[0] as never, {} as never))!.agent({} as never);
		expect(agent.model).toEqual({ provider: "scripted", modelId: "helper" });
		expect(agent.tools.map((x) => x.name).sort()).toEqual(["bash", "edit", "read", "run_tests", "web_search", "write"]);
		// ids handed back as strings (CLI/JSON) work too
		expect((await t.factory.getConversation(run, String(tr.helpers[0]))).items.length).toBe(h.items.length);
	});
});
