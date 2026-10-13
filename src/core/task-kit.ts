// What the run Task and the bundle Task share (spec §4; bundles spec §2): role Conversations, driving an agent through
// the bridge, cost records, pending asks, a review round (a reviewer plus, when AQ testing applies, a QA agent in a
// boat.dev VM) and the CI wait. Each Task passes its own Document family; both Documents use the same field names for
// these parts (`KitDoc`).
import type { Context } from "@earendil-works/chord";
import { configure, type TaskRuntime, type Tx, UsageDoc } from "@earendil-works/pi-durable";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ROLE_TOOLS } from "../agents/tools.ts";
import type { Boat } from "../boat/boat.ts";
import { BridgeDoc, type BridgeTool, bridgeToolsNotFor, EnvDoc, ScreenshotsDoc } from "./bridge.ts";
import { formatFinding, validateQa, validateReview } from "./findings.ts";
import { RunConfigDoc } from "./run-config.ts";
import type { ReviewRoundState } from "./run-doc.ts";
import type { CoreServices } from "./run-task.ts";
import { parseDuration } from "./settings.ts";
import type { CiStatus, CostRecord, Delivery, Finding, FindingsLogEntry, HumanMessage, Notice, QaStatus, ReviewResult, Role, RunCtx, Workspace } from "./types.ts";
import { addCost, sumUsage, type UsageSum } from "./usage.ts";
import { createEditTool, createWriteTool } from "@earendil-works/pi-durable/tools";
import type { ToolRegistration } from "@earendil-works/pi-durable";

/** Removed from every role but the ones that write the worktree (the builder, its helpers and a bundle's integrator). */
export const WRITE_TOOLS: ToolRegistration[] = [createWriteTool() as ToolRegistration, createEditTool() as ToolRegistration];
const WRITERS: Role[] = ["builder", "integrator"];

const MAX_NUDGES = 2;

export class Cancelled extends Error {}

/** The parts of a run or bundle Document the kit reads and writes. */
export type KitDoc = {
	id: string;
	project: string;
	state: string;
	pinned: { config: Record<string, any> };
	counters: { reviewRound: number; ciFixes: number; buildSeq: number; reviewSeq: number; askSeq: number; findingSeq: number; discussionSeq: number; attempt?: number; msgSeq?: number };
	caps: { review: number; ciFix: number };
	loop: "review" | "ci";
	workspace?: Workspace;
	envs: Partial<Record<Role, { envId: string; cwd: string }>>;
	conversations: { reviewers: { id: string; seq: number }[]; qa?: { id: string; seq: number }[]; active?: string };
	reviews?: Record<string, ReviewRoundState>;
	driving?: { conversationId: string; key: string };
	pendingAsk?: { id: string; question: any; createdAt: number; response?: any };
	messages?: HumanMessage[];
	findingsLog: FindingsLogEntry[];
	humanFindingsForReview: Finding[];
	lastReview?: ReviewResult;
	advisory: Finding[];
	cost: CostRecord[];
	usage?: Record<string, UsageSum>;
	notices: Notice[];
	updatedAt: number;
};

/**
 * An agent's own prior findings (review or qa entries) with the responses of `fixer` (the builder or the integrator),
 * plus blocking human findings since the last review.
 */
export function priorFindings(d: Pick<KitDoc, "findingsLog" | "humanFindingsForReview">, kind: "review" | "qa", label: string, fixer: string): string[] {
	const parts: string[] = [];
	const lastPrior = d.findingsLog.filter((e) => e.kind === kind).at(-1);
	const responses = d.findingsLog.flatMap((e) => e.responses ?? []);
	const answered = (f: Finding) => {
		const r = responses.find((x) => x.findingId === f.id);
		return `  ${fixer}: ${r ? `${r.status}${r.reason ? ` — ${r.reason}` : ""}` : "(no response)"}`;
	};
	if (lastPrior) {
		parts.push("", `## Your prior findings and the ${fixer}'s responses (${label})`);
		for (const f of lastPrior.findings) parts.push(formatFinding(f), answered(f));
	}
	const human = d.humanFindingsForReview;
	if (human.length) {
		parts.push("", "## Human findings from a gate rejection (blocking)");
		for (const f of human) parts.push(formatFinding(f), answered(f));
	}
	return parts;
}

