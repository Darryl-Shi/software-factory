// The `factory.run` Document (spec §4): state, round counters, conversation IDs, artifacts, pending ask,
// cost per role per round, pinned config hash and Pi version. One session-scoped family member per run.
import type { CleanedUp } from "./cleanup.ts";
import { defineDoc, defineDocFamily } from "@earendil-works/pi-durable";
import { NO_LIVE_COST, type UsageSum } from "./usage.ts";
import type {
	ArtifactRef,
	CiStatus,
	CostRecord,
	Delivery,
	EscalationInfo,
	Finding,
	FindingsLogEntry,
	Gate,
	HumanMessage,
	Interrupted,
	LiveCost,
	Notice,
	PendingAsk,
	QaStatus,
	Request,
	ReviewResult,
	Role,
	RunState,
	RunView,
	Workspace,
} from "./types.ts";

/** One review (review #seq, §3.7 "Persisted state and resume"): the reviewer and, when AQ testing runs, the QA agent. */
export type ReviewRoundState = {
	seq: number;
	round: number;
	reviewer?: string;
	/** The reviewed working tree as a commit (refs/factory/<run>/review-<seq>). */
	sha?: string;
	/** Decided on entering REVIEWING; `pending` while the QA VM is being provisioned. */
	qaStatus?: QaStatus | "pending";
	qa?: string;
	vm?: { envId: string; id?: string; name: string; attempt: number; state: "provisioning" | "ready" | "disposed"; outcome?: string };
	bootLog?: string;
	/** Each submission is committed as it arrives. */
	review?: ReviewResult;
	qaResult?: ReviewResult;
	screenshots?: string[];
	/** The latest VM attempt the QA agent was told about (restart / replacement). */
	toldAttempt?: string;
};

export type RunDocState = {
	id: string;
	project: string;
	repo: string;
	request: Request;
	state: RunState;
	gate?: Gate;
	taskId?: string;
	createdAt: number;
	updatedAt: number;
	pinned: { config: Record<string, any>; configHash: string; piVersion: string };
	counters: { reviewRound: number; ciFixes: number; buildSeq: number; reviewSeq: number; discussionSeq: number; askSeq: number; findingSeq: number; attempt?: number; msgSeq?: number };
	caps: { review: number; ciFix: number };
	loop: "review" | "ci";
	workspace?: Workspace;
	envs: Partial<Record<Role, { envId: string; cwd: string }>>;
	conversations: { architect?: string; builder?: string; reviewers: { id: string; seq: number }[]; qa?: { id: string; seq: number }[]; active?: string };
	/** Per review #seq (missing on runs started before AQ testing existed). */
	reviews?: Record<string, ReviewRoundState>;
	/** The Conversation the core is driving right now (set when runAgent submits, cleared by the next transition). */
	driving?: { conversationId: string; key: string };
	/** The agent paused by `interruptAgent` while the core drives it (cleared by the resuming message or the turn's end). */
	interrupted?: Interrupted;
	/** Per Conversation: its usage when the core's current turn on it started (the live cost's baseline, with `usage`). */
	usageBase?: Record<string, UsageSum>;
	pending: { architectInput?: string; builderFindings?: Finding[]; builderNote?: string };
	pendingAsk?: PendingAsk;
	artifacts: { spec?: ArtifactRef & { text: string }; delivery?: Delivery };
	lastFingerprint?: string;
	lastReview?: ReviewResult;
	humanFindingsForReview: Finding[];
	findingsLog: FindingsLogEntry[];
	advisory: Finding[];
	acceptedBlocking: Finding[];
	escalation?: EscalationInfo;
	ci?: { startedAt: number; last?: CiStatus };
	noCi?: boolean;
	cost: CostRecord[];
	cancelReason?: string;
	failure?: { state: RunState; gate?: Gate; reason: string; pendingAsk?: PendingAsk };
	notices: Notice[];
	history: { from: RunState | null; to: RunState; at: number; round: number }[];
	/** Messages humans sent with `message` (missing on runs started before messages existed). */
	messages?: HumanMessage[];
	/** Usage already in cost records, per Conversation (see usage.ts). */
	usage?: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number; usd: number }>;
	/** The last ask the core closed without a human response, and who closed it (a superseded spec approval). */
	closedAsk?: { id: string; by: string };
	/** 2: created (or migrated) by a factory with bundles. Runs without it were started before bundles existed. */
	flowVersion?: number;
	/** A run that had begun delivering under the old flow when the factory upgraded: it finishes with its own PR, CI and merge gate. */
	legacy?: boolean;
	/** The active or merged bundle the run belongs to (cleared when the bundle releases it). */
	bundle?: string;
	/** Set by the bundle when it merged: the run goes READY → DELIVERED. */
	bundleMerged?: { bundle: string; delivery: Delivery };
	/** READY: how many messages to the builder were already checked for a workspace change. */
	readyChecked?: number;
	/** Set by `clearRuns`: the run is archived (off the board and default listings) and its files and branches are deleted (src/core/cleanup.ts); the record stays. */
	cleared?: { at: number; by: string };
	/** Disk cleanup done (src/core/cleanup.ts): set when every step of that scope succeeded; deleted by a retry. */
	cleanedUp?: CleanedUp;
};

