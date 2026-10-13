// The factory home: the sandbox denies the whole home as a directory (a tmpfs under bwrap, so files renamed or created
// in it later stay hidden) and re-allows the environment's own roots inside it (worktree, git dir, scratch, extraWrite),
// so a workdir inside the home (the dry run's layout) stays readable. The most specific rule wins, as in the sandbox
// runtime: a denyRead entry inside an allowed root is still denied. Hermetic: the sandbox runtime is stubbed and the
// policy handed to it is inspected.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as c } from "@earendil-works/chord/context";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { afterEach, describe, expect, test, vi } from "vitest";
import { git, gitOut } from "../src/github/git.ts";
import { GITHUB_SIDE_IDENTITY } from "../src/github/host.ts";
import { Sandbox } from "../src/sandbox/sandbox.ts";

const WHO = { name: "octocat", email: "583231+octocat@users.noreply.github.com" };

const PRIVATE = ["secrets.json", "secrets.json.123.tmp", "pi/auth.json", "web-token", "web-url", "factory.log", "factory.sqlite", "factory.sqlite-wal", "factory.sqlite-shm", "environments/x.json", "qa-vms/y.json", "config.yaml"];

function layout(enabled: boolean, over: { denyRead?: string[]; extraWrite?: string[]; role?: string; storage?: string } = {}) {
	// The home sits in a directory of its own (<outer>), so a root can contain it without being the system temp dir.
	const outer = realpathSync(mkdtempSync(join(tmpdir(), "sf-home-")));
	const home = join(outer, "fh");
	const stateDir = join(home, "environments");
	const worktree = join(home, "work", "runs", "r1");
	const gitDir = join(worktree, ".git");
	const scratch = join(home, "work", "scratch", "r1-reviewer");
	for (const d of [stateDir, worktree, scratch, join(home, "pi"), join(home, "qa-vms"), join(gitDir, "hooks"), join(gitDir, "objects")]) mkdirSync(d, { recursive: true });
	for (const f of PRIVATE) writeFileSync(join(home, f), "SECRET");
	writeFileSync(join(gitDir, "config"), "[core]\n");
	writeFileSync(join(worktree, "AGENTS.md"), "# agents\n");
	writeFileSync(join(worktree, ".env"), "TOKEN=x\n");
	const sub = (p: string) => p.replace("<home>", home).replace("<outer>", outer);
	const rec = {
		envId: "r1-reviewer",
		role: over.role ?? "reviewer",
		worktree,
		cwd: worktree,
		gitCommonDir: gitDir,
		scratch,
		sandbox: { enabled, allowedDomains: [], deniedDomains: [], denyRead: (over.denyRead ?? []).map(sub), extraWrite: (over.extraWrite ?? []).map(sub), unixSockets: "block" },
		...(over.storage ? { storage: sub(over.storage) } : {}),
		commitIdentity: WHO,
	};
	writeFileSync(join(stateDir, "r1-reviewer.json"), JSON.stringify(rec));
	const sandbox = new Sandbox({ stateDir });
	const env = sandbox.env({ conversationId: "c", envId: "r1-reviewer" });
	return { outer, home, worktree, gitDir, scratch, env, sandbox };
}

