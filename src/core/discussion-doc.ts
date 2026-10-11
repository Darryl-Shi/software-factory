// The `factory.discussion` Document (discussions spec §1.1): one session-scoped family member per discussion, beside
// the run documents. The discussion Task and the core's operations change it; `toDiscussionView` is what interfaces get.
import { defineDoc, defineDocFamily } from "@earendil-works/pi-durable";
import type { DiscussionId, DiscussionNotice, DiscussionState, DiscussionView, Draft, RepoRef, RunId, RunState, TurnCost, Workspace } from "./types.ts";

/** The turn in progress. `text` is what the turn submits: for `say`, the human's text; for `draft`, the drafting instructions. */
export type DiscussionTurn = {
	kind: "say" | "draft";
	/** The request id of the turn's input (`<id>:turn<seq>`): submitting it again is a no-op. */
	key: string;
	seq: number;
	text: string;
	/** The interface that started the turn. */
	by: string;
	/** Set on a human's `say`: the input goes in as a human message (`humanContent`); unset on the core's first input. */
	msgId?: string;
	startedAt: number;
	/** A `say` turn's factory note (the checkout changed since the last turn), sent in the message's header. */
	note?: string;
	stopRequested?: boolean;
	/** The interface that asked to stop the turn. */
	stoppedBy?: string;
};

export type DiscussionDocState = {
	id: DiscussionId;
	project: string;
	repo: RepoRef;
	title: string;
	state: DiscussionState;
	/** FAILED only. */
	error?: string;
	/** Pinned at start, never changed. */
	model: { model: string; thinking: string };
	/** The project's effective settings at start, as a run pins them. */
	pinned: { config: Record<string, any> };
	/** The current discussion Task (a new one on reopen and retry). */
	taskId?: string;
	/** The read-only checkout (spec §1.4). */
	workspace?: Workspace;
	/**
	 * Set when a reopen or retry changed the checkout (another head, or the repo now exists) and no turn has told the
	 * model yet; the next `say` or `draft` turn takes it as a factory note (`takeCheckoutNote`).
	 */
	checkoutChanged?: { from: string; to: string; repoCreated: boolean };
	conversationId?: string;
	turn: DiscussionTurn | null;
	/** The human's first message (with `startDiscussion`); the first turn submits it with the project context. */
	firstMessage: { text: string; by: string };
	counters: { turnSeq: number; draftSeq: number; batch: number };
	/** From the latest submit_tickets. */
	summary?: string;
	drafts: Draft[];
	notices: DiscussionNotice[];
	turnCosts: TurnCost[];
	createdAt: number;
	updatedAt: number;
};

// Typed loosely for Chord's JSON constraint; use `as DiscussionDocState` at read sites.
export const DiscussionDoc = defineDocFamily<Record<string, any>, any>({
	kind: "factory.discussion",
	version: 1,
	scope: "session",
	family: true,
	initial: (seed) => seed,
});

export const DiscussionIndex = defineDoc<{ ids: string[] }>({
	kind: "factory.discussions",
	version: 1,
	scope: "session",
	initial: () => ({ ids: [] }),
});

/** The view interfaces get: `cost` is the Conversation's usage so far; `runState` looks up the state of a run a draft became. */
export function toDiscussionView(d: DiscussionDocState, cost: { usd: number; totalTokens: number }, runState: (id: RunId) => RunState | undefined): DiscussionView {
	const runs: { id: RunId; state: RunState }[] = [];
	for (const x of d.drafts) {
		const state = x.runId !== undefined ? runState(x.runId) : undefined;
		if (state) runs.push({ id: x.runId!, state });
	}
	return {
		id: d.id,
		project: d.project,
		repo: d.repo,
		title: d.title,
		state: d.state,
		...(d.error !== undefined ? { error: d.error } : {}),
		model: d.model,
		...(d.conversationId !== undefined ? { conversationId: d.conversationId } : {}),
		turn: d.turn ? { kind: d.turn.kind, startedAt: d.turn.startedAt } : null,
		...(d.summary !== undefined ? { summary: d.summary } : {}),
		drafts: d.drafts,
		notices: d.notices,
		cost,
		turnCosts: d.turnCosts,
		runs,
		...(d.workspace ? { workspace: d.workspace } : {}),
		createdAt: d.createdAt,
		updatedAt: d.updatedAt,
	};
}
