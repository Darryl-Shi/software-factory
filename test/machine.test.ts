// State machine (spec §4): every transition, gates, rejections, escalations, fix-round caps, CI modes.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { FactoryEvent, RunView } from "../src/core/types.ts";
import { git } from "../src/extensions/git.ts";
import { inState, makeFactory, type TestEnv, until } from "./helpers.ts";

let t: TestEnv | undefined;
afterEach(async () => {
	await t?.factory.close().catch(() => {});
	t = undefined;
});

const states = (v: RunView) => v.history.map((h) => h.to);
const G = { global: true } as const;
const done = inState("DELIVERED", "FAILED", "CANCELLED");

async function setup(settings: [string, unknown][] = [], project = "p", repo = "me/p") {
	t = await makeFactory();
	await t.factory.createProject(project, repo);
	for (const [path, value] of settings) await t.factory.setSetting({ project }, path, value);
	return t;
}
const start = (body = "make hello", project = "p") => t!.factory.startRun(project, { source: "test", title: "hello", body });
async function remoteFile(repo: string, ref: string, path: string) {
	const r = await git(t!.host.bare(repo), ["show", `${ref}:${path}`], { allowFail: true });
	return r.code === 0 ? r.stdout : undefined;
}

describe("new repo (zero to MVP), push-main", () => {
	test("RECEIVED → PREPARING → DISCUSSING → SPEC_READY → BUILDING → REVIEWING → DELIVERING → AWAITING_CI → DELIVERED (no CI)", async () => {
		await setup();
		const run = await start();
		const v = await until(t!.factory, run, done);
		expect(states(v)).toEqual(["RECEIVED", "PREPARING", "DISCUSSING", "SPEC_READY", "BUILDING", "REVIEWING", "DELIVERING", "AWAITING_CI", "DELIVERED"]);
		expect(v.artifacts.delivery?.kind).toBe("repo");
		expect(v.noCi).toBe(true);
		expect(t!.host.state().created).toContain("me/p");
		expect(await remoteFile("me/p", "main", "docs/spec.md")).toContain("Acceptance behaviours");
		expect(await remoteFile("me/p", "main", "round-1.txt")).toBe("round 1\n");
		const notes = await remoteFile("me/p", "main", "docs/delivery-notes.md");
		expect(notes).toContain("no CI");
		expect(v.notices.at(-1)!.final).toBe(true);
		expect(v.notices.at(-1)!.noCi).toBe(true);
		// pinned config + Pi version + cost per role per round
		expect(v.configHash).toMatch(/^[0-9a-f]{16}$/);
		expect(v.piVersion).toBe("1.1.0");
		expect(v.cost.map((c) => `${c.role}:${c.round}`)).toEqual(["architect:0", "builder:1", "reviewer:1"]);
		expect(v.cost.every((c) => c.totalTokens > 0 && c.durationMs >= 0)).toBe(true);
	});

	test("discussion: ask_human → pending ask → answer resubmitted → spec gate → approve", async () => {
		await setup([["policy.approvals", ["spec"]]]);
		t!.control.askFirst = true;
		const events: FactoryEvent[] = [];
		t!.factory.subscribe({ project: "p" }, (e) => events.push(e));
		const run = await start();
		let v = await until(t!.factory, run, (x) => x.pendingAsk?.question.kind === "discussion");
		expect(v.state).toBe("DISCUSSING");
		expect(v.pendingAsk!.question).toEqual({ kind: "discussion", text: "Which language?" });
		await expect(t!.factory.answer(run, "nope", "TypeScript")).rejects.toThrow(/not pending/);
		await expect(t!.factory.approve(run, "spec")).rejects.toThrow(/no spec approval/);
		const ask = v.pendingAsk!.id;
		const cli = t!.factory.as("cli");
		await cli.answer(run, ask, "TypeScript");
		await expect(t!.factory.answer(run, ask, "again")).rejects.toThrow(/already answered|not pending|no pending/);
		v = await until(t!.factory, run, (x) => x.state === "AWAITING_APPROVAL");
		expect(v.gate).toBe("spec");
		expect(v.pendingAsk!.question).toMatchObject({ kind: "approval", gate: "spec", options: ["approve", "reject"] });
		expect(t!.control.architectInputs[1]).toBe("TypeScript");
		await t!.factory.approve(run, "spec");
		v = await until(t!.factory, run, done);
		expect(v.state).toBe("DELIVERED");
		const resolved = events.filter((e) => e.type === "run.askResolved");
		expect(resolved[0]).toMatchObject({ type: "run.askResolved", by: "cli" });
		expect(events.filter((e) => e.type === "run.ask").length).toBe(2);
		expect(events.filter((e) => e.type === "run.state").map((e) => (e as any).to)).toEqual(states(v));
	});

	test("spec rejection returns to DISCUSSING in the same architect conversation", async () => {
		await setup([["policy.approvals", ["spec"]]]);
		const run = await start();
		let v = await until(t!.factory, run, inState("AWAITING_APPROVAL"));
		const architect = v.conversations.architect;
		await t!.factory.reject(run, "spec", "use SQLite instead");
		v = await until(t!.factory, run, (x) => x.state === "AWAITING_APPROVAL" && (x.artifacts.spec?.version ?? 0) === 2);
		expect(states(v)).toEqual(["RECEIVED", "PREPARING", "DISCUSSING", "SPEC_READY", "AWAITING_APPROVAL", "DISCUSSING", "SPEC_READY", "AWAITING_APPROVAL"]);
		expect(v.conversations.architect).toBe(architect);
		expect(t!.control.architectInputs[1]).toContain("use SQLite instead");
		await t!.factory.approve(run, "spec");
		expect((await until(t!.factory, run, done)).state).toBe("DELIVERED");
	});
});

