// `factory serve` as a daemon: it detaches, keeps factory.pid / factory.log / web-url next to the config file, and
// `stop`, `status` and `web` find it from any working directory. Every test spawns real processes.
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";

const BIN = join(import.meta.dirname, "..", "bin", "factory");

interface Result {
	code: number;
	stdout: string;
	stderr: string;
}

/** Runs `bin/factory`; never throws. */
function factory(args: string[], cwd: string, extraEnv: Record<string, string> = {}): Promise<Result> {
	const env = { ...process.env, ...extraEnv };
	delete env.FACTORY_CONFIG;
	delete env.FACTORY_SCRIPTED;
	return new Promise((resolve) =>
		execFile(BIN, args, { cwd, env, timeout: 60_000 }, (err, stdout, stderr) => {
			const code = err ? (typeof err.code === "number" ? err.code : -1) : 0;
			resolve({ code, stdout, stderr });
		}),
	);
}

function cfg(dir: string, opts: { port?: number } = {}): string {
	const path = join(dir, "config.yaml");
	const q = (s: string) => JSON.stringify(s);
	writeFileSync(
		path,
		`version: 1
web: { port: ${opts.port ?? 0} }
storage: { path: ${q(join(dir, "f.sqlite"))} }
roles:
  architect: { model: scripted/architect }
  builder: { model: scripted/builder }
  helper: { model: scripted/helper }
  reviewer: { model: scripted/reviewer }
workdir: ${q(join(dir, "work"))}
sandbox: { enabled: false }
`,
	);
	return path;
}

const link = (out: string) => /http:\/\/\S+/.exec(out)?.[0] ?? "";
const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};
const readPid = (dir: string) => Number(readFileSync(join(dir, "factory.pid"), "utf8").trim());

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "sf-daemon-"));
});
afterEach(async () => {
	for (const config of [join(dir, "config.yaml"), join(dir, ".factory", "config.yaml")]) await factory(["stop", "--config", config], tmpdir());
	rmSync(dir, { recursive: true, force: true });
});

const serve = (extra: string[] = []) => factory(["serve", "--config", "config.yaml", "--fake-github", "gh", "--scripted", ...extra], dir);

test("serve detaches; status, web and stop work from another cwd", async () => {
	cfg(dir);
	const s = await serve();
	expect(s.code).toBe(0);
	expect(s.stdout).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?token=/m);
	expect(readFileSync(join(dir, "factory.pid"), "utf8")).toMatch(/^\d+\n$/);
	expect(statSync(join(dir, "factory.log")).mode & 0o777).toBe(0o600);
	const config = join(dir, "config.yaml");
	const st = await factory(["status", "--config", config], tmpdir());
	expect(st.code).toBe(0);
	expect(st.stdout).toMatch(/^running \(pid \d+\) http:/);
	expect(link(st.stdout)).toBe(link(s.stdout));
	expect((await fetch(new URL("/", link(st.stdout)))).status).toBe(401); // reachable
	const w = await factory(["web", "--config", config], tmpdir());
	expect(w.code).toBe(0);
	expect(w.stdout.trim()).toBe(link(s.stdout));
	const pid = readPid(dir);
	expect((await factory(["stop", "--config", config], tmpdir())).stdout.trim()).toBe("stopped");
	expect(existsSync(join(dir, "factory.pid"))).toBe(false);
	expect(existsSync(join(dir, "web-url"))).toBe(false);
	expect(alive(pid)).toBe(false);
});

test("a second serve refuses while one runs", async () => {
	cfg(dir);
	expect((await serve()).code).toBe(0);
	const again = await serve();
	expect(again.code).toBe(1);
	expect(again.stderr).toMatch(/already running \(pid \d+\)/);
	expect(again.stderr.trim().split("\n")).toHaveLength(1);
});

test("a busy port fails serve with exit 1 and no pid file", async () => {
	const busy = createServer();
	await new Promise<void>((r) => busy.listen(0, "127.0.0.1", () => r()));
	try {
		const port = (busy.address() as { port: number }).port;
		cfg(dir, { port });
		const s = await serve();
		expect(s.code).toBe(1);
		expect(s.stderr).toMatch(/^error: web UI: 127\.0\.0\.1:\d+ is in use/m);
		expect(s.stderr.trim().split("\n")).toHaveLength(1);
		expect(existsSync(join(dir, "factory.pid"))).toBe(false);
		// The port is checked before the factory opens its storage (and resumes runs).
		expect(existsSync(join(dir, "f.sqlite"))).toBe(false);
	} finally {
		await new Promise<void>((r) => busy.close(() => r()));
	}
});

