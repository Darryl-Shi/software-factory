// The factory core (spec §3.6, §4): model-free, interface-agnostic. Holds the state machine (a Pi Durable Task), the
// agent bridge, projects, layered settings and durable pending asks. Exposes operations and events; knows no interface.
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import {
	AssistantEntry,
	type Conversation,
	configure,
	createRegistry,
	defineExtension,
	Harness,
	MemoryStorage,
	type Registry,
	type Submission,
	type Tx,
	UsageDoc,
} from "@earendil-works/pi-durable";
import { AGENT_EXTENSIONS, ROLE_TOOLS } from "../agents/tools.ts";
import { type Boat, boatProblems } from "../boat/boat.ts";
import { type GitHub, githubProblems } from "../github/github.ts";
import { type Sandbox, sandboxProblems } from "../sandbox/sandbox.ts";
import { Bridge, BridgeDoc, bridgeToolsNotFor, EnvDoc } from "./bridge.ts";
import { DiscussionDoc, type DiscussionDocState, DiscussionIndex, deriveTitle, toDiscussionView } from "./discussion-doc.ts";
import { createDiscussionTask, draftInstructions, takeCheckoutNote } from "./discussion-task.ts";
import { humanFindings } from "./findings.ts";
import { DEFAULT_MESSAGE_ROLES, holdMessage, messageContent, messageTarget, parseMessage } from "./messages.ts";
import { RunDoc, type RunDocState, RunIndex, toView } from "./run-doc.ts";
import { RunConfigDoc } from "./run-config.ts";
import { createRunTask } from "./run-task.ts";
import { assertNoLegacySections, ConfigStore, coreSchema, expandHome, hashConfig, isObj, type Obj, parseDuration, THINKING_LEVELS } from "./settings.ts";
import { addCost, sumUsage, type UsageSum } from "./usage.ts";
import {
	type AskId,
	type AskResponse,
	type DiscussionId,
	type DiscussionLink,
	type DiscussionState,
	type DiscussionView,
	DISCUSSION_STATES,
	type EffectiveSettings,
	type FactoryCore,
	FactoryError,
	type FactoryEvent,
	type Gate,
	type HumanFinding,
	type HumanMessage,
	type ModelInfo,
	type Project,
	type Request,
	type Role,
	type RunId,
	RUN_STATES,
	type RunState,
	type RunView,
	type Scope,
	type SettingField,
	TERMINAL_STATES,
	type TranscriptItem,
	type TranscriptView,
	type Unsubscribe,
} from "./types.ts";

/** A `states` filter from an interface: an array of known states (else `invalid`). */
function checkStates(states: unknown, known: readonly string[]): void {
	if (states === undefined) return;
	if (!Array.isArray(states) || !states.every((s) => typeof s === "string" && known.includes(s)))
		throw new FactoryError("invalid", `states must be an array of: ${known.join(", ")}`);
}

const require = createRequire(import.meta.url);
export const PI_DURABLE_VERSION: string = require("@earendil-works/pi-durable/package.json").version;

export interface CoreOptions {
	/** Path of the config file (§5). */
	configPath: string;
	/** pi-ai models (the model host's ModelRuntime, src/models/host.ts) — injected platform service (§3.1). */
	models: Models;
	/** GitHub: workspaces, delivery, CI and merges. */
	github: GitHub;
	/** The sandbox every role's commands and file tools run in (the QA agent excepted). */
	sandbox: Sandbox;
	/** boat.dev VMs for AQ testing (§3.7). */
	boat: Boat;
	/** Run artifacts (QA screenshots); default: `artifacts` next to the config file (under ~/.factory, hidden from every sandbox). */
	artifactsDir?: string;
	/** Storage override (tests): "memory", or a sqlite path. Default: the config's `storage`. */
	storage?: "memory" | { sqlite: string } | { jsonl: string };
	now?: () => number;
	ciPollMs?: number;
	log?: (msg: string) => void;
}

type Waiter = () => void;

export class Factory implements FactoryCore {
	readonly config: ConfigStore;
	private harness!: Harness;
	private root!: Conversation;
	private registry: Registry;
	private runTask!: ReturnType<typeof createRunTask>;
	private discussionTask!: ReturnType<typeof createDiscussionTask>;
	private listeners = new Set<{ filter: { project?: string; run?: RunId; discussion?: DiscussionId }; on: (e: FactoryEvent) => void }>();
	/** Keyed by document id: run ids and discussion ids never collide. */
	private waiters = new Map<string, Set<Waiter>>();
	private cache = new Map<string, RunDocState>();
	private convIndex = new Map<string, { run: string; role: Role }>();
	private discussions = new Map<string, DiscussionDocState>();
	/** The discussant Conversation of each discussion (keys are String(conversationId)). */
	private discussionConvs = new Map<string, DiscussionId>();
	private convThrottle = new Map<string, NodeJS.Timeout>();
	private ctx: Context = BACKGROUND_CONTEXT;
	private now: () => number;
	private log: (msg: string) => void;
	private by = "core";

	constructor(private opts: CoreOptions) {
		this.now = opts.now ?? Date.now;
		this.log = opts.log ?? (() => {});
		this.registry = createRegistry();
		this.config = new ConfigStore(opts.configPath, () => this.settingsSchema(), (eff, scope) => this.coreRules(eff, scope));
	}