describe("review loop", () => {
	test("failed review resumes the SAME builder with the findings; reviewer is fresh and sees prior findings + responses", async () => {
		await setup();
		t!.control.reviews = ["fail", "pass-advisory"];
		const run = await start();
		const v = await until(t!.factory, run, done);
		expect(v.state).toBe("DELIVERED");
		expect(states(v)).toEqual(["RECEIVED", "PREPARING", "DISCUSSING", "SPEC_READY", "BUILDING", "REVIEWING", "BUILDING", "REVIEWING", "DELIVERING", "AWAITING_CI", "DELIVERED"]);
		expect(v.reviewRound).toBe(2);
		expect(v.conversations.reviewers.length).toBe(2);
		expect(v.conversations.reviewers[0]!.id).not.toBe(v.conversations.reviewers[1]!.id);
		// same builder conversation got the findings as new input
		const tr = await t!.factory.getConversation(run, v.conversations.builder!);
		const userInputs = tr.items.filter((i) => i.role === "user").map((i) => i.text!);
		expect(userInputs.length).toBe(2);
		expect(userInputs[1]).toContain("[F1] (reviewer, BLOCKING, major)");
		expect(userInputs[1]).toContain("it does not print hello");
		expect(t!.control.reviewerInputs[1]).toContain("Your prior findings and the builder's responses");
		expect(t!.control.reviewerInputs[1]).toContain("builder: fixed");
		// advisory findings of the final review are collected and delivered
		expect(v.advisory.map((f) => f.description)).toEqual(["consider colours"]);
		expect(await remoteFile("me/p", "main", "docs/delivery-notes.md")).toContain("consider colours");
		expect(v.cost.filter((c) => c.role === "reviewer").map((c) => c.round)).toEqual([1, 2]);
	});

	test("review round cap → ESCALATED; more rounds raises the cap; then delivered", async () => {
		await setup([["policy.reviewRoundCap", 2]]);
		t!.control.reviews = ["fail", "fail", "pass"];
		const run = await start();
		let v = await until(t!.factory, run, inState("ESCALATED"));
		expect(v.reviewRound).toBe(2);
		expect(v.escalation).toMatchObject({ cap: "review", from: "REVIEWING" });
		expect(v.pendingAsk!.question).toMatchObject({ kind: "escalation", options: ["accept", "more-rounds", "abort"] });
		await expect(t!.factory.resolveEscalation(run, v.pendingAsk!.id, { moreRounds: 0 })).rejects.toThrow();
		await t!.factory.resolveEscalation(run, v.pendingAsk!.id, { moreRounds: 1 });
		v = await until(t!.factory, run, done);
		expect(v.state).toBe("DELIVERED");
		expect(v.caps.review).toBe(3);
		expect(v.reviewRound).toBe(3);
	});

	test("escalation accept → DELIVERING; open blocking findings are listed in the delivery note and final report", async () => {
		await setup([["policy.reviewRoundCap", 1]]);
		t!.control.reviews = ["fail"];
		const run = await start();
		let v = await until(t!.factory, run, inState("ESCALATED"));
		await t!.factory.resolveEscalation(run, v.pendingAsk!.id, { accept: true });
		v = await until(t!.factory, run, done);
		expect(v.state).toBe("DELIVERED");
		expect(v.acceptedBlocking.map((f) => f.description)).toEqual(["it does not print hello"]);
		expect(await remoteFile("me/p", "main", "docs/delivery-notes.md")).toContain("accepted as is");
		expect(v.notices.at(-1)!.acceptedBlocking!.length).toBe(1);
	});

	test("escalation abort → CANCELLED", async () => {
		await setup([["policy.reviewRoundCap", 1]]);
		t!.control.reviews = ["fail"];
		const run = await start();
		const v = await until(t!.factory, run, inState("ESCALATED"));
		await t!.factory.resolveEscalation(run, v.pendingAsk!.id, { abort: true });
		expect((await until(t!.factory, run, done)).state).toBe("CANCELLED");
	});

	test("a fix round with an empty diff escalates early (no progress)", async () => {
		await setup();
		t!.control.reviews = ["fail"];
		t!.control.noProgressFromInput = 2;
		const run = await start();
		const v = await until(t!.factory, run, inState("ESCALATED", "DELIVERED"));
		expect(v.state).toBe("ESCALATED");
		expect(v.escalation!.reason).toMatch(/no progress/);
		expect(v.escalation!.from).toBe("BUILDING");
	});

	test("escalateOnNoProgress: false disables the early escalation", async () => {
		await setup([["policy.escalateOnNoProgress", false]]);
		t!.control.reviews = ["fail", "pass"];
		t!.control.builderNoProgress = false;
		const run = await start();
		await until(t!.factory, run, (v) => v.reviewRound === 2);
		t!.control.builderNoProgress = true;
		expect((await until(t!.factory, run, done)).state).toBe("DELIVERED");
	});

	test("the bridge rejects an invalid review (no evidence, fail without blocking); the reviewer then submits a valid one", async () => {
		await setup();
		t!.control.reviews = ["invalid-then-pass"];
		const run = await start();
		const v = await until(t!.factory, run, done);
		expect(v.state).toBe("DELIVERED");
		const tr = await t!.factory.getConversation(run, v.conversations.reviewers[0]!.id);
		const results = tr.items.filter((i) => i.toolResult?.name === "submit_review").map((i) => i.toolResult!);
		expect(results[0]!.isError).toBe(true);
		expect(results[0]!.text).toMatch(/evidence is required/);
		expect(results[0]!.text).toMatch(/requires at least one blocking finding/);
		expect(results[1]!.isError).toBe(false);
	});
});

