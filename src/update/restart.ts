// Restarting the factory the way it was started: the systemd user unit, the launchd agent, or the `factory serve`
// daemon. Shared by the setup wizard (src/setup/context.ts) and the updater's detached restart helper
// (src/update/helper.ts), which runs as its own process from a copy of this file: it imports node builtins only.
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type StartedBy = "systemd" | "launchd" | "daemon" | "foreground";
export type RunResult = { code: number; stdout: string; stderr: string };
export type Runner = (cmd: string, args: string[], opts?: { cwd?: string; env?: Record<string, string>; timeoutMs?: number }) => Promise<RunResult>;

/** Runs a command; never throws. A missing binary is code 127, a timeout or a signal code 1. */
export const runCommand: Runner = (cmd, args, opts = {}) =>
	new Promise((done) => {
		const child = execFile(
			cmd,
			args,
			{
				cwd: opts.cwd,
				env: opts.env ? { ...process.env, ...opts.env } : process.env,
				encoding: "utf8",
				maxBuffer: 64 * 1024 * 1024,
				...(opts.timeoutMs ? { timeout: opts.timeoutMs, killSignal: "SIGKILL" as const } : {}),
			},
			(err, stdout, stderr) => {
				if (!err) return done({ code: 0, stdout, stderr });
				const code = (err as NodeJS.ErrnoException).code as unknown;
				if (code === "ENOENT") return done({ code: 127, stdout, stderr: stderr || `${cmd}: command not found` });
				if (typeof code === "number") return done({ code, stdout, stderr });
				done({ code: 1, stdout, stderr: stderr || err.message });
			},
		);
		child.stdin?.end();
	});

export const UNIT = "software-factory";
export const LABEL = "dev.software-factory";
/** Set by startDaemon on the daemon child: the JSON array of the serve arguments it was started with. */
export const DAEMON_ENV = "FACTORY_DAEMON_ARGS";

/** How this process was started, from its environment: systemd (INVOCATION_ID and the unit active), launchd
 * (XPC_SERVICE_NAME is the agent's label), daemon (startDaemon's marker), else foreground. */
export async function detectStartedBy(env: NodeJS.ProcessEnv, run: Runner): Promise<{ startedBy: StartedBy; serveArgs: string[] }> {
	if (env.INVOCATION_ID && (await run("systemctl", ["--user", "is-active", UNIT]).catch(() => ({ code: 1 }))).code === 0)
		return { startedBy: "systemd", serveArgs: [] };
	if (env.XPC_SERVICE_NAME === LABEL) return { startedBy: "launchd", serveArgs: [] };
	const marker = env[DAEMON_ENV];
	if (marker !== undefined) {
		try {
			const args = JSON.parse(marker);
			if (Array.isArray(args) && args.every((a) => typeof a === "string")) return { startedBy: "daemon", serveArgs: args };
		} catch {}
	}
	return { startedBy: "foreground", serveArgs: [] };
}

/** How a factory that runs now was started, seen from another process (the setup wizard): the unit active, the
 * agent loaded, or else the daemon. */
export async function detectService(run: Runner, platform: NodeJS.Platform, uid = process.getuid?.() ?? 0): Promise<StartedBy> {
	if ((await run("systemctl", ["--user", "is-active", UNIT])).code === 0) return "systemd";
	if (platform === "darwin" && (await run("launchctl", ["print", `gui/${uid}/${LABEL}`])).code === 0) return "launchd";
	return "daemon";
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

/** SIGTERMs the pid in <home>/factory.pid and waits for it to exit (SIGKILL after timeoutMs). */
export async function stopByPidFile(configPath: string, timeoutMs = 60_000): Promise<void> {
	const file = join(dirname(configPath), "factory.pid");
	if (!existsSync(file)) return;
	const pid = Number(readFileSync(file, "utf8").trim());
	if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid || !alive(pid)) return;
	try {
		process.kill(pid, "SIGTERM");
	} catch {}
	const deadline = Date.now() + timeoutMs;
	while (alive(pid)) {
		if (Date.now() > deadline) {
			try {
				process.kill(pid, "SIGKILL");
			} catch {}
			await sleep(500);
			break;
		}
		await sleep(100);
	}
}

const lastLine = (r: RunResult) => (r.stderr || r.stdout).trim().split("\n").filter(Boolean).at(-1)?.replace(/^error: /, "") ?? `exit ${r.code}`;

/** Restarts the factory the way it was started. `root` is the install root (its bin/factory starts the daemon).
 * Throws with the command's last output line when the restart fails; a foreground factory can't be restarted. */
export async function restartFactory(
	how: StartedBy,
	o: { configPath: string; root: string; serveArgs: string[]; run: Runner; uid?: number },
): Promise<void> {
	if (how === "systemd") {
		const r = await o.run("systemctl", ["--user", "restart", UNIT]);
		if (r.code !== 0) throw new Error(`systemctl --user restart ${UNIT} failed: ${lastLine(r)}`);
		return;
	}
	if (how === "launchd") {
		const target = `gui/${o.uid ?? process.getuid?.() ?? 0}/${LABEL}`;
		const r = await o.run("launchctl", ["kickstart", "-k", target]);
		if (r.code !== 0) throw new Error(`launchctl kickstart -k ${target} failed: ${lastLine(r)}`);
		return;
	}
	if (how === "daemon") {
		await stopByPidFile(o.configPath);
		const r = await o.run(join(o.root, "bin", "factory"), ["serve", "--config", o.configPath, ...o.serveArgs], { cwd: o.root, timeoutMs: 120_000 });
		if (r.code !== 0) throw new Error(`factory serve failed: ${lastLine(r)}`);
		return;
	}
	throw new Error("a factory started in the foreground can't be restarted; restart it by hand");
}
