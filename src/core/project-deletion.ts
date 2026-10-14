// Project deletion (docs/specs/run-mv86f7vs-jif2.md): the `factory.projectDeletions` session Document records each
// deletion from its purge commit until its config removal and disk cleanup are done, so a crash at any point after the
// commit ends with the project fully deleted (the startup sweep and `gc` finish it).
import { defineDoc } from "@earendil-works/pi-durable";
import type { OwnerKind } from "./cleanup.ts";

/** What a purged owner's full cleanup needs, captured in the purge commit (its Document is retired there). */
export type CapturedOwner = {
	kind: OwnerKind;
	id: string;
	repo: string;
	/** The owner's pinned workdir (expanded). */
	workdir: string;
	/** The owner's pinned `github` settings (identity references only, never secrets): for the remote branch. */
	github?: Record<string, any>;
	/** Whether the repo existed on the host when the project was deleted (null: unknown, checked again at cleanup). */
	repoExists: boolean | null;
};

export type ProjectDeletion = {
	/** Unique per deletion (the same name can be deleted again later). */
	id: string;
	project: string;
	repo: string;
	at: number;
	by: string;
	/** Owners whose cleanup has not succeeded yet. */
	owners: CapturedOwner[];
	configRemoved: boolean;
	/** The shared clone in the global workdir, until removed (or kept: another project binds the repo). */
	clone: string | null;
	/** The shared clones in the other workdirs the owners pinned, until removed. */
	otherClones?: string[];
};

export const ProjectDeletions = defineDoc<{ entries: ProjectDeletion[] }>({
	kind: "factory.projectDeletions",
	version: 1,
	scope: "session",
	initial: () => ({ entries: [] }),
});

/** The next `<prefix>N` of an index: monotonic (never reused after a purge), seeded from the existing ids on first use. */
export function nextIndexId(idx: { ids: string[]; seq?: number }, prefix: string): string {
	idx.seq = maxIndexSeq(idx, prefix) + 1;
	return `${prefix}${idx.seq}`;
}

/** The highest number issued so far in an index (its counter, or its ids). */
export function maxIndexSeq(idx: { ids: string[]; seq?: number }, prefix: string): number {
	let max = idx.seq ?? 0;
	for (const id of idx.ids) {
		const n = id.startsWith(prefix) ? Number(id.slice(prefix.length)) : Number.NaN;
		if (Number.isInteger(n) && n > max) max = n;
	}
	return max;
}
