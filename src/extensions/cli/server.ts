// Interface extension `cli` (spec §3.2 InterfaceExtension, §7): the transport side. The process that owns the storage
// and the core starts it; it listens on a Unix socket and maps a JSON-lines protocol onto the core's operations and
// event stream. The terminal client (src/extensions/cli/client.ts) connects to it. The core knows nothing about it.
import { chmodSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { dirname } from "node:path";
import { expandHome } from "../../core/settings.ts";
import { CORE_OPS, type FactoryCore, type InterfaceExtension } from "../../core/types.ts";

export { CORE_OPS } from "../../core/types.ts";

export const DEFAULT_SOCKET = "~/.factory/factory.sock";

export function cliInterface(opts: { socket?: string } = {}): InterfaceExtension {
	return {
		kind: "interface",
		name: "cli",
		settings: {
			schema: { socket: { type: "string", default: DEFAULT_SOCKET, description: "Unix socket the `factory` CLI connects to (cli interface)" } },
		},
		async start(core: FactoryCore) {
			const configured = (await core.getSettings({ global: true }))["stages.interface.socket"]?.value as string | undefined;
			const path = expandHome(opts.socket ?? configured ?? DEFAULT_SOCKET);
			mkdirSync(dirname(path), { recursive: true });
			if (existsSync(path)) rmSync(path);
			const sockets = new Set<Socket>();
			const server = createServer((sock) => {
				sockets.add(sock);
				const unsubs: (() => void)[] = [];
				let buf = "";
				const send = (m: unknown) => {
					if (!sock.destroyed) sock.write(`${JSON.stringify(m)}\n`);
				};
				sock.on("data", (d) => {
					buf += d.toString();
					let i: number;
					while ((i = buf.indexOf("\n")) >= 0) {
						const line = buf.slice(0, i);
						buf = buf.slice(i + 1);
						if (!line.trim()) continue;
						let msg: { id: number; op: string; args?: unknown[] };
						try {
							msg = JSON.parse(line);
						} catch {
							send({ id: null, ok: false, error: "invalid JSON" });
							continue;
						}
						if (msg.op === "subscribe") {
							unsubs.push(core.subscribe((msg.args?.[0] ?? {}) as any, (event) => send({ id: msg.id, event })));
							send({ id: msg.id, ok: true, result: "subscribed" });
							continue;
						}
						if (!(CORE_OPS as readonly string[]).includes(msg.op)) {
							send({ id: msg.id, ok: false, error: `unknown operation ${msg.op}` });
							continue;
						}
						Promise.resolve()
							.then(() => (core as any)[msg.op](...(msg.args ?? [])))
							.then((result) => send({ id: msg.id, ok: true, result: result ?? null }))
							.catch((e: any) => send({ id: msg.id, ok: false, error: e?.message ?? String(e), code: e?.code }));
					}
				});
				sock.on("close", () => {
					unsubs.forEach((u) => u());
					sockets.delete(sock);
				});
				sock.on("error", () => {});
			});
			await new Promise<void>((resolve, reject) => {
				server.once("error", reject);
				server.listen(path, () => resolve());
			});
			chmodSync(path, 0o600);
			return {
				async stop() {
					for (const s of sockets) s.destroy();
					await new Promise<void>((r) => server.close(() => r()));
					rmSync(path, { force: true });
				},
			};
		},
	};
}
