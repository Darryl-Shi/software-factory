// Findings/evidence enforcement (spec §2 "Findings", §3.4).
import { afterEach, describe, expect, test } from "vitest";
import { humanFindings, validateResponses, validateReview } from "../src/core/findings.ts";
import { makeFactory, type TestEnv } from "./helpers.ts";

const ok = { severity: "major", blocking: true, specRef: "AB1", description: "broken", evidence: "$ npm test\n1 failing" };

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
	test("every reviewer finding needs evidence and a specRef", () => {
		const r = validateReview({ verdict: "fail", findings: [{ ...ok, evidence: "" }, { ...ok, specRef: undefined }, { ...ok, evidence: "   " }] });
		expect(r.ok).toBe(false);
		const p = !r.ok ? r.problems : [];
		expect(p.filter((x) => /evidence is required/.test(x)).length).toBe(2);
		expect(p.filter((x) => /specRef/.test(x)).length).toBe(1);
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
		const v = await t.factory.waitForState(run, (x) => ["DELIVERED", "FAILED", "ESCALATED"].includes(x.state));
		expect(v.state).toBe("DELIVERED");
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
		const v = await t.factory.waitForState(run, (x) => x.state === "DELIVERED");
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
		const v = await t.factory.waitForState(run, (x) => x.state === "DELIVERED");
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
	test("the builder's helper runs with the helper role: its model, read tools incl. bash, no write tools, no bridge tools", async () => {
		t = await makeFactory();
		t.control.builderSubagent = true;
		await t.factory.createProject("p", "me/p");
		const run = await t.factory.startRun("p", { source: "t", title: "x", body: "x" });
		const v = await t.factory.waitForState(run, (x) => x.state === "DELIVERED");
		const tr = await t.factory.getConversation(run, v.conversations.builder!);
		expect(tr.helpers.length).toBe(1);
		const h = await t.factory.getConversation(run, tr.helpers[0]!);
		expect(h.role).toBe("helper");
		const results = h.items.filter((i) => i.toolResult).map((i) => [i.toolResult!.name, i.toolResult!.isError]);
		expect(results.sort()).toEqual([
			["bash", false],
			["write", true],
		]);
		const sub = tr.items.find((i) => i.toolResult?.name === "subagent")!.toolResult!;
		expect(sub.text).toMatch(/helper saw: (bash:ok, write:error|write:error, bash:ok)/);
		// ids handed back as strings (CLI/JSON) work too
		expect((await t.factory.getConversation(run, String(tr.helpers[0]))).items.length).toBe(h.items.length);
	});
});
