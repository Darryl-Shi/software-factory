// The updater (spec: updates): the factory updates itself to the tip of its own checkout's upstream branch.
// A service wired in src/main.ts and exposed by the web server (/api/version, /api/update/*), not a core operation.
// It checks (git fetch, then HEAD vs @{u}), applies (fast-forward, npm ci when the lockfile changed) and hands the
// restart to a detached helper (helper.ts) that waits for the new version and rolls back if it doesn't come up.
import { spawn } from "node:child_process";
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FactoryError } from "../core/types.ts";
import { GIT_ENV, type HelperJob, logLine, npmCi, resetCheckout, short } from "./helper.ts";
import { ACTIVE_PHASES, clearRecord, readRecord, type UpdateRecord, writeRecord } from "./record.ts";
import { type Runner, runCommand, type StartedBy } from "./restart.ts";

export interface UpdateCheck {
	behind: number;
	ahead: number;
	dirty: boolean;
	/** The upstream branch, e.g. `origin/main`. */
	upstream: string;
	/** The upstream's short SHA; `upstreamFullSha` the full one. */
	upstreamSha: string;
	upstreamFullSha: string;
	/** Subjects of the incoming commits (HEAD..@{u}), newest first, at most 50. */
	commits: string[];
	checkedAt: number;
	/** The fetch failed (no network, auth): the comparison is against the last fetched upstream. */
	error?: string;
}

export interface ActiveWork {
	kind: "run" | "bundle" | "discussion";
	id: string;
	project: string;
	title: string;
	state: string;
}

export interface VersionInfo {
	version: string;
	/** The running commit's short SHA (undefined when not a git checkout); `fullSha` the full one. */
	sha?: string;
	fullSha?: string;
	date?: string;
	updatable: boolean;
	reason?: string;
	check?: UpdateCheck;
	update?: UpdateRecord;
	startedBy: StartedBy;
	/** Runs, bundles and discussions working now (they resume after a restart). */
	active: ActiveWork[];
}

export interface UpdaterOptions {
	/** The install root: the directory that holds src/ (a git checkout, normally of Darryl-Shi/software-factory). */
	root: string;
	/** The factory home (update.json, factory.log, web-url); `configPath` is the config file in it. */
	home: string;
	configPath: string;
	startedBy: StartedBy;
	serveArgs?: string[];
	run?: Runner;
	log?: (m: string) => void;
	/** The active work, for the confirm dialog. */
	activeWork?: () => Promise<ActiveWork[]>;
	/** Starts the restart helper (default: a detached process; tests stub it). */
	spawnHelper?: (job: HelperJob) => void;
	/** How long the helper waits for the new version (default 90 s). */
	restartTimeoutMs?: number;
	now?: () => number;
}

const MAX_COMMITS = 50;
const FIRST_CHECK_MS = 30_000;
const CHECK_EVERY_MS = 6 * 60 * 60_000;
/** A record left in `restarting` this long ago is finished at startup (its helper is gone). */
const STALE_RESTART_MS = 5 * 60_000;
const HELPER_FILES = ["helper.ts", "restart.ts", "record.ts"];

const firstLine = (s: string) => s.trim().split("\n").filter(Boolean)[0] ?? "";

export class Updater {
	readonly root: string;
	readonly home: string;
	readonly startedBy: StartedBy;
	private readonly o: UpdaterOptions;
	private readonly run: Runner;
	private readonly log: (m: string) => void;
	private readonly now: () => number;
	private running: { version: string; fullSha?: string; date?: string } = { version: "0.0.0" };
	private lastCheck?: UpdateCheck;
	private checking?: Promise<UpdateCheck>;
	private applying = false;
	private pipeline?: Promise<void>;
	private timers: NodeJS.Timeout[] = [];
	/** The helper's sources, read at startup: the restart runs the version that started the update. */
	private helperSources = new Map<string, string>();

	constructor(o: UpdaterOptions) {
		this.o = o;
		this.root = o.root;
		this.home = o.home;
		this.startedBy = o.startedBy;
		this.run = o.run ?? runCommand;
		this.log = o.log ?? (() => {});
		this.now = o.now ?? Date.now;
	}

