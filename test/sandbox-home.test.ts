// The factory home: the sandbox denies the whole home as a directory (a tmpfs under bwrap, so files renamed or created
// in it later stay hidden) and re-allows the environment's own roots inside it (worktree, git dir, scratch, extraWrite),
// so a workdir inside the home (the dry run's layout) stays readable. The most specific rule wins, as in the sandbox
// runtime: a denyRead entry inside an allowed root is still denied. Hermetic: the sandbox runtime is stubbed and the
// policy handed to it is inspected.
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as c } from "@earendil-works/chord/context";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { afterEach, describe, expect, test, vi } from "vitest";
import { Sandbox } from "../src/sandbox/sandbox.ts";

const PRIVATE = ["secrets.json", "secrets.json.123.tmp", "pi/auth.json", "web-token", "web-url", "factory.log", "factory.sqlite", "factory.sqlite-wal", "factory.sqlite-shm", "environments/x.json", "qa-vms/y.json", "config.yaml"];

function layout(enabled: boolean, over: { denyRead?: string[]; extraWrite?: string[]; role?: string; storage?: string } = {}) {
	const home = realpathSync(mkdtempSync(join(tmpdir(), "sf-home-")));
	const stateDir = join(home, "environments");
	const worktree = join(home, "work", "runs", "r1");
	const scratch = join(home, "work", "scratch", "r1-reviewer");
	for (const d of [stateDir, worktree, scratch, join(home, "pi"), join(home, "qa-vms")]) mkdirSync(d, { recursive: true });
	for (const f of PRIVATE) writeFileSync(join(home, f), "SECRET");
	writeFileSync(join(worktree, "AGENTS.md"), "# agents\n");
	writeFileSync(join(worktree, ".env"), "TOKEN=x\n");
	const rec = {
		envId: "r1-reviewer",
		role: over.role ?? "reviewer",
		worktree,
		cwd: worktree,
		scratch,
		sandbox: { enabled, allowedDomains: [], deniedDomains: [], denyRead: (over.denyRead ?? []).map((p) => p.replace("<home>", home)), extraWrite: (over.extraWrite ?? []).map((p) => p.replace("<home>", home)), unixSockets: "block" },
		...(over.storage ? { storage: over.storage } : {}),
	};
	writeFileSync(join(stateDir, "r1-reviewer.json"), JSON.stringify(rec));
	const sandbox = new Sandbox({ stateDir });
	const env = sandbox.env({ conversationId: "c", envId: "r1-reviewer" });
	return { home, worktree, scratch, env, sandbox };
}

function stubRuntime() {
	vi.spyOn(SandboxManager, "checkDependencies").mockReturnValue({ errors: [], warnings: [] } as any);
	vi.spyOn(SandboxManager, "initialize").mockResolvedValue(undefined as any);
	return vi.spyOn(SandboxManager, "wrapWithSandbox").mockImplementation(async (cmd: string) => cmd);
}

const read = async (env: any, p: string) => ((await env.readTextFile(p, c)) as any).ok as boolean;

afterEach(() => vi.restoreAllMocks());

