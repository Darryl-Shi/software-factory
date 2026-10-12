// Boat (spec §3.7): the QA agent's environment, a boat.dev VM with a desktop and Chrome, where the reviewed build runs.
// Same shape as `Sandbox` (provision, env, dispose); the core calls it directly. One fresh VM per review round, named
// `factory-<runId>-<seq>`, created with `noEnv` and an idempotency key (run + round + attempt), so a resume after a crash
// finds the same VM. The reviewed build arrives as a git bundle (the VM gets no GitHub access); the repo's setup script
// runs, then the first run script that exists starts the product in the background.
// The boat API key is a reference (`boat.apiKey`); only this class, in the factory process, resolves it. It is never
// written to the config file, the run Document, a transcript, a log or a VM.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import type { Context } from "@earendil-works/chord";
import { type ExecutionEnv, ExecutionError, FileError, type Result, type ShellExecOptions, type ShellExecResult } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { expandHome, parseDuration, resolveSecret } from "../core/settings.ts";
import type { RunCtx, Workspace } from "../core/types.ts";
import type { SecretStore } from "../secrets/store.ts";
import { type BoatBackend, BoatNotFound, GONE_STATES, STOPPED_STATES } from "./backend.ts";

export type QaVmRecord = {
	envId: string;
	runId: string;
	seq: number;
	name: string;
	attempt: number;
	vmId?: string;
	/** The reference, never the key. */
	apiKeyRef: string;
	size: string;
	ttlSeconds: number;
	home?: string;
	appDir?: string;
	runScript?: string;
	sha?: string;
	state: "provisioning" | "ready" | "disposed";
	bootLog?: string;
	booted?: boolean;
};

export interface ProvisionResult {
	envId: string;
	vmId: string;
	name: string;
	attempt: number;
	/** Setup + run script output; `bootOk` false when either failed (the QA agent still starts, with this output). */
	bootLog: string;
	bootOk: boolean;
	runScript?: string;
	/** new: a fresh VM · same: the VM this round already had · restarted: a stopped VM was resumed and the product restarted · replaced: the old VM was gone, a new one took its place. */
	outcome: "new" | "same" | "restarted" | "replaced";
}

