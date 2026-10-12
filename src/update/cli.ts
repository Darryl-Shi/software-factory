// `factory update` (spec: updates): the web UI's check and apply from a terminal. With a factory running it goes
// through that factory's /api/version and /api/update/* (so the restart is the factory's own: systemd, launchd,
// daemon, or a note to restart a foreground factory by hand); with none running it only pulls and installs.
import { existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { daemonFiles, livePid } from "../daemon.ts";
import { factoryHome, INSTALL_ROOT } from "../main.ts";
import type { UpdateRecord } from "./record.ts";
import type { UpdateCheck, VersionInfo } from "./updater.ts";
import { Updater } from "./updater.ts";

const out = (s: string) => console.log(s);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const short = (s: string) => s.slice(0, 7);

/** "abc1234 (2026-01-01T…, v0.1.0)" */
export function describeVersion(v: Pick<VersionInfo, "sha" | "date" | "version">): string {
	return v.sha ? `${v.sha} (${v.date ?? "?"}, v${v.version})` : `v${v.version} (not a git checkout)`;
}

async function api<T>(link: string, path: string, body?: unknown): Promise<T> {
	const u = new URL(link);
	const token = u.searchParams.get("token") ?? "";
	const res = await fetch(new URL(path, u.origin), {
		method: body === undefined ? "GET" : "POST",
		headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
		signal: AbortSignal.timeout(180_000),
	});
	const json = (await res.json()) as T & { ok?: false; error?: string; code?: string };
	if (!res.ok) throw new Error(`${json.error ?? `HTTP ${res.status}`}${json.code ? ` (${json.code})` : ""}`);
	return json;
}

export const fetchVersion = (link: string) => api<VersionInfo>(link, "/api/version");

function printCheck(v: VersionInfo, check: UpdateCheck): void {
	out(`running:  ${describeVersion(v)}`);
	out(`upstream: ${check.upstream} at ${check.upstreamSha}`);
	if (check.error) out(`check failed: ${check.error} (compared with the last fetched ${check.upstream})`);
	if (check.behind > 0) {
		out(`\n${check.behind} new commit${check.behind === 1 ? "" : "s"}:`);
		for (const c of check.commits) out(`  - ${c}`);
		if (check.behind > check.commits.length) out(`  … and ${check.behind - check.commits.length} more`);
	}
}

function blocker(check: UpdateCheck): string | undefined {
	return Updater.blocker(check);
}

async function confirm(question: string): Promise<boolean> {
	if (!process.stdin.isTTY) throw new Error("not a terminal: pass --yes to update");
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	try {
		return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim());
	} finally {
		rl.close();
	}
}

function report(r: UpdateRecord | undefined, to: string): number {
	if (!r || r.to !== to) {
		out("the update's record is missing");
		return 1;
	}
	if (r.phase === "done") {
		out(r.restartRequired ? `pulled ${short(r.to)}. ${r.message ?? "Restart the factory to finish the update"}.` : `updated from ${short(r.from)} to ${short(r.to)}`);
		return 0;
	}
	if (r.phase === "rolled-back") out(`update to ${short(r.to)} failed to start; rolled back to ${short(r.from)}: ${r.error ?? ""}`);
	else out(`update failed: ${r.error ?? r.phase}`);
	return 1;
}

export async function updateCommand(configPath: string, o: { yes: boolean }): Promise<number> {
	const files = daemonFiles(configPath);
	const pid = livePid(configPath);
	const link = pid !== undefined && existsSync(files.url) ? readFileSync(files.url, "utf8").trim() : undefined;
	if (link) return updateRunning(link, files.url, o);
	if (pid !== undefined) throw new Error(`the factory (pid ${pid}) runs but its web UI does not answer; stop it first`);
	return updateLocal(configPath, o);
}

async function updateRunning(link: string, urlFile: string, o: { yes: boolean }): Promise<number> {
	const before = await fetchVersion(link);
	if (!before.updatable) {
		out(`running: ${describeVersion(before)}\nUpdates unavailable: ${before.reason}`);
		return 1;
	}
	const v = await api<VersionInfo>(link, "/api/update/check", {});
	const check = v.check!;
	printCheck(v, check);
	const b = blocker(check);
	if (b) {
		out(b === "already up to date" ? "already up to date" : `can't update: ${b}`);
		return b === "already up to date" ? 0 : 1;
	}
	if (v.active.length) {
		out(`\nactive now (they resume after the restart; only the step in progress is redone):`);
		for (const a of v.active) out(`  - ${a.kind} ${a.id} (${a.project}, ${a.state}): ${a.title}`);
	}
	if (v.startedBy === "foreground") out("\nThe factory runs in the foreground: restart it by hand after the update.");
	if (!o.yes && !(await confirm(`\nUpdate to ${check.upstreamSha}?`))) return 1;
	const to = check.upstreamFullSha;
	const started = await api<VersionInfo>(link, "/api/update/apply", { sha: to });
	let phase = started.update?.phase;
	out(`updating (${phase})…`);
	const deadline = Date.now() + 20 * 60_000;
	let last: VersionInfo | undefined;
	while (Date.now() < deadline) {
		await sleep(2000);
		// The restarted factory writes its link again (the token persists; with port 0 the port may not).
		const current = existsSync(urlFile) ? readFileSync(urlFile, "utf8").trim() : link;
		try {
			last = await fetchVersion(current);
		} catch {
			continue; // restarting
		}
		const r = last.update;
		if (r?.phase !== phase && r?.phase) out(`… ${r.phase}`);
		phase = r?.phase;
		if (r && r.to === to && ["done", "failed", "rolled-back"].includes(r.phase)) return report(r, to);
	}
	out("the update did not finish within 20 minutes; see factory.log");
	return 1;
}

async function updateLocal(configPath: string, o: { yes: boolean }): Promise<number> {
	const updater = new Updater({ root: INSTALL_ROOT, home: factoryHome(configPath), configPath, startedBy: "foreground" });
	await updater.init();
	const v = await updater.version();
	if (!v.updatable) {
		out(`version: ${describeVersion(v)}\nUpdates unavailable: ${v.reason}`);
		return 1;
	}
	const check = await updater.check();
	printCheck(v, check);
	const b = blocker(check);
	if (b) {
		out(b === "already up to date" ? "already up to date" : `can't update: ${b}`);
		return b === "already up to date" ? 0 : 1;
	}
	out("\nNo factory is running: the update pulls and installs only.");
	if (!o.yes && !(await confirm(`Update to ${check.upstreamSha}?`))) return 1;
	await updater.apply(check.upstreamFullSha);
	await updater.settled();
	const r = (await updater.version()).update;
	if (r?.phase === "done" && r.to === check.upstreamFullSha) {
		out(`updated the checkout from ${short(r.from)} to ${short(r.to)}; start the factory with \`factory serve\``);
		return 0;
	}
	return report(r, check.upstreamFullSha);
}
