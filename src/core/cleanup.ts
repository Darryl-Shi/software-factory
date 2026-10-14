// Disk cleanup (docs/specs/run-mv58bn4q-q2zs.md): what each finished run, bundle and discussion ("owner") leaves under
// its pinned workdir is deleted as soon as nothing uses it. One pure rule (`cleanupScope`), one never-throwing
// `cleanup(owner, scope)` (each step idempotent, attempted even if an earlier one failed), per-owner serialisation in
// process, and the startup sweep / `gc` that backfills old records, retries failed cleanups and removes orphans.
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { CheckoutArea, GitHub, StepResult } from "../github/github.ts";
import type { Sandbox } from "../sandbox/sandbox.ts";
import { expandHome } from "./settings.ts";
import { ROLES } from "./types.ts";

export type OwnerKind = "run" | "bundle" | "discussion";
export type CleanupScope = "none" | "scratch" | "full";
/** Set on an owner's Document when every step of that scope succeeded. `full` is final; `scratch` can become `full`. */
export type CleanedUp = { at: number; scope: "scratch" | "full" };

/** What the cleanup needs to know about a run, bundle or discussion. */
export interface Owner {
	kind: OwnerKind;
	id: string;
	repo: string;
	state: string;
	/** Runs only: cleared from the board. */
	cleared?: boolean;
	/** The owner's pinned config (its `workdir` and GitHub identity). */
	config: Record<string, any>;
	cleanedUp?: CleanedUp;
	taskId?: string;
	/** False when the repo was known not to exist on the host (the remote branch step is then skipped). */
	repoExists?: boolean | null;
}

/** The rules (spec "Rules"): which things of an owner in its current state may go. */
export function cleanupScope(o: Pick<Owner, "kind" | "state" | "cleared">): CleanupScope {
	if (o.kind === "run") {
		if (o.state === "DELIVERED") return "full";
		if (o.state === "FAILED" || o.state === "CANCELLED") return o.cleared ? "full" : "scratch";
		return "none";
	}
	if (o.kind === "bundle") {
		if (o.state === "MERGED" || o.state === "CANCELLED") return "full";
		if (o.state === "FAILED") return "scratch";
		return "none";
	}
	return o.state === "CLOSED" || o.state === "FAILED" ? "full" : "none";
}

/** Whether the marker already covers the scope (nothing left to do). */
export function covered(marker: CleanedUp | undefined, scope: CleanupScope): boolean {
	return scope === "none" || marker?.scope === "full" || marker?.scope === scope;
}

/** The marker after a successful cleanup of `scope`: never downgraded from `full`. */
export function nextMarker(prev: CleanedUp | undefined, scope: "scratch" | "full", at: number): CleanedUp {
	return prev?.scope === "full" ? prev : { at, scope };
}

export const workdirOf = (config: Record<string, any>): string => expandHome(config.workdir ?? "~/factory/work");
export const AREA: Record<OwnerKind, CheckoutArea> = { run: "runs", bundle: "bundles", discussion: "discussions" };
/** Factory-made ids per area; nothing else is ever treated as an orphan. */
export const ID_PATTERN: Record<CheckoutArea, RegExp> = { runs: /^run-[A-Za-z0-9_-]+$/, bundles: /^bundle-[A-Za-z0-9_-]+$/, discussions: /^disc-[A-Za-z0-9_-]+$/ };
const isOwnerId = (id: string) => Object.values(ID_PATTERN).some((p) => p.test(id));

/** `<owner id>-<role>` (a scratch dir or an environment record) → its owner id, or undefined for any other name. */
export function ownerOfEnvName(name: string): string | undefined {
	for (const role of ROLES) {
		if (!name.endsWith(`-${role}`)) continue;
		const id = name.slice(0, -role.length - 1);
		if (isOwnerId(id)) return id;
	}
	return undefined;
}

export type Cat = "runs" | "bundles" | "discussions" | "scratch" | "env" | "local" | "remote";
export type Item = { cat: Cat; text: string };

export interface CleanupResult {
	removed: string[];
	failures: string[];
}

export interface SweepResult extends CleanupResult {
	counts: Record<Cat, number>;
	/** The one summary line the sweep logs. */
	summary: string;
}

