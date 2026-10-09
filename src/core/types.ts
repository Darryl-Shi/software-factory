// Shared contracts of the software factory core (spec §3). Transport-neutral, model-free.

export type RunId = string;
export type AskId = string;
export type RepoRef = string; // "owner/name"
export type Role = "architect" | "builder" | "helper" | "reviewer";
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
	"AWAITING_CI",
	"DELIVERED",
	"FAILED",
	"CANCELLED",
] as const;
export type RunState = (typeof RUN_STATES)[number];
export const TERMINAL_STATES: readonly RunState[] = ["DELIVERED", "FAILED", "CANCELLED"];

export interface Request {
	id: string;
	source: string;
	title: string;
	body: string;
	project: string;
	meta?: Record<string, unknown>;
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
	source?: "reviewer" | "human" | "ci";
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

export interface RunUpdate {
	status: "started" | "progress" | "done" | "failed" | "cancelled";
	state: RunState;
	url?: string;
	message?: string;
	advisory?: Finding[];
	acceptedBlocking?: Finding[];
	noCi?: boolean;
}

export interface Notice {
	at: number;
	level: "info" | "warn" | "error";
	text: string;
	url?: string;
	advisory?: Finding[];
	acceptedBlocking?: Finding[];
	noCi?: boolean;
	final?: boolean;
}

// ---------------------------------------------------------------- settings (§6)
export type SettingField =
	| { type: "string" | "number" | "boolean" | "secretRef"; default?: unknown; description: string; min?: number; max?: number }
	| { type: "enum"; values: string[]; default?: string; description: string }
	| { type: "list"; of: SettingField; default?: unknown[]; description: string }
	| { type: "object"; fields: Record<string, SettingField>; description: string };

export interface Configurable {
	settings?: { schema: Record<string, SettingField>; validate?(value: unknown): string[] };
}

export type Scope = { global: true } | { project: string };
export type SettingSource = "default" | "global" | "project";
export type EffectiveSettings = Record<string, { value: unknown; source: SettingSource }>;

// ---------------------------------------------------------------- factory extensions (§3.2, §3.3)
export interface FactoryCoreRef {
	/** Name of the extension (used for Request.source, stage `use`). */
	name: string;
}

export interface IntakeExtension extends Configurable {
	kind: "intake";
	name: string;
	pull(): Promise<Omit<Request, "id">[]>;
	subscribe?(onRequest: (r: Omit<Request, "id">) => void): Unsubscribe;
	writeBack(req: Request, update: RunUpdate): Promise<void>;
}

export interface InterfaceExtension extends Configurable {
	kind: "interface";
	name: string;
	start(core: FactoryCore): Promise<{ stop(): Promise<void> }>;
}

/** Per-call context the core hands to stage extensions: the run's pinned stage settings. */
export interface StageCallOptions {
	runId: string;
	settings: Record<string, any>;
	/** All pinned stage settings of the run (e.g. the delivery extension reads the repo identity from `stages.repo`). */
	stages?: Record<string, any>;
}

export interface RepoExtension extends Configurable {
	kind: "repo";
	name: string;
	open(ref: RepoRef, opts: StageCallOptions): Promise<Workspace>;
	create(ref: RepoRef, opts: StageCallOptions): Promise<void>;
	fork?(ref: RepoRef, opts: StageCallOptions): Promise<RepoRef>;
	diff(ws: Workspace, base: string, head?: string): Promise<Diff>;
	merge(pr: PrRef, how: "merge" | "squash" | "rebase", opts: StageCallOptions): Promise<void>;
	/** Deviation (DEVIATIONS.md): commit a core artifact (docs/spec.md) into the workspace. Idempotent. */
	writeArtifact(ws: Workspace, path: string, content: string, message: string): Promise<void>;
}

export interface DeliveryContext {
	spec: ArtifactRef;
	specText: string;
	review: ReviewResult;
	request: Request;
	advisory: Finding[];
	acceptedBlocking: Finding[];
	mode: "push-main" | "pull-request";
	runId: string;
	settings: Record<string, any>;
	stages?: Record<string, any>;
}

export interface DeliveryExtension extends Configurable {
	kind: "delivery";
	name: string;
	deliver(ws: Workspace, ctx: DeliveryContext): Promise<Delivery>;
	checks(d: Delivery, names?: string[], opts?: StageCallOptions): Promise<CiStatus>;
	/** Deviation (DEVIATIONS.md): add a note (e.g. "no CI") to the PR description / delivery note. Idempotent. */
	annotate?(d: Delivery, ws: Workspace, note: string, opts: StageCallOptions): Promise<void>;
}

export interface EnvironmentExtension extends Configurable {
	kind: "environment";
	name: string;
	provision(ws: Workspace, role: Role, opts: StageCallOptions): Promise<{ envId: string; cwd: string }>;
	env(input: { conversationId: string; cwd?: string; envId: string }): import("@earendil-works/pi-durable/env").ExecutionEnv;
	dispose(envId: string): Promise<void>;
}

export type FactoryExtension = IntakeExtension | InterfaceExtension | RepoExtension | DeliveryExtension | EnvironmentExtension;
export type StageName = "intake" | "interface" | "repo" | "delivery" | "environment";

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
	conversations: { architect?: string; builder?: string; reviewers: { id: string; seq: number }[]; active?: string };
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
	history: { from: RunState | null; to: RunState; at: number; round: number }[];
	workspace?: Workspace;
	createdAt: number;
	updatedAt: number;
}

