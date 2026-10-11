// The discussion Task (discussions spec §1): a pi-durable Task per stretch of a discussion's life (start, then each
// reopen or retry). PREPARING opens the read-only checkout, provisions the discussant's environment and creates its one
// Conversation; OPEN runs the turns the operations set until the discussion leaves OPEN. The core never calls a model:
// it submits input to the Conversation, waits for it to settle and records how the turn ended.
import type { Context } from "@earendil-works/chord";
import type { AssistantMessage, UserMessage } from "@earendil-works/pi-ai";
import { type ConversationHandle, configure, defineTask, type SettledSubmissionRecord, type TaskRuntime, type Tx, UsageDoc } from "@earendil-works/pi-durable";
import { ROLE_TOOLS } from "../agents/tools.ts";
import { BridgeDoc, bridgeToolsNotFor, EnvDoc } from "./bridge.ts";
import { DiscussionDoc, type DiscussionDocState } from "./discussion-doc.ts";
import { humanContent } from "./messages.ts";
import { RunConfigDoc } from "./run-config.ts";
import { type CoreServices, WRITE_TOOLS } from "./run-task.ts";
import type { DiscussionNotice, RunCtx } from "./types.ts";
import { sumUsage } from "./usage.ts";

type Phase = "PREPARING" | "OPEN" | "FINAL";
type Checkpoint = { phase: Phase; n: number };
type DiscussionInput = { discussionId: string; start: "PREPARING" };
type RT = TaskRuntime<DiscussionInput, Checkpoint, string, object>;

export type DiscussionServices = Pick<CoreServices, "github" | "sandbox" | "bridge" | "now" | "log"> & {
	/** Resolves when the discussion's document changes (say, stop, close); never rejects. */
	changed(id: string, ms: number): Promise<void>;
};

/** How a turn ended, applied in the commit that clears it. A stopped turn applies nothing and gets a `stopped` notice. */
type TurnOutcome = { notice?: Omit<DiscussionNotice, "at">; apply?: (d: DiscussionDocState) => void };

class Cancelled extends Error {}

