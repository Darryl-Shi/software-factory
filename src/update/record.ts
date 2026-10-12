// <factory home>/update.json: the last update's record (mode 0600). Written by the updater in the factory and by the
// detached restart helper, which runs from a copy of this file: it imports node builtins only.
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type UpdatePhase = "pulling" | "installing" | "restarting" | "done" | "failed" | "rolled-back";
export const ACTIVE_PHASES: readonly UpdatePhase[] = ["pulling", "installing", "restarting"];

export interface UpdateRecord {
	/** Full SHAs: the commit the factory ran before, and the one it updates to. */
	from: string;
	to: string;
	startedAt: number;
	phase: UpdatePhase;
	error?: string;
	/** A note for the user, e.g. "Restart the factory to finish the update" (foreground). */
	message?: string;
	/** Set when the factory has to be restarted by hand (started in the foreground). */
	restartRequired?: boolean;
	/** Whether package.json / package-lock.json changed between the two SHAs (npm ci ran). */
	lockChanged?: boolean;
	startedBy?: string;
	/** When the restart was triggered (the helper's 90 s start from here). */
	restartAt?: number;
	finishedAt?: number;
}

export const updateFile = (home: string) => join(home, "update.json");

export function readRecord(home: string): UpdateRecord | undefined {
	const f = updateFile(home);
	if (!existsSync(f)) return undefined;
	try {
		const r = JSON.parse(readFileSync(f, "utf8"));
		return r && typeof r === "object" && typeof r.phase === "string" ? (r as UpdateRecord) : undefined;
	} catch {
		return undefined;
	}
}

export function writeRecord(home: string, r: UpdateRecord): void {
	const f = updateFile(home);
	const tmp = `${f}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(r, null, 2)}\n`, { mode: 0o600 });
	renameSync(tmp, f);
}

export function clearRecord(home: string): void {
	rmSync(updateFile(home), { force: true });
}
