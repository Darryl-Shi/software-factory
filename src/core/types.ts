// Shared contracts of the software factory core (spec §3). Transport-neutral, model-free.

export type RunId = string;
export type AskId = string;
export type RepoRef = string; // "owner/name"
export type Role = "architect" | "builder" | "helper" | "reviewer" | "qa" | "discussant" | "integrator";
/** Every role name (scratch dirs and environment records are named `<owner id>-<role>`). */
export const ROLES: readonly Role[] = ["architect", "builder", "helper", "reviewer", "qa", "discussant", "integrator"];
/** Whether AQ testing ran in a review round (§2 "QA status"). */
export type QaStatus = "ran" | "off" | "skipped" | "unavailable";
export type Gate = "spec" | "delivery" | "merge";
export type Unsubscribe = () => void;

export const RUN_STATES = [
	"RECEIVED",
	"PREPARING",
	"DISCUSSING",
	"SPEC_READY",
	"AWAITING_APPROVAL",
	"BUILDING",
	"REVIEWING",
	"ESCALATED",
	"DELIVERING",
	"READY",
	"AWAITING_CI",
	"DELIVERED",
	"FAILED",
	"CANCELLED",
] as const;
export type RunState = (typeof RUN_STATES)[number];
export const TERMINAL_STATES: readonly RunState[] = ["DELIVERED", "FAILED", "CANCELLED"];

// ---------------------------------------------------------------- bundles (several Ready tickets shipped as one PR)
export type BundleId = string;
export const BUNDLE_STATES = [
	"INTEGRATING",
	"FIXING",
	"REVIEWING",
	"DELIVERING",
	"AWAITING_CI",
	"AWAITING_MERGE",
	"ESCALATED",
	"MERGED",
	"FAILED",
	"CANCELLED",
] as const;
export type BundleState = (typeof BUNDLE_STATES)[number];
/** Terminal bundle states. A FAILED bundle keeps its members until it is retried or cancelled. */
export const BUNDLE_TERMINAL_STATES: readonly BundleState[] = ["MERGED", "FAILED", "CANCELLED"];
/** A bundle in one of these states holds its members: they cannot join another bundle, be cancelled or messaged. */
export const BUNDLE_RELEASED_STATES: readonly BundleState[] = ["MERGED", "CANCELLED"];
export const MERGE_METHODS = ["merge", "squash", "rebase"] as const;
export type MergeMethod = (typeof MERGE_METHODS)[number];

export type BundleQuestion =
	| { kind: "merge"; options: ["merge", "request-changes", "drop"] }
	| { kind: "escalation"; reason: string; options: ["more-rounds", "drop", "abort"] };

export type BundleAskResponse =
	| { type: "merge"; by: string }
	| { type: "changes"; feedback: string; by: string }
	| { type: "drop"; runs: RunId[]; by: string }
	| { type: "escalation"; choice: { moreRounds: number } | { drop: RunId[] } | { abort: true }; by: string };

export interface BundlePendingAsk {
	id: AskId;
	question: BundleQuestion;
	createdAt: number;
	response?: BundleAskResponse;
}

export interface BundleMember {
	run: RunId;
	title: string;
	/** The ticket key the board shows (PROJECT-N). */
	key: string;
	/** The run's spec path in the repo (docs/specs/<run-id>.md, or docs/spec.md for older runs). */
	specPath: string;
	branch: string;
}

