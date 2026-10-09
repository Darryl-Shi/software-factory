// Interface extension `web`: a ticket board and full-screen run view in the browser. Like `cli`, it is only a
// transport over the core's operations and events (spec §3.6); the core knows nothing about it.
//   POST /api/op/<op>   { args: [...] } → { ok, result } | { ok: false, error, code }   (the CORE_OPS allowlist)
//   GET  /api/events?run=&project=      server-sent events from core.subscribe
//   GET  /, /app.js, /app.css            the UI (static files, no build step)
// Access needs a token: `factory serve` prints a link carrying it, and the first visit swaps it for an HttpOnly,
// SameSite=Strict cookie. The server binds to localhost by default and rejects foreign Host and Origin headers.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { CORE_OPS, type FactoryCore, type FactoryError, type InterfaceExtension } from "../core/types.ts";

export const DEFAULT_WEB_PORT = 7317;
const COOKIE = "factory_web";
const UI_DIR = join(import.meta.dirname, "ui");
const STATIC: Record<string, [string, string]> = {
	"/": ["index.html", "text/html; charset=utf-8"],
	"/app.js": ["app.js", "text/javascript; charset=utf-8"],
	"/app.css": ["app.css", "text/css; charset=utf-8"],
};
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
const STATUS: Record<FactoryError["code"], number> = { not_found: 404, invalid: 400, conflict: 409, not_pending: 409 };

export interface WebOptions {
	/** Where the access token is kept (mode 0600) so links survive restarts; without it, a new token per process. */
	tokenFile?: string;
	/** Overrides `stages.interface.host` / `stages.interface.port` (tests: port 0). */
	host?: string;
	port?: number;
	log?: (msg: string) => void;
}

export function loadToken(file?: string): string {
	if (file && existsSync(file)) {
		const t = readFileSync(file, "utf8").trim();
		if (t.length >= 32) return t;
	}
	const token = randomBytes(24).toString("base64url");
	if (file) {
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, `${token}\n`, { mode: 0o600 });
	}
	return token;
}

const isLoopback = (h: string) => h === "127.0.0.1" || h === "localhost" || h === "::1" || h === "[::1]";

