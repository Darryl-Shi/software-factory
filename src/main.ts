// The factory process: the one process that owns the storage and the core (spec §3.6 "Transport belongs to the
// extension"). It wires the platform services (pi-ai models, storage) into the core through dependency injection,
// installs the factory extensions, and starts the web server.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Models } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { Factory } from "./core/core.ts";
import { expandHome } from "./core/settings.ts";
import { GitHub } from "./github/github.ts";
import { GhApiHost, type GitHubHost, LocalGitHubHost } from "./github/host.ts";
import { Sandbox } from "./sandbox/sandbox.ts";
import { startWebServer } from "./web/server.ts";

export interface ProcessOptions {
	configPath?: string;
	/** Use a fake GitHub on the local disk (bare remotes + local CI runner) instead of github.com. */
	fakeGithub?: string;
	/** Register the scripted dry-run agents as provider "scripted" (no credentials needed). */
	scripted?: boolean;
	/** Port of the web UI (overrides web.port; 0 picks a free port). */
	webPort?: number;
	ciPollMs?: number;
	log?: (m: string) => void;
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

export interface FactoryProcess {
	factory: Factory;
	host: GitHubHost;
	web: { url: string; stop(): Promise<void> };
	/** Stops the web server, then the factory. */
	close(): Promise<void>;
}

export async function startFactoryProcess(opts: ProcessOptions = {}): Promise<FactoryProcess> {
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
		github: new GitHub(host),
		sandbox: new Sandbox({ stateDir: join(factoryHome(configPath), "environments") }),
		...(opts.ciPollMs ? { ciPollMs: opts.ciPollMs } : {}),
		log,
	});
	await factory.start();
	const cfg = factory.config.effective({ global: true }).web;
	let web: FactoryProcess["web"];
	try {
		web = await startWebServer(factory.as("web"), {
			host: String(cfg.host),
			port: opts.webPort ?? Number(cfg.port),
			tokenFile: join(factoryHome(configPath), "web-token"),
			log,
		});
	} catch (e) {
		await factory.close().catch(() => {});
		throw e;
	}
	return {
		factory,
		host,
		web,
		async close() {
			try {
				await web.stop();
			} finally {
				await factory.close();
			}
		},
	};
}
