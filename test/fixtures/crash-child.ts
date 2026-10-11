// Child process for the crash/resume tests: runs a factory on SQLite until the parent SIGKILLs it.
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DiscussionView } from "../../src/core/types.ts";
import { makeFactory, newControl } from "../helpers.ts";

const dir = process.argv[2]!;
const mode = process.argv[3]!; // "mid-build" | "approval" | "helper" | "qa" | "disc-say" | "disc-draft" | "disc-ticket"
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

await (mode.startsWith("disc-") ? discussionModes() : runModes());
setInterval(() => {}, 1000);
