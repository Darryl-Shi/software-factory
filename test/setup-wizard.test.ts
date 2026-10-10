// Setup wizard (spec §3.1): sections in order, reconfigure prompts, cancel keeps completed sections, restart offer.
import { readFileSync, writeFileSync } from "node:fs";
import { secretsPath } from "../src/secrets/store.ts";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { resolveSecret, setDefaultSecretStore } from "../src/core/settings.ts";
import { daemonFiles } from "../src/daemon.ts";
import { runCommand, SECTIONS, type SectionName, type SetupContext, type Step, type StepStatus } from "../src/setup/context.ts";
import { STEPS } from "../src/setup/steps/index.ts";
import { runSetup } from "../src/setup/wizard.ts";
import { testContext } from "./setup-context.ts";
import { CANCEL } from "./setup-helpers.ts";

afterEach(() => setDefaultSecretStore(undefined));

const PROMPTS = ["text", "password", "select", "multiselect", "confirm"];

/** Fake steps named after the real sections; each records its runs in `calls`. */
function fakeSteps(
	calls: string[],
	over: Partial<Record<SectionName, { state?: StepStatus["state"]; run?: (ctx: SetupContext) => Promise<void> }>> = {},
): Step[] {
	return SECTIONS.map((name) => ({
		name,
		title: `T-${name}`,
		status: async () => ({ state: over[name]?.state ?? "missing", detail: `d-${name}` }),
		run: async (ctx) => {
			calls.push(name);
			await over[name]?.run?.(ctx);
		},
	}));
}