/** What the sweep reads from the core. */
export interface SweepSource {
	/** Every run, bundle and discussion in storage, as last committed. */
	owners(): Owner[];
	/** The owner's record, read again from storage (undefined: gone). */
	reread(o: Owner): Promise<Owner | undefined>;
	/** Whether the owner's Task exists and is not terminal (its own finalize cleans it). */
	taskLive(o: Owner): Promise<boolean>;
	/** Commit the marker on the owner's Document. */
	commit(o: Owner, marker: CleanedUp): Promise<void>;
	/** The owner with this id, if any record has it (live). */
	known(id: string): Owner | undefined;
	/** The global workdir. */
	globalWorkdir(): string;
	/** Finish interrupted project deletions first (docs/specs/run-mv86f7vs-jif2.md "Resuming"). */
	deletions?(): Promise<{ items: Item[]; failures: string[] }>;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const emptyCounts = (): Record<Cat, number> => ({ runs: 0, bundles: 0, discussions: 0, scratch: 0, env: 0, local: 0, remote: 0 });

export class Cleaner {
	private locks = new Map<string, Promise<unknown>>();
	private pending = new Set<Promise<unknown>>();
	private sweeping: Promise<SweepResult> | undefined;

	constructor(private o: { github: GitHub; sandbox: Sandbox; log: (msg: string) => void; now: () => number }) {}

	/** Run `f` while no cleanup of `id` runs (and none starts). Retries commit through this. */
	exclusive<T>(id: string, f: () => Promise<T>): Promise<T> {
		const prev = this.locks.get(id) ?? Promise.resolve();
		const next = prev.catch(() => undefined).then(f);
		this.locks.set(id, next);
		void next
			.finally(() => {
				if (this.locks.get(id) === next) this.locks.delete(id);
			})
			.catch(() => undefined);
		return next;
	}

	/** Track a background cleanup (`settled` awaits it). */
	background(p: Promise<unknown>): void {
		const q = p.catch((e) => this.o.log(`cleanup: ${errText(e)}`));
		this.pending.add(q);
		void q.finally(() => this.pending.delete(q));
	}

	/** Test hook: every background cleanup started so far (and any they start) has finished. */
	async settled(): Promise<void> {
		while (this.pending.size || this.sweeping) {
			await Promise.allSettled([...this.pending, ...(this.sweeping ? [this.sweeping] : [])]);
		}
	}

	/**
	 * Clean an owner (spec "One cleanup service"). Serialised per owner id; never throws. `recheck` (inside the lock)
	 * re-reads the owner just before acting: the scope then comes from its current state, and nothing is done when the
	 * scope is `none`, already covered by the marker, or `recheck` returns undefined. `commit` records the marker; it is
	 * called only when every step of the scope succeeded.
	 */
	cleanup(owner: Owner, scope: "scratch" | "full", opts: { recheck?: () => Promise<Owner | undefined>; commit?: (marker: CleanedUp) => Promise<void> } = {}): Promise<CleanupResult> {
		return this.cleanupItems(owner, scope, opts).then((r) => ({ removed: r.items.map((i) => i.text), failures: r.failures }));
	}

	private cleanupItems(
		owner: Owner,
		scope: "scratch" | "full",
		opts: { recheck?: () => Promise<Owner | undefined>; commit?: (marker: CleanedUp) => Promise<void> },
	): Promise<{ items: Item[]; failures: string[] }> {
		return this.exclusive(owner.id, async () => {
			let o = owner;
			let s = scope;
			if (opts.recheck) {
				const x = await opts.recheck().catch((e) => {
					this.o.log(`cleanup ${owner.kind} ${owner.id}: re-reading the record failed: ${errText(e)}`);
					return undefined;
				});
				if (!x) return { items: [], failures: [] };
				const now = cleanupScope(x);
				if (now === "none" || covered(x.cleanedUp, now)) return { items: [], failures: [] };
				o = x;
				s = now;
			}
			const r = await this.steps(o, s);
			for (const f of r.failures) this.o.log(`cleanup ${o.kind} ${o.id}: ${f}`);
			if (r.failures.length === 0 && opts.commit) {
				await opts.commit(nextMarker(o.cleanedUp, s, this.o.now())).catch((e) => this.o.log(`cleanup ${o.kind} ${o.id}: committing the cleanedUp marker failed (the next sweep redoes it): ${errText(e)}`));
			}
			return r;
		}).catch((e) => {
			const f = `cleanup ${owner.kind} ${owner.id}: ${errText(e)}`;
			this.o.log(f);
			return { items: [], failures: [errText(e)] };
		});
	}

