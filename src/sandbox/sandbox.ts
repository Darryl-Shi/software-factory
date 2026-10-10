// Sandbox (spec §3.3, §7): every role works in the run's git worktree; every command it
// executes runs inside Anthropic's sandbox runtime (@anthropic-ai/sandbox-runtime, used as a library). In-process file
// tools are not processes, so the ExecutionEnv applies the same path rules to their readers and writers.
// Write access is fixed by role: only the builder and its helpers (which run in the builder's environment) may write the
// worktree (and its git dirs); the architect and reviewer may write only their scratch dir. The QA agent works in a
// boat.dev VM instead (src/boat). The core's credentials (GitHub token, boat API key) are denied to every command.
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type ExecutionEnv, ExecutionError, FileError, type Result, type ShellExecOptions, type ShellExecResult } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { DEFAULT_DENY_READ, expandHome, type Obj } from "../core/settings.ts";
import type { Role, RunCtx, Workspace } from "../core/types.ts";
import { gitOut } from "../github/git.ts";

export const CREDENTIAL_ENV_VARS = ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "FACTORY_GIT_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "AWS_SECRET_ACCESS_KEY", "BOAT_API_KEY", "PARALLEL_API_KEY"];

/** The env vars and files the run's credential references name (GitHub identity, boat API key): denied in the sandbox. */
export function credentialLocations(config: Record<string, any>): { envVars: string[]; files: string[] } {
	const refs = [config.github?.identity?.tokenRef, config.github?.identity?.privateKeyRef, config.boat?.apiKey, config.webSearch?.apiKey].filter((r): r is string => typeof r === "string");
	const envVars = refs.filter((r) => r.startsWith("env:")).map((r) => r.slice(4));
	const files = refs.filter((r) => r.startsWith("file:")).map((r) => expandHome(r.slice(5)));
	return { envVars: [...new Set([...CREDENTIAL_ENV_VARS, ...envVars])], files };
}

type EnvRecord = {
	envId: string;
	role: Role;
	worktree: string;
	cwd: string;
	gitCommonDir?: string;
	scratch: string;
	sandbox: { enabled: boolean; allowedDomains: string[]; deniedDomains: string[]; denyRead: string[]; extraWrite: string[]; unixSockets: string };
	setup?: { script: string; exitCode: number };
	/** Credential env vars and key files named by the run's config (missing on records written before). */
	credentials?: { envVars: string[]; files: string[] };
};

const shellQuote = (argv: readonly string[]) => argv.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(" ");
const within = (p: string, root: string) => p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);

function real(p: string): string {
	// realpath of the nearest existing ancestor + the rest, so symlinks cannot smuggle a write out of a root.
	let cur = p;
	const rest: string[] = [];
	while (!existsSync(cur) && dirname(cur) !== cur) {
		rest.unshift(cur.slice(dirname(cur).length + 1));
		cur = dirname(cur);
	}
	try {
		return join(realpathSync(cur), ...rest);
	} catch {
		return p;
	}
}

class SandboxedEnv implements ExecutionEnv {
	readonly id = "node:local";
	private inner: NodeExecutionEnv;
	constructor(
		private rec: EnvRecord,
		cwd: string,
		private writeRoots: string[],
		private denyWrite: string[],
		private denyRead: string[],
		private shellEnv: Record<string, string>,
		private wrap: (cmd: string, signal?: AbortSignal) => Promise<string>,
	) {
		this.inner = new NodeExecutionEnv({ cwd, shellEnv });
	}
	get cwd() {
		return this.inner.cwd;
	}
	set cwd(v: string) {
		this.inner.cwd = v;
	}
	private abs(p: string) {
		return real(isAbsolute(p) ? p : resolve(this.inner.cwd, p));
	}
	private readErr<T>(path: string): Result<T, FileError> | undefined {
		const a = this.abs(path);
		if (this.denyRead.some((d) => within(a, d))) return { ok: false, error: new FileError("permission_denied" as any, `sandbox: reading ${path} is denied`, path) };
		return undefined;
	}
	private writeErr<T>(path: string): Result<T, FileError> | undefined {
		const a = this.abs(path);
		const allowed = this.writeRoots.some((r) => within(a, r)) && !this.denyWrite.some((d) => within(a, d));
		if (!allowed)
			return {
				ok: false,
				error: new FileError("permission_denied" as any, `sandbox: writing ${path} is denied for the ${this.rec.role} role${this.rec.role === "builder" ? "" : " (read-only role)"}`, path),
			};
		return undefined;
	}

