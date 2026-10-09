// The factory core (spec §3.6, §4): model-free, interface-agnostic. Holds the state machine (a Pi Durable Task), the
// agent bridge, projects, layered settings and durable pending asks. Exposes operations and events; knows no interface.
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import {
	AssistantEntry,
	type Conversation,
	configure,
	createRegistry,
	defineExtension,
	type Extension,
	Harness,
	MemoryStorage,
	type Registry,
} from "@earendil-works/pi-durable";
import { createEditTool, createWriteTool } from "@earendil-works/pi-durable/tools";
import { Bridge, BridgeDoc, bridgeToolsNotFor, EnvDoc } from "./bridge.ts";
import { humanFindings } from "./findings.ts";
import { RunDoc, type RunDocState, RunIndex, toView } from "./run-doc.ts";
import { createRunTask } from "./run-task.ts";
import { ConfigStore, coreSchema, expandHome, hashConfig, isObj, type Obj } from "./settings.ts";
import {
	type AskId,
	type AskResponse,
	type DeliveryExtension,
	type EffectiveSettings,
	type EnvironmentExtension,
	type FactoryCore,
	FactoryError,
	type FactoryEvent,
	type FactoryExtension,
	type Gate,
	type HumanFinding,
	type IntakeExtension,
	type InterfaceExtension,
	type Project,
	type RepoExtension,
	type Request,
	type Role,
	type RunId,
	type RunState,
	type RunView,
	type Scope,
	type SettingField,
	TERMINAL_STATES,
	type TranscriptItem,
	type TranscriptView,
	type Unsubscribe,
} from "./types.ts";

const require = createRequire(import.meta.url);
export const PI_DURABLE_VERSION: string = require("@earendil-works/pi-durable/package.json").version;

