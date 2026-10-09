// Child process for the crash/resume test: runs a factory on SQLite until the parent SIGKILLs it.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeFactory, newControl } from "../helpers.ts";

const dir = process.argv[2]!;
const mode = process.argv[3]!; // "mid-build" | "approval"
const control = newControl();
control.reviews = ["fail", "pass"];
const t = await makeFactory({ dir, storage: "sqlite", control, config: process.env.SF_CONFIG });
const f = t.factory;
await f.createProject("todo", "me/todo");
if (mode === "approval") await f.setSetting({ project: "todo" }, "policy.approvals", ["spec"]);
const run = await f.startRun("todo", { source: "test", title: "todo", body: "CLI todo" });
writeFileSync(join(dir, "run-id"), run);
if (mode === "mid-build") {
	// hang the builder in its second round (after a failed review), then tell the parent
	control.hangAtInput = 2;
	const check = setInterval(async () => {
		const v = await f.getRun(run);
		if (control.builderInputs.length >= 2 && control.builderHang) {
			writeFileSync(join(dir, "ready"), JSON.stringify(v));
			clearInterval(check);
		}
	}, 20);
} else {
	const check = setInterval(async () => {
		const v = await f.getRun(run);
		if (v.state === "AWAITING_APPROVAL") {
			writeFileSync(join(dir, "ready"), JSON.stringify(v));
			clearInterval(check);
		}
	}, 20);
}
setInterval(() => {}, 1000);