export interface BundleView {
	id: BundleId;
	project: string;
	repo: RepoRef;
	state: BundleState;
	members: BundleMember[];
	/** Runs dropped from the bundle (they went back to Ready). */
	dropped: RunId[];
	mergeMethod: MergeMethod;
	delivery?: Delivery;
	ci?: CiStatus;
	noCi?: boolean;
	pendingAsk?: BundlePendingAsk;
	escalation?: EscalationInfo;
	/** Merge was clicked and the bundle is being updated onto the latest default branch: it merges by itself when clean and green. */
	mergeRequested?: boolean;
	/**
	 * The latest integration: its base commit, the conflicts the integrator resolved, whether it changed anything, and
	 * whether it follows the rule that a clean merge of 2+ tickets is reviewed (absent on integrations from before it).
	 */
	integration?: { n: number; base: string; resolved: { run: RunId; files: string[] }[]; conflict?: { run: RunId; files: string[] }; changed: boolean; reviewCombination?: boolean };
	round: number;
	reviewRound: number;
	ciFixes: number;
	caps: { review: number; ciFix: number };
	conversations: { integrator?: string; reviewers: { id: string; seq: number }[]; qa: { id: string; seq: number }[]; active?: string };
	reviews: ReviewRoundView[];
	qaStatus?: QaStatus;
	findingsLog: FindingsLogEntry[];
	advisory: Finding[];
	acceptedBlocking: Finding[];
	notices: Notice[];
	messages: HumanMessage[];
	history: { from: BundleState | null; to: BundleState; at: number; round: number }[];
	cost: CostRecord[];
	failure?: { state: BundleState; reason: string };
	workspace?: Workspace;
	createdAt: number;
	updatedAt: number;
}

// ---------------------------------------------------------------- discussions (a pre-ticket chat with the discussant)
export type DiscussionId = string;
export const DISCUSSION_STATES = ["PREPARING", "OPEN", "CLOSED", "FAILED"] as const;
export type DiscussionState = (typeof DISCUSSION_STATES)[number];
export interface Draft {
	id: string;
	title: string;
	body: string;
	edited: boolean;
	/** Which submit_tickets submission it came from (1-based). */
	batch: number;
	runId?: RunId;
}
export interface DiscussionNotice {
	at: number;
	kind: "error" | "stopped" | "no_submission";
	text: string;
	/** The turn (its seq, as in `turnCosts`) that ended with this notice. */
	turn?: number;
}
export interface TurnCost {
	turn: number;
	kind: "say" | "draft";
	usd: number;
	totalTokens: number;
	durationMs: number;
}
export interface DiscussionView {
	id: DiscussionId;
	project: string;
	repo: RepoRef;
	title: string;
	state: DiscussionState;
	error?: string;
	model: { model: string; thinking: string };
	conversationId?: string;
	turn: { kind: "say" | "draft"; startedAt: number } | null;
	summary?: string;
	drafts: Draft[];
	notices: DiscussionNotice[];
	cost: { usd: number; totalTokens: number };
	turnCosts: TurnCost[];
	runs: { id: RunId; state: RunState }[];
	workspace?: Workspace;
	createdAt: number;
	updatedAt: number;
}

export interface Request {
	id: string;
	source: string;
	title: string;
	body: string;
	project: string;
	meta?: Record<string, unknown>;
}

/** `Request.meta.discussion` of a run created from a discussion draft (`createTicket`): copied, never read back. */
export interface DiscussionLink {
	id: DiscussionId;
	title: string;
	draftId: string;
	summary: string;
	/** The titles of the other drafts from the same submit_tickets submission. */
	siblings: string[];
}

export interface ArtifactRef {
	kind: "spec" | "delivery" | "workspace";
	path?: string;
	url?: string;
	sha256?: string;
	version?: number;
}

export type Question =
	| { kind: "discussion"; text: string }
	| { kind: "approval"; gate: Gate; artifact: ArtifactRef; options: ["approve", "reject"] }
	| { kind: "escalation"; reason: string; options: string[] };

/** A finding (§2, §3.4). `source: "ci"` carries a CI failure back to the builder in the same shape. */
export interface Finding {
	id?: string;
	severity: string;
	blocking: boolean;
	specRef?: string;
	description: string;
	evidence?: string;
	/** Ids of screenshots the QA agent took in its VM (§3.7); every QA finding cites at least one. */
	screenshots?: string[];
	source?: "reviewer" | "qa" | "human" | "ci";
}
export type HumanFinding = { severity: string; description: string; specRef?: string; evidence?: string };

export interface FindingResponse {
	findingId: string;
	status: "fixed" | "wontfix";
	reason?: string;
}

export interface ReviewResult {
	verdict: "pass" | "fail";
	findings: Finding[];
}

export interface Workspace {
	repo: RepoRef;
	path: string;
	baseRef: string;
	branch: string;
	newRepo: boolean;
}

