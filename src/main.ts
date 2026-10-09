// The factory process: the one process that owns the storage and the core (spec §3.6 "Transport belongs to the
// extension"). It wires the platform services (pi-ai models, storage) into the core through dependency injection,
// installs the factory extensions and the worker extensions, and starts the configured interface extensions.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Models } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { Factory } from "./core/core.ts";
import { expandHome } from "./core/settings.ts";
import type { FactoryExtension } from "./core/types.ts";
import { cliInterface } from "./extensions/cli/server.ts";
import { githubDelivery } from "./extensions/github/delivery.ts";
import { GhApiHost, type GitHubHost, LocalGitHubHost } from "./extensions/github/host.ts";
import { githubRepo } from "./extensions/github/repo.ts";
import { localWorktree } from "./extensions/local-worktree/index.ts";
import { webInterface } from "./extensions/web/server.ts";
import { DEFAULT_WORKER_EXTENSIONS, DEFAULT_WORKER_SETTINGS } from "./extensions/workers/index.ts";

export interface ProcessOptions {
	configPath?: string;
	/** Use a fake GitHub on the local disk (bare remotes + local CI runner) instead of github.com. */
	fakeGithub?: string;
	/** Register the scripted dry-run agents as provider "scripted" (no credentials needed). */
	scripted?: boolean;
	socket?: string;
	/** Port of the web interface (overrides stages.interface.port; 0 picks a free port). */
	webPort?: number;
	ciPollMs?: number;
	log?: (m: string) => void;
	extraExtensions?: FactoryExtension[];
}

export const DEFAULT_CONFIG = "~/.factory/config.yaml";

export function factoryHome(configPath: string) {
	return dirname(configPath);
}

export async function createModels(scripted: boolean): Promise<Models> {
	// pi-ai providers read their credentials from the environment / secret store (platform service, §3.1).
	const models = builtinModels();
	if (scripted) {
		const { scriptedProvider } = await import("./testing/scripted.ts");
		const { DRY_RUN_SCRIPTS } = await import("./testing/dry-run-agents.ts");
		models.setProvider(scriptedProvider(DRY_RUN_SCRIPTS).provider);
	}
	return models;
}

export async function startFactoryProcess(opts: ProcessOptions = {}) {
	const configPath = expandHome(opts.configPath ?? process.env.FACTORY_CONFIG ?? DEFAULT_CONFIG);
	if (!existsSync(configPath)) {
		mkdirSync(dirname(configPath), { recursive: true });
		writeFileSync(configPath, "version: 1\n");
	}
	const log = opts.log ?? ((m: string) => console.error(`[factory] ${m}`));
	const host: GitHubHost = opts.fakeGithub ? new LocalGitHubHost(expandHome(opts.fakeGithub)) : new GhApiHost();
	const factory = new Factory({
		configPath,
		models: await createModels(!!opts.scripted),
		extensions: [
			githubRepo(host),
			githubDelivery(host),
			localWorktree({ stateDir: join(factoryHome(configPath), "environments") }),
			cliInterface(opts.socket ? { socket: opts.socket } : {}),
			webInterface({ tokenFile: join(factoryHome(configPath), "web-token"), ...(opts.webPort !== undefined ? { port: opts.webPort } : {}), log }),
			...(opts.extraExtensions ?? []),
		],
		workerExtensions: DEFAULT_WORKER_EXTENSIONS,
		workerSettings: DEFAULT_WORKER_SETTINGS,
		...(opts.ciPollMs ? { ciPollMs: opts.ciPollMs } : {}),
		log,
	});
	await factory.start();
	await factory.startInterfaces();
	return { factory, host };
}
