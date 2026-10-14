// The discussion Task (discussions spec §1): a pi-durable Task per stretch of a discussion's life (start, then each
// reopen or retry). PREPARING opens the read-only checkout, provisions the discussant's environment and creates its one
// Conversation; OPEN runs the turns the operations set until the discussion leaves OPEN. The core never calls a model:
// it submits input to the Conversation, waits for it to settle and records how the turn ended.
import type { Context } from "@earendil-works/chord";
import type { AssistantMessage, UserMessage } from "@earendil-works/pi-ai";
import { type ConversationHandle, configure, defineTask, type SettledSubmissionRecord, type TaskRuntime, type Tx, UsageDoc } from "@earendil-works/pi-durable";
import { ROLE_TOOLS } from "../agents/tools.ts";
import { BridgeDoc, bridgeToolsNotFor, EnvDoc } from "./bridge.ts";
import { cleanAtEnd, discussionOwner, nextMarker } from "./cleanup.ts";
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

export type DiscussionServices = Pick<CoreServices, "github" | "sandbox" | "cleanup" | "bridge" | "now" | "log"> & {
	/** Resolves when the discussion's document changes (say, stop, close); never rejects. */
	changed(id: string, ms: number): Promise<void>;
};

/** How a turn ended, applied in the commit that clears it. A stopped turn applies nothing and gets a `stopped` notice. */
type TurnOutcome = { notice?: Omit<DiscussionNotice, "at">; apply?: (d: DiscussionDocState) => void };

class Cancelled extends Error {}

/** Reminders after the model stops without calling submit_tickets (as `runAgent`'s). */
const MAX_NUDGES = 2;

/** The drafts a redraft builds on: those that already became runs, and the others (which the submission replaces). */
export type DraftContext = { tickets: { title: string; runId: string }[]; drafts: { title: string; body: string; edited: boolean }[] };

/**
 * What a `draft` turn submits (spec §2.2): the drafting instructions; on a redraft, the drafts that already became
 * tickets (not to be submitted again) and the current drafts with the human's edits marked; then the human's
 * instructions, if any.
 */
export function draftInstructions(instructions?: string, context?: DraftContext): string {
	const lines = [
		"# Draft tickets",
		"Draft tickets from this discussion and submit them, with a summary, by calling submit_tickets.",
		"- Write one ticket per piece of work that can be specified, built and reviewed on its own.",
		"- Each body is a self-contained request for the factory's architect: the goal, the constraints, what is in and out of scope, and acceptance criteria. Refer to other tickets by title where they depend on each other.",
		"- The summary separates what is settled from what is still open.",
	];
	if (context?.tickets.length)
		lines.push(
			"",
			"# Drafts that already became tickets",
			"These are runs now. Do not re-submit these; refer to them by title where a new ticket depends on them.",
			...context.tickets.map((x) => `- ${x.title} (run ${x.runId})`),
		);
	if (context?.drafts.length)
		lines.push(
			"",
			"# The current drafts",
			"Your submission replaces these. Build on them: keep what still holds, and keep the human's edits unless the discussion has moved past them.",
			...context.drafts.flatMap((x) => ["", `## ${x.title}${x.edited ? " (edited by the human)" : ""}`, x.body]),
		);
	const extra = instructions?.trim();
	if (extra) lines.push("", "# The human's instructions", extra);
	return lines.join("\n");
}

/**
 * The factory note for the next turn when a reopen or retry changed the checkout, or undefined; clears it (call
 * inside the commit that sets the turn).
 */