export function createDiscussionTask(svc: DiscussionServices) {
	// ------------------------------------------------------------------ helpers
	const read = async (rt: RT, id: string, c: Context) => {
		const d = await rt.snapshot(DiscussionDoc, id, c);
		if (!d) throw new Error(`discussion ${id} has no document`);
		return d as DiscussionDocState;
	};

	/** What `GitHub` and `Sandbox` calls get: the discussion id in place of a run id, and the pinned config. */
	const rc = (d: DiscussionDocState): RunCtx => ({ runId: d.id, config: d.pinned.config });

	/** Commit a document change and the next checkpoint together; `FINAL` ends the Task in the same commit. */
	async function transition(rt: RT, c: Context, id: string, change: (d: DiscussionDocState, tx: Tx) => Phase | Promise<Phase>): Promise<void> {
		await rt.commit(async (tx, current) => {
			const d = (await tx.doc(DiscussionDoc, id, null as never)) as unknown as DiscussionDocState;
			const next = await change(d, tx);
			d.updatedAt = svc.now();
			if (next === "FINAL") return { status: "terminal", outcome: { status: "completed", result: d.state } };
			return { status: "running", checkpoint: { phase: next, n: current.state.checkpoint.n + 1 } };
		}, c);
	}

	function notice(d: DiscussionDocState, n: Omit<DiscussionNotice, "at">) {
		d.notices.push({ at: svc.now(), kind: n.kind, text: n.text });
	}

	/** The Conversation, configured like a role Conversation (`createRoleConversation`), with the pinned model. */
	async function createConversation(rt: RT, tx: Tx, d: DiscussionDocState, env: { envId: string; cwd: string }): Promise<string> {
		const conv = await tx.createConversation({ ownership: { kind: "task", taskId: rt.taskId } });
		const [provider, ...rest] = d.model.model.split("/");
		await configure(tx, conv.id, {
			model: { provider: provider!, modelId: rest.join("/") },
			thinkingLevel: d.model.thinking as any,
			extensions: [...ROLE_TOOLS.discussant, svc.bridge],
			tools: { remove: [...bridgeToolsNotFor("discussant"), ...WRITE_TOOLS] },
			cwd: env.cwd,
		});
		const b = await tx.doc(BridgeDoc, conv.id);
		b.runId = d.id;
		b.role = "discussant";
		const e = await tx.doc(EnvDoc, conv.id);
		e.runId = d.id;
		e.role = "discussant";
		e.envId = env.envId;
		const r = await tx.doc(RunConfigDoc, conv.id);
		r.runId = d.id;
		r.webSearch = JSON.parse(JSON.stringify(d.pinned.config.webSearch ?? {}));
		return conv.id as unknown as string;
	}

	/** The data the core hands over on the first turn (spec §1.5), then the human's first message. */
	function firstInput(d: DiscussionDocState): string {
		const ws = d.workspace!;
		return [
			"# Discussion",
			`Title: ${d.title}`,
			"",
			"# Project",
			`Project: ${d.project}; repo binding: ${d.repo} (${ws.newRepo ? "the repo does not exist yet" : "existing repo"}).`,
			`Workspace (read-only for you): ${ws.path}${ws.newRepo ? "" : "; read AGENTS.md and docs/spec.md first if present"}.`,
			"",
			"# The human's first message",
			d.firstMessage.text,
		].join("\n");
	}

	// ------------------------------------------------------------------ turns
	/**
	 * Submit one input of the turn (idempotent by `requestId`) and wait until the Conversation settles it. A Stop the
	 * operation could not deliver (it came before the input was admitted, or the factory restarted in between) is
	 * delivered here. Returns whether the turn was stopped and, when the model failed, the provider's message.
	 */
	async function submitAndWait(rt: RT, c: Context, d: DiscussionDocState, handle: ConversationHandle, requestId: string, content: UserMessage["content"]): Promise<{ stopped: boolean; error?: string }> {
		const stopped = async () => !!(await read(rt, d.id, c)).turn?.stopRequested;
		if (await stopped()) {
			await handle.abort(c);
			return { stopped: true };
		}
		const sub = await handle.submit({ type: "input", content, requestId }, c);
		if (await stopped()) await handle.abort(c);
		const settled = await sub.wait(c);
		if (await stopped()) return { stopped: true };
		const error = await modelError(rt, c, d.conversationId!, settled);
		return { stopped: false, ...(error !== undefined ? { error } : {}) };
	}

	/** The provider's message when the last model response of the input failed (auth, rate limit, unknown model, …). */
	async function modelError(rt: RT, c: Context, conversationId: string, settled: SettledSubmissionRecord): Promise<string | undefined> {
		const view = await rt.context(conversationId as never, c);
		const from = settled.entry !== undefined ? view.entries.findIndex((e) => e.id === settled.entry) : -1;
		const last = view.entries
			.slice(from + 1)
			.map((e) => e.model?.[0])
			.filter((m) => m?.role === "assistant")
			.at(-1) as AssistantMessage | undefined;
		if (last?.stopReason === "error") return last.errorMessage ?? "the model failed";
		if (settled.status === "unanswered" && settled.reason === "model_error") return String(settled.detail ?? "the model failed");
		return undefined;
	}

	/** A `say` turn: the first turn submits the project context and the first message, later ones the human's text. */
	async function sayTurn(rt: RT, c: Context, d: DiscussionDocState, handle: ConversationHandle): Promise<TurnOutcome> {
		const turn = d.turn!;
		const content = turn.msgId === undefined ? turn.text : humanContent(turn.by, turn.msgId, turn.text);
		const r = await submitAndWait(rt, c, d, handle, turn.key, content);
		return r.error !== undefined ? { notice: { kind: "error", text: r.error } } : {};
	}

	/** A `draft` turn: drafting instructions, the bridge's `submit_tickets` and reminders (added with drafting). */
	async function draftTurn(_rt: RT, _c: Context, _d: DiscussionDocState, _handle: ConversationHandle): Promise<TurnOutcome> {
		throw new Error("not implemented");
	}

	/**
	 * Run the turn that is set, then clear it with its cost and a notice if it was stopped or failed. Resumable: after a
	 * crash the memos and the request id make the rerun wait on the same input.
	 */
	async function runTurn(rt: RT, c: Context, d: DiscussionDocState): Promise<void> {
		const turn = d.turn!;
		const conversationId = d.conversationId!;
		const handle = await rt.conversation(conversationId as never, c);
		if (!handle) throw new Error(`conversation ${conversationId} is missing`);
		const usageOf = async () => sumUsage((await rt.snapshot(UsageDoc, conversationId as never, c)) as any);
		const before = await rt.memo(`${turn.key}:usage0`, await usageOf(), c);
		const startedAt = await rt.memo(`${turn.key}:t0`, svc.now(), c);
		const outcome = turn.kind === "draft" ? await draftTurn(rt, c, d, handle) : await sayTurn(rt, c, d, handle);
		const after = await usageOf();
		await rt.commit(async (tx) => {
			const doc = (await tx.doc(DiscussionDoc, d.id, null as never)) as unknown as DiscussionDocState;
			if (doc.turn?.key !== turn.key) return undefined;
			if (doc.turn.stopRequested) notice(doc, { kind: "stopped", text: `Stopped by ${doc.turn.stoppedBy ?? doc.turn.by}` });
			else {
				outcome.apply?.(doc);
				if (outcome.notice) notice(doc, outcome.notice);
			}
			doc.turnCosts.push({
				turn: turn.seq,
				kind: turn.kind,
				usd: Math.max(0, after.usd - before.usd),
				totalTokens: Math.max(0, after.totalTokens - before.totalTokens),
				durationMs: svc.now() - startedAt,
			});
			doc.turn = null;
			doc.updatedAt = svc.now();
			return undefined;
		}, c);
	}

	// ------------------------------------------------------------------ phases
	const handlers: Record<Phase, (rt: RT, c: Context, d: DiscussionDocState) => Promise<void>> = {
		PREPARING: async (rt, c, d) => {
			const ws = d.workspace ? await svc.github.refresh(d.workspace, rc(d)) : await svc.github.open(d.repo, rc(d), "discussions");
			const env = await svc.sandbox.provision(ws, "discussant", rc(d));
			await transition(rt, c, d.id, async (doc, tx): Promise<Phase> => {
				doc.workspace = ws;
				// Reopen and retry keep the Conversation; only the first prepare creates it and sets the first turn.
				if (doc.conversationId === undefined) {
					doc.conversationId = await createConversation(rt, tx, doc, env);
					doc.counters.turnSeq += 1;
					const seq = doc.counters.turnSeq;
					doc.turn = { kind: "say", key: `${doc.id}:turn${seq}`, seq, text: firstInput(doc), by: doc.firstMessage.by, startedAt: svc.now() };
				}
				doc.state = "OPEN";
				return "OPEN";
			});
		},

		OPEN: async (rt, c, d) => {
			for (;;) {
				if (rt.signal.aborted) throw new Cancelled();
				const doc = await read(rt, d.id, c);
				if (doc.state !== "OPEN") return transition(rt, c, d.id, () => "FINAL");
				if (doc.turn) {
					await runTurn(rt, c, doc);
					continue;
				}
				await Promise.race([svc.changed(d.id, 1000), rt.sleep(svc.now() + 1000, c).catch(() => undefined)]);
			}
		},

		FINAL: async (rt, c, d) => {
			await rt.commit(() => ({ status: "terminal", outcome: { status: "completed", result: d.state } }), c);
		},
	};

	return defineTask<DiscussionInput, Checkpoint, string>({
		name: "factory.discussion",
		version: 1,
		initial: (input) => ({ phase: input.start, n: 0 }),
		phases: Object.fromEntries(
			(Object.keys(handlers) as Phase[]).map((phase) => [
				phase,
				async (task: any, rt: RT, c: Context) => {
					const d = await read(rt, task.input.discussionId, c);
					try {
						await handlers[phase](rt, c, d);
					} catch (e) {
						if (rt.signal.aborted || e instanceof Cancelled || phase === "FINAL") throw e;
						const reason = e instanceof Error ? e.message : String(e);
						svc.log(`discussion ${d.id} failed in ${phase}: ${reason}`);
						// FAILED and the end of the Task in one commit, so that Retry can follow at once.
						await transition(rt, c, d.id, (doc) => {
							doc.state = "FAILED";
							doc.error = reason;
							doc.turn = null;
							return "FINAL";
						});
					}
				},
			]),
		) as any,
		// The operations never abort the Task (Stop aborts the Conversation's work). If it is aborted all the same, the
		// discussion goes to FAILED so that Retry brings it back.
		abort: async (task, rt, c) => {
			await rt.commit(async (tx) => {
				const doc = (await tx.doc(DiscussionDoc, task.input.discussionId, null as never)) as unknown as DiscussionDocState;
				if (doc.state === "PREPARING" || doc.state === "OPEN") {
					doc.state = "FAILED";
					doc.error = "the discussion's task was aborted";
					doc.turn = null;
					doc.updatedAt = svc.now();
				}
				return { status: "terminal", outcome: { status: "aborted", reason: "aborted" } };
			}, c);
		},
	});
}
