// The `factory.bundle` Document (bundles spec §2.1): a bundle's members, state, integration, review rounds, delivery,
// CI, pending ask, findings, cost and pinned settings. The fields it shares with the run Document have the same names,
// so the run and bundle Tasks share their review, agent and CI code (task-kit.ts).
import type { CleanedUp } from "./cleanup.ts";
import { defineDoc, defineDocFamily } from "@earendil-works/pi-durable";
import { lastQaStatus, type ReviewRoundState } from "./run-doc.ts";
import type {
	BundleMember,
	BundlePendingAsk,
	BundleState,
	BundleView,
	CiStatus,
	CostRecord,
	Delivery,
	EscalationInfo,
	Finding,
	FindingsLogEntry,
	HumanMessage,
	MergeMethod,
	Notice,
	ReviewResult,
	Role,
	RunId,
	Workspace,
} from "./types.ts";

export type BundleDocState = {
	id: string;
	project: string;
	repo: string;
	state: BundleState;
	taskId?: string;
	createdAt: number;
	updatedAt: number;
	pinned: { config: Record<string, any>; configHash: string };
	/** Current members, in the order they were picked. */
	members: BundleMember[];
	dropped: RunId[];
	counters: {
		reviewRound: number;
		ciFixes: number;
		/** Integrator tasks (conflicts and findings), as the run's builder tasks. */
		buildSeq: number;
		reviewSeq: number;
		askSeq: number;
		findingSeq: number;
		discussionSeq: number;
		/** Integrations started (a re-integration after a drop or a moved default branch starts a new one). */
		integration: number;
		attempt?: number;
		msgSeq?: number;
	};
	caps: { review: number; ciFix: number };
	loop: "review" | "ci";
	workspace?: Workspace;
	envs: Partial<Record<Role, { envId: string; cwd: string }>>;
	conversations: { integrator?: string; reviewers: { id: string; seq: number }[]; qa?: { id: string; seq: number }[]; active?: string };
	reviews?: Record<string, ReviewRoundState>;
	driving?: { conversationId: string; key: string };
	/** The integration in progress or done: merging members in order onto `base`. */
	integration?: {
		n: number;
		base: string;
		/** Index of the next member to merge. */
		next: number;
		resolved: { run: RunId; files: string[] }[];
		/** The conflicted merge the integrator is resolving. */
		conflict?: { run: RunId; files: string[]; attempts: number };
		/** The integrator changed something (resolved a conflict), so the combined result goes through review. */
		changed: boolean;
		/**
		 * Set on every integration started under the combined-review rule: a clean merge of 2+ members is reviewed. An
		 * integration record from before that rule has no mark and ends with the old rule (clean → DELIVERING).
		 */
		reviewCombination?: boolean;
	};
	/** Input for the integrator's next task: findings (FIXING) and notes (dropped tickets, why it runs). */
	pending: { findings?: Finding[]; note?: string; notes?: string[] };
	pendingAsk?: BundlePendingAsk;
	closedAsk?: { id: string; by: string };
	escalation?: Omit<EscalationInfo, "from"> & { from: BundleState };
	lastFingerprint?: string;
	lastReview?: ReviewResult;
	humanFindingsForReview: Finding[];
	findingsLog: FindingsLogEntry[];
	advisory: Finding[];
	acceptedBlocking: Finding[];
	delivery?: Delivery;
	ci?: { startedAt: number; sha: string; last?: CiStatus };
	noCi?: boolean;
	/** The default branch's head the delivered integration was built on (a moved default needs an update before merging). */
	deliveredBase?: string;
	/** Merge was clicked while the default branch had moved: merge by itself once the update is clean and green. */
	mergeRequested?: boolean;
	cost: CostRecord[];
	usage?: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number; usd: number }>;
	notices: Notice[];
	messages?: HumanMessage[];
	history: { from: BundleState | null; to: BundleState; at: number; round: number }[];
	cancelReason?: string;
	/** Disk cleanup done (src/core/cleanup.ts): set when every step of that scope succeeded; deleted by a retry. */
	cleanedUp?: CleanedUp;
	failure?: { state: BundleState; reason: string; pendingAsk?: BundlePendingAsk };
};

export const BundleDoc = defineDocFamily<Record<string, any>, any>({
	kind: "factory.bundle",
	version: 1,
	scope: "session",
	family: true,
	initial: (seed) => seed,
});

export const BundleIndex = defineDoc<{ ids: string[]; seq?: number }>({
	kind: "factory.bundles",
	version: 1,
	scope: "session",
	initial: () => ({ ids: [] }),
});

export const mergeMethodOf = (d: Pick<BundleDocState, "pinned">): MergeMethod => (d.pinned.config.bundle?.mergeMethod ?? "squash") as MergeMethod;

export function toBundleView(d: BundleDocState): BundleView {
	const qaStatus = lastQaStatus(d as any);
	return {
		id: d.id,
		project: d.project,
		repo: d.repo,
		state: d.state,
		members: d.members,
		dropped: d.dropped,
		mergeMethod: mergeMethodOf(d),
		...(d.delivery ? { delivery: d.delivery } : {}),
		...(d.ci?.last ? { ci: d.ci.last } : {}),
		...(d.noCi ? { noCi: true } : {}),
		...(d.pendingAsk ? { pendingAsk: d.pendingAsk } : {}),
		...(d.escalation ? { escalation: d.escalation as unknown as EscalationInfo } : {}),
		...(d.mergeRequested ? { mergeRequested: true } : {}),
		...(d.integration
			? {
					integration: {
						n: d.integration.n,
						base: d.integration.base,
						resolved: d.integration.resolved,
						...(d.integration.conflict ? { conflict: { run: d.integration.conflict.run, files: d.integration.conflict.files } } : {}),
						changed: d.integration.changed,
						...(d.integration.reviewCombination ? { reviewCombination: true } : {}),
					},
				}
			: {}),
		round: d.counters.reviewRound,
		reviewRound: d.counters.reviewRound,
		ciFixes: d.counters.ciFixes,
		caps: d.caps,
		conversations: {
			...(d.conversations.integrator !== undefined ? { integrator: String(d.conversations.integrator) } : {}),
			// Conversation ids are numbers in the harness; the view's are strings, as its type says.
			reviewers: d.conversations.reviewers.map((r) => ({ id: String(r.id), seq: r.seq })),
			qa: (d.conversations.qa ?? []).map((r) => ({ id: String(r.id), seq: r.seq })),
			...(d.conversations.active !== undefined ? { active: String(d.conversations.active) } : {}),
		},
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
		...(qaStatus ? { qaStatus } : {}),
		findingsLog: d.findingsLog,
		advisory: d.advisory,
		acceptedBlocking: d.acceptedBlocking,
		notices: d.notices,
		messages: d.messages ?? [],
		history: d.history,
		cost: d.cost,
		...(d.failure ? { failure: { state: d.failure.state, reason: d.failure.reason } } : {}),
		...(d.workspace ? { workspace: d.workspace } : {}),
		createdAt: d.createdAt,
		updatedAt: d.updatedAt,
	};
}
