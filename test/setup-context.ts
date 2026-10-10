// testContext: a SetupContext over a temp factory home for setup tests (spec §6). Real SecretStore, real model host
// (with the scripted provider), ScriptedUi; commands, fetch, the daemon and doctor are stubs unless given.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished } from "vitest";
import { setDefaultSecretStore } from "../src/core/settings.ts";
import { createBoat } from "../src/main.ts";
import { createModelHost } from "../src/models/host.ts";
import { SecretStore, secretsPath } from "../src/secrets/store.ts";
import { buildSetupContext, type SetupContext } from "../src/setup/context.ts";
import { ScriptedUi } from "./setup-helpers.ts";

export interface TestContextOptions {
	/** ScriptedUi answers, in prompt order. */
	answers: unknown[];
	/** Contents of `<home>/config.yaml` (default `version: 1\n`). */
	config?: string;
	/** `ctx.env`, exactly (default `{}`: nothing from the real environment leaks in). */
	env?: Record<string, string>;
	/** `ctx.platform` (default `linux`). */
	platform?: NodeJS.Platform;
	/** `ctx.run` (default: records the call in `runs` and returns code 127, as if the binary were missing). */
	run?: SetupContext["run"];
	/** `ctx.fetch` (default: rejects, so no test reaches the network by accident). */
	fetch?: typeof fetch;
	/** `ctx.boat` on a LocalBoatBackend under a temp dir (default: boat.dev's API backend, never called by default). */
	fakeBoat?: boolean;
	/** `ctx.boat` replaced outright, e.g. a stub whose `limits` rejects. Wins over `fakeBoat`. */
	boat?: SetupContext["boat"];
	/** `ctx.doctor` (default: no lines; the real checks would run `gh` from the real PATH). */
	doctor?: SetupContext["doctor"];
	/** `ctx.daemon.pid()` (default undefined: the factory is not running). */
	daemonPid?: number;
}

export interface TestDaemon {
	pid(): number | undefined;
	restart(): Promise<void>;
	/** How many times `restart()` ran. */
	restarts: number;
	/** What `pid()` returns; tests may change it. */
	running: number | undefined;
}

export interface TestContext {
	ctx: SetupContext;
	ui: ScriptedUi;
	/** The factory home: `config.yaml`, `secrets.json`, `pi/` (the agent dir). */
	home: string;
	/** The same object as `ctx.daemon`, with its counters. */
	daemon: TestDaemon;
	/** Calls made through the default `run` stub (empty when `run` is given). */
	runs: { cmd: string; args: string[]; opts?: { input?: string; env?: Record<string, string> } }[];
}

/**
 * A SetupContext over a fresh temp home. Like `createSetupContext`, it makes its SecretStore the process-wide default
 * for `store:` refs (`setDefaultSecretStore`), so `ctx.boat.limits("store:boat")` and `resolveSecret` see it.
 * When called inside a test, the default is reset when that test finishes (`onTestFinished`); otherwise the caller
 * resets it with `setDefaultSecretStore(undefined)` (e.g. in `afterEach`).
 * `ctx.homedir` is `<home>/user-home`, an empty temp dir, never the real `~`.
 */
export function testContext(opts: TestContextOptions): TestContext {
	const home = mkdtempSync(join(tmpdir(), "sf-setup-"));
	const configPath = join(home, "config.yaml");
	writeFileSync(configPath, opts.config ?? "version: 1\n");
	const userHome = join(home, "user-home");
	mkdirSync(userHome);
	const ui = new ScriptedUi(opts.answers);
	const secrets = new SecretStore(secretsPath(home));
	setDefaultSecretStore(secrets);
	try {
		onTestFinished(() => setDefaultSecretStore(undefined));
	} catch {
		// not inside a test (e.g. beforeAll): the caller resets the default store
	}
	const runs: TestContext["runs"] = [];
	const run: SetupContext["run"] =
		opts.run ??
		(async (cmd, args, o) => {
			runs.push(o ? { cmd, args, opts: o } : { cmd, args });
			return { code: 127, stdout: "", stderr: `${cmd}: command not found (testContext: run not stubbed)` };
		});
	const daemon: TestDaemon = {
		restarts: 0,
		running: opts.daemonPid,
		pid: () => daemon.running,
		restart: async () => {
			daemon.restarts++;
		},
	};
	const boat = opts.boat ?? createBoat(configPath, opts.fakeBoat ? mkdtempSync(join(tmpdir(), "sf-setup-boat-")) : undefined);
	const ctx = buildSetupContext({
		configPath,
		ui,
		secrets,
		makeHost: () => createModelHost({ factoryHome: home, scripted: true }),
		boat,
		fetch: opts.fetch ?? (async (input) => Promise.reject(new Error(`testContext: fetch not stubbed (${String(input)})`))),
		run,
		platform: opts.platform ?? "linux",
		env: { ...opts.env },
		homedir: userHome,
		daemon,
		doctor: opts.doctor ?? (async () => []),
	});
	return { ctx, ui, home, daemon, runs };
}
