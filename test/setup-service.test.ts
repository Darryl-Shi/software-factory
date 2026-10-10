// Setup section "service" (spec §3.4): systemd user unit on linux, launchd agent on darwin. Commands are stubbed.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { setDefaultSecretStore } from "../src/core/settings.ts";
import type { RunResult } from "../src/setup/context.ts";
import { launchdPlist, servicePaths, step, systemdUnit } from "../src/setup/steps/service.ts";
import { testContext } from "./setup-context.ts";

afterEach(() => setDefaultSecretStore(undefined));

type Reply = Partial<RunResult>;

/** A `run` stub: records `cmd args...` lines; replies come from `replies` by exact line (default: code 0, no output). */
function stubRun(replies: Record<string, Reply> = {}) {
	const calls: string[] = [];
	const run = async (cmd: string, args: string[]): Promise<RunResult> => {
		const line = [cmd, ...args].join(" ");
		calls.push(line);
		const r = replies[line] ?? {};
		return { code: r.code ?? 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
	};
	return { calls, run };
}

const uid = process.getuid?.() ?? 0;
const tsx = (repo: string) => `${repo}/node_modules/tsx/dist/esm/index.mjs`;

describe("setup service", () => {
	test("unit content matches", () => {
		const unit = systemdUnit({ node: "/usr/bin/node", repoRoot: "/opt/sf", configPath: "/h/.factory/config.yaml", path: "/usr/local/bin:/usr/bin" });
		const lines = unit.split("\n");
		expect(lines).toContain(
			"ExecStart=/usr/bin/node --import /opt/sf/node_modules/tsx/dist/esm/index.mjs --no-warnings /opt/sf/src/cli.ts serve --foreground --config /h/.factory/config.yaml",
		);
		expect(lines).toContain("Environment=PATH=/usr/local/bin:/usr/bin");
		expect(lines).toContain("Restart=on-failure");
		expect(lines).toContain("WantedBy=default.target");
		expect(lines).toContain("[Unit]");
		expect(lines).toContain("[Service]");
		expect(lines).toContain("[Install]");
		expect(lines).toContain("After=network-online.target");
		expect(servicePaths("/h")).toEqual({
			unit: "/h/.config/systemd/user/software-factory.service",
			plist: "/h/Library/LaunchAgents/dev.software-factory.plist",
		});
	});

	test("install runs daemon-reload and enable --now, offers linger when Linger=no", async () => {
		const { calls, run } = stubRun({
			"systemctl --user is-active software-factory": { code: 3, stdout: "inactive\n" },
			"loginctl show-user alice -p Linger": { stdout: "Linger=no\n" },
		});
		const { ctx, ui } = testContext({ answers: ["install", true], run, env: { PATH: "/usr/bin:/bin", USER: "alice" } });
		expect(await step.status(ctx)).toEqual({ state: "missing", detail: "not installed" });
		await step.run(ctx);
		const unit = readFileSync(servicePaths(ctx.homedir).unit, "utf8");
		expect(unit).toBe(systemdUnit({ node: process.execPath, repoRoot: ctx.repoRoot, configPath: ctx.configPath, path: "/usr/bin:/bin" }));
		expect(unit).toContain(`ExecStart=${process.execPath} --import ${tsx(ctx.repoRoot)} --no-warnings ${ctx.repoRoot}/src/cli.ts serve --foreground --config ${ctx.configPath}`);
		expect(calls).toEqual([
			"systemctl --user is-active software-factory",
			"systemctl --user daemon-reload",
			"systemctl --user enable --now software-factory",
			"loginctl show-user alice -p Linger",
			"loginctl enable-linger alice",
		]);
		expect(ui.shown.find((s) => s.kind === "select")?.options).toEqual(["install", "skip"]);
		expect(ui.shown.filter((s) => s.kind === "confirm").map((s) => s.message)).toEqual([
			"Keep the factory running when you are logged out (loginctl enable-linger)?",
		]);
		expect(ui.shown.filter((s) => s.kind === "log.error")).toEqual([]);
		expect(ui.remaining()).toBe(0);
	});

	test("install offers to stop a running factory first; linger already on is not offered", async () => {
		const { calls, run } = stubRun({
			"systemctl --user is-active software-factory": { code: 3 },
			"loginctl show-user alice -p Linger": { stdout: "Linger=yes\n" },
		});
		// daemonPid is a stub; stopDaemon reads the temp home's (absent) pid file, so nothing is signalled.
		const { ctx, ui } = testContext({ answers: ["install", true], run, env: { PATH: "/usr/bin", USER: "alice" }, daemonPid: 999_999_999 });
		await step.run(ctx);
		expect(ui.shown.filter((s) => s.kind === "confirm").map((s) => s.message)).toEqual(["Stop the running factory first?"]);
		expect(calls).not.toContain("loginctl enable-linger alice");
		expect(calls).toContain("systemctl --user enable --now software-factory");
		expect(ui.remaining()).toBe(0);
	});

	test("declining to stop the running factory installs, then warns with the restart command", async () => {
		const { calls, run } = stubRun({
			"systemctl --user is-active software-factory": { code: 3 },
			"loginctl show-user alice -p Linger": { stdout: "Linger=yes\n" },
		});
		const { ctx, ui } = testContext({ answers: ["install", false], run, env: { PATH: "/usr/bin", USER: "alice" }, daemonPid: 999_999_999 });
		await step.run(ctx);
		expect(calls).toContain("systemctl --user enable --now software-factory");
		expect(ui.shown.filter((s) => s.kind === "log.warn").map((s) => s.message)).toEqual([
			"the service will fail while the running factory is up; stop it, then run: systemctl --user restart software-factory",
		]);
		expect(ui.remaining()).toBe(0);
	});

	test("darwin: declining to stop warns with launchctl kickstart", async () => {
		const { run } = stubRun({ [`launchctl print gui/${uid}/dev.software-factory`]: { code: 113 } });
		const { ctx, ui } = testContext({ answers: ["install", false], run, platform: "darwin", env: { PATH: "/usr/bin" }, daemonPid: 999_999_999 });
		await step.run(ctx);
		expect(ui.shown.filter((s) => s.kind === "log.warn").map((s) => s.message)).toEqual([
			`the service will fail while the running factory is up; stop it, then run: launchctl kickstart -k gui/${uid}/dev.software-factory`,
		]);
	});

	test("remove failure keeps the unit and the manual command includes rm and daemon-reload", async () => {
		const { calls, run } = stubRun({ "systemctl --user disable --now software-factory": { code: 1, stderr: "Failed to connect to bus\n" } });
		const { ctx, ui } = testContext({ answers: ["remove"], run });
		const unit = servicePaths(ctx.homedir).unit;
		mkdirSync(dirname(unit), { recursive: true });
		writeFileSync(unit, "x");
		await step.run(ctx);
		expect(existsSync(unit)).toBe(true);
		expect(calls.at(-1)).toBe("systemctl --user disable --now software-factory");
		expect(ui.shown.filter((s) => s.kind === "log.info").map((s) => s.message)).toEqual([
			`run it yourself: systemctl --user disable --now software-factory && rm ${unit} && systemctl --user daemon-reload`,
		]);
	});

	test("systemctl failure keeps the unit and shows the manual command", async () => {
		const { calls, run } = stubRun({
			"systemctl --user is-active software-factory": { code: 3 },
			"systemctl --user enable --now software-factory": { code: 1, stderr: "Failed to connect to bus\n" },
		});
		const { ctx, ui } = testContext({ answers: ["install"], run, env: { PATH: "/usr/bin", USER: "alice" } });
		await step.run(ctx);
		expect(existsSync(servicePaths(ctx.homedir).unit)).toBe(true);
		expect(calls.at(-1)).toBe("systemctl --user enable --now software-factory");
		const errors = ui.shown.filter((s) => s.kind === "log.error").map((s) => s.message);
		expect(errors).toEqual(["systemctl --user enable --now software-factory failed: Failed to connect to bus"]);
		expect(ui.shown.filter((s) => s.kind === "log.info").map((s) => s.message)).toContain(
			"run it yourself: systemctl --user enable --now software-factory",
		);
		expect(ui.remaining()).toBe(0);
	});

	test("status: installed and active is ok, installed and inactive is warn", async () => {
		const active = stubRun();
		const a = testContext({ answers: [], run: active.run });
		const unit = servicePaths(a.ctx.homedir).unit;
		mkdirSync(dirname(unit), { recursive: true });
		writeFileSync(unit, "x");
		expect((await step.status(a.ctx)).state).toBe("ok");

		const inactive = stubRun({ "systemctl --user is-active software-factory": { code: 3 } });
		const b = testContext({ answers: [], run: inactive.run });
		const unitB = servicePaths(b.ctx.homedir).unit;
		mkdirSync(dirname(unitB), { recursive: true });
		writeFileSync(unitB, "x");
		expect((await step.status(b.ctx)).state).toBe("warn");
	});

	test("remove disables and deletes", async () => {
		const { calls, run } = stubRun();
		const { ctx, ui } = testContext({ answers: ["remove"], run, env: { USER: "alice" } });
		const unit = servicePaths(ctx.homedir).unit;
		mkdirSync(dirname(unit), { recursive: true });
		writeFileSync(unit, "x");
		await step.run(ctx);
		expect(ui.shown.find((s) => s.kind === "select")?.options).toEqual(["install", "remove", "skip"]);
		expect(existsSync(unit)).toBe(false);
		expect(calls).toEqual([
			"systemctl --user is-active software-factory",
			"systemctl --user disable --now software-factory",
			"systemctl --user daemon-reload",
		]);
		expect(ui.remaining()).toBe(0);
	});

	test("darwin writes the plist and bootstraps", async () => {
		const { calls, run } = stubRun({ [`launchctl print gui/${uid}/dev.software-factory`]: { code: 113 } });
		const { ctx, ui, home } = testContext({ answers: ["install"], run, platform: "darwin", env: { PATH: "/opt/homebrew/bin:/usr/bin" } });
		await step.run(ctx);
		const { plist } = servicePaths(ctx.homedir);
		const content = readFileSync(plist, "utf8");
		expect(content).toBe(
			launchdPlist({ node: process.execPath, repoRoot: ctx.repoRoot, configPath: ctx.configPath, path: "/opt/homebrew/bin:/usr/bin", log: join(home, "factory.log") }),
		);
		expect(content).toContain("<key>Label</key>\n\t<string>dev.software-factory</string>");
		expect(content).toContain(`<string>${tsx(ctx.repoRoot)}</string>`);
		expect(content).toContain("<key>PATH</key>\n\t\t<string>/opt/homebrew/bin:/usr/bin</string>");
		expect(content).toContain("<key>SuccessfulExit</key>\n\t\t<false/>");
		expect(content).toContain(`<key>StandardOutPath</key>\n\t<string>${join(home, "factory.log")}</string>`);
		expect(calls).toEqual([`launchctl print gui/${uid}/dev.software-factory`, `launchctl bootstrap gui/${uid} ${plist}`]);
		expect(statSync(join(home, "factory.log")).mode & 0o777).toBe(0o600);
		expect(ui.shown.filter((s) => s.kind === "log.error")).toEqual([]);
		expect(ui.shown.filter((s) => s.kind === "log.warn")).toEqual([]);
		expect(ui.remaining()).toBe(0);
	});

	test("darwin remove boots out and deletes", async () => {
		const { calls, run } = stubRun();
		const { ctx, ui } = testContext({ answers: ["remove"], run, platform: "darwin" });
		const { plist } = servicePaths(ctx.homedir);
		mkdirSync(dirname(plist), { recursive: true });
		writeFileSync(plist, "x");
		await step.run(ctx);
		expect(existsSync(plist)).toBe(false);
		expect(calls).toEqual([`launchctl print gui/${uid}/dev.software-factory`, `launchctl bootout gui/${uid}/dev.software-factory`]);
		expect(ui.remaining()).toBe(0);
	});

	test("install warns once about credentials read from the environment and asks to install anyway", async () => {
		const { calls, run } = stubRun({
			"systemctl --user is-active software-factory": { code: 3 },
			"loginctl show-user alice -p Linger": { stdout: "Linger=yes\n" },
		});
		const env = { PATH: "/usr/bin", USER: "alice", GH_TOKEN: "ghp_x", BOAT_API_KEY: "bk", PARALLEL_API_KEY: "pk", ANTHROPIC_API_KEY: "sk-ant" };
		const { ctx, ui } = testContext({ answers: ["install", true], run, env });
		await step.run(ctx);
		const warns = ui.shown.filter((s) => s.kind === "log.warn").map((s) => s.message);
		expect(warns).toEqual([
			[
				"GH_TOKEN (github.identity.tokenRef) is read from the environment, which the service won't have; run factory setup github to store it",
				"BOAT_API_KEY (boat.apiKey) is read from the environment, which the service won't have; run factory setup qa to store it",
				"PARALLEL_API_KEY (webSearch.apiKey) is read from the environment, which the service won't have; run factory setup search to store it",
				"ANTHROPIC_API_KEY (provider anthropic) is read from the environment, which the service won't have; run factory setup models to store it",
			].join("\n"),
		]);
		expect(ui.shown.filter((s) => s.kind === "confirm").map((s) => s.message)).toEqual(["Install the service anyway?"]);
		expect(calls).toContain("systemctl --user enable --now software-factory");
		expect(ui.remaining()).toBe(0);
	});

	test("declining to install anyway leaves the service alone", async () => {
		const { calls, run } = stubRun({ "systemctl --user is-active software-factory": { code: 3 } });
		const { ctx, ui } = testContext({ answers: ["install", false], run, env: { PATH: "/usr/bin", GH_TOKEN: "ghp_x" } });
		await step.run(ctx);
		expect(existsSync(servicePaths(ctx.homedir).unit)).toBe(false);
		expect(calls).toEqual(["systemctl --user is-active software-factory"]);
		expect(ui.remaining()).toBe(0);
	});

	test("BOAT_API_KEY is not listed when AQ testing is off globally", async () => {
		const { run } = stubRun({ "systemctl --user is-active software-factory": { code: 3 }, "loginctl show-user alice -p Linger": { stdout: "Linger=yes\n" } });
		const { ctx, ui } = testContext({
			answers: ["install", true],
			run,
			config: "version: 1\nqa:\n  enabled: false\n",
			env: { PATH: "/usr/bin", USER: "alice", BOAT_API_KEY: "bk", PARALLEL_API_KEY: "pk" },
		});
		await step.run(ctx);
		expect(ui.shown.filter((s) => s.kind === "log.warn").map((s) => s.message)).toEqual([
			"PARALLEL_API_KEY (webSearch.apiKey) is read from the environment, which the service won't have; run factory setup search to store it",
		]);
		expect(ui.remaining()).toBe(0);
	});

	test("a failing credential check warns and still installs", async () => {
		const { calls, run } = stubRun({ "systemctl --user is-active software-factory": { code: 3 }, "loginctl show-user alice -p Linger": { stdout: "Linger=yes\n" } });
		const { ctx, ui } = testContext({ answers: ["install"], run, env: { PATH: "/usr/bin", USER: "alice", GH_TOKEN: "ghp_x" } });
		ctx.host = async () => {
			throw new Error("extension exploded");
		};
		ctx.settings = async () => {
			throw new Error("config.yaml: bad yaml");
		};
		await step.run(ctx);
		expect(ui.shown.filter((s) => s.kind === "log.warn").map((s) => s.message)).toEqual([
			"could not check which credentials come from the environment: config.yaml: bad yaml",
		]);
		expect(ui.shown.filter((s) => s.kind === "confirm")).toEqual([]);
		expect(existsSync(servicePaths(ctx.homedir).unit)).toBe(true);
		expect(calls).toContain("systemctl --user enable --now software-factory");
		expect(ui.remaining()).toBe(0);
	});

	test("no warning when every credential is stored", async () => {
		const { calls, run } = stubRun({
			"systemctl --user is-active software-factory": { code: 3 },
			"loginctl show-user alice -p Linger": { stdout: "Linger=yes\n" },
		});
		const config = [
			"version: 1",
			"github:",
			"  identity: { kind: pat, tokenRef: store:github }",
			"boat:",
			"  apiKey: store:boat",
			"webSearch:",
			"  apiKey: store:parallel",
			"",
		].join("\n");
		// The env still has GH_TOKEN, but the config does not read it; anthropic and openai come from auth.json.
		const { ctx, ui, home } = testContext({ answers: ["install"], run, config, env: { PATH: "/usr/bin", USER: "alice", GH_TOKEN: "ghp_x" } });
		for (const k of ["github", "boat", "parallel"]) ctx.secrets.set(k, "v");
		mkdirSync(join(home, "pi"), { recursive: true });
		const auth = { anthropic: { type: "api_key", key: "k" }, openai: { type: "api_key", key: "k" } };
		writeFileSync(join(home, "pi", "auth.json"), JSON.stringify(auth), { mode: 0o600 });
		expect((await (await ctx.host()).models.checkAuth("anthropic"))?.source).toBe("stored credential");
		await step.run(ctx);
		expect(ui.shown.filter((s) => s.kind === "log.warn")).toEqual([]);
		expect(ui.shown.filter((s) => s.kind === "confirm")).toEqual([]);
		expect(calls).toContain("systemctl --user enable --now software-factory");
		expect(ui.remaining()).toBe(0);
	});

	test("other platforms warn", async () => {
		const { calls, run } = stubRun();
		const { ctx, ui } = testContext({ answers: [], run, platform: "win32" });
		await step.run(ctx);
		expect(ui.shown).toEqual([{ kind: "log.warn", message: "no service support on win32" }]);
		expect(calls).toEqual([]);
	});
});