const write = async (env: any, p: string) => (await env.writeFile(p, "PWNED", c)) as { ok: boolean; error?: Error };

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

	test("file tools: a write root that contains the home makes neither the home nor the storage writable; the env's own roots stay writable", async () => {
		const { outer, home, worktree, gitDir, scratch, env } = layout(false, { role: "builder", extraWrite: ["<outer>", "<home>/cache"], storage: "<outer>/db/f.sqlite" });
		const db = join(outer, "db", "f.sqlite");
		mkdirSync(join(outer, "db"));
		writeFileSync(db, "DB");
		mkdirSync(join(home, "cache"));
		// the reviewer's spike: config.yaml and the environment record that holds the env's own sandbox policy
		for (const f of ["config.yaml", "environments/r1-reviewer.json", "environments/x.json", "secrets.json", "pi/auth.json", "anything-new"]) {
			const r = await write(env, join(home, f));
			expect(r.ok, f).toBe(false);
			expect(String(r.error?.message), f).toMatch(/is denied/);
		}
		expect(readFileSync(join(home, "config.yaml"), "utf8")).toBe("SECRET");
		expect(JSON.parse(readFileSync(join(home, "environments", "r1-reviewer.json"), "utf8")).envId).toBe("r1-reviewer");
		expect(((await env.renameFile(join(worktree, "AGENTS.md"), join(home, "config.yaml"), c)) as any).ok).toBe(false);
		for (const s of ["", "-wal", "-journal"]) expect((await write(env, db + s)).ok, s).toBe(false);
		expect(existsSync(`${db}-journal`)).toBe(false);
		expect(readFileSync(db, "utf8")).toBe("DB");
		// the root that contains the home is dropped as a whole (sandbox-runtime cannot re-allow a root inside a write deny)
		expect((await write(env, join(outer, "elsewhere"))).ok).toBe(false);
		// the env's own roots inside the home stay writable
		for (const p of [join(worktree, "x.txt"), join(gitDir, "objects", "o"), join(scratch, "s.txt"), join(home, "cache", "c.txt")]) expect((await write(env, p)).ok, p).toBe(true);
		// and the git dir's hooks and config stay read-only
		for (const p of [join(gitDir, "hooks", "pre-commit"), join(gitDir, "config")]) expect((await write(env, p)).ok, p).toBe(false);
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
		}, WHO);
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

	test("commands: a write root that contains the home or the storage is dropped; private entries and storage are write-denied", async () => {
		const wrap = stubRuntime();
		const { outer, home, worktree, gitDir, scratch, env } = layout(true, { role: "builder", extraWrite: ["<outer>", "<outer>/db"], storage: "<outer>/db/f.sqlite" });
		const db = join(outer, "db", "f.sqlite");
		await env.exec("true", undefined, c);
		const fs = (wrap.mock.calls.at(-1)![2] as any).filesystem as { allowWrite: string[]; denyWrite: string[] };
		expect(fs.allowWrite).toEqual(expect.arrayContaining([worktree, gitDir, scratch]));
		for (const p of [outer, join(outer, "db")]) expect(fs.allowWrite).not.toContain(p);
		// no write root at or around the home or the storage: the runtime lets a write deny win over any root inside it
		const around = (p: string, r: string) => p === r || p.startsWith(`${r}/`);
		for (const r of fs.allowWrite) for (const p of [home, db]) expect(around(p, r), `${r} contains ${p}`).toBe(false);
		expect(fs.denyWrite).toEqual(expect.arrayContaining([join(gitDir, "hooks"), join(gitDir, "config"), join(home, "secrets.json"), join(home, "environments"), join(home, "pi"), db, `${db}-wal`, `${db}-journal`]));
		expect(fs.denyWrite).not.toContain(home);
	});
});

