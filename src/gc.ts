// `factory gc` (docs/specs/run-mv58bn4q-q2zs.md): run the disk sweep of the running factory through its HTTP API
// (POST /api/op/gc, with the token from its web-url) and print what it removed and any failures.
import { existsSync, readFileSync } from "node:fs";
import type { GcResult } from "./core/types.ts";
import { daemonFiles } from "./daemon.ts";

/** The lines `factory gc` prints for a sweep's result. */
export function formatGc(r: GcResult): string[] {
	const lines = [r.summary];
	if (r.removed.length === 0) lines.push("Nothing was removed.");
	else lines.push(`Removed ${r.removed.length} item${r.removed.length === 1 ? "" : "s"}:`, ...r.removed.map((x) => `  - ${x}`));
	if (r.failures.length) lines.push(`${r.failures.length} failure${r.failures.length === 1 ? "" : "s"}:`, ...r.failures.map((x) => `  ! ${x}`));
	return lines;
}

/** POST /api/op/gc to the factory whose web UI link is `link`. */
export async function requestGc(link: string): Promise<GcResult> {
	const u = new URL(link);
	const res = await fetch(new URL("/api/op/gc", u.origin), {
		method: "POST",
		headers: { authorization: `Bearer ${u.searchParams.get("token") ?? ""}`, "content-type": "application/json" },
		body: JSON.stringify({ args: [] }),
		signal: AbortSignal.timeout(30 * 60_000),
	});
	const json = (await res.json()) as { ok: boolean; result?: GcResult; error?: string };
	if (!res.ok || !json.ok || !json.result) throw new Error(json.error ?? `HTTP ${res.status}`);
	return json.result;
}

/** Exit code: 0 when the sweep ran without failures, 1 otherwise (or when no factory is running). */
export async function gcCommand(configPath: string, print: (s: string) => void = console.log, error: (s: string) => void = console.error): Promise<number> {
	const files = daemonFiles(configPath);
	const url = existsSync(files.url) ? readFileSync(files.url, "utf8").trim() : undefined;
	if (!url) {
		error("no factory is running: start it with `factory serve` (the sweep also runs at every start)");
		return 1;
	}
	let r: GcResult;
	try {
		r = await requestGc(url);
	} catch (e) {
		const refused = e instanceof TypeError || /ECONNREFUSED|fetch failed/.test(String((e as any)?.cause ?? e));
		error(refused ? `no factory is running at ${new URL(url).origin}: start it with \`factory serve\`` : `gc failed: ${e instanceof Error ? e.message : e}`);
		return 1;
	}
	for (const l of formatGc(r)) print(l);
	return r.failures.length ? 1 : 0;
}
