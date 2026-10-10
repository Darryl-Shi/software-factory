// Setup section "models" (spec §3.4): provider logins, provider packages, compatible endpoints in models.json.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CredentialSynchronizationError, DefaultPackageManager, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, onTestFinished, test, vi } from "vitest";
import { setDefaultSecretStore } from "../src/core/settings.ts";
import { agentDirOf } from "../src/models/host.ts";
import { discoverModels, providersInUse, readModelsJson, writeModelsJson } from "../src/setup/steps/endpoints.ts";
import { packageChange, step } from "../src/setup/steps/models.ts";
import { SetupCancelled } from "../src/setup/ui.ts";
import { testContext } from "./setup-context.ts";
import { CANCEL } from "./setup-helpers.ts";

afterEach(() => setDefaultSecretStore(undefined));

const TRUST =
	"Packages are code that runs inside the factory process, outside the sandbox, with access to its credentials. Review the source before installing.";
const LOGIN_PKG = resolve("test/fixtures/login-provider");
const PROVIDER_PKG = resolve("test/fixtures/provider-package");
const BROKEN_PKG = resolve("test/fixtures/broken-package");

type Opts = { message: string; initial?: unknown; placeholder?: string; options?: { value: string; label: string; hint?: string }[] };
/** Answers a prompt with its default (`initial`). */
const dflt = (o: Opts) => o.initial;
/** The four per-model prompts (context window, max tokens, images, reasoning), each answered with its default. */
const MODEL_DEFAULTS = [dflt, dflt, dflt, dflt];
/** Picks the first option of a select. */
const first = (o: Opts) => o.options![0]!.value;

const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const settingsPackages = (home: string): unknown[] => {
	const p = join(agentDirOf(home), "settings.json");
	return existsSync(p) ? (readJson(p).packages ?? []) : [];
};
const authJson = (home: string) => {
	const p = join(agentDirOf(home), "auth.json");
	return existsSync(p) ? readJson(p) : {};
};
const factoryPackages = (home: string) => {
	const p = join(agentDirOf(home), "factory-packages.json");
	return existsSync(p) ? readJson(p) : {};
};
const shownOf = (ui: { shown: { kind: string; message: string; body?: string }[] }, kind: string) => ui.shown.filter((s) => s.kind === kind);

/** A local HTTP server for one test; records each request's path and Authorization header. */
async function server(handler: (req: IncomingMessage, res: ServerResponse) => void) {
	const requests: { url: string; auth?: string }[] = [];
	const srv = createServer((req, res) => {
		requests.push({ url: req.url ?? "", auth: req.headers.authorization });
		handler(req, res);
	});
	await new Promise<void>((done) => srv.listen(0, "127.0.0.1", done));
	onTestFinished(
		() =>
			new Promise<void>((done) => {
				srv.closeAllConnections();
				srv.close(() => done());
			}),
	);
	return { base: `http://127.0.0.1:${(srv.address() as AddressInfo).port}/v1`, requests };
}

/** `/v1/models` lists `ids`; `/v1/chat/completions` answers with `chat`, default 404. */
function endpoint(ids: string[], chat?: (res: ServerResponse) => void) {
	return (req: IncomingMessage, res: ServerResponse) => {
		req.resume();
		if (req.method === "GET" && req.url === "/v1/models") {
			res.setHeader("content-type", "application/json");
			res.end(JSON.stringify({ object: "list", data: ids.map((id) => ({ id, object: "model" })) }));
		} else if (req.url === "/v1/chat/completions" && chat) {
			req.on("end", () => chat(res));
		} else {
			res.statusCode = 404;
			res.end("{}");
		}
	};
}

/** An OpenAI chat-completions stream that replies "OK". */
function replyOk(res: ServerResponse) {
	res.setHeader("content-type", "text/event-stream");
	const chunk = (delta: object, finish: string | null, extra: object = {}) =>
		`data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 0, model: "a", choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`;
	res.write(chunk({ role: "assistant", content: "OK" }, null));
	res.write(chunk({}, "stop", { usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } }));
	res.end("data: [DONE]\n\n");
}

const realFetch: typeof fetch = (input, init) => fetch(input, init);

/** Writes `<agentDir>/auth.json` as pi does (0600). */
function writeAuthJson(home: string, doc: object) {
	mkdirSync(agentDirOf(home), { recursive: true, mode: 0o700 });
	writeFileSync(join(agentDirOf(home), "auth.json"), JSON.stringify(doc), { mode: 0o600 });
}

/** The source pi recorded in settings.json for the only user package. */
async function onlyPackageSource(ctx: { host(): Promise<{ packages: DefaultPackageManager }> }) {
	const pkgs = (await ctx.host()).packages.listConfiguredPackages();
	expect(pkgs).toHaveLength(1);
	return pkgs[0]!.source;
}

/**
 * Simulates `npm install` for `npm:<name>@<version>` sources without the network: copies the provider-package fixture
 * to pi's managed npm path (`<agentDir>/npm/node_modules/<name>`) with that version, then records the source with pi's
 * real `addSourceToSettings`, which replaces an entry for the same npm name in place. PI_OFFLINE keeps pi from
 * installing anything when it resolves the packages on reload.
 */