export function takeCheckoutNote(d: DiscussionDocState): string | undefined {
	const ch = d.checkoutChanged;
	if (!ch) return undefined;
	delete d.checkoutChanged;
	if (ch.repoCreated)
		return `The repo ${d.repo} now exists: your workspace (${d.workspace?.path}) is now a checkout of it at ${ch.to}. Read AGENTS.md and docs/spec.md first if present.`;
	return `The repo checkout was updated to ${ch.to}, the latest commit of the default branch (it was ${ch.from}). Files may have changed since you last read them.`;
}

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
		d.notices.push({ at: svc.now(), kind: n.kind, text: n.text, ...(n.turn !== undefined ? { turn: n.turn } : {}) });
	}

	/**
	 * Retire the discussant's environment (its network allowlist entries) when the discussion leaves OPEN, as a run does
	 * when it ends. Best effort and idempotent; a reopen or retry provisions it again (`Sandbox.provision`).
	 */
	async function disposeEnv(rt: RT, c: Context, d: DiscussionDocState) {
		try {
			if (d.conversationId === undefined) return;
			const env = await rt.snapshot(EnvDoc, d.conversationId as never, c);
			if (env?.envId) await svc.sandbox.dispose(env.envId);
		} catch (e) {
			svc.log(`discussion ${d.id}: could not dispose its environment: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	/** Clear the turn and, for a `draft` turn, what the bridge expects for it (a late submit_tickets is refused). */
	async function clearTurn(tx: Tx, d: DiscussionDocState) {
		if (d.turn && d.conversationId !== undefined) {
			const b = await tx.doc(BridgeDoc, d.conversationId as never);
			if (b.expect?.key === d.turn.key) b.expect = null;
		}
		d.turn = null;
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
		const failed = settled.status === "unanswered" && settled.reason === "model_error" ? String(settled.detail ?? "the model failed") : undefined;
		// No entry: the input never reached the transcript, so no response there is this input's.
		if (settled.entry === undefined) return failed;
		const view = await rt.context(conversationId as never, c);
		const from = view.entries.findIndex((e) => e.id === settled.entry);
		if (from < 0) return failed;
		const last = view.entries
			.slice(from + 1)
			.map((e) => e.model?.[0])
			.filter((m) => m?.role === "assistant")
			.at(-1) as AssistantMessage | undefined;
		if (last?.stopReason === "error") return last.errorMessage ?? "the model failed";
		return failed;
	}

	/** A `say` turn: the first turn submits the project context and the first message, later ones the human's text. */
	async function sayTurn(rt: RT, c: Context, d: DiscussionDocState, handle: ConversationHandle): Promise<TurnOutcome> {
		const turn = d.turn!;
		let content: UserMessage["content"] = turn.text;
		if (turn.msgId !== undefined) {
			const [head, body] = humanContent(turn.by, turn.msgId, turn.text) as [{ type: "text"; text: string }, { type: "text"; text: string }];
			// A factory note goes in the header, after the sender (as a run message's situation note).
			content = turn.note ? [{ type: "text", text: `${head.text.slice(0, -1)}[factory] ${turn.note}\n\n` }, body] : [head, body];
		}
		const r = await submitAndWait(rt, c, d, handle, turn.key, content);
		return r.error !== undefined ? { notice: { kind: "error", text: r.error } } : {};
	}

	/**
	 * A `draft` turn: the drafting instructions (`turn.text`), then up to `MAX_NUDGES` reminders while the model stops
	 * without calling submit_tickets. A submission already recorded (a rerun after a crash) is applied without asking
	 * again. A stopped turn applies nothing (`runTurn`).
	 */
	async function draftTurn(rt: RT, c: Context, d: DiscussionDocState, handle: ConversationHandle): Promise<TurnOutcome> {
		const turn = d.turn!;
		const submitted = async () => (await rt.snapshot(BridgeDoc, d.conversationId as never, c))?.results[turn.key];
		let result = await submitted();
		for (let attempt = 0; attempt <= MAX_NUDGES && result === undefined; attempt++) {
			const requestId = attempt === 0 ? turn.key : `${turn.key}:nudge${attempt}`;
			const text =
				attempt === 0
					? turn.text
					: "You stopped without calling submit_tickets. The factory only continues when you call submit_tickets. Continue your work if needed, then call it.";
			const r = await submitAndWait(rt, c, d, handle, requestId, text);
			if (r.stopped) return {};
			result = await submitted();
			if (result === undefined && r.error !== undefined) return { notice: { kind: "error", text: r.error } };
		}
		if (result === undefined) return { notice: { kind: "no_submission", text: "The model did not submit draft tickets; the drafts are unchanged" } };
		const payload = result.payload as { summary: string; tickets: { title: string; body: string }[] };
		return {
			apply: (doc) => {
				doc.summary = payload.summary;
				doc.counters.batch += 1;
				doc.drafts = doc.drafts.filter((x) => x.runId !== undefined);
				for (const t of payload.tickets)
					doc.drafts.push({ id: `D${++doc.counters.draftSeq}`, title: t.title, body: t.body, edited: false, batch: doc.counters.batch });
			},
		};
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
			if (doc.turn.stopRequested) notice(doc, { kind: "stopped", text: `Stopped by ${doc.turn.stoppedBy ?? doc.turn.by}`, turn: turn.seq });
			else {
				outcome.apply?.(doc);
				if (outcome.notice) notice(doc, { ...outcome.notice, turn: turn.seq });
			}
			doc.turnCosts.push({
				turn: turn.seq,
				kind: turn.kind,
				usd: Math.max(0, after.usd - before.usd),
				totalTokens: Math.max(0, after.totalTokens - before.totalTokens),
				durationMs: svc.now() - startedAt,
			});
			await clearTurn(tx, doc);
			doc.updatedAt = svc.now();
			return undefined;
		}, c);
	}

	// ------------------------------------------------------------------ phases
	const handlers: Record<Phase, (rt: RT, c: Context, d: DiscussionDocState) => Promise<void>> = {
		PREPARING: async (rt, c, d) => {
			// The commit identity before any work (the discussant's environment carries it): a failed lookup fails here.
			const who = await svc.github.commitIdentity(rc(d));
			const ws = d.workspace ? await svc.github.refresh(d.workspace, rc(d)) : await svc.github.open(d.repo, rc(d), "discussions");
			const env = await svc.sandbox.provision(ws, "discussant", rc(d), who);
			await transition(rt, c, d.id, async (doc, tx): Promise<Phase> => {
				const prev = doc.workspace;
				doc.workspace = ws;
				// The model read the old checkout: the next turn tells it what changed (an untold earlier change is merged in).
				if (prev && (prev.baseRef !== ws.baseRef || prev.newRepo !== ws.newRepo)) {
					const pending = doc.checkoutChanged;
					doc.checkoutChanged = { from: pending?.from ?? prev.baseRef, to: ws.baseRef, repoCreated: !!pending?.repoCreated || (prev.newRepo && !ws.newRepo) };
				}
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
				if (doc.state !== "OPEN") {
					await disposeEnv(rt, c, doc);
					const cleaned = await cleanAtEnd(svc.cleanup, discussionOwner(doc));
					return transition(rt, c, d.id, (x) => {
						if (cleaned) x.cleanedUp = nextMarker(x.cleanedUp, cleaned, svc.now());
						return "FINAL";
					});
				}
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
						// A turn that was running has nobody waiting on it any more: stop the Conversation's work (best effort).
						try {
							const now = await read(rt, d.id, c);
							if (now.turn && now.conversationId !== undefined) await (await rt.conversation(now.conversationId as never, c))?.abort(c);
						} catch (abortError) {
							svc.log(`discussion ${d.id}: could not abort the conversation: ${abortError instanceof Error ? abortError.message : String(abortError)}`);
						}
						await disposeEnv(rt, c, d);
						// A FAILED discussion is cleaned at once (a retry re-creates the checkout and the environment).
						const cleaned = await cleanAtEnd(svc.cleanup, discussionOwner({ ...(await read(rt, d.id, c)), state: "FAILED" })).catch(() => undefined);
						// FAILED and the end of the Task in one commit, so that Retry can follow at once.
						await transition(rt, c, d.id, async (doc, tx): Promise<Phase> => {
							doc.state = "FAILED";
							doc.error = reason;
							if (cleaned) doc.cleanedUp = nextMarker(doc.cleanedUp, cleaned, svc.now());
							await clearTurn(tx, doc);
							return "FINAL";
						});
					}
				},
			]),
		) as any,
		// The turn operations never abort the Task (Stop aborts the Conversation's work); deleteProject does (it ends the
		// project's live discussions). The discussion goes to
		// FAILED so that Retry brings it back.
		abort: async (task, rt, c) => {
			// The discussion leaves OPEN (to FAILED, unless it is already CLOSED or FAILED): clean it before the commit.
			const before = await read(rt, task.input.discussionId, c).catch(() => undefined);
			// A turn may be running (mid-reply, drafting): stop the Conversation's work, then drop the environment.
			if (before && (before.state === "PREPARING" || before.state === "OPEN")) {
				try {
					if (before.turn && before.conversationId !== undefined) await (await rt.conversation(before.conversationId as never, c))?.abort(c);
				} catch (e) {
					svc.log(`discussion ${before.id}: could not abort the conversation: ${e instanceof Error ? e.message : String(e)}`);
				}
				await disposeEnv(rt, c, before);
			}
			const cleaned = before
				? await cleanAtEnd(svc.cleanup, discussionOwner({ ...before, state: before.state === "PREPARING" || before.state === "OPEN" ? "FAILED" : before.state })).catch(() => undefined)
				: undefined;
			await rt.commit(async (tx) => {
				const doc = (await tx.doc(DiscussionDoc, task.input.discussionId, null as never)) as unknown as DiscussionDocState;
				if (doc.state === "PREPARING" || doc.state === "OPEN") {
					doc.state = "FAILED";
					doc.error = "the discussion's task was aborted";
					await clearTurn(tx, doc);
					doc.updatedAt = svc.now();
				}
				if (cleaned) doc.cleanedUp = nextMarker(doc.cleanedUp, cleaned, svc.now());
				return { status: "terminal", outcome: { status: "aborted", reason: "aborted" } };
			}, c);
		},
	});
}