	// ------------------------------------------------------------------ lifecycle
	async start(): Promise<void> {
		assertNoLegacySections(this.opts.configPath);
		for (const ext of AGENT_EXTENSIONS) this.registry.install(ext);
		this.registry.install(Bridge);
		this.runTask = createRunTask({
			github: this.opts.github,
			sandbox: this.opts.sandbox,
			boat: this.opts.boat,
			artifactsDir: this.artifactsDir,
			acceptsImages: (ref) => this.acceptsImages(ref),
			bridge: Bridge,
			changed: (runId, ms) => this.changed(runId, ms),
			now: this.now,
			ciPollMs: this.opts.ciPollMs ?? 15_000,
			log: this.log,
		});
		this.discussionTask = createDiscussionTask({
			github: this.opts.github,
			sandbox: this.opts.sandbox,
			bridge: Bridge,
			changed: (id, ms) => this.changed(id, ms),
			now: this.now,
			log: this.log,
		});
		this.registry.install(defineExtension({ name: "factory.core", tasks: [this.runTask, this.discussionTask] }));

		const storage = await this.openStorage();
		this.harness = await Harness.open(
			storage,
			{
				models: this.opts.models,
				registry: this.registry,
				settings: { extensions: [] },
				env: async ({ conversationId, cwd, read }, c) => {
					const b = await read.snapshot(EnvDoc, conversationId, c);
					if (!b?.envId || !b.runId) return undefined;
					if (b.role === "qa") return this.opts.boat.env({ envId: b.envId, ...(cwd ? { cwd } : {}) });
					return this.opts.sandbox.env({ conversationId: conversationId as unknown as string, ...(cwd ? { cwd } : {}), envId: b.envId });
				},
				conversationCreated: async (tx, rec) => {
					// Helpers the builder spawns (Pi's subagent pattern): they write code in the builder's environment (same
					// worktree, same write rules), with roles.helper's model and thinking (unset = the builder's); no subagent,
					// no bridge tools.
					if (!rec.owner) return;
					const parent = await tx.doc(EnvDoc, rec.owner.conversationId);
					if (parent.role !== "builder" || !parent.runId) return;
					const run = (await tx.doc(RunDoc, parent.runId, null as never)) as unknown as RunDocState;
					const roles = run.pinned.config.roles ?? {};
					const model = roles.helper?.model ?? roles.builder?.model;
					const thinking = roles.helper?.thinking ?? roles.builder?.thinking;
					const helperEnv = run.envs.builder;
					const [provider, ...rest] = String(model ?? "").split("/");
					await configure(tx, rec.id, {
						model: { provider: provider!, modelId: rest.join("/") },
						thinkingLevel: (thinking ?? "medium") as any,
						extensions: [...ROLE_TOOLS.helper, Bridge],
						tools: { remove: bridgeToolsNotFor("helper") as any },
						...(helperEnv ? { cwd: helperEnv.cwd } : {}),
					});
					const e = await tx.doc(EnvDoc, rec.id);
					e.runId = parent.runId;
					e.role = "helper";
					if (helperEnv) e.envId = helperEnv.envId;
					const rc = await tx.doc(RunConfigDoc, rec.id);
					rc.runId = parent.runId;
					rc.webSearch = JSON.parse(JSON.stringify(run.pinned.config.webSearch ?? {}));
				},
				onReport: (e) => this.log(`harness report: ${e instanceof Error ? e.stack : String(e)}`),
			},
			this.ctx,
		);
		this.root = await this.harness.root(this.ctx);
		await this.loadCache();
		this.harness.subscribeCommits((pub) => {
			for (const ch of pub.changes) {
				if (ch.type === "document" && ch.record.kind === "factory.run" && ch.record.key && ch.value) {
					const v = ch.value as unknown as RunDocState;
					setImmediate(() => this.onRunChange(v));
				} else if (ch.type === "document" && ch.record.kind === "factory.discussion" && ch.record.key && ch.value) {
					const v = ch.value as unknown as DiscussionDocState;
					setImmediate(() => this.onDiscussionChange(v));
				} else if (ch.type === "document" && ch.record.kind === "factory.env" && ch.conversationId && ch.value) {
					const v = ch.value as { runId?: string; role?: Role };
					// a discussant's runId is its discussion's id
					if (v.runId && v.role === "discussant") this.discussionConvs.set(String(ch.conversationId), v.runId);
					else if (v.runId && v.role) this.convIndex.set(ch.conversationId as unknown as string, { run: v.runId, role: v.role });
				} else if (ch.type === "entry") {
					this.touchConversation(ch.value.conversationId as unknown as string);
				} else if (ch.type === "document" && ch.record.kind === "pi.live" && ch.conversationId) {
					this.touchConversation(ch.conversationId as unknown as string);
				}
			}
		});
		this.harness.resume();
		void this.sweepQaVms();
		for (const run of this.cache.values())
			if (!TERMINAL_STATES.includes(run.state) && run.pinned.piVersion !== PI_DURABLE_VERSION)
				this.log(`run ${run.id} was pinned to pi-durable ${run.pinned.piVersion}; this process runs ${PI_DURABLE_VERSION}`);
	}

	private get artifactsDir(): string {
		return this.opts.artifactsDir ?? join(dirname(this.opts.configPath), "artifacts");
	}

	private acceptsImages(ref: string): boolean {
		const [provider, ...rest] = ref.split("/");
		const m = provider ? (this.opts.models.getModel(provider, rest.join("/")) as { input?: string[] } | undefined) : undefined;
		return !!m?.input?.includes("image");
	}

	/**
	 * Startup sweep (§3.7): delete QA VMs named factory-<runId>-<seq> whose run is not in REVIEWING for that review
	 * (orphans of a crash, or of a factory that was down while the ttl ran out). One pass per boat key reference in use.
	 */
	private async sweepQaVms(): Promise<string[]> {
		try {
			const refs = new Set<string>();
			for (const scope of [{ global: true } as Scope, ...this.config.projects().map((p) => ({ project: p.name }))]) {
				const eff = this.config.effective(scope);
				if (eff.qa?.enabled) refs.add(String(eff.boat?.apiKey ?? "env:BOAT_API_KEY"));
			}
			for (const run of this.cache.values()) if (run.pinned.config.boat?.apiKey) refs.add(String(run.pinned.config.boat.apiKey));
			const keep = (runId: string, seq: number) => {
				const run = this.cache.get(runId);
				return !!run && run.state === "REVIEWING" && run.counters.reviewSeq === seq;
			};
			return await this.opts.boat.sweep([...refs], keep, this.log);
		} catch (e) {
			this.log(`QA VM sweep failed: ${e instanceof Error ? e.message : e}`);
			return [];
		}
	}

	/** Test hook: run the startup sweep again. */
	sweepForTests(): Promise<string[]> {
		return this.sweepQaVms();
	}

	async close(): Promise<void> {
		for (const t of this.convThrottle.values()) clearTimeout(t);
		await this.harness.close(this.ctx);
	}

	/** A handle whose answers are attributed to `name` (the interface that answered). */
	as(name: string): FactoryCore {
		const self = this;
		return new Proxy(this, {
			get(target, prop, receiver) {
				const v = Reflect.get(target, prop, receiver);
				if (typeof v !== "function") return v;
				return (...args: unknown[]) => {
					const prev = self.by;
					self.by = name;
					try {
						return v.apply(target, args);
					} finally {
						self.by = prev;
					}
				};
			},
		});
	}

	private async openStorage() {
		const o = this.opts.storage;
		if (o === "memory") return new MemoryStorage();
		if (o && "sqlite" in o) {
			mkdirSync(dirname(o.sqlite), { recursive: true });
			const { openNodeSqliteStorage } = await import("@earendil-works/pi-durable/storage/sqlite/node");
			return openNodeSqliteStorage(o.sqlite);
		}
		const eff = this.config.effective({ global: true });
		const kind = o && "jsonl" in o ? "jsonl" : eff.storage?.kind;
		const path = expandHome(o && "jsonl" in o ? o.jsonl : eff.storage?.path);
		if (kind === "jsonl") {
			mkdirSync(path, { recursive: true });
			const { openNodeJsonlStorage } = await import("@earendil-works/pi-durable/storage/jsonl/node");
			return openNodeJsonlStorage(path, this.ctx);
		}
		mkdirSync(dirname(path), { recursive: true });
		const { openNodeSqliteStorage } = await import("@earendil-works/pi-durable/storage/sqlite/node");
		return openNodeSqliteStorage(path);
	}

