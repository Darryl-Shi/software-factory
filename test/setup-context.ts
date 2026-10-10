// testContext: a SetupContext over a temp factory home for setup tests (spec §6). Real SecretStore, real model host
// (with the scripted provider), ScriptedUi; commands, fetch, the daemon and doctor are stubs unless given.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished, vi } from "vitest";
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

/**
 * Every env var pi-ai's built-in providers read for credentials (or for the project/account a credential needs):
 * the README's "Environment Variables" table, plus the Bedrock and Vertex ambient-credential variables found in
 * pi-ai's dist. pi looks keys up as `env?.[name] || process.env[name]`, so the developer's shell would leak into
 * `host().models` without these stubs.
 */
export const PROVIDER_ENV_VARS = [
	"AI_GATEWAY_API_KEY",
	"ANT_LING_API_KEY",
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_AUTH_TOKEN",
	"ANTHROPIC_OAUTH_TOKEN",
	"ANTHROPIC_PROFILE",
	"ANTHROPIC_SERVICE_ACCOUNT_ID",
	"AWS_ACCESS_KEY_ID",
	"AWS_BEARER_TOKEN_BEDROCK",
	"AWS_CONTAINER_CREDENTIALS_FULL_URI",
	"AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
	"AWS_DEFAULT_REGION",
	"AWS_PROFILE",
	"AWS_REGION",
	"AWS_SECRET_ACCESS_KEY",
	"AWS_SESSION_TOKEN",
	"AWS_WEB_IDENTITY_TOKEN_FILE",
	"AZURE_OPENAI_API_KEY",
	"AZURE_OPENAI_BASE_URL",
	"AZURE_OPENAI_RESOURCE_NAME",
	"BASETEN_API_KEY",
	"CEREBRAS_API_KEY",
	"CLOUDFLARE_ACCOUNT_ID",
	"CLOUDFLARE_API_KEY",
	"CLOUDFLARE_GATEWAY_ID",
	"COPILOT_GITHUB_TOKEN",
	"DEEPSEEK_API_KEY",
	"FIREWORKS_API_KEY",
	"GCLOUD_PROJECT",
	"GEMINI_API_KEY",
	"GOOGLE_APPLICATION_CREDENTIALS",
	"GOOGLE_CLOUD_API_KEY",
	"GOOGLE_CLOUD_LOCATION",
	"GOOGLE_CLOUD_PROJECT",
	"GROQ_API_KEY",
	"HF_TOKEN",
	"KIMI_API_KEY",
	"META_API_KEY",
	"MINIMAX_API_KEY",
	"MINIMAX_CN_API_KEY",
	"MISTRAL_API_KEY",
	"MOONSHOT_API_KEY",
	"NVIDIA_API_KEY",
	"OPENAI_API_KEY",
	"OPENCODE_API_KEY",
	"OPENROUTER_API_KEY",
	"QWEN_TOKEN_PLAN_API_KEY",
	"QWEN_TOKEN_PLAN_CN_API_KEY",
	"RADIUS_API_KEY",
	"TOGETHER_API_KEY",
	"TYPESAFE_API_KEY",
	"XAI_API_KEY",
	"XIAOMI_API_KEY",
	"XIAOMI_TOKEN_PLAN_AMS_API_KEY",
	"XIAOMI_TOKEN_PLAN_CN_API_KEY",
	"XIAOMI_TOKEN_PLAN_SGP_API_KEY",
	"ZAI_API_KEY",
	"ZAI_CODING_CN_API_KEY",
	// the factory's own credentials (doctor, setup sections)
	"GH_TOKEN",
	"BOAT_API_KEY",
	"PARALLEL_API_KEY",
] as const;

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
 *
 * The host must not see the developer's credentials: every PROVIDER_ENV_VARS entry is unset in `process.env` with
 * `vi.stubEnv`, then `opts.env` is stubbed on top, so keys a test passes are visible to the host (and `ctx.env` is
 * exactly `opts.env`). Inside a test the stubs are undone when it finishes (`vi.unstubAllEnvs`, which also undoes the
 * test's own `vi.stubEnv` calls); outside one the caller calls `vi.unstubAllEnvs()`.
 * HOME is left alone: the only home-dir credential pi-ai probes is Vertex's gcloud ADC file, which counts only with
 * GOOGLE_CLOUD_PROJECT/GCLOUD_PROJECT and GOOGLE_CLOUD_LOCATION set, and those are unset here.
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
	for (const name of PROVIDER_ENV_VARS) vi.stubEnv(name, undefined);
	for (const [name, value] of Object.entries(opts.env ?? {})) vi.stubEnv(name, value);
	try {
		onTestFinished(() => {
			setDefaultSecretStore(undefined);
			vi.unstubAllEnvs();
		});
	} catch {
		// not inside a test (e.g. beforeAll): the caller resets the default store and the env stubs
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
