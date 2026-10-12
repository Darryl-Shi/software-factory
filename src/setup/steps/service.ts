// Setup section "service" (spec §3.4): runs the factory as a systemd user unit (linux) or a launchd agent (darwin).
// Everything goes through ctx.run, ctx.platform, ctx.homedir and ctx.env; no credentials are written into the files.
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, rmSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { daemonFiles, stopDaemon } from "../../daemon.ts";
import { LABEL, UNIT } from "../../update/restart.ts";
import type { SetupContext, Step, StepStatus } from "../context.ts";

export function servicePaths(homedir: string): { unit: string; plist: string } {
	return {
		unit: join(homedir, ".config", "systemd", "user", `${UNIT}.service`),
		plist: join(homedir, "Library", "LaunchAgents", `${LABEL}.plist`),
	};
}

/** The command `bin/factory` runs, with absolute paths: `serve --foreground` for the given config. */
function command(o: { node: string; repoRoot: string; configPath: string }): string[] {
	return [
		o.node,
		"--import",
		`${o.repoRoot}/node_modules/tsx/dist/esm/index.mjs`,
		"--no-warnings",
		`${o.repoRoot}/src/cli.ts`,
		"serve",
		"--foreground",
		"--config",
		o.configPath,
	];
}

/** A systemd value: `%` is a specifier, so it is doubled; a word with whitespace, quotes or backslashes is quoted. */
function systemdWord(s: string): string {
	const v = s.replaceAll("%", "%%");
	return /[\s"'\\]/.test(v) ? `"${v.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"` : v;
}

export function systemdUnit(o: { node: string; repoRoot: string; configPath: string; path: string }): string {
	return [
		"[Unit]",
		"Description=software factory",
		"After=network-online.target",
		"[Service]",
		`ExecStart=${command(o).map(systemdWord).join(" ")}`,
		`Environment=${systemdWord(`PATH=${o.path}`)}`,
		"Restart=on-failure",
		"[Install]",
		"WantedBy=default.target",
		"",
	].join("\n");
}

const xml = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

export function launchdPlist(o: { node: string; repoRoot: string; configPath: string; path: string; log: string }): string {
	return [
		'<?xml version="1.0" encoding="UTF-8"?>',
		'<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
		'<plist version="1.0">',
		"<dict>",
		"\t<key>Label</key>",
		`\t<string>${LABEL}</string>`,
		"\t<key>ProgramArguments</key>",
		"\t<array>",
		...command(o).map((a) => `\t\t<string>${xml(a)}</string>`),
		"\t</array>",
		"\t<key>EnvironmentVariables</key>",
		"\t<dict>",
		"\t\t<key>PATH</key>",
		`\t\t<string>${xml(o.path)}</string>`,
		"\t</dict>",
		"\t<key>RunAtLoad</key>",
		"\t<true/>",
		"\t<key>KeepAlive</key>",
		"\t<dict>",
		"\t\t<key>SuccessfulExit</key>",
		"\t\t<false/>",
		"\t</dict>",
		"\t<key>StandardOutPath</key>",
		`\t<string>${xml(o.log)}</string>`,
		"\t<key>StandardErrorPath</key>",
		`\t<string>${xml(o.log)}</string>`,
		"</dict>",
		"</plist>",
		"",
	].join("\n");
}

type Kind = "systemd" | "launchd";

function kindOf(platform: NodeJS.Platform): Kind | undefined {
	if (platform === "linux") return "systemd";
	if (platform === "darwin") return "launchd";
	return undefined;
}

const uid = () => process.getuid?.() ?? 0;

function fileOf(ctx: SetupContext, kind: Kind): string {
	const p = servicePaths(ctx.homedir);
	return kind === "systemd" ? p.unit : p.plist;
}

async function isActive(ctx: SetupContext, kind: Kind): Promise<boolean> {
	const r =
		kind === "systemd"
			? await ctx.run("systemctl", ["--user", "is-active", UNIT])
			: await ctx.run("launchctl", ["print", `gui/${uid()}/${LABEL}`]);
	return r.code === 0;
}

/** Runs the commands in order; on the first failure shows its output and the commands left to run by hand
 * (those not run yet, then `after`, the steps that would have followed them). */
async function runAll(ctx: SetupContext, cmds: [string, string[]][], after: string[] = []): Promise<boolean> {
	const line = ([cmd, args]: [string, string[]]) => [cmd, ...args].join(" ");
	for (const [i, c] of cmds.entries()) {
		const r = await ctx.run(c[0], c[1]);
		if (r.code === 0) continue;
		const out = (r.stderr || r.stdout).trim();
		ctx.ui.log.error(out ? `${line(c)} failed: ${out}` : `${line(c)} failed (exit ${r.code})`);
		ctx.ui.log.info(`run it yourself: ${[...cmds.slice(i).map(line), ...after].join(" && ")}`);
		return false;
	}
	return true;
}

async function install(ctx: SetupContext, kind: Kind, active: boolean): Promise<void> {
	// A `factory serve` left running makes the service fail with `already running` (and systemd gives up on it).
	let daemonUp = false;
	if (ctx.daemon.pid() !== undefined && !active) {
		daemonUp = true;
		if (await ctx.ui.confirm({ message: "Stop the running factory first?", initial: true })) {
			try {
				await stopDaemon(ctx.configPath);
				daemonUp = false;
			} catch (e) {
				ctx.ui.log.error((e as Error).message);
			}
		}
	}
	const warnDaemonUp = () => {
		if (!daemonUp) return;
		const restart = kind === "systemd" ? `systemctl --user restart ${UNIT}` : `launchctl kickstart -k gui/${uid()}/${LABEL}`;
		ctx.ui.log.warn(`the service will fail while the running factory is up; stop it, then run: ${restart}`);
	};
	const file = fileOf(ctx, kind);
	const o = { node: process.execPath, repoRoot: ctx.repoRoot, configPath: ctx.configPath, path: ctx.env.PATH ?? "" };
	mkdirSync(dirname(file), { recursive: true });
	const log = daemonFiles(ctx.configPath).log;
	writeFileSync(file, kind === "systemd" ? systemdUnit(o) : launchdPlist({ ...o, log }));
	// The log gets the web UI link with its token; launchd would create it with the default umask.
	mkdirSync(dirname(log), { recursive: true });
	closeSync(openSync(log, "a", 0o600));
	chmodSync(log, 0o600);

	if (kind === "launchd") {
		// A loaded agent keeps its old definition, and bootstrap refuses it: unload it first.
		const cmds: [string, string[]][] = active ? [["launchctl", ["bootout", `gui/${uid()}/${LABEL}`]]] : [];
		cmds.push(["launchctl", ["bootstrap", `gui/${uid()}`, file]]);
		if (!(await runAll(ctx, cmds))) return;
		ctx.ui.log.success(`installed ${file}`);
		warnDaemonUp();
		return;
	}

	const cmds: [string, string[]][] = [
		["systemctl", ["--user", "daemon-reload"]],
		["systemctl", ["--user", "enable", "--now", UNIT]],
	];
	// enable --now leaves a running unit alone; a reinstall restarts it on the new unit file.
	if (active) cmds.push(["systemctl", ["--user", "restart", UNIT]]);
	if (!(await runAll(ctx, cmds))) return;
	ctx.ui.log.success(`installed ${file}`);
	warnDaemonUp();

	const user = ctx.env.USER || userInfo().username;
	const linger = await ctx.run("loginctl", ["show-user", user, "-p", "Linger"]);
	if (linger.code === 0 && linger.stdout.trim() === "Linger=no") {
		if (await ctx.ui.confirm({ message: "Keep the factory running when you are logged out (loginctl enable-linger)?", initial: true })) {
			await runAll(ctx, [["loginctl", ["enable-linger", user]]]);
		}
	}
}

/** An env var name, as pi reports a provider credential read from the environment (`checkAuth().source`). */
const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;

/**
 * The credentials the factory reads from the environment, which a service started by systemd or launchd won't have
 * (its unit sets only PATH): one line per credential, naming the setup section that stores it instead.
 */
async function envCredentials(ctx: SetupContext): Promise<string[]> {
	const line = (name: string, what: string, section: string) =>
		`${name} (${what}) is read from the environment, which the service won't have; run factory setup ${section} to store it`;
	const lines: string[] = [];
	const eff = (await ctx.settings()).effective({ global: true });
	const id = eff.github?.identity ?? {};
	const refs: [string, unknown, string][] = [
		id.kind === "app" ? ["github.identity.privateKeyRef", id.privateKeyRef, "github"] : ["github.identity.tokenRef", id.tokenRef ?? "env:GH_TOKEN", "github"],
		// With AQ testing off globally, the boat key is not used.
		...(eff.qa?.enabled === false ? [] : [["boat.apiKey", eff.boat?.apiKey, "qa"] as [string, unknown, string]]),
		["webSearch.apiKey", eff.webSearch?.apiKey, "search"],
	];
	for (const [path, ref, section] of refs) {
		const name = typeof ref === "string" && ref.startsWith("env:") ? ref.slice(4) : undefined;
		if (name && ctx.env[name]) lines.push(line(name, path, section));
	}
	const providers = new Set<string>();
	for (const r of Object.values(eff.roles ?? {}) as { model?: unknown }[]) if (typeof r?.model === "string") providers.add(r.model.split("/")[0]!);
	const { models } = await ctx.host();
	for (const p of providers) {
		const auth = await models.checkAuth(p).catch(() => undefined);
		if (auth?.type === "api_key" && auth.source && ENV_NAME.test(auth.source)) lines.push(line(auth.source, `provider ${p}`, "models"));
	}
	return lines;
}

/** Warns about credentials the service won't see; true to install anyway (the default). */
async function confirmEnvCredentials(ctx: SetupContext): Promise<boolean> {
	let lines: string[];
	try {
		lines = await envCredentials(ctx);
	} catch (e) {
		// A broken config or model host must not block the install; it only skips the warning.
		ctx.ui.log.warn(`could not check which credentials come from the environment: ${(e as Error).message}`);
		return true;
	}
	if (lines.length === 0) return true;
	ctx.ui.log.warn(lines.join("\n"));
	return ctx.ui.confirm({ message: "Install the service anyway?", initial: true });
}

async function remove(ctx: SetupContext, kind: Kind, active: boolean): Promise<void> {
	const file = fileOf(ctx, kind);
	if (kind === "systemd") {
		if (!(await runAll(ctx, [["systemctl", ["--user", "disable", "--now", UNIT]]], [`rm ${file}`, "systemctl --user daemon-reload"]))) return;
		rmSync(file, { force: true });
		await runAll(ctx, [["systemctl", ["--user", "daemon-reload"]]]);
	} else {
		// bootout fails on an agent that is not loaded; only a loaded one needs it.
		if (active && !(await runAll(ctx, [["launchctl", ["bootout", `gui/${uid()}/${LABEL}`]]], [`rm ${file}`]))) return;
		rmSync(file, { force: true });
	}
	ctx.ui.log.success(`removed ${file}`);
}

async function status(ctx: SetupContext): Promise<StepStatus> {
	const kind = kindOf(ctx.platform);
	if (!kind) return { state: "missing", detail: `no service support on ${ctx.platform}` };
	if (!existsSync(fileOf(ctx, kind))) return { state: "missing", detail: "not installed" };
	return (await isActive(ctx, kind)) ? { state: "ok", detail: "installed, active" } : { state: "warn", detail: "installed, not active" };
}

export const step: Step = {
	name: "service",
	title: "Service",
	status,
	async run(ctx) {
		const kind = kindOf(ctx.platform);
		if (!kind) {
			ctx.ui.log.warn(`no service support on ${ctx.platform}`);
			return;
		}
		const installed = existsSync(fileOf(ctx, kind));
		const active = await isActive(ctx, kind);
		const options: { value: "install" | "remove" | "skip"; label: string; hint?: string }[] = [
			{ value: "install", label: installed ? "Reinstall" : "Install", hint: kind === "systemd" ? "systemd user unit" : "launchd agent" },
		];
		if (installed) options.push({ value: "remove", label: "Remove" });
		options.push({ value: "skip", label: "Skip" });
		const action = await ctx.ui.select({ message: "Run the factory as a service?", options, initial: installed ? "skip" : "install" });
		if (action === "install") {
			if (await confirmEnvCredentials(ctx)) await install(ctx, kind, active);
		}
		else if (action === "remove") await remove(ctx, kind, active);
	},
};
