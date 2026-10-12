// Child process for the crash/resume tests: runs a factory on SQLite until the parent SIGKILLs it.
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DiscussionView } from "../../src/core/types.ts";
import { makeFactory, newControl } from "../helpers.ts";

const dir = process.argv[2]!;
// "mid-build" | "approval" | "helper" | "qa" | "bundle-conflict" | "legacy-ci" | "disc-say" | "disc-draft" | "disc-ticket"
const mode = process.argv[3]!;
const control = newControl();
control.reviews = mode === "mid-build" ? ["fail", "pass"] : ["pass"];
const t = await makeFactory({ dir, storage: "sqlite", control, config: process.env.SF_CONFIG });
const f = t.factory;
type Ready = (extra: Record<string, unknown>) => Promise<void>;
const poll = (cond: () => Promise<Record<string, unknown> | undefined>, ready: Ready) => {
	const check = setInterval(async () => {
		const extra = await cond().catch(() => undefined);
		if (extra) {
			clearInterval(check);
			await ready(extra);
		}
	}, 20);
};

/** Runs: the run's id goes to "run-id", its view (and `extra`) to "ready". */
async function runModes() {
	await f.createProject("todo", "me/todo");
	if (mode === "approval") await f.setSetting({ project: "todo" }, "policy.approvals", ["spec"]);
	if (mode === "helper") {
		control.builderSubagent = true;
		control.helperHang = true; // the helper hangs after its first write landed
	}
	if (mode === "qa") {
		await f.setSetting({ project: "todo" }, "qa.enabled", true);
		control.runScript = true;
		control.qaHang = true; // the QA agent hangs after its screenshot
	}
	const run = await f.startRun("todo", { source: "test", title: "todo", body: "CLI todo" });
	writeFileSync(join(dir, "run-id"), run);
	const ready: Ready = async (extra) => {
		const v = await f.getRun(run);
		writeFileSync(join(dir, "ready"), JSON.stringify({ ...v, ...extra }));
	};
	if (mode === "mid-build") {
		// hang the builder in its second round (after a failed review), then tell the parent
		control.hangAtInput = 2;
		poll(async () => (control.builderInputs.length >= 2 && control.builderHang ? {} : undefined), ready);
	} else if (mode === "approval") {
		poll(async () => ((await f.getRun(run)).state === "AWAITING_APPROVAL" ? {} : undefined), ready);
	} else if (mode === "helper") {
		poll(async () => {
			const v = await f.getRun(run);
			if (!v.workspace || !existsSync(join(v.workspace.path, "helper.txt")) || !v.conversations.builder) return undefined;
			const tr = await f.getConversation(run, v.conversations.builder);
			return tr.helpers.length ? { helper: String(tr.helpers[0]) } : undefined;
		}, ready);
	} else {
		poll(async () => {
			const v = await f.getRun(run);
			return v.reviews[0]?.submitted.review && existsSync(join(dir, "state", "artifacts", run, "screenshots", "r1-s1.png")) ? {} : undefined;
		}, ready);
	}
}

/**
 * "bundle-conflict": two runs of an existing repo write conflicting shared.txt; both reach READY, then a bundle of both
 * hangs in INTEGRATING with the integrator on the conflict. The bundle's id goes to "bundle-id" (the runs' ids, comma-
 * separated, to "run-id"), its view to "ready".
 */
async function bundleConflict() {
	control.sharedFile = true;
	control.reviews = [];
	await t.host.seedRepo("me/todo", { "README.md": "# todo\n", "AGENTS.md": "Test: true\n" });
	await f.createProject("todo", "me/todo");
	const a = await f.startRun("todo", { source: "test", title: "alpha", body: "make alpha" });
	const b = await f.startRun("todo", { source: "test", title: "beta", body: "make beta" });
	writeFileSync(join(dir, "run-id"), `${a},${b}`);
	const end = (v: { state: string }) => ["READY", "FAILED", "CANCELLED"].includes(v.state);
	const [ra, rb] = await Promise.all([f.waitForState(a, end, 60_000), f.waitForState(b, end, 60_000)]);
	if (ra.state !== "READY" || rb.state !== "READY") throw new Error(`runs not READY: ${ra.state} ${rb.state}`);
	control.integratorHang = true;
	const id = await f.createBundle("todo", [a, b]);
	writeFileSync(join(dir, "bundle-id"), id);
	poll(
		async () => {
			const v = await f.getBundle(id);
			return v.state === "INTEGRATING" && v.integration?.conflict && v.conversations.integrator && control.integratorInputs.length === 1 ? {} : undefined;
		},
		async (extra) => writeFileSync(join(dir, "ready"), JSON.stringify({ ...(await f.getBundle(id)), ...extra })),
	);
}