export interface Diff {
	base: string;
	head: string;
	files: { path: string; status: string }[];
	stat: string;
	patch: string;
	/** Hash of the patch (working tree incl. uncommitted and untracked files vs base). */
	fingerprint: string;
	empty: boolean;
}

export interface PrRef {
	repo: RepoRef;
	number: number;
	url: string;
}

export type Delivery = { kind: "repo" | "pr"; url: string; ref: string; sha: string; pr?: PrRef };
export type CiStatus = { state: "none" | "pending" | "green" | "red"; failures?: string[]; checks?: { name: string; state: string }[] };

export interface Notice {
	at: number;
	level: "info" | "warn" | "error";
	text: string;
	url?: string;
	advisory?: Finding[];
	acceptedBlocking?: Finding[];
	noCi?: boolean;
	/** The final round's QA status (on the final notice). */
	qaStatus?: QaStatus;
	final?: boolean;
}

// ---------------------------------------------------------------- settings (§6)
export type SettingField =
	| { type: "string" | "number" | "boolean" | "secretRef"; default?: unknown; description: string; min?: number; max?: number }
	| { type: "enum"; values: string[]; default?: string; description: string }
	| { type: "list"; of: SettingField; default?: unknown[]; description: string }
	| { type: "object"; fields: Record<string, SettingField>; description: string };

export type Scope = { global: true } | { project: string };
export type SettingSource = "default" | "global" | "project";
export type EffectiveSettings = Record<string, { value: unknown; source: SettingSource }>;

// ---------------------------------------------------------------- GitHub and sandbox calls
/** Per-call context the core hands to `GitHub` and `Sandbox`: the run id and the run's pinned effective config. */
export interface RunCtx {
	runId: string;
	config: Record<string, any>;
}

export interface DeliveryContext {
	spec: ArtifactRef;
	specText: string;
	review: ReviewResult;
	request: Request;
	advisory: Finding[];
	acceptedBlocking: Finding[];
	mode: "push-main" | "pull-request";
	/** The final review round's QA status; QA findings' screenshots stay in the factory's run view. */
	qaStatus?: QaStatus;
}

// ---------------------------------------------------------------- projects, runs, events (§3.5, §3.6)
export interface Project {
	name: string;
	repo: RepoRef;
	overrides: Record<string, unknown>;
}

export interface CostRecord {
	role: Role;
	round: number;
	seq: number;
	conversationId: string;
	/** provider/modelId and thinking level the role ran with (from the run's pinned config). */
	model: string;
	thinking: string;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	usd: number;
	durationMs: number;
	/** Set on usage from turns your messages started while the role was idle (see `message`). */
	trigger?: "message";
	/** QA: the boat.dev VM's machine time for the round (a record of its own, with boat's dollars in `usd`). */
	vmSeconds?: number;
}

export interface PendingAsk {
	id: AskId;
	question: Question;
	createdAt: number;
	response?: AskResponse;
}

export type AskResponse =
	| { type: "answer"; text: string; by: string }
	| { type: "approve"; by: string }
	| { type: "reject"; findings: HumanFinding[]; feedback: string; by: string }
	| { type: "escalation"; choice: { accept: true } | { moreRounds: number } | { abort: true }; by: string };

/** A message a human sent to the agent the run is with (`message`). */
export interface HumanMessage {
	id: string;
	text: string;
	/** The interface that sent it. */
	by: string;
	to: Role;
	/** Set once the message is handed to a conversation; unset while the role hasn't started yet. */
	conversationId?: string;
	at: number;
}

