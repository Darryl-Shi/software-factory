// The seam between `Boat` and boat.dev (spec §3.7): `BoatApiBackend` talks to boat's HTTP API through `@boatdev/sdk`;
// `LocalBoatBackend` is a fake on the local disk for tests and the dry run (a "VM" is a directory, commands run in a
// local shell, and a stub `cua-driver` writes screenshots). Like GitHubHost, it is the only seam; the core calls `Boat`.
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { BoatApi, Configuration, ResponseError, waitUntilReady } from "@boatdev/sdk";

export interface BoatVm {
	id: string;
	name?: string;
	/** boat's sandbox state, e.g. ready, idle, running, stopping, stopped, archived, deleted, error. */
	state: string;
}

export interface BoatExecResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

export interface BoatBackend {
	/** Create a VM with no account env (`noEnv`), named `name`; the idempotency key makes a retry return the same VM. */
	create(opts: { name: string; idempotencyKey: string; size: string; ttlSeconds: number }): Promise<BoatVm>;
	/** undefined when the VM no longer exists. */
	get(id: string): Promise<BoatVm | undefined>;
	waitReady(id: string, timeoutMs: number): Promise<BoatVm>;
	resume(id: string): Promise<void>;
	exec(id: string, command: string, opts?: { cwd?: string; timeoutSeconds?: number }): Promise<BoatExecResult>;
	writeFile(id: string, path: string, bytes: Uint8Array): Promise<void>;
	readFile(id: string, path: string): Promise<Uint8Array>;
	/** Permanently delete the VM and its snapshots. */
	delete(id: string): Promise<void>;
	list(): Promise<BoatVm[]>;
	usage(id: string): Promise<{ seconds: number; dollars: number }>;
	limits(): Promise<unknown>;
}

/** boat.dev runs a synchronous command for at most this long; `timeoutSeconds` must be an integer in 1..600. */
export const MAX_EXEC_SECONDS = 600;

/** A command timeout boat accepts: a whole number of seconds in 1..600; undefined (boat's default) for none or a non-number. */
export function boatTimeout(seconds: number | undefined): number | undefined {
	if (seconds === undefined || Number.isNaN(seconds) || seconds <= 0) return undefined;
	return Math.min(MAX_EXEC_SECONDS, Math.max(1, Math.ceil(seconds)));
}

export const READY_STATES = ["ready", "idle", "running", "busy"];
export const STOPPED_STATES = ["stopped", "stopping", "archived", "paused"];
export const GONE_STATES = ["deleted", "deleting", "error", "failed", "destroyed"];

/** An error from boat that says the thing does not exist (HTTP 404). */
export class BoatNotFound extends Error {}

const statusOf = (e: unknown) => (e instanceof ResponseError ? e.response.status : (e as any)?.response?.status);

export class BoatApiBackend implements BoatBackend {
	private api: BoatApi;
	constructor(apiKey: string, basePath = process.env.BOAT_BASE_URL ?? "https://boat.dev/api/v1") {
		this.api = new BoatApi(new Configuration({ basePath, accessToken: apiKey }));
	}

	private async wrap<T>(f: () => Promise<T>): Promise<T> {
		try {
			return await f();
		} catch (e) {
			if (statusOf(e) === 404) throw new BoatNotFound(String((e as Error).message));
			if (e instanceof ResponseError) {
				const body = await e.response.text().catch(() => "");
				throw new Error(`boat API ${e.response.status}: ${body.slice(0, 300) || e.message}`);
			}
			throw e;
		}
	}

