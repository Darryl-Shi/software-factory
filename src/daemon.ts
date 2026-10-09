// `factory serve` as a daemon: the detached factory process and the files it keeps next to the config file
// (factory.pid, factory.log, web-url). Every path here derives from an absolute config path.
import { spawn } from "node:child_process";
import { closeSync, existsSync, fstatSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export function daemonFiles(configPath: string): { pid: string; log: string; url: string } {
	const home = dirname(configPath);
	return { pid: join(home, "factory.pid"), log: join(home, "factory.log"), url: join(home, "web-url") };
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** The pid of the running factory, or undefined. A pid file whose process is gone is deleted. */
export function livePid(configPath: string): number | undefined {
	const file = daemonFiles(configPath).pid;
	if (!existsSync(file)) return undefined;
	const pid = Number(readFileSync(file, "utf8").trim());
	if (Number.isInteger(pid) && pid > 0 && isAlive(pid)) return pid;
	rmSync(file, { force: true });
	return undefined;
}

export function writePid(configPath: string): void {
	writeFileSync(daemonFiles(configPath).pid, `${process.pid}\n`);
}

export function removePid(configPath: string): void {
	rmSync(daemonFiles(configPath).pid, { force: true });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The last non-empty line the log got from byte `from` on (this start), without the CLI's `error: ` prefix. */
function lastLogLine(file: string, from: number): string | undefined {
	if (!existsSync(file)) return undefined;
	const line = readFileSync(file).subarray(from).toString("utf8").split("\n").map((l) => l.trim()).filter(Boolean).at(-1);
	return line?.replace(/^error: /, "");
}

/** The command that runs the factory CLI: bin/factory, or this node with src/cli.ts if the launcher is missing. */
function factoryCommand(): [string, string[]] {
	const bin = join(import.meta.dirname, "..", "bin", "factory");
	if (existsSync(bin)) return [bin, []];
	return [process.execPath, [...process.execArgv, join(import.meta.dirname, "cli.ts")]];
}

/** Starts `factory serve --foreground` detached; resolves once it has written its pid file and web-url. */
export async function startDaemon(configPath: string, serveArgs: string[], timeoutMs = 30_000): Promise<{ pid: number; url: string }> {
	const files = daemonFiles(configPath);
	rmSync(files.url, { force: true }); // left behind by a factory that was killed; no factory runs now
	const [cmd, pre] = factoryCommand();
	const out = openSync(files.log, "a", 0o600); // the log carries the web UI link with its token
	const logStart = fstatSync(out).size;
	let child;
	try {
		child = spawn(cmd, [...pre, "serve", "--foreground", "--config", configPath, ...serveArgs], { detached: true, stdio: ["ignore", out, out] });
	} finally {
		closeSync(out);
	}
	let exit: number | string | undefined;
	child.once("exit", (code, signal) => (exit = code ?? signal ?? "unknown"));
	child.once("error", (e) => (exit = e.message));
	child.unref();
	const pid = child.pid;
	const deadline = Date.now() + timeoutMs;
	while (exit === undefined && pid !== undefined && Date.now() < deadline) {
		if (livePid(configPath) === pid && existsSync(files.url)) return { pid, url: readFileSync(files.url, "utf8").trim() };
		await sleep(100);
	}
	if (exit === undefined && pid !== undefined) {
		try {
			process.kill(pid, "SIGTERM");
		} catch {}
		throw new Error(lastLogLine(files.log, logStart) ?? `the factory did not start within ${timeoutMs / 1000}s`);
	}
	throw new Error(lastLogLine(files.log, logStart) ?? (pid === undefined ? `could not run ${cmd}` : `the factory exited (${exit}) before it started`));
}

/** Stops the running factory (SIGTERM) and waits until its process is gone. */
export async function stopDaemon(configPath: string, timeoutMs = 10_000): Promise<"stopped" | "not running"> {
	const pid = livePid(configPath);
	if (pid === undefined) return "not running";
	try {
		process.kill(pid, "SIGTERM");
	} catch {}
	const deadline = Date.now() + timeoutMs;
	while (isAlive(pid)) {
		if (Date.now() >= deadline) throw new Error(`factory (pid ${pid}) did not stop within ${timeoutMs / 1000}s`);
		await sleep(100);
	}
	livePid(configPath); // removes the pid file if the process died without removing it
	return "stopped";
}
