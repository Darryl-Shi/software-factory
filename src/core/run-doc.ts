// The `factory.run` Document (spec §4): state, round counters, conversation IDs, artifacts, pending ask,
// cost per role per round, pinned config hash and Pi version. One session-scoped family member per run.
import { defineDoc, defineDocFamily } from "@earendil-works/pi-durable";
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
};

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

export function toView(d: RunDocState): RunView {
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