export interface RunView {
	id: RunId;
	project: string;
	repo: RepoRef;
	request: Request;
	state: RunState;
	gate?: Gate;
	round: number;
	reviewRound: number;
	ciFixes: number;
	caps: { review: number; ciFix: number };
	pendingAsk?: PendingAsk;
	artifacts: { spec?: ArtifactRef & { text: string }; delivery?: Delivery };
	conversations: { architect?: string; builder?: string; reviewers: { id: string; seq: number }[]; qa: { id: string; seq: number }[]; active?: string };
	/** One entry per review (review #seq): the round it belongs to and whether AQ testing ran in it. */
	reviews: ReviewRoundView[];
	/** QA status of the latest review round (undefined before the first review). */
	qaStatus?: QaStatus;
	cost: CostRecord[];
	configHash: string;
	piVersion: string;
	failure?: { state: RunState; gate?: Gate; reason: string };
	escalation?: EscalationInfo;
	advisory: Finding[];
	acceptedBlocking: Finding[];
	findingsLog: FindingsLogEntry[];
	noCi?: boolean;
	notices: Notice[];
	messages: HumanMessage[];
	history: { from: RunState | null; to: RunState; at: number; round: number }[];
	workspace?: Workspace;
	/** The run's spec path in the repo: docs/specs/<run-id>.md (docs/spec.md for runs past SPEC_READY before bundles). */
	specPath: string;
	/** The active or merged bundle the run belongs to. */
	bundle?: BundleId;
	/** Set once the run was cleared from the board (`clearRuns`): when, and by which interface. */
	cleared?: { at: number; by: string };
	createdAt: number;
	updatedAt: number;
}

export interface ReviewRoundView {
	seq: number;
	round: number;
	qaStatus?: QaStatus;
	reviewer?: string;
	qa?: string;
	/** The QA VM (boat.dev sandbox) of this review, if one was provisioned. */
	vm?: { id: string; name: string; attempt: number; state: "provisioning" | "ready" | "disposed" };
	/** Screenshot ids the QA agent took in this review. */
	screenshots: string[];
	submitted: { review: boolean; qa: boolean };
}

export interface EscalationInfo {
	reason: string;
	from: RunState;
	cap: "review" | "ciFix" | "none";
	findings: Finding[];
}

export interface FindingsLogEntry {
	seq: number;
	kind: "review" | "qa" | "human" | "ci";
	round: number;
	/** For review and qa entries: the review (#seq) they came from. */
	reviewSeq?: number;
	findings: Finding[];
	responses?: FindingResponse[];
	reviewerConversation?: string;
}

export interface TranscriptItem {
	entryId: string;
	kind: string;
	role?: string;
	/** For user items: `human` for a message sent with `message`, `factory` for the core's own input. */
	author?: "factory" | "human";
	/** For human messages: the interface that sent it and the message id. `text` is the human's text only. */
	by?: string;
	msgId?: string;
	text?: string;
	toolCalls?: { id: string; name: string; args: unknown }[];
	toolResult?: { callId: string; name: string; isError: boolean; text: string; details?: unknown };
}

export interface TranscriptView {
	conversationId: string;
	role?: Role;
	items: TranscriptItem[];
	/** Helper conversations the builder spawned (found through tool `details`). */
	helpers: string[];
	busy: boolean;
	/** Human messages waiting in the conversation's inbox for the agent's next step boundary. */
	queued: { msgId: string; by: string; text: string }[];
}

export type FactoryEvent =
	| { type: "run.state"; run: RunId; project: string; from: RunState | null; to: RunState; round: number }
	/** A terminal run was cleared from the board (`clearRuns`). */
	| { type: "run.cleared"; run: RunId; project: string }
	| { type: "run.ask"; run: RunId; ask: AskId; question: Question }
	| { type: "run.askResolved"; run: RunId; ask: AskId; by: string }
	| { type: "run.notice"; run: RunId; notice: Notice }
	| { type: "conversation.updated"; run: RunId; conversationId: string; role: Role }
	| { type: "run.message"; run: RunId; message: { id: string; to: Role; conversationId?: string } }
	| { type: "settings.changed"; scope: Scope; path: string }
	| { type: "discussion.state"; discussion: DiscussionId; project: string; from: DiscussionState | null; to: DiscussionState }
	/** `submission`: with `what: "drafts"`, a new submit_tickets was applied (absent for a human's edit or delete). */
	| { type: "discussion.updated"; discussion: DiscussionId; project: string; what: "turn.started" | "turn.ended" | "drafts" | "ticket" | "notice"; submission?: true }
	| { type: "discussion.conversation.updated"; discussion: DiscussionId; conversationId: string }
	| { type: "bundle.state"; bundle: BundleId; project: string; from: BundleState | null; to: BundleState; round: number }
	| { type: "bundle.ask"; bundle: BundleId; ask: AskId; question: BundleQuestion }
	| { type: "bundle.askResolved"; bundle: BundleId; ask: AskId; by: string }
	| { type: "bundle.notice"; bundle: BundleId; notice: Notice }
	| { type: "bundle.conversation.updated"; bundle: BundleId; conversationId: string; role: Role };

