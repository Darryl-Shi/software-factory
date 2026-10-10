// Setup section "github" (spec §3.4) and GhApiHost.whoami: a fake `gh` on a temp PATH (as in github-api.test.ts)
// answers `--version`, `auth token` and `api` calls from a route table, with extra response headers such as
// `x-oauth-scopes`; a local HTTP server stands in for the GitHub App token endpoint.
import { generateKeyPairSync } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { setDefaultSecretStore } from "../src/core/settings.ts";
import { GhApiHost } from "../src/github/host.ts";
import { runCommand } from "../src/setup/context.ts";
import { step } from "../src/setup/steps/github.ts";
import { testContext } from "./setup-context.ts";

afterEach(() => {
	setDefaultSecretStore(undefined);
	vi.unstubAllEnvs();
});

type Route = { status: number; body?: unknown; headers?: Record<string, string> };

/** A fake `gh` in a fresh temp dir: records every call, answers `api` from routes, `auth token` from `authToken`. */
function fakeGh() {
	const dir = mkdtempSync(join(tmpdir(), "fake-gh-"));
	const state: { routes: Record<string, Route>; authToken?: string } = { routes: {} };
	const save = () => writeFileSync(join(dir, "state.json"), JSON.stringify(state));
	writeFileSync(join(dir, "calls.jsonl"), "");
	save();
	writeFileSync(
		join(dir, "gh"),
		`#!/usr/bin/env node
const fs = require("fs"), path = require("path");
const dir = ${JSON.stringify(dir)};
const args = process.argv.slice(2);
fs.appendFileSync(path.join(dir, "calls.jsonl"), JSON.stringify({ args, token: process.env.GH_TOKEN }) + "\\n");
const state = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));
if (args[0] === "--version") { process.stdout.write("gh version 2.60.0 (fake)\\n"); process.exit(0); }
if (args[0] === "auth" && args[1] === "token") {
	if (state.authToken === undefined) { process.stderr.write("no oauth token\\n"); process.exit(1); }
	process.stdout.write(state.authToken + "\\n"); process.exit(0);
}
const method = args.includes("-X") ? args[args.indexOf("-X") + 1] : "GET";
const p = args[args.length - 1];
const r = state.routes[method + " " + p.split("?")[0]] || { status: 404, body: { message: "Not Found" } };
let head = "HTTP/2.0 " + r.status + " X\\r\\ncontent-type: application/json\\r\\n";
for (const [k, v] of Object.entries(r.headers || {})) head += k + ": " + v + "\\r\\n";
process.stdout.write(head + "\\r\\n" + (r.body === undefined ? "" : JSON.stringify(r.body)));
process.exit(r.status >= 400 ? 1 : 0);
`,
	);
	chmodSync(join(dir, "gh"), 0o755);
	return {
		dir,
		path: `${dir}:${process.env.PATH}`,
		route(key: string, r: Route) {
			state.routes[key] = r;
			save();
		},
		authToken(t: string) {
			state.authToken = t;
			save();
		},
		calls: () =>
			readFileSync(join(dir, "calls.jsonl"), "utf8")
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((l) => JSON.parse(l) as { args: string[]; token?: string }),
	};
}

const octo = { status: 200, body: { login: "octo" }, headers: { "x-oauth-scopes": "repo, read:org" } };
const messages = (shown: { kind: string; message: string }[], kind: string) => shown.filter((s) => s.kind === kind).map((s) => s.message);

describe("GhApiHost.whoami", () => {
	test("whoami parses scopes", async () => {
		const gh = fakeGh();
		vi.stubEnv("PATH", gh.path);
		vi.stubEnv("SF_TEST_TOKEN", "ghp_whoami");
		const id = { kind: "pat" as const, tokenRef: "env:SF_TEST_TOKEN" };
		const h = new GhApiHost();
		gh.route("GET /user", { status: 200, body: { login: "octo" }, headers: { "X-OAuth-Scopes": " repo ,read:org, workflow " } });
		expect(await h.whoami(id)).toEqual({ login: "octo", scopes: ["repo", "read:org", "workflow"] });
		const call = gh.calls().at(-1)!;
		expect(call.args).toContain("--include");
		expect(call.args.at(-1)).toBe("/user");
		expect(call.token).toBe("ghp_whoami");
		expect(call.args.join(" ")).not.toContain("ghp_whoami");
		gh.route("GET /user", { status: 200, body: { login: "fine" } });
		expect(await h.whoami(id)).toEqual({ login: "fine", scopes: undefined });
		gh.route("GET /user", { status: 401, body: { message: "Bad credentials" } });
		await expect(h.whoami(id)).rejects.toThrow("GitHub GET /user: 401");
	});
});

