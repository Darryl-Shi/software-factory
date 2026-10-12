// GhApiHost (the real-GitHub host) without a token or network: a fake `gh` executable on PATH records every
// `gh api` call and answers from a route table; a local HTTP server stands in for the App token endpoint.
// Verifies request shapes, the token handling (env only, never argv or .git/config) and response parsing.
import { generateKeyPairSync } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { GhApiHost } from "../src/github/host.ts";

const dir = mkdtempSync(join(tmpdir(), "fake-gh-"));
const routes: Record<string, { status: number; body?: unknown }> = {};
const calls = () =>
	readFileSync(join(dir, "calls.jsonl"), "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l) as { args: string[]; token: string; stdin: string; method: string; path: string });
const route = (key: string, status: number, body?: unknown) => {
	routes[key] = { status, ...(body !== undefined ? { body } : {}) };
	writeFileSync(join(dir, "routes.json"), JSON.stringify(routes));
};
const PATH0 = process.env.PATH;
const pat = { kind: "pat" as const, tokenRef: "env:SF_TEST_TOKEN" };

beforeAll(() => {
	writeFileSync(join(dir, "calls.jsonl"), "");
	writeFileSync(join(dir, "routes.json"), "{}");
	writeFileSync(
		join(dir, "gh"),
		`#!/usr/bin/env node
const fs = require("fs"), path = require("path");
const dir = ${JSON.stringify(dir)};
const args = process.argv.slice(2);
const method = args[args.indexOf("-X") + 1];
const p = args[args.length - 1] === "-" ? args[args.length - 3] : args[args.length - 1];
let stdin = "";
if (args.includes("--input")) stdin = fs.readFileSync(0, "utf8");
fs.appendFileSync(path.join(dir, "calls.jsonl"), JSON.stringify({ args, token: process.env.GH_TOKEN, stdin, method, path: p }) + "\\n");
const routes = JSON.parse(fs.readFileSync(path.join(dir, "routes.json"), "utf8"));
const r = routes[method + " " + p.split("?")[0]] || { status: 404, body: { message: "Not Found" } };
process.stdout.write("HTTP/2.0 " + r.status + " X\\r\\ncontent-type: application/json\\r\\n\\r\\n" + (r.body === undefined ? "" : JSON.stringify(r.body)));
process.exit(r.status >= 400 ? 1 : 0);
`,
	);
	chmodSync(join(dir, "gh"), 0o755);
	process.env.PATH = `${dir}:${PATH0}`;
	process.env.SF_TEST_TOKEN = "ghp_test_token_123";
});
afterAll(() => {
	process.env.PATH = PATH0;
	delete process.env.SF_TEST_TOKEN;
});

describe("GhApiHost over gh api", () => {
	test("repoExists maps 404/200; createRepo is idempotent, tries the org then the user endpoint, private by default", async () => {
		const h = new GhApiHost();
		expect(await h.repoExists("me/todo", pat)).toBe(false);
		route("POST /orgs/me/repos", 404, { message: "Not Found" });
		route("POST /user/repos", 201, { full_name: "me/todo" });
		await h.createRepo("me/todo", { private: true }, pat);
		const c = calls();
		expect(c.map((x) => `${x.method} ${x.path}`)).toEqual(["GET /repos/me/todo", "GET /repos/me/todo", "POST /orgs/me/repos", "POST /user/repos"]);
		expect(JSON.parse(c.at(-1)!.stdin)).toEqual({ name: "todo", private: true, auto_init: false });
		// the token travels in the environment only
		expect(c.every((x) => x.token === "ghp_test_token_123")).toBe(true);
		expect(c.some((x) => x.args.join(" ").includes("ghp_test_token_123"))).toBe(false);
		route("GET /repos/me/todo", 200, { full_name: "me/todo", default_branch: "trunk" });
		const n = calls().length;
		await h.createRepo("me/todo", { private: true }, pat);
		expect(calls().length).toBe(n + 1); // exists → no create
		expect(await h.defaultBranch("me/todo", pat)).toBe("trunk");
	});

	test("PRs: find (by owner:branch), create, update, merge (skips when already merged)", async () => {
		const h = new GhApiHost();
		route("GET /repos/me/todo/pulls", 200, []);
		expect(await h.findPr("me/todo", "factory/run-1", pat)).toBeUndefined();
		expect(calls().at(-1)!.path).toBe("/repos/me/todo/pulls?state=all&head=me:factory%2Frun-1");
		route("POST /repos/me/todo/pulls", 201, { number: 7, html_url: "https://github.com/me/todo/pull/7", head: { ref: "factory/run-1" }, base: { ref: "main" }, state: "open", body: "b" });
		const pr = await h.createPr("me/todo", { head: "factory/run-1", base: "main", title: "t", body: "b" }, pat);
		expect(pr).toEqual({ number: 7, url: "https://github.com/me/todo/pull/7", head: "factory/run-1", base: "main", state: "open", body: "b" });
		route("PATCH /repos/me/todo/pulls/7", 200, {});
		await h.updatePr("me/todo", 7, "new body", pat);
		expect(JSON.parse(calls().at(-1)!.stdin)).toEqual({ body: "new body" });
		route("GET /repos/me/todo/pulls/7", 200, { number: 7, state: "open", head: { ref: "factory/run-1" }, base: { ref: "main" } });
		route("PUT /repos/me/todo/pulls/7/merge", 200, { merged: true });
		await h.mergePr("me/todo", 7, "squash", pat);
		expect(JSON.parse(calls().at(-1)!.stdin)).toEqual({ merge_method: "squash" });
		route("GET /repos/me/todo/pulls/7", 200, { number: 7, state: "closed", merged_at: "2026-01-01T00:00:00Z" });
		const n = calls().length;
		await h.mergePr("me/todo", 7, "squash", pat);
		expect(calls().length).toBe(n + 1); // only the GET
	});

	test("checks combine check runs and commit statuses for the delivered sha", async () => {
		const h = new GhApiHost();
		route("GET /repos/me/todo/commits/abc/check-runs", 200, { check_runs: [{ name: "test", status: "completed", conclusion: "success" }, { name: "lint", status: "queued" }] });
		route("GET /repos/me/todo/commits/abc/status", 200, { statuses: [{ context: "ci/legacy", state: "failure", description: "1 failing" }] });
		expect(await h.checks("me/todo", "abc", pat)).toEqual([
			{ name: "test", status: "completed", conclusion: "success" },
			{ name: "lint", status: "queued" },
			{ name: "ci/legacy", status: "completed", conclusion: "failure", summary: "1 failing" },
		]);
	});

	test("errors carry the status; a missing token is a clear error", async () => {
		const h = new GhApiHost();
		route("POST /repos/me/todo/pulls", 422, { message: "Validation Failed" });
		await expect(h.createPr("me/todo", { head: "x", base: "main", title: "t", body: "" }, pat)).rejects.toThrow(/422.*Validation Failed/);
		await expect(h.repoExists("me/todo", { kind: "pat", tokenRef: "env:NOPE_NOT_SET" })).rejects.toThrow(/no GitHub token: set env:NOPE_NOT_SET/);
	});

	test("git auth: the token goes to git through an env var read by an inline credential helper", async () => {
		const h = new GhApiHost();
		const a = await h.gitAuth(pat);
		expect(a.env).toEqual({ FACTORY_GIT_TOKEN: "ghp_test_token_123" });
		expect(a.extraArgs.join(" ")).not.toContain("ghp_test_token_123");
		expect(a.extraArgs.join(" ")).toContain("$FACTORY_GIT_TOKEN");
	});

	test("GitHub App identity: signs an RS256 JWT, exchanges it for an installation token, caches it", async () => {
		const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
		const keyFile = join(dir, "app.pem");
		writeFileSync(keyFile, privateKey.export({ type: "pkcs1", format: "pem" }));
		let hits = 0;
		let jwt = "";
		const srv = createServer((req, res) => {
			hits++;
			jwt = String(req.headers.authorization).replace(/^Bearer /, "");
			expect(req.method).toBe("POST");
			expect(req.url).toBe("/app/installations/456/access_tokens");
			res.writeHead(201, { "content-type": "application/json" });
			res.end(JSON.stringify({ token: "ghs_installation", expires_at: new Date(Date.now() + 3600_000).toISOString() }));
		});
		await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
		const port = (srv.address() as any).port;
		try {
			const h = new GhApiHost(`http://127.0.0.1:${port}`);
			const id = { kind: "app" as const, appId: 123, installationId: 456, privateKeyRef: `file:${keyFile}` };
			expect(await h.token(id)).toBe("ghs_installation");
			expect(await h.token(id)).toBe("ghs_installation");
			expect(hits).toBe(1);
			const [head, payload, sig] = jwt.split(".");
			expect(JSON.parse(Buffer.from(head!, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
			expect(JSON.parse(Buffer.from(payload!, "base64url").toString()).iss).toBe("123");
			const { createVerify } = await import("node:crypto");
			expect(createVerify("RSA-SHA256").update(`${head}.${payload}`).verify(publicKey, Buffer.from(sig!, "base64url"))).toBe(true);
		} finally {
			srv.close();
		}
	});
});

describe("GhApiHost: deleting branches (disk cleanup)", () => {
	test("deleteBranch: DELETE git/refs/heads/<branch>; 404 and 422 count as already gone; other errors throw", async () => {
		const h = new GhApiHost();
		route("DELETE /repos/me/del/git/refs/heads/factory/run-1", 204);
		expect(await h.deleteBranch("me/del", "factory/run-1", pat)).toBe(true);
		const c = calls().filter((x) => x.method === "DELETE").at(-1)!;
		expect(c.path).toBe("/repos/me/del/git/refs/heads/factory/run-1");
		expect(c.token).toBe("ghp_test_token_123");
		route("DELETE /repos/me/del/git/refs/heads/factory/run-2", 422, { message: "Reference does not exist" });
		expect(await h.deleteBranch("me/del", "factory/run-2", pat)).toBe(false);
		expect(await h.deleteBranch("me/del", "factory/run-3", pat)).toBe(false); // unrouted: 404
		route("DELETE /repos/me/del/git/refs/heads/factory/run-4", 403, { message: "Forbidden" });
		await expect(h.deleteBranch("me/del", "factory/run-4", pat)).rejects.toThrow(/403/);
	});
});
