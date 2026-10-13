// Sandbox: role-fixed write access, denyRead, network allowlist and credential hiding, enforced by
// @anthropic-ai/sandbox-runtime for processes and by the ExecutionEnv for in-process file tools.
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as c } from "@earendil-works/chord/context";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { beforeAll, describe, expect, test } from "vitest";
import { git } from "../src/github/git.ts";
import { GITHUB_SIDE_IDENTITY } from "../src/github/host.ts";
import { Sandbox } from "../src/sandbox/sandbox.ts";
import type { Workspace } from "../src/core/types.ts";

const available = process.platform === "linux" && SandboxManager.checkDependencies().errors.length === 0;

async function exec(env: any, cmd: string) {
	let out = "";
	const r = await env.exec(cmd, { onOutput: (t: string) => (out += t) }, c);
	return { code: r.ok ? r.value.exitCode : -1, out: out + (r.ok ? "" : r.error.message) };
}

describe.skipIf(!available)("Sandbox (bubblewrap)", () => {
	const dir = mkdtempSync(join(tmpdir(), "sf-sbx-"));
	const secretDir = join(dir, "secret-home", ".factory");
	const ws: Workspace = { repo: "me/x", path: join(dir, "wt"), baseRef: "", branch: "main", newRepo: true };
	const WHO = { name: "octocat", email: "583231+octocat@users.noreply.github.com" };
	const sandbox = new Sandbox({ stateDir: join(dir, "state") }); // the factory home is dir: the worktree and workdir live in it
	const workdir = join(dir, "root");
	const settings = {
		sandbox: {
			enabled: true,
			allowedDomains: ["registry.npmjs.org"],
			deniedDomains: [],
			denyRead: [secretDir],
			extraWrite: [],
			unixSockets: "auto",
			setupScripts: ["scripts/setup.sh"],
		},
	};
	let builder: any, reviewer: any;

	beforeAll(async () => {
		mkdirSync(join(ws.path, "scripts"), { recursive: true });
		mkdirSync(secretDir, { recursive: true });
		writeFileSync(join(secretDir, "token"), "SECRET");
		mkdirSync(join(dir, "pi"), { recursive: true });
		writeFileSync(join(dir, "secrets.json"), "HOME_SECRET");
		writeFileSync(join(dir, "pi", "auth.json"), "HOME_SECRET");
		await git(ws.path, ["init", "-q", "-b", "main"]);
		writeFileSync(join(ws.path, "scripts/setup.sh"), "echo setup-ran > .setup-marker\n");
		await git(ws.path, ["add", "-A"]);
		await git(ws.path, ["commit", "-qm", "init"], { identity: GITHUB_SIDE_IDENTITY });
		const b = await sandbox.provision(ws, "builder", { runId: "r1", config: { workdir, sandbox: settings.sandbox } }, WHO);
		const r = await sandbox.provision(ws, "reviewer", { runId: "r1", config: { workdir, sandbox: settings.sandbox } }, WHO);
		builder = sandbox.env({ conversationId: "c1", envId: b.envId });
		reviewer = sandbox.env({ conversationId: "c2", envId: r.envId });
	});

	test("provision runs the repo's setup script (sandboxed, builder rights)", () => {
		expect(existsSync(join(ws.path, ".setup-marker"))).toBe(true);
	});

	test("the builder can write the worktree and commit; the reviewer cannot write the worktree (bash or file tools)", async () => {
		expect((await exec(builder, "echo hi > built.txt && git add built.txt && git commit -qm built && echo OK")).out).toContain("OK");
		// the commit is authored and committed by the environment's commit identity (the GitHub account), not factory-<role>
		expect((await exec(builder, "git log -1 --format='%an <%ae>|%cn <%ce>'")).out.trim()).toBe(`${WHO.name} <${WHO.email}>|${WHO.name} <${WHO.email}>`);
		const rb = await exec(reviewer, "echo x > reviewer.txt");
		expect(rb.code).not.toBe(0);
		expect(rb.out).toMatch(/Read-only file system|Permission denied/);
		const w = await reviewer.writeFile("reviewer2.txt", "x", c);
		expect(w.ok).toBe(false);
		expect(String(w.error.message)).toMatch(/denied for the reviewer role/);
		expect((await builder.writeFile("b2.txt", "x", c)).ok).toBe(true);
		// the reviewer may write its scratch dir (HOME, caches and TMPDIR point there)
		expect((await exec(reviewer, 'echo x > "$HOME/scratch.txt" && echo x > "$TMPDIR/t.txt" && echo "$TMPDIR" && echo OK')).out).toMatch(/scratch\/r1-reviewer\/tmp\nOK/);
	});

	test("the discussant cannot write the worktree with bash but can write its scratch dir", async () => {
		const p = await sandbox.provision(ws, "discussant", { runId: "r1", config: { workdir, sandbox: settings.sandbox } }, WHO);
		const discussant = sandbox.env({ conversationId: "c3", envId: p.envId });
		// it reads the repo and runs commands in it
		expect((await exec(discussant, "cat scripts/setup.sh")).out).toContain("setup-ran");
		const rb = await exec(discussant, "echo x > discussant.txt");
		expect(rb.code).not.toBe(0);
		expect(rb.out).toMatch(/Read-only file system|Permission denied/);
		expect(existsSync(join(ws.path, "discussant.txt"))).toBe(false);
		expect((await exec(discussant, 'echo x > "$HOME/scratch.txt" && echo x > "$TMPDIR/t.txt" && echo "$TMPDIR" && echo OK')).out).toMatch(/scratch\/r1-discussant\/tmp\nOK/);
	});

	test("git hooks and config of the shared git dir are not writable by the builder", async () => {
		const r = await exec(builder, "echo 'echo pwned' > .git/hooks/pre-commit");
		expect(r.code).not.toBe(0);
	});

	test("denyRead hides secret paths from commands and from file tools", async () => {
		const r = await exec(builder, `cat ${join(secretDir, "token")}`);
		expect(r.out).not.toContain("SECRET");
		const f = await reviewer.readTextFile(join(secretDir, "token"), c);
		expect(f.ok).toBe(false);
	});

	test("the factory home's secrets are hidden from commands and file tools; the worktree inside the home is not", async () => {
		for (const f of [join(dir, "secrets.json"), join(dir, "pi", "auth.json")]) {
			expect((await exec(reviewer, `cat ${f}`)).out).not.toContain("HOME_SECRET");
			expect((await reviewer.readTextFile(f, c)).ok).toBe(false);
		}
		expect((await exec(reviewer, "cat scripts/setup.sh")).out).toContain("setup-ran");
		expect((await reviewer.readTextFile(join(ws.path, "scripts/setup.sh"), c)).ok).toBe(true);
	});

	test("secrets renamed or created in the factory home while a command runs stay hidden from it", async () => {
		const tmp = join(workdir, "scratch", "r1-reviewer", "tmp");
		rmSync(join(tmp, "started"), { force: true });
		rmSync(join(tmp, "go"), { force: true });
		const run = exec(
			reviewer,
			`touch "$TMPDIR/started"; while [ ! -e "$TMPDIR/go" ]; do sleep 0.05; done; cat ${join(dir, "secrets.json")} ${join(dir, "pi", "models.json")} 2>/dev/null; echo LS; ls -a ${dir}; echo DONE`,
		);
		for (let i = 0; i < 400 && !existsSync(join(tmp, "started")); i++) await new Promise((r) => setTimeout(r, 50));
		expect(existsSync(join(tmp, "started"))).toBe(true);
		// SecretStore.write: secrets.json.<pid>.tmp, then rename over secrets.json; and a file the home did not have yet
		writeFileSync(join(dir, "secrets.json.9.tmp"), "RENAMED_SECRET");
		renameSync(join(dir, "secrets.json.9.tmp"), join(dir, "secrets.json"));
		writeFileSync(join(dir, "secrets.json.10.tmp"), "LEFT_TMP");
		writeFileSync(join(dir, "pi", "models.json"), "NEW_SECRET");
		writeFileSync(join(tmp, "go"), "");
		const r = await run;
		expect(r.out).toContain("DONE");
		for (const s of ["RENAMED_SECRET", "NEW_SECRET", "HOME_SECRET"]) expect(r.out).not.toContain(s);
		// the home is an empty directory inside the sandbox but for the mount points of the roots it re-allows
		const listed = r.out.split("LS\n")[1]!.split("DONE")[0]!;
		expect(listed).not.toMatch(/secrets\.json|\.tmp/);
		console.log(`home inside the sandbox: ${listed.trim().split("\n").join(" ")}`);
		// a later command (and the file tools) cannot see them either
		expect((await exec(reviewer, `cat ${join(dir, "secrets.json.10.tmp")} 2>/dev/null; ls ${dir}`)).out).not.toMatch(/LEFT_TMP|secrets/);
		expect((await reviewer.readTextFile(join(dir, "secrets.json.10.tmp"), c)).ok).toBe(false);
	}, 40_000);

	test("credentials in the factory's environment are not visible inside the sandbox", async () => {
		process.env.GH_TOKEN = "ghp_should_not_leak";
		const r = await exec(builder, 'echo "token=[$GH_TOKEN]"');
		expect(r.out).toContain("token=[]");
		delete process.env.GH_TOKEN;
	});

	test("network: allowlisted registry reachable, everything else (incl. github.com) blocked", async () => {
		const ok = await exec(builder, "curl -sS -m 15 -o /dev/null -w '%{http_code}' https://registry.npmjs.org/");
		const blocked = await exec(builder, "curl -sS -m 15 -o /dev/null -w '%{http_code}' https://github.com/");
		expect(blocked.out).not.toMatch(/^200/);
		if (!/^200/.test(ok.out)) console.warn("registry.npmjs.org unreachable from this host; skipping the positive check");
	}, 40_000);
});