describe("existing repo (incremental), PR delivery, delivery + merge gates", () => {
	test("reject at delivery and merge gates → same builder gets a blocking human finding, no round added, next reviewer sees it; approve → merge", async () => {
		t = await makeFactory();
		await t.host.seedRepo("me/app", { "README.md": "# app\n", "AGENTS.md": "Test: true\n" });
		await t.factory.createProject("app", "me/app");
		await t.factory.setSetting({ project: "app" }, "policy.approvals", ["spec", "delivery", "merge"]);
		const run = await t.factory.startRun("app", { source: "test", title: "add due dates", body: "add due dates" });
		let v = await until(t.factory, run, inState("AWAITING_APPROVAL"));
		await t.factory.approve(run, "spec");
		v = await until(t.factory, run, (x) => x.state === "AWAITING_APPROVAL" && x.gate === "delivery");
		const builder = v.conversations.builder;
		await t.factory.reject(run, "delivery", "please add a changelog entry");
		v = await until(t.factory, run, (x) => x.state === "AWAITING_APPROVAL" && x.gate === "delivery" && x.conversations.reviewers.length === 2);
		expect(v.reviewRound).toBe(1);
		expect(v.ciFixes).toBe(0);
		expect(v.conversations.builder).toBe(builder);
		expect(t.control.builderInputs[1]).toContain("(human, BLOCKING, blocking)");
		expect(t.control.builderInputs[1]).toContain("please add a changelog entry");
		expect(t.control.reviewerInputs[1]).toContain("Human findings from a gate rejection");
		expect(t.control.reviewerInputs[1]).toContain("please add a changelog entry");
		const humanLog = v.findingsLog.find((e) => e.kind === "human")!;
		expect(humanLog.findings[0]).toMatchObject({ source: "human", blocking: true });
		expect(humanLog.responses?.[0]).toMatchObject({ status: "fixed" });
		await t.factory.approve(run, "delivery");
		v = await until(t.factory, run, (x) => x.state === "AWAITING_APPROVAL" && x.gate === "merge");
		expect(v.artifacts.delivery?.kind).toBe("pr");
		const pr = v.artifacts.delivery!.pr!;
		// structured rejection at the merge gate
		await t.factory.submitHumanFindings(run, "merge", [{ severity: "major", description: "rename the flag", specRef: "AB2" }]);
		v = await until(t.factory, run, (x) => x.state === "AWAITING_APPROVAL" && x.gate === "delivery" && x.conversations.reviewers.length === 3);
		expect(v.reviewRound).toBe(1);
		expect(t.control.reviewerInputs[2]).toContain("rename the flag");
		await t.factory.approve(run, "delivery");
		v = await until(t.factory, run, (x) => x.state === "AWAITING_APPROVAL" && x.gate === "merge");
		expect(v.artifacts.delivery!.pr!.number).toBe(pr.number); // the existing PR is reused
		await t.factory.approve(run, "merge");
		v = await until(t.factory, run, done);
		expect(v.state).toBe("DELIVERED");
		expect(t.host.state().prs.find((p) => p.number === pr.number)!.state).toBe("merged");
		expect(await remoteFile("me/app", "main", "docs/spec.md")).toContain("Acceptance behaviours");
		expect(states(v).filter((s) => s === "BUILDING").length).toBe(3);
	});

	test("merge gate off: the PR is left open (no auto-merge) and the run is DELIVERED", async () => {
		t = await makeFactory();
		await t.host.seedRepo("me/app", { "README.md": "# app\n" });
		await t.factory.createProject("app", "me/app");
		const run = await t.factory.startRun("app", { source: "test", title: "x", body: "x" });
		const v = await until(t.factory, run, done);
		expect(v.state).toBe("DELIVERED");
		expect(v.artifacts.delivery?.kind).toBe("pr");
		expect(t.host.state().prs[0]!.state).toBe("open");
		expect(v.notices.at(-1)!.text).toMatch(/PR left open/);
		expect(t.host.state().prs[0]!.body).toMatch(/no CI/);
	});

	test("the merge gate does not apply to push-main deliveries", async () => {
		await setup([["policy.approvals", ["merge"]]]);
		const run = await start();
		const v = await until(t!.factory, run, done);
		expect(v.state).toBe("DELIVERED");
		expect(states(v)).not.toContain("AWAITING_APPROVAL");
	});
});

