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
	LiveDoc,
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
import { bundleOwner, type CleanedUp, Cleaner, discussionOwner, type Item, type Owner, runOwner, type SweepSource, workdirOf } from "./cleanup.ts";
import { type CapturedOwner, maxIndexSeq, nextIndexId, type ProjectDeletion, ProjectDeletions } from "./project-deletion.ts";
import { clonePath } from "../github/github.ts";
import { Bridge, BRIDGE_TOOLS, BridgeDoc, bridgeToolsNotFor, EnvDoc } from "./bridge.ts";
import { DiscussionDoc, type DiscussionDocState, DiscussionIndex, deriveTitle, toDiscussionView } from "./discussion-doc.ts";
import { createDiscussionTask, draftInstructions, takeCheckoutNote } from "./discussion-task.ts";
import { humanFindings } from "./findings.ts";
import { BundleDoc, type BundleDocState, BundleIndex, toBundleView } from "./bundle-doc.ts";
import { bundleRoleConfig, createBundleTask } from "./bundle-task.ts";
import { bundleHoldMessage, bundleMessageContent, bundleMessageTarget, DEFAULT_MESSAGE_ROLES, holdMessage, messageContent, messageTarget, parseMessage } from "./messages.ts";
import { isLegacyDelivery, RunDoc, type RunDocState, RunIndex, specPathOf, toView } from "./run-doc.ts";
import { RunConfigDoc } from "./run-config.ts";
import { createRunTask } from "./run-task.ts";
import { assertNoLegacySections, ConfigStore, coreSchema, expandHome, hashConfig, isObj, type Obj, parseDuration, THINKING_LEVELS } from "./settings.ts";
import { addCost, NO_LIVE_COST, sumUsage, unrecorded, type UsageSum } from "./usage.ts";
import {
	type AskId,
	type AskResponse,
	BUNDLE_RELEASED_STATES,
	BUNDLE_STATES,
	BUNDLE_TERMINAL_STATES,
	type BundleAskResponse,
	type BundleId,
	type BundleMember,
	type BundleState,
	type BundleView,
	type DeletedProject,
	type DiscussionId,
	type DiscussionLink,
	type DiscussionState,
	type DiscussionView,
	DISCUSSION_STATES,
	type EffectiveSettings,
	type FactoryCore,
	FactoryError,
	type FactoryEvent,
	type GcResult,
	type Gate,
	type HumanFinding,
	type HumanMessage,
	type Interrupted,
	type LiveCost,
	type LiveItem,
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

/** What a subscriber filters on: a `project` matches run, discussion and bundle events; the others only their own. */
type EventFilter = { project?: string; run?: RunId; discussion?: DiscussionId; bundle?: BundleId };

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
	private bundleTask!: ReturnType<typeof createBundleTask>;
	private listeners = new Set<{ filter: EventFilter; on: (e: FactoryEvent) => void }>();
	/** Bundle documents, as last committed (keys are bundle ids). */
	private bundles = new Map<string, BundleDocState>();
	/** Keyed by document id: run ids and discussion ids never collide. */
	private waiters = new Map<string, Set<Waiter>>();
	private cache = new Map<string, RunDocState>();
	private convIndex = new Map<string, { run: string; role: Role }>();
	private discussions = new Map<string, DiscussionDocState>();
	/** The discussant Conversation of each discussion (keys are String(conversationId)). */
	private discussionConvs = new Map<string, DiscussionId>();
	private convThrottle = new Map<string, NodeJS.Timeout>();
	/** `cost.updated`: per owner id, the 2 s throttle (and whether another change came during it) and the last total sent. */
	private costThrottle = new Map<string, { timer?: NodeJS.Timeout; dirty: boolean }>();
	private lastCost = new Map<string, string>();
	/** Stops of tool calls that were pending without a task yet (per Conversation id): aborted once their task exists. */
	private pendingStops = new Map<string, Set<string>>();
	private ctx: Context = BACKGROUND_CONTEXT;
	private now: () => number;
	private log: (msg: string) => void;
	private by = "core";
	/** Disk cleanup of finished runs, bundles and discussions (src/core/cleanup.ts). */
	private cleaner: Cleaner;
	/** Ids purged by a project deletion in this process: a late commit notification never brings them back. */
	private purged = new Set<string>();
	/** Per-project serialisation of deleteProject with the ops that create things in (or change) a project. */
	private projectLocks = new Map<string, Promise<unknown>>();
	/** Test hook: deleteProject stops right after its purge commit (as if the process were killed there). */
	haltDeletionAfterCommitForTests = false;

	constructor(private opts: CoreOptions) {
		this.now = opts.now ?? Date.now;
		this.log = opts.log ?? (() => {});
		this.cleaner = new Cleaner({ github: opts.github, sandbox: opts.sandbox, log: (m) => this.log(m), now: () => this.now() });
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
			cleanup: this.cleaner,
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
			cleanup: this.cleaner,
			bridge: Bridge,
			changed: (id, ms) => this.changed(id, ms),
			now: this.now,
			log: this.log,
		});
		this.bundleTask = createBundleTask({
			github: this.opts.github,
			sandbox: this.opts.sandbox,
			cleanup: this.cleaner,
			boat: this.opts.boat,
			artifactsDir: this.artifactsDir,
			acceptsImages: (ref) => this.acceptsImages(ref),
			bridge: Bridge,
			changed: (id, ms) => this.changed(id, ms),
			now: this.now,
			ciPollMs: this.opts.ciPollMs ?? 15_000,
			log: this.log,
		});
		this.registry.install(defineExtension({ name: "factory.core", tasks: [this.runTask, this.discussionTask, this.bundleTask] }));

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
					// A record written before commits were authored by the GitHub identity gets it first (never a shellEnv without one).
					if (this.opts.sandbox.needsCommitIdentity(b.envId)) this.opts.sandbox.setCommitIdentity(b.envId, await this.ownerCommitIdentity(b.runId));
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
		await this.migrateRuns();
		await this.loadCache();
		// An interrupted deletion's config removal is finished before any interface can call in (a same-name createProject).
		await this.finishConfigRemovals();
		this.harness.subscribeCommits((pub) => {
			for (const ch of pub.changes) {
				if (ch.type === "document" && ch.record.kind === "factory.run" && ch.record.key && ch.value) {
					const v = ch.value as unknown as RunDocState;
					setImmediate(() => this.onRunChange(v));
				} else if (ch.type === "document" && ch.record.kind === "factory.bundle" && ch.record.key && ch.value) {
					const v = ch.value as unknown as BundleDocState;
					setImmediate(() => this.onBundleChange(v));
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
					if (this.pendingStops.has(String(ch.conversationId))) {
						const cid = String(ch.conversationId);
						const v = ch.value as { tools?: { callId: string; taskId?: unknown; status: string }[] } | undefined;
						setImmediate(() => this.applyPendingStops(cid, v));
					}
					this.touchConversation(ch.conversationId as unknown as string);
				}
			}
		});
		this.harness.resume();
		void this.sweepQaVms();
		void this.sweepDisk().catch((e) => this.log(`disk sweep failed: ${e instanceof Error ? e.message : e}`));
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
			for (const run of [...this.cache.values(), ...this.bundles.values()]) if (run.pinned.config.boat?.apiKey) refs.add(String(run.pinned.config.boat.apiKey));
			const keep = (id: string, seq: number) => {
				const owner = this.cache.get(id) ?? this.bundles.get(id);
				return !!owner && owner.state === "REVIEWING" && owner.counters.reviewSeq === seq;
			};
			return await this.opts.boat.sweep([...refs], keep, this.log);
		} catch (e) {
			this.log(`QA VM sweep failed: ${e instanceof Error ? e.message : e}`);
			return [];
		}
	}

	// ------------------------------------------------------------------ disk cleanup (docs/specs/run-mv58bn4q-q2zs.md)

	private ownerOf(kind: Owner["kind"], id: string): Owner | undefined {
		if (kind === "run") {
			const d = this.cache.get(id);
			return d && runOwner(d);
		}
		if (kind === "bundle") {
			const d = this.bundles.get(id);
			return d && bundleOwner(d);
		}
		const d = this.discussions.get(id);
		return d && discussionOwner(d);
	}

	/**
	 * The commit identity of a run's, bundle's or discussion's pinned `github.identity` (through the GitHub class's cache),
	 * for an environment record that lacks one. Throws the lookup's error.
	 */
	private async ownerCommitIdentity(id: string) {
		const Doc = id.startsWith("bundle-") ? BundleDoc : id.startsWith("disc-") ? DiscussionDoc : RunDoc;
		const d = (await this.harness.snapshot(Doc as typeof RunDoc, id, this.ctx)) as { pinned?: { config?: Record<string, any> } } | undefined;
		if (!d?.pinned?.config) throw new Error(`cannot resolve the commit identity for ${id}: its Document has no pinned config`);
		return this.opts.github.commitIdentity({ runId: id, config: d.pinned.config });
	}

	/** The owner as committed now (from storage, not the cache). */
	private async rereadOwner(kind: Owner["kind"], id: string): Promise<Owner | undefined> {
		if (kind === "run") {
			const d = (await this.harness.snapshot(RunDoc, id, this.ctx)) as RunDocState | undefined;
			return d?.id ? runOwner(d) : undefined;
		}
		if (kind === "bundle") {
			const d = (await this.harness.snapshot(BundleDoc, id, this.ctx)) as BundleDocState | undefined;
			return d?.id ? bundleOwner(d) : undefined;
		}
		const d = (await this.harness.snapshot(DiscussionDoc, id, this.ctx)) as DiscussionDocState | undefined;
		return d?.id ? discussionOwner(d) : undefined;
	}

	/** Record a cleanup in the owner's Document (never downgraded; `full` is final). */
	private async commitCleanedUp(kind: Owner["kind"], id: string, m: CleanedUp): Promise<void> {
		const Doc = kind === "run" ? RunDoc : kind === "bundle" ? BundleDoc : DiscussionDoc;
		await this.root.commit(async (tx) => {
			const d = (await tx.doc(Doc as typeof RunDoc, id, null as never)) as unknown as { id?: string; cleanedUp?: CleanedUp };
			if (!d?.id || d.cleanedUp?.scope === "full") return;
			d.cleanedUp = m;
		}, this.ctx);
		// The caches follow commits on the next tick; the sweep's clone pass reads them.
		await new Promise((r) => setImmediate(r));
	}

	/** Start a cleanup of an owner in the background; the scope comes from its state when the cleanup starts. */
	private cleanInBackground(kind: Owner["kind"], id: string): void {
		// The owner (and so the scope) is read again from storage inside the owner's lock, just before acting.
		const o: Owner = this.ownerOf(kind, id) ?? { kind, id, repo: "", state: "", config: {} };
		this.cleaner.background(
			this.cleaner.cleanup(o, "full", {
				recheck: () => this.rereadOwner(kind, id),
				commit: (m) => this.commitCleanedUp(kind, id, m),
			}),
		);
	}

	private sweepSource(): SweepSource {
		const all = () => [
			...[...this.cache.values()].map((d) => runOwner(d)),
			...[...this.bundles.values()].map((d) => bundleOwner(d)),
			...[...this.discussions.values()].map((d) => discussionOwner(d)),
		];
		return {
			owners: all,
			reread: (o) => this.rereadOwner(o.kind, o.id),
			taskLive: async (o) => {
				if (o.taskId === undefined) return false;
				const t = await this.harness.getTask(o.taskId as never, this.ctx);
				return !!t && t.state.status !== "terminal";
			},
			commit: (o, m) => this.commitCleanedUp(o.kind, o.id, m),
			known: (id) => this.ownerOf("run", id) ?? this.ownerOf("bundle", id) ?? this.ownerOf("discussion", id),
			globalWorkdir: () => this.globalWorkdir(),
			deletions: () => this.finishDeletions(),
		};
	}

	/** The startup sweep (spec "Startup sweep"): records, then orphans, then one summary line. Single flight. */
	private sweepDisk(): Promise<GcResult> {
		return this.cleaner.sweep(this.sweepSource()).then((r) => ({ removed: r.removed, failures: r.failures, summary: r.summary }));
	}

	async gc(): Promise<GcResult> {
		return this.sweepDisk();
	}

	/** Test hook: every background cleanup (clearRuns, cancelBundle) and any running sweep has finished. */
	cleanupsSettledForTests(): Promise<void> {
		return this.cleaner.settled();
	}

	/** Test hook: run the startup sweep again. */
	sweepForTests(): Promise<string[]> {
		return this.sweepQaVms();
	}

	async close(): Promise<void> {
		for (const t of this.convThrottle.values()) clearTimeout(t);
		for (const t of this.costThrottle.values()) if (t.timer) clearTimeout(t.timer);
		this.costThrottle.clear();
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
		const bidx = await this.harness.snapshot(BundleIndex, this.ctx);
		for (const id of bidx?.ids ?? []) {
			const d = (await this.harness.snapshot(BundleDoc, id, this.ctx)) as BundleDocState | undefined;
			if (d) this.indexBundle(d);
		}
		const didx = await this.harness.snapshot(DiscussionIndex, this.ctx);
		for (const id of didx?.ids ?? []) {
			const d = (await this.harness.snapshot(DiscussionDoc, id, this.ctx)) as DiscussionDocState | undefined;
			if (d) this.indexDiscussion(d);
		}
	}

	private indexDiscussion(d: DiscussionDocState) {
		if (this.purged.has(d.id)) return;
		this.discussions.set(d.id, structuredClone(d));
		if (d.conversationId !== undefined) this.discussionConvs.set(String(d.conversationId), d.id);
	}

	private onDiscussionChange(v: DiscussionDocState) {
		if (this.purged.has(v.id)) return;
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
		if (this.purged.has(d.id)) return;
		this.cache.set(d.id, structuredClone(d));
		if (d.conversations.architect) this.convIndex.set(d.conversations.architect, { run: d.id, role: "architect" });
		if (d.conversations.builder) this.convIndex.set(d.conversations.builder, { run: d.id, role: "builder" });
		for (const r of d.conversations.reviewers) this.convIndex.set(r.id, { run: d.id, role: "reviewer" });
		for (const r of d.conversations.qa ?? []) this.convIndex.set(r.id, { run: d.id, role: "qa" });
	}

	private onRunChange(v: RunDocState) {
		if (this.purged.has(v.id)) return;
		const prev = this.cache.get(v.id);
		this.indexRun(v);
		const ws = this.waiters.get(v.id);
		if (ws) for (const w of [...ws]) w();
		const scope = { project: v.project, run: v.id };
		const hist = v.history.slice(prev?.history.length ?? 0);
		for (const h of hist) this.emit({ type: "run.state", run: v.id, project: v.project, from: h.from, to: h.to, round: h.round }, scope);
		if (v.cleared && !prev?.cleared) this.emit({ type: "run.cleared", run: v.id, project: v.project }, scope);
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
					this.costTick("discussion", disc.id);
					return;
				}
				const m = this.convIndex.get(id) ?? this.convIndex.get(String(id));
				if (!m) return;
				const bundle = this.bundles.get(m.run);
				if (bundle) {
					this.emit({ type: "bundle.conversation.updated", bundle: bundle.id, conversationId: id, role: m.role }, { project: bundle.project, bundle: bundle.id });
					this.costTick("bundle", bundle.id);
					return;
				}
				const run = this.cache.get(m.run);
				if (run) {
					this.emit({ type: "conversation.updated", run: m.run, conversationId: id, role: m.role }, { project: run.project, run: run.id });
					this.costTick("run", run.id);
				}
			}, 150),
		);
	}

	// ------------------------------------------------------------------ live cost (docs/specs/run-mv8t6vsz-pmy8.md §4)
	private conversationId(x: string | number): string {
		return (/^\d+$/.test(String(x)) ? Number(x) : x) as unknown as string;
	}

	private async usageNow(conversationId: string): Promise<UsageSum> {
		return sumUsage((await this.harness.snapshot(UsageDoc, this.conversationId(conversationId) as never, this.ctx)) as any);
	}

	private async liveState(conversationId: string): Promise<{ run?: unknown; generation?: unknown; tools?: { callId: string; name: string; taskId?: unknown; status: string; details?: any }[] } | undefined> {
		return (await this.harness.snapshot(LiveDoc, this.conversationId(conversationId) as never, this.ctx)) as any;
	}

	/**
	 * The usage of a run's or bundle's Conversations that no cost record contains yet: per Conversation, its usage now
	 * minus the larger of what the Document recorded and what the current turn started from; a builder's running
	 * helpers count in full (their spend reaches the builder's own usage only when their subagent call returns).
	 * Conversations the core never accounted (none recorded, no turn started since this existed) are left out.
	 */
	private async liveCostOf(d: RunDocState | BundleDocState): Promise<LiveCost> {
		const terminal = d.id.startsWith("bundle-") ? BUNDLE_TERMINAL_STATES.includes(d.state as BundleState) : TERMINAL_STATES.includes(d.state as RunState);
		if (terminal) return NO_LIVE_COST;
		const c = d.conversations as { architect?: string; builder?: string; integrator?: string; reviewers: { id: string }[]; qa?: { id: string }[] };
		const convs: [Role, string][] = [
			...(c.architect !== undefined ? [["architect", c.architect] as [Role, string]] : []),
			...(c.builder !== undefined ? [["builder", c.builder] as [Role, string]] : []),
			...(c.integrator !== undefined ? [["integrator", c.integrator] as [Role, string]] : []),
			...c.reviewers.map((r) => ["reviewer", r.id] as [Role, string]),
			...(c.qa ?? []).map((r) => ["qa", r.id] as [Role, string]),
		];
		const byRole: LiveCost["byRole"] = [];
		for (const [role, cid] of convs) {
			const key = String(cid);
			const recorded = d.usage?.[key];
			const base = d.usageBase?.[key];
			if (!recorded && !base) continue;
			const part = unrecorded(await this.usageNow(cid), recorded, base);
			if (role === "builder") {
				const live = await this.liveState(cid);
				for (const slot of live?.tools ?? []) {
					const child = slot.details?.conversationId;
					if (slot.status === "done" || (typeof child !== "string" && typeof child !== "number")) continue;
					const u = await this.usageNow(child as string);
					part.usd += u.usd;
					part.totalTokens += u.totalTokens;
				}
			}
			if (part.usd > 0 || part.totalTokens > 0) byRole.push({ role, conversationId: key, usd: part.usd, totalTokens: part.totalTokens });
		}
		return { usd: byRole.reduce((s, x) => s + x.usd, 0), totalTokens: byRole.reduce((s, x) => s + x.totalTokens, 0), byRole };
	}

	/** A discussion's recorded cost (turns that ended) and its running turn's unrecorded usage. */
	private async discussionCost(d: DiscussionDocState): Promise<{ cost: { usd: number; totalTokens: number }; live: { usd: number; totalTokens: number } }> {
		if (d.conversationId === undefined) return { cost: { usd: 0, totalTokens: 0 }, live: { usd: 0, totalTokens: 0 } };
		const now = await this.usageNow(d.conversationId);
		const live = d.turn?.usage0 ? unrecorded(now, undefined, d.turn.usage0) : { usd: 0, totalTokens: 0 };
		return { cost: { usd: Math.max(0, now.usd - live.usd), totalTokens: Math.max(0, now.totalTokens - live.totalTokens) }, live };
	}

	/** An owner's total (recorded plus live), as `cost.updated` carries it. */
	private async ownerTotal(kind: "run" | "bundle" | "discussion", id: string): Promise<{ project: string; usd: number; totalTokens: number } | undefined> {
		if (kind === "discussion") {
			const d = this.discussions.get(id);
			if (!d) return undefined;
			const { cost, live } = await this.discussionCost(d);
			return { project: d.project, usd: cost.usd + live.usd, totalTokens: cost.totalTokens + live.totalTokens };
		}
		const d = kind === "run" ? this.cache.get(id) : this.bundles.get(id);
		if (!d) return undefined;
		const live = await this.liveCostOf(d);
		return { project: d.project, usd: d.cost.reduce((s, x) => s + (x.usd ?? 0), 0) + live.usd, totalTokens: d.cost.reduce((s, x) => s + (x.totalTokens ?? 0), 0) + live.totalTokens };
	}

	/** An owner's Conversation changed: send `cost.updated` if its total changed (at most once per 2 s per owner). */
	private costTick(kind: "run" | "bundle" | "discussion", id: string) {
		const held = this.costThrottle.get(id);
		if (held) {
			held.dirty = true;
			return;
		}
		const slot: { timer?: NodeJS.Timeout; dirty: boolean } = { dirty: false };
		this.costThrottle.set(id, slot);
		void this.ownerTotal(kind, id)
			.then((t) => {
				if (!t || this.purged.has(id)) return;
				const sig = `${t.usd.toFixed(9)}|${t.totalTokens}`;
				if (this.lastCost.get(id) === sig) return;
				const first = !this.lastCost.has(id);
				this.lastCost.set(id, sig);
				// the first look at an owner after a start only learns its total, unless it is working now
				if (first && t.usd === 0 && t.totalTokens === 0) return;
				this.emit({ type: "cost.updated", project: t.project, [kind]: id, usd: t.usd, totalTokens: t.totalTokens } as FactoryEvent, { project: t.project, [kind]: id });
			})
			.catch((e) => this.log(`cost update for ${id}: ${e instanceof Error ? e.message : e}`))
			.finally(() => {
				if (this.costThrottle.get(id) !== slot) return;
				slot.timer = setTimeout(() => {
					this.costThrottle.delete(id);
					if (slot.dirty) this.costTick(kind, id);
				}, 2000);
			});
	}

	/** `scope`: whose event it is. A `run`, `discussion` or `bundle` filter only matches events of that one. */
	private emit(e: FactoryEvent, scope?: { project: string; run?: string; discussion?: string; bundle?: string }) {
		for (const l of [...this.listeners]) {
			if (l.filter.run && l.filter.run !== scope?.run) continue;
			if (l.filter.discussion && l.filter.discussion !== scope?.discussion) continue;
			if (l.filter.bundle && l.filter.bundle !== scope?.bundle) continue;
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

	subscribe(filter: EventFilter, on: (e: FactoryEvent) => void): Unsubscribe {
		const l = { filter, on };
		this.listeners.add(l);
		return () => this.listeners.delete(l);
	}

	// ------------------------------------------------------------------ projects
	async createProject(name: string, repo: string): Promise<Project> {
		return this.withProject(name, async () => this.config.createProject(name, repo));
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

	// ------------------------------------------------------------------ deleting a project (docs/specs/run-mv86f7vs-jif2.md)

	/** Run `f` while no deletion of the project runs (and none starts): deleteProject and the ops that act in a project. */
	private withProject<T>(name: string, f: () => Promise<T>): Promise<T> {
		const key = String(name);
		const prev = this.projectLocks.get(key) ?? Promise.resolve();
		const next = prev.catch(() => undefined).then(f);
		this.projectLocks.set(key, next);
		void next
			.finally(() => {
				if (this.projectLocks.get(key) === next) this.projectLocks.delete(key);
			})
			.catch(() => undefined);
		return next;
	}

	private globalWorkdir(): string {
		return expandHome(this.config.effective({ global: true }).workdir ?? "~/factory/work");
	}

	/** A project's runs, bundles and discussions as committed (from storage, not the caches). */
	private async projectOwners(name: string): Promise<{ runs: RunDocState[]; bundles: BundleDocState[]; discussions: DiscussionDocState[] }> {
		const runs: RunDocState[] = [];
		for (const id of (await this.harness.snapshot(RunIndex, this.ctx))?.runs ?? []) {
			const d = (await this.harness.snapshot(RunDoc, id, this.ctx)) as RunDocState | undefined;
			if (d?.project === name) runs.push(d);
		}
		const bundles: BundleDocState[] = [];
		for (const id of (await this.harness.snapshot(BundleIndex, this.ctx))?.ids ?? []) {
			const d = (await this.harness.snapshot(BundleDoc, id, this.ctx)) as BundleDocState | undefined;
			if (d?.project === name) bundles.push(d);
		}
		const discussions: DiscussionDocState[] = [];
		for (const id of (await this.harness.snapshot(DiscussionIndex, this.ctx))?.ids ?? []) {
			const d = (await this.harness.snapshot(DiscussionDoc, id, this.ctx)) as DiscussionDocState | undefined;
			if (d?.project === name) discussions.push(d);
		}
		return { runs, bundles, discussions };
	}

	/**
	 * The live work (spec A1) among a project's owners: runs not DELIVERED/FAILED/CANCELLED and bundles not
	 * MERGED/CANCELLED. Discussions are never live: deleteProject ends them itself (docs/specs/run-mv89bw5w-pykq.md).
	 */
	private liveItems(o: { runs: RunDocState[]; bundles: BundleDocState[] }): LiveItem[] {
		return [
			...o.runs.filter((d) => !TERMINAL_STATES.includes(d.state)).map((d) => ({ kind: "run" as const, id: d.id, state: d.state })),
			...o.bundles.filter((d) => d.state !== "MERGED" && d.state !== "CANCELLED").map((d) => ({ kind: "bundle" as const, id: d.id, state: d.state })),
		];
	}

	/**
	 * End every PREPARING/OPEN discussion of the project by aborting its Task (the Task's abort path stops the
	 * Conversation's work, cleans the checkout, branch, scratch and environment, and commits FAILED). All are aborted
	 * first, then waited for (10 s); one whose Task has not ended makes the deletion fail with `conflict`.
	 */
	private async endDiscussions(name: string, discussions: DiscussionDocState[]): Promise<void> {
		const live = discussions.filter((d) => d.state === "PREPARING" || d.state === "OPEN");
		if (!live.length) return;
		const aborted: DiscussionDocState[] = [];
		for (const d of live) {
			if (d.taskId === undefined) continue;
			const task = await this.harness.getTask(d.taskId as never, this.ctx);
			if (!task || task.state.status === "terminal") continue;
			await this.harness.abortTask(d.taskId as never, this.ctx);
			aborted.push(d);
		}
		// The 10 s limit covers everything below: the Conversation aborts are started, not awaited (an abort resolves
		// only once the Conversation's work is idle, which a stuck tool or provider may never be).
		const deadline = withAbortSignal(AbortSignal.timeout(10_000), this.ctx);
		// A running turn (mid-reply, drafting) holds the Task's invocation until the Conversation's work ends: stop that
		// work, as Stop does, so that the aborted Task gets to its abort (cleanup, FAILED).
		for (const d of aborted) {
			const now = (await this.harness.snapshot(DiscussionDoc, d.id, this.ctx)) as DiscussionDocState | undefined;
			if (!now?.turn || now.conversationId === undefined) continue;
			void this.harness
				.conversation(now.conversationId as never, this.ctx)
				.then((conv) => conv?.abort(this.ctx))
				.catch((e) => this.log(`project deletion ${name}: could not stop discussion ${d.id}'s turn: ${e instanceof Error ? e.message : String(e)}`));
		}
		await Promise.all(aborted.map((d) => this.harness.waitForTask(d.taskId as never, deadline).catch(() => undefined)));
		const finishing: LiveItem[] = [];
		for (const d of aborted) {
			const again = await this.harness.getTask(d.taskId as never, this.ctx);
			if (again && again.state.status !== "terminal") finishing.push({ kind: "discussion", id: d.id, state: `${d.state} (still finishing)` });
		}
		if (finishing.length) throw this.liveConflict(name, finishing);
	}

	private liveConflict(name: string, live: LiveItem[]): FactoryError {
		// Only discussions still finishing (they were ended by this deletion): nothing to cancel, try again.
		const hint = live.every((l) => l.kind === "discussion") ? "try again in a moment" : "cancel it first (Cancel, Cancel bundle)";
		return new FactoryError(
			"conflict",
			`project ${name} has live work: ${live.map((l) => `${l.id} is ${l.state}`).join(", ")}; ${hint}`,
			{ live },
		);
	}

	async deleteProject(name: string): Promise<DeletedProject> {
		const by = this.by; // before any await (see startRun)
		if (typeof name !== "string" || !name) throw new FactoryError("invalid", "deleteProject needs a project name");
		return this.withProject(name, () => this.deleteProjectLocked(name, by));
	}

	private async deleteProjectLocked(name: string, by: string): Promise<DeletedProject> {
		const project = this.config.project(name); // not_found
		let owners = await this.projectOwners(name);
		const live = this.liveItems(owners);
		if (live.length) throw this.liveConflict(name, live);
		// Runs and bundles allow it: end the live discussions (nothing was touched on a refusal above).
		await this.endDiscussions(name, owners.discussions);
		owners = await this.projectOwners(name);
		// A finished owner's Task may still be ending (its last cleanup and commit): wait for it briefly.
		const all = [...owners.runs, ...owners.bundles, ...owners.discussions] as { id: string; state: string; taskId?: string }[];
		const finishing: LiveItem[] = [];
		for (const d of all) {
			if (d.taskId === undefined) continue;
			const task = await this.harness.getTask(d.taskId as never, this.ctx);
			if (!task || task.state.status === "terminal") continue;
			await this.harness.waitForTask(d.taskId as never, withAbortSignal(AbortSignal.timeout(10_000), this.ctx)).catch(() => undefined);
			const again = await this.harness.getTask(d.taskId as never, this.ctx);
			if (again && again.state.status !== "terminal") {
				const kind = d.id.startsWith("bundle-") ? "bundle" : d.id.startsWith("disc-") ? "discussion" : "run";
				finishing.push({ kind, id: d.id, state: `${d.state} (still finishing)` });
			}
		}
		if (finishing.length) throw this.liveConflict(name, finishing);
		owners = await this.projectOwners(name);
		// Whether each repo exists on the host (for the remote branch step), asked once per repo and identity.
		const exists = new Map<string, Promise<boolean | null>>();
		const repoExists = (repo: string, config: Record<string, any>) => {
			const key = JSON.stringify([repo, config.github?.identity ?? null]);
			let p = exists.get(key);
			if (!p) {
				p = this.opts.github.repoExists(repo, { runId: name, config }).catch((e) => {
					this.log(`project deletion ${name}: checking whether ${repo} exists failed (checked again at cleanup): ${e instanceof Error ? e.message : e}`);
					return null;
				});
				exists.set(key, p);
			}
			return p;
		};
		const ownerRepo = (d: { repo: string; workspace?: { repo: string } }) => d.workspace?.repo ?? d.repo;
		const known = new Map<string, boolean | null>();
		for (const d of [...owners.runs, ...owners.bundles, ...owners.discussions] as RunDocState[]) known.set(d.id, await repoExists(ownerRepo(d), d.pinned.config));
		const ids = [...owners.runs, ...owners.bundles, ...owners.discussions].map((d) => d.id);
		const result: DeletedProject = { project: name, runs: [], bundles: [], discussions: [] };
		// After any in-flight cleanup of the owners, and none starts until committed.
		const locked = ids.reduceRight<() => Promise<void>>((inner, id) => () => this.cleaner.exclusive(id, inner), () => this.purgeCommit(name, project.repo, by, known, result));
		await locked();
		for (const id of [...result.runs, ...result.bundles, ...result.discussions]) this.forget(id);
		if (this.haltDeletionAfterCommitForTests) return result;
		// 2. config
		await this.finishConfigRemovals();
		// 3. event
		this.emit({ type: "project.deleted", ...result }, { project: name });
		// 4. disk, in the background
		this.cleaner.background(this.finishDeletions());
		return result;
	}

	/** Step 1: one commit that re-checks liveness, captures and retires every owner, and records the deletion. */
	private async purgeCommit(name: string, repo: string, by: string, known: Map<string, boolean | null>, result: DeletedProject): Promise<void> {
		const now = this.now();
		const global = this.globalWorkdir();
		await this.root.commit(async (tx) => {
			result.runs = [];
			result.bundles = [];
			result.discussions = [];
			const runIdx = await tx.doc(RunIndex);
			const bundleIdx = await tx.doc(BundleIndex);
			const discIdx = await tx.doc(DiscussionIndex);
			const runs: RunDocState[] = [];
			for (const id of runIdx.runs) {
				const d = (await tx.doc(RunDoc, id, null as never)) as unknown as RunDocState;
				if (d?.project === name) runs.push(d);
			}
			const bundles: BundleDocState[] = [];
			for (const id of bundleIdx.ids) {
				const d = (await tx.doc(BundleDoc, id, null as never)) as unknown as BundleDocState;
				if (d?.project === name) bundles.push(d);
			}
			const discussions: DiscussionDocState[] = [];
			for (const id of discIdx.ids) {
				const d = (await tx.doc(DiscussionDoc, id, null as never)) as unknown as DiscussionDocState;
				if (d?.project === name) discussions.push(d);
			}
			const live = this.liveItems({ runs, bundles });
			if (live.length) throw this.liveConflict(name, live);
			// Something created meanwhile has no captured repo check: it is checked at cleanup.
			const capture = (kind: CapturedOwner["kind"], d: RunDocState | BundleDocState | DiscussionDocState): CapturedOwner => {
				const config = (d.pinned.config ?? {}) as Record<string, any>;
				return {
					kind,
					id: d.id,
					repo: (d as RunDocState).workspace?.repo ?? d.repo,
					workdir: workdirOf(config),
					...(config.github ? { github: JSON.parse(JSON.stringify(config.github)) } : {}),
					repoExists: known.has(d.id) ? known.get(d.id)! : null,
				};
			};
			const captured: CapturedOwner[] = [];
			for (const d of runs) {
				captured.push(capture("run", d));
				await tx.retireDoc(RunDoc, d.id);
				result.runs.push(d.id);
			}
			for (const d of bundles) {
				captured.push(capture("bundle", d));
				await tx.retireDoc(BundleDoc, d.id);
				result.bundles.push(d.id);
			}
			for (const d of discussions) {
				captured.push(capture("discussion", d));
				await tx.retireDoc(DiscussionDoc, d.id);
				result.discussions.push(d.id);
			}
			if (result.runs.length) runIdx.runs = runIdx.runs.filter((id) => !result.runs.includes(id));
			// The counters keep counting from the highest id ever issued (a new bundle-N never meets an old PR or branch).
			if (result.bundles.length) {
				bundleIdx.seq = maxIndexSeq(bundleIdx, "bundle-");
				bundleIdx.ids = bundleIdx.ids.filter((id) => !result.bundles.includes(id));
			}
			if (result.discussions.length) {
				discIdx.seq = maxIndexSeq(discIdx, "disc-");
				discIdx.ids = discIdx.ids.filter((id) => !result.discussions.includes(id));
			}
			const workdirs = [...new Set(captured.map((o) => o.workdir))].filter((w) => w !== global);
			const entry: ProjectDeletion = {
				id: `${name}@${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
				project: name,
				repo,
				at: now,
				by,
				owners: captured,
				configRemoved: false,
				clone: clonePath(global, repo),
				otherClones: workdirs.map((w) => clonePath(w, repo)),
			};
			(await tx.doc(ProjectDeletions)).entries.push(entry);
		}, this.ctx);
	}

	/** Drop a purged id from every cache (its Document is retired). */
	private forget(id: string): void {
		this.purged.add(id);
		this.cache.delete(id);
		this.bundles.delete(id);
		this.discussions.delete(id);
		for (const [conv, m] of this.convIndex) if (m.run === id) this.convIndex.delete(conv);
		for (const [conv, d] of this.discussionConvs) if (d === id) this.discussionConvs.delete(conv);
	}

	/** Step 2 of every recorded deletion whose config block is not removed yet (startup, deleteProject, the sweep). */
	private async finishConfigRemovals(): Promise<void> {
		const doc = await this.harness.snapshot(ProjectDeletions, this.ctx);
		for (const e of doc?.entries ?? []) {
			if (e.configRemoved) continue;
			try {
				this.config.removeProject(e.project);
			} catch (err) {
				this.log(`project deletion ${e.project}: removing projects.${e.project} from the config failed (retried by the next sweep): ${err instanceof Error ? err.message : err}`);
				continue;
			}
			await this.root.commit(async (tx) => {
				const x = (await tx.doc(ProjectDeletions)).entries.find((y) => y.id === e.id);
				if (x) x.configRemoved = true;
			}, this.ctx);
		}
	}

	/**
	 * Finish every recorded deletion (step 4, and the sweep's resumption): the config removal if missing, each owner's
	 * full cleanup and its artifacts, then the shared clones; each removed from the entry as it succeeds, the entry
	 * dropped once empty. Serialised; never throws (failures are returned and stay for a retry).
	 */
	private finishDeletions(): Promise<{ items: Item[]; failures: string[] }> {
		return this.cleaner.exclusive("project-deletions", async () => {
			const items: Item[] = [];
			const failures: string[] = [];
			await this.finishConfigRemovals().catch((e) => failures.push(`project deletions: config: ${e instanceof Error ? e.message : e}`));
			const doc = await this.harness.snapshot(ProjectDeletions, this.ctx);
			for (const e of doc?.entries ?? []) {
				const update = (change: (x: ProjectDeletion) => void) =>
					this.root.commit(async (tx) => {
						const d = await tx.doc(ProjectDeletions);
						const x = d.entries.find((y) => y.id === e.id);
						if (!x) return;
						change(x as ProjectDeletion);
						if (x.configRemoved && x.owners.length === 0 && x.clone === null && !(x.otherClones ?? []).length) d.entries = d.entries.filter((y) => y.id !== e.id);
					}, this.ctx);
				let ownersLeft = 0;
				for (const c of e.owners) {
					this.purged.add(c.id);
					const owner: Owner = { kind: c.kind, id: c.id, repo: c.repo, state: "", config: { workdir: c.workdir, ...(c.github ? { github: c.github } : {}) }, repoExists: c.repoExists };
					const r = await this.cleaner.purgeOwner(owner, this.artifactsDir);
					items.push(...r.items);
					failures.push(...r.failures.map((f) => `project ${e.project}: ${c.kind} ${c.id}: ${f}`));
					if (r.failures.length) ownersLeft++;
					else await update((x) => (x.owners = x.owners.filter((o) => o.id !== c.id)));
				}
				const clones = [...(e.clone ? [e.clone] : []), ...(e.otherClones ?? [])];
				if (ownersLeft || !e.configRemoved) continue;
				// The clone goes only if no remaining project (or record) uses the same repo; else only the branches went.
				const shared =
					this.config.projects().some((p) => p.repo === e.repo) ||
					[...this.cache.values(), ...this.bundles.values(), ...this.discussions.values()].some((d) => (d as RunDocState).repo === e.repo || (d as RunDocState).workspace?.repo === e.repo);
				const done: string[] = [];
				for (const clone of clones) {
					if (shared) {
						done.push(clone);
						continue;
					}
					const r = await this.opts.github.removeClone(clone);
					items.push(...r.removed.map((text) => ({ cat: "local" as const, text })));
					for (const f of r.failures) this.log(`project deletion: ${e.project}: clone: ${f}`);
					failures.push(...r.failures.map((f) => `project ${e.project}: ${f}`));
					if (!r.failures.length) done.push(clone);
				}
				if (shared) this.log(`project deletion: ${e.project}: the shared clone of ${e.repo} stays (another project binds the repo)`);
				await update((x) => {
					if (x.clone && done.includes(x.clone)) x.clone = null;
					x.otherClones = (x.otherClones ?? []).filter((c) => !done.includes(c));
				});
			}
			return { items, failures };
		});
	}

	/** Test/diagnostic hook: the recorded, unfinished project deletions. */
	async projectDeletionsForTests(): Promise<ProjectDeletion[]> {
		return ((await this.harness.snapshot(ProjectDeletions, this.ctx))?.entries ?? []) as ProjectDeletion[];
	}

	// ------------------------------------------------------------------ runs
	async startRun(project: string, request: Omit<Request, "id" | "project">): Promise<RunId> {
		const by = this.by; // before any await: `as(name)` sets `by` only for the synchronous part of the call
		return this.withProject(project, async () => {
			let runId!: RunId;
			await this.root.commit(async (tx) => {
				runId = await this.createRunIn(tx, project, request, by);
			}, this.ctx);
			this.harness.resume();
			return runId;
		});
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
			flowVersion: 2,
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
		const d = await this.doc(run);
		return toView(d, await this.liveCostOf(d));
	}

	/** Internal document (tests, diagnostics). */
	async runDocument(run: RunId): Promise<RunDocState> {
		return this.doc(run);
	}

	async listRuns(filter?: { project?: string; states?: RunState[]; includeCleared?: boolean }): Promise<RunView[]> {
		checkStates(filter?.states, RUN_STATES);
		if (filter?.includeCleared !== undefined && typeof filter.includeCleared !== "boolean") throw new FactoryError("invalid", "includeCleared must be a boolean");
		const idx = await this.harness.snapshot(RunIndex, this.ctx);
		const out: RunView[] = [];
		for (const id of idx?.runs ?? []) {
			const d = await this.doc(id);
			if (filter?.project && d.project !== filter.project) continue;
			if (filter?.states && !filter.states.includes(d.state)) continue;
			if (d.cleared && !filter?.includeCleared) continue;
			out.push(toView(d, await this.liveCostOf(d)));
		}
		return out;
	}

	async getConversation(run: RunId, conversationIdIn: string | number): Promise<TranscriptView> {
		const conversationId = await this.runConversation(run, conversationIdIn);
		return this.transcript(conversationId, this.convIndex.get(conversationId)?.role);
	}

	/** A Conversation of the run (its roles, QA agents and the builder's helpers), as the harness's id; else `not_found`. */
	private async runConversation(run: RunId, conversationIdIn: string | number): Promise<string> {
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
		return conversationId;
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
		/** When the response that made each call ended (for results without their own duration: a stopped call). */
		const calledAt = new Map<string, number>();
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
				for (const p of m.content) if (p.type === "toolCall" && typeof m.timestamp === "number") calledAt.set(p.id, m.timestamp);
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
				const t0 = calledAt.get(m.toolCallId);
				const durationMs = typeof m.durationMs === "number" ? m.durationMs : t0 !== undefined && typeof m.timestamp === "number" ? Math.max(0, m.timestamp - t0) : undefined;
				items.push({
					entryId: e.id,
					kind: e.kind,
					role: "tool",
					toolResult: {
						callId: m.toolCallId,
						name: m.toolName,
						isError: m.isError,
						text: m.content.map((p: any) => p.text ?? "").join(""),
						...(m.details ? { details: m.details } : {}),
						...(durationMs !== undefined ? { durationMs } : {}),
					},
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
		const running: TranscriptView["running"] = [];
		for (const slot of (live?.tools ?? []) as { callId: string; name: string; taskId?: unknown; status: string }[]) {
			if (slot.status !== "running" && slot.status !== "pending") continue;
			const task = slot.taskId !== undefined ? await this.harness.getTask(slot.taskId as never, this.ctx).catch(() => undefined) : undefined;
			const startedAt = (task as { startedAt?: number } | undefined)?.startedAt;
			running.push({ callId: slot.callId, name: slot.name, status: slot.status, ...(startedAt !== undefined ? { startedAt } : {}) });
		}
		return { conversationId, ...(role ? { role } : {}), items, helpers: [...helpers], busy, queued, running, now: Date.now() };
	}

	async cancelRun(run: RunId, reason?: string): Promise<void> {
		const by = this.by;
		const d = await this.doc(run);
		if (TERMINAL_STATES.includes(d.state)) throw new FactoryError("conflict", `run ${run} is already ${d.state}`);
		const held = this.activeBundleOf(d);
		if (held) throw new FactoryError("conflict", `run ${run} is in ${held}; drop it from the bundle or cancel the bundle first`);
		await this.root.commit(async (tx) => {
			const doc = (await tx.doc(RunDoc, run, null as never)) as unknown as RunDocState;
			doc.cancelReason = reason ?? `cancelled by ${by}`;
		}, this.ctx);
		await this.harness.abortTask(d.taskId as never, this.ctx);
	}

	async cancelRuns(runs: RunId[], reason?: string): Promise<{ cancelled: RunId[] }> {
		const by = this.by; // before any await (see cancelRun)
		if (!Array.isArray(runs) || runs.length === 0) throw new FactoryError("invalid", "cancelRuns needs a non-empty array of run ids");
		if (!runs.every((r) => typeof r === "string" && r.length > 0)) throw new FactoryError("invalid", "run ids must be non-empty strings");
		if (reason !== undefined && reason !== null && typeof reason !== "string") throw new FactoryError("invalid", "reason must be a string");
		const ids = [...new Set(runs)];
		// Check the whole call first, then set every cancelReason in one commit, then abort the tasks.
		const refuse = (d: RunDocState): FactoryError | undefined => {
			if (TERMINAL_STATES.includes(d.state)) return new FactoryError("conflict", `run ${d.id} is already ${d.state}`);
			const held = this.activeBundleOf(d);
			if (held) return new FactoryError("conflict", `run ${d.id} is in ${held}; drop it from the bundle or cancel the bundle first`);
			return undefined;
		};
		for (const id of ids) {
			const d = await this.doc(id); // not_found
			const e = refuse(d);
			if (e) throw e;
		}
		const taskIds: { id: RunId; taskId: string }[] = [];
		await this.root.commit(async (tx) => {
			const docs: RunDocState[] = [];
			for (const id of ids) {
				const d = (await tx.doc(RunDoc, id, null as never)) as unknown as RunDocState | undefined;
				if (!d?.id) throw new FactoryError("not_found", `run ${id} does not exist`);
				const e = refuse(d);
				if (e) throw e;
				docs.push(d);
			}
			for (const d of docs) {
				d.cancelReason = reason ?? `cancelled by ${by}`;
				taskIds.push({ id: d.id, taskId: d.taskId as string });
			}
		}, this.ctx);
		const cancelled: RunId[] = [];
		for (const { id, taskId } of taskIds) {
			await this.harness.abortTask(taskId as never, this.ctx);
			cancelled.push(id);
		}
		return { cancelled };
	}

	async retryRun(run: RunId): Promise<void> {
		const by = this.by;
		const d = await this.doc(run);
		if (d.cleared) throw new FactoryError("conflict", `run ${run} was cleared; it cannot be retried`);
		if (d.state !== "FAILED" && d.state !== "CANCELLED") throw new FactoryError("conflict", `run ${run} is ${d.state}; only FAILED or CANCELLED runs can be retried`);
		const old = await this.harness.getTask(d.taskId as never, this.ctx);
		if (old && old.state.status !== "terminal") throw new FactoryError("conflict", `run ${run} is still finishing; retry in a moment`);
		// After any in-flight cleanup of the run (a retry never races a scratch deletion), and none starts until committed.
		await this.cleaner.exclusive(run, () => this.root.commit(async (tx) => {
			const doc = (await tx.doc(RunDoc, run, null as never)) as unknown as RunDocState;
			if (doc.cleared) throw new FactoryError("conflict", `run ${run} was cleared; it cannot be retried`);
			if (doc.state !== "FAILED" && doc.state !== "CANCELLED") throw new FactoryError("conflict", `run ${run} is ${doc.state}; only FAILED or CANCELLED runs can be retried`);
			delete doc.cleanedUp;
			const f = doc.failure!;
			const to: RunState = f.state === "DELIVERED" || f.state === "FAILED" || f.state === "CANCELLED" ? "RECEIVED" : f.state;
			doc.history.push({ from: doc.state, to, at: this.now(), round: doc.counters.reviewRound });
			doc.state = to;
			if (f.gate) doc.gate = f.gate;
			if (f.pendingAsk) doc.pendingAsk = f.pendingAsk;
			delete doc.failure;
			delete doc.cancelReason;
			delete doc.driving;
			delete doc.interrupted;
			doc.counters.attempt = (doc.counters.attempt ?? 0) + 1;
			doc.notices.push({ at: this.now(), level: "info", text: `Retried by ${by}; resuming at ${to}` });
			const taskId = await tx.createTask(this.runTask, { runId: run, start: to }, { ownership: { kind: "conversation" }, background: true });
			doc.taskId = taskId as unknown as string;
		}, this.ctx));
		this.harness.resume();
	}

	async clearRuns(runs: RunId[]): Promise<{ cleared: RunId[] }> {
		const by = this.by; // before any await (see startRun)
		if (!Array.isArray(runs) || runs.length === 0) throw new FactoryError("invalid", "clearRuns needs a non-empty array of run ids");
		if (!runs.every((r) => typeof r === "string" && r.length > 0)) throw new FactoryError("invalid", "run ids must be non-empty strings");
		const ids = [...new Set(runs)];
		// Check the whole call first (runs are never deleted, so existence holds), then apply it in one commit.
		const conflict = (d: RunDocState) => new FactoryError("conflict", `run ${d.id} is ${d.state}; only DELIVERED, FAILED or CANCELLED runs can be cleared`);
		for (const id of ids) {
			const d = await this.doc(id); // not_found
			if (!TERMINAL_STATES.includes(d.state)) throw conflict(d);
		}
		const cleared: RunId[] = [];
		await this.root.commit(async (tx) => {
			const docs: RunDocState[] = [];
			for (const id of ids) {
				const d = (await tx.doc(RunDoc, id, null as never)) as unknown as RunDocState | undefined;
				if (!d?.id) throw new FactoryError("not_found", `run ${id} does not exist`);
				if (!TERMINAL_STATES.includes(d.state)) throw conflict(d);
				docs.push(d);
			}
			const at = this.now();
			for (const d of docs) {
				if (d.cleared) continue;
				d.cleared = { at, by };
				cleared.push(d.id);
			}
		}, this.ctx);
		// A cleared run's files and branches go now, in the background (the call does not wait for the deletion). Each
		// cleanup re-reads the run: one already fully cleaned is skipped.
		for (const id of ids) this.cleanInBackground("run", id);
		return { cleared };
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
			const held = this.activeBundleOf(d);
			if (held) throw new FactoryError("conflict", `run ${run} is in ${held}; message the bundle instead (it goes to the agent the bundle is with)`);
			if (d.pendingAsk && !d.pendingAsk.response && d.pendingAsk.question.kind === "discussion")
				throw new FactoryError("conflict", "the architect is waiting for an answer to its question; send it with answer");
			const target = messageTarget(d);
			const allowed = (d.pinned.config.policy?.messages ?? DEFAULT_MESSAGE_ROLES) as Role[];
			if (!allowed.includes(target.role)) throw new FactoryError("conflict", `messages to the ${target.role} are turned off for this run (policy.messages)`);
			d.counters.msgSeq = (d.counters.msgSeq ?? 0) + 1;
			msg = { id: `${d.id}-msg${d.counters.msgSeq}`, text: text.trim(), by, to: target.role, at: this.now() };
			this.resumeWith(d, msg, target.conversationId);
			// (assign, then push through the document: a push onto the assigned array itself would not be recorded)
			if (!d.messages) d.messages = [];
			d.messages.push(msg);
			d.updatedAt = this.now();
		}, this.ctx);
		// A message to a paused agent resumes its turn: the run Task submits it (as `msg.resume`) as the turn's next input.
		if (msg.resume) return { message: msg.id, to: msg.to, conversationId: msg.conversationId! };
		// Re-read after the commit: if the core started the role's turn meanwhile, deliver now (request ids make a
		// second delivery by the run task a no-op).
		const d = await this.doc(run);
		const target = messageTarget(d);
		if (target.role === msg.to && target.conversationId !== undefined && !holdMessage(d, target)) await this.deliver(d, msg, target.conversationId);
		const now = (await this.doc(run)).messages?.find((m) => m.id === msg.id);
		return { message: msg.id, to: msg.to, ...(now?.conversationId !== undefined ? { conversationId: String(now.conversationId) } : {}) };
	}

	private async deliver(d: RunDocState, msg: HumanMessage, conversationId: string, family: { Doc: unknown; content: { type: "text"; text: string }[] } = { Doc: RunDoc, content: messageContent(d, msg) }) {
		const id = (/^\d+$/.test(String(conversationId)) ? Number(conversationId) : conversationId) as never;
		const conv = await this.harness.conversation(id, this.ctx);
		if (!conv) return;
		const view = await conv.viewState(this.ctx);
		const live = (view.value as any)?.docs?.["pi.live"];
		view.dispose?.();
		const idle = !live || (live.generation === undefined && Object.keys(live.tools ?? {}).length === 0 && !live.run);
		const before = sumUsage((await this.harness.snapshot(UsageDoc, id, this.ctx)) as any);
		const started = this.now();
		const sub = await conv.submit({ type: "input", content: family.content, requestId: msg.id, whenBusy: "steer" }, this.ctx);
		await this.root.commit(async (tx) => {
			const doc = (await tx.doc(family.Doc as typeof RunDoc, d.id, null as never)) as unknown as RunDocState;
			const m = doc.messages?.find((x) => x.id === msg.id);
			if (m && m.conversationId === undefined) m.conversationId = String(conversationId);
		}, this.ctx);
		// An idle agent answers in a turn of its own; the core records that turn's usage when it ends.
		if (idle) void this.recordMessageTurn(d.id, msg.to, conversationId, sub, before, started, family.Doc).catch((e) => this.log(`message turn usage: ${e}`));
	}

	private async recordMessageTurn(run: RunId, role: Role, conversationId: string, sub: Submission, before: UsageSum, started: number, Doc: unknown = RunDoc) {
		await sub.wait(this.ctx);
		const id = (/^\d+$/.test(String(conversationId)) ? Number(conversationId) : conversationId) as never;
		const after = sumUsage((await this.harness.snapshot(UsageDoc, id, this.ctx)) as any);
		await this.root.commit(async (tx) => {
			const doc = (await tx.doc(Doc as typeof RunDoc, run, null as never)) as unknown as RunDocState;
			if (doc?.id) addCost(doc, role, conversationId, before, after, this.now() - started, { trigger: "message" });
		}, this.ctx);
	}

	/**
	 * Inside a message's commit: when the message goes to the agent the human paused, it becomes the paused turn's next
	 * input (request id `<key>:resume<n>`, which the Task submits) and the pause ends.
	 */
	private resumeWith(d: { interrupted?: Interrupted; messages?: HumanMessage[] }, msg: HumanMessage, conversationId: string | undefined) {
		const p = d.interrupted;
		if (!p || conversationId === undefined || String(p.conversationId) !== String(conversationId)) return;
		const n = (d.messages ?? []).filter((m) => m.resume?.startsWith(`${p.key}:resume`)).length + 1;
		msg.resume = `${p.key}:resume${n}`;
		msg.conversationId = String(conversationId);
		delete d.interrupted;
	}

	// ------------------------------------------------------------------ interrupts and stopping tool calls (§3, §2)
	async interruptAgent(run: RunId): Promise<void> {
		const by = this.by;
		const d = await this.doc(run);
		if (TERMINAL_STATES.includes(d.state)) throw new FactoryError("conflict", `run ${run} is ${d.state}`);
		const held = this.activeBundleOf(d);
		if (held) throw new FactoryError("conflict", `run ${run} is in ${held}; interrupt the bundle's agent instead`);
		const target = messageTarget(d);
		const allowed = (d.pinned.config.policy?.messages ?? DEFAULT_MESSAGE_ROLES) as Role[];
		if (!allowed.includes(target.role))
			throw new FactoryError("conflict", `the ${target.role} can't be interrupted: messages to it are turned off for this run (policy.messages), and only a message continues it`);
		await this.interrupt("run", RunDoc, d, target, ["DISCUSSING", "BUILDING", "REVIEWING"], by, (x) => messageTarget(x as RunDocState));
	}

	async interruptBundleAgent(id: BundleId): Promise<void> {
		const by = this.by;
		const d = await this.bundleDoc(id);
		if (BUNDLE_TERMINAL_STATES.includes(d.state)) throw new FactoryError("conflict", `bundle ${id} is ${d.state}`);
		const target = bundleMessageTarget(d);
		// As messageBundle: the integrator always takes messages; the reviewer only when policy.messages lists it.
		const allowed = (d.pinned.config.policy?.messages ?? DEFAULT_MESSAGE_ROLES) as Role[];
		if (target.role === "reviewer" && !allowed.includes("reviewer"))
			throw new FactoryError("conflict", `the reviewer can't be interrupted: messages to it are turned off for this project (policy.messages), and only a message continues it`);
		await this.interrupt("bundle", BundleDoc, d, target, ["INTEGRATING", "FIXING", "REVIEWING"], by, (x) => bundleMessageTarget(x as BundleDocState));
	}

	/**
	 * Interrupt the agent `target`: when the core drives it, one commit records the pause (`interrupted`) and the notice,
	 * then its Conversation is aborted (the Task waits for the next message instead of failing); otherwise only the reply
	 * in progress is aborted.
	 */
	private async interrupt(
		noun: "run" | "bundle",
		Doc: unknown,
		d: RunDocState | BundleDocState,
		target: { role: Role; conversationId?: string },
		driven: string[],
		by: string,
		targetOf: (d: RunDocState | BundleDocState) => { role: Role; conversationId?: string },
	): Promise<void> {
		const Role = target.role.charAt(0).toUpperCase() + target.role.slice(1);
		if (d.interrupted) throw new FactoryError("conflict", `${Role} is paused already; send a message to continue`);
		if (target.conversationId === undefined) throw new FactoryError("conflict", `${target.role} is not working`);
		const cid = target.conversationId;
		const live = await this.liveState(cid);
		const busy = !!live && (live.generation !== undefined || (live.tools?.length ?? 0) > 0 || live.run !== undefined);
		if (!busy) throw new FactoryError("conflict", `${target.role} is not working`);
		const terminal = noun === "run" ? (s: string) => TERMINAL_STATES.includes(s as RunState) : (s: string) => BUNDLE_TERMINAL_STATES.includes(s as BundleState);
		let paused = false;
		await this.root.commit(async (tx) => {
			const doc = (await tx.doc(Doc as typeof RunDoc, d.id, null as never)) as unknown as RunDocState | BundleDocState;
			if (terminal(doc.state)) throw new FactoryError("conflict", `${noun} ${d.id} is ${doc.state}`);
			const now = targetOf(doc);
			if (String(now.conversationId) !== String(cid)) throw new FactoryError("conflict", `${noun} ${d.id} moved on; ${target.role} is not working`);
			if (doc.interrupted) throw new FactoryError("conflict", `${Role} is paused already; send a message to continue`);
			// Core-driven: the Task is waiting for this agent's bridge tool in this state.
			paused = driven.includes(doc.state) && doc.driving !== undefined && String(doc.driving.conversationId) === String(cid);
			if (paused) doc.interrupted = { role: target.role, conversationId: String(cid), key: doc.driving!.key, at: this.now(), by };
			doc.notices.push({ at: this.now(), level: "info", text: `${Role} interrupted by you; send a message to continue` });
			doc.updatedAt = this.now();
		}, this.ctx);
		this.log(`${noun} ${d.id}: ${by} interrupted the ${target.role} (conversation ${cid})${paused ? "; paused until the next message" : ""}`);
		const conv = await this.harness.conversation(this.conversationId(cid) as never, this.ctx);
		// The abort resolves once the Conversation is idle; the call does not wait longer than 10 s for it.
		const aborting = conv?.abort(this.ctx).catch((e) => this.log(`${noun} ${d.id}: interrupting the ${target.role} failed: ${e instanceof Error ? e.message : e}`));
		let timer: NodeJS.Timeout | undefined;
		await Promise.race([aborting, new Promise((r) => (timer = setTimeout(r, 10_000)))]);
		clearTimeout(timer);
	}

	async stopToolCall(target: { run?: RunId; bundle?: BundleId; discussion?: DiscussionId; conversationId: string; callId: string }): Promise<void> {
		const by = this.by;
		if (!target || typeof target !== "object") throw new FactoryError("invalid", "stopToolCall needs { run | bundle | discussion, conversationId, callId }");
		const owners = (["run", "bundle", "discussion"] as const).filter((k) => target[k] !== undefined && target[k] !== null);
		if (owners.length !== 1) throw new FactoryError("invalid", "give exactly one of run, bundle or discussion");
		const kind = owners[0]!;
		const ownerId = target[kind]!;
		if (typeof ownerId !== "string" || !ownerId) throw new FactoryError("invalid", `${kind} must be an id`);
		if ((typeof target.conversationId !== "string" && typeof target.conversationId !== "number") || String(target.conversationId) === "")
			throw new FactoryError("invalid", "conversationId is required");
		if (typeof target.callId !== "string" || !target.callId) throw new FactoryError("invalid", "callId is required");
		let cid: string;
		if (kind === "run") cid = await this.runConversation(ownerId, target.conversationId);
		else if (kind === "bundle") cid = await this.bundleConversation(ownerId, target.conversationId);
		else {
			const d = await this.discussionDoc(ownerId);
			if (d.conversationId === undefined || String(d.conversationId) !== String(target.conversationId))
				throw new FactoryError("not_found", `conversation ${target.conversationId} does not belong to discussion ${ownerId}`);
			cid = d.conversationId;
		}
		const live = await this.liveState(cid);
		const slot = (live?.tools ?? []).find((s) => s.callId === target.callId);
		if (!slot || (slot.status !== "running" && slot.status !== "pending")) throw new FactoryError("conflict", `tool call ${target.callId} is not running`);
		if ((BRIDGE_TOOLS as readonly string[]).includes(slot.name)) throw new FactoryError("conflict", `${slot.name} can't be stopped: the factory is waiting for it`);
		if (slot.taskId !== undefined) await this.harness.abortTask(slot.taskId as never, this.ctx);
		else {
			// Not started yet (a sequential round): aborted as soon as its task exists.
			const set = this.pendingStops.get(String(cid)) ?? new Set<string>();
			set.add(slot.callId);
			this.pendingStops.set(String(cid), set);
		}
		this.log(`${kind} ${ownerId}: ${by} stopped ${slot.name} (${slot.callId}) in conversation ${cid}`);
	}

	/** Abort the pending stopped calls of a Conversation whose task now exists; forget those done or gone. */
	private applyPendingStops(cid: string, live: { tools?: { callId: string; taskId?: unknown; status: string }[] } | undefined) {
		const set = this.pendingStops.get(cid);
		if (!set) return;
		for (const callId of [...set]) {
			const slot = live?.tools?.find((s) => s.callId === callId);
			if (!slot || slot.status === "done") set.delete(callId);
			else if (slot.taskId !== undefined) {
				set.delete(callId);
				void this.harness.abortTask(slot.taskId as never, this.ctx).catch((e) => this.log(`stopping ${callId}: ${e instanceof Error ? e.message : e}`));
			}
		}
		if (!set.size) this.pendingStops.delete(cid);
	}

	async getScreenshot(run: RunId, id: string): Promise<{ mime: string; bytes: Uint8Array }> {
		await this.doc(run); // not_found
		if (typeof id !== "string" || !/^r\d+-s\d+$/.test(id)) throw new FactoryError("invalid", `invalid screenshot id ${String(id)}`);
		const file = join(this.artifactsDir, run, "screenshots", `${id}.png`);
		if (!existsSync(file)) throw new FactoryError("not_found", `run ${run} has no screenshot ${id}`);
		return { mime: "image/png", bytes: readFileSync(file) };
	}

	// ------------------------------------------------------------------ bundles (Ready runs shipped as one PR)
	/** The active bundle (not MERGED or CANCELLED) a run is in, if any. */
	private activeBundleOf(d: Pick<RunDocState, "bundle" | "bundleMerged">): string | undefined {
		if (!d.bundle || d.bundleMerged) return undefined;
		const b = this.bundles.get(d.bundle);
		return b && BUNDLE_RELEASED_STATES.includes(b.state) ? undefined : d.bundle;
	}

	/** The board's ticket key of a run (PROJECT-N, N counting the project's runs by creation), as the web UI shows it. */
	private ticketKey(run: RunDocState): string {
		const runs = [...this.cache.values()].filter((r) => r.project === run.project).sort((a, b) => a.createdAt - b.createdAt);
		const n = runs.findIndex((r) => r.id === run.id) + 1 || runs.length + 1;
		const prefix = run.project.split(/[-_.]/)[0]!.replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 6) || "RUN";
		return `${prefix}-${n}`;
	}

	async createBundle(project: string, runs: RunId[]): Promise<BundleId> {
		const by = this.by;
		return this.withProject(project, () => this.createBundleIn(project, runs, by));
	}

	private async createBundleIn(project: string, runs: RunId[], by: string): Promise<BundleId> {
		if (!Array.isArray(runs) || runs.length === 0 || !runs.every((r) => typeof r === "string")) throw new FactoryError("invalid", "a bundle needs at least one run");
		if (new Set(runs).size !== runs.length) throw new FactoryError("invalid", "a run is listed twice");
		this.config.project(project); // not_found
		const eff = this.config.effective({ project });
		// The integrator's model and thinking default to the builder's (pinned resolved, so its cost records name them).
		const config = { ...eff, roles: { ...(eff.roles ?? {}), integrator: bundleRoleConfig(eff, "integrator") } };
		for (const run of runs) if (!(await this.harness.snapshot(RunDoc, run, this.ctx))) throw new FactoryError("invalid", `run ${run} does not exist`);
		let id!: BundleId;
		await this.root.commit(async (tx) => {
			const members: BundleMember[] = [];
			for (const run of runs) {
				const d = (await tx.doc(RunDoc, run, null as never)) as unknown as RunDocState;
				if (d.project !== project) throw new FactoryError("invalid", `run ${run} belongs to project ${d.project}, not ${project}; a bundle holds tickets of one project`);
				if (d.bundle && !d.bundleMerged) {
					const b = (await tx.doc(BundleDoc, d.bundle, null as never)) as unknown as BundleDocState;
					if (b?.id && !BUNDLE_RELEASED_STATES.includes(b.state)) throw new FactoryError("conflict", `run ${run} is already in ${d.bundle} (${b.state}); a run is in at most one active bundle`);
				}
				if (d.state !== "READY") throw new FactoryError("invalid", `run ${run} is ${d.state}; only READY runs can be shipped`);
				members.push({ run, title: d.request.title, key: this.ticketKey(d), specPath: specPathOf(d), branch: d.workspace?.branch ?? `factory/${run}` });
			}
			const idx = await tx.doc(BundleIndex);
			id = nextIndexId(idx, "bundle-");
			idx.ids.push(id);
			const now = this.now();
			const seed: BundleDocState = {
				id,
				project,
				repo: this.config.project(project).repo,
				state: "INTEGRATING",
				createdAt: now,
				updatedAt: now,
				pinned: { config, configHash: hashConfig(config) },
				members,
				dropped: [],
				counters: { reviewRound: 1, ciFixes: 0, buildSeq: 0, reviewSeq: 0, askSeq: 0, findingSeq: 0, discussionSeq: 0, integration: 1 },
				caps: { review: Number(eff.policy?.reviewRoundCap ?? 3), ciFix: Number(eff.ci?.fixRounds ?? 2) },
				loop: "review",
				envs: {},
				conversations: { reviewers: [], qa: [] },
				pending: {},
				humanFindingsForReview: [],
				findingsLog: [],
				advisory: [],
				acceptedBlocking: [],
				cost: [],
				notices: [{ at: now, level: "info", text: `Shipped by ${by}: ${members.map((m) => m.key).join(", ")}` }],
				messages: [],
				history: [{ from: null, to: "INTEGRATING", at: now, round: 1 }],
			};
			const doc = (await tx.doc(BundleDoc, id, seed as never)) as unknown as BundleDocState;
			for (const m of members) {
				const d = (await tx.doc(RunDoc, m.run, null as never)) as unknown as RunDocState;
				d.bundle = id;
				d.notices.push({ at: now, level: "info", text: `Shipping in ${id}` });
				d.updatedAt = now;
			}
			doc.taskId = (await tx.createTask(this.bundleTask, { bundleId: id, start: "INTEGRATING" as BundleState }, { ownership: { kind: "conversation" }, background: true })) as unknown as string;
		}, this.ctx);
		this.harness.resume();
		return id;
	}

	private async bundleDoc(id: BundleId): Promise<BundleDocState> {
		const d = typeof id === "string" ? ((await this.harness.snapshot(BundleDoc, id, this.ctx)) as BundleDocState | undefined) : undefined;
		if (!d) throw new FactoryError("not_found", `bundle ${id} does not exist`);
		return d;
	}

	async getBundle(id: BundleId): Promise<BundleView> {
		const d = await this.bundleDoc(id);
		return toBundleView(d, await this.liveCostOf(d));
	}

	/** Internal document (tests, diagnostics). */
	async bundleDocument(id: BundleId): Promise<BundleDocState> {
		return this.bundleDoc(id);
	}

	async listBundles(filter?: { project?: string; states?: BundleState[] }): Promise<BundleView[]> {
		checkStates(filter?.states, BUNDLE_STATES);
		const idx = await this.harness.snapshot(BundleIndex, this.ctx);
		const out: BundleView[] = [];
		for (const id of idx?.ids ?? []) {
			const d = await this.bundleDoc(id);
			if (filter?.project && d.project !== filter.project) continue;
			if (filter?.states && !filter.states.includes(d.state)) continue;
			out.push(toBundleView(d, await this.liveCostOf(d)));
		}
		return out;
	}

	async getBundleConversation(id: BundleId, conversationIdIn: string | number): Promise<TranscriptView> {
		const conversationId = await this.bundleConversation(id, conversationIdIn);
		return this.transcript(conversationId, this.convIndex.get(conversationId)?.role);
	}

	/** A Conversation of the bundle (integrator, reviewers, QA agents), as the harness's id; else `not_found`. */
	private async bundleConversation(id: BundleId, conversationIdIn: string | number): Promise<string> {
		const d = await this.bundleDoc(id);
		const conversationId = (/^\d+$/.test(String(conversationIdIn)) ? Number(conversationIdIn) : conversationIdIn) as unknown as string;
		const known = new Set([d.conversations.integrator, ...d.conversations.reviewers.map((r) => r.id), ...(d.conversations.qa ?? []).map((r) => r.id)].filter((x) => x !== undefined).map(String));
		if (!known.has(String(conversationId))) {
			const env = await this.harness.snapshot(EnvDoc, conversationId as never, this.ctx);
			if (env?.runId !== id) throw new FactoryError("not_found", `conversation ${conversationId} does not belong to bundle ${id}`);
		}
		return conversationId;
	}

	/** Answer a bundle's pending ask (one commit; `check` refuses with a reason). */
	private async respondBundle(id: BundleId, check: (d: BundleDocState) => string | undefined, response: BundleAskResponse): Promise<void> {
		await this.bundleDoc(id); // not_found
		await this.root.commit(async (tx) => {
			const d = (await tx.doc(BundleDoc, id, null as never)) as unknown as BundleDocState;
			const problem = !d.pendingAsk ? `bundle ${id} is ${d.state} and waits for nothing` : d.pendingAsk.response ? "that ask was already answered" : check(d);
			if (problem) throw new FactoryError("not_pending", problem);
			d.pendingAsk!.response = response as any;
			d.updatedAt = this.now();
		}, this.ctx);
	}

	private mergeAsk = (d: BundleDocState) => (d.pendingAsk!.question.kind !== "merge" ? `bundle ${d.id} is not waiting for Merge (${d.state})` : undefined);

	async mergeBundle(id: BundleId): Promise<void> {
		await this.respondBundle(id, this.mergeAsk, { type: "merge", by: this.by });
	}

	async requestBundleChanges(id: BundleId, feedback: string): Promise<void> {
		if (typeof feedback !== "string" || !feedback.trim()) throw new FactoryError("invalid", "requesting changes needs feedback");
		await this.respondBundle(id, this.mergeAsk, { type: "changes", feedback: feedback.trim(), by: this.by });
	}

	/** Runs to drop: listed, members, and at least one member left (`all` when every member is listed). */
	private dropCheck(d: BundleDocState, runs: unknown): { all: boolean } {
		if (!Array.isArray(runs) || runs.length === 0 || !runs.every((r) => typeof r === "string")) throw new FactoryError("invalid", "choose the runs to drop");
		for (const r of runs) if (!d.members.some((m) => m.run === r)) throw new FactoryError("invalid", `run ${r} is not a member of ${d.id}`);
		return { all: d.members.every((m) => runs.includes(m.run)) };
	}

	async dropFromBundle(id: BundleId, runs: RunId[]): Promise<void> {
		const by = this.by;
		const d = await this.bundleDoc(id);
		const q = d.pendingAsk && !d.pendingAsk.response ? d.pendingAsk.question.kind : undefined;
		if (q !== "merge" && q !== "escalation") throw new FactoryError("conflict", `tickets can be dropped at the merge card or an escalation; ${id} is ${d.state}`);
		// Dropping every member is the same as cancelling.
		if (this.dropCheck(d, runs).all) return this.as(by).cancelBundle(id, `every ticket was dropped by ${by}`);
		await this.respondBundle(id, (x) => (x.pendingAsk!.question.kind !== q ? `bundle ${id} moved on` : undefined), { type: "drop", runs: [...runs], by });
	}

	async resolveBundleEscalation(id: BundleId, ask: AskId, choice: { moreRounds: number } | { drop: RunId[] } | { abort: true }): Promise<void> {
		const by = this.by;
		if (!choice || typeof choice !== "object") throw new FactoryError("invalid", "choose moreRounds, drop or abort");
		if ("moreRounds" in choice && (!Number.isInteger(choice.moreRounds) || choice.moreRounds < 1 || choice.moreRounds > 10))
			throw new FactoryError("invalid", "moreRounds must be an integer from 1 to 10");
		if (!("moreRounds" in choice) && !("drop" in choice) && !("abort" in choice)) throw new FactoryError("invalid", "choose moreRounds, drop or abort");
		const d = await this.bundleDoc(id);
		let c = choice;
		if ("drop" in choice && this.dropCheck(d, choice.drop).all) c = { abort: true };
		await this.respondBundle(id, (x) => (x.pendingAsk!.id !== ask ? `ask ${ask} is not pending` : x.pendingAsk!.question.kind !== "escalation" ? "the pending ask is not an escalation" : undefined), {
			type: "escalation",
			choice: c,
			by,
		});
	}

	async cancelBundle(id: BundleId, reason?: string): Promise<void> {
		const by = this.by;
		const d = await this.bundleDoc(id);
		if (d.state === "MERGED" || d.state === "CANCELLED") throw new FactoryError("conflict", `bundle ${id} is already ${d.state}`);
		const why = reason ?? `cancelled by ${by}`;
		const task = d.taskId !== undefined ? await this.harness.getTask(d.taskId as never, this.ctx) : undefined;
		if (task && task.state.status !== "terminal") {
			await this.root.commit(async (tx) => {
				const doc = (await tx.doc(BundleDoc, id, null as never)) as unknown as BundleDocState;
				doc.cancelReason = why;
			}, this.ctx);
			await this.harness.abortTask(d.taskId as never, this.ctx);
			return;
		}
		// A FAILED bundle (its Task has ended): close its PR and release its members here.
		if (d.delivery?.pr) await this.opts.github.closePr(d.delivery.pr, { runId: id, config: d.pinned.config }).catch((e) => this.log(`bundle ${id}: closing the PR failed: ${e}`));
		await this.root.commit(async (tx) => {
			const doc = (await tx.doc(BundleDoc, id, null as never)) as unknown as BundleDocState;
			if (doc.state === "MERGED" || doc.state === "CANCELLED") throw new FactoryError("conflict", `bundle ${id} is already ${doc.state}`);
			const now = this.now();
			for (const m of doc.members) {
				const r = (await tx.doc(RunDoc, m.run, null as never)) as unknown as RunDocState;
				if (r?.id && r.bundle === id) {
					delete r.bundle;
					r.notices.push({ at: now, level: "info", text: `Released from ${id} (${why}); back in Ready` });
					r.updatedAt = now;
				}
			}
			delete doc.pendingAsk;
			doc.notices.push({ at: now, level: "warn", text: `Cancelled in ${doc.state}: ${why}`, final: true });
			doc.history.push({ from: doc.state, to: "CANCELLED", at: now, round: doc.counters.reviewRound });
			doc.state = "CANCELLED";
			doc.updatedAt = now;
		}, this.ctx);
		// No Task cleans it: delete the bundle's own things in the background (members' branches are theirs).
		this.cleanInBackground("bundle", id);
	}

	async retryBundle(id: BundleId): Promise<void> {
		const by = this.by;
		const d = await this.bundleDoc(id);
		if (d.state !== "FAILED") throw new FactoryError("conflict", `bundle ${id} is ${d.state}; only a FAILED bundle can be retried`);
		const old = d.taskId !== undefined ? await this.harness.getTask(d.taskId as never, this.ctx) : undefined;
		if (old && old.state.status !== "terminal") throw new FactoryError("conflict", `bundle ${id} is still finishing; retry in a moment`);
		await this.cleaner.exclusive(id, () => this.root.commit(async (tx) => {
			const doc = (await tx.doc(BundleDoc, id, null as never)) as unknown as BundleDocState;
			if (doc.state !== "FAILED") throw new FactoryError("conflict", `bundle ${id} is ${doc.state}; only a FAILED bundle can be retried`);
			delete doc.cleanedUp;
			const f = doc.failure!;
			const to: BundleState = BUNDLE_TERMINAL_STATES.includes(f.state) ? "INTEGRATING" : f.state;
			doc.history.push({ from: doc.state, to, at: this.now(), round: doc.counters.reviewRound });
			doc.state = to;
			if (f.pendingAsk) doc.pendingAsk = f.pendingAsk;
			delete doc.failure;
			delete doc.driving;
			delete doc.interrupted;
			doc.counters.attempt = (doc.counters.attempt ?? 0) + 1;
			doc.notices.push({ at: this.now(), level: "info", text: `Retried by ${by}; resuming at ${to}` });
			doc.taskId = (await tx.createTask(this.bundleTask, { bundleId: id, start: to }, { ownership: { kind: "conversation" }, background: true })) as unknown as string;
		}, this.ctx));
		this.harness.resume();
	}

	async messageBundle(id: BundleId, text: string): Promise<{ message: string; to: Role; conversationId?: string }> {
		const by = this.by;
		if (typeof text !== "string" || !text.trim()) throw new FactoryError("invalid", "a message needs text");
		await this.bundleDoc(id); // not_found
		let msg!: HumanMessage;
		await this.root.commit(async (tx) => {
			const d = (await tx.doc(BundleDoc, id, null as never)) as unknown as BundleDocState;
			if (BUNDLE_TERMINAL_STATES.includes(d.state)) throw new FactoryError("conflict", `bundle ${id} is ${d.state}; it takes no messages`);
			const target = bundleMessageTarget(d);
			const allowed = (d.pinned.config.policy?.messages ?? DEFAULT_MESSAGE_ROLES) as Role[];
			if (target.role === "reviewer" && !allowed.includes("reviewer")) throw new FactoryError("conflict", `messages to the reviewer are turned off for this project (policy.messages); ${id} is being reviewed`);
			d.counters.msgSeq = (d.counters.msgSeq ?? 0) + 1;
			msg = { id: `${id}-msg${d.counters.msgSeq}`, text: text.trim(), by, to: target.role, at: this.now() };
			this.resumeWith(d, msg, target.conversationId);
			if (!d.messages) d.messages = [];
			d.messages.push(msg);
			d.updatedAt = this.now();
		}, this.ctx);
		if (msg.resume) return { message: msg.id, to: msg.to, conversationId: msg.conversationId! };
		const d = await this.bundleDoc(id);
		const target = bundleMessageTarget(d);
		if (target.role === msg.to && target.conversationId !== undefined && !bundleHoldMessage(d, target))
			await this.deliver(d as unknown as RunDocState, msg, target.conversationId, { Doc: BundleDoc, content: bundleMessageContent(d, msg) });
		const now = (await this.bundleDoc(id)).messages?.find((m) => m.id === msg.id);
		return { message: msg.id, to: msg.to, ...(now?.conversationId !== undefined ? { conversationId: String(now.conversationId) } : {}) };
	}

	async getBundleScreenshot(id: BundleId, screenshotId: string): Promise<{ mime: string; bytes: Uint8Array }> {
		await this.bundleDoc(id); // not_found
		if (typeof screenshotId !== "string" || !/^r\d+-s\d+$/.test(screenshotId)) throw new FactoryError("invalid", `invalid screenshot id ${String(screenshotId)}`);
		const file = join(this.artifactsDir, id, "screenshots", `${screenshotId}.png`);
		if (!existsSync(file)) throw new FactoryError("not_found", `bundle ${id} has no screenshot ${screenshotId}`);
		return { mime: "image/png", bytes: readFileSync(file) };
	}

	private indexBundle(d: BundleDocState) {
		if (this.purged.has(d.id)) return;
		this.bundles.set(d.id, structuredClone(d));
		if (d.conversations.integrator !== undefined) this.convIndex.set(d.conversations.integrator, { run: d.id, role: "integrator" });
		for (const r of d.conversations.reviewers) this.convIndex.set(r.id, { run: d.id, role: "reviewer" });
		for (const r of d.conversations.qa ?? []) this.convIndex.set(r.id, { run: d.id, role: "qa" });
	}

	private onBundleChange(v: BundleDocState) {
		if (this.purged.has(v.id)) return;
		const prev = this.bundles.get(v.id);
		this.indexBundle(v);
		const ws = this.waiters.get(v.id);
		if (ws) for (const w of [...ws]) w();
		const scope = { project: v.project, bundle: v.id };
		for (const h of v.history.slice(prev?.history.length ?? 0)) this.emit({ type: "bundle.state", bundle: v.id, project: v.project, from: h.from, to: h.to, round: h.round }, scope);
		const prevAsk = prev?.pendingAsk;
		if (prevAsk && !prevAsk.response && (v.pendingAsk?.id !== prevAsk.id || v.pendingAsk.response)) {
			const by = v.pendingAsk?.id === prevAsk.id ? v.pendingAsk.response!.by : "core";
			this.emit({ type: "bundle.askResolved", bundle: v.id, ask: prevAsk.id, by }, scope);
		}
		if (v.pendingAsk && !v.pendingAsk.response && v.pendingAsk.id !== prevAsk?.id) this.emit({ type: "bundle.ask", bundle: v.id, ask: v.pendingAsk.id, question: v.pendingAsk.question }, scope);
		for (const n of v.notices.slice(prev?.notices.length ?? 0)) this.emit({ type: "bundle.notice", bundle: v.id, notice: n }, scope);
	}

	/**
	 * Runs started before bundles existed (no `flowVersion`): those that had begun delivering the old way are marked
	 * `legacy` and finish with their own PR, CI and merge gate; the others take the new flow (spec §1.1). Once, before
	 * any Task resumes.
	 */
	private async migrateRuns() {
		const idx = await this.harness.snapshot(RunIndex, this.ctx);
		const old: string[] = [];
		for (const id of idx?.runs ?? []) {
			const d = (await this.harness.snapshot(RunDoc, id, this.ctx)) as RunDocState | undefined;
			if (d && d.flowVersion === undefined && !TERMINAL_STATES.includes(d.state)) old.push(id);
		}
		if (!old.length) return;
		await this.root.commit(async (tx) => {
			for (const id of old) {
				const d = (await tx.doc(RunDoc, id, null as never)) as unknown as RunDocState;
				if (isLegacyDelivery(d)) {
					d.legacy = true;
					d.notices.push({ at: this.now(), level: "info", text: "This run began delivering before bundles existed: it finishes with its own PR, CI and merge gate" });
				}
				d.flowVersion = 2;
			}
		}, this.ctx);
	}

	async waitForBundle(id: BundleId, pred: (v: BundleView) => boolean, timeoutMs = 30_000): Promise<BundleView> {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const v = await this.getBundle(id);
			if (pred(v)) return v;
			if (Date.now() > deadline) throw new Error(`timeout waiting on bundle ${id}; state ${v.state}${v.failure ? ` (${v.failure.reason})` : ""}`);
			await this.changed(id, 200);
		}
	}

	// ------------------------------------------------------------------ discussions (a pre-ticket chat per project)
	async startDiscussion(project: string, d: { title?: string; message: string; model?: { model: string; thinking: string } }): Promise<DiscussionId> {
		const by = this.by;
		return this.withProject(project, () => this.startDiscussionIn(project, d, by));
	}

	private async startDiscussionIn(project: string, d: { title?: string; message: string; model?: { model: string; thinking: string } }, by: string): Promise<DiscussionId> {
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
			id = nextIndexId(idx, "disc-");
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
		const { cost, live } = await this.discussionCost(d);
		// The run cache, or the document for a run the watch has not delivered yet (just created by createTicket).
		const uncached = new Map<RunId, RunState | undefined>();
		for (const x of d.drafts)
			if (x.runId !== undefined && !this.cache.has(x.runId))
				uncached.set(x.runId, ((await this.harness.snapshot(RunDoc, x.runId, this.ctx)) as RunDocState | undefined)?.state);
		return toDiscussionView(d, cost, live, (run) => this.cache.get(run)?.state ?? uncached.get(run));
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
		const { project } = await this.discussionDoc(id); // not_found
		return this.withProject(project, () => this.createTicketIn(id, draft, by));
	}

	private async createTicketIn(id: DiscussionId, draft: string, by: string): Promise<RunId> {
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
		const { project } = await this.discussionDoc(id); // not_found
		// Serialised with deleteProject: an ended discussion can't come back before the purge commit.
		await this.withProject(project, () => this.restartDiscussion(id, "CLOSED", "reopened"));
	}

	async retryDiscussion(id: DiscussionId): Promise<void> {
		const { project } = await this.discussionDoc(id); // not_found
		await this.withProject(project, () => this.restartDiscussion(id, "FAILED", "retried"));
	}

	/** Reopen or retry: back to PREPARING with a new Task (the Conversation is kept), like `retryRun`. */
	private async restartDiscussion(id: DiscussionId, from: "CLOSED" | "FAILED", verb: string): Promise<void> {
		const d = await this.discussionDoc(id);
		if (d.state !== from) throw new FactoryError("conflict", `discussion ${id} is ${d.state}; only a ${from} discussion can be ${verb}`);
		const old = d.taskId !== undefined ? await this.harness.getTask(d.taskId as never, this.ctx) : undefined;
		if (old && old.state.status !== "terminal") throw new FactoryError("conflict", `discussion ${id} is still finishing; try again in a moment`);
		// After any in-flight cleanup of the discussion: PREPARING re-creates the checkout and the environment.
		await this.cleaner.exclusive(id, () => this.root.commit(async (tx) => {
			const doc = (await tx.doc(DiscussionDoc, id, null as never)) as unknown as DiscussionDocState;
			if (doc.state !== from) throw new FactoryError("conflict", `discussion ${id} is ${doc.state}; only a ${from} discussion can be ${verb}`);
			doc.state = "PREPARING";
			delete doc.error;
			delete doc.cleanedUp;
			doc.updatedAt = this.now();
			doc.taskId = await this.newDiscussionTask(tx, id);
		}, this.ctx));
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
		for (const role of ["architect", "builder", "helper", "reviewer", "qa", "integrator"] as Role[]) {
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
		await this.withScope(scope, async () => this.config.set(scope, path, value));
		this.emit({ type: "settings.changed", scope, path });
	}

	async unsetSetting(scope: Scope, path: string): Promise<void> {
		await this.withScope(scope, async () => this.config.unset(scope, path));
		this.emit({ type: "settings.changed", scope, path });
	}

	/** A project scope's change waits for (and is serialised with) a deletion of that project. */
	private withScope<T>(scope: Scope, f: () => Promise<T>): Promise<T> {
		const project = scope && typeof scope === "object" && "project" in scope ? (scope as { project: unknown }).project : undefined;
		return typeof project === "string" ? this.withProject(project, f) : f();
	}

	// ------------------------------------------------------------------ test/diagnostic helpers
	get harnessForTests(): Harness {
		return this.harness;
	}

	/** Test hook: change a run's Document in one commit (e.g. mark it `legacy` to exercise the old delivery flow). */
	async patchRunForTests(run: RunId, change: (d: RunDocState) => void): Promise<void> {
		await this.doc(run);
		await this.root.commit(async (tx) => {
			change((await tx.doc(RunDoc, run, null as never)) as unknown as RunDocState);
		}, this.ctx);
	}

	/** Test hook: change a bundle's Document in one commit (e.g. drop an integration's rule mark to simulate a record from before an upgrade). */
	async patchBundleForTests(id: BundleId, change: (d: BundleDocState) => void): Promise<void> {
		await this.bundleDoc(id);
		await this.root.commit(async (tx) => {
			change((await tx.doc(BundleDoc, id, null as never)) as unknown as BundleDocState);
		}, this.ctx);
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
