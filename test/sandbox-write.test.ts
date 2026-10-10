// A write root that contains the factory home (or the run's storage) must not make them writable: neither through bash
// in the sandbox runtime nor through the file tools. Such a root is dropped (sandbox-runtime lets a write deny win over
// any root inside it, so the home cannot be write-denied while the env's own roots inside it stay writable), while the
// env's own roots inside the home stay writable and the git dir's hooks stay read-only. Needs bubblewrap and socat.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as c } from "@earendil-works/chord/context";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { beforeAll, describe, expect, test } from "vitest";
import { git } from "../src/github/git.ts";
import { Sandbox } from "../src/sandbox/sandbox.ts";
import type { Workspace } from "../src/core/types.ts";

const available = process.platform === "linux" && SandboxManager.checkDependencies().errors.length === 0;

async function exec(env: any, cmd: string) {
	let out = "";
	const r = await env.exec(cmd, { onOutput: (t: string) => (out += t) }, c);
	return { code: r.ok ? r.value.exitCode : -1, out: out + (r.ok ? "" : r.error.message) };
}

describe.skipIf(!available)("Sandbox (bubblewrap): a write root around the factory home", () => {
	const outer = realpathSync(mkdtempSync(join(tmpdir(), "sf-sbxw-")));
	const home = join(outer, "fh");
	const db = join(outer, "db", "factory.sqlite");
	const ws: Workspace = { repo: "me/x", path: join(home, "wt"), baseRef: "", branch: "main", newRepo: true };
	const sandbox = new Sandbox({ stateDir: join(home, "environments") });
	let builder: any, envId: string;

	beforeAll(async () => {
		mkdirSync(ws.path, { recursive: true });
		mkdirSync(join(outer, "db"), { recursive: true });
		writeFileSync(join(home, "config.yaml"), "CONFIG");
		writeFileSync(join(home, "secrets.json"), "HOME_SECRET");
		writeFileSync(db, "DB");
		await git(ws.path, ["init", "-q", "-b", "main"]);
		writeFileSync(join(ws.path, "README.md"), "x\n");
		await git(ws.path, ["add", "-A"]);
		await git(ws.path, ["commit", "-qm", "init"]);
		const sb = { enabled: true, allowedDomains: [], deniedDomains: [], denyRead: [], extraWrite: [outer], unixSockets: "auto" };
		({ envId } = await sandbox.provision(ws, "builder", { runId: "r9", config: { workdir: join(home, "root"), sandbox: sb, storage: { kind: "sqlite", path: db } } }));
		builder = sandbox.env({ conversationId: "c1", envId });
	});

	test("bash writes neither the home nor the storage (nor creates a -journal next to it)", async () => {
		const record = join(home, "environments", `${envId}.json`);
		const targets = [join(home, "config.yaml"), record, join(home, "secrets.json"), join(home, "new-file"), db, `${db}-journal`, join(outer, "elsewhere")];
		const r = await exec(builder, `${targets.map((t) => `echo PWNED > '${t}' 2>/dev/null`).join("; ")}; echo END`);
		expect(r.out).toContain("END");
		expect(readFileSync(join(home, "config.yaml"), "utf8")).toBe("CONFIG");
		expect(JSON.parse(readFileSync(record, "utf8")).envId).toBe(envId);
		expect(readFileSync(join(home, "secrets.json"), "utf8")).toBe("HOME_SECRET");
		expect(readFileSync(db, "utf8")).toBe("DB");
		for (const p of [join(home, "new-file"), `${db}-journal`, join(outer, "elsewhere")]) expect(existsSync(p), p).toBe(false);
	});

	test("the file tools cannot write them either", async () => {
		for (const p of [join(home, "config.yaml"), join(home, "environments", `${envId}.json`), db]) {
			const w = await builder.writeFile(p, "PWNED", c);
			expect(w.ok, p).toBe(false);
		}
		expect(readFileSync(join(home, "config.yaml"), "utf8")).toBe("CONFIG");
	});

	test("the builder still writes and commits its worktree inside the home; .git/hooks stays read-only", async () => {
		expect((await exec(builder, "echo hi > built.txt && git add built.txt && git commit -qm built && echo OK")).out).toContain("OK");
		expect((await builder.writeFile("b2.txt", "x", c)).ok).toBe(true);
		expect((await exec(builder, "echo 'echo pwned' > .git/hooks/pre-commit")).code).not.toBe(0);
		expect((await builder.writeFile(".git/hooks/pre-commit", "x", c)).ok).toBe(false);
		expect(existsSync(join(ws.path, ".git", "hooks", "pre-commit"))).toBe(false);
	});
});
