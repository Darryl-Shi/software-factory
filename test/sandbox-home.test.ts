// The factory home: the sandbox hides only its secret and state entries, so a workdir inside the home (the dry run's
// layout) stays readable. Hermetic: the sandbox runtime is stubbed and the policy handed to it is inspected.
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as c } from "@earendil-works/chord/context";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { afterEach, describe, expect, test, vi } from "vitest";
import { Sandbox } from "../src/sandbox/sandbox.ts";

const PRIVATE = ["secrets.json", "pi/auth.json", "web-token", "web-url", "factory.log", "factory.sqlite", "factory.sqlite-wal", "factory.sqlite-shm", "environments/x.json", "qa-vms/y.json"];

function layout(enabled: boolean) {
	const home = realpathSync(mkdtempSync(join(tmpdir(), "sf-home-")));
	const stateDir = join(home, "environments");
	const worktree = join(home, "work", "runs", "r1");
	const scratch = join(home, "work", "scratch", "r1-reviewer");
	for (const d of [stateDir, worktree, scratch, join(home, "pi"), join(home, "qa-vms")]) mkdirSync(d, { recursive: true });
	for (const f of PRIVATE) writeFileSync(join(home, f), "SECRET");
	writeFileSync(join(home, "config.yaml"), "version: 1\n");
	writeFileSync(join(worktree, "AGENTS.md"), "# agents\n");
	const rec = {
		envId: "r1-reviewer",
		role: "reviewer",
		worktree,
		cwd: worktree,
		scratch,
		sandbox: { enabled, allowedDomains: [], deniedDomains: [], denyRead: [], extraWrite: [], unixSockets: "block" },
	};
	writeFileSync(join(stateDir, "r1-reviewer.json"), JSON.stringify(rec));
	const env = new Sandbox({ stateDir }).env({ conversationId: "c", envId: "r1-reviewer" });
	return { home, worktree, env };
}

afterEach(() => vi.restoreAllMocks());

describe("factory home inside the sandbox", () => {
	test("file tools (sandbox disabled): the worktree and config.yaml are readable; secrets and state are denied", async () => {
		const { home, worktree, env } = layout(false);
		const ok: any = await env.readTextFile(join(worktree, "AGENTS.md"), c);
		expect(ok).toEqual({ ok: true, value: "# agents\n" });
		expect(((await env.readTextFile("AGENTS.md", c)) as any).ok).toBe(true);
		expect(((await env.listDir(worktree, c)) as any).ok).toBe(true);
		expect(((await env.readTextFile(join(home, "config.yaml"), c)) as any).ok).toBe(true);
		for (const f of PRIVATE) {
			const r: any = await env.readTextFile(join(home, f), c);
			expect(r.ok, f).toBe(false);
			expect(String(r.error.message), f).toMatch(/is denied/);
		}
		for (const d of ["pi", "environments", "qa-vms"]) expect(((await env.listDir(join(home, d), c)) as any).ok, d).toBe(false);
	});

	test("commands: the policy handed to the sandbox runtime denies the home's secret entries, not the home", async () => {
		vi.spyOn(SandboxManager, "checkDependencies").mockReturnValue({ errors: [], warnings: [] } as any);
		vi.spyOn(SandboxManager, "initialize").mockResolvedValue(undefined as any);
		const wrap = vi.spyOn(SandboxManager, "wrapWithSandbox").mockImplementation(async (cmd: string) => cmd);
		const { home, worktree, env } = layout(true);
		await env.exec("true", undefined, c);
		const fs = (wrap.mock.calls.at(-1)![2] as any).filesystem as { denyRead: string[] };
		expect(fs.denyRead).not.toContain(home);
		expect(fs.denyRead.some((d) => worktree === d || worktree.startsWith(`${d}/`))).toBe(false);
		for (const e of ["secrets.json", "pi", "web-token", "web-url", "factory.log", "factory.sqlite", "factory.sqlite-wal", "factory.sqlite-shm", "environments", "qa-vms"]) expect(fs.denyRead, e).toContain(join(home, e));
		// file tools follow the same list with the sandbox on
		expect(((await env.readTextFile(join(worktree, "AGENTS.md"), c)) as any).ok).toBe(true);
		expect(((await env.readTextFile(join(home, "pi", "auth.json"), c)) as any).ok).toBe(false);
	});

	test("entries that do not exist yet are still denied (by name, under the real path of the home)", async () => {
		const { home, env } = layout(false);
		const r: any = await env.readTextFile(join(home, "pi", "models.json"), c);
		expect(r.ok).toBe(false);
		const late: any = await env.readTextFile(join(home, "factory.sqlite-journal"), c);
		expect(late.ok).toBe(false);
	});
});
