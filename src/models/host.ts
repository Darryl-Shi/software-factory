import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createAgentSessionServices, DefaultPackageManager, type ModelRuntime } from "@earendil-works/pi-coding-agent";

/** The factory's model host: pi's ModelRuntime and package manager over its own agent dir (spec §1, §2.1). */
export interface ModelHost {
	models: ModelRuntime;
	packages: DefaultPackageManager;
	agentDir: string;
	/** Non-fatal problems while loading extensions, packages and models.json. */
	diagnostics: { type: "error" | "warning"; message: string }[];
}

/** pi's agent dir for this factory: `<factoryHome>/pi` (never ~/.pi/agent). */
export function agentDirOf(factoryHome: string): string {
	return join(factoryHome, "pi");
}

/**
 * Builds pi's model runtime from `<factoryHome>/pi`: built-in providers, `models.json`, `auth.json`
 * and installed pi packages. cwd is the agent dir, so no project-local `.pi/` resources load.
 * Extension and models.json errors become diagnostics; they never throw.
 */
export async function createModelHost(opts: { factoryHome: string; scripted?: boolean }): Promise<ModelHost> {
	const agentDir = agentDirOf(opts.factoryHome);
	mkdirSync(agentDir, { recursive: true, mode: 0o700 });
	const services = await createAgentSessionServices({ cwd: agentDir, agentDir });
	const models = services.modelRuntime;
	const packages = new DefaultPackageManager({ cwd: agentDir, agentDir, settingsManager: services.settingsManager });
	const diagnostics: ModelHost["diagnostics"] = services.diagnostics
		.filter((d): d is typeof d & { type: "error" | "warning" } => d.type === "error" || d.type === "warning")
		.map((d) => ({ type: d.type, message: d.message }));
	// Extension load failures (a throwing factory, a missing file) are reported by the resource loader, not services.
	const extensions = services.resourceLoader.getExtensions();
	for (const e of extensions.errors) diagnostics.push({ type: "error", message: `Extension "${e.path}" error: ${e.error}` });
	for (const w of extensions.warnings ?? []) diagnostics.push({ type: "warning", message: `Extension "${w.path}": ${w.warning}` });
	const error = models.getError();
	if (error && !diagnostics.some((d) => d.message === error)) diagnostics.push({ type: "error", message: error });
	if (opts.scripted) {
		const { scriptedProvider } = await import("../testing/scripted.ts");
		const { DRY_RUN_SCRIPTS } = await import("../testing/dry-run-agents.ts");
		models.registerNativeProvider(scriptedProvider(DRY_RUN_SCRIPTS).provider);
	}
	return { models, packages, agentDir, diagnostics };
}