	/** The steps of a scope, in order; each attempted even if an earlier one failed. */
	private async steps(o: Owner, scope: "scratch" | "full"): Promise<{ items: Item[]; failures: string[] }> {
		const items: Item[] = [];
		const failures: string[] = [];
		const workdir = workdirOf(o.config);
		const area = AREA[o.kind];
		const add = (r: StepResult, cat: Cat) => {
			for (const t of r.removed) items.push({ cat: t.startsWith("local branch") ? "local" : cat, text: t });
			failures.push(...r.failures);
		};
		if (scope === "full") {
			// 1. the remote branch (runs and bundles: discussion branches are never pushed)
			if (o.kind !== "discussion" && o.repoExists !== false) {
				const branch = `factory/${o.id}`;
				try {
					if (await this.o.github.deleteRemoteBranch(o.repo, branch, { runId: o.id, config: o.config })) items.push({ cat: "remote", text: `remote branch ${branch} (${o.repo})` });
				} catch (e) {
					failures.push(`remote branch: ${branch} on ${o.repo}: ${errText(e)}`);
				}
			}
			// 2-5. the worktree, git worktree prune, the local branch, the manifest
			add(await this.o.github.discard(area, o.id, o.repo, workdir), area);
		}
		// 6. the scratch dirs
		try {
			add(this.o.sandbox.removeScratch(o.id, workdir), "scratch");
		} catch (e) {
			failures.push(`scratch: ${errText(e)}`);
		}
		// 7. the environment records (full only: a retried owner resumes with them)
		if (scope === "full") {
			for (const role of ROLES) {
				const envId = `${o.id}-${role}`;
				try {
					if (this.o.sandbox.destroy(envId)) items.push({ cat: "env", text: `env record ${envId}` });
				} catch (e) {
					failures.push(`env record: ${envId}: ${errText(e)}`);
				}
			}
		}
		return { items, failures };
	}

	/**
	 * A purged owner's full cleanup (deleteProject), driven from its captured data (no Document, no recheck): the §8.1
	 * steps, then `<artifactsDir>/<id>/`. Serialised with any other cleanup of the id; never throws.
	 */
	purgeOwner(o: Owner, artifactsDir: string): Promise<{ items: Item[]; failures: string[] }> {
		return this.exclusive(o.id, async () => {
			const r = await this.steps(o, "full");
			const dir = join(artifactsDir, o.id);
			try {
				if (existsSync(dir)) {
					rmSync(dir, { recursive: true, force: true });
					if (existsSync(dir)) r.failures.push(`artifacts: ${dir} is still there`);
					else r.items.push({ cat: AREA[o.kind], text: `artifacts ${dir}` });
				}
			} catch (e) {
				r.failures.push(`artifacts: ${dir}: ${errText(e)}`);
			}
			for (const f of r.failures) this.o.log(`project deletion: ${o.kind} ${o.id}: ${f}`);
			return r;
		}).catch((e) => {
			this.o.log(`project deletion: ${o.kind} ${o.id}: ${errText(e)}`);
			return { items: [], failures: [errText(e)] };
		});
	}

	/** The startup sweep and `gc` (single flight: a second call waits for the running sweep and returns its result). */
	sweep(src: SweepSource): Promise<SweepResult> {
		if (this.sweeping) return this.sweeping;
		const p = this.sweepOnce(src).finally(() => {
			if (this.sweeping === p) this.sweeping = undefined;
		});
		this.sweeping = p;
		return p;
	}

	private async sweepOnce(src: SweepSource): Promise<SweepResult> {
		const items: Item[] = [];
		const failures: string[] = [];
		const take = (r: { items: Item[]; failures: string[] }) => {
			items.push(...r.items);
			failures.push(...r.failures);
		};
		// 0. interrupted project deletions (their owners have no record any more)
		if (src.deletions) {
			try {
				take(await src.deletions());
			} catch (e) {
				failures.push(`project deletions: ${errText(e)}`);
			}
		}
		// 1. records: one owner at a time
		for (const o of src.owners()) {
			const scope = cleanupScope(o);
			if (scope === "none" || covered(o.cleanedUp, scope)) continue;
			try {
				if (await src.taskLive(o)) continue;
			} catch (e) {
				failures.push(`${o.kind} ${o.id}: reading its task: ${errText(e)}`);
				continue;
			}
			const r = await this.cleanupItems(o, scope, {
				recheck: async () => {
					const x = await src.reread(o);
					return x && !(await src.taskLive(x)) ? x : undefined;
				},
				commit: (m) => src.commit(o, m),
			});
			take({ items: r.items, failures: r.failures.map((f) => `${o.kind} ${o.id}: ${f}`) });
		}
		// 2. orphans, in the global workdir and every pinned one
		const workdirs = [...new Set([src.globalWorkdir(), ...src.owners().map((o) => workdirOf(o.config))])];
		for (const wd of workdirs) take(await this.sweepWorkdir(wd, src));
		for (const envId of this.o.sandbox.recordIds()) {
			const id = ownerOfEnvName(envId);
			if (!id || src.known(id)) continue;
			try {
				if (this.o.sandbox.destroy(envId)) items.push({ cat: "env", text: `env record ${envId}` });
			} catch (e) {
				failures.push(`orphan env record: ${envId}: ${errText(e)}`);
			}
		}
		for (const wd of workdirs)
			for (const clone of this.o.github.clones(wd)) {
				const r = this.o.github.sweepClone(clone, (id) => {
					const o = src.known(id);
					if (!o) return true;
					return cleanupScope(o) === "full" && o.cleanedUp?.scope === "full";
				});
				const x = await r;
				take({ items: x.removed.map((text) => ({ cat: "local" as const, text })), failures: x.failures });
			}
		// 3. summary
		const counts = emptyCounts();
		for (const i of items) counts[i.cat]++;
		const summary = `disk sweep: removed ${items.length} items (runs ${counts.runs}, bundles ${counts.bundles}, discussions ${counts.discussions}, scratch ${counts.scratch}, env records ${counts.env}, branches ${counts.local} local / ${counts.remote} remote), ${failures.length} failures`;
		this.o.log(summary);
		for (const f of failures) this.o.log(`disk sweep failure: ${f}`);
		return { removed: items.map((i) => i.text), failures, counts, summary };
	}