export function webInterface(opts: WebOptions = {}): InterfaceExtension {
	return {
		kind: "interface",
		name: "web",
		settings: {
			schema: {
				host: { type: "string", default: "127.0.0.1", description: "web: address the web UI listens on (keep it on localhost)" },
				port: { type: "number", default: DEFAULT_WEB_PORT, min: 0, max: 65535, description: "web: port of the web UI (0 picks a free port)" },
			},
		},
		async start(core: FactoryCore) {
			const log = opts.log ?? (() => {});
			const eff = await core.getSettings({ global: true });
			const host = String(opts.host ?? eff["stages.interface.host"]?.value ?? "127.0.0.1");
			const wantPort = Number(opts.port ?? eff["stages.interface.port"]?.value ?? DEFAULT_WEB_PORT);
			const token = loadToken(opts.tokenFile);
			const tokenBuf = Buffer.from(token);
			const streams = new Set<ServerResponse>();
			let port = wantPort;

			const authed = (req: IncomingMessage): boolean => {
				const bearer = /^Bearer (\S+)$/.exec(req.headers.authorization ?? "")?.[1];
				const cookie = (req.headers.cookie ?? "").split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
				return [bearer, cookie].some((t) => t !== undefined && t.length === token.length && timingSafeEqual(Buffer.from(t), tokenBuf));
			};
			// DNS rebinding: on a loopback address only loopback Host names are accepted.
			const hostOk = (req: IncomingMessage): boolean => {
				if (!isLoopback(host)) return true;
				const h = req.headers.host ?? "";
				return [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(h);
			};
			const originOk = (req: IncomingMessage): boolean => {
				const o = req.headers.origin;
				return o === undefined || o === `http://${req.headers.host}`;
			};
			const send = (res: ServerResponse, status: number, body: string, type = "application/json; charset=utf-8", extra: Record<string, string> = {}) => {
				res.writeHead(status, {
					"content-type": type,
					"cache-control": "no-store",
					"x-content-type-options": "nosniff",
					"referrer-policy": "no-referrer",
					"x-frame-options": "DENY",
					"content-security-policy": CSP,
					...extra,
				});
				res.end(body);
			};
			const json = (res: ServerResponse, status: number, v: unknown) => send(res, status, JSON.stringify(v));

			const server = createServer(async (req, res) => {
				try {
					const url = new URL(req.url ?? "/", "http://localhost");
					if (!hostOk(req)) return send(res, 421, "Unknown host", "text/plain; charset=utf-8");
					// Exchange the link's token for the cookie, then drop it from the address bar.
					if (req.method === "GET" && url.pathname === "/" && url.searchParams.has("token")) {
						const t = url.searchParams.get("token") ?? "";
						if (t.length !== token.length || !timingSafeEqual(Buffer.from(t), tokenBuf)) return send(res, 401, loginPage(true), "text/html; charset=utf-8");
						return send(res, 303, "", "text/plain", { location: "/", "set-cookie": `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/` });
					}
					if (!authed(req)) {
						if (req.method === "GET" && url.pathname === "/") return send(res, 401, loginPage(false), "text/html; charset=utf-8");
						return json(res, 401, { ok: false, error: "open the link `factory serve` printed (or run `factory web`)", code: "unauthorized" });
					}
					const file = STATIC[url.pathname];
					if (req.method === "GET" && file) return send(res, 200, readFileSync(join(UI_DIR, file[0]), "utf8"), file[1]);
					if (req.method === "GET" && url.pathname === "/api/events") return events(req, res, url);
					const op = /^\/api\/op\/([A-Za-z]+)$/.exec(url.pathname)?.[1];
					if (op !== undefined) {
						if (req.method !== "POST") return json(res, 405, { ok: false, error: "use POST" });
						if (!originOk(req)) return json(res, 403, { ok: false, error: "cross-origin request refused" });
						if (!/^application\/json\b/.test(req.headers["content-type"] ?? "")) return json(res, 415, { ok: false, error: "send application/json" });
						if (!(CORE_OPS as readonly string[]).includes(op)) return json(res, 404, { ok: false, error: `unknown operation ${op}` });
						let args: unknown[];
						try {
							const body = JSON.parse((await readBody(req)) || "{}");
							args = Array.isArray(body.args) ? body.args : [];
						} catch (e) {
							return json(res, 400, { ok: false, error: e instanceof Error ? e.message : "invalid JSON" });
						}
						try {
							const result = await (core as any)[op](...args);
							return json(res, 200, { ok: true, result: result ?? null });
						} catch (e: any) {
							const code = e?.code as FactoryError["code"] | undefined;
							return json(res, (code && STATUS[code]) ?? 500, { ok: false, error: e?.message ?? String(e), ...(code ? { code } : {}) });
						}
					}
					return json(res, 404, { ok: false, error: "not found" });
				} catch (e) {
					log(`web: ${e instanceof Error ? e.stack : e}`);
					if (!res.headersSent) json(res, 500, { ok: false, error: "internal error" });
					else res.end();
				}
			});

			function events(req: IncomingMessage, res: ServerResponse, url: URL) {
				const filter: { run?: string; project?: string } = {};
				const run = url.searchParams.get("run");
				const project = url.searchParams.get("project");
				if (run) filter.run = run;
				if (project) filter.project = project;
				res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive", "x-content-type-options": "nosniff" });
				res.write("retry: 2000\n\n");
				streams.add(res);
				const off = core.subscribe(filter, (e) => res.write(`data: ${JSON.stringify(e)}\n\n`));
				const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
				const close = () => {
					off();
					clearInterval(ping);
					streams.delete(res);
				};
				req.on("close", close);
				res.on("error", close);
			}

			const listening = await new Promise<boolean>((resolve, reject) => {
				server.once("error", (e: NodeJS.ErrnoException) => {
					if (e.code === "EADDRINUSE" || e.code === "EACCES") {
						log(`web UI not started: ${host}:${wantPort} is ${e.code === "EADDRINUSE" ? "in use" : "not allowed"} (set stages.interface.port)`);
						resolve(false);
					} else reject(e);
				});
				server.listen(wantPort, host, () => resolve(true));
			});
			if (!listening) return { url: undefined, async stop() {} };
			const addr = server.address();
			port = typeof addr === "object" && addr ? addr.port : wantPort;
			const shown = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host.includes(":") ? `[${host}]` : host;
			const link = `http://${shown}:${port}/?token=${token}`;
			if (!isLoopback(host)) log(`web UI listens on ${host}, beyond this machine, over plain HTTP; prefer 127.0.0.1 behind an SSH tunnel`);
			log(`web UI: ${link}`);
			const urlFile = opts.tokenFile ? join(dirname(opts.tokenFile), "web-url") : undefined;
			if (urlFile) writeFileSync(urlFile, `${link}\n`, { mode: 0o600 });
			return {
				url: link,
				async stop() {
					for (const s of streams) s.end();
					await new Promise<void>((r) => server.close(() => r()));
					server.closeAllConnections?.();
					if (urlFile) rmSync(urlFile, { force: true });
				},
			};
		},
	};
}

function readBody(req: IncomingMessage, limit = 1 << 20): Promise<string> {
	return new Promise((resolve, reject) => {
		let size = 0;
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => {
			size += c.length;
			if (size > limit) {
				reject(new Error("request body too large"));
				req.destroy();
			} else chunks.push(c);
		});
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}

function loginPage(bad: boolean): string {
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Factory</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;font:15px/1.55 system-ui,sans-serif;background:#f4f6f9;color:#16202b}main{max-width:420px;padding:28px;background:#fff;border:1px solid #e1e6ed;border-radius:14px}h1{font-size:18px;margin:0 0 8px}code{background:#eef1f5;padding:1px 5px;border-radius:5px}@media (prefers-color-scheme:dark){body{background:#0b0f15;color:#e6ebf2}main{background:#121821;border-color:#222b38}code{background:#1c2430}}</style></head>
<body><main><h1>${bad ? "That link has expired" : "Factory"}</h1><p>${bad ? "The token in the link doesn't match this factory." : "This page needs the link that carries your access token."} Open the link <code>factory serve</code> printed, or run <code>factory web</code> to print it again.</p></main></body></html>`;
}