export interface EscalationInfo {
	reason: string;
	from: RunState;
	cap: "review" | "ciFix" | "none";
	findings: Finding[];
}

export interface FindingsLogEntry {
	seq: number;
	kind: "review" | "human" | "ci";
	round: number;
	findings: Finding[];
	responses?: FindingResponse[];
	reviewerConversation?: string;
}

export interface TranscriptItem {
	entryId: string;
	kind: string;
	role?: string;
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
}

export type FactoryEvent =
	| { type: "run.state"; run: RunId; project: string; from: RunState | null; to: RunState; round: number }
	| { type: "run.ask"; run: RunId; ask: AskId; question: Question }
	| { type: "run.askResolved"; run: RunId; ask: AskId; by: string }
	| { type: "run.notice"; run: RunId; notice: Notice }
	| { type: "conversation.updated"; run: RunId; conversationId: string; role: Role }
	| { type: "settings.changed"; scope: Scope; path: string };

export interface FactoryCore {
	createProject(name: string, repo: RepoRef): Promise<Project>;
	getProject(name: string): Promise<Project>;
	listProjects(): Promise<Project[]>;
	startRun(project: string, request: Omit<Request, "id" | "project">): Promise<RunId>;
	getRun(run: RunId): Promise<RunView>;
	listRuns(filter?: { project?: string; states?: RunState[] }): Promise<RunView[]>;
	getConversation(run: RunId, conversationId: string): Promise<TranscriptView>;
	cancelRun(run: RunId, reason?: string): Promise<void>;
	retryRun(run: RunId): Promise<void>;
	answer(run: RunId, ask: AskId, text: string): Promise<void>;
	approve(run: RunId, gate: Gate): Promise<void>;
	reject(run: RunId, gate: Gate, feedback: string): Promise<void>;
	submitHumanFindings(run: RunId, gate: "delivery" | "merge", findings: HumanFinding[]): Promise<void>;
	resolveEscalation(run: RunId, ask: AskId, choice: { accept: true } | { moreRounds: number } | { abort: true }): Promise<void>;
	settingsSchema(): Record<string, SettingField>;
	getSettings(scope: Scope): Promise<EffectiveSettings>;
	setSetting(scope: Scope, path: string, value: unknown): Promise<void>;
	unsetSetting(scope: Scope, path: string): Promise<void>;
	subscribe(filter: { project?: string; run?: RunId }, on: (e: FactoryEvent) => void): Unsubscribe;
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