export const vmName = (runId: string, seq: number) => `factory-${runId}-${seq}`;
const qaEnvId = (runId: string, seq: number) => `${runId}-qa-${seq}`;
const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** The env var or file a `boat.apiKey` reference names (for the sandbox's credential deny list). */
export function boatKeyLocation(ref: unknown): { envVar?: string; file?: string } {
	if (typeof ref !== "string") return {};
	if (ref.startsWith("env:")) return { envVar: ref.slice(4) };
	if (ref.startsWith("file:")) return { file: expandHome(ref.slice(5)) };
	return {};
}

/** Rules on the `boat` settings section (validate on save; whether the key resolves is a run-time and doctor check). */
export function boatProblems(boat: Record<string, any>): string[] {
	const problems: string[] = [];
	if (boat?.ttl !== undefined) {
		const ms = parseDuration(boat.ttl);
		if (!(ms >= 0)) problems.push(`ttl: "${boat.ttl}" is not a duration (e.g. 1h, 30m)`);
		else if (ms < 10 * 60_000 || ms > 24 * 3_600_000) problems.push(`ttl: ${boat.ttl} is out of range (10m to 24h)`);
	}
	if (boat?.runScripts !== undefined) {
		const rs = boat.runScripts as unknown[];
		if (!Array.isArray(rs) || rs.length === 0) problems.push("runScripts: needs at least one path");
		else
			for (const p of rs)
				if (typeof p !== "string" || !p.trim() || p.startsWith("/") || p.split(/[\\/]/).includes("..")) problems.push(`runScripts: ${String(p)} must be a repo-relative path without ".."`);
	}
	return problems;
}

export class Boat {
	private readonly stateDir: string;
	private readonly backendFor: (apiKey: string) => BoatBackend;
	private readonly retryDelayMs: number;
	private readonly bootWaitMs: number;
	private readonly readyTimeoutMs: number;

	constructor(opts: { stateDir: string; backend: (apiKey: string) => BoatBackend; retryDelayMs?: number; bootWaitMs?: number; readyTimeoutMs?: number }) {
		this.stateDir = expandHome(opts.stateDir);
		this.backendFor = opts.backend;
		this.retryDelayMs = opts.retryDelayMs ?? 2000;
		this.bootWaitMs = opts.bootWaitMs ?? 5000;
		this.readyTimeoutMs = opts.readyTimeoutMs ?? 10 * 60_000;
	}

	/** The boat API key a run's pinned config names resolves (no VM, no API call). */
	keyResolves(config: Record<string, any>): boolean {
		return !!resolveSecret(config.boat?.apiKey ?? "env:BOAT_API_KEY");
	}

	private backend(apiKeyRef: string, store?: SecretStore): BoatBackend {
		const key = resolveSecret(apiKeyRef, store);
		if (!key) throw new Error(`boat.apiKey (${apiKeyRef}) does not resolve`);
		return this.backendFor(key);
	}

	private recordPath(envId: string) {
		return join(this.stateDir, `${envId}.json`);
	}
	record(envId: string): QaVmRecord | undefined {
		const p = this.recordPath(envId);
		return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as QaVmRecord) : undefined;
	}
	private save(r: QaVmRecord) {
		mkdirSync(this.stateDir, { recursive: true });
		writeFileSync(this.recordPath(r.envId), JSON.stringify(r, null, 2));
	}

	/** boat API calls retry with backoff (3 attempts). */
	private async retry<T>(what: string, f: () => Promise<T>): Promise<T> {
		let last: unknown;
		for (let i = 0; i < 3; i++) {
			try {
				return await f();
			} catch (e) {
				if (e instanceof BoatNotFound) throw e;
				last = e;
				if (i < 2) await new Promise((r) => setTimeout(r, this.retryDelayMs * 2 ** i));
			}
		}
		throw new Error(`boat: ${what} failed after 3 attempts: ${last instanceof Error ? last.message : String(last)}`);
	}

	/**
	 * The round's VM with the reviewed build running in it. Idempotent per (run, round): called again after a crash it
	 * returns the same VM (same idempotency key); a stopped VM is resumed and the product restarted; a deleted or broken
	 * VM is replaced (attempt + 1). `bundle` makes the git bundle of the reviewed build (called only when it is needed).
	 * Throws when boat cannot provide a working VM after retries (the caller records QA as `unavailable`).
	 */
	async provision(ws: Workspace, rc: RunCtx, opts: { seq: number; bundle: (out: string) => Promise<{ ref: string; sha: string }> }): Promise<ProvisionResult> {
		const envId = qaEnvId(rc.runId, opts.seq);
		const cfg = rc.config.boat ?? {};
		let rec =
			this.record(envId) ??
			({
				envId,
				runId: rc.runId,
				seq: opts.seq,
				name: vmName(rc.runId, opts.seq),
				attempt: 1,
				apiKeyRef: String(cfg.apiKey ?? "env:BOAT_API_KEY"),
				size: String(cfg.size ?? "default"),
				ttlSeconds: Math.round(parseDuration(cfg.ttl ?? "1h") / 1000),
				state: "provisioning",
			} satisfies QaVmRecord);
		if (rec.state === "disposed") throw new Error(`the QA VM of review ${opts.seq} was already disposed`);
		const api = this.backend(rec.apiKeyRef);
		let outcome: ProvisionResult["outcome"] = rec.vmId ? "same" : "new";
		if (rec.vmId && rec.booted) {
			const vm = await this.retry("get", () => api.get(rec.vmId!));
			if (!vm || GONE_STATES.includes(vm.state)) {
				// deleted by hand, or broken: replace it (a new idempotency key)
				rec = { ...rec, attempt: rec.attempt + 1, state: "provisioning", booted: false };
				delete rec.vmId;
				delete rec.home;
				outcome = "replaced";
			} else if (STOPPED_STATES.includes(vm.state)) {
				await this.retry("resume", () => api.resume(rec.vmId!));
				await this.retry("wait for ready", () => api.waitReady(rec.vmId!, this.readyTimeoutMs));
				const log = await this.startProduct(api, rec);
				rec = { ...rec, bootLog: `${rec.bootLog ?? ""}\n[the VM was stopped and resumed; the product was restarted]\n${log.text}`, state: "ready" };
				this.save(rec);
				return this.result(rec, "restarted", log.ok);
			} else {
				rec.state = "ready";
				this.save(rec);
				return this.result(rec, "same", !/\[(setup|run) script failed/.test(rec.bootLog ?? ""));
			}
		}
		this.save(rec);
		const key = `factory:${rc.runId}:${opts.seq}:${rec.attempt}`;
		const vm = await this.retry("create", () => api.create({ name: rec.name, idempotencyKey: key, size: rec.size, ttlSeconds: rec.ttlSeconds }));
		rec.vmId = vm.id;
		this.save(rec);
		await this.retry("wait for ready", () => api.waitReady(vm.id, this.readyTimeoutMs));
		const home = (await this.retry("exec", () => api.exec(vm.id, "printf %s \"$HOME\""))).stdout.trim() || "/root";
		rec.home = home;
		rec.appDir = posix.join(home, "app");
		// copy in the reviewed build as a git bundle
		const local = join(tmpdir(), `factory-${envId}-${Date.now()}.bundle`);
		const { ref, sha } = await opts.bundle(local);
		const remoteBundle = posix.join(home, "factory-review.bundle");
		try {
			await this.retry("upload", () => api.writeFile(vm.id, remoteBundle, readFileSync(local)));
		} finally {
			rmSync(local, { force: true });
		}
		const clone = await this.retry("exec", () =>
			api.exec(vm.id, `rm -rf ${shq(rec.appDir!)} && git init -q ${shq(rec.appDir!)} && cd ${shq(rec.appDir!)} && git fetch -q ${shq(remoteBundle)} ${shq(ref)} && git -c advice.detachedHead=false checkout -q FETCH_HEAD && git rev-parse HEAD`),
		);
		if (clone.exitCode !== 0) throw new Error(`could not copy the reviewed build into the VM: ${clone.stderr.slice(0, 300)}`);
		rec.sha = sha;
		// setup script (sandbox.setupScripts), then the first run script that exists (boat.runScripts)
		let log = "";
		let ok = true;
		const setup = ((rc.config.sandbox?.setupScripts ?? []) as string[]).find((s) => existsSync(join(ws.path, s)));
		if (setup) {
			const r = await this.retry("exec", () => api.exec(vm.id, `bash ${shq(setup)} 2>&1`, { cwd: rec.appDir!, timeoutSeconds: 900 }));
			log += `$ bash ${setup}\n${r.stdout}${r.stderr}\n[setup script exited ${r.exitCode}]\n`;
			if (r.exitCode !== 0) {
				ok = false;
				log += `[setup script failed]\n`;
			}
		}
		rec.runScript = ((cfg.runScripts ?? ["scripts/run.sh", "bin/run"]) as string[]).find((s) => existsSync(join(ws.path, s)));
		const started = await this.startProduct(api, rec);
		log += started.text;
		ok &&= started.ok;
		rec = { ...rec, bootLog: log, booted: true, state: "ready" };
		this.save(rec);
		return this.result(rec, outcome, ok);
	}

	private result(rec: QaVmRecord, outcome: ProvisionResult["outcome"], bootOk: boolean): ProvisionResult {
		return { envId: rec.envId, vmId: rec.vmId!, name: rec.name, attempt: rec.attempt, bootLog: rec.bootLog ?? "", bootOk, ...(rec.runScript ? { runScript: rec.runScript } : {}), outcome };
	}

	/** Start (or restart) the run script in the background; its output goes to ~/factory-run.log. */
	private async startProduct(api: BoatBackend, rec: QaVmRecord): Promise<{ ok: boolean; text: string }> {
		if (!rec.runScript) return { ok: false, text: "[no run script found]\n" };
		const logFile = posix.join(rec.home!, "factory-run.log");
		const pidFile = posix.join(rec.home!, ".factory-run.pid");
		const r = await this.retry("exec", () =>
			api.exec(
				rec.vmId!,
				`if [ -f ${shq(pidFile)} ]; then kill -- -$(cat ${shq(pidFile)}) 2>/dev/null || kill $(cat ${shq(pidFile)}) 2>/dev/null; fi; ` +
					`setsid nohup bash ${shq(rec.runScript!)} > ${shq(logFile)} 2>&1 < /dev/null & echo $! > ${shq(pidFile)}; sleep ${Math.max(0, this.bootWaitMs / 1000)}; ` +
					`if kill -0 $(cat ${shq(pidFile)}) 2>/dev/null; then echo __RUNNING; else echo __EXITED; fi; tail -c 4000 ${shq(logFile)}`,
				{ cwd: rec.appDir!, timeoutSeconds: 120 },
			),
		);
		const running = r.stdout.includes("__RUNNING");
		const out = r.stdout.replace(/__RUNNING\n?|__EXITED\n?/, "");
		return {
			ok: running,
			text: `$ bash ${rec.runScript} &   (in the background, output in ~/factory-run.log)\n${out}${r.stderr}\n${running ? "[run script is running]" : "[run script failed: it exited right away]"}\n`,
		};
	}

	/** The QA agent's environment: commands run in the VM, file readers read the VM's checkout; no writes. */
	env(input: { envId: string; cwd?: string; cacheDir?: string }): ExecutionEnv {
		const rec = this.record(input.envId);
		if (!rec?.vmId) throw new Error(`QA environment ${input.envId} has no VM`);
		return new BoatEnv(this, rec, input.cwd ?? rec.appDir ?? "/", join(this.stateDir, "cache", input.envId));
	}

	/** Used by BoatEnv: run a command in the VM; a VM the ttl stopped is resumed and the product restarted first. */
	async execIn(rec: QaVmRecord, command: string, opts: { cwd?: string; timeoutSeconds?: number }): Promise<{ exitCode: number; stdout: string; stderr: string; note?: string }> {
		const api = this.backend(rec.apiKeyRef);
		try {
			return await api.exec(rec.vmId!, command, opts);
		} catch (e) {
			const vm = await api.get(rec.vmId!).catch(() => undefined);
			if (!vm || !STOPPED_STATES.includes(vm.state)) throw e;
			await this.retry("resume", () => api.resume(rec.vmId!));
			await this.retry("wait for ready", () => api.waitReady(rec.vmId!, this.readyTimeoutMs));
			const started = await this.startProduct(api, rec);
			const r = await api.exec(rec.vmId!, command, opts);
			return { ...r, note: `[factory] The VM had been stopped (boat.ttl) and was resumed from its snapshot; the product was restarted.\n${started.text}\n` };
		}
	}
	readFileIn(rec: QaVmRecord, path: string): Promise<Uint8Array> {
		return this.backend(rec.apiKeyRef).readFile(rec.vmId!, path);
	}

	/** Permanently delete the round's VM (VM and snapshots). Idempotent. */
	async dispose(envId: string): Promise<void> {
		const rec = this.record(envId);
		if (!rec || rec.state === "disposed") return;
		if (rec.vmId) await this.retry("delete", () => this.backend(rec.apiKeyRef).delete(rec.vmId!));
		rm(join(this.stateDir, "cache", envId));
		this.save({ ...rec, state: "disposed" });
	}

	/** boat's usage call for the round's VM (machine time), for the qa role's cost record. */
	async usage(envId: string): Promise<{ seconds: number; dollars: number } | undefined> {
		const rec = this.record(envId);
		if (!rec?.vmId) return undefined;
		return this.backend(rec.apiKeyRef).usage(rec.vmId);
	}

	/**
	 * Startup sweep: delete every VM named `factory-<runId>-<seq>` (or `factory-<bundleId>-<seq>`) that `keep` does not claim (orphans of a crash or of a
	 * factory that was down while the ttl ran out). One pass per distinct key reference.
	 */
	async sweep(apiKeyRefs: string[], keep: (runId: string, seq: number) => boolean, log: (m: string) => void = () => {}): Promise<string[]> {
		const deleted: string[] = [];
		for (const ref of [...new Set(apiKeyRefs)]) {
			if (!resolveSecret(ref)) continue;
			const api = this.backend(ref);
			for (const vm of await api.list()) {
				const m = /^factory-(run-[a-z0-9]+-[a-z0-9]+|bundle-\d+)-(\d+)$/.exec(vm.name ?? "");
				if (!m || keep(m[1]!, Number(m[2]))) continue;
				await api.delete(vm.id).catch((e) => log(`sweep: deleting ${vm.name} failed: ${e}`));
				deleted.push(vm.name!);
				const envId = qaEnvId(m[1]!, Number(m[2]));
				const rec = this.record(envId);
				if (rec) this.save({ ...rec, state: "disposed" });
				log(`sweep: deleted orphan QA VM ${vm.name}`);
			}
		}
		return deleted;
	}

	/** doctor: boat's limits call with a key reference (`store:` refs resolve through `store`, else the default). */
	limits(apiKeyRef: string, store?: SecretStore): Promise<unknown> {
		return this.backend(apiKeyRef, store).limits();
	}
}

function rm(p: string) {
	rmSync(p, { recursive: true, force: true });
}

const denied = <T>(path: string): Result<T, FileError> => ({
	ok: false,
	error: new FileError("permission_denied", `QA VM: ${path} is read-only for the QA agent (it holds a throwaway copy of the reviewed build)`, path),
});

/**
 * ExecutionEnv over a boat VM. `exec` runs in the VM (boat's commands API). Reads fetch the file from the VM into a local
 * cache and read it from there, so the factory's read tool works unchanged; writes are refused.
 */
class BoatEnv implements ExecutionEnv {
	readonly id = "boat";
	private local: NodeExecutionEnv;
	constructor(
		private boat: Boat,
		private rec: QaVmRecord,
		public cwd: string,
		private cacheDir: string,
	) {
		mkdirSync(cacheDir, { recursive: true });
		this.local = new NodeExecutionEnv({ cwd: cacheDir });
	}
	private abs(p: string) {
		return posix.resolve(this.cwd, p);
	}
	private cachePath(p: string) {
		return join(this.cacheDir, this.abs(p));
	}
	private async fetch(p: string): Promise<Result<string, FileError>> {
		const abs = this.abs(p);
		try {
			const bytes = await this.boat.readFileIn(this.rec, abs);
			const local = this.cachePath(abs);
			mkdirSync(dirname(local), { recursive: true });
			writeFileSync(local, bytes);
			return { ok: true, value: local };
		} catch (e) {
			return { ok: false, error: new FileError(e instanceof BoatNotFound ? "not_found" : "unknown", `QA VM: cannot read ${abs}: ${e instanceof Error ? e.message : e}`, abs) };
		}
	}
	private async via<T>(p: string, f: (local: string) => Promise<Result<T, FileError>>): Promise<Result<T, FileError>> {
		const l = await this.fetch(p);
		return l.ok ? f(l.value) : l;
	}
	async absolutePath(p: string) {
		return { ok: true as const, value: this.abs(p) };
	}
	async joinPath(parts: string[]) {
		return { ok: true as const, value: posix.join(...parts) };
	}
	async canonicalPath(p: string) {
		return { ok: true as const, value: this.abs(p) };
	}
	readTextFile(p: string, c: Context) {
		return this.via(p, (l) => this.local.readTextFile(l, c));
	}
	openTextLineReader(p: string, c: Context) {
		return this.via(p, (l) => this.local.openTextLineReader(l, c));
	}
	readTextLines(p: string, o: { maxLines?: number } | undefined, c: Context) {
		return this.via(p, (l) => this.local.readTextLines(l, o, c));
	}
	readBinaryFile(p: string, c: Context) {
		return this.via(p, (l) => this.local.readBinaryFile(l, c));
	}
	openBinaryReader(p: string, o: { noFollow?: boolean } | undefined, c: Context) {
		return this.via(p, (l) => this.local.openBinaryReader(l, o, c));
	}
	async writeFile(p: string) {
		return denied<void>(p);
	}
	async appendFile(p: string) {
		return denied<void>(p);
	}
	async truncateFile(p: string) {
		return denied<void>(p);
	}
	async flushFile(p: string) {
		return denied<void>(p);
	}
	async renameFile(p: string) {
		return denied<void>(p);
	}
	async createDir(p: string) {
		return denied<void>(p);
	}
	async remove(p: string) {
		return denied<void>(p);
	}
	async createTempDir() {
		return denied<string>("tmp");
	}
	async createTempFile() {
		return denied<string>("tmp");
	}
	private async shell(cmd: string): Promise<{ exitCode: number; stdout: string }> {
		const r = await this.boat.execIn(this.rec, cmd, { cwd: this.cwd, timeoutSeconds: 60 });
		return { exitCode: r.exitCode, stdout: r.stdout };
	}
	async exists(p: string) {
		const r = await this.shell(`test -e ${shq(this.abs(p))} && echo yes || echo no`).catch(() => ({ exitCode: 1, stdout: "no" }));
		return { ok: true as const, value: r.stdout.trim() === "yes" };
	}
	async fileInfo(p: string) {
		const abs = this.abs(p);
		const r = await this.shell(`stat -c '%F|%s|%Y' ${shq(abs)}`).catch(() => ({ exitCode: 1, stdout: "" }));
		if (r.exitCode !== 0) return { ok: false as const, error: new FileError("not_found", `QA VM: ${abs} not found`, abs) };
		const [kind, size, mtime] = r.stdout.trim().split("|");
		return {
			ok: true as const,
			value: { name: posix.basename(abs), path: abs, kind: (/directory/.test(kind ?? "") ? "directory" : /link/.test(kind ?? "") ? "symlink" : "file") as any, size: Number(size), mtimeMs: Number(mtime) * 1000 },
		};
	}
	async listDir(p: string) {
		const abs = this.abs(p);
		const r = await this.shell(`cd ${shq(abs)} && for f in * .[!.]*; do [ -e "$f" ] || continue; stat -c '%n|%F|%s|%Y' -- "$f"; done`).catch(() => ({ exitCode: 1, stdout: "" }));
		if (r.exitCode !== 0) return { ok: false as const, error: new FileError("not_found", `QA VM: ${abs} not found`, abs) };
		return {
			ok: true as const,
			value: r.stdout
				.split("\n")
				.filter(Boolean)
				.map((l) => {
					const [name, kind, size, mtime] = l.split("|");
					return { name: name!, path: posix.join(abs, name!), kind: (/directory/.test(kind ?? "") ? "directory" : "file") as any, size: Number(size), mtimeMs: Number(mtime) * 1000 };
				}),
		};
	}
	async openDirReader(p: string) {
		const list = await this.listDir(p);
		if (!list.ok) return list;
		let done = false;
		return {
			ok: true as const,
			value: {
				async next() {
					const entries = done ? [] : list.value;
					done = true;
					return { ok: true as const, value: { entries, done: true } };
				},
				async close() {},
			},
		};
	}
	async watch(_t: any, _on: any) {
		return { ok: false as const, error: new FileError("not_supported", "QA VM: watching files is not supported") };
	}

	async exec(command: string | readonly string[], options: ShellExecOptions | undefined, context: Context): Promise<Result<ShellExecResult, ExecutionError>> {
		const cmd = typeof command === "string" ? command : command.map(shq).join(" ");
		try {
			const r = await this.boat.execIn(this.rec, cmd, { cwd: options?.cwd ?? this.cwd, ...(options?.timeout ? { timeoutSeconds: options.timeout } : {}) });
			if (r.note) options?.onOutput?.(r.note, context, { stream: "stdout" });
			if (r.stdout) options?.onOutput?.(r.stdout, context, { stream: "stdout" });
			if (r.stderr) options?.onOutput?.(r.stderr, context, { stream: "stderr" });
			return { ok: true, value: { exitCode: r.exitCode } };
		} catch (e) {
			return { ok: false, error: new ExecutionError("spawn_error", `QA VM: ${e instanceof Error ? e.message : e}`) };
		}
	}
	async cleanup() {}
}
