import { chmodSync, mkdirSync } from "node:fs";
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

/**
 * `ModelRuntime.registerNativeProvider` ends with a floating `void this.refresh(...)`, which reads and writes
 * `auth.json` / `models-store.json`. pi does not serialise refreshes, so a second awaited refresh can finish
 * first. Capture the exact promise the registration starts and wait for it, so the host is settled when returned.
 */
async function registerNativeProviderSettled(models: ModelRuntime, provider: Parameters<ModelRuntime["registerNativeProvider"]>[0]) {
	const pending: Promise<unknown>[] = [];
	const refresh = models.refresh;
	models.refresh = (options) => {
		const p = refresh.call(models, options);
		pending.push(p);
		return p;
	};
	try {
		models.registerNativeProvider(provider);
	} finally {
		delete (models as { refresh?: unknown }).refresh; // back to the prototype method
	}
	// A failed refresh surfaces through getError() (availability) or leaves the static models in place.
	await Promise.allSettled(pending);
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
	chmodSync(agentDir, 0o700); // tighten a pre-existing dir too
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
	if (opts.scripted) {
		const { scriptedProvider } = await import("../testing/scripted.ts");
		const { DRY_RUN_SCRIPTS } = await import("../testing/dry-run-agents.ts");
		await registerNativeProviderSettled(models, scriptedProvider(DRY_RUN_SCRIPTS).provider);
	}
	// getError() joins config, provider-composition and availability errors with blank lines.
	const seen = new Set<string>();
	for (const part of (models.getError() ?? "").split("\n\n")) {
		const message = part.trim();
		if (!message || seen.has(message)) continue;
		seen.add(message);
		diagnostics.push({ type: "error", message });
	}
	return { models, packages, agentDir, diagnostics };
}