describe("setup wizard", () => {
	test("unknown section returns 1 and lists sections", async () => {
		const { ctx, ui } = testContext({ answers: [] });
		const calls: string[] = [];
		expect(await runSetup(ctx, "nope", fakeSteps(calls))).toBe(1);
		expect(ui.shown).toEqual([
			{ kind: "log.error", message: "unknown section nope; sections: prereqs, github, models, roles, qa, search, service" },
		]);
		expect(calls).toEqual([]);
	});

	test("a section name runs only that step, without summary or doctor", async () => {
		let doctors = 0;
		const { ctx, ui } = testContext({ answers: [], doctor: async () => (doctors++, []) });
		const calls: string[] = [];
		expect(await runSetup(ctx, "qa", fakeSteps(calls, { qa: { state: "ok" } }))).toBe(0);
		expect(calls).toEqual(["qa"]);
		expect(doctors).toBe(0);
		expect(ui.shown.filter((s) => ["intro", "note", "outro", ...PROMPTS].includes(s.kind))).toEqual([]);
	});

	test("full run: summary note, steps in order, doctor note, outro", async () => {
		const { ctx, ui } = testContext({
			answers: [],
			doctor: async () => [
				{ level: "ok", text: "config fine" },
				{ level: "warn", text: "no key → factory setup search" },
			],
		});
		const calls: string[] = [];
		const steps = fakeSteps(calls, { github: { state: "warn" } });
		expect(await runSetup(ctx, undefined, steps)).toBe(0);
		expect(calls).toEqual([...SECTIONS]);
		expect(ui.shown[0]).toEqual({ kind: "intro", message: "factory setup" });
		const notes = ui.shown.filter((s) => s.kind === "note");
		expect(notes[0]!.body).toBe(
			[
				"✖ T-prereqs — d-prereqs",
				"⚠ T-github — d-github",
				"✖ T-models — d-models",
				"✖ T-roles — d-roles",
				"✖ T-qa — d-qa",
				"✖ T-search — d-search",
				"✖ T-service — d-service",
			].join("\n"),
		);
		expect(notes[1]!.body).toContain("config fine");
		expect(notes[1]!.body).toContain("no key → factory setup search");
		expect(notes).toHaveLength(2);
		expect(ui.shown.at(-1)).toEqual({ kind: "outro", message: "next: factory serve" });
	});

	test("outro links the web UI when the factory runs", async () => {
		const { ctx, ui, home } = testContext({ answers: [], daemonPid: 4242, doctor: async () => [] });
		writeFileSync(daemonFiles(join(home, "config.yaml")).url, "http://127.0.0.1:7777/?token=x\n");
		expect(await runSetup(ctx, undefined, fakeSteps([]))).toBe(0);
		expect(ui.shown.at(-1)).toEqual({ kind: "outro", message: "factory is running: http://127.0.0.1:7777/?token=x" });
	});

	test("outro says the service is starting when it is installed and active but the factory is not up yet", async () => {
		const { ctx, ui } = testContext({ answers: [false], doctor: async () => [] });
		expect(await runSetup(ctx, undefined, fakeSteps([], { service: { state: "ok" } }))).toBe(0);
		expect(ui.shown.at(-1)).toEqual({ kind: "outro", message: "the service is starting; factory web prints the link" });
	});

	test("ok steps ask to reconfigure and default to skip", async () => {
		const { ctx, ui } = testContext({ answers: [false], doctor: async () => [] });
		const calls: string[] = [];
		expect(await runSetup(ctx, undefined, fakeSteps(calls, { models: { state: "ok" } }))).toBe(0);
		expect(calls).toEqual(SECTIONS.filter((s) => s !== "models"));
		expect(ui.shown.filter((s) => s.kind === "confirm")).toEqual([{ kind: "confirm", message: "Reconfigure T-models?" }]);
	});

	test("cancel in the third step keeps the first two steps' writes and returns 130", async () => {
		const { ctx, ui } = testContext({ answers: [CANCEL], doctor: async () => [] });
		const calls: string[] = [];
		const steps = fakeSteps(calls, {
			prereqs: { run: async (c) => c.secrets.set("s1", "v1") },
			github: { run: async (c) => c.secrets.set("s2", "v2") },
			models: { run: async (c) => void (await c.ui.confirm({ message: "go on?" })) },
		});
		expect(await runSetup(ctx, undefined, steps)).toBe(130);
		expect(calls).toEqual(["prereqs", "github", "models"]);
		expect(ctx.secrets.get("s1")).toBe("v1");
		expect(ctx.secrets.get("s2")).toBe("v2");
		expect(ui.shown.at(-1)).toEqual({ kind: "log.warn", message: "setup cancelled; completed sections were saved" });
	});

	test("legacy config refuses before any prompt", async () => {
		const { ctx, ui, home } = testContext({ answers: [true, true], config: "version: 1\nstages: {}\n" });
		const calls: string[] = [];
		expect(await runSetup(ctx, undefined, fakeSteps(calls))).toBe(1);
		expect(calls).toEqual([]);
		expect(ui.shown.filter((s) => PROMPTS.includes(s.kind))).toEqual([]);
		expect(ui.shown).toHaveLength(1);
		expect(ui.shown[0]!.kind).toBe("log.error");
		expect(ui.shown[0]!.message).toContain("config uses removed sections (stages)");
		expect(readFileSync(join(home, "config.yaml"), "utf8")).toBe("version: 1\nstages: {}\n");
	});

	test("restart is offered when needsRestart and the daemon runs", async () => {
		const { ctx, ui, daemon } = testContext({ answers: [true], daemonPid: 4242, doctor: async () => [] });
		const steps = fakeSteps([], { models: { run: async (c) => void (c.needsRestart = true) } });
		expect(await runSetup(ctx, undefined, steps)).toBe(0);
		expect(daemon.restarts).toBe(1);
		expect(ctx.needsRestart).toBe(false);
		expect(ui.shown.filter((s) => s.kind === "confirm")).toEqual([{ kind: "confirm", message: "Restart the factory to load the new providers?" }]);
	});

	test("no restart offer when the daemon is not running", async () => {
		const { ctx, ui, daemon } = testContext({ answers: [], doctor: async () => [] });
		expect(await runSetup(ctx, "models", fakeSteps([], { models: { run: async (c) => void (c.needsRestart = true) } }))).toBe(0);
		expect(daemon.restarts).toBe(0);
		expect(ui.shown.filter((s) => s.kind === "confirm")).toEqual([]);
	});

	test("a section run offers the restart too", async () => {
		const { ctx, daemon } = testContext({ answers: [true], daemonPid: 4242 });
		expect(await runSetup(ctx, "models", fakeSteps([], { models: { run: async (c) => void (c.needsRestart = true) } }))).toBe(0);
		expect(daemon.restarts).toBe(1);
	});

	test("a declined restart is not offered again until a later step needs one; the outro reminds", async () => {
		const { ctx, ui, daemon, home } = testContext({ answers: [false, false], daemonPid: 4242, doctor: async () => [] });
		writeFileSync(daemonFiles(join(home, "config.yaml")).url, "http://u\n");
		const needs = { run: async (c: SetupContext) => void (c.needsRestart = true) };
		expect(await runSetup(ctx, undefined, fakeSteps([], { models: needs, search: needs }))).toBe(0);
		expect(daemon.restarts).toBe(0);
		expect(ui.shown.filter((s) => s.kind === "confirm")).toHaveLength(2); // after models and after search, not after roles/qa
		expect(ui.shown.at(-1)).toEqual({ kind: "outro", message: "factory is running: http://u\nrestart the factory to load the new providers" });
	});

	test("a restart that succeeds later clears the reminder", async () => {
		const { ctx, ui, daemon } = testContext({ answers: [false, true], daemonPid: 4242, doctor: async () => [] });
		const needs = { run: async (c: SetupContext) => void (c.needsRestart = true) };
		expect(await runSetup(ctx, undefined, fakeSteps([], { models: needs, search: needs }))).toBe(0);
		expect(daemon.restarts).toBe(1);
		expect(ui.shown.at(-1)).toEqual({ kind: "outro", message: "next: factory serve" });
	});

	for (const [platform, manual] of [
		["linux", "systemctl --user restart software-factory"],
		["darwin", "factory stop && factory serve"],
	] as const) {
		test(`a failed restart shows the error and the manual command (${platform}), then setup continues`, async () => {
			const { ctx, ui } = testContext({ answers: [true], daemonPid: 4242, platform, doctor: async () => [] });
			ctx.daemon.restart = async () => {
				throw new Error("Failed to restart software-factory.service: Unit not found.");
			};
			const calls: string[] = [];
			expect(await runSetup(ctx, undefined, fakeSteps(calls, { models: { run: async (c) => void (c.needsRestart = true) } }))).toBe(0);
			expect(calls).toEqual([...SECTIONS]);
			expect(ui.shown).toContainEqual({ kind: "log.error", message: "restart failed: Failed to restart software-factory.service: Unit not found." });
			expect(ui.shown).toContainEqual({ kind: "log.info", message: `restart it yourself: ${manual}` });
			expect(ui.shown.at(-1)!.message).toContain("restart the factory to load the new providers");
		});
	}

	test("a step error is prefixed with the step title and returns 1", async () => {
		const { ctx, ui } = testContext({ answers: [], doctor: async () => [] });
		const steps = fakeSteps([], { github: { run: async () => Promise.reject(new Error("boom")) } });
		expect(await runSetup(ctx, undefined, steps)).toBe(1);
		expect(ui.shown.at(-1)).toEqual({ kind: "log.error", message: "T-github: boom" });
		expect(await runSetup(ctx, "github", steps)).toBe(1);
		expect(ui.shown.at(-1)).toEqual({ kind: "log.error", message: "T-github: boom" });
	});

	for (const section of [undefined, "github"]) {
		test(`secrets.json with mode 0644 refuses before any prompt (${section ?? "all sections"})`, async () => {
			const { ctx, ui, home } = testContext({ answers: [true, true] });
			writeFileSync(secretsPath(home), JSON.stringify({ version: 1, secrets: {} }), { mode: 0o644 });
			const calls: string[] = [];
			expect(await runSetup(ctx, section, fakeSteps(calls))).toBe(1);
			expect(calls).toEqual([]);
			expect(ui.shown).toHaveLength(1);
			expect(ui.shown[0]!.kind).toBe("log.error");
			expect(ui.shown[0]!.message).toContain("chmod 600");
		});
	}

	test("an unparseable secrets.json refuses and is left as is", async () => {
		const { ctx, ui, home } = testContext({ answers: [] });
		writeFileSync(secretsPath(home), "{nope", { mode: 0o600 });
		expect(await runSetup(ctx, undefined, fakeSteps([]))).toBe(1);
		expect(ui.shown[0]!.message).toContain(`cannot parse ${secretsPath(home)}`);
		expect(readFileSync(secretsPath(home), "utf8")).toBe("{nope");
	});

	test("testContext hides the developer's provider credentials from the host", async () => {
		vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-from-the-shell");
		vi.stubEnv("OPENAI_API_KEY", "sk-from-the-shell");
		const { ctx } = testContext({ answers: [] });
		const host = await ctx.host();
		expect(await host.models.checkAuth("anthropic")).toBeUndefined();
		expect(await host.models.checkAuth("openai")).toBeUndefined();
		expect(ctx.env).toEqual({});
	});

	test("testContext's env is visible to the host, and ctx.env is exactly it", async () => {
		vi.stubEnv("OPENAI_API_KEY", "sk-from-the-shell");
		const { ctx } = testContext({ answers: [], env: { ANTHROPIC_API_KEY: "sk-ant-test" } });
		const host = await ctx.host();
		expect(await host.models.checkAuth("anthropic")).toBeDefined();
		expect(await host.models.checkAuth("openai")).toBeUndefined();
		expect(ctx.env).toEqual({ ANTHROPIC_API_KEY: "sk-ant-test" });
	});

	test("context settings() writes validated config", async () => {
		const { ctx, home } = testContext({ answers: [] });
		(await ctx.settings()).set({ global: true }, "github.visibility", "public");
		expect(readFileSync(join(home, "config.yaml"), "utf8")).toContain("visibility: public");
		await expect((async () => (await ctx.settings()).set({ global: true }, "github.visibility", "nope"))()).rejects.toThrow();
		expect(readFileSync(join(home, "config.yaml"), "utf8")).toContain("visibility: public");
	});

	test("context host() is cached; reloadHost() rebuilds host and settings", async () => {
		const { ctx } = testContext({ answers: [] });
		const h1 = await ctx.host();
		const s1 = await ctx.settings();
		expect(await ctx.host()).toBe(h1);
		expect(await ctx.settings()).toBe(s1);
		const h2 = await ctx.reloadHost();
		expect(h2).not.toBe(h1);
		expect(await ctx.host()).toBe(h2);
		expect(await ctx.settings()).not.toBe(s1);
		expect(h2.models.getModel("scripted", "architect")).toBeDefined();
	});

	test("runCommand never throws: exit codes, 127 for a missing binary, input and env", async () => {
		expect((await runCommand("sf-no-such-binary-xyz", [])).code).toBe(127);
		expect(await runCommand("sh", ["-c", "cat; echo err >&2; exit 3"], { input: "hi" })).toEqual({ code: 3, stdout: "hi", stderr: "err\n" });
		expect((await runCommand("sh", ["-c", "echo $SF_T"], { env: { SF_T: "bar" } })).stdout).toBe("bar\n");
	});

	test("testContext makes its store the default for store: refs", () => {
		const { ctx } = testContext({ answers: [] });
		ctx.secrets.set("boat", "k");
		expect(resolveSecret("store:boat")).toBe("k");
	});

	test("registry lists one step per section, in order, with section titles", async () => {
		expect(STEPS.map((s) => s.name)).toEqual([...SECTIONS]);
		expect(STEPS.map((s) => s.title)).toEqual([
			"Prerequisites",
			"GitHub",
			"Model providers",
			"Role models",
			"AQ testing (boat.dev)",
			"Web search (Parallel)",
			"Service",
		]);
	});
});