	async create(opts: { name: string; idempotencyKey: string; size: string; ttlSeconds: number }): Promise<BoatVm> {
		const r = await this.wrap(() =>
			this.api.create({ idempotencyKey: opts.idempotencyKey, createSandboxRequest: { noEnv: true, type: opts.size as any, ttlSeconds: opts.ttlSeconds } }),
		);
		const id = r.sandbox!.id!;
		await this.wrap(() => this.api.update({ sandboxId: id, updateSandboxRequest: { name: opts.name } }));
		return { id, name: opts.name, state: String(r.sandbox?.state ?? "provisioning") };
	}
	async get(id: string): Promise<BoatVm | undefined> {
		try {
			const r = await this.wrap(() => this.api.get({ sandboxId: id }));
			return { id, name: (r as any).sandbox?.name, state: String((r as any).sandbox?.state ?? "unknown") };
		} catch (e) {
			if (e instanceof BoatNotFound) return undefined;
			throw e;
		}
	}
	async waitReady(id: string, timeoutMs: number): Promise<BoatVm> {
		const s = await this.wrap(() => waitUntilReady(this.api, id, { timeoutMs }));
		return { id, name: s.name, state: String(s.state) };
	}
	async resume(id: string): Promise<void> {
		await this.wrap(() => this.api.resume({ sandboxId: id, resumeRequest: { noEnv: true } }));
	}
	async exec(id: string, command: string, opts: { cwd?: string; timeoutSeconds?: number } = {}): Promise<BoatExecResult> {
		const timeoutSeconds = boatTimeout(opts.timeoutSeconds);
		const r: any = await this.wrap(() =>
			this.api.command({ sandboxId: id, commandRequest: { command, ...(opts.cwd ? { cwd: opts.cwd } : {}), ...(timeoutSeconds ? { timeoutSeconds } : {}) } }),
		);
		return { exitCode: r.exitCode ?? (r.timedOut ? 124 : -1), stdout: r.stdout ?? "", stderr: (r.stderr ?? "") + (r.timedOut ? "\n[timed out]" : "") };
	}
	async writeFile(id: string, path: string, bytes: Uint8Array): Promise<void> {
		await this.wrap(() => this.api.writeFile({ sandboxId: id, fileWriteRequest: { path, content: Buffer.from(bytes).toString("base64"), encoding: "base64" as any } }));
	}
	async readFile(id: string, path: string): Promise<Uint8Array> {
		const r = await this.wrap(() => this.api.readFile({ sandboxId: id, path, encoding: "base64" as any }));
		return r.encoding === "utf8" ? Buffer.from(r.content ?? "", "utf8") : Buffer.from(r.content ?? "", "base64");
	}
	async delete(id: string): Promise<void> {
		try {
			await this.wrap(() => this.api.deleteSandbox({ sandboxId: id, xAsciiConfirmDelete: id }));
		} catch (e) {
			if (!(e instanceof BoatNotFound)) throw e;
		}
	}
	async list(): Promise<BoatVm[]> {
		const out: BoatVm[] = [];
		let cursor: string | undefined;
		for (let page = 0; page < 50; page++) {
			const r = await this.wrap(() => this.api.sandboxes({ limit: 100, ...(cursor ? { cursor } : {}) }));
			for (const s of r.sandboxes ?? []) out.push({ id: String(s.id), name: s.name, state: String(s.state) });
			if (!r.pageInfo?.hasMore || !r.pageInfo.nextCursor) break;
			cursor = r.pageInfo.nextCursor;
		}
		return out;
	}
	async usage(id: string): Promise<{ seconds: number; dollars: number }> {
		const r = await this.wrap(() => this.api.usage({ sandboxId: id }));
		return { seconds: Number(r.seconds ?? 0), dollars: Number(r.dollars ?? 0) };
	}
	async limits(): Promise<unknown> {
		return this.wrap(() => this.api.limits({}));
	}
}

// ------------------------------------------------------------------ the local fake
type LocalVm = { id: string; name?: string; state: string; key: string; home: string; createdAt: number; deleted?: boolean };
type LocalState = { seq: number; vms: Record<string, LocalVm>; keys: Record<string, string>; calls: { op: string; id?: string; detail?: unknown }[] };

/** A 1x1 PNG: what the stub cua-driver writes as a screenshot. */
export const TINY_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

