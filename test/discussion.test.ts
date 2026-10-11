// Discussions (spec docs/superpowers/specs/2026-10-11-discussion-flow-design.md): the workspace, ...
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { RunCtx } from "../src/core/types.ts";
import { git, gitOut } from "../src/github/git.ts";
import { GitHub } from "../src/github/github.ts";
import { makeFactory, type TestEnv } from "./helpers.ts";

let t: TestEnv | undefined;
afterEach(async () => {
	await t?.factory.close().catch(() => {});
	t = undefined;
});

/** Commit `path` with `content` on the remote's default branch (creating the remote if needed); returns the new head. */
async function pushCommit(repo: string, path: string, content: string): Promise<string> {
	await t!.host.createRepo(repo, { private: true });
	const work = mkdtempSync(join(tmpdir(), "push-"));
	try {
		await git(work, ["clone", "-q", t!.host.bare(repo), "."]);
		await git(work, ["checkout", "-q", "-B", "main"]);
		writeFileSync(join(work, path), content);
		await git(work, ["add", "-A"]);
		await git(work, ["commit", "-q", "-m", `add ${path}`]);
		await git(work, ["push", "-q", "origin", "HEAD:refs/heads/main"]);
		return await gitOut(work, ["rev-parse", "HEAD"]);
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
}
/** Create the remote repo with a first commit holding `path` on main. */
const createRemoteWith = (repo: string, path: string, content: string) => pushCommit(repo, path, content);

describe("workspace", () => {
	let gh: GitHub;
	let rc: RunCtx;
	beforeEach(async () => {
		t = await makeFactory();
		await t.host.seedRepo("me/p", { "README.md": "# p\n" });
		await t.factory.createProject("p", "me/p");
		gh = new GitHub(t.host);
		rc = { runId: "disc-1", config: t.factory.config.effective({ project: "p" }) } as RunCtx;
	});

	test("open(…, 'discussions') checks out under <workdir>/discussions/<id>", async () => {
		const ws = await gh.open("me/p", rc, "discussions");
		expect(ws.path).toBe(join(t!.dir, "work", "discussions", "disc-1"));
		expect(existsSync(join(t!.dir, "work", "discussions", "disc-1.json"))).toBe(true);
		expect(readFileSync(join(ws.path, "README.md"), "utf8")).toBe("# p\n");
	});

	test("refresh fast-forwards to the default branch", async () => {
		const ws = await gh.open("me/p", rc, "discussions");
		const head = await pushCommit("me/p", "NEW.md", "new\n");
		const ws2 = await gh.refresh(ws, rc);
		expect(ws2.baseRef).toBe(head);
		expect(readFileSync(join(ws2.path, "NEW.md"), "utf8")).toBe("new\n");
		expect(JSON.parse(readFileSync(`${ws2.path}.json`, "utf8")).baseRef).toBe(head);
	});

	test("refresh of a new-repo workspace before the repo exists changes nothing", async () => {
		const ws = await gh.open("me/new", rc, "discussions");
		expect(ws.newRepo).toBe(true);
		expect(await gh.refresh(ws, rc)).toEqual(ws);
	});

	test("refresh of a new-repo workspace after the repo was created gives the delivered code", async () => {
		const ws = await gh.open("me/new", rc, "discussions");
		expect(ws.newRepo).toBe(true);
		await createRemoteWith("me/new", "README.md", "delivered\n");
		const ws2 = await gh.refresh(ws, rc);
		expect(ws2.newRepo).toBe(false);
		expect(ws2.path).toBe(ws.path);
		expect(readFileSync(join(ws2.path, "README.md"), "utf8")).toBe("delivered\n");
	});

	test("a failed fast-forward throws with git's output", async () => {
		const ws = await gh.open("me/p", rc, "discussions");
		writeFileSync(join(ws.path, "LOCAL.md"), "local\n");
		await git(ws.path, ["add", "-A"]);
		await git(ws.path, ["commit", "-q", "-m", "diverge"]);
		await pushCommit("me/p", "NEW.md", "new\n");
		await expect(gh.refresh(ws, rc)).rejects.toThrow(/^could not fast-forward the discussion's checkout to origin\/main: /);
	});

	test("the run area is unchanged by default", async () => {
		const ws = await gh.open("me/p", rc);
		expect(ws.path).toBe(join(t!.dir, "work", "runs", "disc-1"));
		expect(existsSync(join(t!.dir, "work", "runs", "disc-1.json"))).toBe(true);
	});
});