	absolutePath(p: string, c: Context) { return this.inner.absolutePath(p, c); }
	joinPath(parts: string[], c: Context) { return this.inner.joinPath(parts, c); }
	readTextFile(p: string, c: Context) { return Promise.resolve(this.readErr<string>(p) ?? this.inner.readTextFile(p, c)); }
	openTextLineReader(p: string, c: Context) { return Promise.resolve(this.readErr<any>(p) ?? this.inner.openTextLineReader(p, c)); }
	readTextLines(p: string, o: { maxLines?: number } | undefined, c: Context) { return Promise.resolve(this.readErr<string[]>(p) ?? this.inner.readTextLines(p, o, c)); }
	readBinaryFile(p: string, c: Context) { return Promise.resolve(this.readErr<Uint8Array>(p) ?? this.inner.readBinaryFile(p, c)); }
	openBinaryReader(p: string, o: { noFollow?: boolean } | undefined, c: Context) { return Promise.resolve(this.readErr<any>(p) ?? this.inner.openBinaryReader(p, o, c)); }
	writeFile(p: string, content: string | Uint8Array, c: Context) { return Promise.resolve(this.writeErr<void>(p) ?? this.inner.writeFile(p, content, c)); }
	appendFile(p: string, content: string | Uint8Array, c: Context) { return Promise.resolve(this.writeErr<void>(p) ?? this.inner.appendFile(p, content, c)); }
	truncateFile(p: string, size: number, c: Context) { return Promise.resolve(this.writeErr<void>(p) ?? this.inner.truncateFile(p, size, c)); }
	flushFile(p: string, c: Context) { return Promise.resolve(this.writeErr<void>(p) ?? this.inner.flushFile(p, c)); }
	renameFile(a: string, b: string, c: Context) { return Promise.resolve(this.writeErr<void>(a) ?? this.writeErr<void>(b) ?? this.inner.renameFile(a, b, c)); }
	fileInfo(p: string, c: Context) { return Promise.resolve(this.readErr<any>(p) ?? this.inner.fileInfo(p, c)); }
	listDir(p: string, c: Context) { return Promise.resolve(this.readErr<any>(p) ?? this.inner.listDir(p, c)); }
	openDirReader(p: string, c: Context) { return Promise.resolve(this.readErr<any>(p) ?? this.inner.openDirReader(p, c)); }
	watch(t: any, on: any, c: Context) { return this.inner.watch(t, on, c); }
	canonicalPath(p: string, c: Context) { return this.inner.canonicalPath(p, c); }
	exists(p: string, c: Context) { return Promise.resolve(this.readErr<boolean>(p) ?? this.inner.exists(p, c)); }
	createDir(p: string, o: { recursive?: boolean } | undefined, c: Context) { return Promise.resolve(this.writeErr<void>(p) ?? this.inner.createDir(p, o, c)); }
	remove(p: string, o: { recursive?: boolean; force?: boolean } | undefined, c: Context) { return Promise.resolve(this.writeErr<void>(p) ?? this.inner.remove(p, o, c)); }
	async createTempDir(prefix: string | undefined, c: Context) {
		const dir = join(this.rec.scratch, "tmp", `${prefix ?? "tmp"}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`);
		mkdirSync(dir, { recursive: true });
		return { ok: true as const, value: dir };
	}
	async createTempFile(o: { prefix?: string; suffix?: string } | undefined, c: Context) {
		const dir = join(this.rec.scratch, "tmp");
		mkdirSync(dir, { recursive: true });
		const f = join(dir, `${o?.prefix ?? "f"}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}${o?.suffix ?? ""}`);
		writeFileSync(f, "");
		return { ok: true as const, value: f };
	}

	async exec(command: string | readonly string[], options: ShellExecOptions | undefined, context: Context): Promise<Result<ShellExecResult, ExecutionError>> {
		const cmd = typeof command === "string" ? command : shellQuote(command);
		let wrapped: string;
		try {
			wrapped = await this.wrap(cmd, context.abortSignal);
		} catch (e) {
			return { ok: false, error: new ExecutionError("spawn_error", `sandbox: ${e instanceof Error ? e.message : e}`) };
		}
		// Never inherit the factory process's environment (it may hold credentials).
		return this.inner.exec(wrapped, { ...options, inheritEnv: false, env: { ...this.shellEnv, ...(options?.env ?? {}) } }, context);
	}
	cleanup(c: Context) {
		return this.inner.cleanup(c);
	}
}