export interface CoreOptions {
	/** Path of the config file (§5). */
	configPath: string;
	/** pi-ai models (createModels() with providers) — injected platform service (§3.1). */
	models: Models;
	/** Factory extensions (layer 2) and the environment extension (layer 3). */
	extensions: FactoryExtension[];
	/** Worker extensions (Pi Durable extensions) agents may select by name. */
	workerExtensions: Extension[];
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
	private listeners = new Set<{ filter: { project?: string; run?: RunId }; on: (e: FactoryEvent) => void }>();
	private waiters = new Map<string, Set<Waiter>>();
	private cache = new Map<string, RunDocState>();
	private convIndex = new Map<string, { run: string; role: Role }>();
	private convThrottle = new Map<string, NodeJS.Timeout>();
	private interfaces: { stop(): Promise<void> }[] = [];
	private intakeStops: (() => void)[] = [];
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
		for (const ext of this.opts.workerExtensions) this.registry.install(ext);
		this.registry.install(Bridge);
		this.runTask = createRunTask({
			repo: (cfg) => this.ext<RepoExtension>("repo", cfg.use),
			delivery: (cfg) => this.ext<DeliveryExtension>("delivery", cfg.use),
			environment: (cfg) => this.ext<EnvironmentExtension>("environment", cfg.use),
			intake: (cfg) => (cfg.use && cfg.use !== "none" ? this.ext<IntakeExtension>("intake", cfg.use) : undefined),
			workerExtensions: (role, names) => this.workerExtensionsFor(role, names),
			bridge: Bridge,
			changed: (runId, ms) => this.changed(runId, ms),
			now: this.now,
			ciPollMs: this.opts.ciPollMs ?? 15_000,
			log: this.log,
		});
		this.registry.install(defineExtension({ name: "factory.core", tasks: [this.runTask] }));

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
					const run = (await read.snapshot(RunDoc, b.runId, c)) as RunDocState | undefined;
					const envExt = this.ext<EnvironmentExtension>("environment", run?.pinned.config.stages?.environment?.use);
					return envExt.env({ conversationId: conversationId as unknown as string, ...(cwd ? { cwd } : {}), envId: b.envId });
				},
				conversationCreated: async (tx, rec) => {
					// Helpers the builder spawns (Pi's subagent pattern): read-only, the helper role's model, no bridge tools.
					if (!rec.owner) return;
					const parent = await tx.doc(EnvDoc, rec.owner.conversationId);
					if (parent.role !== "builder" || !parent.runId) return;
					const run = (await tx.doc(RunDoc, parent.runId, null as never)) as unknown as RunDocState;
					const cfg = run.pinned.config.roles?.helper ?? {};
					const helperEnv = run.envs.helper ?? run.envs.builder;
					const [provider, ...rest] = String(cfg.model ?? "").split("/");
					await configure(tx, rec.id, {
						model: { provider: provider!, modelId: rest.join("/") },
						thinkingLevel: (cfg.thinking ?? "medium") as any,
						extensions: [...this.workerExtensionsFor("helper", cfg.extensions ?? []), Bridge],
						tools: { remove: [...bridgeToolsNotFor("helper"), createWriteTool(), createEditTool()] as any },
						...(helperEnv ? { cwd: helperEnv.cwd } : {}),
					});
					const e = await tx.doc(EnvDoc, rec.id);
					e.runId = parent.runId;
					e.role = "helper";
					if (helperEnv) e.envId = helperEnv.envId;
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
				} else if (ch.type === "document" && ch.record.kind === "factory.env" && ch.conversationId && ch.value) {
					const v = ch.value as { runId?: string; role?: Role };
					if (v.runId && v.role) this.convIndex.set(ch.conversationId as unknown as string, { run: v.runId, role: v.role });
				} else if (ch.type === "entry") {
					this.touchConversation(ch.value.conversationId as unknown as string);
				} else if (ch.type === "document" && ch.record.kind === "pi.live" && ch.conversationId) {
					this.touchConversation(ch.conversationId as unknown as string);
				}
			}
		});
		this.harness.resume();
		for (const run of this.cache.values())
			if (!TERMINAL_STATES.includes(run.state) && run.pinned.piVersion !== PI_DURABLE_VERSION)
				this.log(`run ${run.id} was pinned to pi-durable ${run.pinned.piVersion}; this process runs ${PI_DURABLE_VERSION}`);
	}

	/** Start the configured interface extensions and intakes. The core never calls an interface by name. */
	async startInterfaces(): Promise<void> {
		const eff = this.config.effective({ global: true });
		for (const name of (eff.stages?.interface?.use ?? []) as string[]) {
			const ext = this.ext<InterfaceExtension>("interface", name);
			this.interfaces.push(await ext.start(this.as(ext.name)));
		}
		const intakeName = eff.stages?.intake?.use;
		if (intakeName && intakeName !== "none") {
			const intake = this.ext<IntakeExtension>("intake", intakeName);
			const take = (r: Omit<Request, "id">) =>
				void this.startRun(r.project, { ...r, source: intake.name, meta: { ...(r.meta ?? {}), intake: intake.name } }).catch((e) => this.log(`intake: ${e}`));
			if (intake.subscribe) this.intakeStops.push(intake.subscribe(take));
			const timer = setInterval(() => void intake.pull().then((rs) => rs.forEach(take)).catch((e) => this.log(`intake pull: ${e}`)), 30_000);
			this.intakeStops.push(() => clearInterval(timer));
		}
	}

	async close(): Promise<void> {
		for (const s of this.intakeStops) s();
		for (const i of this.interfaces) await i.stop().catch(() => {});
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

	// ------------------------------------------------------------------ extensions
	private ext<T extends FactoryExtension>(kind: FactoryExtension["kind"], name: string | undefined): T {
		const found = this.opts.extensions.find((e) => e.kind === kind && (name === undefined || e.name === name));
		if (!found) throw new FactoryError("not_found", `no ${kind} extension named ${name ?? "(default)"} is installed`);
		return found as T;
	}

	private workerExtensionsFor(role: Role, names: string[]): Extension[] {
		const snap = this.registry.snapshot();
		const out: Extension[] = [];
		const guide = snap.extension(`role-${role}`);
		if (guide) out.push(guide);
		for (const n of names) {
			const e = snap.extension(n);
			if (e && !out.includes(e)) out.push(e);
		}
		return out;
	}

	// ------------------------------------------------------------------ events
	private async loadCache() {
		const idx = await this.harness.snapshot(RunIndex, this.ctx);
		for (const id of idx?.runs ?? []) {
			const d = (await this.harness.snapshot(RunDoc, id, this.ctx)) as RunDocState | undefined;
			if (d) this.indexRun(d);
		}
	}

	private indexRun(d: RunDocState) {
		this.cache.set(d.id, structuredClone(d));
		if (d.conversations.architect) this.convIndex.set(d.conversations.architect, { run: d.id, role: "architect" });
		if (d.conversations.builder) this.convIndex.set(d.conversations.builder, { run: d.id, role: "builder" });
		for (const r of d.conversations.reviewers) this.convIndex.set(r.id, { run: d.id, role: "reviewer" });
	}

	private onRunChange(v: RunDocState) {
		const prev = this.cache.get(v.id);
		this.indexRun(v);
		const ws = this.waiters.get(v.id);
		if (ws) for (const w of [...ws]) w();
		const hist = v.history.slice(prev?.history.length ?? 0);
		for (const h of hist) this.emit({ type: "run.state", run: v.id, project: v.project, from: h.from, to: h.to, round: h.round }, v);
		const prevAsk = prev?.pendingAsk;
		if (prevAsk && !prevAsk.response && (v.pendingAsk?.id !== prevAsk.id || v.pendingAsk.response))
			this.emit({ type: "run.askResolved", run: v.id, ask: prevAsk.id, by: v.pendingAsk?.id === prevAsk.id ? v.pendingAsk.response!.by : "core" }, v);
		if (v.pendingAsk && !v.pendingAsk.response && v.pendingAsk.id !== prevAsk?.id)
			this.emit({ type: "run.ask", run: v.id, ask: v.pendingAsk.id, question: v.pendingAsk.question }, v);
		for (const n of v.notices.slice(prev?.notices.length ?? 0)) this.emit({ type: "run.notice", run: v.id, notice: n }, v);
	}

	private touchConversation(id: string) {
		if (this.convThrottle.has(id)) return;
		this.convThrottle.set(
			id,
			setTimeout(() => {
				this.convThrottle.delete(id);
				const m = this.convIndex.get(id);
				if (!m) return;
				const run = this.cache.get(m.run);
				if (run) this.emit({ type: "conversation.updated", run: m.run, conversationId: id, role: m.role }, run);
			}, 150),
		);
	}

	private emit(e: FactoryEvent, run?: { id: string; project: string }) {
		for (const l of [...this.listeners]) {
			if (l.filter.run && (!run || l.filter.run !== run.id)) continue;
			if (l.filter.project && (!run || l.filter.project !== run.project)) continue;
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

	subscribe(filter: { project?: string; run?: RunId }, on: (e: FactoryEvent) => void): Unsubscribe {
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
	async listProjects(): Promise<Project[]> {
		return this.config.projects();
	}

	// ------------------------------------------------------------------ runs
	async startRun(project: string, request: Omit<Request, "id" | "project">): Promise<RunId> {
		const p = this.config.project(project);
		const eff = this.config.effective({ project });
		const runId = `run-${this.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
		const now = this.now();
		const seed: RunDocState = {
			id: runId,
			project,
			repo: p.repo,
			request: { ...request, id: runId, project, source: request.source || this.by },
			state: "RECEIVED",
			createdAt: now,
			updatedAt: now,
			pinned: { config: eff, configHash: hashConfig(eff), piVersion: PI_DURABLE_VERSION },
			counters: { reviewRound: 1, ciFixes: 0, buildSeq: 0, reviewSeq: 0, discussionSeq: 0, askSeq: 0, findingSeq: 0 },
			caps: { review: Number(eff.policy?.reviewRoundCap ?? 3), ciFix: Number(eff.stages?.delivery?.ci?.fixRounds ?? 2) },
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
		await this.root.commit(async (tx) => {
			(await tx.doc(RunIndex)).runs.push(runId);
			const d = (await tx.doc(RunDoc, runId, seed as never)) as unknown as RunDocState;
			const taskId = await tx.createTask(this.runTask, { runId, start: "RECEIVED" as RunState }, { ownership: { kind: "conversation" }, background: true });
			d.taskId = taskId as unknown as string;
		}, this.ctx);
		this.harness.resume();
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
		// Interfaces may hand ids back as strings (CLI arguments, JSON); the harness's ids are numeric.
		const conversationId = (/^\d+$/.test(String(conversationIdIn)) ? Number(conversationIdIn) : conversationIdIn) as unknown as string;
		const known = new Set([d.conversations.architect, d.conversations.builder, ...d.conversations.reviewers.map((r) => r.id)].filter(Boolean).map(String));
		const mapped = this.convIndex.get(conversationId) ?? this.convIndex.get(String(conversationId) as never);
		if (!known.has(String(conversationId)) && mapped?.run !== run) {
			const env = await this.harness.snapshot(EnvDoc, conversationId as never, this.ctx);
			if (env?.runId !== run) throw new FactoryError("not_found", `conversation ${conversationId} does not belong to run ${run}`);
		}
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
			if (m.role === "user") items.push({ entryId: e.id, kind: e.kind, role: "user", text: typeof m.content === "string" ? m.content : m.content.map((p: any) => p.text ?? "").join("") });
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
		view.dispose?.();
		for (const slot of Object.values((live?.tools ?? {}) as Record<string, any>)) {
			const child = slot?.details?.conversationId;
			if (typeof child === "string") helpers.add(child);
		}
		const busy = !!live && (live.generation !== undefined || Object.keys(live.tools ?? {}).length > 0);
		const role = this.convIndex.get(conversationId)?.role;
		return { conversationId, ...(role ? { role } : {}), items, helpers: [...helpers], busy };
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

	// ------------------------------------------------------------------ settings
	settingsSchema(): Record<string, SettingField> {
		const schema = coreSchema();
		const stage = (kind: FactoryExtension["kind"]) => this.opts.extensions.filter((e) => e.kind === kind);
		const fieldsOf = (exts: FactoryExtension[]) => {
			const out: Record<string, SettingField> = {};
			for (const e of exts) for (const [k, f] of Object.entries(e.settings?.schema ?? {})) if (!(k in out)) out[k] = f;
			return out;
		};
		const names = (kind: FactoryExtension["kind"]) => stage(kind).map((e) => e.name);
		const stages: Record<string, SettingField> = {
			intake: {
				type: "object",
				description: "Where requests come from",
				fields: { use: { type: "enum", values: ["none", ...names("intake")], default: "none", description: "Intake extension" }, ...fieldsOf(stage("intake")) },
			},
			interface: {
				type: "object",
				description: "How humans reach the factory",
				fields: {
					use: { type: "list", of: { type: "enum", values: names("interface"), description: "interface" }, default: names("interface").slice(0, 1), description: "Interface extensions" },
					...fieldsOf(stage("interface")),
				},
			},
		};
		for (const kind of ["repo", "delivery", "environment"] as const) {
			stages[kind] = {
				type: "object",
				description: `${kind} stage`,
				fields: { use: { type: "enum", values: names(kind), default: names(kind)[0] ?? "", description: `${kind} extension` }, ...fieldsOf(stage(kind)) } as Record<string, SettingField>,
			};
		}
		return { ...schema, stages: { type: "object", description: "Stage → factory extension + its settings", fields: stages } };
	}

	private coreRules(eff: Obj, _scope: Scope): string[] {
		const problems: string[] = [];
		const installed = new Set(this.opts.workerExtensions.map((e) => e.name));
		for (const role of ["architect", "builder", "helper", "reviewer"] as Role[]) {
			const r = eff.roles?.[role];
			if (!isObj(r)) continue;
			const [provider, ...rest] = String(r.model ?? "").split("/");
			if (!provider || rest.length === 0) problems.push(`roles.${role}.model: expected provider/modelId`);
			else if (!this.opts.models.getModel(provider, rest.join("/"))) problems.push(`roles.${role}.model: ${r.model} is not a model createModels() knows`);
			for (const n of (r.extensions ?? []) as string[]) if (!installed.has(n)) problems.push(`roles.${role}.extensions: ${n} is not an installed worker extension`);
		}
		for (const kind of ["intake", "repo", "delivery", "environment", "interface"] as const) {
			const st = eff.stages?.[kind];
			if (!isObj(st)) continue;
			const uses = Array.isArray(st.use) ? st.use : [st.use];
			for (const u of uses) {
				if (u === "none" || u === undefined) continue;
				const ext = this.opts.extensions.find((e) => e.kind === kind && e.name === u);
				if (!ext) problems.push(`stages.${kind}.use: ${u} is not installed`);
				else if (ext.settings?.validate) problems.push(...ext.settings.validate(st).map((p) => `stages.${kind}: ${p}`));
			}
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
}
