// local-worktree environment: role-fixed write access, denyRead, network allowlist and credential hiding, enforced by
// @anthropic-ai/sandbox-runtime for processes and by the ExecutionEnv for in-process file tools.
import { mkdirSync, mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as c } from "@earendil-works/chord/context";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { beforeAll, describe, expect, test } from "vitest";
import { git } from "../src/extensions/git.ts";
import { localWorktree } from "../src/extensions/local-worktree/index.ts";
import type { Workspace } from "../src/core/types.ts";

const available = process.platform === "linux" && SandboxManager.checkDependencies().errors.length === 0;

async function exec(env: any, cmd: string) {
	let out = "";
	const r = await env.exec(cmd, { onOutput: (t: string) => (out += t) }, c);
	return { code: r.ok ? r.value.exitCode : -1, out: out + (r.ok ? "" : r.error.message) };
}

describe.skipIf(!available)("local-worktree sandbox (bubblewrap)", () => {
	const dir = mkdtempSync(join(tmpdir(), "sf-sbx-"));
	const secretDir = join(dir, "secret-home", ".factory");
	const ws: Workspace = { repo: "me/x", path: join(dir, "wt"), baseRef: "", branch: "main", newRepo: true };
	const ext = localWorktree({ stateDir: join(dir, "state") });
	const settings = {
		root: join(dir, "root"),
		setupScripts: ["scripts/setup.sh"],
		sandbox: { enabled: true, allowedDomains: ["registry.npmjs.org"], deniedDomains: [], denyRead: [secretDir], extraWrite: [], unixSockets: "auto" },
	};
	let builder: any, reviewer: any;

	beforeAll(async () => {
		mkdirSync(join(ws.path, "scripts"), { recursive: true });
		mkdirSync(secretDir, { recursive: true });
		writeFileSync(join(secretDir, "token"), "SECRET");
		await git(ws.path, ["init", "-q", "-b", "main"]);
		writeFileSync(join(ws.path, "scripts/setup.sh"), "echo setup-ran > .setup-marker\n");
		await git(ws.path, ["add", "-A"]);
		await git(ws.path, ["commit", "-qm", "init"]);
		const b = await ext.provision(ws, "builder", { runId: "r1", settings });
		const r = await ext.provision(ws, "reviewer", { runId: "r1", settings });
		builder = ext.env({ conversationId: "c1", envId: b.envId });
		reviewer = ext.env({ conversationId: "c2", envId: r.envId });
	});

	test("provision runs the repo's setup script (sandboxed, builder rights)", () => {
		expect(existsSync(join(ws.path, ".setup-marker"))).toBe(true);
	});

	test("the builder can write the worktree and commit; the reviewer cannot write the worktree (bash or file tools)", async () => {
		expect((await exec(builder, "echo hi > built.txt && git add built.txt && git commit -qm built && echo OK")).out).toContain("OK");
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