	// ------------------------------------------------------------------ events
	private async loadCache() {
		const idx = await this.harness.snapshot(RunIndex, this.ctx);
		for (const id of idx?.runs ?? []) {
			const d = (await this.harness.snapshot(RunDoc, id, this.ctx)) as RunDocState | undefined;
			if (d) this.indexRun(d);
		}
		const didx = await this.harness.snapshot(DiscussionIndex, this.ctx);
		for (const id of didx?.ids ?? []) {
			const d = (await this.harness.snapshot(DiscussionDoc, id, this.ctx)) as DiscussionDocState | undefined;
			if (d) this.indexDiscussion(d);
		}
	}

	private indexDiscussion(d: DiscussionDocState) {
		this.discussions.set(d.id, structuredClone(d));
		if (d.conversationId !== undefined) this.discussionConvs.set(String(d.conversationId), d.id);
	}

	private onDiscussionChange(v: DiscussionDocState) {
		const prev = this.discussions.get(v.id);
		this.indexDiscussion(v);
		const ws = this.waiters.get(v.id);
		if (ws) for (const w of [...ws]) w();
		const scope = { project: v.project, discussion: v.id };
		if (prev?.state !== v.state) this.emit({ type: "discussion.state", discussion: v.id, project: v.project, from: prev?.state ?? null, to: v.state }, scope);
		const updated = (what: "turn.started" | "turn.ended" | "drafts" | "ticket" | "notice", submission?: boolean) =>
			this.emit({ type: "discussion.updated", discussion: v.id, project: v.project, what, ...(submission ? { submission: true as const } : {}) }, scope);
		if (prev?.turn && prev.turn.key !== v.turn?.key) updated("turn.ended");
		if (v.turn && v.turn.key !== prev?.turn?.key) updated("turn.started");
		const drafts = (d?: DiscussionDocState) => JSON.stringify([d?.summary ?? null, (d?.drafts ?? []).map((x) => [x.id, x.title, x.body])]);
		// `submission`: a new submit_tickets was applied (not a human's edit or delete).
		if (drafts(prev) !== drafts(v)) updated("drafts", v.counters.batch > (prev?.counters.batch ?? 0));
		if (v.drafts.some((x) => x.runId !== undefined && prev?.drafts.find((p) => p.id === x.id)?.runId === undefined)) updated("ticket");
		if (v.notices.length > (prev?.notices.length ?? 0)) updated("notice");
	}

	private indexRun(d: RunDocState) {
		this.cache.set(d.id, structuredClone(d));
		if (d.conversations.architect) this.convIndex.set(d.conversations.architect, { run: d.id, role: "architect" });
		if (d.conversations.builder) this.convIndex.set(d.conversations.builder, { run: d.id, role: "builder" });
		for (const r of d.conversations.reviewers) this.convIndex.set(r.id, { run: d.id, role: "reviewer" });
		for (const r of d.conversations.qa ?? []) this.convIndex.set(r.id, { run: d.id, role: "qa" });
	}

	private onRunChange(v: RunDocState) {
		const prev = this.cache.get(v.id);
		this.indexRun(v);
		const ws = this.waiters.get(v.id);
		if (ws) for (const w of [...ws]) w();
		const scope = { project: v.project, run: v.id };
		const hist = v.history.slice(prev?.history.length ?? 0);
		for (const h of hist) this.emit({ type: "run.state", run: v.id, project: v.project, from: h.from, to: h.to, round: h.round }, scope);
		const prevAsk = prev?.pendingAsk;
		if (prevAsk && !prevAsk.response && (v.pendingAsk?.id !== prevAsk.id || v.pendingAsk.response)) {
			const by = v.pendingAsk?.id === prevAsk.id ? v.pendingAsk.response!.by : v.closedAsk?.id === prevAsk.id ? v.closedAsk.by : "core";
			this.emit({ type: "run.askResolved", run: v.id, ask: prevAsk.id, by }, scope);
		}
		if (v.pendingAsk && !v.pendingAsk.response && v.pendingAsk.id !== prevAsk?.id)
			this.emit({ type: "run.ask", run: v.id, ask: v.pendingAsk.id, question: v.pendingAsk.question }, scope);
		for (const n of v.notices.slice(prev?.notices.length ?? 0)) this.emit({ type: "run.notice", run: v.id, notice: n }, scope);
		const before = new Map((prev?.messages ?? []).map((m) => [m.id, m]));
		for (const m of v.messages ?? []) {
			const was = before.get(m.id);
			if (!was || (was.conversationId === undefined && m.conversationId !== undefined))
				this.emit({ type: "run.message", run: v.id, message: { id: m.id, to: m.to, ...(m.conversationId !== undefined ? { conversationId: m.conversationId } : {}) } }, scope);
		}
	}

	private touchConversation(id: string) {
		if (this.convThrottle.has(id)) return;
		this.convThrottle.set(
			id,
			setTimeout(() => {
				this.convThrottle.delete(id);
				const disc = this.discussions.get(this.discussionConvs.get(String(id)) ?? "");
				if (disc) {
					this.emit({ type: "discussion.conversation.updated", discussion: disc.id, conversationId: id }, { project: disc.project, discussion: disc.id });
					return;
				}
				const m = this.convIndex.get(id);
				if (!m) return;
				const run = this.cache.get(m.run);
				if (run) this.emit({ type: "conversation.updated", run: m.run, conversationId: id, role: m.role }, { project: run.project, run: run.id });
			}, 150),
		);
	}

	/** `scope`: whose event it is. A `run` or `discussion` filter only matches events of that run or discussion. */
	private emit(e: FactoryEvent, scope?: { project: string; run?: string; discussion?: string }) {
		for (const l of [...this.listeners]) {
			if (l.filter.run && l.filter.run !== scope?.run) continue;
			if (l.filter.discussion && l.filter.discussion !== scope?.discussion) continue;
			if (l.filter.project && l.filter.project !== scope?.project) continue;
			try {
				l.on(e);
			} catch (err) {
				this.log(`listener error: ${err}`);
			}
		}
	}

	private changed(runId: string, ms: number): Promise<void> {
		return new Promise((resolve) => {
			const set = this.waiters.get(runId) ?? new Set();
			this.waiters.set(runId, set);
			const done = () => {
				clearTimeout(t);
				set.delete(done);
				resolve();
			};
			const t = setTimeout(done, ms);
			set.add(done);
		});
	}

	subscribe(filter: { project?: string; run?: RunId; discussion?: DiscussionId }, on: (e: FactoryEvent) => void): Unsubscribe {
		const l = { filter, on };
		this.listeners.add(l);
		return () => this.listeners.delete(l);
	}

	// ------------------------------------------------------------------ projects
	async createProject(name: string, repo: string): Promise<Project> {
		return this.config.createProject(name, repo);
	}
	async getProject(name: string): Promise<Project> {
		return this.config.project(name);
	}
	async listModels(): Promise<ModelInfo[]> {
		const available = await this.opts.models.getAvailable();
		return available.map((m) => ({ id: `${m.provider}/${m.id}`, ...(m.name ? { name: m.name } : {}), provider: String(m.provider) }));
	}

