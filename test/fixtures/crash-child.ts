// Child process for the crash/resume tests: runs a factory on SQLite until the parent SIGKILLs it.
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeFactory, newControl } from "../helpers.ts";

const dir = process.argv[2]!;
const mode = process.argv[3]!; // "mid-build" | "approval" | "helper" | "qa"
const control = newControl();
control.reviews = mode === "mid-build" ? ["fail", "pass"] : ["pass"];
const t = await makeFactory({ dir, storage: "sqlite", control, config: process.env.SF_CONFIG });
const f = t.factory;
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
const ready = (extra: Record<string, unknown> = {}) => async () => {
	const v = await f.getRun(run);
	writeFileSync(join(dir, "ready"), JSON.stringify({ ...v, ...extra }));
};
const poll = (cond: () => Promise<Record<string, unknown> | undefined>) => {
	const check = setInterval(async () => {
		const extra = await cond().catch(() => undefined);
		if (extra) {
			clearInterval(check);
			await ready(extra)();
		}
	}, 20);
};
if (mode === "mid-build") {
	// hang the builder in its second round (after a failed review), then tell the parent
	control.hangAtInput = 2;
	poll(async () => (control.builderInputs.length >= 2 && control.builderHang ? {} : undefined));
} else if (mode === "approval") {
	poll(async () => ((await f.getRun(run)).state === "AWAITING_APPROVAL" ? {} : undefined));
} else if (mode === "helper") {
	poll(async () => {
		const v = await f.getRun(run);
		if (!v.workspace || !existsSync(join(v.workspace.path, "helper.txt")) || !v.conversations.builder) return undefined;
		const tr = await f.getConversation(run, v.conversations.builder);
		return tr.helpers.length ? { helper: String(tr.helpers[0]) } : undefined;
	});
} else {
	poll(async () => {
		const v = await f.getRun(run);
		return v.reviews[0]?.submitted.review && existsSync(join(dir, "state", "artifacts", run, "screenshots", "r1-s1.png")) ? {} : undefined;
	});
}
setInterval(() => {}, 1000);