/** A model `listModels` reports: `id` is `provider/modelId`. */
export interface ModelInfo {
	id: string;
	name?: string;
	provider: string;
}

export interface FactoryCore {
	createProject(name: string, repo: RepoRef): Promise<Project>;
	getProject(name: string): Promise<Project>;
	listProjects(): Promise<Project[]>;
	/** The models the model host reports as available (with credentials). Read-only; needs no project. */
	listModels(): Promise<ModelInfo[]>;
	startRun(project: string, request: Omit<Request, "id" | "project">): Promise<RunId>;
	getRun(run: RunId): Promise<RunView>;
	/** Cleared runs are left out unless `includeCleared` is set. */
	listRuns(filter?: { project?: string; states?: RunState[]; includeCleared?: boolean }): Promise<RunView[]>;
	getConversation(run: RunId, conversationId: string): Promise<TranscriptView>;
	cancelRun(run: RunId, reason?: string): Promise<void>;
	retryRun(run: RunId): Promise<void>;
	/**
	 * Archive terminal runs: they leave the board and default listings. Then starts, in the background, a full disk
	 * cleanup of each (worktree, manifest, local and remote branch, scratch, environment records); the record stays.
	 */
	clearRuns(runs: RunId[]): Promise<{ cleared: RunId[] }>;
	/**
	 * The disk sweep (the one that runs at startup): cleans finished owners not cleaned yet and removes orphans under the
	 * workdirs. Waits for a sweep already running and returns its result.
	 */
	gc(): Promise<GcResult>;
	answer(run: RunId, ask: AskId, text: string): Promise<void>;
	approve(run: RunId, gate: Gate): Promise<void>;
	reject(run: RunId, gate: Gate, feedback: string): Promise<void>;
	submitHumanFindings(run: RunId, gate: "delivery" | "merge", findings: HumanFinding[]): Promise<void>;
	resolveEscalation(run: RunId, ask: AskId, choice: { accept: true } | { moreRounds: number } | { abort: true }): Promise<void>;
	/** Send a message to the agent the run is with. It never moves the run; see `messageTarget` for who receives it. */
	message(run: RunId, text: string): Promise<{ message: string; to: Role; conversationId?: string }>;
	/** A QA screenshot (§3.7), kept by the core as a run artifact. Over HTTP: GET /api/runs/<run>/screenshots/<id>. */
	getScreenshot(run: RunId, id: string): Promise<{ mime: string; bytes: Uint8Array }>;
	settingsSchema(): Record<string, SettingField>;
	getSettings(scope: Scope): Promise<EffectiveSettings>;
	setSetting(scope: Scope, path: string, value: unknown): Promise<void>;
	unsetSetting(scope: Scope, path: string): Promise<void>;
	/** Start a discussion on a project with a first message; `model` defaults to the project's `discussion.model`.
	 * A missing or blank `title` is derived from the first line of the message (see `deriveTitle`). */
	startDiscussion(project: string, d: { title?: string; message: string; model?: { model: string; thinking: string } }): Promise<DiscussionId>;
	getDiscussion(id: DiscussionId): Promise<DiscussionView>;
	listDiscussions(filter?: { project?: string; states?: DiscussionState[] }): Promise<DiscussionView[]>;
	/** The discussion's transcript (its one Conversation, role `discussant`). */
	getDiscussionConversation(id: DiscussionId): Promise<TranscriptView>;
	/** Send the human's text to the discussant: starts a turn. Refused while a turn runs or when not OPEN. */
	say(id: DiscussionId, text: string): Promise<void>;
	/** Abort the turn that is running. */
	stopTurn(id: DiscussionId): Promise<void>;
	/** Ask the discussant for draft tickets and a summary (a `draft` turn), with the human's optional instructions. */
	requestDrafts(id: DiscussionId, instructions?: string): Promise<void>;
	/** Edit a draft that has not become a run; marks it `edited`. */
	updateDraft(id: DiscussionId, draft: string, change: { title?: string; body?: string }): Promise<void>;
	deleteDraft(id: DiscussionId, draft: string): Promise<void>;
	/** Turn a draft into a run (OPEN or CLOSED; not while a `draft` turn runs); the draft then records the run and is read-only. */
	createTicket(id: DiscussionId, draft: string): Promise<RunId>;
	closeDiscussion(id: DiscussionId): Promise<void>;
	reopenDiscussion(id: DiscussionId): Promise<void>;
	retryDiscussion(id: DiscussionId): Promise<void>;
	/** Ship Ready runs of one project as a bundle (one PR). `invalid`: empty, another project, not READY; `conflict`: already in an active bundle. */
	createBundle(project: string, runs: RunId[]): Promise<BundleId>;
	getBundle(id: BundleId): Promise<BundleView>;
	listBundles(filter?: { project?: string; states?: BundleState[] }): Promise<BundleView[]>;
	getBundleConversation(id: BundleId, conversationId: string): Promise<TranscriptView>;
	/** Merge the bundle's PR (at AWAITING_MERGE); updates it onto the latest default branch first when that moved. */
	mergeBundle(id: BundleId): Promise<void>;
	requestBundleChanges(id: BundleId, feedback: string): Promise<void>;
	/** Drop members (at AWAITING_MERGE or ESCALATED); at least one must remain. They return to plain READY. */
	dropFromBundle(id: BundleId, runs: RunId[]): Promise<void>;
	resolveBundleEscalation(id: BundleId, ask: AskId, choice: { moreRounds: number } | { drop: RunId[] } | { abort: true }): Promise<void>;
	cancelBundle(id: BundleId, reason?: string): Promise<void>;
	retryBundle(id: BundleId): Promise<void>;
	/** A message to the agent the bundle is with (the reviewer while REVIEWING, else the integrator). */
	messageBundle(id: BundleId, text: string): Promise<{ message: string; to: Role; conversationId?: string }>;
	/** A QA screenshot of a bundle review. Over HTTP: GET /api/bundles/<id>/screenshots/<sid>. */
	getBundleScreenshot(id: BundleId, screenshotId: string): Promise<{ mime: string; bytes: Uint8Array }>;
	/** A `project` filter matches run, discussion and bundle events; `run`, `discussion` and `bundle` match only that one's. */
	subscribe(filter: { project?: string; run?: RunId; discussion?: DiscussionId; bundle?: BundleId }, on: (e: FactoryEvent) => void): Unsubscribe;
}