test("a config that fails to load fails serve with exit 1", async () => {
	writeFileSync(join(dir, "config.yaml"), "version: [\n");
	const s = await serve();
	expect(s.code).toBe(1);
	expect(s.stderr).toMatch(/^error: config .*config\.yaml: /m);
	expect(s.stderr.trim().split("\n")).toHaveLength(1);
	expect(existsSync(join(dir, "factory.pid"))).toBe(false);
});

test("a legacy stages config fails serve with exit 1", async () => {
	writeFileSync(join(dir, "config.yaml"), "version: 1\nweb: { port: 0 }\nstages:\n  delivery: { ci: { mode: off } }\n");
	const s = await serve();
	expect(s.code).toBe(1);
	expect(s.stderr).toMatch(/removed sections \(stages\)/);
	expect(s.stderr.trim().split("\n")).toHaveLength(1);
	expect(existsSync(join(dir, "factory.pid"))).toBe(false);
});

test("an unknown serve option is refused", async () => {
	cfg(dir);
	const s = await serve(["--socket", "x.sock"]);
	expect(s.code).toBe(1);
	expect(s.stderr).toMatch(/unknown option --socket/);
	expect(existsSync(join(dir, "factory.pid"))).toBe(false);
});

test("a stale pid file is cleaned up", async () => {
	cfg(dir);
	expect((await serve()).code).toBe(0);
	const first = readPid(dir);
	process.kill(first, "SIGKILL");
	for (let i = 0; alive(first) && i < 100; i++) await new Promise((r) => setTimeout(r, 100));
	expect(alive(first)).toBe(false);
	const st = await factory(["status", "--config", "config.yaml"], dir);
	expect(st.code).toBe(1);
	expect(existsSync(join(dir, "factory.pid"))).toBe(false);
	const s = await serve();
	expect(s.code).toBe(0);
	const second = readPid(dir);
	expect(second).not.toBe(first);
	expect(alive(second)).toBe(true);
});

test("a pid file naming an unrelated live process is stale", async () => {
	cfg(dir);
	// The test runner is alive but isn't a factory: stop must not signal it.
	writeFileSync(join(dir, "factory.pid"), `${process.pid}\n`);
	const stop = await factory(["stop", "--config", "config.yaml"], dir);
	expect(stop.code).toBe(0);
	expect(stop.stdout.trim()).toBe("not running");
	expect(existsSync(join(dir, "factory.pid"))).toBe(false);
	// Nor does it keep serve from starting.
	writeFileSync(join(dir, "factory.pid"), `${process.pid}\n`);
	const s = await serve();
	expect(s.code).toBe(0);
	const pid = readPid(dir);
	expect(pid).not.toBe(process.pid);
	expect(alive(pid)).toBe(true);
});

test("first serve on a fresh install creates the config directory", async () => {
	// HOME points into the temp dir, so the default ~/.factory/config.yaml (and its storage) live there.
	const home = { HOME: dir };
	const config = join(dir, ".factory", "config.yaml");
	expect(existsSync(join(dir, ".factory"))).toBe(false);
	const s = await factory(["serve", "--scripted", "--port", "0"], dir, home);
	expect(s.stderr).toBe("");
	expect(s.code).toBe(0);
	expect(s.stdout).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?token=/m);
	expect(existsSync(config)).toBe(true);
	expect(existsSync(join(dir, ".factory", "factory.pid"))).toBe(true);
	expect((await factory(["stop"], tmpdir(), home)).stdout.trim()).toBe("stopped");
});

test("stop/status/web with nothing running", async () => {
	cfg(dir);
	const stop = await factory(["stop", "--config", "config.yaml"], dir);
	expect(stop.code).toBe(0);
	expect(stop.stdout.trim()).toBe("not running");
	const status = await factory(["status", "--config", "config.yaml"], dir);
	expect(status.code).toBe(1);
	expect(status.stdout.trim()).toBe("not running");
	const web = await factory(["web", "--config", "config.yaml"], dir);
	expect(web.code).toBe(1);
	expect(web.stderr).toMatch(/not running/);
});