	private git(args: string[], timeoutMs = 60_000) {
		return this.run("git", args, { cwd: this.root, env: GIT_ENV, timeoutMs });
	}

	private async gitOut(args: string[]): Promise<string | undefined> {
		const r = await this.git(args);
		return r.code === 0 ? r.stdout.trim() : undefined;
	}

	/** Reads the running version, snapshots the helper and settles an update.json the last process left. */
	async init(): Promise<void> {
		let version = "0.0.0";
		try {
			version = String(JSON.parse(readFileSync(join(this.root, "package.json"), "utf8")).version ?? version);
		} catch {}
		this.running = { version };
		if ((await this.gitOut(["rev-parse", "--is-inside-work-tree"])) === "true") {
			const out = await this.gitOut(["log", "-1", "--format=%H%n%cI"]);
			if (out) {
				const [sha, date] = out.split("\n");
				this.running = { version, fullSha: sha, date };
			}
		}
		for (const f of HELPER_FILES) {
			try {
				this.helperSources.set(f, readFileSync(join(import.meta.dirname, f), "utf8"));
			} catch {}
		}
		const r = readRecord(this.home);
		if (r && ACTIVE_PHASES.includes(r.phase)) {
			const at = r.restartAt ?? r.startedAt;
			if (r.phase !== "restarting" || this.now() - at > STALE_RESTART_MS) {
				const ok = this.running.fullSha === r.to;
				writeRecord(this.home, {
					...r,
					phase: ok && r.phase === "restarting" ? "done" : "failed",
					...(ok && r.phase === "restarting" ? {} : { error: `the factory stopped during the update (${r.phase})` }),
					finishedAt: this.now(),
				});
			}
		}
	}

	/** The first check shortly after startup, then every 6 hours. */
	startChecks(firstMs = FIRST_CHECK_MS, everyMs = CHECK_EVERY_MS): void {
		const tick = () => {
			this.check().catch(() => {});
		};
		const t = setTimeout(() => {
			tick();
			const i = setInterval(tick, everyMs);
			i.unref();
			this.timers.push(i);
		}, firstMs);
		t.unref();
		this.timers.push(t);
	}

	stop(): void {
		for (const t of this.timers) clearTimeout(t);
		this.timers = [];
	}