	/** Orphans in one workdir: factory-named entries whose id matches no record. Nothing else is touched. */
	private async sweepWorkdir(wd: string, src: SweepSource): Promise<{ items: Item[]; failures: string[] }> {
		const items: Item[] = [];
		const failures: string[] = [];
		const list = (dir: string) => {
			try {
				return existsSync(dir) ? readdirSync(dir) : [];
			} catch (e) {
				failures.push(`listing ${dir}: ${errText(e)}`);
				return [];
			}
		};
		for (const area of ["runs", "bundles", "discussions"] as const) {
			const dir = join(wd, area);
			for (const name of list(dir)) {
				const json = name.endsWith(".json");
				const id = json ? name.slice(0, -5) : name;
				if (!ID_PATTERN[area].test(id) || src.known(id)) continue;
				const path = join(dir, name);
				await this.exclusive(id, async () => {
					if (src.known(id)) return;
					try {
						const st = statSync(path);
						if (json) {
							if (!st.isFile()) return;
							rmSync(path, { force: true });
							items.push({ cat: area, text: `manifest ${path}` });
						} else if (st.isDirectory()) {
							const r = await this.o.github.removeOrphanWorktree(path);
							for (const t of r.removed) items.push({ cat: area, text: t });
							failures.push(...r.failures.map((f) => `orphan ${f}`));
						}
					} catch (e) {
						failures.push(`orphan ${path}: ${errText(e)}`);
					}
				});
			}
		}
		const scratch = join(wd, "scratch");
		for (const name of list(scratch)) {
			const id = ownerOfEnvName(name);
			if (!id || src.known(id)) continue;
			const path = join(scratch, name);
			await this.exclusive(id, async () => {
				if (src.known(id)) return;
				try {
					if (!statSync(path).isDirectory()) return;
					rmSync(path, { recursive: true, force: true });
					if (existsSync(path)) failures.push(`orphan scratch: ${path} is still there`);
					else items.push({ cat: "scratch", text: `scratch ${path}` });
				} catch (e) {
					failures.push(`orphan scratch: ${path}: ${errText(e)}`);
				}
			});
		}
		return { items, failures };
	}
}

// ------------------------------------------------------------------ owners from Documents
type RunLike = { id: string; repo: string; state: string; cleared?: unknown; pinned: { config: Record<string, any> }; cleanedUp?: CleanedUp; taskId?: string; workspace?: { repo: string } };

export function runOwner(d: RunLike): Owner {
	return { kind: "run", id: d.id, repo: d.workspace?.repo ?? d.repo, state: d.state, cleared: !!d.cleared, config: d.pinned.config, ...(d.cleanedUp ? { cleanedUp: d.cleanedUp } : {}), ...(d.taskId !== undefined ? { taskId: d.taskId } : {}) };
}
export function bundleOwner(d: RunLike): Owner {
	return { ...runOwner(d), kind: "bundle", cleared: false };
}
export function discussionOwner(d: RunLike): Owner {
	return { ...runOwner(d), kind: "discussion", cleared: false };
}

/**
 * A Task's cleanup at its end (finalize/abort): the scope from the rules, done now. Returns the scope to record in the
 * Task's terminal commit (with `nextMarker`), or undefined when nothing is to be recorded (scope `none`, already
 * covered, or a step failed: the sweep retries later).
 */
export async function cleanAtEnd(cleaner: Cleaner, owner: Owner): Promise<"scratch" | "full" | undefined> {
	const scope = cleanupScope(owner);
	if (scope === "none" || covered(owner.cleanedUp, scope)) return undefined;
	const r = await cleaner.cleanup(owner, scope);
	return r.failures.length ? undefined : scope;
}
