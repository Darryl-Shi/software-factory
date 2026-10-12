// Setup context (spec §3.3): what every setup step works with. The settings it hands out are the factory's own
// validated ConfigStore (the same validate-on-save the web UI uses), over the current model host's models.
import { execFile, type ExecFileException } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Boat } from "../boat/boat.ts";
import { Factory } from "../core/core.ts";
import { type ConfigStore, expandHome, setDefaultSecretStore } from "../core/settings.ts";
import { livePid } from "../daemon.ts";
import { type DoctorLine, runDoctorChecks } from "../doctor.ts";
import { GitHub } from "../github/github.ts";
import { GhApiHost } from "../github/host.ts";
import { createBoat, factoryHome } from "../main.ts";
import { createModelHost, type ModelHost } from "../models/host.ts";
import { Sandbox } from "../sandbox/sandbox.ts";
import { SecretStore, secretsPath } from "../secrets/store.ts";
import { detectService, restartFactory, runCommand as runRestart } from "../update/restart.ts";
import type { SetupUi } from "./ui.ts";

export const SECTIONS = ["prereqs", "github", "models", "roles", "qa", "search", "service"] as const;
export type SectionName = (typeof SECTIONS)[number];

export interface StepStatus {
	state: "ok" | "warn" | "missing";
	detail: string;
}

/** One setup section. `status` is cheap and side-effect free; `run` prompts, verifies and saves. */
export interface Step {
	name: SectionName;
	title: string;
	status(ctx: SetupContext): Promise<StepStatus>;
	run(ctx: SetupContext): Promise<void>;
}

export type RunResult = { code: number; stdout: string; stderr: string };

export interface SetupContext {
	configPath: string;
	factoryHome: string;
	repoRoot: string;
	ui: SetupUi;
	secrets: SecretStore;
	/** The model host over `<factoryHome>/pi`, built on first use and cached. */
	host(): Promise<ModelHost>;
	/** Rebuilds the host after a packages/models.json change; also rebuilds `settings()`. */
	reloadHost(): Promise<ModelHost>;
	/** The factory's validated ConfigStore over the current host's models. */
	settings(): Promise<ConfigStore>;
	boat: Boat;
	fetch: typeof fetch;
	/** Runs a command; never throws on a non-zero exit. A missing binary gives code 127. */
	run(cmd: string, args: string[], opts?: { input?: string; env?: Record<string, string> }): Promise<RunResult>;
	platform: NodeJS.Platform;
	env: NodeJS.ProcessEnv;
	homedir: string;
	daemon: { pid(): number | undefined; restart(): Promise<void> };
	doctor(): Promise<DoctorLine[]>;
	/** Set by a step when packages/models.json changed; the wizard offers a restart at section end. */
	needsRestart: boolean;
}

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** `execFile` that resolves with the exit code instead of rejecting; ENOENT (no such binary) is code 127. */
export function runCommand(cmd: string, args: string[], opts: { input?: string; env?: Record<string, string> } = {}): Promise<RunResult> {
	return new Promise((done) => {
		const child = execFile(
			cmd,
			args,
			{ env: opts.env ? { ...process.env, ...opts.env } : process.env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
			(err: ExecFileException | null, stdout: string, stderr: string) => {
				if (!err) return done({ code: 0, stdout, stderr });
				if (err.code === "ENOENT") return done({ code: 127, stdout, stderr: stderr || `${cmd}: command not found` });
				if (typeof err.code === "number") return done({ code: err.code, stdout, stderr });
				done({ code: 1, stdout, stderr: stderr || err.message }); // killed by a signal, or a spawn error
			},
		);
		child.stdin?.on("error", () => {}); // EPIPE: the command exited without reading its input
		child.stdin?.end(opts.input ?? "");
	});
}

/** The parts of a SetupContext that differ between the CLI and tests; everything else is derived. */
export interface SetupContextParts {
	configPath: string;
	ui: SetupUi;
	secrets: SecretStore;
	makeHost: () => Promise<ModelHost>;
	boat: Boat;
	fetch: typeof fetch;
	run: SetupContext["run"];
	platform: NodeJS.Platform;
	env: NodeJS.ProcessEnv;
	homedir: string;
	daemon: SetupContext["daemon"];
	/** Default: `runDoctorChecks(configPath, { host: await ctx.host() })`. */
	doctor?: SetupContext["doctor"];
}

/** Assembles a SetupContext: a cached host, and settings rebuilt with the host. */
export function buildSetupContext(p: SetupContextParts): SetupContext {
	let host: Promise<ModelHost> | undefined;
	let settings: Promise<ConfigStore> | undefined;
	const home = factoryHome(p.configPath);
	const settingsOver = async (h: Promise<ModelHost>): Promise<ConfigStore> =>
		new Factory({
			configPath: p.configPath,
			models: (await h).models,
			github: new GitHub(new GhApiHost()),
			sandbox: new Sandbox({ stateDir: join(home, "environments") }),
			boat: p.boat,
		}).config;
	const ctx: SetupContext = {
		configPath: p.configPath,
		factoryHome: home,
		repoRoot,
		ui: p.ui,
		secrets: p.secrets,
		host() {
			host ??= p.makeHost();
			return host;
		},
		reloadHost() {
			const next = p.makeHost();
			host = next;
			settings = undefined;
			return next;
		},
		settings() {
			if (settings) return settings;
			const current = (settings = settingsOver(ctx.host()));
			// A failed build is not cached, so the next call retries.
			current.catch(() => {
				if (settings === current) settings = undefined;
			});
			return current;
		},
		boat: p.boat,
		fetch: p.fetch,
		run: p.run,
		platform: p.platform,
		env: p.env,
		homedir: p.homedir,
		daemon: p.daemon,
		doctor: p.doctor ?? (async () => runDoctorChecks(p.configPath, { host: await ctx.host() })),
		needsRestart: false,
	};
	return ctx;
}

/** Restarts the running factory the way it was started: systemd unit, launchd agent, or `factory serve` daemon
 * (src/update/restart.ts, shared with the updater's restart helper). */
async function restartRunningFactory(configPath: string): Promise<void> {
	const how = await detectService(runRestart, process.platform);
	await restartFactory(how, { configPath, root: repoRoot, serveArgs: [], run: runRestart });
}

/** The CLI's context: the real secret store (also the default for `store:` refs), host, boat, commands and daemon. */
export function createSetupContext(opts: { configPath: string; ui: SetupUi; fakeBoat?: string }): SetupContext {
	const configPath = expandHome(opts.configPath);
	const home = factoryHome(configPath);
	const secrets = new SecretStore(secretsPath(home));
	setDefaultSecretStore(secrets);
	return buildSetupContext({
		configPath,
		ui: opts.ui,
		secrets,
		makeHost: () => createModelHost({ factoryHome: home }),
		boat: createBoat(configPath, opts.fakeBoat),
		fetch: globalThis.fetch,
		run: runCommand,
		platform: process.platform,
		env: process.env,
		homedir: homedir(),
		daemon: {
			pid: () => livePid(configPath),
			restart: () => restartRunningFactory(configPath),
		},
	});
}
