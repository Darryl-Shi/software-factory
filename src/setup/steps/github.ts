// Setup section "github" (spec §3.4): stub, replaced by its section task.
import type { Step } from "../context.ts";

export const step: Step = {
	name: "github",
	title: "GitHub",
	async status() {
		return { state: "missing", detail: "not implemented" };
	},
	async run(ctx) {
		ctx.ui.log.warn("not implemented");
	},
};
