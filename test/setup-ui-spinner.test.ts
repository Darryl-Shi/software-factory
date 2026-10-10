// Ctrl-C during a ClackUi spinner (spec §5): clack's block() exits the process 0 on the cancel key in raw mode, and
// its own SIGINT handler only stops the spinner; both must end with exit code 130 and the cancel message.
import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { expect, test } from "vitest";

const repo = join(__dirname, "..");
const tsx = join(repo, "node_modules/tsx/dist/esm/index.mjs");
const MESSAGE = "setup cancelled; completed sections were saved";

const fixture = [process.execPath, "--import", tsx, join(__dirname, "fixtures/spinner-cancel.ts")];
// util-linux script(1) runs the child on a pseudo-terminal, so clack's block() puts a real TTY stdin in raw mode.
const hasScript = process.platform === "linux" && spawnSync("script", ["--version"]).status === 0;

function child(mode: string, onReady?: (c: ReturnType<typeof spawn>) => void, pty = false): Promise<{ code: number | null; out: string }> {
	const c = pty
		? spawn("script", ["-qec", [...fixture, mode].map((a) => `'${a}'`).join(" "), "/dev/null"], { stdio: "pipe", cwd: repo })
		: spawn(fixture[0]!, [...fixture.slice(1), mode], { stdio: "pipe", cwd: repo });
	let out = "";
	let ready = false;
	const read = (d: Buffer) => {
		out += d;
		if (!ready && out.includes("ready")) {
			ready = true;
			onReady?.(c);
		}
	};
	c.stdout!.on("data", read);
	c.stderr!.on("data", read);
	const timer = setTimeout(() => c.kill("SIGKILL"), 20_000);
	return new Promise((resolve) =>
		c.once("exit", (code) => {
			clearTimeout(timer);
			resolve({ code, out });
		}),
	);
}

test("process.exit(0) while a spinner runs (clack's raw-mode Ctrl-C) exits 130 with the cancel message", async () => {
	const { code, out } = await child("exit");
	expect(out).toContain(MESSAGE);
	expect(code).toBe(130);
}, 30_000);

test("SIGINT while a spinner runs (stdin not in raw mode) exits 130 with the cancel message", async () => {
	const { code, out } = await child("wait", (c) => c.kill("SIGINT"));
	expect(out).toContain(MESSAGE);
	expect(code).toBe(130);
}, 30_000);

test.skipIf(!hasScript)("Ctrl-C on a pseudo-terminal while a spinner runs (raw mode, block() exits 0) exits 130 with the cancel message", async () => {
	const { code, out } = await child("wait", (c) => c.stdin!.write("\x03"), true);
	expect(out).toContain(MESSAGE);
	expect(code).toBe(130);
}, 30_000);

test("after stop(), process.exit(0) exits 0 without the cancel message", async () => {
	const { code, out } = await child("stop");
	expect(out).not.toContain(MESSAGE);
	expect(code).toBe(0);
}, 30_000);
