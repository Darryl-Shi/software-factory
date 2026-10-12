// The web server (spec §3.6 transport): token and cookie auth, Host/Origin/content-type checks, the
// operation allowlist and error codes, the event stream, the token file, a busy port, and the static UI.
import { once } from "node:events";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { Script } from "node:vm";
import { afterEach, describe, expect, test } from "vitest";
import type { FactoryEvent } from "../src/core/types.ts";
import { loadToken, startWebServer } from "../src/web/server.ts";
import { inState, makeFactory, shipAndMerge, type TestEnv, until } from "./helpers.ts";

let t: TestEnv | undefined;
let stops: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const s of stops) await s().catch(() => {});
	stops = [];
	await t?.factory.close().catch(() => {});
	t = undefined;
});

const UI = join(import.meta.dirname, "../src/web/ui");

async function serve(opts: { port?: number } = {}) {
	t ??= await makeFactory();
	const logs: string[] = [];
	const tokenFile = join(t.dir, "home", "web-token");
	const { url, stop } = await startWebServer(t.factory.as("web"), { host: "127.0.0.1", port: opts.port ?? 0, tokenFile, log: (m) => logs.push(m) });
	stops.push(stop);
	const u = new URL(url);
	return { url, stop, logs, tokenFile, token: u.searchParams.get("token") ?? "", port: Number(u.port) };
}

interface Res {
	status: number;
	headers: Record<string, string | string[] | undefined>;
	body: string;
}
function http(port: number, method: string, path: string, opts: { headers?: Record<string, string>; body?: string } = {}): Promise<Res> {
	return new Promise((resolve, reject) => {
		const req = request({ host: "127.0.0.1", port, method, path, headers: { host: `127.0.0.1:${port}`, ...opts.headers } }, (res) => {
			let body = "";
			res.on("data", (c) => (body += c));
			res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
		});
		req.on("error", reject);
		req.end(opts.body);
	});
}
const op = (port: number, token: string, name: string, args: unknown[] = [], headers: Record<string, string> = {}) =>
	http(port, "POST", `/api/op/${name}`, { headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers }, body: JSON.stringify({ args }) });