function fakeNpmInstalls(home: string) {
	vi.stubEnv("PI_OFFLINE", "1");
	const spy = vi.spyOn(DefaultPackageManager.prototype, "installAndPersist").mockImplementation(async function (this: DefaultPackageManager, source: string) {
		const m = /^npm:(.+)@([^@]+)$/.exec(source);
		if (!m) throw new Error(`fakeNpmInstalls: unsupported source ${source}`);
		const dir = join(agentDirOf(home), "npm", "node_modules", m[1]!);
		rmSync(dir, { recursive: true, force: true });
		cpSync(PROVIDER_PKG, dir, { recursive: true });
		writeFileSync(join(dir, "package.json"), JSON.stringify({ name: m[1], version: m[2], type: "module", pi: { extensions: ["./index.ts"] } }));
		this.addSourceToSettings(source);
	});
	onTestFinished(() => spy.mockRestore());
}

/** A throwaway local package whose extension is `body` (a function of `pi`). */
function tempPackage(body: string): string {
	const dir = mkdtempSync(join(tmpdir(), "sf-pkg-"));
	writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "sf-tmp", version: "0.0.1", type: "module", pi: { extensions: ["./index.ts"] } }));
	writeFileSync(join(dir, "index.ts"), `export default function (pi: any) {\n${body}\n}\n`);
	return dir;
}

describe("models: logins", () => {
	test("api_key login through the scripted UI stores the credential", async () => {
		let options: Opts["options"];
		const { ctx, ui, home } = testContext({
			answers: [
				"login",
				(o: Opts) => {
					options = o.options;
					return "sf-login";
				},
				"key-1",
				"done",
			],
		});
		await (await ctx.host()).packages.installAndPersist(LOGIN_PKG);
		await ctx.reloadHost();

		await step.run(ctx);

		expect(await (await ctx.host()).models.checkAuth("sf-login")).toBeDefined();
		const authPath = join(agentDirOf(home), "auth.json");
		expect(statSync(authPath).mode & 0o777).toBe(0o600);
		expect(authJson(home)["sf-login"]).toEqual({ type: "api_key", key: "key-1" });
		// the providers the default roles use come first; each shows its auth status
		expect(options!.slice(0, 2).map((o) => o.value)).toEqual(["anthropic", "openai"]);
		expect(options!.find((o) => o.value === "sf-login")?.hint).toBe("not configured");
		// sf-login has only an API-key login: no method prompt
		expect(shownOf(ui, "password").map((s) => s.message)).toEqual(["SF Login key"]);
		expect(shownOf(ui, "select").map((s) => s.message)).toEqual(["Model providers", "Log in to", "Model providers"]);
		expect(shownOf(ui, "log.success").some((s) => s.message.includes("sf-login"))).toBe(true);
		// credentials apply live: a login needs no restart
		expect(ctx.needsRestart).toBe(false);
		expect(ui.remaining()).toBe(0);
	});

	test("a cancel in the middle of a login propagates and stores nothing", async () => {
		const { ctx, ui, home } = testContext({ answers: ["login", "sf-login", CANCEL] });
		await (await ctx.host()).packages.installAndPersist(LOGIN_PKG);
		await ctx.reloadHost();
		await expect(step.run(ctx)).rejects.toBeInstanceOf(SetupCancelled);
		expect(authJson(home)).toEqual({});
		expect(shownOf(ui, "log.error")).toEqual([]);
		expect(ctx.needsRestart).toBe(false);
	});

	test("a provider with API key and OAuth asks for the method", async () => {
		let methods: string[] = [];
		const { ctx, ui, home } = testContext({
			answers: [
				"login",
				"anthropic",
				(o: Opts) => {
					methods = o.options!.map((x) => x.value);
					return "api_key";
				},
				"sk-ant-test",
				"done",
			],
		});
		await step.run(ctx);
		expect(methods).toEqual(["api_key", "oauth"]);
		expect(authJson(home).anthropic).toEqual({ type: "api_key", key: "sk-ant-test" });
		expect(ui.remaining()).toBe(0);
	});

	test("a failed login offers Retry / Skip; Retry logs in", async () => {
		let choices: string[] = [];
		const { ctx, ui, home } = testContext({
			answers: [
				"login",
				"sf-login",
				() => {
					throw new Error("keychain locked");
				},
				(o: Opts) => {
					choices = o.options!.map((x) => x.value);
					expect(o.initial).toBe("retry");
					return "retry";
				},
				"key-2",
				"done",
			],
		});
		await (await ctx.host()).packages.installAndPersist(LOGIN_PKG);
		await ctx.reloadHost();
		await step.run(ctx);
		expect(choices).toEqual(["retry", "skip"]);
		expect(shownOf(ui, "log.error").map((s) => s.message)).toEqual(["sf-login: keychain locked"]);
		expect(authJson(home)["sf-login"]).toEqual({ type: "api_key", key: "key-2" });
		expect(ui.remaining()).toBe(0);
	});

	test("a failed login skipped stores nothing", async () => {
		const { ctx, ui, home } = testContext({
			answers: [
				"login",
				"sf-login",
				() => {
					throw new Error("nope");
				},
				"skip",
				"done",
			],
		});
		await (await ctx.host()).packages.installAndPersist(LOGIN_PKG);
		await ctx.reloadHost();
		await step.run(ctx);
		expect(authJson(home)["sf-login"]).toBeUndefined();
		expect(ui.remaining()).toBe(0);
	});

	test("log out lists stored credentials and removes the chosen one", async () => {
		let stored: string[] = [];
		const { ctx, ui, home } = testContext({
			answers: [
				"login",
				"sf-login",
				"key-1",
				"logout",
				(o: Opts) => {
					stored = o.options!.map((x) => x.value);
					return "sf-login";
				},
				"done",
			],
		});
		await (await ctx.host()).packages.installAndPersist(LOGIN_PKG);
		await ctx.reloadHost();
		await step.run(ctx);
		expect(stored).toEqual(["sf-login"]);
		expect(authJson(home)["sf-login"]).toBeUndefined();
		expect(await (await ctx.host()).models.listCredentials()).toEqual([]);
		expect(ui.remaining()).toBe(0);
	});

	test("logging out of a provider a role uses asks first (default No)", async () => {
		const { ctx, ui, home } = testContext({
			config: "version: 1\nroles:\n  builder:\n    model: sf-login/m\n",
			answers: [
				"logout",
				"sf-login",
				(o: Opts) => {
					expect(o.message).toBe("sf-login is used by roles.builder; log out anyway?");
					expect(o.initial).toBe(false);
					return false;
				},
				"done",
				"logout",
				"sf-login",
				true,
				"done",
			],
		});
		await (await ctx.host()).packages.installAndPersist(LOGIN_PKG);
		await (await ctx.reloadHost()).models.login("sf-login", "api_key", { prompt: async () => "k", notify: () => {} });
		await step.run(ctx);
		expect(authJson(home)["sf-login"]).toEqual({ type: "api_key", key: "k" });
		await step.run(ctx);
		expect(authJson(home)["sf-login"]).toBeUndefined();
		expect(shownOf(ui, "confirm")).toHaveLength(2);
		expect(ui.remaining()).toBe(0);
	});
});

