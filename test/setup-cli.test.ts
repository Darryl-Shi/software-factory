// `factory setup` as a real process: bin/factory spawned with piped stdio (so stdin and stdout are not TTYs) and a temp
// --config. Only the refusals before any prompt can run here; the wizard itself is covered by setup-wizard.test.ts.
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";

const BIN = join(import.meta.dirname, "..", "bin", "factory");

interface Result {
	code: number;
	stdout: string;
	stderr: string;
}

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "setup-cli-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Runs `bin/factory` with piped stdio and HOME in the temp dir; never throws. */
function factory(args: string[]): Promise<Result> {
	const env: NodeJS.ProcessEnv = { ...process.env, HOME: dir };
	delete env.FACTORY_CONFIG;
	delete env.FACTORY_SCRIPTED;
	return new Promise((resolve) => {
		const child = execFile(BIN, args, { cwd: dir, env, timeout: 60_000 }, (err, stdout, stderr) => {
			const code = err ? (typeof err.code === "number" ? err.code : -1) : 0;
			resolve({ code, stdout, stderr });
		});
		child.stdin?.end();
	});
}

const config = () => join(dir, "config.yaml");

test("non-TTY exits 1 with the interactive message", async () => {
	const r = await factory(["setup", "--config", config()]);
	expect(r.code).toBe(1);
	expect(r.stderr).toContain("factory setup is interactive; run it in a terminal");
	const one = await factory(["setup", "github", "--config", config()]);
	expect(one.code).toBe(1);
	expect(one.stderr).toContain("factory setup is interactive; run it in a terminal");
}, 60_000);

test("unknown section exits 1 listing sections", async () => {
	const r = await factory(["setup", "nope", "--config", config()]);
	expect(r.code).toBe(1);
	expect(r.stderr).toContain("error: unknown section nope; sections: prereqs, github, models, roles, qa, search, service");
	expect(r.stderr).not.toContain("interactive");
}, 60_000);

test("unknown option exits 1", async () => {
	const r = await factory(["setup", "--port", "1", "--config", config()]);
	expect(r.code).toBe(1);
	expect(r.stderr).toContain("error: unknown option --port");
}, 60_000);

test("--help lists factory setup", async () => {
	const r = await factory(["--help"]);
	expect(r.code).toBe(0);
	expect(r.stdout).toContain("factory setup [section] [--config p]");
}, 60_000);