describe("access", () => {
	test("the link's token is swapped for an HttpOnly SameSite=Strict cookie; without it, a login page", async () => {
		const { port, token, tokenFile } = await serve();
		expect(token.length).toBeGreaterThanOrEqual(32);
		expect(statSync(tokenFile).mode & 0o777).toBe(0o600);
		expect(readFileSync(tokenFile, "utf8").trim()).toBe(token);
		const anon = await http(port, "GET", "/");
		expect(anon.status).toBe(401);
		expect(anon.body).toContain("factory web");
		expect((await http(port, "GET", "/?token=wrong")).status).toBe(401);
		const swap = await http(port, "GET", `/?token=${token}`);
		expect(swap.status).toBe(303);
		expect(swap.headers.location).toBe("/");
		const cookie = String(swap.headers["set-cookie"]);
		expect(cookie).toMatch(/^factory_web=[^;]+; HttpOnly; SameSite=Strict; Path=\//);
		const page = await http(port, "GET", "/", { headers: { cookie: cookie.split(";")[0]! } });
		expect(page.status).toBe(200);
		expect(page.body).toContain('<script src="/app.js"');
		expect(String(page.headers["content-security-policy"])).toContain("script-src 'self'");
		expect(page.headers["x-frame-options"]).toBe("DENY");
		const js = await http(port, "GET", "/app.js", { headers: { cookie: cookie.split(";")[0]! } });
		expect(js.status).toBe(200);
		expect(js.headers["content-type"]).toMatch(/^text\/javascript/);
		expect((await http(port, "GET", "/app.js")).status).toBe(401);
	});

	test("foreign Host (DNS rebinding) and Origin are refused; POST needs application/json", async () => {
		const { port, token } = await serve();
		expect((await http(port, "GET", "/", { headers: { host: `evil.example:${port}`, authorization: `Bearer ${token}` } })).status).toBe(421);
		expect((await op(port, token, "listProjects", [], { origin: "http://evil.example" })).status).toBe(403);
		expect((await op(port, token, "listProjects", [], { origin: `http://127.0.0.1:${port}` })).status).toBe(200);
		const plain = await http(port, "POST", "/api/op/listProjects", { headers: { authorization: `Bearer ${token}`, "content-type": "text/plain" }, body: "{}" });
		expect(plain.status).toBe(415);
		expect((await http(port, "GET", "/api/op/listProjects", { headers: { authorization: `Bearer ${token}` } })).status).toBe(405);
		expect((await op(port, "x".repeat(token.length), "listProjects")).status).toBe(401);
	});

	test("the token survives restarts (kept in its file); the link file is written and removed with the server", async () => {
		const first = await serve();
		const urlFile = join(first.tokenFile, "..", "web-url");
		expect(readFileSync(urlFile, "utf8").trim()).toContain(`token=${first.token}`);
		expect(statSync(urlFile).mode & 0o777).toBe(0o600);
		await first.stop();
		expect(existsSync(urlFile)).toBe(false);
		expect(loadToken(first.tokenFile)).toBe(first.token);
		const second = await serve();
		expect(second.token).toBe(first.token);
	});

	test("a busy port is an error, not a silent no-UI start", async () => {
		const blocker = createServer().listen(0, "127.0.0.1");
		await once(blocker, "listening");
		const port = (blocker.address() as AddressInfo).port;
		t = await makeFactory();
		await expect(startWebServer(t.factory.as("web"), { host: "127.0.0.1", port })).rejects.toThrow(`127.0.0.1:${port} is in use`);
		blocker.close();
	});
});

describe("screenshots", () => {
	test("a QA screenshot is served at /api/runs/<run>/screenshots/<id> behind the token", async () => {
		t = await makeFactory();
		t.control.runScript = true;
		await t.factory.createProject("p", "me/p");
		await t.factory.setSetting({ project: "p" }, "qa.enabled", true);
		const run = await t.factory.startRun("p", { source: "t", title: "x", body: "x" });
		await until(t.factory, run, inState("READY"));
		const { port, token } = await serve();
		const ok = await http(port, "GET", `/api/runs/${run}/screenshots/r1-s1`, { headers: { authorization: `Bearer ${token}` } });
		expect(ok.status).toBe(200);
		expect(ok.headers["content-type"]).toBe("image/png");
		expect((await http(port, "GET", `/api/runs/${run}/screenshots/r1-s1`)).status).toBe(401);
		expect((await http(port, "GET", `/api/runs/${run}/screenshots/r9-s9`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(404);
		expect((await http(port, "GET", `/api/runs/${run}/screenshots/..%2Fx`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(404);
		const viaOp = JSON.parse((await op(port, token, "getScreenshot", [run, "r1-s1"])).body);
		expect(viaOp.result.mime).toBe("image/png");
		expect(Buffer.from(viaOp.result.bytes, "base64").subarray(1, 4).toString()).toBe("PNG");
	});
});

describe("operations and events", () => {
	test("operations go through the allowlist; core errors map to HTTP statuses with their codes", async () => {
		const { port, token } = await serve();
		const created = JSON.parse((await op(port, token, "createProject", ["p", "me/p"])).body);
		expect(created).toMatchObject({ ok: true, result: { name: "p", repo: "me/p" } });
		expect(JSON.parse((await op(port, token, "listProjects")).body).result).toHaveLength(1);
		const missing = await op(port, token, "getRun", ["nope"]);
		expect(missing.status).toBe(404);
		expect(JSON.parse(missing.body)).toMatchObject({ ok: false, code: "not_found" });
		const invalid = await op(port, token, "message", ["nope", "   "]);
		expect(invalid.status).toBe(400);
		expect(JSON.parse(invalid.body).code).toBe("invalid");
		// a `states` filter must be an array of known states (a string used to substring-match, a number threw a 500)
		for (const name of ["listRuns", "listDiscussions"])
			for (const states of ["OPEN", 5, ["NOPE"]]) {
				const r = await op(port, token, name, [{ states }]);
				expect(r.status).toBe(400);
				expect(JSON.parse(r.body).code).toBe("invalid");
			}
		expect(JSON.parse((await op(port, token, "listRuns", [{ states: ["DELIVERED"] }])).body).result).toEqual([]);
		expect((await op(port, token, "createProject", ["p", "other/p"])).status).toBe(409);
		expect((await op(port, token, "subscribe")).status).toBe(404);
		expect((await op(port, token, "harnessForTests")).status).toBe(404);
		const bad = await http(port, "POST", "/api/op/listProjects", { headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: "{" });
		expect(bad.status).toBe(400);
		const schema = JSON.parse((await op(port, token, "settingsSchema")).body).result;
		expect(Object.keys(schema)).toContain("webSearch");
		expect(schema.web.fields).toMatchObject({ host: { default: "127.0.0.1" }, port: { type: "number", default: 7317 } });
	});

	test("the event stream carries core events; runs started over HTTP are attributed to `web`", async () => {
		const { port, token } = await serve();
		await op(port, token, "createProject", ["p", "me/p"]);
		const events: FactoryEvent[] = [];
		const stream = await new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
			const req = request({ host: "127.0.0.1", port, path: "/api/events?project=p", headers: { host: `127.0.0.1:${port}`, authorization: `Bearer ${token}` } }, resolve);
			req.on("error", reject);
			req.end();
		});
		expect(stream.headers["content-type"]).toBe("text/event-stream");
		let buf = "";
		stream.on("data", (c) => {
			buf += c;
			for (let i = buf.indexOf("\n\n"); i >= 0; i = buf.indexOf("\n\n")) {
				const chunk = buf.slice(0, i);
				buf = buf.slice(i + 2);
				const data = /^data: (.*)$/m.exec(chunk)?.[1];
				if (data) events.push(JSON.parse(data));
			}
		});
		await t!.factory.setSetting({ project: "p" }, "policy.approvals", ["spec"]);
		await t!.host.seedRepo("me/p", { "README.md": "# p\n" }); // an existing repo: the bundle opens a PR and waits for Merge
		const run = JSON.parse((await op(port, token, "startRun", ["p", { source: "web", title: "hello", body: "make hello" }])).body).result as string;
		const v = await until(t!.factory, run, inState("AWAITING_APPROVAL"));
		expect((await op(port, token, "approve", [run, "spec"])).status).toBe(200);
		await until(t!.factory, run, inState("READY"));
		// ship it over HTTP and merge it: bundle events reach a project-filtered stream
		const bundle = JSON.parse((await op(port, token, "createBundle", ["p", [run]])).body).result as string;
		await t!.factory.waitForBundle(bundle, (b) => b.state === "AWAITING_MERGE" && !!b.pendingAsk);
		expect((await op(port, token, "mergeBundle", [bundle])).status).toBe(200);
		await until(t!.factory, run, inState("DELIVERED"));
		await new Promise((r) => setTimeout(r, 200));
		stream.destroy();
		expect(events.filter((e) => e.type === "run.state").map((e: any) => e.to)).toEqual(expect.arrayContaining(["READY", "DELIVERED"]));
		expect(events.filter((e) => e.type === "bundle.state").map((e: any) => e.to)).toEqual(expect.arrayContaining(["DELIVERING", "AWAITING_MERGE", "MERGED"]));
		expect(events).toContainEqual(expect.objectContaining({ type: "bundle.askResolved", bundle, by: "web" }));
		expect(events).toContainEqual(expect.objectContaining({ type: "run.ask", run, ask: v.pendingAsk!.id }));
		expect(events).toContainEqual(expect.objectContaining({ type: "run.askResolved", run, by: "web" }));
	});
});

describe("clearing runs", () => {
	test("clearRuns over HTTP: status mapping, all or nothing, listRuns includeCleared, retryRun refused, run.cleared on the stream", async () => {
		const { port, token } = await serve();
		await op(port, token, "createProject", ["p", "me/p"]);
		const start = async () => JSON.parse((await op(port, token, "startRun", ["p", { source: "web", title: "hello", body: "make hello" }])).body).result as string;
		const delivered = await start();
		expect((await shipAndMerge(t!.factory, delivered)).state).toBe("DELIVERED");
		await t!.factory.setSetting({ project: "p" }, "policy.approvals", ["spec"]);
		const cancelled = await start();
		await until(t!.factory, cancelled, inState("AWAITING_APPROVAL"));
		expect((await op(port, token, "cancelRun", [cancelled])).status).toBe(200);
		await until(t!.factory, cancelled, inState("CANCELLED"));
		const live = await start();
		await until(t!.factory, live, inState("AWAITING_APPROVAL"));
		const es = await sse(port, token, "project=p");

		for (const [args, status, code] of [
			[[[]], 400, "invalid"],
			[["x"], 400, "invalid"],
			[[[delivered, "nope"]], 404, "not_found"],
			[[[delivered, cancelled, live]], 409, "conflict"],
		] as const) {
			const r = await op(port, token, "clearRuns", args as unknown as unknown[]);
			expect(r.status).toBe(status);
			expect(JSON.parse(r.body).code).toBe(code);
		}
		expect(JSON.parse((await op(port, token, "listRuns")).body).result).toHaveLength(3);

		const ok = await op(port, token, "clearRuns", [[delivered, cancelled]]);
		expect(ok.status).toBe(200);
		expect(JSON.parse(ok.body).result).toEqual({ cleared: [delivered, cancelled] });
		expect(JSON.parse((await op(port, token, "clearRuns", [[delivered]])).body).result).toEqual({ cleared: [] });
		const listed = JSON.parse((await op(port, token, "listRuns")).body).result as { id: string }[];
		expect(listed.map((r) => r.id)).toEqual([live]);
		const all = JSON.parse((await op(port, token, "listRuns", [{ includeCleared: true }])).body).result as { id: string; cleared?: { by: string } }[];
		expect(all.map((r) => r.id).sort()).toEqual([delivered, cancelled, live].sort());
		for (const r of all.filter((x) => x.id !== live)) expect(r.cleared).toMatchObject({ by: "web" });
		expect(JSON.parse((await op(port, token, "getRun", [delivered])).body).result.cleared).toMatchObject({ by: "web" });
		const retry = await op(port, token, "retryRun", [cancelled]);
		expect(retry.status).toBe(409);
		expect(JSON.parse(retry.body).code).toBe("conflict");
		await waitFor(() => es.got.filter((e) => e.type === "run.cleared").length === 2);
		expect(es.got.filter((e) => e.type === "run.cleared")).toEqual([
			{ type: "run.cleared", run: delivered, project: "p" },
			{ type: "run.cleared", run: cancelled, project: "p" },
		]);
	});
});

/** Opens `/api/events?<query>` and collects its frames into `got`. */
async function sse(port: number, token: string, query: string) {
	const got: any[] = [];
	const stream = await new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
		const req = request({ host: "127.0.0.1", port, path: `/api/events?${query}`, headers: { host: `127.0.0.1:${port}`, authorization: `Bearer ${token}` } }, resolve);
		req.on("error", reject);
		req.end();
	});
	stops.push(async () => void stream.destroy());
	let buf = "";
	stream.on("data", (c) => {
		buf += c;
		for (let i = buf.indexOf("\n\n"); i >= 0; i = buf.indexOf("\n\n")) {
			const data = /^data: (.*)$/m.exec(buf.slice(0, i))?.[1];
			buf = buf.slice(i + 2);
			if (data) got.push(JSON.parse(data));
		}
	});
	return { got, stream };
}
async function waitFor(cond: () => boolean | Promise<boolean>, ms = 10_000) {
	for (const end = Date.now() + ms; !(await cond()); ) {
		if (Date.now() > end) throw new Error("waitFor timed out");
		await new Promise((r) => setTimeout(r, 20));
	}
}

describe("discussions", () => {
	test("discussion operations over HTTP, their error codes, and the discussion event filter", async () => {
		const { port, token } = await serve();
		await t!.host.seedRepo("me/p", { "README.md": "# p\n" });
		await op(port, token, "createProject", ["p", "me/p"]);
		const es = await sse(port, token, "discussion=disc-1");
		const id = JSON.parse((await op(port, token, "startDiscussion", ["p", { title: "t", message: "m" }])).body).result;
		expect(id).toBe("disc-1");
		// a second discussion's events must not reach disc-1's stream
		const other = JSON.parse((await op(port, token, "startDiscussion", ["p", { title: "u", message: "n" }])).body).result;
		expect(other).toBe("disc-2");
		await waitFor(() => es.got.some((e) => e.type === "discussion.state" && e.to === "OPEN"));
		const v2 = await t!.factory.waitForDiscussion(other, (v) => v.state !== "PREPARING");
		expect(v2.state).toBe("OPEN");
		await new Promise((r) => setTimeout(r, 100));
		expect(es.got.length).toBeGreaterThan(0);
		expect(es.got.every((e) => e.discussion === id)).toBe(true);
		const missing = await op(port, token, "say", ["disc-9", "x"]);
		expect(missing.status).toBe(404);
		expect(JSON.parse(missing.body).code).toBe("not_found");
		const empty = await op(port, token, "say", [id, ""]);
		expect(empty.status).toBe(400);
		expect(JSON.parse(empty.body).code).toBe("invalid");
	});
});

describe("chat ops", () => {
	test("listModels over HTTP returns the available models; startDiscussion without a title derives it", async () => {
		const { port, token } = await serve();
		const models = await op(port, token, "listModels");
		expect(models.body).toContain("\"ok\":true");
		expect(models.status).toBe(200);
		const list = JSON.parse(models.body).result as { id: string; name?: string; provider: string }[];
		expect(Array.isArray(list)).toBe(true);
		expect(list.length).toBeGreaterThan(0);
		for (const m of list) {
			expect(m.id.startsWith(`${m.provider}/`)).toBe(true);
		}
		expect(list.map((m) => m.id)).toContain("scripted/discussant");
		await t!.host.seedRepo("me/p", { "README.md": "# p\n" });
		await op(port, token, "createProject", ["p", "me/p"]);
		const res = await op(port, token, "startDiscussion", ["p", { message: "## Why is the build slow?\nIt takes ages." }]);
		expect(res.status).toBe(200);
		const id = JSON.parse(res.body).result;
		const v = JSON.parse((await op(port, token, "getDiscussion", [id])).body).result;
		expect(v.title).toBe("Why is the build slow?");
		await t!.factory.waitForDiscussion(id, (d) => d.state !== "PREPARING");
	});
});

describe("static UI", () => {
	test("app.js parses; index.html loads only same-origin files and has no inline script (CSP)", () => {
		const js = readFileSync(join(UI, "app.js"), "utf8");
		expect(() => new Script(js, { filename: "app.js" })).not.toThrow();
		const html = readFileSync(join(UI, "index.html"), "utf8");
		expect(html).toContain('href="/app.css"');
		const disc = readFileSync(join(UI, "discussions.js"), "utf8");
		const bundles = readFileSync(join(UI, "bundles.js"), "utf8");
		// classic scripts after app.js: they share app.js's globals and parse in the same global scope
		expect(() => new Script(`${js}\n;${disc}\n;${bundles}`, { filename: "app.js+discussions.js+bundles.js" })).not.toThrow();
		// md()/inline() come only from markdown.js, which shares the same global scope
		const mdjs = readFileSync(join(UI, "markdown.js"), "utf8");
		expect(() => new Script(`${mdjs}\n;${js}\n;${disc}\n;${bundles}`, { filename: "markdown.js+app.js+discussions.js+bundles.js" })).not.toThrow();
		expect(`${js}\n${disc}\n${bundles}`).not.toMatch(/(function|const|let|var)\s+(md|inline)\b/);
		expect([...html.matchAll(/<script\b[^>]*>/g)].map((m) => m[0])).toEqual([
			'<script src="/vendor/marked.js" defer>',
			'<script src="/vendor/purify.js" defer>',
			'<script src="/markdown.js" defer>',
			'<script src="/app.js" defer>',
			'<script src="/discussions.js" defer>',
			'<script src="/bundles.js" defer>',
			'<script src="/update.js" defer>',
		]);
		const upd = readFileSync(join(UI, "update.js"), "utf8");
		expect(() => new Script(`${mdjs}\n;${js}\n;${disc}\n;${bundles}\n;${upd}`, { filename: "all UI scripts" })).not.toThrow();
		// the nav is Board and Settings; the Chat button sits right after Create; the Discussions list and modal are gone
		expect([...html.matchAll(/data-view="([a-z]+)"/g)].map((m) => m[1])).toEqual(["board", "settings"]);
		expect(html).toMatch(/id="create-btn"[^]*?<\/button>\s*<button type="button" class="btn" id="chat-btn"/);
		expect(html).not.toContain("view-discussions");
		expect(html).toContain('id="chatbar"');
		for (const gone of ["openNewDiscussion", "renderDiscussions", "#disc-list", "#view-discussions"]) expect(`${js}\n${disc}`).not.toContain(gone);
		expect(disc).toContain("core.listModels(");
		expect(html).not.toMatch(/https?:\/\//);
		expect(readFileSync(join(UI, "app.css"), "utf8")).not.toMatch(/@import|url\(https?:/);
		// every operation the UI calls is one the server allows
		const used = new Set([...`${js}\n${disc}\n${bundles}`.matchAll(/core\.([a-zA-Z]+)\(/g)].map((m) => m[1]!));
		used.delete("subscribe");
		const server = readFileSync(join(import.meta.dirname, "../src/core/types.ts"), "utf8");
		for (const name of used) expect(server).toContain(`"${name}",`);
	});

	test("vendor markdown libraries and markdown.js: exact routes, JavaScript, same auth, no path traversal", async () => {
		const { port, token } = await serve();
		const get = (path: string, auth = true) => http(port, "GET", path, { headers: auth ? { authorization: `Bearer ${token}` } : {} });
		for (const [path, marker] of [["/vendor/marked.js", "marked v18.1.0"], ["/vendor/purify.js", "DOMPurify"], ["/markdown.js", "DOMPurify"]] as const) {
			const r = await get(path);
			expect(r.status).toBe(200);
			expect(r.headers["content-type"]).toBe("text/javascript; charset=utf-8");
			expect(r.headers["x-content-type-options"]).toBe("nosniff");
			expect(r.headers["content-security-policy"]).toBe((await get("/app.js")).headers["content-security-policy"]);
			expect(r.body).toContain(marker);
			expect(() => new Script(r.body, { filename: path })).not.toThrow();
			// same rule as /app.js: refused without the token or cookie
			const anon = await get(path, false);
			expect(anon.status).toBe(401);
			expect(anon.body).not.toContain(marker);
		}
		// only the exact entries: no directory listing, no other files, no traversal
		for (const path of [
			"/vendor/", "/vendor", "/vendor/marked.umd.js", "/vendor/purify.min.js", "/vendor/../package.json", "/vendor/%2e%2e/package.json",
			"/vendor/..%2f..%2fpackage.json", "/vendor/marked.js/../../server.ts", "/node_modules/marked/package.json", "/../server.ts", "/%2e%2e/server.ts", "/constructor", "/__proto__", "/hasOwnProperty",
		]) {
			const r = await get(path);
			expect(r.status, path).not.toBe(200);
			expect(r.body, path).not.toMatch(/"name":|import \{/);
		}
		// the CSP gains no unsafe-eval and no foreign origin
		const csp = String((await get("/")).headers["content-security-policy"]);
		expect(csp).not.toMatch(/unsafe-eval|https?:/);
		expect(csp).toContain("script-src 'self'");
	});

	test("discussions.js is served, parses, and is loaded by index.html", async () => {
		const { port, token } = await serve();
		const get = (path: string) => http(port, "GET", path, { headers: { authorization: `Bearer ${token}` } });
		const js = await get("/discussions.js");
		expect(js.status).toBe(200);
		expect(js.headers["content-type"]).toMatch(/^text\/javascript/);
		expect(() => new Function(js.body)).not.toThrow();
		expect((await get("/")).body).toMatch(/<script src="\/discussions\.js" defer><\/script>/);
	});

	test("bundles.js is served, parses, and is loaded by index.html", async () => {
		const { port, token } = await serve();
		const get = (path: string) => http(port, "GET", path, { headers: { authorization: `Bearer ${token}` } });
		const js = await get("/bundles.js");
		expect(js.status).toBe(200);
		expect(js.headers["content-type"]).toMatch(/^text\/javascript/);
		expect(() => new Function(js.body)).not.toThrow();
		expect((await get("/")).body).toMatch(/<script src="\/bundles\.js" defer><\/script>/);
		expect((await http(port, "GET", "/bundles.js")).status).toBe(401);
	});

	test("the board and the bundle view call the bundle operations", () => {
		const ui = ["app.js", "bundles.js"].map((f) => readFileSync(join(UI, f), "utf8")).join("\n");
		for (const name of ["createBundle", "getBundle", "listBundles", "getBundleConversation", "mergeBundle", "requestBundleChanges", "dropFromBundle", "resolveBundleEscalation", "cancelBundle", "retryBundle", "messageBundle"])
			expect(ui).toContain(`core.${name}(`);
		expect(ui).toContain("#bundle=");
		expect(ui).not.toMatch(/\son[a-z]+="/); // no inline event handlers (CSP)
	});
});

/** A core stub: only what the bundle routes use, recording the calls. */
function fakeCore() {
	const calls: { op: string; args: unknown[] }[] = [];
	const subs: { filter: Record<string, string>; on: (e: FactoryEvent) => void }[] = [];
	const core = {
		async getBundleScreenshot(id: string, sid: string) {
			calls.push({ op: "getBundleScreenshot", args: [id, sid] });
			if (sid !== "r1-s1") throw Object.assign(new Error(`no screenshot ${sid}`), { code: "not_found" });
			return { mime: "image/png", bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) };
		},
		async getScreenshot() {
			throw new Error("not the run route");
		},
		subscribe(filter: Record<string, string>, on: (e: FactoryEvent) => void) {
			const s = { filter, on };
			subs.push(s);
			return () => void subs.splice(subs.indexOf(s), 1);
		},
	};
	return { core, calls, subs };
}

describe("bundles", () => {
	test("a bundle's QA screenshot is served at /api/bundles/<id>/screenshots/<sid> behind the token", async () => {
		const f = fakeCore();
		const { url, stop } = await startWebServer(f.core as any, { host: "127.0.0.1", port: 0 });
		stops.push(stop);
		const u = new URL(url), port = Number(u.port), token = u.searchParams.get("token") ?? "";
		const auth = { authorization: `Bearer ${token}` };
		expect((await http(port, "GET", "/api/bundles/bundle-1/screenshots/r1-s1")).status).toBe(401);
		expect(f.calls).toEqual([]);
		const ok = await http(port, "GET", "/api/bundles/bundle-1/screenshots/r1-s1", { headers: auth });
		expect(ok.status).toBe(200);
		expect(ok.headers["content-type"]).toBe("image/png");
		expect(ok.headers["x-content-type-options"]).toBe("nosniff");
		expect(f.calls).toEqual([{ op: "getBundleScreenshot", args: ["bundle-1", "r1-s1"] }]);
		const missing = await http(port, "GET", "/api/bundles/bundle-1/screenshots/r9-s9", { headers: auth });
		expect(missing.status).toBe(404);
		expect(JSON.parse(missing.body)).toMatchObject({ ok: false, code: "not_found" });
		expect((await http(port, "GET", "/api/bundles/bundle-1/screenshots/..%2Fx", { headers: auth })).status).toBe(404);
		expect(f.calls).toHaveLength(2);
	});

	test("the event stream passes a `bundle` filter to core.subscribe", async () => {
		const f = fakeCore();
		const { url, stop } = await startWebServer(f.core as any, { host: "127.0.0.1", port: 0 });
		stops.push(stop);
		const u = new URL(url), port = Number(u.port), token = u.searchParams.get("token") ?? "";
		const es = await sse(port, token, "bundle=bundle-2&project=p");
		await waitFor(() => f.subs.length === 1);
		expect(f.subs[0]!.filter).toEqual({ bundle: "bundle-2", project: "p" });
		const e: FactoryEvent = { type: "bundle.state", bundle: "bundle-2", project: "p", from: "INTEGRATING", to: "DELIVERING", round: 1 };
		f.subs[0]!.on(e);
		await waitFor(() => es.got.length === 1);
		expect(es.got[0]).toEqual(e);
		es.stream.destroy();
		await waitFor(() => f.subs.length === 0);
	});
});
