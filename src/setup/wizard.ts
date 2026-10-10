// `factory setup` (spec §3.1): the status summary, the sections in order (or one section), the doctor checks and the
// outro. Each section saves as it finishes, so a cancel keeps the sections already completed.
import { existsSync, readFileSync } from "node:fs";
import { assertNoLegacySections } from "../core/settings.ts";
import { daemonFiles } from "../daemon.ts";
import { formatDoctorLine } from "../doctor.ts";
import { SECTIONS, type SetupContext, type Step, type StepStatus } from "./context.ts";
import { STEPS } from "./steps/index.ts";
import { SetupCancelled } from "./ui.ts";

const ICON: Record<StepStatus["state"], string> = { ok: "✔", warn: "⚠", missing: "✖" };

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** A status that throws (e.g. secrets.json with a bad mode) shows as missing, with the error as its detail. */
async function statusOf(step: Step, ctx: SetupContext): Promise<StepStatus> {
	try {
		return await step.status(ctx);
	} catch (e) {
		if (e instanceof SetupCancelled) throw e;
		return { state: "missing", detail: message(e) };
	}
}

/** After a step: a step that changed packages or models.json needs a restart of a running factory to take effect. */
async function offerRestart(ctx: SetupContext): Promise<void> {
	if (!ctx.needsRestart || ctx.daemon.pid() === undefined) return;
	if (!(await ctx.ui.confirm({ message: "Restart the factory to load the new providers?", initial: true }))) return;
	await ctx.daemon.restart();
	ctx.needsRestart = false;
}

/** The web UI link when the factory runs and has written one. */
function runningUrl(ctx: SetupContext): string | undefined {
	const file = daemonFiles(ctx.configPath).url;
	if (ctx.daemon.pid() === undefined || !existsSync(file)) return undefined;
	return readFileSync(file, "utf8").trim() || undefined;
}

/** Runs setup (all sections, or one); returns the exit code: 0 done, 1 usage/config error, 130 cancelled. */
export async function runSetup(ctx: SetupContext, section?: string, steps: Step[] = STEPS): Promise<number> {
	const { ui } = ctx;
	if (section !== undefined && !(SECTIONS as readonly string[]).includes(section)) {
		ui.log.error(`unknown section ${section}; sections: ${SECTIONS.join(", ")}`);
		return 1;
	}
	try {
		assertNoLegacySections(ctx.configPath);
	} catch (e) {
		ui.log.error(message(e));
		return 1;
	}
	try {
		if (section !== undefined) {
			const step = steps.find((s) => s.name === section);
			if (!step) throw new Error(`no step for section ${section}`);
			await step.run(ctx);
			await offerRestart(ctx);
			return 0;
		}
		ui.intro("factory setup");
		const summary: string[] = [];
		for (const step of steps) {
			const s = await statusOf(step, ctx);
			summary.push(`${ICON[s.state]} ${step.title} — ${s.detail}`);
		}
		ui.note(summary.join("\n"), "Status");
		for (const step of steps) {
			// Re-read: an earlier section may have changed this one's status (e.g. models → roles).
			const s = await statusOf(step, ctx);
			if (s.state === "ok" && !(await ui.confirm({ message: `Reconfigure ${step.title}?`, initial: false }))) continue;
			await step.run(ctx);
			await offerRestart(ctx);
		}
		ui.note((await ctx.doctor()).map(formatDoctorLine).join("\n"), "Checks");
		const url = runningUrl(ctx);
		ui.outro(url ? `factory is running: ${url}` : "next: factory serve");
		return 0;
	} catch (e) {
		if (e instanceof SetupCancelled) {
			ui.log.warn("setup cancelled; completed sections were saved");
			return 130;
		}
		ui.log.error(message(e));
		return 1;
	}
}