describe("CI modes", () => {
	test("ci.mode off: finishes at delivery without waiting for CI", async () => {
		await setup([["stages.delivery.ci.mode", "off"]]);
		const run = await start();
		const v = await until(t!.factory, run, done);
		expect(v.state).toBe("DELIVERED");
		expect(states(v)).not.toContain("AWAITING_CI");
	});

	test("ci.mode required and no checks → ESCALATED (no CI checks) after ci.noChecksTimeout", async () => {
		await setup([["stages.delivery.ci.mode", "required"], ["stages.delivery.ci.noChecksTimeout", "400ms"]]);
		const run = await start();
		const v = await until(t!.factory, run, inState("ESCALATED", "DELIVERED"));
		expect(v.state).toBe("ESCALATED");
		expect(v.escalation!.reason).toMatch(/no CI checks/);
		expect(v.escalation!.from).toBe("AWAITING_CI");
		const ci = v.history.find((h) => h.to === "AWAITING_CI")!.at;
		expect(v.history.at(-1)!.at - ci).toBeGreaterThanOrEqual(400);
	});

	test("ci.mode if-present and no checks → DELIVERED, noting no CI", async () => {
		await setup([["stages.delivery.ci.mode", "if-present"]]);
		const run = await start();
		const v = await until(t!.factory, run, done);
		expect(v.state).toBe("DELIVERED");
		expect(v.noCi).toBe(true);
	});

	test("CI red → same builder fixes → review (counts toward ci.fixRounds) → redeliver → CI green", async () => {
		await setup([["stages.delivery.ci.mode", "required"]]);
		t!.host.forceChecks("me/p", [{ name: "test", status: "completed", conclusion: "failure", summary: "1 failing" }], [{ name: "test", status: "completed", conclusion: "success" }]);
		const run = await start();
		const v = await until(t!.factory, run, done);
		expect(v.state).toBe("DELIVERED");
		expect(states(v)).toEqual([
			"RECEIVED", "PREPARING", "DISCUSSING", "SPEC_READY", "BUILDING", "REVIEWING", "DELIVERING", "AWAITING_CI",
			"BUILDING", "REVIEWING", "DELIVERING", "AWAITING_CI", "DELIVERED",
		]);
		expect(v.ciFixes).toBe(1);
		expect(v.reviewRound).toBe(1);
		expect(t!.control.builderInputs[1]).toContain("CI failed on the delivered commit");
		expect(t!.control.builderInputs[1]).toContain("(ci, BLOCKING");
	});

	test("ci.fixRounds 0: CI red escalates without a fix round", async () => {
		await setup([["stages.delivery.ci.fixRounds", 0]]);
		t!.host.forceChecks("me/p", [{ name: "test", status: "completed", conclusion: "failure" }]);
		const run = await start();
		const v = await until(t!.factory, run, inState("ESCALATED", "DELIVERED"));
		expect(v.state).toBe("ESCALATED");
		expect(states(v).slice(-2)).toEqual(["AWAITING_CI", "ESCALATED"]);
		expect(states(v).filter((s) => s === "BUILDING").length).toBe(1);
	});

	test("CI red at cap → ESCALATED; accept from AWAITING_CI → DELIVERED (merge gate off)", async () => {
		await setup([["stages.delivery.ci.fixRounds", 1]]);
		const red = [{ name: "test", status: "completed" as const, conclusion: "failure" }];
		t!.host.forceChecks("me/p", red, red);
		const run = await start();
		let v = await until(t!.factory, run, inState("ESCALATED"));
		expect(v.ciFixes).toBe(1);
		expect(v.escalation).toMatchObject({ from: "AWAITING_CI", cap: "ciFix" });
		await t!.factory.resolveEscalation(run, v.pendingAsk!.id, { accept: true });
		v = await until(t!.factory, run, done);
		expect(v.state).toBe("DELIVERED");
		expect(states(v).slice(-2)).toEqual(["ESCALATED", "DELIVERED"]);
	});

	test("CI red at cap → more rounds → another CI fix round", async () => {
		await setup([["stages.delivery.ci.fixRounds", 0]]);
		t!.host.forceChecks("me/p", [{ name: "t", status: "completed", conclusion: "failure" }], [{ name: "t", status: "completed", conclusion: "success" }]);
		const run = await start();
		let v = await until(t!.factory, run, inState("ESCALATED"));
		await t!.factory.resolveEscalation(run, v.pendingAsk!.id, { moreRounds: 1 });
		v = await until(t!.factory, run, done);
		expect(v.state).toBe("DELIVERED");
		expect(v.caps.ciFix).toBe(1);
		expect(v.ciFixes).toBe(1);
	});

	test("a failing review after a CI fix counts toward ci.fixRounds, not reviewRoundCap", async () => {
		await setup([["stages.delivery.ci.fixRounds", 1]]);
		t!.host.forceChecks("me/p", [{ name: "t", status: "completed", conclusion: "failure" }]);
		t!.control.reviews = ["pass", "fail"];
		const run = await start();
		const v = await until(t!.factory, run, inState("ESCALATED", "DELIVERED"));
		expect(v.state).toBe("ESCALATED");
		expect(v.escalation).toMatchObject({ cap: "ciFix", from: "REVIEWING" });
		expect(v.reviewRound).toBe(1);
	});

	test("ci.checks limits the checks that count", async () => {
		await setup([["stages.delivery.ci.checks", ["test"]], ["stages.delivery.ci.mode", "required"]]);
		t!.host.forceChecks("me/p", [
			{ name: "lint", status: "completed", conclusion: "failure" },
			{ name: "test", status: "completed", conclusion: "success" },
		]);
		const run = await start();
		const v = await until(t!.factory, run, done);
		expect(v.state).toBe("DELIVERED");
		expect(v.noCi).toBeUndefined();
	});

	test("CI from a real workflow in the repo (local CI runner): pending → green", async () => {
		await setup([["stages.delivery.ci.mode", "required"]]);
		// the builder in this test writes round-N.txt; seed a workflow via the spec artifact path is not possible, so
		// add one to the workspace before delivery through the repo extension (as a builder would)
		const run = await start();
		await until(t!.factory, run, (x) => x.state === "REVIEWING" || x.state === "DELIVERING" || done(x));
		const ws = (await t!.factory.getRun(run)).workspace!;
		const { writeFileSync, mkdirSync } = await import("node:fs");
		mkdirSync(join(ws.path, ".github/workflows"), { recursive: true });
		writeFileSync(join(ws.path, ".github/workflows/ci.yml"), "name: ci\non: [push]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: test -f round-1.txt\n");
		const v = await until(t!.factory, run, done);
		expect(v.state).toBe("DELIVERED");
		expect(v.notices.some((n) => /CI green/.test(n.text))).toBe(true);
	});
});