describe("setup github", () => {
	test("pasted token is trimmed, stored as store:github, verified, workflow warning shown", async () => {
		const gh = fakeGh();
		gh.route("GET /user", octo);
		const { ctx, ui } = testContext({ answers: ["pat", "paste", "", "  ghp_abc\n", "private"], env: { PATH: gh.path }, run: runCommand });
		await step.run(ctx);
		expect(ctx.secrets.get("github")).toBe("ghp_abc");
		const raw = (await ctx.settings()).raw();
		expect(raw.github).toEqual({ identity: { kind: "pat", tokenRef: "store:github" }, visibility: "private" });
		expect(messages(ui.shown, "validate")).toEqual(["required"]);
		expect(messages(ui.shown, "log.success")).toContain("Authenticated as octo");
		const warns = messages(ui.shown, "log.warn");
		expect(warns.some((w) => w.includes("workflow"))).toBe(true);
		expect(warns.some((w) => /\brepo\b/.test(w))).toBe(false);
		// the token went to gh through the environment only
		const api = gh.calls().find((c) => c.args[0] === "api")!;
		expect(api.token).toBe("ghp_abc");
		expect(ui.remaining()).toBe(0);
		expect(await step.status(ctx)).toEqual({ state: "ok", detail: expect.stringContaining("store:github") });
	});

	test("401 offers retry/save/skip; skip leaves config unchanged", async () => {
		const gh = fakeGh();
		gh.route("GET /user", { status: 401, body: { message: "Bad credentials" } });
		const config = "version: 1\ngithub:\n  identity: { kind: pat, tokenRef: env:GH_TOKEN }\n";
		const { ctx, ui, home } = testContext({ answers: ["bot", "paste", "ghp_bad", "skip"], config, env: { PATH: gh.path }, run: runCommand });
		await step.run(ctx);
		const sel = ui.shown.filter((s) => s.kind === "select").at(-1)!;
		expect(sel.options).toEqual(["retry", "save", "skip"]);
		expect(messages(ui.shown, "log.error").some((m) => m.includes("401"))).toBe(true);
		expect(readFileSync(join(home, "config.yaml"), "utf8")).toBe(config);
		expect(ctx.secrets.get("github")).toBeUndefined();
		expect(ui.remaining()).toBe(0);
	});

	test("401 then save anyway saves what was collected; retry asks for the credential again", async () => {
		const gh = fakeGh();
		gh.route("GET /user", { status: 401, body: { message: "Bad credentials" } });
		const { ctx, ui } = testContext({
			answers: ["pat", "paste", "ghp_one", "retry", "paste", "ghp_two", "save", "public"],
			env: { PATH: gh.path },
			run: runCommand,
		});
		await step.run(ctx);
		expect(ctx.secrets.get("github")).toBe("ghp_two");
		expect((await ctx.settings()).raw().github).toEqual({ identity: { kind: "pat", tokenRef: "store:github" }, visibility: "public" });
		expect(ui.remaining()).toBe(0);
	});

	test("gh missing shows the prereqs hint", async () => {
		const { ctx, ui, runs } = testContext({ answers: ["retry", "skip"], env: { PATH: "/nonexistent" } });
		await step.run(ctx);
		expect(messages(ui.shown, "log.error")).toEqual(["gh CLI not found; run factory setup prereqs", "gh CLI not found; run factory setup prereqs"]);
		expect(ui.shown.filter((s) => s.kind === "select").map((s) => s.options)).toEqual([
			["retry", "skip"],
			["retry", "skip"],
		]);
		expect(runs.map((r) => `${r.cmd} ${r.args.join(" ")}`)).toEqual(["gh --version", "gh --version"]);
		expect((await ctx.settings()).raw().github).toBeUndefined();
		expect(ui.remaining()).toBe(0);
	});

	test("env choice keeps env:GH_TOKEN", async () => {
		const gh = fakeGh();
		gh.route("GET /user", octo);
		const { ctx, ui } = testContext({ answers: ["pat", "env", "private"], env: { PATH: gh.path, GH_TOKEN: "ghp_fromenv" }, run: runCommand });
		await step.run(ctx);
		expect(ui.shown.filter((s) => s.kind === "select")[1]!.options).toEqual(["paste", "env"]);
		expect((await ctx.settings()).raw().github.identity).toEqual({ kind: "pat", tokenRef: "env:GH_TOKEN" });
		expect(ctx.secrets.get("github")).toBeUndefined();
		expect(gh.calls().find((c) => c.args[0] === "api")!.token).toBe("ghp_fromenv");
		expect(messages(ui.shown, "log.success")).toContain("Authenticated as octo");
		expect(ui.remaining()).toBe(0);
	});

	test("gh choice imports and trims `gh auth token`; a fine-grained token shows the permissions", async () => {
		const gh = fakeGh();
		gh.authToken("  github_pat_xyz  ");
		gh.route("GET /user", { status: 200, body: { login: "octo" } });
		const { ctx, ui } = testContext({ answers: ["pat", "gh", "private"], env: { PATH: gh.path }, run: runCommand });
		await step.run(ctx);
		expect(ui.shown.filter((s) => s.kind === "select")[1]!.options).toEqual(["paste", "gh"]);
		expect(ctx.secrets.get("github")).toBe("github_pat_xyz");
		const note = ui.shown.find((s) => s.kind === "note")!;
		for (const p of ["Administration: read & write", "Contents: read & write", "Pull requests: read & write", "Workflows: read & write", "Checks and Commit statuses: read"])
			expect(note.body).toContain(p);
		expect(messages(ui.shown, "log.warn")).toEqual([]);
		expect(ui.remaining()).toBe(0);
	});

	test("app path stores the PEM and sets privateKeyRef", async () => {
		const gh = fakeGh();
		const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
		const pem = privateKey.export({ type: "pkcs1", format: "pem" }) as string;
		const keyFile = join(gh.dir, "app.pem");
		writeFileSync(keyFile, pem);
		const notKey = join(gh.dir, "not-a-key.txt");
		writeFileSync(notKey, "hello");
		const hits: { method?: string; url?: string; auth?: string }[] = [];
		const srv = createServer((req, res) => {
			hits.push({ method: req.method, url: req.url, auth: req.headers.authorization });
			res.writeHead(201, { "content-type": "application/json" });
			res.end(JSON.stringify({ token: "ghs_inst", expires_at: new Date(Date.now() + 3600_000).toISOString() }));
		});
		await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
		try {
			const api = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
			const { ctx, ui } = testContext({
				answers: ["app", "abc", "42", "7", notKey, keyFile, "public"],
				env: { PATH: gh.path, SF_TEST_GITHUB_API: api },
				run: runCommand,
			});
			await step.run(ctx);
			expect(hits.map((h) => `${h.method} ${h.url}`)).toEqual(["POST /app/installations/7/access_tokens"]);
			const payload = JSON.parse(Buffer.from(hits[0]!.auth!.replace(/^Bearer /, "").split(".")[1]!, "base64url").toString());
			expect(payload.iss).toBe("42");
			expect(ctx.secrets.get("github-app-key")).toBe(pem.trim());
			expect((await ctx.settings()).raw().github).toEqual({
				identity: { kind: "app", appId: 42, installationId: 7, privateKeyRef: "store:github-app-key" },
				visibility: "public",
			});
			expect(messages(ui.shown, "validate")).toEqual(["must be a positive integer", "no PRIVATE KEY in this file"]);
			expect(ui.remaining()).toBe(0);
			expect((await step.status(ctx)).state).toBe("ok");
		} finally {
			srv.close();
		}
	});

	test("status: missing names the ref when the credential does not resolve", async () => {
		const { ctx } = testContext({ answers: [] });
		expect(await step.status(ctx)).toEqual({ state: "missing", detail: expect.stringContaining("env:GH_TOKEN") });
		const { ctx: ctx2 } = testContext({ answers: [], env: { GH_TOKEN: "ghp_x" } });
		expect((await step.status(ctx2)).state).toBe("ok");
	});
});
