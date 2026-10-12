// The detached restart helper (spec: updates). The factory spawns it outside itself, from a copy of this file and
// of restart.ts / record.ts made from the running version, so a broken new version can't break its own rollback.
// It triggers the restart, waits up to 90 s for the new process to serve GET /api/version with the target SHA, and
// sets update.json's phase to `done`; otherwise it resets the checkout, reinstalls if the lockfile had changed,
// restarts again and sets `rolled-back`. Node builtins only.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { readRecord, type UpdateRecord, writeRecord } from "./record.ts";
import { restartFactory, type Runner, runCommand, type StartedBy } from "./restart.ts";

export interface HelperJob {
	root: string;
	home: string;
	configPath: string;
	from: string;
	to: string;
	lockChanged: boolean;
	startedBy: StartedBy;
	serveArgs: string[];
	logFile: string;
	timeoutMs: number;
	path?: string;
}

export interface HelperDeps {
	run: Runner;
	fetch: typeof fetch;
	restart: (job: HelperJob) => Promise<void>;
	sleep: (ms: number) => Promise<void>;
	now: () => number;
}

export const short = (sha: string) => sha.slice(0, 7);
const tail = (s: string, n = 12) => s.trim().split("\n").slice(-n).join("\n");
export const GIT_ENV = { GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", SSH_ASKPASS: "", LC_ALL: "C" };

export function logLine(file: string, msg: string): void {
	try {
		appendFileSync(file, `[factory] update: ${msg}\n`, { mode: 0o600 });
	} catch {}
}

/** `npm ci --no-audit --no-fund` in the install root; throws with the last lines of its output. */
export async function npmCi(root: string, run: Runner): Promise<void> {
	const r = await run("npm", ["ci", "--no-audit", "--no-fund"], { cwd: root, timeoutMs: 15 * 60_000 });
	if (r.code !== 0) throw new Error(`npm ci failed (exit ${r.code}):\n${tail(`${r.stdout}\n${r.stderr}`)}`);
}

/** Puts the checkout back on `from` (it was clean before the update), reinstalling if the lockfile had changed. */
export async function resetCheckout(root: string, from: string, lockChanged: boolean, run: Runner): Promise<void> {
	const r = await run("git", ["reset", "--hard", "--quiet", from], { cwd: root, env: GIT_ENV });
	if (r.code !== 0) throw new Error(`git reset --hard ${short(from)} failed: ${(r.stderr || r.stdout).trim()}`);
	if (lockChanged) await npmCi(root, run);
}

function logTail(file: string, n = 15): string {
	try {
		return existsSync(file) ? tail(readFileSync(file, "utf8"), n) : "";
	} catch {
		return "";
	}
}

/** Polls <home>/web-url's server until GET /api/version reports `sha` (full) or the deadline passes. */
export async function waitForVersion(job: HelperJob, sha: string, deadline: number, deps: HelperDeps): Promise<boolean> {
	while (deps.now() < deadline) {
		try {
			const link = readFileSync(`${job.home}/web-url`, "utf8").trim();
			const u = new URL(link);
			const token = u.searchParams.get("token") ?? "";
			const res = await deps.fetch(new URL("/api/version", u.origin), { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) });
			if (res.ok) {
				const v = (await res.json()) as { fullSha?: string };
				if (v.fullSha === sha) return true;
			}
		} catch {}
		await deps.sleep(1000);
	}
	return false;
}

const update = (home: string, patch: Partial<UpdateRecord>) => {
	const r = readRecord(home);
	if (r) writeRecord(home, { ...r, ...patch });
};

export async function runHelper(job: HelperJob, deps: HelperDeps): Promise<"done" | "rolled-back" | "failed"> {
	const log = (m: string) => logLine(job.logFile, m);
	const deadline = deps.now() + job.timeoutMs;
	let reason: string | undefined;
	try {
		log(`restarting (${job.startedBy}) to finish the update from ${short(job.from)} to ${short(job.to)}`);
		await deps.restart(job);
		if (await waitForVersion(job, job.to, deadline, deps)) {
			update(job.home, { phase: "done", finishedAt: deps.now() });
			log(`updated from ${short(job.from)} to ${short(job.to)}`);
			return "done";
		}
		reason = `the new version did not start within ${Math.round(job.timeoutMs / 1000)}s`;
	} catch (e) {
		reason = e instanceof Error ? e.message : String(e);
	}
	const lines = logTail(job.logFile);
	log(`update to ${short(job.to)} failed to start (${reason.split("\n")[0]}); rolling back to ${short(job.from)}`);
	try {
		await resetCheckout(job.root, job.from, job.lockChanged, deps.run);
		await deps.restart(job);
		const back = await waitForVersion(job, job.from, deps.now() + job.timeoutMs, deps);
		update(job.home, {
			phase: "rolled-back",
			error: `${reason}${lines ? `\n\nfactory.log:\n${lines}` : ""}`,
			finishedAt: deps.now(),
		});
		log(back ? `rolled back to ${short(job.from)}` : `rolled back to ${short(job.from)}, but the factory did not come back within ${Math.round(job.timeoutMs / 1000)}s`);
		return "rolled-back";
	} catch (e) {
		const err = e instanceof Error ? e.message : String(e);
		update(job.home, { phase: "failed", error: `${reason}; the rollback to ${short(job.from)} failed too: ${err}`, finishedAt: deps.now() });
		log(`rollback to ${short(job.from)} failed: ${err.split("\n")[0]}`);
		return "failed";
	}
}

export const defaultHelperDeps = (): HelperDeps => ({
	run: runCommand,
	fetch: globalThis.fetch,
	restart: (job) => restartFactory(job.startedBy, { configPath: job.configPath, root: job.root, serveArgs: job.serveArgs, run: runCommand }),
	sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
	now: Date.now,
});

// Run as a script: `node --import tsx helper.ts <job.json>`.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const job = JSON.parse(readFileSync(process.argv[2]!, "utf8")) as HelperJob;
	if (job.path) process.env.PATH = job.path;
	delete process.env.FACTORY_DAEMON_ARGS;
	runHelper(job, defaultHelperDeps()).then(
		() => process.exit(0),
		(e) => {
			logLine(job.logFile, `helper failed: ${e instanceof Error ? e.message : e}`);
			process.exit(1);
		},
	);
}
