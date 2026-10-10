// Setup section "service" (spec §3.4): stub, replaced by its section task.
import type { Step } from "../context.ts";

export const step: Step = {
	name: "service",
	title: "Service",
	async status() {
		return { state: "missing", detail: "not implemented" };
	},
	async run(ctx) {
		ctx.ui.log.warn("not implemented");
	},
};