export const clip = (patch: string) => (patch.length > 60_000 ? patch.slice(0, 60_000) + "\n… (truncated; inspect the workspace)" : patch);

export type AgentContent = string | ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[];
export type AgentResult = { tool: BridgeTool; payload: any; usage: { before: UsageSum; after: UsageSum; durationMs: number } };

export interface KitHooks<D extends KitDoc> {
	/** "run" or "bundle": for log lines and errors. */
	noun: string;
	/** What a held human message looks like to the agent (header, situation note, text). */
	messageContent(d: D, m: HumanMessage): { type: "text"; text: string }[];
	/** The model and thinking of a role (the pinned `roles.<role>`, with any defaults applied). */
	roleConfig?(d: D, role: Role): { model?: string; thinking?: string };
}

/** `Doc`: the Task's Document family (RunDoc or BundleDoc). */
export function createTaskKit<D extends KitDoc>(svc: CoreServices, Doc: unknown, hooks: KitHooks<D>) {
	const read = async (rt: TaskRuntime<any, any, any, any>, id: string, c: Context): Promise<D> => {
		const d = await rt.snapshot(Doc as any, id as never, c);
		if (!d) throw new Error(`${hooks.noun} ${id} has no document`);
		return d as unknown as D;
	};
	const docIn = async (tx: Tx, id: string): Promise<D> => (await tx.doc(Doc as any, id as never, null as never)) as unknown as D;
	const roleConfig = (d: D, role: Role) => hooks.roleConfig?.(d, role) ?? d.pinned.config.roles?.[role] ?? {};
	/** What `GitHub`, `Sandbox` and `Boat` calls get: the id and the pinned config. */
	const rc = (d: D): RunCtx => ({ runId: d.id, config: d.pinned.config });

	function newAsk(d: D, question: unknown) {
		d.counters.askSeq += 1;
		const ask = { id: `${d.id}-ask${d.counters.askSeq}`, question: JSON.parse(JSON.stringify(question)), createdAt: svc.now() };
		d.pendingAsk = ask;
		return ask;
	}

	function notice(d: D, n: Omit<Notice, "at">) {
		d.notices.push(JSON.parse(JSON.stringify({ at: svc.now(), ...n })) as Notice);
	}

	function assignIds(d: D, findings: Finding[]): Finding[] {
		return findings.map((f) => {
			d.counters.findingSeq += 1;
			return { ...f, id: `F${d.counters.findingSeq}` };
		});
	}

	async function createRoleConversation(rt: TaskRuntime<any, any, any, any>, tx: Tx, d: D, role: Role, qa?: { envId: string; cwd?: string; seq: number }): Promise<string> {
		const cfg = roleConfig(d, role);
		// The QA agent works in its boat.dev VM; every other role in the local sandbox (helpers share the builder's).
		const env = qa ? { envId: qa.envId, cwd: qa.cwd } : (d.envs[role] ?? d.envs.builder ?? d.envs.integrator);
		const conv = await tx.createConversation({ ownership: { kind: "task", taskId: rt.taskId } });
		const [provider, ...rest] = String(cfg.model ?? "").split("/");
		await configure(tx, conv.id, {
			model: { provider: provider!, modelId: rest.join("/") },
			thinkingLevel: (cfg.thinking ?? "medium") as any,
			extensions: [...ROLE_TOOLS[role], svc.bridge],
			tools: { remove: [...bridgeToolsNotFor(role), ...(WRITERS.includes(role) ? [] : WRITE_TOOLS)] },
			...(env?.cwd ? { cwd: env.cwd } : {}),
		});
		const b = await tx.doc(BridgeDoc, conv.id);
		b.runId = d.id;
		b.role = role;
		const e = await tx.doc(EnvDoc, conv.id);
		e.runId = d.id;
		e.role = role;
		if (env) e.envId = env.envId;
		const r = await tx.doc(RunConfigDoc, conv.id);
		r.runId = d.id;
		r.webSearch = JSON.parse(JSON.stringify(d.pinned.config.webSearch ?? {}));
		if (qa) r.qa = { seq: qa.seq, artifactsDir: svc.artifactsDir };
		return conv.id as unknown as string;
	}

	/** Hand human messages that were waiting for this role's turn to its Conversation, as steers (see messages.ts). */
	async function deliverHeld(rt: TaskRuntime<any, any, any, any>, c: Context, id: string, role: Role, conversationId: string, handle: { submit: (s: any, c: Context) => Promise<unknown> }) {
		const doc = await read(rt, id, c);
		const held = (doc.messages ?? []).filter((m) => m.to === role && m.conversationId === undefined);
		if (!held.length) return;
		for (const m of held) await handle.submit({ type: "input", content: hooks.messageContent(doc, m), requestId: m.id, whenBusy: "steer" }, c);
		await rt.commit(async (tx) => {
			const r = await docIn(tx, id);
			for (const m of r.messages ?? []) if (held.some((h) => h.id === m.id)) m.conversationId = String(conversationId);
			return undefined;
		}, c);
	}

	/** Submit input to a role Conversation (idempotent by request key) and read what it committed through the bridge. */
	async function runAgent(
		rt: TaskRuntime<any, any, any, any>,
		c: Context,
		d: D,
		role: Role,
		conversationId: string,
		key: string,
		content: AgentContent,
		tools: BridgeTool[],
		findingIds?: string[],
		opts: { drive?: boolean } = {},
	): Promise<AgentResult> {
		if (d.counters.attempt) key = `${key}:retry${d.counters.attempt}`;
		await rt.commit(async (tx) => {
			const b = await tx.doc(BridgeDoc, conversationId as never);
			if (b.expect?.key !== key) b.expect = { key, tools, ...(findingIds ? { findingIds } : {}) };
			// The QA agent runs beside the reviewer and takes no messages: it never becomes the active agent.
			if (opts.drive !== false) {
				const r = await docIn(tx, d.id);
				r.conversations.active = conversationId;
				r.driving = { conversationId, key };
			}
			return undefined;
		}, c);
		const usageOf = async () => sumUsage((await rt.snapshot(UsageDoc, conversationId as never, c)) as any);
		const before = await rt.memo(`${key}:usage0`, await usageOf(), c);
		const startedAt = await rt.memo(`${key}:t0`, svc.now(), c);
		const handle = await rt.conversation(conversationId as never, c);
		if (!handle) throw new Error(`conversation ${conversationId} is missing`);
		let result: { tool: BridgeTool; payload: any } | undefined;
		let lastStatus = "";
		for (let attempt = 0; attempt <= MAX_NUDGES && result === undefined; attempt++) {
			const requestId = attempt === 0 ? key : `${key}:nudge${attempt}`;
			const text =
				attempt === 0
					? content
					: `You stopped without calling ${tools.join(" or ")}. The factory only continues when you call ${tools.join(" or ")}. Continue your work if needed, then call it.`;
			const sub = await handle.submit({ type: "input", content: text as any, requestId }, c);
			if (opts.drive !== false) await deliverHeld(rt, c, d.id, role, conversationId, handle);
			const settled = await sub.wait(c);
			result = (await rt.snapshot(BridgeDoc, conversationId as never, c))?.results[key];
			if (result === undefined && settled.status === "unanswered") {
				lastStatus = `unanswered (${(settled as any).reason ?? "unknown"}${(settled as any).error ? `: ${JSON.stringify((settled as any).error)}` : ""})`;
				if ((settled as any).reason !== "stale") break;
			}
		}
		if (result === undefined) throw new Error(`${role} conversation finished without calling ${tools.join("/")}${lastStatus ? `; last input ${lastStatus}` : ""}`);
		return { ...result, usage: { before, after: await usageOf(), durationMs: svc.now() - startedAt } };
	}

	const pushCost = (doc: D, role: Role, conversationId: string, r: AgentResult) => addCost(doc as any, role, conversationId, r.usage.before, r.usage.after, r.usage.durationMs, { always: true });

	/** At the end: usage of turns nobody recorded yet (a message's turn the core didn't see finish). */
	async function settleUsage(rt: TaskRuntime<any, any, any, any>, c: Context, id: string, convs: [Role, string][]) {
		const d = await read(rt, id, c);
		const now = await Promise.all(convs.map(async ([, cid]) => sumUsage((await rt.snapshot(UsageDoc, cid as never, c)) as any)));
		if (!convs.some(([, cid], i) => now[i]!.totalTokens > (d.usage?.[String(cid)]?.totalTokens ?? 0))) return;
		await rt.commit(async (tx) => {
			const doc = await docIn(tx, id);
			// Only Conversations with accounted usage: runs started before accounting existed have no baseline.
			convs.forEach(([role, cid], i) => {
				const seen = doc.usage?.[String(cid)];
				if (seen && now[i]!.totalTokens > seen.totalTokens) addCost(doc as any, role, cid, seen, now[i]!, 0, { trigger: "message" });
			});
			return undefined;
		}, c);
	}

	/** Wait for the human's response to an ask, or for `other` to produce something first (checked after the response). */
	async function awaitResponseOr<T>(rt: TaskRuntime<any, any, any, any>, c: Context, id: string, askId: string, other?: () => Promise<T | undefined>, pollMs = 1000) {
		for (;;) {
			const d = await read(rt, id, c);
			if (d.pendingAsk?.id === askId && d.pendingAsk.response) return { response: d.pendingAsk.response };
			const o = other ? await other() : undefined;
			if (o !== undefined) return { other: o };
			if (rt.signal.aborted) throw new Cancelled();
			await Promise.race([svc.changed(id, pollMs), rt.sleep(svc.now() + pollMs, c).catch(() => undefined)]);
			if (rt.signal.aborted) throw new Cancelled();
		}
	}

	/** A fresh review: a new reviewer Conversation and the review's record (QA is decided on entering REVIEWING). */
	async function enterReview(rt: TaskRuntime<any, any, any, any>, tx: Tx, doc: D) {
		doc.counters.reviewSeq += 1;
		const seq = doc.counters.reviewSeq;
		const reviewer = await createRoleConversation(rt, tx, doc, "reviewer");
		doc.conversations.reviewers.push({ id: reviewer, seq });
		doc.reviews = { ...(doc.reviews ?? {}), [String(seq)]: { seq, round: doc.counters.reviewRound, reviewer } };
	}

	/** Change the current review's record (its own commit, no transition). */
	async function commitReview(rt: TaskRuntime<any, any, any, any>, c: Context, id: string, seq: number, change: (r: ReviewRoundState, doc: D) => void) {
		await rt.commit(async (tx) => {
			const doc = await docIn(tx, id);
			doc.reviews ??= {};
			const r = (doc.reviews[String(seq)] ??= { seq, round: doc.counters.reviewRound });
			change(r, doc);
			doc.updatedAt = svc.now();
			return undefined;
		}, c);
	}

	/**
	 * The current review (review #reviewSeq): the reviewer and, when AQ testing applies, the QA agent in a fresh VM, in
	 * parallel. Each submission is committed as it arrives, so a resume continues where the review was. `base` is the
	 * commit the reviewer's diff is taken against.
	 */
	async function runReview(
		rt: TaskRuntime<any, any, any, any>,
		c: Context,
		d: D,
		inputs: {
			base: string;
			reviewerInput(doc: D, diff: { stat: string; patch: string; files: { path: string; status: string }[] }, since?: { base: string; stat: string; patch: string }): string;
			qaInput(doc: D, r: ReviewRoundState, bootOk: boolean): string;
		},
	): Promise<void> {
		const seq = d.counters.reviewSeq;
		const ws = d.workspace!;
		const reviewer = d.conversations.reviewers.find((x) => x.seq === seq)!.id;
		// Runs that entered REVIEWING before AQ testing existed have no review record: QA is off for them.
		if (!d.reviews?.[String(seq)]) await commitReview(rt, c, d.id, seq, (r) => Object.assign(r, { reviewer, qaStatus: "off" }));
		let r = (await read(rt, d.id, c)).reviews![String(seq)]!;
		if (!r.sha) {
			const sha = await svc.github.snapshot(ws, `review-${seq}`, rc(d));
			await commitReview(rt, c, d.id, seq, (x) => (x.sha = sha));
		}
		if (r.qaStatus === undefined) {
			// AQ testing applies when it is on for the project and one of the run scripts exists at the reviewed build.
			const cfg = d.pinned.config;
			const runScripts = (cfg.boat?.runScripts ?? []) as string[];
			const status: ReviewRoundState["qaStatus"] = cfg.qa?.enabled !== true ? "off" : runScripts.some((p) => existsSync(join(ws.path, p))) ? "pending" : "skipped";
			await commitReview(rt, c, d.id, seq, (x) => (x.qaStatus = status));
		}
		r = (await read(rt, d.id, c)).reviews![String(seq)]!;

		const reviewerBranch = async () => {
			if (r.review) return;
			const doc = await read(rt, d.id, c);
			const diff = await svc.github.diff(ws, inputs.base);
			const prevSha = doc.reviews?.[String(seq - 1)]?.sha;
			const since = prevSha ? await svc.github.diff(ws, prevSha) : undefined;
			const key = `${d.id}:REVIEWING:${seq}`;
			const res = await runAgent(rt, c, doc, "reviewer", reviewer, key, inputs.reviewerInput(doc, diff, since ? { base: prevSha!, stat: since.stat, patch: since.patch } : undefined), ["submit_review"]);
			const checked = validateReview(res.payload);
			if (!checked.ok) throw new Error(`invalid review reached the core: ${checked.problems.join("; ")}`);
			await rt.commit(async (tx) => {
				const x = await docIn(tx, d.id);
				x.reviews![String(seq)]!.review = checked.review;
				pushCost(x, "reviewer", reviewer, res);
				return undefined;
			}, c);
		};

		const qaBranch = async () => {
			if (r.qaStatus !== "pending" && !(r.qaStatus === "ran" && !r.qaResult)) return;
			let prov: Awaited<ReturnType<Boat["provision"]>>;
			try {
				prov = await svc.boat.provision(ws, rc(d), { seq, bundle: (out) => svc.github.bundle(ws, `review-${seq}`, out, rc(d)) });
			} catch (e) {
				const why = e instanceof Error ? e.message : String(e);
				svc.log(`${hooks.noun} ${d.id}: boat unavailable for review ${seq}: ${why}`);
				await svc.boat.dispose(`${d.id}-qa-${seq}`).catch(() => undefined);
				await commitReview(rt, c, d.id, seq, (x, doc) => {
					x.qaStatus = "unavailable";
					if (x.vm) x.vm.state = "disposed";
					notice(doc, { level: "warn", text: `AQ testing unavailable for review #${seq}: boat.dev could not provide a VM (${why.slice(0, 200)}); this round is the review alone` });
				});
				return;
			}
			const vmRec = svc.boat.record(prov.envId);
			await rt.commit(async (tx) => {
				const doc = await docIn(tx, d.id);
				const x = doc.reviews![String(seq)]!;
				x.vm = { envId: prov.envId, id: prov.vmId, name: prov.name, attempt: prov.attempt, state: "ready", outcome: prov.outcome };
				x.bootLog = prov.bootLog;
				if (x.qa === undefined) {
					x.qa = await createRoleConversation(rt, tx, doc, "qa", { envId: prov.envId, ...(vmRec?.appDir ? { cwd: vmRec.appDir } : {}), seq });
					doc.conversations.qa = [...(doc.conversations.qa ?? []), { id: x.qa, seq }];
					x.qaStatus = "ran";
					x.toldAttempt = `${prov.attempt}:${prov.outcome}`;
				}
				return undefined;
			}, c);
			const doc = await read(rt, d.id, c);
			const x = doc.reviews![String(seq)]!;
			const qaConv = x.qa!;
			const told = `${prov.attempt}:${prov.outcome}`;
			if ((prov.outcome === "restarted" || prov.outcome === "replaced") && x.toldAttempt !== told) {
				// After a crash: the VM was stopped (resumed, product restarted) or gone (replaced). Tell the QA agent.
				const handle = await rt.conversation(qaConv as never, c);
				const note =
					prov.outcome === "replaced"
						? "[factory] Your VM was lost and has been replaced with a fresh one running the same reviewed build. Files and state you created there are gone; screenshots you already took are kept. Continue testing."
						: "[factory] Your VM was stopped and has been resumed; the product was restarted. Continue testing.";
				await handle?.submit({ type: "input", content: note, requestId: `${d.id}:QA:${seq}:vm:${told}`, whenBusy: "steer" }, c);
				await commitReview(rt, c, d.id, seq, (y) => (y.toldAttempt = told));
			}
			const key = `${d.id}:QA:${seq}`;
			const res = await runAgent(rt, c, doc, "qa", qaConv, key, inputs.qaInput(doc, x, prov.bootOk), ["submit_qa"], undefined, { drive: false });
			const taken = ((await rt.snapshot(ScreenshotsDoc, qaConv as never, c)) as { ids?: string[] } | undefined)?.ids ?? [];
			const checked = validateQa(res.payload, taken);
			if (!checked.ok) throw new Error(`invalid QA verdict reached the core: ${checked.problems.join("; ")}`);
			const usage = await svc.boat.usage(prov.envId).catch(() => undefined);
			await svc.boat.dispose(prov.envId).catch((e) => svc.log(`${hooks.noun} ${d.id}: disposing QA VM failed: ${e}`));
			await rt.commit(async (tx) => {
				const y = await docIn(tx, d.id);
				const z = y.reviews![String(seq)]!;
				z.qaResult = checked.review;
				z.screenshots = [...taken];
				if (z.vm) z.vm.state = "disposed";
				pushCost(y, "qa", qaConv, res);
				if (usage) {
					const boatCfg = y.pinned.config.boat ?? {};
					y.cost.push({
						role: "qa",
						round: y.counters.reviewRound,
						seq,
						conversationId: String(qaConv),
						model: `boat.dev VM (${boatCfg.size ?? "default"})`,
						thinking: "",
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						usd: usage.dollars,
						durationMs: usage.seconds * 1000,
						vmSeconds: usage.seconds,
					});
				}
				return undefined;
			}, c);
		};

		// The review and AQ testing run in parallel; the core waits for both, even when one has already failed.
		const settled = await Promise.allSettled([reviewerBranch(), qaBranch()]);
		const failed = settled.find((x): x is PromiseRejectedResult => x.status === "rejected");
		if (failed) throw failed.reason;
	}

	/**
	 * Record the current review's outcome in `doc` (inside the transition's commit): finding ids, the findings log, the
	 * last review and a notice. Returns the verdict and the findings for the caller's next state.
	 */
	function reviewOutcome(doc: D): { verdict: "pass" | "fail"; findings: Finding[]; qaStatus: QaStatus } {
		const seq = doc.counters.reviewSeq;
		const x = doc.reviews![String(seq)]!;
		const qaStatus = (x.qaStatus === "pending" ? "unavailable" : x.qaStatus) as QaStatus;
		x.qaStatus = qaStatus;
		const reviewFindings = assignIds(doc, x.review!.findings);
		const qaFindings = x.qaResult ? assignIds(doc, x.qaResult.findings) : [];
		const findings = [...reviewFindings, ...qaFindings];
		const verdict: "pass" | "fail" = findings.some((f) => f.blocking) ? "fail" : "pass";
		doc.lastReview = { verdict, findings };
		doc.findingsLog.push({ seq: doc.findingsLog.length + 1, kind: "review", round: doc.counters.reviewRound, reviewSeq: seq, findings: reviewFindings, reviewerConversation: x.reviewer });
		if (x.qaResult) doc.findingsLog.push({ seq: doc.findingsLog.length + 1, kind: "qa", round: doc.counters.reviewRound, reviewSeq: seq, findings: qaFindings, reviewerConversation: x.qa! });
		doc.humanFindingsForReview = [];
		const qaNote = `QA ${qaStatus}${x.qaResult ? ` (${x.qaResult.verdict})` : ""}`;
		if (verdict === "pass") {
			doc.advisory = findings.filter((f) => !f.blocking);
			notice(doc, { level: "info", text: `Review passed (review #${seq}; ${qaNote})${doc.advisory.length ? ` with ${doc.advisory.length} advisory finding(s)` : ""}`, qaStatus });
		} else {
			const blocking = findings.filter((f) => f.blocking).length;
			notice(doc, { level: "warn", text: `Review round failed (review #${seq}; reviewer ${x.review!.verdict}, ${qaNote}): ${blocking} blocking finding(s)`, qaStatus });
		}
		return { verdict, findings, qaStatus };
	}

	/** Poll CI on a delivered commit until it is green or red, or no checks appeared within `ci.noChecksTimeout`. */
	async function waitForCi(rt: TaskRuntime<any, any, any, any>, c: Context, d: D, delivery: Delivery, startedAt: number, poll?: () => Promise<boolean>): Promise<CiStatus | undefined> {
		const ci = d.pinned.config.ci ?? {};
		const timeout = parseDuration(ci.noChecksTimeout ?? "2m");
		const names: string[] | undefined = Array.isArray(ci.checks) && ci.checks.length ? ci.checks : undefined;
		for (;;) {
			const st = await svc.github.checks(delivery, names, rc(d));
			if (st.state === "green" || st.state === "red") return st;
			if (st.state === "none" && svc.now() - startedAt >= timeout) return st;
			// `poll` lets the caller stop waiting (a bundle whose PR was merged or closed meanwhile).
			if (poll && (await poll())) return undefined;
			await rt.sleep(svc.now() + svc.ciPollMs, c);
		}
	}

	async function sideEffectsAtEnd(d: D) {
		for (const e of Object.values(d.envs)) if (e) await svc.sandbox.dispose(e.envId).catch((err) => svc.log(`dispose failed: ${err}`));
		// any QA VM still live is deleted (delivered, failed or cancelled)
		for (const r of Object.values(d.reviews ?? {})) if (r.vm && r.vm.state !== "disposed") await svc.boat.dispose(r.vm.envId).catch((err) => svc.log(`QA VM dispose failed: ${err}`));
	}

	/** Record the QA VMs sideEffectsAtEnd deleted. */
	async function markVmsDisposed(rt: TaskRuntime<any, any, any, any>, c: Context, id: string) {
		const d = await read(rt, id, c);
		if (!Object.values(d.reviews ?? {}).some((r) => r.vm && r.vm.state !== "disposed")) return;
		await rt.commit(async (tx) => {
			const doc = await docIn(tx, id);
			for (const r of Object.values(doc.reviews ?? {})) if (r.vm) r.vm.state = "disposed";
			return undefined;
		}, c);
	}

	return {
		read,
		docIn,
		rc,
		newAsk,
		notice,
		assignIds,
		createRoleConversation,
		runAgent,
		deliverHeld,
		pushCost,
		settleUsage,
		awaitResponseOr,
		enterReview,
		commitReview,
		runReview,
		reviewOutcome,
		waitForCi,
		sideEffectsAtEnd,
		markVmsDisposed,
	};
}