describe("the environment's commit identity (the GitHub account behind github.identity)", () => {
	const OTHER = { name: "my-app[bot]", email: "42+my-app[bot]@users.noreply.github.com" };

	/** A git worktree inside a factory home, and a sandbox (disabled) over its environments dir. */
	async function setup(runId: string) {
		const home = realpathSync(mkdtempSync(join(tmpdir(), "sf-home-")));
		const wt = join(home, "work", "runs", runId);
		mkdirSync(wt, { recursive: true });
		await git(wt, ["init", "-q", "-b", "main"]);
		writeFileSync(join(wt, "README.md"), "x\n");
		await git(wt, ["add", "-A"]);
		await git(wt, ["commit", "-q", "-m", "init"], { identity: GITHUB_SIDE_IDENTITY });
		const stateDir = join(home, "environments");
		const ws = { repo: "me/x", path: wt, baseRef: "", branch: "main", newRepo: true };
		const rc = { runId, config: { workdir: join(home, "work"), sandbox: { enabled: false } } };
		return { home, wt, stateDir, ws, rc, sandbox: new Sandbox({ stateDir }) };
	}

	async function sh(env: any, cmd: string): Promise<string> {
		let out = "";
		const r = await env.exec(cmd, { onOutput: (t: string) => (out += t) }, c);
		expect(r.ok, out).toBe(true);
		expect(r.value.exitCode, out).toBe(0);
		return out;
	}

	const ident = (w: { name: string; email: string }) => `${w.name} <${w.email}>`;

	/** Drop `commitIdentity` from the record on disk, as written before this change. */
	function makeOld(stateDir: string, envId: string) {
		const p = join(stateDir, `${envId}.json`);
		const rec = JSON.parse(readFileSync(p, "utf8"));
		delete rec.commitIdentity;
		writeFileSync(p, JSON.stringify(rec, null, 2));
	}
	const onDisk = (stateDir: string, envId: string) => JSON.parse(readFileSync(join(stateDir, `${envId}.json`), "utf8")).commitIdentity;

	test("provision stores the identity; the shell env's GIT_AUTHOR_*/GIT_COMMITTER_* are it, and a commit in the worktree is authored and committed by it", async () => {
		const { wt, stateDir, ws, rc, sandbox } = await setup("r3");
		for (const role of ["builder", "integrator", "reviewer", "discussant"] as const) {
			const { envId } = await sandbox.provision(ws, role, rc, WHO);
			expect(onDisk(stateDir, envId), role).toEqual(WHO);
			const env = sandbox.env({ conversationId: `c-${role}`, envId });
			const out = await sh(env, 'printf "%s|%s|%s|%s\\n" "$GIT_AUTHOR_NAME" "$GIT_AUTHOR_EMAIL" "$GIT_COMMITTER_NAME" "$GIT_COMMITTER_EMAIL"; env');
			expect(out.split("\n")[0], role).toBe(`${WHO.name}|${WHO.email}|${WHO.name}|${WHO.email}`);
			const gitVars = out.split("\n").filter((l) => l.startsWith("GIT_AUTHOR_") || l.startsWith("GIT_COMMITTER_"));
			expect(gitVars.sort(), role).toEqual([`GIT_AUTHOR_EMAIL=${WHO.email}`, `GIT_AUTHOR_NAME=${WHO.name}`, `GIT_COMMITTER_EMAIL=${WHO.email}`, `GIT_COMMITTER_NAME=${WHO.name}`]);
			expect(gitVars.join("\n"), role).not.toMatch(/factory-|@factory\.local/);
		}
		const builder = sandbox.env({ conversationId: "c", envId: "r3-builder" });
		expect((await sh(builder, "git var GIT_AUTHOR_IDENT")).trim()).toMatch(new RegExp(`^${WHO.name} <${WHO.email.replace(/[.+]/g, "\\$&")}> \\d+ [+-]\\d{4}$`));
		await sh(builder, "echo hi > built.txt && git add built.txt && git commit -q -m built");
		const log = await gitOut(wt, ["log", "-1", "--format=%an <%ae>|%cn <%ce>"]);
		expect(log).toBe(`${ident(WHO)}|${ident(WHO)}`);
		expect(log).not.toMatch(/factory-|@factory\.local/);
	});

	test("an old record without an identity: env() throws; setCommitIdentity writes it to the record and env() then uses it", async () => {
		const { wt, stateDir, ws, rc } = await setup("r4");
		const { envId } = await new Sandbox({ stateDir }).provision(ws, "builder", rc, WHO);
		makeOld(stateDir, envId);
		// a fresh instance (a restart) reads the record from disk
		const sandbox = new Sandbox({ stateDir });
		expect(sandbox.needsCommitIdentity(envId)).toBe(true);
		expect(sandbox.commitIdentityOf(envId)).toBeUndefined();
		expect(() => sandbox.env({ conversationId: "c", envId })).toThrow(/no commit identity/);
		sandbox.setCommitIdentity(envId, OTHER);
		expect(sandbox.needsCommitIdentity(envId)).toBe(false);
		expect(onDisk(stateDir, envId)).toEqual(OTHER);
		// idempotent: a record that has one keeps it
		sandbox.setCommitIdentity(envId, WHO);
		expect(onDisk(stateDir, envId)).toEqual(OTHER);
		for (const sb of [sandbox, new Sandbox({ stateDir })]) {
			const env = sb.env({ conversationId: "c", envId });
			expect((await sh(env, 'printf "%s <%s>|%s <%s>" "$GIT_AUTHOR_NAME" "$GIT_AUTHOR_EMAIL" "$GIT_COMMITTER_NAME" "$GIT_COMMITTER_EMAIL"'))).toBe(`${ident(OTHER)}|${ident(OTHER)}`);
		}
		await sh(sandbox.env({ conversationId: "c", envId }), "echo hi > f.txt && git add f.txt && git commit -q -m f");
		expect(await gitOut(wt, ["log", "-1", "--format=%an <%ae>|%cn <%ce>"])).toBe(`${ident(OTHER)}|${ident(OTHER)}`);
	});

	test("provision on an existing record without an identity fills it in (a reopened discussion); one with an identity keeps it", async () => {
		const { stateDir, ws, rc } = await setup("r5");
		const { envId } = await new Sandbox({ stateDir }).provision(ws, "discussant", rc, WHO);
		makeOld(stateDir, envId);
		const sandbox = new Sandbox({ stateDir });
		expect(sandbox.needsCommitIdentity(envId)).toBe(true);
		expect((await sandbox.provision(ws, "discussant", rc, OTHER)).envId).toBe(envId);
		expect(onDisk(stateDir, envId)).toEqual(OTHER);
		expect(sandbox.needsCommitIdentity(envId)).toBe(false);
		expect(await sh(sandbox.env({ conversationId: "c", envId }), 'printf "%s <%s>" "$GIT_AUTHOR_NAME" "$GIT_AUTHOR_EMAIL"')).toBe(ident(OTHER));
		// a later provision does not replace the identity the record has
		await new Sandbox({ stateDir }).provision(ws, "discussant", rc, WHO);
		expect(onDisk(stateDir, envId)).toEqual(OTHER);
	});
});