/** Where a run's spec is committed: docs/specs/<run-id>.md, or the path its spec already has (docs/spec.md for older runs). */
export function specPathOf(d: Pick<RunDocState, "id" | "artifacts">): string {
	return d.artifacts.spec?.path ?? `docs/specs/${d.id}.md`;
}

/**
 * Whether a run started before bundles existed had already begun delivering the old way: it then finishes with its own
 * PR, CI and merge gate (spec §1.1 "Legacy runs").
 */
export function isLegacyDelivery(d: RunDocState): boolean {
	if (d.flowVersion !== undefined) return false;
	if (["DELIVERED", "FAILED", "CANCELLED"].includes(d.state)) return false;
	if (d.state === "DELIVERING" || d.state === "AWAITING_CI") return true;
	if (d.state === "AWAITING_APPROVAL" && d.gate === "merge") return true;
	if (d.state === "ESCALATED" && d.escalation?.from === "AWAITING_CI") return true;
	return d.artifacts.delivery !== undefined;
}

// Typed loosely for Chord's JSON constraint; use `as RunDocState` at read sites.
export const RunDoc = defineDocFamily<Record<string, any>, any>({
	kind: "factory.run",
	version: 1,
	scope: "session",
	family: true,
	initial: (seed) => seed,
});

export const RunIndex = defineDoc<{ runs: string[] }>({
	kind: "factory.runs",
	version: 1,
	scope: "session",
	initial: () => ({ runs: [] }),
});

export function toView(d: RunDocState, liveCost: LiveCost = NO_LIVE_COST): RunView {
	return {
		id: d.id,
		project: d.project,
		repo: d.repo,
		request: d.request,
		state: d.state,
		...(d.gate ? { gate: d.gate } : {}),
		round: d.counters.reviewRound,
		reviewRound: d.counters.reviewRound,
		ciFixes: d.counters.ciFixes,
		caps: d.caps,
		...(d.pendingAsk ? { pendingAsk: d.pendingAsk } : {}),
		artifacts: d.artifacts,
		conversations: { ...d.conversations, reviewers: d.conversations.reviewers, qa: d.conversations.qa ?? [] },
		reviews: Object.values(d.reviews ?? {})
			.sort((a, b) => a.seq - b.seq)
			.map((r) => ({
				seq: r.seq,
				round: r.round,
				...(r.qaStatus && r.qaStatus !== "pending" ? { qaStatus: r.qaStatus } : {}),
				...(r.reviewer !== undefined ? { reviewer: String(r.reviewer) } : {}),
				...(r.qa !== undefined ? { qa: String(r.qa) } : {}),
				...(r.vm?.id ? { vm: { id: r.vm.id, name: r.vm.name, attempt: r.vm.attempt, state: r.vm.state } } : {}),
				screenshots: r.screenshots ?? [],
				submitted: { review: !!r.review, qa: !!r.qaResult },
			})),
		...(lastQaStatus(d) ? { qaStatus: lastQaStatus(d) } : {}),
		cost: d.cost,
		liveCost,
		...(d.interrupted ? { interrupted: { ...d.interrupted, conversationId: String(d.interrupted.conversationId) } } : {}),
		configHash: d.pinned.configHash,
		piVersion: d.pinned.piVersion,
		...(d.failure ? { failure: { state: d.failure.state, ...(d.failure.gate ? { gate: d.failure.gate } : {}), reason: d.failure.reason } } : {}),
		...(d.escalation ? { escalation: d.escalation } : {}),
		advisory: d.advisory,
		acceptedBlocking: d.acceptedBlocking,
		findingsLog: d.findingsLog,
		...(d.noCi ? { noCi: true } : {}),
		notices: d.notices,
		messages: d.messages ?? [],
		history: d.history,
		...(d.workspace ? { workspace: d.workspace } : {}),
		specPath: specPathOf(d),
		...(d.bundle ? { bundle: d.bundle } : {}),
		...(d.cleared ? { cleared: { at: d.cleared.at, by: d.cleared.by } } : {}),
		createdAt: d.createdAt,
		updatedAt: d.updatedAt,
	};
}

/** The QA status of the latest review that decided one. */
export function lastQaStatus(d: RunDocState): QaStatus | undefined {
	const rs = Object.values(d.reviews ?? {}).sort((a, b) => b.seq - a.seq);
	const s = rs.find((r) => r.qaStatus && r.qaStatus !== "pending")?.qaStatus;
	return s as QaStatus | undefined;
}