/** The operations an interface may call over its transport (everything but `subscribe`). */
export const CORE_OPS = [
	"createProject",
	"getProject",
	"listProjects",
	"listModels",
	"startRun",
	"getRun",
	"listRuns",
	"getConversation",
	"cancelRun",
	"retryRun",
	"clearRuns",
	"gc",
	"answer",
	"approve",
	"reject",
	"submitHumanFindings",
	"resolveEscalation",
	"message",
	"getScreenshot",
	"settingsSchema",
	"getSettings",
	"setSetting",
	"unsetSetting",
	"startDiscussion",
	"getDiscussion",
	"listDiscussions",
	"getDiscussionConversation",
	"say",
	"stopTurn",
	"requestDrafts",
	"updateDraft",
	"deleteDraft",
	"createTicket",
	"closeDiscussion",
	"reopenDiscussion",
	"retryDiscussion",
	"createBundle",
	"getBundle",
	"listBundles",
	"getBundleConversation",
	"mergeBundle",
	"requestBundleChanges",
	"dropFromBundle",
	"resolveBundleEscalation",
	"cancelBundle",
	"retryBundle",
	"messageBundle",
	"getBundleScreenshot",
] as const satisfies readonly (keyof FactoryCore)[];

/** What a disk sweep (`gc`) removed and what it could not remove. */
export interface GcResult {
	removed: string[];
	failures: string[];
	/** The sweep's one-line summary (as logged). */
	summary: string;
}

export class FactoryError extends Error {
	constructor(
		public code: "not_found" | "invalid" | "conflict" | "not_pending",
		message: string,
	) {
		super(message);
		this.name = "FactoryError";
	}
}
