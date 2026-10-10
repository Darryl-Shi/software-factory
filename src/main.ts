// The factory process: the one process that owns the storage and the core. It points `store:` secret refs at
// <factoryHome>/secrets.json, builds the model host (pi's ModelRuntime over <factoryHome>/pi), a GitHub on
// a GhApiHost (or a LocalGitHubHost with --fake-github) and a Sandbox, hands them to the Factory, which opens the
// storage, and then starts the web server, the factory's interface. A busy web port stops it before any run resumes.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Boat } from "./boat/boat.ts";
import { BoatApiBackend, type BoatBackend, LocalBoatBackend } from "./boat/backend.ts";
import { Factory } from "./core/core.ts";
import { expandHome, setDefaultSecretStore } from "./core/settings.ts";
import { GitHub } from "./github/github.ts";
import { GhApiHost, type GitHubHost, LocalGitHubHost } from "./github/host.ts";
import { createModelHost } from "./models/host.ts";
import { Sandbox } from "./sandbox/sandbox.ts";
import { SecretStore, secretsPath } from "./secrets/store.ts";
import { startWebServer } from "./web/server.ts";

export interface ProcessOptions {
	configPath?: string;
	/** Use a fake GitHub on the local disk (bare remotes + local CI runner) instead of github.com. */
	fakeGithub?: string;
	/** Use a fake boat.dev on the local disk (a VM is a directory, a stub cua-driver) instead of boat's API. */
	fakeBoat?: string;
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

/** Boat on boat.dev's API, or on a LocalBoatBackend under `fake` (dry runs, tests). */
export function createBoat(configPath: string, fake?: string): Boat {
	let local: BoatBackend | undefined;
	return new Boat({
		stateDir: join(factoryHome(configPath), "qa-vms"),
		backend: fake ? () => (local ??= new LocalBoatBackend(expandHome(fake))) : (key) => new BoatApiBackend(key),
		...(fake ? { retryDelayMs: 100, bootWaitMs: 1000 } : {}),
	});
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

/** Whether any role's model provider (global or any project) has credentials; serve still starts without. */
async function anyRoleHasCredentials(factory: Factory, models: ModelRuntime): Promise<boolean> {
	const scopes = [{ global: true } as const, ...factory.config.projects().map((p) => ({ project: p.name }))];
	const providers = new Set<string>();
	for (const s of scopes) {
		const roles = factory.config.effective(s).roles ?? {};
		for (const r of Object.values(roles) as { model?: unknown }[]) if (typeof r?.model === "string") providers.add(r.model.split("/")[0]!);
	}
	for (const p of providers) if (await models.checkAuth(p).catch(() => undefined)) return true;
	return false;
}

export async function startFactoryProcess(opts: ProcessOptions = {}): Promise<FactoryProcess> {
	const configPath = expandHome(opts.configPath ?? process.env.FACTORY_CONFIG ?? DEFAULT_CONFIG);
	if (!existsSync(configPath)) {
		mkdirSync(dirname(configPath), { recursive: true });
		writeFileSync(configPath, "version: 1\n");
	}
	const log = opts.log ?? ((m: string) => console.error(`[factory] ${m}`));
	const home = factoryHome(configPath);
	setDefaultSecretStore(new SecretStore(secretsPath(home)));
	const modelHost = await createModelHost({ factoryHome: home, ...(opts.scripted ? { scripted: true } : {}) });
	for (const d of modelHost.diagnostics) log(`extension: ${d.message}`);
	const ghHost: GitHubHost = opts.fakeGithub ? new LocalGitHubHost(expandHome(opts.fakeGithub)) : new GhApiHost();
	const factory = new Factory({
		configPath,
		models: modelHost.models,
		github: new GitHub(ghHost),
		sandbox: new Sandbox({ stateDir: join(factoryHome(configPath), "environments") }),
		boat: createBoat(configPath, opts.fakeBoat),
		...(opts.ciPollMs ? { ciPollMs: opts.ciPollMs } : {}),
		log,
	});
	// A config problem here is reported by factory.start() below, not by this hint.
	if (!(await anyRoleHasCredentials(factory, modelHost.models).catch(() => true))) log("no model credentials configured; run factory setup");
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