const CUA_STUB = `#!/usr/bin/env bash
# Stub of boat's Cua Driver for the fake boat: "cua-driver call <tool> [json] [--screenshot-out-file f]".
shift
tool="$1"; shift
json="{}"; out=""
while [ $# -gt 0 ]; do
  case "$1" in
    --screenshot-out-file) out="$2"; shift 2;;
    *) json="$1"; shift;;
  esac
done
page="$HOME/.cua-page"
case "$tool" in
  browser_navigate)
    url=$(printf '%s' "$json" | sed -n 's/.*"url"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p')
    curl -s -m 10 "$url" > "$page" 2>&1; code=$?
    echo "{\\"ok\\":$([ $code = 0 ] && echo true || echo false),\\"url\\":\\"$url\\"}";;
  get_browser_state|get_window_state)
    echo "{\\"ok\\":true,\\"tool\\":\\"$tool\\",\\"page_text\\":$(node -e 'const fs=require("fs");const p=process.argv[1];process.stdout.write(JSON.stringify(fs.existsSync(p)?fs.readFileSync(p,"utf8"):""))' "$page")}";;
  *) echo "{\\"ok\\":true,\\"tool\\":\\"$tool\\",\\"args\\":$json}";;
esac
if [ -n "$out" ]; then printf '%s' '${TINY_PNG.toString("base64")}' | base64 -d > "$out"; fi
`;

export class LocalBoatBackend implements BoatBackend {
	constructor(readonly root: string) {
		mkdirSync(join(root, "bin"), { recursive: true });
		writeFileSync(join(root, "bin", "cua-driver"), CUA_STUB);
		chmodSync(join(root, "bin", "cua-driver"), 0o755);
	}
	private file() {
		return join(this.root, "state.json");
	}
	state(): LocalState {
		return existsSync(this.file()) ? JSON.parse(readFileSync(this.file(), "utf8")) : { seq: 0, vms: {}, keys: {}, calls: [] };
	}
	private save(s: LocalState) {
		writeFileSync(this.file(), JSON.stringify(s, null, 2));
	}
	private vm(id: string): LocalVm {
		const v = this.state().vms[id];
		if (!v || v.deleted) throw new BoatNotFound(`sandbox ${id} not found`);
		return v;
	}
	private log(op: string, id?: string, detail?: unknown) {
		const s = this.state();
		s.calls.push({ op, ...(id ? { id } : {}), ...(detail !== undefined ? { detail } : {}) });
		this.save(s);
	}