describe("models: provider packages", () => {
	test("install package shows the trust note, lists new providers, sets needsRestart", async () => {
		const { ctx, ui, home } = testContext({
			answers: [
				"install",
				PROVIDER_PKG,
				(o: Opts) => {
					expect(o.initial).toBe(false);
					return true;
				},
				false, // Log in to sf-fixture now?
				"done",
			],
		});
		await step.run(ctx);

		expect(shownOf(ui, "note").map((s) => s.body)).toContain(TRUST);
		const noteAt = ui.shown.findIndex((s) => s.kind === "note" && s.body === TRUST);
		expect(ui.shown[noteAt + 1]?.kind).toBe("confirm");
		expect(shownOf(ui, "confirm").map((s) => s.message)).toContain("Log in to sf-fixture now?");
		expect(shownOf(ui, "log.success").some((s) => s.message.includes("sf-fixture"))).toBe(true);
		// a plain line, not an animated spinner: pi's npm/git children write to the inherited terminal
		expect(shownOf(ui, "log.info").map((s) => s.message)).toContain(`Installing ${PROVIDER_PKG}…`);
		expect(shownOf(ui, "spinner")).toEqual([]);
		expect(ctx.needsRestart).toBe(true);
		expect(settingsPackages(home)).toHaveLength(1);
		expect(Object.values(factoryPackages(home))).toEqual([["sf-fixture"]]);
		expect((await ctx.host()).models.getProvider("sf-fixture")).toBeDefined();
		expect(ui.remaining()).toBe(0);
	});

	test("logging in to a new package's provider right after installing it", async () => {
		const { ctx, ui, home } = testContext({ answers: ["install", LOGIN_PKG, true, true, "key-9", "done"] });
		await step.run(ctx);
		expect(shownOf(ui, "confirm").map((s) => s.message)).toContain("Log in to sf-login now?");
		expect(authJson(home)["sf-login"]).toEqual({ type: "api_key", key: "key-9" });
		expect(ui.remaining()).toBe(0);
	});

	test("a relative local path is resolved from the directory setup runs in, not pi's agent dir", async () => {
		const { ctx, ui, home } = testContext({ answers: ["install", "./test/fixtures/provider-package", true, false, "done"] });
		await step.run(ctx);
		expect(shownOf(ui, "confirm")[0]!.message).toBe(`Install ${PROVIDER_PKG}?`);
		expect(settingsPackages(home)).toHaveLength(1);
		expect((await ctx.host()).models.getProvider("sf-fixture")).toBeDefined();
		expect(ui.remaining()).toBe(0);
	});

	test("declining the trust confirm installs nothing", async () => {
		const { ctx, ui, home } = testContext({ answers: ["install", PROVIDER_PKG, false, "done"] });
		await step.run(ctx);
		expect(shownOf(ui, "note").map((s) => s.body)).toContain(TRUST);
		expect(settingsPackages(home)).toEqual([]);
		expect(factoryPackages(home)).toEqual({});
		expect(shownOf(ui, "log.info").some((s) => s.message.startsWith("Installing"))).toBe(false);
		expect(ctx.needsRestart).toBe(false);
		expect(ui.remaining()).toBe(0);
	});

	test("package with no providers offers removal (default yes) and removes it", async () => {
		const { ctx, ui, home } = testContext({
			answers: [
				"install",
				BROKEN_PKG,
				true,
				(o: Opts) => {
					expect(o.message).toBe("Remove the package?");
					expect(o.initial).toBe(true);
					return true;
				},
				"done",
			],
		});
		await step.run(ctx);
		const warnings = shownOf(ui, "log.warn").map((s) => s.message);
		expect(warnings.some((m) => m.includes("fixture boom"))).toBe(true);
		expect(settingsPackages(home)).toEqual([]);
		expect(factoryPackages(home)).toEqual({});
		expect(ctx.needsRestart).toBe(false);
		expect(ui.remaining()).toBe(0);
	});

	test("an install error shows the message and persists nothing", async () => {
		const { ctx, ui, home } = testContext({ answers: ["install", join("/nonexistent", "sf-pkg"), true, "done"] });
		await step.run(ctx);
		const errors = shownOf(ui, "log.error").map((s) => s.message);
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain("Path does not exist");
		expect(settingsPackages(home)).toEqual([]);
		expect(factoryPackages(home)).toEqual({});
		expect(ctx.needsRestart).toBe(false);
		expect(ui.remaining()).toBe(0);
	});

	test("remove refuses when a role uses the package's provider", async () => {
		const { ctx, ui, home } = testContext({
			config: "version: 1\nroles:\n  builder:\n    model: sf-fixture/text-1\n",
			answers: ["install", PROVIDER_PKG, true, false, "remove-package", first, "done"],
		});
		await step.run(ctx);
		expect(shownOf(ui, "log.error").map((s) => s.message)).toEqual(["sf-fixture is used by roles.builder; change those roles first"]);
		expect(settingsPackages(home)).toHaveLength(1);
		expect(Object.values(factoryPackages(home))).toEqual([["sf-fixture"]]);
		expect(ui.remaining()).toBe(0);
	});

	test("a cancel at the removal offer keeps the installed package and needsRestart", async () => {
		const { ctx, home } = testContext({ answers: ["install", BROKEN_PKG, true, CANCEL] });
		await expect(step.run(ctx)).rejects.toBeInstanceOf(SetupCancelled);
		expect(settingsPackages(home)).toHaveLength(1);
		expect(ctx.needsRestart).toBe(true);
	});

	test("a package that extends an existing provider id counts as supplying it", async () => {
		const pkg = tempPackage(`pi.registerProvider("openai", { baseUrl: "http://127.0.0.1:9/v1" });`);
		const { ctx, ui, home } = testContext({ answers: ["install", pkg, true, false, "done"] });
		await step.run(ctx);
		expect(shownOf(ui, "confirm").map((s) => s.message)).toEqual([`Install ${pkg}?`, "Log in to openai now?"]);
		expect(Object.values(factoryPackages(home))).toEqual([["openai"]]);
		expect(shownOf(ui, "log.warn")).toEqual([]);
		expect(ui.remaining()).toBe(0);
	});

	test("re-installing a package at another version moves its record and does not offer removal", async () => {
		// Approach: pi's real addSourceToSettings and host reload, with only the npm download simulated (fakeNpmInstalls).
		const { ctx, ui, home } = testContext({
			config: "version: 1\nroles:\n  builder:\n    model: sf-fixture/text-1\n",
			answers: [
				"install",
				"npm:sf-fixture-provider@0.0.1",
				true,
				false, // Log in to sf-fixture now?
				"install",
				"npm:sf-fixture-provider@0.0.2",
				true,
				"remove-package",
				first,
				"done",
			],
		});
		fakeNpmInstalls(home);
		await step.run(ctx);
		expect(settingsPackages(home)).toEqual(["npm:sf-fixture-provider@0.0.2"]);
		expect(factoryPackages(home)).toEqual({ "npm:sf-fixture-provider@0.0.2": ["sf-fixture"] });
		expect(shownOf(ui, "confirm").map((s) => s.message)).toEqual([
			"Install npm:sf-fixture-provider@0.0.1?",
			"Log in to sf-fixture now?",
			"Install npm:sf-fixture-provider@0.0.2?",
		]);
		expect(shownOf(ui, "log.success").map((s) => s.message)).toContain("replaced npm:sf-fixture-provider@0.0.1 with npm:sf-fixture-provider@0.0.2");
		expect(shownOf(ui, "log.warn")).toEqual([]);
		// the in-use guard still holds for the new version
		expect(shownOf(ui, "log.error").map((s) => s.message)).toEqual(["sf-fixture is used by roles.builder; change those roles first"]);
		expect(ctx.needsRestart).toBe(true);
		expect(ui.remaining()).toBe(0);
	});

	test("packageChange tells a new package from a replaced or unchanged one", () => {
		expect(packageChange(["a"], ["a", "npm:x@1"])).toEqual({ kind: "new", source: "npm:x@1" });
		expect(packageChange(["a", "npm:x@1"], ["a", "npm:x@2"])).toEqual({ kind: "replaced", source: "npm:x@2", old: "npm:x@1" });
		expect(packageChange(["a", "npm:x@1"], ["a", "npm:x@1"])).toEqual({ kind: "unchanged" });
	});

	test("remove reports every in-use provider of the package", async () => {
		const { ctx, ui, home } = testContext({
			config: "version: 1\nroles:\n  builder:\n    model: sf-fixture/text-1\n  reviewer:\n    model: sf-other/x\n",
			answers: ["remove-package", first, "done"],
		});
		await (await ctx.host()).packages.installAndPersist(PROVIDER_PKG);
		const source = await onlyPackageSource(ctx);
		writeFileSync(join(agentDirOf(home), "factory-packages.json"), JSON.stringify({ [source]: ["sf-fixture", "sf-other"] }));
		await step.run(ctx);
		expect(shownOf(ui, "log.error").map((s) => s.message)).toEqual([
			"sf-fixture is used by roles.builder; change those roles first",
			"sf-other is used by roles.reviewer; change those roles first",
		]);
		expect(settingsPackages(home)).toHaveLength(1);
		expect(ui.remaining()).toBe(0);
	});

	test("removing a package setup has no record of asks first (default No)", async () => {
		const { ctx, ui, home } = testContext({
			answers: [
				"remove-package",
				first,
				(o: Opts) => {
					expect(o.initial).toBe(false);
					return false;
				},
				"done",
				"remove-package",
				first,
				true,
				"done",
			],
		});
		await (await ctx.host()).packages.installAndPersist(PROVIDER_PKG); // outside setup: no factory-packages.json
		const source = await onlyPackageSource(ctx);
		await step.run(ctx);
		expect(settingsPackages(home)).toHaveLength(1);
		expect(ctx.needsRestart).toBe(false);
		await step.run(ctx);
		expect(settingsPackages(home)).toEqual([]);
		expect(shownOf(ui, "confirm").map((s) => s.message)).toEqual([
			`setup can't tell which providers ${source} supplies; remove it anyway?`,
			`setup can't tell which providers ${source} supplies; remove it anyway?`,
		]);
		expect(shownOf(ui, "log.info").map((s) => s.message)).toContain(`Removing ${source}…`);
		expect(shownOf(ui, "spinner")).toEqual([]);
		expect(ctx.needsRestart).toBe(true);
		expect(ui.remaining()).toBe(0);
	});

	test("a removal that matches nothing in settings.json is reported", async () => {
		const { ctx, ui } = testContext({ answers: ["install", PROVIDER_PKG, true, false, "remove-package", first, "done"] });
		const spy = vi.spyOn(DefaultPackageManager.prototype, "removeAndPersist").mockResolvedValue(false);
		onTestFinished(() => spy.mockRestore());
		await step.run(ctx);
		const source = await onlyPackageSource(ctx);
		expect(shownOf(ui, "log.warn").map((s) => s.message)).toEqual([`nothing in settings.json matched ${source}; nothing was removed`]);
		expect(shownOf(ui, "log.success").some((s) => s.message.startsWith("removed"))).toBe(false);
		expect(ui.remaining()).toBe(0);
	});

	test("remove a package no role uses", async () => {
		let picked = "";
		const pick = (o: Opts) => (picked = first(o));
		const { ctx, ui, home } = testContext({ answers: ["install", PROVIDER_PKG, true, false, "remove-package", pick, "done"] });
		await step.run(ctx);
		expect(shownOf(ui, "log.success").map((s) => s.message)).toContain(`removed ${picked}`);
		expect(ctx.needsRestart).toBe(true);
		expect(settingsPackages(home)).toEqual([]);
		expect(factoryPackages(home)).toEqual({});
		expect((await ctx.host()).models.getProvider("sf-fixture")).toBeUndefined();
		expect(ui.remaining()).toBe(0);
	});
});