/** Rules on the `sandbox` settings section (core write limits, §3.3); problems are relative to the section. */
export function sandboxProblems(sandbox: Obj): string[] {
	const problems: string[] = [];
	// extraWrite may never widen into secrets, home or the filesystem root.
	const home = homedir();
	const deny = [...(sandbox?.denyRead ?? DEFAULT_DENY_READ), "~/.factory", "~/.ssh"].map(expandHome);
	for (const w of (sandbox?.extraWrite ?? []) as string[]) {
		const p = resolve(expandHome(w));
		if (p === "/" || p === home || within(home, p)) problems.push(`extraWrite: ${w} would make the home directory or the filesystem root writable`);
		else if (deny.some((d) => within(p, d) || within(d, p))) problems.push(`extraWrite: ${w} overlaps a denied secret path`);
	}
	return problems;
}

export class Sandbox {
	// Environment records live with the factory's own state (hidden from agents by denyRead ~/.factory).
	private readonly stateDir: string;
	private readonly records = new Map<string, EnvRecord>();
	private initialized = false;
	private unixSocketMode: "block" | "allow" | undefined;
	private readonly network = new Map<string, { allowed: string[]; denied: string[] }>(); // per live env
	private initPromise: Promise<void> | undefined;

	constructor(opts: { stateDir: string }) {
		this.stateDir = expandHome(opts.stateDir);
	}

	private recordPath(envId: string) {
		return join(this.stateDir, `${envId}.json`);
	}

	private load(envId: string): EnvRecord {
		let r = this.records.get(envId);
		if (!r) {
			const p = this.recordPath(envId);
			if (!existsSync(p)) throw new Error(`unknown environment ${envId}`);
			r = JSON.parse(readFileSync(p, "utf8")) as EnvRecord;
			this.records.set(envId, r);
		}
		return r;
	}

	private networkConfig() {
		const allowed = new Set<string>();
		const denied = new Set<string>();
		for (const n of this.network.values()) {
			n.allowed.forEach((d) => allowed.add(d));
			n.denied.forEach((d) => denied.add(d));
		}
		return { allowedDomains: [...allowed].filter((d) => !denied.has(d)), deniedDomains: [...denied], ...(this.unixSocketMode === "allow" ? { allowAllUnixSockets: true } : {}) };
	}

	private async ensureSandbox(rec: EnvRecord) {
		this.network.set(rec.envId, { allowed: rec.sandbox.allowedDomains, denied: rec.sandbox.deniedDomains });
		if (!this.initialized) {
			this.initPromise ??= (async () => {
				const deps = SandboxManager.checkDependencies();
				if (deps.errors.length) throw new Error(`sandbox runtime unavailable: ${deps.errors.join("; ")}`);
				const fsBase = { denyRead: [], allowWrite: [], denyWrite: [] };
				const want = rec.sandbox.unixSockets;
				this.unixSocketMode = want === "allow" ? "allow" : "block";
				await SandboxManager.initialize({ network: this.networkConfig(), filesystem: fsBase } as any);
				if (want === "auto" && process.platform === "linux") {
					// Ubuntu 24.04+ restricts unprivileged user namespaces; the seccomp layer then cannot start.
					const probe = await SandboxManager.wrapWithSandbox("true");
					const { spawnSync } = await import("node:child_process");
					const r = spawnSync("bash", ["-c", probe], { encoding: "utf8" });
					if (r.status !== 0 && /setgroups|CAP_SYS_ADMIN|nested userns/i.test(r.stderr)) {
						this.unixSocketMode = "allow";
						SandboxManager.updateConfig({ network: this.networkConfig(), filesystem: fsBase } as any);
					}
				}
				this.initialized = true;
			})();
			await this.initPromise;
		} else SandboxManager.updateConfig({ ...(SandboxManager.getConfig() as any), network: this.networkConfig() });
	}