	/** Why the checkout can't be updated (not a git checkout, detached HEAD, no upstream), or undefined. */
	async unavailable(): Promise<string | undefined> {
		if ((await this.gitOut(["rev-parse", "--is-inside-work-tree"])) !== "true") return "not a git checkout";
		if ((await this.git(["symbolic-ref", "-q", "HEAD"])).code !== 0) return "detached HEAD";
		if ((await this.git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])).code !== 0) return "no upstream branch";
		return undefined;
	}

	async version(): Promise<VersionInfo> {
		const reason = await this.unavailable();
		const update = readRecord(this.home);
		const active = this.o.activeWork ? await this.o.activeWork().catch(() => []) : [];
		return {
			version: this.running.version,
			...(this.running.fullSha ? { sha: short(this.running.fullSha), fullSha: this.running.fullSha, date: this.running.date } : {}),
			updatable: reason === undefined,
			...(reason ? { reason } : {}),
			...(this.lastCheck && !reason ? { check: this.lastCheck } : {}),
			...(update ? { update } : {}),
			startedBy: this.startedBy,
			active,
		};
	}

	/** git fetch of the upstream remote, then HEAD vs @{u}. One check at a time; a concurrent call shares it. */
	check(): Promise<UpdateCheck> {
		this.checking ??= this.doCheck().finally(() => (this.checking = undefined));
		return this.checking;
	}

	private async doCheck(): Promise<UpdateCheck> {
		const reason = await this.unavailable();
		if (reason) throw new FactoryError("invalid", `Updates unavailable: ${reason}`);
		const branch = (await this.gitOut(["symbolic-ref", "--short", "HEAD"]))!;
		const upstream = (await this.gitOut(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]))!;
		const remote = (await this.gitOut(["config", `branch.${branch}.remote`])) ?? "origin";
		let error: string | undefined;
		if (remote !== ".") {
			const f = await this.git(["fetch", "--quiet", "--no-tags", remote], 120_000);
			if (f.code !== 0) {
				error = firstLine(f.stderr || f.stdout) || `git fetch ${remote} failed (exit ${f.code})`;
				this.log(`update check: git fetch ${remote} failed: ${error}`);
			}
		}
		const counts = (await this.gitOut(["rev-list", "--left-right", "--count", "HEAD...@{u}"])) ?? "0\t0";
		const [ahead, behind] = counts.split(/\s+/).map(Number) as [number, number];
		const upstreamFullSha = (await this.gitOut(["rev-parse", "@{u}"])) ?? "";
		const log = behind > 0 ? ((await this.gitOut(["log", `--max-count=${MAX_COMMITS}`, "--format=%s", "HEAD..@{u}"])) ?? "") : "";
		const dirty = (await this.git(["status", "--porcelain", "--untracked-files=no"])).stdout.trim() !== "";
		const check: UpdateCheck = {
			behind,
			ahead,
			dirty,
			upstream,
			upstreamSha: short(upstreamFullSha),
			upstreamFullSha,
			commits: log ? log.split("\n") : [],
			checkedAt: this.now(),
			...(error ? { error } : {}),
		};
		this.lastCheck = check;
		return check;
	}

	/** Why `check` blocks an update, or undefined. */
	static blocker(check: UpdateCheck): string | undefined {
		if (check.dirty) return "local changes in tracked files";
		if (check.ahead > 0) return `local commits not on ${check.upstream}`;
		if (check.behind === 0) return "already up to date";
		return undefined;
	}

	/** The running update's pipeline (tests and the CLI wait on it); resolves at once when none runs. */
	settled(): Promise<void> {
		return this.pipeline ?? Promise.resolve();
	}

	/** Starts the update to `sha` (the latest check's upstream SHA). Refusals: `conflict` for an update already
	 * running or a stale SHA, `invalid` for a precondition. Resolves once the update is recorded; the pull, install
	 * and restart go on in the background (update.json carries the phase). */
	async apply(sha: unknown): Promise<UpdateRecord> {
		if (typeof sha !== "string" || !/^[0-9a-f]{4,40}$/.test(sha)) throw new FactoryError("invalid", "sha: expected the upstream commit SHA to update to");
		const current = readRecord(this.home);
		const inFlight =
			current &&
			ACTIVE_PHASES.includes(current.phase) &&
			!(current.phase === "restarting" && this.now() - (current.restartAt ?? current.startedAt) > STALE_RESTART_MS);
		if (this.applying || inFlight) throw new FactoryError("conflict", "an update is already running");
		this.applying = true;
		try {
			const known = this.lastCheck;
			const matches = !!known && (sha === known.upstreamSha || (sha.length >= 7 && known.upstreamFullSha.startsWith(sha)));
			if (!known || !matches)
				throw new FactoryError("conflict", `${sha} is not the upstream version of the latest check; check again`);
			const check = await this.check(); // the preconditions, again, right before applying
			if (check.upstreamFullSha !== known.upstreamFullSha)
				throw new FactoryError("conflict", `the upstream moved to ${check.upstreamSha} since the check; check again`);
			const blocker = Updater.blocker(check);
			if (blocker) throw new FactoryError("invalid", blocker);
			const from = (await this.gitOut(["rev-parse", "HEAD"]))!;
			const to = check.upstreamFullSha;
			const record: UpdateRecord = { from, to, startedAt: this.now(), phase: "pulling", startedBy: this.startedBy };
			writeRecord(this.home, record);
			this.log(`update: applying ${short(from)} → ${short(to)} (${check.behind} commit${check.behind === 1 ? "" : "s"}, started by ${this.startedBy})`);
			this.pipeline = this.pull(record).finally(() => {
				this.applying = false;
			});
			return { ...record };
		} catch (e) {
			this.applying = false;
			throw e;
		}
	}

	private set(r: UpdateRecord, patch: Partial<UpdateRecord>): UpdateRecord {
		Object.assign(r, patch);
		writeRecord(this.home, r);
		return r;
	}

	private async pull(r: UpdateRecord): Promise<void> {
		const { from, to } = r;
		const fail = (error: string) => {
			this.set(r, { phase: "failed", error, finishedAt: this.now() });
			this.log(`update ${short(from)} → ${short(to)} failed: ${firstLine(error)}`);
		};
		const m = await this.git(["merge", "--ff-only", "--quiet", to]);
		if (m.code !== 0) return fail(`git merge --ff-only ${short(to)} failed: ${(m.stderr || m.stdout).trim()}`);
		const diff = await this.git(["diff", "--name-only", from, to, "--", "package-lock.json", "package.json"]);
		const lockChanged = diff.code !== 0 || diff.stdout.trim() !== "";
		this.set(r, { lockChanged });
		if (lockChanged) {
			this.set(r, { phase: "installing" });
			try {
				await npmCi(this.root, this.run);
			} catch (e) {
				const error = e instanceof Error ? e.message : String(e);
				try {
					await resetCheckout(this.root, from, true, this.run);
				} catch (e2) {
					return fail(`${error}\n\nThe rollback to ${short(from)} failed too: ${e2 instanceof Error ? e2.message : e2}`);
				}
				return fail(`${error}\n\nThe checkout is back on ${short(from)}.`);
			}
		}
		if (this.startedBy === "foreground") {
			this.set(r, { phase: "done", restartRequired: true, message: "Restart the factory to finish the update", finishedAt: this.now() });
			this.log(`update: pulled ${short(to)}; restart the factory to finish the update`);
			return;
		}
		this.set(r, { phase: "restarting", restartAt: this.now() });
		const job: HelperJob = {
			root: this.root,
			home: this.home,
			configPath: this.o.configPath,
			from,
			to,
			lockChanged,
			startedBy: this.startedBy,
			serveArgs: this.o.serveArgs ?? [],
			logFile: join(this.home, "factory.log"),
			timeoutMs: this.o.restartTimeoutMs ?? 90_000,
			...(process.env.PATH ? { path: process.env.PATH } : {}),
		};
		try {
			(this.o.spawnHelper ?? ((j) => this.spawnHelper(j)))(job);
		} catch (e) {
			const error = `could not start the restart helper: ${e instanceof Error ? e.message : e}`;
			try {
				await resetCheckout(this.root, from, lockChanged, this.run);
			} catch {}
			return fail(error);
		}
	}

	/** Writes the helper (the running version's sources) and its job under <home>/update-helper/ and starts it
	 * detached, outside the factory: its own process group, or a transient systemd unit (a unit's restart kills its
	 * whole control group). */
	private spawnHelper(job: HelperJob): void {
		const dir = join(this.home, "update-helper");
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		for (const f of HELPER_FILES) {
			const src = this.helperSources.get(f);
			if (src !== undefined) writeFileSync(join(dir, f), src);
			else copyFileSync(join(import.meta.dirname, f), join(dir, f));
		}
		const jobFile = join(dir, "job.json");
		writeFileSync(jobFile, JSON.stringify(job, null, 2), { mode: 0o600 });
		const tsx = join(this.root, "node_modules", "tsx", "dist", "esm", "index.mjs");
		if (!existsSync(tsx)) throw new Error(`${tsx} is missing`);
		const node = [process.execPath, "--import", tsx, "--no-warnings", join(dir, "helper.ts"), jobFile];
		const [cmd, args] =
			this.startedBy === "systemd"
				? ["systemd-run", ["--user", "--collect", "--quiet", `--unit=software-factory-update-${this.now()}`, `--setenv=PATH=${process.env.PATH ?? ""}`, ...node]]
				: [node[0]!, node.slice(1)];
		const out = openSync(job.logFile, "a", 0o600);
		try {
			const env = { ...process.env };
			delete env.FACTORY_DAEMON_ARGS;
			const child = spawn(cmd as string, args as string[], { detached: true, stdio: ["ignore", out, out], cwd: this.home, env });
			child.on("error", (e) => logLine(job.logFile, `restart helper: ${e.message}`));
			child.unref();
		} finally {
			closeSync(out);
		}
	}

	/** Clears the last update's report (not while an update runs). */
	dismiss(): void {
		const r = readRecord(this.home);
		if (r && ACTIVE_PHASES.includes(r.phase)) throw new FactoryError("conflict", "an update is running");
		clearRecord(this.home);
	}
}