describe("cancel, failure, retry", () => {
	test("cancel at a pending discussion ask → CANCELLED; retry restores the ask and continues", async () => {
		await setup();
		t!.control.askFirst = true;
		const run = await start();
		let v = await until(t!.factory, run, (x) => !!x.pendingAsk);
		await t!.factory.cancelRun(run, "changed my mind");
		v = await until(t!.factory, run, done);
		expect(v.state).toBe("CANCELLED");
		expect(v.failure).toMatchObject({ state: "DISCUSSING", reason: "changed my mind" });
		expect(v.pendingAsk).toBeUndefined();
		await expect(t!.factory.cancelRun(run)).rejects.toThrow(/already/);
		await t!.factory.retryRun(run);
		v = await until(t!.factory, run, (x) => x.state === "DISCUSSING" && !!x.pendingAsk);
		await t!.factory.answer(run, v.pendingAsk!.id, "Go");
		expect((await until(t!.factory, run, done)).state).toBe("DELIVERED");
	});

	test("cancel at AWAITING_APPROVAL and at AWAITING_CI", async () => {
		await setup([["policy.approvals", ["spec"]]]);
		const run = await start();
		await until(t!.factory, run, inState("AWAITING_APPROVAL"));
		await t!.factory.cancelRun(run);
		expect((await until(t!.factory, run, done)).failure!.state).toBe("AWAITING_APPROVAL");
		await t!.factory.retryRun(run);
		await until(t!.factory, run, inState("AWAITING_APPROVAL"));
		await t!.factory.approve(run, "spec");
		expect((await until(t!.factory, run, done)).state).toBe("DELIVERED");

		await t!.factory.setSetting({ project: "p" }, "policy.approvals", []);
		await t!.factory.setSetting({ project: "p" }, "stages.delivery.ci.noChecksTimeout", "1h");
		const run2 = await start();
		await until(t!.factory, run2, inState("AWAITING_CI"));
		await t!.factory.cancelRun(run2);
		const v2 = await until(t!.factory, run2, done);
		expect(v2.state).toBe("CANCELLED");
		expect(v2.failure!.state).toBe("AWAITING_CI");
	});

	test("cancel mid-build (builder busy) aborts the builder's work → CANCELLED", async () => {
		await setup();
		t!.control.builderHang = true;
		const dbg = (m: string) => process.env.SF_DEBUG && console.error(`[mid-build ${Date.now() % 100000}] ${m}`);
		dbg("start");
		const run = await start();
		dbg("started");
		await until(t!.factory, run, inState("BUILDING"));
		dbg("building");
		await new Promise((r) => setTimeout(r, 300));
		// the scripted provider cannot observe the abort signal; release it shortly after the abort is marked
		const cancelling = t!.factory.cancelRun(run);
		setTimeout(() => (t!.control.builderHang = false), 300);
		await cancelling;
		dbg("cancel returned");
		const v = await until(t!.factory, run, done);
		dbg("done");
		expect(v.state).toBe("CANCELLED");
		expect(v.failure!.state).toBe("BUILDING");
	});

	test("PREPARING error → FAILED", async () => {
		await setup([["stages.repo.workdir", "/dev/null/work"]]);
		const run = await start();
		const v = await until(t!.factory, run, done);
		expect(v.state).toBe("FAILED");
		expect(v.failure!.state).toBe("PREPARING");
	});

	test("DELIVERING error → FAILED; retry resumes at DELIVERING", async () => {
		await setup();
		const orig = t!.host.createRepo.bind(t!.host);
		let fail = true;
		t!.host.createRepo = async (...a: Parameters<typeof orig>) => {
			if (fail) throw new Error("GitHub is down");
			return orig(...a);
		};
		const run = await start();
		let v = await until(t!.factory, run, done);
		expect(v.state).toBe("FAILED");
		expect(v.failure).toMatchObject({ state: "DELIVERING", reason: "GitHub is down" });
		fail = false;
		await t!.factory.retryRun(run);
		v = await until(t!.factory, run, (x) => x.state === "DELIVERED");
		expect(states(v).slice(-4)).toEqual(["FAILED", "DELIVERING", "AWAITING_CI", "DELIVERED"]);
	});

	test("a run is pinned to the config it started with; a settings change applies to new runs only", async () => {
		await setup([["policy.approvals", ["spec"]]]);
		const r1 = await start();
		await until(t!.factory, r1, inState("AWAITING_APPROVAL"));
		const hash1 = (await t!.factory.getRun(r1)).configHash;
		await t!.factory.setSetting(G, "roles.reviewer.model", "scripted/reviewer-strict");
		await t!.factory.setSetting(G, "roles.reviewer.thinking", "low");
		await t!.factory.approve(r1, "spec");
		expect((await until(t!.factory, r1, done)).state).toBe("DELIVERED");
		expect(t!.control.reviewerModels).toEqual(["reviewer"]);
		const r2 = await start();
		await until(t!.factory, r2, inState("AWAITING_APPROVAL"));
		await t!.factory.approve(r2, "spec");
		const v2 = await until(t!.factory, r2, done);
		expect(t!.control.reviewerModels).toEqual(["reviewer", "reviewer-strict"]);
		expect(v2.configHash).not.toBe(hash1);
		const agent = await (await t!.factory.harnessForTests.conversation(v2.conversations.reviewers[0]!.id as never, {} as never))!.agent({} as never);
		expect(agent.model).toEqual({ provider: "scripted", modelId: "reviewer-strict" });
		expect(agent.thinkingLevel).toBe("low");
	});
});