	private policy(rec: EnvRecord) {
		const deny = [...rec.sandbox.denyRead.map(expandHome), ...(rec.credentials?.files ?? [])].map((p) => real(p));
		const builder = rec.role === "builder";
		const writeRoots = [rec.scratch, ...(builder ? [rec.worktree, ...(rec.gitCommonDir ? [rec.gitCommonDir] : []), ...rec.sandbox.extraWrite.map(expandHome)] : [])].map(real);
		const denyWrite = builder && rec.gitCommonDir ? [join(rec.gitCommonDir, "hooks"), join(rec.gitCommonDir, "config")].map(real) : [];
		const shellEnv: Record<string, string> = {
			PATH: process.env.PATH ?? "/usr/bin:/bin",
			HOME: join(rec.scratch, "home"),
			TMPDIR: join(rec.scratch, "tmp"),
			XDG_CACHE_HOME: join(rec.scratch, "cache"),
			npm_config_cache: join(rec.scratch, "npm-cache"),
			PIP_CACHE_DIR: join(rec.scratch, "pip-cache"),
			GOCACHE: join(rec.scratch, "go-cache"),
			LANG: process.env.LANG ?? "C.UTF-8",
			TERM: "dumb",
			GIT_AUTHOR_NAME: `factory-${rec.role}`,
			GIT_AUTHOR_EMAIL: `${rec.role}@factory.local`,
			GIT_COMMITTER_NAME: `factory-${rec.role}`,
			GIT_COMMITTER_EMAIL: `${rec.role}@factory.local`,
			GIT_CONFIG_NOSYSTEM: "1",
		};
		for (const d of ["home", "tmp", "cache", "npm-cache"]) mkdirSync(join(rec.scratch, d), { recursive: true });
		const fsConfig = {
			denyRead: deny,
			allowWrite: writeRoots,
			denyWrite,
		};
		const wrap = async (cmd: string, signal?: AbortSignal) => {
			if (!rec.sandbox.enabled) return cmd;
			await this.ensureSandbox(rec);
			// srt points TMPDIR at its shared /tmp/claude; point it back at this environment's scratch dir.
			const inner = `export TMPDIR=${shellQuote([shellEnv.TMPDIR!])}\n${cmd}`;
			return SandboxManager.wrapWithSandbox(
				inner,
				undefined,
				{
					filesystem: fsConfig,
					credentials: { envVars: (rec.credentials?.envVars ?? CREDENTIAL_ENV_VARS).map((name) => ({ name, mode: "deny" as const })) },
				} as any,
				signal,
			);
		};
		return { deny, writeRoots, denyWrite, shellEnv, wrap };
	}

	status(): { initialized: boolean; unixSockets?: string } {
		return { initialized: this.initialized, ...(this.unixSocketMode ? { unixSockets: this.unixSocketMode } : {}) };
	}

	/** Reads the run's pinned `workdir` (scratch root) and `sandbox.*` (including `setupScripts`). */
	async provision(ws: Workspace, role: Role, rc: RunCtx): Promise<{ envId: string; cwd: string }> {
		const root = expandHome(rc.config.workdir ?? "~/factory/work");
		const envId = `${rc.runId}-${role}`;
		const existing = existsSync(this.recordPath(envId)) ? this.load(envId) : undefined;
		if (existing) return { envId, cwd: existing.cwd };
		const sb = rc.config.sandbox ?? {};
		const rec: EnvRecord = {
			envId,
			role,
			worktree: ws.path,
			cwd: ws.path,
			scratch: join(root, "scratch", envId),
			sandbox: {
				enabled: sb.enabled !== false,
				allowedDomains: sb.allowedDomains ?? [],
				deniedDomains: sb.deniedDomains ?? [],
				denyRead: sb.denyRead ?? DEFAULT_DENY_READ,
				extraWrite: sb.extraWrite ?? [],
				unixSockets: sb.unixSockets ?? "auto",
			},
			credentials: credentialLocations(rc.config),
		};
		const common = await gitOut(ws.path, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).catch(() => "");
		if (common) rec.gitCommonDir = common;
		mkdirSync(rec.scratch, { recursive: true });
		if (role === "builder") {
			const script = ((sb.setupScripts ?? []) as string[]).find((s) => existsSync(join(ws.path, s)));
			if (script) {
				const p = this.policy(rec);
				const env = new SandboxedEnv(rec, ws.path, p.writeRoots, p.denyWrite, p.deny, p.shellEnv, p.wrap);
				let log = "";
				const r = await env.exec(`bash ${shellQuote([script])}`, { timeout: 900, onOutput: (t) => (log += t) }, BACKGROUND_CONTEXT);
				rec.setup = { script, exitCode: r.ok ? r.value.exitCode : -1 };
				writeFileSync(join(rec.scratch, "setup.log"), log);
			}
		}
		mkdirSync(dirname(this.recordPath(envId)), { recursive: true });
		writeFileSync(this.recordPath(envId), JSON.stringify(rec, null, 2));
		this.records.set(envId, rec);
		return { envId, cwd: rec.cwd };
	}

	env(input: { conversationId: string; cwd?: string; envId: string }): ExecutionEnv {
		const rec = this.load(input.envId);
		const p = this.policy(rec);
		return new SandboxedEnv(rec, input.cwd ?? rec.cwd, p.writeRoots, p.denyWrite, p.deny, p.shellEnv, p.wrap);
	}

	async dispose(envId: string): Promise<void> {
		this.network.delete(envId);
		this.records.delete(envId);
		// The worktree stays for inspection; only the environment record is retired.
		const p = this.recordPath(envId);
		if (existsSync(p)) writeFileSync(p, JSON.stringify({ ...JSON.parse(readFileSync(p, "utf8")), disposed: true }, null, 2));
	}
}