/**
 * "legacy-ci": a run of an existing repo, marked legacy while it waits at the delivery gate, delivers the old way (its
 * own PR) and waits in AWAITING_CI: the delivered commit's checks are forced to stay in progress (the parent turns
 * them green in the fake GitHub's state file after the kill).
 */
async function legacyCi() {
	await t.host.seedRepo("me/todo", { "README.md": "# todo\n", "AGENTS.md": "Test: true\n" });
	await f.createProject("todo", "me/todo");
	await f.setSetting({ project: "todo" }, "policy.approvals", ["delivery"]);
	const run = await f.startRun("todo", { source: "test", title: "todo", body: "CLI todo" });
	writeFileSync(join(dir, "run-id"), run);
	const v = await f.waitForState(run, (x) => x.state === "AWAITING_APPROVAL" || x.state === "FAILED", 60_000);
	const q = v.pendingAsk?.question as { kind?: string; gate?: string } | undefined;
	if (q?.kind !== "approval" || q.gate !== "delivery") throw new Error(`not at the delivery gate: ${v.state} ${JSON.stringify(q)}`);
	await f.patchRunForTests(run, (d) => {
		d.legacy = true;
	});
	// the only new commit checked in this repo is the delivered one: its checks stay in progress
	t.host.forceChecks("me/todo", [{ name: "ci", status: "in_progress" }]);
	await f.approve(run, "delivery");
	poll(
		async () => {
			const x = await f.getRun(run);
			const sha = x.artifacts.delivery?.sha;
			return x.state === "AWAITING_CI" && sha && t.host.state().checks[`me/todo@${sha}`] ? {} : undefined;
		},
		async (extra) => writeFileSync(join(dir, "ready"), JSON.stringify({ ...(await f.getRun(run)), ...extra })),
	);
}

/** Discussions: the discussion's id goes to "run-id", its view (and `extra`) to "ready". */
async function discussionModes() {
	await t.host.seedRepo("me/p", { "README.md": "# p\n" });
	await f.createProject("p", "me/p");
	const id = await f.startDiscussion("p", { title: "t", message: "m" });
	writeFileSync(join(dir, "run-id"), id);
	const open = (v: DiscussionView) => v.state === "OPEN" && v.turn === null;
	await f.waitForDiscussion(id, open);
	const ready: Ready = async (extra) => writeFileSync(join(dir, "ready"), JSON.stringify({ ...(await f.getDiscussion(id)), ...extra }));
	if (mode === "disc-say") {
		// the discussant hangs in its reply to "slow"
		control.discussantHang = true;
		await f.say(id, "slow");
		poll(async () => (control.discussantHeard.includes("slow") ? {} : undefined), ready);
	} else if (mode === "disc-draft") {
		// submit_tickets is recorded, then the discussant hangs on its next step, before the turn ends
		control.draftPlan = ["ok-then-hang"];
		await f.requestDrafts(id);
		poll(async () => (control.discussantHang ? {} : undefined), ready);
	} else {
		// "disc-ticket": the parent kills the child as soon as createTicket has committed
		await f.requestDrafts(id);
		await f.waitForDiscussion(id, (v) => open(v) && v.drafts.length === 2);
		const runId = await f.createTicket(id, "D1");
		await ready({ runId });
	}
}

await (mode.startsWith("disc-") ? discussionModes() : mode === "bundle-conflict" ? bundleConflict() : mode === "legacy-ci" ? legacyCi() : runModes());
setInterval(() => {}, 1000);