describe("roles and isolation", () => {
	test("read-only roles are not offered write/edit; only the builder gets report_done; helpers get no bridge tools", async () => {
		await setup();
		const run = await start();
		const v = await until(t!.factory, run, done);
		const h = t!.factory.harnessForTests;
		const tools = async (id: string) => (await (await h.conversation(id as never, {} as never))!.agent({} as never)).tools.map((x) => x.name).sort();
		expect(await tools(v.conversations.architect!)).toEqual(["ask_human", "bash", "read", "submit_spec", "web_search"]);
		expect(await tools(v.conversations.builder!)).toEqual(["bash", "edit", "read", "report_done", "run_tests", "subagent", "web_search", "write"]);
		expect(await tools(v.conversations.reviewers[0]!.id)).toEqual(["bash", "http_request", "read", "run_tests", "submit_review", "web_search"]);
	});

	test("delivered artifacts: AGENTS.md pointer is the builder's job; docs/spec.md is committed by the core at SPEC_READY", async () => {
		await setup([["policy.approvals", ["spec"]]]);
		const run = await start();
		const v = await until(t!.factory, run, inState("AWAITING_APPROVAL"));
		const spec = readFileSync(join(v.workspace!.path, "docs/spec.md"), "utf8");
		expect(spec).toContain("## Acceptance behaviours");
		const log = await git(v.workspace!.path, ["log", "--oneline"]);
		expect(log.stdout).toMatch(/docs: spec v1/);
		expect(existsSync(join(v.workspace!.path, ".git"))).toBe(true);
	});
});
