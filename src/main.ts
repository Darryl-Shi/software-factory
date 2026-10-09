// The factory process: the one process that owns the storage and the core. It creates the pi-ai models, a GitHub on
// a GhApiHost (or a LocalGitHubHost with --fake-github) and a Sandbox, hands them to the Factory, which opens the
// storage, and then starts the web server, the factory's interface. A busy web port stops it before any run resumes.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
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
	web: { url: string; stop(): Promise<void> };
	/** Stops the web server, then the factory. */
	close(): Promise<void>;
}

/** Throws startWebServer's message if host:port is taken (listens on it, then closes). */
function probePort(host: string, port: number): Promise<void> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.once("error", (e: NodeJS.ErrnoException) =>
			reject(e.code === "EADDRINUSE" ? new Error(`web UI: ${host}:${port} is in use (set web.port or pass --port)`) : e),
		);
		server.listen(port, host, () => server.close(() => resolve()));
	});
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
	const cfg = factory.config.effective({ global: true }).web;
	const webHost = String(cfg.host);
	const webPort = opts.webPort ?? Number(cfg.port);
	// Fail on a busy port before start() resumes any run; startWebServer below is the real check.
	if (webPort !== 0) await probePort(webHost, webPort);
	await factory.start();
	let web: FactoryProcess["web"];
	try {
		web = await startWebServer(factory.as("web"), {
			host: webHost,
			port: webPort,
			tokenFile: join(factoryHome(configPath), "web-token"),
			log,
		});
	} catch (e) {
		await factory.close().catch(() => {});
		throw e;
	}
	return {
		factory,
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