describe("models: compatible endpoints", () => {
	test("endpoint with discovery writes models.json", async () => {
		const srv = await server(endpoint(["a", "b"]));
		let offered: string[] = [];
		const { ctx, ui, home } = testContext({
			fetch: realFetch,
			answers: [
				"add-endpoint",
				"my-ep",
				"My EP",
				"openai-completions",
				(o: Opts) => {
					expect(o.placeholder).toBe("http://localhost:11434/v1");
					return srv.base;
				},
				"none",
				(o: Opts) => {
					offered = o.options!.map((x) => x.value);
					return ["a", "b"];
				},
				"", // no more ids by hand
				...MODEL_DEFAULTS,
				...MODEL_DEFAULTS,
				false, // no test call
				"done",
			],
		});
		await step.run(ctx);

		expect(offered).toEqual(["a", "b"]);
		const entry = readModelsJson(agentDirOf(home)).providers["my-ep"];
		expect(entry).toMatchObject({ name: "My EP", api: "openai-completions", baseUrl: srv.base });
		expect(entry.models.map((m: { id: string }) => m.id)).toEqual(["a", "b"]);
		for (const m of entry.models)
			expect(m).toMatchObject({
				contextWindow: 128000,
				maxTokens: 16384,
				input: ["text"],
				reasoning: false,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			});
		expect(statSync(join(agentDirOf(home), "models.json")).mode & 0o777).toBe(0o600);
		expect((await ctx.host()).models.getModel("my-ep", "b")).toBeDefined();
		// no auth: pi counts a provider as configured only with a key, so a keyless endpoint gets a placeholder one
		expect(entry.apiKey).toBe("none");
		expect(await (await ctx.host()).models.checkAuth("my-ep")).toBeDefined();
		expect(authJson(home)).toEqual({});
		expect(srv.requests.map((r) => r.url)).toEqual(["/v1/models"]);
		expect(ctx.needsRestart).toBe(true);
		expect(ui.remaining()).toBe(0);
	});

	test("endpoint with key auth stores the key in auth.json via login, typed once", async () => {
		const srv = await server(endpoint(["a"]));
		const { ctx, ui, home } = testContext({
			fetch: realFetch,
			answers: ["add-endpoint", "my-ep", "My EP", "openai-completions", srv.base, "key", " k1 ", ["a"], "", ...MODEL_DEFAULTS, false, "done"],
		});
		await step.run(ctx);

		expect(shownOf(ui, "password")).toHaveLength(1);
		expect(authJson(home)["my-ep"]).toEqual({ type: "api_key", key: "k1" });
		expect(readModelsJson(agentDirOf(home)).providers["my-ep"]).not.toHaveProperty("apiKey");
		expect(srv.requests[0]).toEqual({ url: "/v1/models", auth: "Bearer k1" });
		expect(await (await ctx.host()).models.checkAuth("my-ep")).toBeDefined();
		expect(ui.remaining()).toBe(0);
	});

	test("endpoint id colliding with a built-in is rejected", async () => {
		const { ctx, ui, home } = testContext({
			answers: [
				"add-endpoint",
				"anthropic",
				"Bad_Id",
				"my-ep",
				"My EP",
				"anthropic-messages",
				(o: Opts) => {
					expect(o.placeholder).toBe("https://api.example.com");
					return "http://127.0.0.1:9";
				},
				"none",
				"m1",
				...MODEL_DEFAULTS,
				false,
				"done",
			],
		});
		await step.run(ctx);
		expect(shownOf(ui, "validate").map((s) => s.message)).toEqual([
			"anthropic is already a provider",
			"use lowercase letters, digits and -",
		]);
		const doc = readModelsJson(agentDirOf(home));
		expect(Object.keys(doc.providers)).toEqual(["my-ep"]);
		expect(doc.providers["my-ep"].models.map((m: { id: string }) => m.id)).toEqual(["m1"]);
		expect(ui.remaining()).toBe(0);
	});

	test("a successful test call reports the reply", async () => {
		const srv = await server(endpoint(["a"], replyOk));
		const { ctx, ui } = testContext({
			fetch: realFetch,
			answers: [
				"add-endpoint",
				"my-ep",
				"My EP",
				"openai-completions",
				srv.base,
				"key",
				"k1",
				["a"],
				"",
				...MODEL_DEFAULTS,
				(o: Opts) => {
					expect(o.initial).toBe(true);
					return true;
				},
				"done",
			],
		});
		await step.run(ctx);
		expect(srv.requests.map((r) => r.url)).toEqual(["/v1/models", "/v1/chat/completions"]);
		expect(srv.requests[1]!.auth).toBe("Bearer k1");
		expect(shownOf(ui, "log.success").some((s) => s.message.includes("OK"))).toBe(true);
		expect(shownOf(ui, "log.error")).toEqual([]);
		expect(ui.remaining()).toBe(0);
	});

	test("a failed test call offers Retry / Save anyway / Skip; Skip leaves models.json and auth.json unchanged", async () => {
		const srv = await server(
			endpoint(["a"], (res) => {
				res.statusCode = 401;
				res.setHeader("content-type", "application/json");
				res.end(JSON.stringify({ error: { message: "bad key", type: "invalid_request_error" } }));
			}),
		);
		let choices: string[] = [];
		const { ctx, ui, home } = testContext({
			fetch: realFetch,
			answers: [
				"add-endpoint",
				"my-ep",
				"My EP",
				"openai-completions",
				srv.base,
				"key",
				"k1",
				["a"],
				"",
				...MODEL_DEFAULTS,
				true,
				(o: Opts) => {
					choices = o.options!.map((x) => x.value);
					expect(o.initial).toBe("retry");
					return "skip";
				},
				"done",
			],
		});
		await step.run(ctx);
		expect(choices).toEqual(["retry", "save", "skip"]);
		expect(shownOf(ui, "log.error")).toHaveLength(1);
		expect(readModelsJson(agentDirOf(home)).providers).toEqual({});
		expect(authJson(home)["my-ep"]).toBeUndefined();
		expect((await ctx.host()).models.getProvider("my-ep")).toBeUndefined();
		expect(ctx.needsRestart).toBe(false);
		expect(ui.remaining()).toBe(0);
	});

	test("a failed test call saved anyway keeps the endpoint", async () => {
		const srv = await server(
			endpoint(["a"], (res) => {
				res.statusCode = 401;
				res.end("{}");
			}),
		);
		const { ctx, ui, home } = testContext({
			fetch: realFetch,
			answers: ["add-endpoint", "my-ep", "My EP", "openai-completions", srv.base, "key", "k1", ["a"], "", ...MODEL_DEFAULTS, true, "save", "done"],
		});
		await step.run(ctx);
		expect(Object.keys(readModelsJson(agentDirOf(home)).providers)).toEqual(["my-ep"]);
		expect(authJson(home)["my-ep"]).toEqual({ type: "api_key", key: "k1" });
		expect(ctx.needsRestart).toBe(true);
		expect(ui.remaining()).toBe(0);
	});

	test("a cancel at the test request prompt leaves the endpoint saved and needsRestart set", async () => {
		const { ctx, home } = testContext({
			answers: ["add-endpoint", "my-ep", "My EP", "anthropic-messages", "http://127.0.0.1:9", "none", "m1", ...MODEL_DEFAULTS, CANCEL],
		});
		await expect(step.run(ctx)).rejects.toBeInstanceOf(SetupCancelled);
		expect(Object.keys(readModelsJson(agentDirOf(home)).providers)).toEqual(["my-ep"]);
		expect(ctx.needsRestart).toBe(true);
	});

	test("removing an endpoint logs out its key; the same id re-added without auth never sends the old key", async () => {
		const a = await server(endpoint(["a"]));
		const b = await server(endpoint(["a"], replyOk));
		const add = (base: string, auth: string[]) => ["add-endpoint", "my-ep", "My EP", "openai-completions", base, ...auth, ["a"], "", ...MODEL_DEFAULTS];
		const { ctx, ui, home } = testContext({
			fetch: realFetch,
			answers: [...add(a.base, ["key", "k1"]), false, "remove-endpoint", "my-ep", "done", ...add(b.base, ["none"]), true, "done"],
		});
		await step.run(ctx);
		expect(authJson(home)["my-ep"]).toBeUndefined();
		expect(shownOf(ui, "log.success").map((s) => s.message)).toContain("removed my-ep from models.json and its key from auth.json");
		await step.run(ctx);
		expect(b.requests.map((r) => r.url)).toEqual(["/v1/models", "/v1/chat/completions"]);
		expect(b.requests.map((r) => r.auth)).toEqual([undefined, "Bearer none"]);
		expect(ui.remaining()).toBe(0);
	});

	test("adding an endpoint clears a stale stored credential for its id", async () => {
		const b = await server(endpoint(["a"], replyOk));
		const { ctx, ui, home } = testContext({
			fetch: realFetch,
			answers: ["add-endpoint", "my-ep", "My EP", "openai-completions", b.base, "none", ["a"], "", ...MODEL_DEFAULTS, true, "done"],
		});
		writeAuthJson(home, { "my-ep": { type: "api_key", key: "stale" } });
		await step.run(ctx);
		expect(authJson(home)["my-ep"]).toBeUndefined();
		expect(b.requests.at(-1)).toEqual({ url: "/v1/chat/completions", auth: "Bearer none" });
		expect(shownOf(ui, "log.info").map((s) => s.message)).toContain("cleared a stored credential for my-ep left from an earlier endpoint");
		expect(ui.remaining()).toBe(0);
	});

	test("Skip after a failed key login clears a key that was stored anyway", async () => {
		const srv = await server(endpoint(["a"]));
		// the key is written, then refreshing pi's snapshot fails (CredentialSynchronizationError)
		const login = ModelRuntime.prototype.login;
		const spy = vi.spyOn(ModelRuntime.prototype, "login").mockImplementationOnce(async function (this: ModelRuntime, ...args) {
			const credential = await login.apply(this, args);
			throw new CredentialSynchronizationError(args[0], "login", credential, { cause: new Error("refresh failed") });
		});
		onTestFinished(() => spy.mockRestore());
		const { ctx, ui, home } = testContext({
			fetch: realFetch,
			answers: ["add-endpoint", "my-ep", "My EP", "openai-completions", srv.base, "key", "k1", ["a"], "", ...MODEL_DEFAULTS, "skip", "done"],
		});
		await step.run(ctx);
		expect(shownOf(ui, "log.error")).toHaveLength(1);
		expect(authJson(home)["my-ep"]).toBeUndefined();
		expect(readModelsJson(agentDirOf(home)).providers).toEqual({});
		expect(ctx.needsRestart).toBe(false);
		expect(ui.remaining()).toBe(0);
	});

	test("a models.json that can't be parsed is reported and setup returns to the menu", async () => {
		const { ctx, ui, home } = testContext({ answers: ["add-endpoint", "remove-endpoint", "done"] });
		const path = join(agentDirOf(home), "models.json");
		await ctx.host();
		const text = '// my endpoints\n{ "providers": {} }\n';
		writeFileSync(path, text);
		await step.run(ctx);
		const errors = shownOf(ui, "log.error").map((s) => s.message);
		expect(errors).toHaveLength(2);
		for (const m of errors) expect(m).toMatch(new RegExp(`^models\\.json can't be parsed: .+; edit ${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} by hand$`));
		expect(readFileSync(path, "utf8")).toBe(text);
		expect(ui.remaining()).toBe(0);
	});

	test("remove endpoint in use is refused", async () => {
		const { ctx, ui, home } = testContext({
			config: "version: 1\nroles:\n  builder:\n    model: my-ep/a\n",
			answers: ["remove-endpoint", "my-ep", "done"],
		});
		writeModelsJson(agentDirOf(home), { providers: { "my-ep": { baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", models: [{ id: "a" }] } } });
		await ctx.reloadHost();
		await step.run(ctx);
		expect(shownOf(ui, "log.error").map((s) => s.message)).toEqual(["my-ep is used by roles.builder; change those roles first"]);
		expect(Object.keys(readModelsJson(agentDirOf(home)).providers)).toEqual(["my-ep"]);
		expect(ctx.needsRestart).toBe(false);
		expect(ui.remaining()).toBe(0);
	});

	test("remove endpoint deletes its entry and keeps the others", async () => {
		const { ctx, ui, home } = testContext({ answers: ["remove-endpoint", "my-ep", "done"] });
		const other = { baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", models: [{ id: "x" }] };
		writeModelsJson(agentDirOf(home), { providers: { "my-ep": { ...other, models: [{ id: "a" }] }, other }, extra: true } as never);
		await step.run(ctx);
		const doc = readModelsJson(agentDirOf(home)) as { providers: Record<string, unknown>; extra?: unknown };
		expect(doc.providers).toEqual({ other });
		expect(doc.extra).toBe(true);
		expect(ctx.needsRestart).toBe(true);
		expect(ui.remaining()).toBe(0);
	});
});

describe("models: status", () => {
	test("missing lists the role providers without credentials", async () => {
		const { ctx } = testContext({ answers: [] });
		expect(await step.status(ctx)).toEqual({ state: "missing", detail: "no credentials for anthropic, openai" });
	});

	test("ok when every role's provider has credentials", async () => {
		const { ctx } = testContext({
			answers: [],
			env: { ANTHROPIC_API_KEY: "a", OPENAI_API_KEY: "o" },
			config: "version: 1\nprojects:\n  p:\n    repo: o/r\n    roles:\n      qa:\n        model: sf-login/m\n",
		});
		expect((await step.status(ctx)).state).toBe("missing"); // the project's qa model has no provider yet
		await (await ctx.host()).packages.installAndPersist(LOGIN_PKG);
		await ctx.reloadHost();
		await (await ctx.host()).models.login("sf-login", "api_key", { prompt: async () => "k", notify: () => {} });
		const s = await step.status(ctx);
		expect(s.state).toBe("ok");
		expect(s.detail).toContain("anthropic");
		expect(s.detail).toContain("sf-login");
	});
});

describe("models: endpoint helpers", () => {
	test("discoverModels returns the ids, sending the key; [] on any failure", async () => {
		const srv = await server(endpoint(["x", "y"]));
		expect(await discoverModels(srv.base, "k", realFetch)).toEqual(["x", "y"]);
		expect(srv.requests[0]).toEqual({ url: "/v1/models", auth: "Bearer k" });
		expect(await discoverModels(`${srv.base}/`, undefined, realFetch)).toEqual(["x", "y"]);
		expect(srv.requests[1]).toEqual({ url: "/v1/models", auth: undefined });
		expect(await discoverModels(`${srv.base}/nope`, undefined, realFetch)).toEqual([]);
		expect(await discoverModels(srv.base, undefined, async () => Promise.reject(new Error("down")))).toEqual([]);
		expect(await discoverModels(srv.base, undefined, async () => new Response("not json"))).toEqual([]);
		expect(await discoverModels(srv.base, undefined, async () => new Response(JSON.stringify({ data: "no" })))).toEqual([]);
	});

	test("readModelsJson/writeModelsJson: missing file, 0600, other keys kept", async () => {
		const { home } = testContext({ answers: [] });
		const dir = agentDirOf(home);
		expect(readModelsJson(dir)).toEqual({ providers: {} });
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "models.json"), '\uFEFF{ "providers": { "b": { "baseUrl": "v" } } }');
		expect(readModelsJson(dir)).toEqual({ providers: { b: { baseUrl: "v" } } });
		writeModelsJson(dir, { providers: { a: { baseUrl: "u" } }, keep: 1 } as never);
		expect(statSync(join(dir, "models.json")).mode & 0o777).toBe(0o600);
		expect(readModelsJson(dir)).toEqual({ providers: { a: { baseUrl: "u" } }, keep: 1 });
	});

	test("providersInUse maps providers to the role paths that set them, at global and project scope", async () => {
		const { ctx } = testContext({
			answers: [],
			config: [
				"version: 1",
				"roles:",
				"  builder:",
				"    model: my-ep/a",
				"projects:",
				"  p:",
				"    repo: o/r",
				"    roles:",
				"      helper:",
				"        model: my-ep/b",
				"      reviewer:",
				"        model: sf-fixture/text-1",
				"",
			].join("\n"),
		});
		const uses = providersInUse(await ctx.settings());
		expect(uses.get("my-ep")).toEqual(["roles.builder", "projects.p.roles.helper"]);
		expect(uses.get("sf-fixture")).toEqual(["projects.p.roles.reviewer"]);
		// defaults count; the helper inheriting the builder's model does not add a path
		expect(uses.get("anthropic")).toEqual(["roles.architect", "roles.qa"]);
		expect(uses.get("openai")).toEqual(["roles.reviewer"]);
	});
});