	async listProjects(): Promise<Project[]> {
		return this.config.projects();
	}

	// ------------------------------------------------------------------ runs
	async startRun(project: string, request: Omit<Request, "id" | "project">): Promise<RunId> {
		const by = this.by; // before any await: `as(name)` sets `by` only for the synchronous part of the call
		let runId!: RunId;
		await this.root.commit(async (tx) => {
			runId = await this.createRunIn(tx, project, request, by);
		}, this.ctx);
		this.harness.resume();
		return runId;
	}

	/**
	 * Create a run in `tx`: its `RunIndex` entry, its `RunDoc` seed and its Task (startRun, createTicket). Call
	 * `harness.resume()` after the commit. `by`: the calling interface, captured before the caller's first await.
	 */
	private async createRunIn(tx: Tx, project: string, request: Omit<Request, "id" | "project">, by: string): Promise<RunId> {
		const p = this.config.project(project);
		const eff = this.config.effective({ project });
		const runId = `run-${this.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
		const now = this.now();
		const seed: RunDocState = {
			id: runId,
			project,
			repo: p.repo,
			request: { ...request, id: runId, project, source: request.source || by },
			state: "RECEIVED",
			createdAt: now,
			updatedAt: now,
			pinned: { config: eff, configHash: hashConfig(eff), piVersion: PI_DURABLE_VERSION },
			counters: { reviewRound: 1, ciFixes: 0, buildSeq: 0, reviewSeq: 0, discussionSeq: 0, askSeq: 0, findingSeq: 0 },
			caps: { review: Number(eff.policy?.reviewRoundCap ?? 3), ciFix: Number(eff.ci?.fixRounds ?? 2) },
			loop: "review",
			envs: {},
			conversations: { reviewers: [] },
			pending: {},
			artifacts: {},
			humanFindingsForReview: [],
			findingsLog: [],
			advisory: [],
			acceptedBlocking: [],
			cost: [],
			notices: [],
			history: [{ from: null, to: "RECEIVED", at: now, round: 1 }],
		};
		(await tx.doc(RunIndex)).runs.push(runId);
		const d = (await tx.doc(RunDoc, runId, seed as never)) as unknown as RunDocState;
		const taskId = await tx.createTask(this.runTask, { runId, start: "RECEIVED" as RunState }, { ownership: { kind: "conversation" }, background: true });
		d.taskId = taskId as unknown as string;
		return runId;
	}

	private async doc(run: RunId): Promise<RunDocState> {
		const d = (await this.harness.snapshot(RunDoc, run, this.ctx)) as RunDocState | undefined;
		if (!d) throw new FactoryError("not_found", `run ${run} does not exist`);
		return d;
	}

	async getRun(run: RunId): Promise<RunView> {
		return toView(await this.doc(run));
	}

	/** Internal document (tests, diagnostics). */
	async runDocument(run: RunId): Promise<RunDocState> {
		return this.doc(run);
	}

	async listRuns(filter?: { project?: string; states?: RunState[] }): Promise<RunView[]> {
		checkStates(filter?.states, RUN_STATES);
		const idx = await this.harness.snapshot(RunIndex, this.ctx);
		const out: RunView[] = [];
		for (const id of idx?.runs ?? []) {
			const d = await this.doc(id);
			if (filter?.project && d.project !== filter.project) continue;
			if (filter?.states && !filter.states.includes(d.state)) continue;
			out.push(toView(d));
		}
		return out;
	}

	async getConversation(run: RunId, conversationIdIn: string | number): Promise<TranscriptView> {
		const d = await this.doc(run);
		// Ids may come back as strings in the JSON from the web UI; the harness's ids are numeric.
		const conversationId = (/^\d+$/.test(String(conversationIdIn)) ? Number(conversationIdIn) : conversationIdIn) as unknown as string;
		const known = new Set(
			[d.conversations.architect, d.conversations.builder, ...d.conversations.reviewers.map((r) => r.id), ...(d.conversations.qa ?? []).map((r) => r.id)].filter((x) => x !== undefined).map(String),
		);
		const mapped = this.convIndex.get(conversationId) ?? this.convIndex.get(String(conversationId) as never);
		if (!known.has(String(conversationId)) && mapped?.run !== run) {
			const env = await this.harness.snapshot(EnvDoc, conversationId as never, this.ctx);
			if (env?.runId !== run) throw new FactoryError("not_found", `conversation ${conversationId} does not belong to run ${run}`);
		}
		return this.transcript(conversationId, this.convIndex.get(conversationId)?.role);
	}

	/** A Conversation's transcript as interfaces show it: factory input, human messages, replies, tool calls and results. */
	private async transcript(conversationId: string, role?: Role): Promise<TranscriptView> {
		const conv = await this.harness.conversation(conversationId as never, this.ctx);
		if (!conv) throw new FactoryError("not_found", `conversation ${conversationId} does not exist`);
		const items: TranscriptItem[] = [];
		const helpers = new Set<string>();
		let cursor: any;
		const entries: any[] = [];
		do {
			const page = await conv.entries({ order: "ascending" }, 500, cursor, this.ctx);
			entries.push(...page.items);
			cursor = (page as any).next ?? (page as any).cursor;
			if (!(page as any).hasMore && !(page as any).next) break;
		} while (cursor && entries.length < 5000);
		for (const e of entries) {
			const m = e.model?.[0] as any;
			if (!m) continue;
			if (m.role === "user") {
				const human = parseMessage(m.content);
				items.push(
					human
						? { entryId: e.id, kind: e.kind, role: "user", author: "human", by: human.by, msgId: human.msgId, text: human.text }
						: { entryId: e.id, kind: e.kind, role: "user", author: "factory", text: typeof m.content === "string" ? m.content : m.content.map((p: any) => p.text ?? "").join("") },
				);
			}
			else if (m.role === "assistant") {
				items.push({
					entryId: e.id,
					kind: e.kind,
					role: "assistant",
					text: m.content.filter((p: any) => p.type === "text").map((p: any) => p.text).join(""),
					toolCalls: m.content.filter((p: any) => p.type === "toolCall").map((p: any) => ({ id: p.id, name: p.name, args: p.arguments })),
				});
			} else if (m.role === "toolResult") {
				const child = (m.details as any)?.conversationId;
				if (typeof child === "string" || typeof child === "number") helpers.add(child as unknown as string);
				items.push({
					entryId: e.id,
					kind: e.kind,
					role: "tool",
					toolResult: { callId: m.toolCallId, name: m.toolName, isError: m.isError, text: m.content.map((p: any) => p.text ?? "").join(""), ...(m.details ? { details: m.details } : {}) },
				});
			}
		}
		// running tools' details (helpers spawned by an in-flight call)
		const view = await conv.viewState(this.ctx);
		const live = (view.value as any)?.docs?.["pi.live"];
		const inbox = ((view.value as any)?.docs?.["pi.inbox"]?.items ?? []) as { mode: string; content?: unknown }[];
		view.dispose?.();
		const queued = inbox.flatMap((it) => {
			const human = it.mode !== "write" ? parseMessage(it.content) : undefined;
			return human ? [{ msgId: human.msgId, by: human.by, text: human.text }] : [];
		});
		for (const slot of Object.values((live?.tools ?? {}) as Record<string, any>)) {
			const child = slot?.details?.conversationId;
			if (typeof child === "string" || typeof child === "number") helpers.add(child as unknown as string);
		}
		const busy = !!live && (live.generation !== undefined || Object.keys(live.tools ?? {}).length > 0);
		return { conversationId, ...(role ? { role } : {}), items, helpers: [...helpers], busy, queued };
	}

	async cancelRun(run: RunId, reason?: string): Promise<void> {
		const by = this.by;
		const d = await this.doc(run);
		if (TERMINAL_STATES.includes(d.state)) throw new FactoryError("conflict", `run ${run} is already ${d.state}`);
		await this.root.commit(async (tx) => {
			const doc = (await tx.doc(RunDoc, run, null as never)) as unknown as RunDocState;
			doc.cancelReason = reason ?? `cancelled by ${by}`;
		}, this.ctx);
		await this.harness.abortTask(d.taskId as never, this.ctx);
	}

	async retryRun(run: RunId): Promise<void> {
		const by = this.by;
		const d = await this.doc(run);
		if (d.state !== "FAILED" && d.state !== "CANCELLED") throw new FactoryError("conflict", `run ${run} is ${d.state}; only FAILED or CANCELLED runs can be retried`);
		const old = await this.harness.getTask(d.taskId as never, this.ctx);
		if (old && old.state.status !== "terminal") throw new FactoryError("conflict", `run ${run} is still finishing; retry in a moment`);
		await this.root.commit(async (tx) => {
			const doc = (await tx.doc(RunDoc, run, null as never)) as unknown as RunDocState;
			const f = doc.failure!;
			const to: RunState = f.state === "DELIVERED" || f.state === "FAILED" || f.state === "CANCELLED" ? "RECEIVED" : f.state;
			doc.history.push({ from: doc.state, to, at: this.now(), round: doc.counters.reviewRound });
			doc.state = to;
			if (f.gate) doc.gate = f.gate;
			if (f.pendingAsk) doc.pendingAsk = f.pendingAsk;
			delete doc.failure;
			delete doc.cancelReason;
			delete doc.driving;
			doc.counters.attempt = (doc.counters.attempt ?? 0) + 1;
			doc.notices.push({ at: this.now(), level: "info", text: `Retried by ${by}; resuming at ${to}` });
			const taskId = await tx.createTask(this.runTask, { runId: run, start: to }, { ownership: { kind: "conversation" }, background: true });
			doc.taskId = taskId as unknown as string;
		}, this.ctx);
		this.harness.resume();
	}

	// ------------------------------------------------------------------ answers to pending asks
	private async respond(run: RunId, check: (d: RunDocState) => string | undefined, response: AskResponse): Promise<void> {
		await this.root.commit(async (tx) => {
			const d = (await tx.doc(RunDoc, run, null as never)) as unknown as RunDocState;
			if (!d?.id) throw new FactoryError("not_found", `run ${run} does not exist`);
			const problem = !d.pendingAsk ? "the run has no pending ask" : d.pendingAsk.response ? "that ask was already answered" : check(d);
			if (problem) throw new FactoryError("not_pending", problem);
			d.pendingAsk!.response = response as any;
			d.updatedAt = this.now();
		}, this.ctx);
	}

	async answer(run: RunId, ask: AskId, text: string): Promise<void> {
		if (!text?.trim()) throw new FactoryError("invalid", "an answer is required");
		await this.respond(run, (d) => (d.pendingAsk!.id !== ask ? `ask ${ask} is not pending` : d.pendingAsk!.question.kind !== "discussion" ? "the pending ask is not a discussion question" : undefined), {
			type: "answer",
			text,
			by: this.by,
		});
	}

	private gateCheck(gate: Gate) {
		return (d: RunDocState) => {
			const q = d.pendingAsk!.question;
			return q.kind !== "approval" || q.gate !== gate ? `no ${gate} approval is pending` : undefined;
		};
	}

	async approve(run: RunId, gate: Gate): Promise<void> {
		await this.respond(run, this.gateCheck(gate), { type: "approve", by: this.by });
	}

	async reject(run: RunId, gate: Gate, feedback: string): Promise<void> {
		if (!feedback?.trim()) throw new FactoryError("invalid", "a rejection needs feedback");
		const findings: HumanFinding[] = gate === "spec" ? [] : [{ severity: "blocking", description: feedback }];
		await this.respond(run, this.gateCheck(gate), { type: "reject", feedback, findings, by: this.by });
	}

	async submitHumanFindings(run: RunId, gate: "delivery" | "merge", findings: HumanFinding[]): Promise<void> {
		const checked = humanFindings(findings);
		if (!checked.ok) throw new FactoryError("invalid", checked.problems.join("; "));
		await this.respond(run, this.gateCheck(gate), {
			type: "reject",
			feedback: findings.map((f) => f.description).join("\n"),
			findings: findings.map((f) => ({ severity: f.severity, description: f.description, ...(f.specRef ? { specRef: f.specRef } : {}), ...(f.evidence ? { evidence: f.evidence } : {}) })),
			by: this.by,
		});
	}

	async resolveEscalation(run: RunId, ask: AskId, choice: { accept: true } | { moreRounds: number } | { abort: true }): Promise<void> {
		if ("moreRounds" in choice && (!Number.isInteger(choice.moreRounds) || choice.moreRounds < 1 || choice.moreRounds > 10))
			throw new FactoryError("invalid", "moreRounds must be an integer from 1 to 10");
		if (!("accept" in choice) && !("moreRounds" in choice) && !("abort" in choice)) throw new FactoryError("invalid", "choose accept, moreRounds or abort");
		await this.respond(run, (d) => (d.pendingAsk!.id !== ask ? `ask ${ask} is not pending` : d.pendingAsk!.question.kind !== "escalation" ? "the pending ask is not an escalation" : undefined), {
			type: "escalation",
			choice,
			by: this.by,
		});
	}

	// ------------------------------------------------------------------ messages to the agent the run is with
	async message(run: RunId, text: string): Promise<{ message: string; to: Role; conversationId?: string }> {
		const by = this.by;
		if (typeof text !== "string" || !text.trim()) throw new FactoryError("invalid", "a message needs text");
		await this.doc(run); // not_found
		let msg!: HumanMessage;
		await this.root.commit(async (tx) => {
			const d = (await tx.doc(RunDoc, run, null as never)) as unknown as RunDocState;
			if (!d?.id) throw new FactoryError("not_found", `run ${run} does not exist`);
			if (TERMINAL_STATES.includes(d.state)) throw new FactoryError("conflict", `run ${run} is ${d.state}; start a new run for follow-up work`);
			if (d.pendingAsk && !d.pendingAsk.response && d.pendingAsk.question.kind === "discussion")
				throw new FactoryError("conflict", "the architect is waiting for an answer to its question; send it with answer");
			const target = messageTarget(d);
			const allowed = (d.pinned.config.policy?.messages ?? DEFAULT_MESSAGE_ROLES) as Role[];
			if (!allowed.includes(target.role)) throw new FactoryError("conflict", `messages to the ${target.role} are turned off for this run (policy.messages)`);
			d.counters.msgSeq = (d.counters.msgSeq ?? 0) + 1;
			msg = { id: `${d.id}-msg${d.counters.msgSeq}`, text: text.trim(), by, to: target.role, at: this.now() };
			// (assign, then push through the document: a push onto the assigned array itself would not be recorded)
			if (!d.messages) d.messages = [];
			d.messages.push(msg);
			d.updatedAt = this.now();
		}, this.ctx);
		// Re-read after the commit: if the core started the role's turn meanwhile, deliver now (request ids make a
		// second delivery by the run task a no-op).
		const d = await this.doc(run);
		const target = messageTarget(d);
		if (target.role === msg.to && target.conversationId !== undefined && !holdMessage(d, target)) await this.deliver(d, msg, target.conversationId);
		const now = (await this.doc(run)).messages?.find((m) => m.id === msg.id);
		return { message: msg.id, to: msg.to, ...(now?.conversationId !== undefined ? { conversationId: String(now.conversationId) } : {}) };
	}

	private async deliver(d: RunDocState, msg: HumanMessage, conversationId: string) {
		const id = (/^\d+$/.test(String(conversationId)) ? Number(conversationId) : conversationId) as never;
		const conv = await this.harness.conversation(id, this.ctx);
		if (!conv) return;
		const view = await conv.viewState(this.ctx);
		const live = (view.value as any)?.docs?.["pi.live"];
		view.dispose?.();
		const idle = !live || (live.generation === undefined && Object.keys(live.tools ?? {}).length === 0 && !live.run);
		const before = sumUsage((await this.harness.snapshot(UsageDoc, id, this.ctx)) as any);
		const started = this.now();
		const sub = await conv.submit({ type: "input", content: messageContent(d, msg), requestId: msg.id, whenBusy: "steer" }, this.ctx);
		await this.root.commit(async (tx) => {
			const doc = (await tx.doc(RunDoc, d.id, null as never)) as unknown as RunDocState;
			const m = doc.messages?.find((x) => x.id === msg.id);
			if (m && m.conversationId === undefined) m.conversationId = String(conversationId);
		}, this.ctx);
		// An idle agent answers in a turn of its own; the core records that turn's usage when it ends.
		if (idle) void this.recordMessageTurn(d.id, msg.to, conversationId, sub, before, started).catch((e) => this.log(`message turn usage: ${e}`));
	}

	private async recordMessageTurn(run: RunId, role: Role, conversationId: string, sub: Submission, before: UsageSum, started: number) {
		await sub.wait(this.ctx);
		const id = (/^\d+$/.test(String(conversationId)) ? Number(conversationId) : conversationId) as never;
		const after = sumUsage((await this.harness.snapshot(UsageDoc, id, this.ctx)) as any);
		await this.root.commit(async (tx) => {
			const doc = (await tx.doc(RunDoc, run, null as never)) as unknown as RunDocState;
			if (doc?.id) addCost(doc, role, conversationId, before, after, this.now() - started, { trigger: "message" });
		}, this.ctx);
	}

	async getScreenshot(run: RunId, id: string): Promise<{ mime: string; bytes: Uint8Array }> {
		await this.doc(run); // not_found
		if (typeof id !== "string" || !/^r\d+-s\d+$/.test(id)) throw new FactoryError("invalid", `invalid screenshot id ${String(id)}`);
		const file = join(this.artifactsDir, run, "screenshots", `${id}.png`);
		if (!existsSync(file)) throw new FactoryError("not_found", `run ${run} has no screenshot ${id}`);
		return { mime: "image/png", bytes: readFileSync(file) };
	}

	// ------------------------------------------------------------------ discussions (a pre-ticket chat per project)
	async startDiscussion(project: string, d: { title?: string; message: string; model?: { model: string; thinking: string } }): Promise<DiscussionId> {
		const by = this.by;
		const p = this.config.project(project);
		const message = typeof d?.message === "string" ? d.message.trim() : "";
		if (!message) throw new FactoryError("invalid", "a discussion needs a first message");
		const explicit = typeof d?.title === "string" ? d.title.trim() : "";
		const title = explicit || deriveTitle(message);
		if (!title) throw new FactoryError("invalid", "a discussion needs a title");
		const eff = this.config.effective({ project });
		const def = eff.discussion?.model ?? {};
		const model = d.model ? { model: String(d.model.model ?? ""), thinking: String(d.model.thinking ?? "") } : { model: String(def.model ?? ""), thinking: String(def.thinking ?? "medium") };
		const problem = this.modelProblem("model", model.model) ?? (THINKING_LEVELS.includes(model.thinking) ? undefined : `thinking: expected one of ${THINKING_LEVELS.join(", ")}`);
		if (problem) throw new FactoryError("invalid", problem);
		const now = this.now();
		let id!: DiscussionId;
		await this.root.commit(async (tx) => {
			const idx = await tx.doc(DiscussionIndex);
			id = `disc-${idx.ids.length + 1}`;
			idx.ids.push(id);
			const seed: DiscussionDocState = {
				id,
				project,
				repo: p.repo,
				title,
				state: "PREPARING",
				model,
				pinned: { config: eff },
				turn: null,
				firstMessage: { text: message, by },
				counters: { turnSeq: 0, draftSeq: 0, batch: 0 },
				drafts: [],
				notices: [],
				turnCosts: [],
				createdAt: now,
				updatedAt: now,
			};
			const doc = (await tx.doc(DiscussionDoc, id, seed as never)) as unknown as DiscussionDocState;
			doc.taskId = await this.newDiscussionTask(tx, id);
		}, this.ctx);
		this.harness.resume();
		return id;
	}

	/** A discussion Task that starts at PREPARING, created in `tx` (start, reopen, retry). */
	private async newDiscussionTask(tx: Tx, id: DiscussionId): Promise<string> {
		const taskId = await tx.createTask(this.discussionTask, { discussionId: id, start: "PREPARING" as const }, { ownership: { kind: "conversation" }, background: true });
		return taskId as unknown as string;
	}

	private async discussionDoc(id: DiscussionId): Promise<DiscussionDocState> {
		const d = typeof id === "string" ? ((await this.harness.snapshot(DiscussionDoc, id, this.ctx)) as DiscussionDocState | undefined) : undefined;
		if (!d) throw new FactoryError("not_found", `discussion ${id} does not exist`);
		return d;
	}

	private async discussionView(d: DiscussionDocState): Promise<DiscussionView> {
		const usage = d.conversationId !== undefined ? sumUsage((await this.harness.snapshot(UsageDoc, d.conversationId as never, this.ctx)) as any) : undefined;
		// The run cache, or the document for a run the watch has not delivered yet (just created by createTicket).
		const uncached = new Map<RunId, RunState | undefined>();
		for (const x of d.drafts)
			if (x.runId !== undefined && !this.cache.has(x.runId))
				uncached.set(x.runId, ((await this.harness.snapshot(RunDoc, x.runId, this.ctx)) as RunDocState | undefined)?.state);
		return toDiscussionView(d, { usd: usage?.usd ?? 0, totalTokens: usage?.totalTokens ?? 0 }, (run) => this.cache.get(run)?.state ?? uncached.get(run));
	}

	async getDiscussion(id: DiscussionId): Promise<DiscussionView> {
		return this.discussionView(await this.discussionDoc(id));
	}

	async listDiscussions(filter?: { project?: string; states?: DiscussionState[] }): Promise<DiscussionView[]> {
		checkStates(filter?.states, DISCUSSION_STATES);
		const idx = await this.harness.snapshot(DiscussionIndex, this.ctx);
		const out: DiscussionView[] = [];
		for (const id of idx?.ids ?? []) {
			const d = await this.discussionDoc(id);
			if (filter?.project && d.project !== filter.project) continue;
			if (filter?.states && !filter.states.includes(d.state)) continue;
			out.push(await this.discussionView(d));
		}
		return out;
	}

	async getDiscussionConversation(id: DiscussionId): Promise<TranscriptView> {
		const d = await this.discussionDoc(id);
		if (d.conversationId === undefined) throw new FactoryError("not_found", `discussion ${id} has no conversation yet (${d.state})`);
		return this.transcript(d.conversationId, "discussant");
	}

	/** Change a discussion in one commit; `change` checks the state and throws a FactoryError to refuse. */
	private async changeDiscussion<T>(id: DiscussionId, change: (d: DiscussionDocState, tx: Tx) => T | Promise<T>): Promise<T> {
		await this.discussionDoc(id); // not_found
		let out!: T;
		await this.root.commit(async (tx) => {
			const d = (await tx.doc(DiscussionDoc, id, null as never)) as unknown as DiscussionDocState;
			out = await change(d, tx);
			d.updatedAt = this.now();
		}, this.ctx);
		return out;
	}

	async say(id: DiscussionId, text: string): Promise<void> {
		const by = this.by;
		if (typeof text !== "string" || !text.trim()) throw new FactoryError("invalid", "say needs text");
		await this.changeDiscussion(id, (d) => {
			if (d.state !== "OPEN") throw new FactoryError("conflict", `discussion ${id} is ${d.state}; only an OPEN discussion takes messages`);
			if (d.turn) throw new FactoryError("conflict", `discussion ${id} has a turn running; wait for the reply or stop it`);
			d.counters.turnSeq += 1;
			const seq = d.counters.turnSeq;
			const note = takeCheckoutNote(d);
			d.turn = { kind: "say", key: `${id}:turn${seq}`, seq, text: text.trim(), by, msgId: `${id}-msg${seq}`, startedAt: this.now(), ...(note ? { note } : {}) };
		});
	}

	async stopTurn(id: DiscussionId): Promise<void> {
		const by = this.by;
		const { key, conversationId } = await this.changeDiscussion(id, (d) => {
			if (!d.turn) throw new FactoryError("conflict", `discussion ${id} has no turn running`);
			d.turn.stopRequested = true;
			d.turn.stoppedBy = by;
			return { key: d.turn.key, conversationId: d.conversationId };
		});
		// The Task clears the turn and adds the notice once the Conversation's work has stopped.
		if (conversationId === undefined) return;
		const conv = await this.harness.conversation(conversationId as never, this.ctx);
		// A late Stop must not abort the next turn: abort only while the stopped turn is still the one running (if it
		// already ended, the Task saw the request; the Task also delivers a Stop this abort misses).
		if ((await this.discussionDoc(id)).turn?.key !== key) return;
		await conv?.abort(this.ctx);
	}

	async requestDrafts(id: DiscussionId, instructions?: string): Promise<void> {
		const by = this.by;
		if (instructions !== undefined && typeof instructions !== "string") throw new FactoryError("invalid", "instructions must be text");
		await this.changeDiscussion(id, async (d, tx) => {
			if (d.state !== "OPEN") throw new FactoryError("conflict", `discussion ${id} is ${d.state}; only an OPEN discussion can draft tickets`);
			if (d.turn) throw new FactoryError("conflict", `discussion ${id} has a turn running; wait for it or stop it`);
			d.counters.turnSeq += 1;
			const seq = d.counters.turnSeq;
			const key = `${id}:turn${seq}`;
			// The drafts so far (spec §2.2): converted ones must not come back, the others are built on.
			const context = {
				tickets: d.drafts.filter((x) => x.runId !== undefined).map((x) => ({ title: x.title, runId: x.runId! })),
				drafts: d.drafts.filter((x) => x.runId === undefined).map((x) => ({ title: x.title, body: x.body, edited: x.edited })),
			};
			const note = takeCheckoutNote(d);
			const text = draftInstructions(instructions, context);
			d.turn = { kind: "draft", key, seq, text: note ? `${text}\n\n# Factory note\n${note}` : text, by, startedAt: this.now() };
			// The bridge takes submit_tickets for this turn only; the Task clears `expect` when the turn ends.
			const b = await tx.doc(BridgeDoc, d.conversationId as never);
			b.expect = { key, tools: ["submit_tickets"] };
		});
	}

	async updateDraft(id: DiscussionId, draft: string, change: { title?: string; body?: string }): Promise<void> {
		const { title, body } = change ?? {};
		if (title === undefined && body === undefined) throw new FactoryError("invalid", "updateDraft needs a title or a body");
		if (title !== undefined && (typeof title !== "string" || !title.trim())) throw new FactoryError("invalid", "a draft needs a title");
		if (title !== undefined && title.trim().length > 200) throw new FactoryError("invalid", "a draft's title is at most 200 characters");
		if (body !== undefined && (typeof body !== "string" || !body.trim())) throw new FactoryError("invalid", "a draft needs a body");
		await this.changeDiscussion(id, (d) => {
			const x = this.editableDraft(d, draft);
			if (title !== undefined) x.title = title.trim();
			if (body !== undefined) x.body = body;
			x.edited = true;
		});
	}

	async deleteDraft(id: DiscussionId, draft: string): Promise<void> {
		await this.changeDiscussion(id, (d) => {
			const x = this.editableDraft(d, draft);
			d.drafts = d.drafts.filter((y) => y !== x);
		});
	}

	async createTicket(id: DiscussionId, draft: string): Promise<RunId> {
		const by = this.by; // before any await (see startRun)
		// One commit: the run (index entry, seed, Task) and the draft's runId, checked inside it, so a second call is refused.
		// Any state: a run never depends on the discussion (only a running `draft` turn locks the drafts).
		const runId = await this.changeDiscussion(id, async (d, tx) => {
			const x = this.editableDraft(d, draft);
			const discussion: DiscussionLink = {
				id,
				title: d.title,
				draftId: x.id,
				summary: d.summary ?? "",
				siblings: d.drafts.filter((y) => y !== x && y.batch === x.batch).map((y) => y.title),
			};
			const run = await this.createRunIn(tx, d.project, { source: "discussion", title: x.title, body: x.body, meta: { discussion } }, by);
			x.runId = run;
			return run;
		});
		this.harness.resume();
		return runId;
	}

	/** The draft, if the human may change it: it has not become a run and no `draft` turn is running. */
	private editableDraft(d: DiscussionDocState, draft: string) {
		const x = d.drafts.find((y) => y.id === draft);
		if (!x) throw new FactoryError("not_found", `discussion ${d.id} has no draft ${draft}`);
		if (x.runId !== undefined) throw new FactoryError("conflict", `draft ${draft} already became run ${x.runId}; it is read-only`);
		if (d.turn?.kind === "draft") throw new FactoryError("conflict", `discussion ${d.id} is drafting tickets; wait for it or stop it`);
		return x;
	}

	async closeDiscussion(id: DiscussionId): Promise<void> {
		const taskId = await this.changeDiscussion(id, (d) => {
			if (d.state !== "OPEN") throw new FactoryError("conflict", `discussion ${id} is ${d.state}; only an OPEN discussion can be closed`);
			if (d.turn) throw new FactoryError("conflict", `discussion ${id} has a turn running; stop it before closing`);
			d.state = "CLOSED";
			return d.taskId;
		});
		// The Task ends as soon as it sees the state; wait for that (briefly) so that a reopen can follow at once.
		if (taskId !== undefined) await this.harness.waitForTask(taskId as never, withAbortSignal(AbortSignal.timeout(10_000), this.ctx)).catch(() => undefined);
	}

	async reopenDiscussion(id: DiscussionId): Promise<void> {
		await this.restartDiscussion(id, "CLOSED", "reopened");
	}

	async retryDiscussion(id: DiscussionId): Promise<void> {
		await this.restartDiscussion(id, "FAILED", "retried");
	}

	/** Reopen or retry: back to PREPARING with a new Task (the Conversation is kept), like `retryRun`. */
	private async restartDiscussion(id: DiscussionId, from: "CLOSED" | "FAILED", verb: string): Promise<void> {
		const d = await this.discussionDoc(id);
		if (d.state !== from) throw new FactoryError("conflict", `discussion ${id} is ${d.state}; only a ${from} discussion can be ${verb}`);
		const old = d.taskId !== undefined ? await this.harness.getTask(d.taskId as never, this.ctx) : undefined;
		if (old && old.state.status !== "terminal") throw new FactoryError("conflict", `discussion ${id} is still finishing; try again in a moment`);
		await this.root.commit(async (tx) => {
			const doc = (await tx.doc(DiscussionDoc, id, null as never)) as unknown as DiscussionDocState;
			if (doc.state !== from) throw new FactoryError("conflict", `discussion ${id} is ${doc.state}; only a ${from} discussion can be ${verb}`);
			doc.state = "PREPARING";
			delete doc.error;
			doc.updatedAt = this.now();
			doc.taskId = await this.newDiscussionTask(tx, id);
		}, this.ctx);
		this.harness.resume();
	}

	// ------------------------------------------------------------------ settings
	settingsSchema(): Record<string, SettingField> {
		return coreSchema();
	}

	private modelProblem(path: string, model: unknown): string | undefined {
		const [provider, ...rest] = String(model ?? "").split("/");
		if (!provider || rest.length === 0) return `${path}: expected provider/modelId`;
		if (!this.opts.models.getModel(provider, rest.join("/"))) return `${path}: ${model} is not a model the model host knows (log in or add it with factory setup models)`;
		return undefined;
	}

	private coreRules(eff: Obj, _scope: Scope): string[] {
		const problems: string[] = [];
		for (const role of ["architect", "builder", "helper", "reviewer", "qa"] as Role[]) {
			const r = eff.roles?.[role];
			if (!isObj(r) || r.model === undefined) continue;
			const p = this.modelProblem(`roles.${role}.model`, r.model);
			if (p) problems.push(p);
			else if (role === "qa" && !this.acceptsImages(String(r.model))) problems.push(`roles.qa.model: ${r.model} does not accept image input (the QA agent works from screenshots)`);
		}
		const dm = eff.discussion?.model?.model;
		if (dm !== undefined) {
			const p = this.modelProblem("discussion.model.model", dm);
			if (p) problems.push(p);
		}
		if (isObj(eff.boat)) problems.push(...boatProblems(eff.boat).map((p) => `boat.${p}`));
		if (isObj(eff.github)) problems.push(...githubProblems(eff.github).map((p) => `github.${p}`));
		if (isObj(eff.sandbox)) problems.push(...sandboxProblems(eff.sandbox, dirname(this.opts.configPath)).map((p) => `sandbox.${p}`));
		if (isObj(eff.ci)) {
			const t = eff.ci.noChecksTimeout;
			if (t !== undefined && !(parseDuration(t) >= 0)) problems.push(`ci.noChecksTimeout: "${t}" is not a duration (e.g. 2m, 90s, 500ms)`);
			const fr = eff.ci.fixRounds;
			if (fr !== undefined && !Number.isInteger(fr)) problems.push("ci.fixRounds must be a whole number");
		}
		const approvals = eff.policy?.approvals ?? [];
		if (new Set(approvals).size !== approvals.length) problems.push("policy.approvals: duplicate gate");
		return problems;
	}

	async getSettings(scope: Scope): Promise<EffectiveSettings> {
		return this.config.getSettings(scope);
	}

	async setSetting(scope: Scope, path: string, value: unknown): Promise<void> {
		this.config.set(scope, path, value);
		this.emit({ type: "settings.changed", scope, path });
	}

	async unsetSetting(scope: Scope, path: string): Promise<void> {
		this.config.unset(scope, path);
		this.emit({ type: "settings.changed", scope, path });
	}

	// ------------------------------------------------------------------ test/diagnostic helpers
	get harnessForTests(): Harness {
		return this.harness;
	}

	async waitForState(run: RunId, pred: (v: RunView) => boolean, timeoutMs = 30_000): Promise<RunView> {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const v = await this.getRun(run);
			if (pred(v)) return v;
			if (Date.now() > deadline) throw new Error(`timeout waiting on run ${run}; state ${v.state}${v.failure ? ` (${v.failure.reason})` : ""}`);
			await this.changed(run, 200);
		}
	}

	async waitForDiscussion(id: DiscussionId, pred: (v: DiscussionView) => boolean, timeoutMs = 30_000): Promise<DiscussionView> {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const v = await this.getDiscussion(id);
			if (pred(v)) return v;
			if (Date.now() > deadline) throw new Error(`timeout waiting on discussion ${id}; state ${v.state}${v.error ? ` (${v.error})` : ""}${v.turn ? `; a ${v.turn.kind} turn is running` : ""}`);
			await this.changed(id, 200);
		}
	}
}