	async create(opts: { name: string; idempotencyKey: string; size: string; ttlSeconds: number }): Promise<BoatVm> {
		const s = this.state();
		const existing = s.keys[opts.idempotencyKey];
		if (existing) {
			const v = s.vms[existing]!;
			return { id: v.id, name: v.name, state: v.deleted ? "deleted" : v.state };
		}
		if (existsSync(join(this.root, "fail-create"))) throw new Error("boat API 503: no capacity (fake)");
		s.seq += 1;
		const id = `sb_fake${s.seq}`;
		const home = join(this.root, "vms", id, "home");
		mkdirSync(home, { recursive: true });
		s.vms[id] = { id, name: opts.name, state: "ready", key: opts.idempotencyKey, home, createdAt: Date.now() };
		s.keys[opts.idempotencyKey] = id;
		s.calls.push({ op: "create", id, detail: { name: opts.name, size: opts.size, ttlSeconds: opts.ttlSeconds, noEnv: true } });
		this.save(s);
		return { id, name: opts.name, state: "ready" };
	}
	async get(id: string): Promise<BoatVm | undefined> {
		const v = this.state().vms[id];
		if (!v || v.deleted) return undefined;
		return { id, name: v.name, state: v.state };
	}
	async waitReady(id: string): Promise<BoatVm> {
		const v = this.vm(id);
		if (!READY_STATES.includes(v.state)) throw new Error(`sandbox ${id} is ${v.state}`);
		return { id, name: v.name, state: v.state };
	}
	async resume(id: string): Promise<void> {
		const s = this.state();
		const v = s.vms[id];
		if (!v || v.deleted) throw new BoatNotFound(`sandbox ${id} not found`);
		v.state = "ready";
		s.calls.push({ op: "resume", id });
		this.save(s);
	}
	/** Test hook: what boat's ttl does (the VM stops; its snapshot keeps the code). Kills the product. */
	stop(id: string) {
		this.killAll(id);
		const s = this.state();
		s.vms[id]!.state = "stopped";
		this.save(s);
	}
	private killAll(id: string) {
		const pidFile = join(this.state().vms[id]?.home ?? "/nonexistent", ".factory-run.pid");
		if (existsSync(pidFile)) {
			const pid = Number(readFileSync(pidFile, "utf8").trim());
			try {
				process.kill(-pid, "SIGKILL");
			} catch {
				try {
					process.kill(pid, "SIGKILL");
				} catch {}
			}
		}
	}
	exec(id: string, command: string, opts: { cwd?: string; timeoutSeconds?: number } = {}): Promise<BoatExecResult> {
		// like boat.dev: a timeout outside 1..600 or not an integer is a 400 invalid_timeout
		const t = opts.timeoutSeconds;
		if (t !== undefined && !(Number.isInteger(t) && t >= 1 && t <= MAX_EXEC_SECONDS))
			return Promise.reject(new Error(`boat API 400: {"ok":false,"code":"invalid_timeout","message":"timeoutSeconds must be an integer between 1 and 600."}`));
		const v = this.vm(id);
		if (!READY_STATES.includes(v.state)) return Promise.reject(Object.assign(new Error(`boat API 409: sandbox ${id} is ${v.state}`), { stopped: true }));
		return new Promise((resolve) => {
			const child = spawn("bash", ["-c", command], {
				cwd: opts.cwd && existsSync(opts.cwd) ? opts.cwd : v.home,
				env: { PATH: `${join(this.root, "bin")}:${process.env.PATH}`, HOME: v.home, LANG: "C.UTF-8", TERM: "dumb" },
				stdio: ["ignore", "pipe", "pipe"],
				detached: true,
			});
			let stdout = "";
			let stderr = "";
			child.stdout.on("data", (d) => (stdout += d));
			child.stderr.on("data", (d) => (stderr += d));
			const t = setTimeout(() => {
				try {
					process.kill(-child.pid!, "SIGKILL");
				} catch {}
			}, (opts.timeoutSeconds ?? 600) * 1000);
			child.on("close", (code) => {
				clearTimeout(t);
				resolve({ exitCode: code ?? -1, stdout, stderr });
			});
		});
	}
	async writeFile(id: string, path: string, bytes: Uint8Array): Promise<void> {
		this.vm(id);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, bytes);
	}
	async readFile(id: string, path: string): Promise<Uint8Array> {
		this.vm(id);
		if (!existsSync(path)) throw new BoatNotFound(`no such file: ${path}`);
		return readFileSync(path);
	}
	async delete(id: string): Promise<void> {
		const s = this.state();
		const v = s.vms[id];
		if (!v || v.deleted) return;
		this.killAll(id);
		v.deleted = true;
		v.state = "deleted";
		s.calls.push({ op: "delete", id });
		this.save(s);
		rmSync(join(this.root, "vms", id), { recursive: true, force: true });
	}
	async list(): Promise<BoatVm[]> {
		return Object.values(this.state().vms)
			.filter((v) => !v.deleted)
			.map((v) => ({ id: v.id, name: v.name, state: v.state }));
	}
	async usage(id: string): Promise<{ seconds: number; dollars: number }> {
		const v = this.state().vms[id];
		const seconds = v ? Math.max(1, Math.round((Date.now() - v.createdAt) / 1000)) : 0;
		return { seconds, dollars: 0 };
	}
	async limits(): Promise<unknown> {
		return { ok: true, fake: true };
	}
}