describe("factory home inside the sandbox", () => {
	test("file tools (sandbox disabled): the worktree inside the home is readable; the rest of the home is denied", async () => {
		const { home, worktree, scratch, env } = layout(false);
		expect(await env.readTextFile(join(worktree, "AGENTS.md"), c)).toEqual({ ok: true, value: "# agents\n" });
		expect(await read(env, "AGENTS.md")).toBe(true);
		expect(((await env.listDir(worktree, c)) as any).ok).toBe(true);
		writeFileSync(join(scratch, "note"), "n");
		expect(await read(env, join(scratch, "note"))).toBe(true);
		for (const f of PRIVATE) {
			const r: any = await env.readTextFile(join(home, f), c);
			expect(r.ok, f).toBe(false);
			expect(String(r.error.message), f).toMatch(/is denied/);
		}
		// the home itself (a crash leaves secrets.json.<pid>.tmp behind), and files that do not exist yet
		expect(((await env.listDir(home, c)) as any).ok).toBe(false);
		expect(((await env.listDir(join(home, "work"), c)) as any).ok).toBe(false);
		expect(await read(env, join(home, "pi", "models.json"))).toBe(false);
		expect(await read(env, join(home, "anything-new"))).toBe(false);
	});

	test("a denyRead entry inside the worktree is still denied (the more specific rule wins)", async () => {
		const { worktree, env } = layout(false, { denyRead: ["<home>/work/runs/r1/.env"] });
		expect(await read(env, join(worktree, ".env"))).toBe(false);
		expect(await read(env, join(worktree, "AGENTS.md"))).toBe(true);
	});

	test("an extraWrite at the home or inside its private entries does not re-allow them", async () => {
		const { home, env } = layout(false, { role: "builder", extraWrite: ["<home>", "<home>/pi"] });
		expect(await read(env, join(home, "secrets.json"))).toBe(false);
		expect(await read(env, join(home, "pi", "auth.json"))).toBe(false);
		expect(await read(env, join(home, "config.yaml"))).toBe(false);
		expect(((await env.writeFile(join(home, "pi", "x"), "x", c)) as any).ok).toBe(false);
	});

	test("an extraWrite elsewhere inside the home is re-allowed", async () => {
		const { home, env } = layout(false, { role: "builder", extraWrite: ["<home>/cache"] });
		mkdirSync(join(home, "cache"));
		writeFileSync(join(home, "cache", "f"), "x");
		expect(await read(env, join(home, "cache", "f"))).toBe(true);
	});

	test("the storage path from the run's config (and its -wal/-shm/-journal) is denied wherever it lives", async () => {
		const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), "sf-store-")));
		const db = join(elsewhere, "f.sqlite");
		for (const s of ["", "-wal", "-shm", "-journal"]) writeFileSync(db + s, "DB");
		writeFileSync(join(elsewhere, "other"), "x");
		const { env } = layout(false, { storage: db });
		for (const s of ["", "-wal", "-shm", "-journal"]) expect(await read(env, db + s), s).toBe(false);
		expect(await read(env, join(elsewhere, "other"))).toBe(true);
	});

	test("provision records the run's storage path", async () => {
		const home = realpathSync(mkdtempSync(join(tmpdir(), "sf-home-")));
		const wt = join(home, "work", "runs", "r2");
		mkdirSync(wt, { recursive: true });
		const sandbox = new Sandbox({ stateDir: join(home, "environments") });
		const db = join(realpathSync(mkdtempSync(join(tmpdir(), "sf-store-"))), "factory.sqlite");
		writeFileSync(`${db}-wal`, "DB");
		const { envId } = await sandbox.provision({ repo: "me/x", path: wt, baseRef: "", branch: "main", newRepo: true }, "reviewer", {
			runId: "r2",
			config: { workdir: join(home, "work"), sandbox: { enabled: false }, storage: { kind: "sqlite", path: db } },
		});
		const r: any = await sandbox.env({ conversationId: "c", envId }).readTextFile(`${db}-wal`, c);
		expect(String(r.error?.message)).toMatch(/is denied/);
	});

	test("commands: the runtime gets the home as a denied directory and the roots inside it as allowRead", async () => {
		const wrap = stubRuntime();
		const { home, worktree, scratch, env } = layout(true, { denyRead: ["<home>/work/runs/r1/.env"] });
		await env.exec("true", undefined, c);
		const fs = (wrap.mock.calls.at(-1)![2] as any).filesystem as { denyRead: string[]; allowRead: string[] };
		expect(fs.denyRead).toContain(home);
		expect(fs.denyRead).toContain(join(worktree, ".env"));
		for (const e of ["secrets.json", "pi", "web-token", "factory.sqlite", "environments", "qa-vms"]) expect(fs.denyRead, e).toContain(join(home, e));
		expect(fs.allowRead).toEqual(expect.arrayContaining([worktree, scratch]));
		expect(fs.allowRead).not.toContain(home);
		// file tools follow the same lists with the sandbox on
		expect(await read(env, join(worktree, "AGENTS.md"))).toBe(true);
		expect(await read(env, join(worktree, ".env"))).toBe(false);
		expect(await read(env, join(home, "pi", "auth.json"))).toBe(false);
	});

	test("commands: an extraWrite at the home is neither re-allowed nor writable", async () => {
		const wrap = stubRuntime();
		const { home, env } = layout(true, { role: "builder", extraWrite: ["<home>", "<home>/pi"] });
		await env.exec("true", undefined, c);
		const fs = (wrap.mock.calls.at(-1)![2] as any).filesystem as { allowRead: string[]; allowWrite: string[] };
		for (const p of [home, join(home, "pi")]) {
			expect(fs.allowRead).not.toContain(p);
			expect(fs.allowWrite).not.toContain(p);
		}
	});
});
