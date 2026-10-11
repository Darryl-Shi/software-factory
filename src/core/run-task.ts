// The core state machine (spec §4) as a Pi Durable Task. One phase per run state; every transition commits the
// `factory.run` Document together with the task checkpoint, atomically. The core never calls a model: it creates and
// configures role Conversations, submits input to them and reads what they commit through the bridge.
import type { Context } from "@earendil-works/chord";
import {
	configure,
	defineTask,
	type Extension,
	type TaskRuntime,
	type ToolRegistration,
	type Tx,
	UsageDoc,
} from "@earendil-works/pi-durable";
import { createEditTool, createWriteTool } from "@earendil-works/pi-durable/tools";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROLE_TOOLS } from "../agents/tools.ts";
import type { Boat } from "../boat/boat.ts";
import type { GitHub } from "../github/github.ts";
import type { Sandbox } from "../sandbox/sandbox.ts";
import { BridgeDoc, type BridgeTool, bridgeToolsNotFor, EnvDoc, ScreenshotsDoc } from "./bridge.ts";
import { formatFinding, validateQa, validateReview } from "./findings.ts";
import { messageContent } from "./messages.ts";
import { RunConfigDoc } from "./run-config.ts";
import { lastQaStatus, type ReviewRoundState, RunDoc, type RunDocState } from "./run-doc.ts";
import { parseDuration } from "./settings.ts";
import { addCost, sumUsage, type UsageSum } from "./usage.ts";
import type {
	CiStatus,
	DeliveryContext,
	DiscussionLink,
	EscalationInfo,
	Finding,
	FindingResponse,
	Gate,
	Notice,
	PendingAsk,
	QaStatus,
	Question,
	ReviewResult,
	Role,
	RunCtx,
	RunState,
} from "./types.ts";

type Phase = RunState | "FINAL";
type Checkpoint = { phase: Phase; n: number };
type RunInput = { runId: string; start: RunState };

export interface CoreServices {
	github: GitHub;
	sandbox: Sandbox;
	/** boat.dev VMs for AQ testing (§3.7). */
	boat: Boat;
	/** Where run artifacts (QA screenshots) live: <artifactsDir>/<runId>/screenshots/<id>.png. */
	artifactsDir: string;
	/** Whether a provider/modelId accepts image input (QA screenshots go to the builder as images only then). */
	acceptsImages(model: string): boolean;
	bridge: Extension;
	/** Resolves when the run's document changes (answers, approvals); never rejects. */
	changed(runId: string, ms: number): Promise<void>;
	now(): number;
	ciPollMs: number;
	log(msg: string): void;
}

const MAX_NUDGES = 2;
/** Removed from every role but the builder (and its helpers). */
export const WRITE_TOOLS: ToolRegistration[] = [createWriteTool() as ToolRegistration, createEditTool() as ToolRegistration];

class Cancelled extends Error {}

export function createRunTask(svc: CoreServices) {
	// ------------------------------------------------------------------ helpers
	const read = async (rt: TaskRuntime<any, any, any, any>, runId: string, c: Context) => {
		const d = await rt.snapshot(RunDoc, runId, c);
		if (!d) throw new Error(`run ${runId} has no document`);
		return d as RunDocState;
	};

	/** Commit a document change and the next checkpoint together. */
	async function transition(
		rt: TaskRuntime<RunInput, Checkpoint, string, object>,
		c: Context,
		runId: string,
		change: (d: RunDocState, tx: Tx) => Phase | Promise<Phase>,
	): Promise<void> {
		await rt.commit(async (tx, current) => {
			const d = (await tx.doc(RunDoc, runId, null as never)) as unknown as RunDocState;
			const before = d.state;
			const next = await change(d, tx);
			const n = current.state.checkpoint.n + 1;
			if (next !== "FINAL" && next !== before) {
				d.history.push({ from: before, to: next, at: svc.now(), round: d.counters.reviewRound });
				d.state = next;
			}
			if (next !== "AWAITING_APPROVAL") delete d.gate;
			delete d.driving;
			d.updatedAt = svc.now();
			return { status: "running", checkpoint: { phase: next, n } };
		}, c);
	}

	function newAsk(d: RunDocState, question: Question): PendingAsk {
		d.counters.askSeq += 1;
		const ask: PendingAsk = { id: `${d.id}-ask${d.counters.askSeq}`, question: JSON.parse(JSON.stringify(question)), createdAt: svc.now() };
		d.pendingAsk = ask;
		return ask;
	}

	function notice(d: RunDocState, n: Omit<Notice, "at">) {
		d.notices.push(JSON.parse(JSON.stringify({ at: svc.now(), ...n })) as Notice);
	}

	function assignIds(d: RunDocState, findings: Finding[]): Finding[] {
		return findings.map((f) => {
			d.counters.findingSeq += 1;
			return { ...f, id: `F${d.counters.findingSeq}` };
		});
	}

	function gates(d: RunDocState): Gate[] {
		return (d.pinned.config.policy?.approvals ?? []) as Gate[];
	}

	/** What `GitHub` and `Sandbox` calls get: the run id and the run's pinned config. */
	function rc(d: RunDocState): RunCtx {
		return { runId: d.id, config: d.pinned.config };
	}

	async function createRoleConversation(
		rt: TaskRuntime<any, any, any, any>,
		tx: Tx,
		d: RunDocState,
		role: Role,
		qa?: { envId: string; cwd?: string; seq: number },
	): Promise<string> {
		const roleCfg = d.pinned.config.roles?.[role] ?? {};
		// The QA agent works in its boat.dev VM; every other role in the run's local sandbox.
		const env = qa ? { envId: qa.envId, cwd: qa.cwd } : (d.envs[role] ?? d.envs.builder);
		const conv = await tx.createConversation({ ownership: { kind: "task", taskId: rt.taskId } });
		const [provider, ...rest] = String(roleCfg.model ?? "").split("/");
		const extensions = [...ROLE_TOOLS[role], svc.bridge];
		const remove = [...bridgeToolsNotFor(role), ...(role === "builder" ? [] : WRITE_TOOLS)];
		await configure(tx, conv.id, {
			model: { provider: provider!, modelId: rest.join("/") },
			thinkingLevel: (roleCfg.thinking ?? "medium") as any,
			extensions,
			tools: { remove },
			...(env?.cwd ? { cwd: env.cwd } : {}),
		});
		const b = await tx.doc(BridgeDoc, conv.id);
		b.runId = d.id;
		b.role = role;
		const e = await tx.doc(EnvDoc, conv.id);
		e.runId = d.id;
		e.role = role;
		if (env) e.envId = env.envId;
		const rc = await tx.doc(RunConfigDoc, conv.id);
		rc.runId = d.id;
		rc.webSearch = JSON.parse(JSON.stringify(d.pinned.config.webSearch ?? {}));
		if (qa) rc.qa = { seq: qa.seq, artifactsDir: svc.artifactsDir };
		return conv.id as unknown as string;
	}

	type AgentResult = { tool: BridgeTool; payload: any; usage: { before: UsageSum; after: UsageSum; durationMs: number } };

	/** Hand human messages that were waiting for this role's turn to its Conversation, as steers (see messages.ts). */
	async function deliverHeld(rt: TaskRuntime<any, any, any, any>, c: Context, runId: string, role: Role, conversationId: string, handle: { submit: (s: any, c: Context) => Promise<unknown> }) {
		const doc = await read(rt, runId, c);
		const held = (doc.messages ?? []).filter((m) => m.to === role && m.conversationId === undefined);
		if (!held.length) return;
		for (const m of held) await handle.submit({ type: "input", content: messageContent(doc, m), requestId: m.id, whenBusy: "steer" }, c);
		await rt.commit(async (tx) => {
			const r = (await tx.doc(RunDoc, runId, null as never)) as unknown as RunDocState;
			for (const m of r.messages ?? []) if (held.some((h) => h.id === m.id)) m.conversationId = String(conversationId);
			return undefined;
		}, c);
	}

	/** Submit input to a role Conversation (idempotent by request key) and read what it committed through the bridge. */
	async function runAgent(
		rt: TaskRuntime<RunInput, Checkpoint, string, object>,
		c: Context,
		d: RunDocState,
		role: Role,
		conversationId: string,
		key: string,
		content: string | ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[],
		tools: BridgeTool[],
		findingIds?: string[],
		opts: { drive?: boolean } = {},
	): Promise<AgentResult> {
		if (d.counters.attempt) key = `${key}:retry${d.counters.attempt}`;
		await rt.commit(async (tx) => {
			const b = await tx.doc(BridgeDoc, conversationId as never);
			if (b.expect?.key !== key) b.expect = { key, tools, ...(findingIds ? { findingIds } : {}) };
			// The QA agent runs beside the reviewer and takes no messages: it never becomes the run's active agent.
			if (opts.drive !== false) {
				const r = await tx.doc(RunDoc, d.id, null as never);
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

	const pushCost = (doc: RunDocState, role: Role, conversationId: string, r: AgentResult) =>
		addCost(doc, role, conversationId, r.usage.before, r.usage.after, r.usage.durationMs, { always: true });

	/** At the end of a run: usage of turns nobody recorded yet (a message's turn the core didn't see finish). */
	async function settleUsage(rt: TaskRuntime<any, any, any, any>, c: Context, runId: string) {
		const d = await read(rt, runId, c);
		const convs: [Role, string][] = [
			...(d.conversations.architect !== undefined ? [["architect", d.conversations.architect] as [Role, string]] : []),
			...(d.conversations.builder !== undefined ? [["builder", d.conversations.builder] as [Role, string]] : []),
			...d.conversations.reviewers.map((r) => ["reviewer", r.id] as [Role, string]),
			...(d.conversations.qa ?? []).map((r) => ["qa", r.id] as [Role, string]),
		];
		const now = await Promise.all(convs.map(async ([, id]) => sumUsage((await rt.snapshot(UsageDoc, id as never, c)) as any)));
		if (!convs.some(([, id], i) => now[i]!.totalTokens > (d.usage?.[String(id)]?.totalTokens ?? 0))) return;
		await rt.commit(async (tx) => {
			const doc = (await tx.doc(RunDoc, runId, null as never)) as unknown as RunDocState;
			// Only Conversations with accounted usage: runs started before accounting existed have no baseline.
			convs.forEach(([role, id], i) => {
				const seen = doc.usage?.[String(id)];
				if (seen && now[i]!.totalTokens > seen.totalTokens) addCost(doc, role, id, seen, now[i]!, 0, { trigger: "message" });
			});
			return undefined;
		}, c);
	}

	async function awaitResponse(rt: TaskRuntime<any, any, any, any>, c: Context, runId: string, askId: string) {
		const r = await awaitResponseOr(rt, c, runId, askId);
		return r.response!;
	}

	/** Wait for the human's response to an ask, or for `other` to produce something first (checked after the response). */
	async function awaitResponseOr<T>(rt: TaskRuntime<any, any, any, any>, c: Context, runId: string, askId: string, other?: () => Promise<T | undefined>) {
		for (;;) {
			const d = await read(rt, runId, c);
			if (d.pendingAsk?.id === askId && d.pendingAsk.response) return { response: d.pendingAsk.response };
			const o = other ? await other() : undefined;
			if (o !== undefined) return { other: o };
			if (rt.signal.aborted) throw new Cancelled();
			await Promise.race([svc.changed(runId, 1000), rt.sleep(svc.now() + 1000, c).catch(() => undefined)]);
			if (rt.signal.aborted) throw new Cancelled();
		}
	}

	function toBuilding(d: RunDocState, findings: Finding[], note?: string): RunState {
		d.counters.buildSeq += 1;
		d.pending.builderFindings = findings;
		if (note) d.pending.builderNote = note;
		else delete d.pending.builderNote;
		return "BUILDING";
	}

	function toEscalated(d: RunDocState, info: EscalationInfo): RunState {
		d.escalation = info;
		newAsk(d, { kind: "escalation", reason: info.reason, options: ["accept", "more-rounds", "abort"] });
		notice(d, { level: "warn", text: `Escalated: ${info.reason}` });
		return "ESCALATED";
	}

	function toGateOrNext(d: RunDocState, gate: Gate, next: RunState): RunState {
		if (gates(d).includes(gate)) {
			d.gate = gate;
			const artifact =
				gate === "spec"
					? { kind: "spec" as const, path: "docs/spec.md", version: d.artifacts.spec?.version, sha256: d.artifacts.spec?.sha256 }
					: gate === "delivery"
						? { kind: "workspace" as const, path: d.workspace?.path, url: d.artifacts.delivery?.url }
						: { kind: "delivery" as const, url: d.artifacts.delivery?.url };
			newAsk(d, { kind: "approval", gate, artifact: artifact as any, options: ["approve", "reject"] });
			return "AWAITING_APPROVAL";
		}
		return next;
	}

	/** After CI is green/skipped or accepted: the merge gate applies only to PR deliveries. */
	function afterCi(d: RunDocState): Phase {
		if (d.artifacts.delivery?.kind === "pr" && gates(d).includes("merge")) return toGateOrNext(d, "merge", "DELIVERED");
		return toFinal(d, "DELIVERED");
	}

	function toFinal(d: RunDocState, state: "DELIVERED" | "FAILED" | "CANCELLED", reason?: string): Phase {
		if (state !== "DELIVERED") {
			d.failure = {
				state: d.state,
				...(d.gate ? { gate: d.gate } : {}),
				reason: reason ?? state.toLowerCase(),
				...(d.pendingAsk && !d.pendingAsk.response ? { pendingAsk: d.pendingAsk } : {}),
			};
		}
		delete d.pendingAsk;
		const url = d.artifacts.delivery?.url;
		const text =
			state === "DELIVERED"
				? `Delivered${url ? `: ${url}` : ""}${d.artifacts.delivery?.kind === "pr" && !gates(d).includes("merge") ? " (PR left open, no auto-merge)" : ""}${d.noCi ? " — the repo has no CI checks; CI did not run" : ""}`
				: `${state === "FAILED" ? "Failed" : "Cancelled"} in ${d.state}: ${reason ?? ""}`;
		const qa = lastQaStatus(d);
		const textQa = state === "DELIVERED" && qa ? `${text} · QA status: ${qa}` : text;
		notice(d, {
			level: state === "DELIVERED" ? "info" : state === "FAILED" ? "error" : "warn",
			text: textQa,
			...(url ? { url } : {}),
			advisory: d.advisory,
			acceptedBlocking: d.acceptedBlocking,
			...(d.noCi ? { noCi: true } : {}),
			...(lastQaStatus(d) ? { qaStatus: lastQaStatus(d) } : {}),
			final: true,
		});
		d.history.push({ from: d.state, to: state, at: svc.now(), round: d.counters.reviewRound });
		d.state = state;
		return "FINAL";
	}

	// ------------------------------------------------------------------ prompts the core hands to roles (data, not guidance)
	function architectFirstInput(d: RunDocState): string {
		const ws = d.workspace!;
		const disc = d.request.meta?.discussion as DiscussionLink | undefined;
		// The discussion the ticket was drafted in (discussions spec §2.3); without one, the input is unchanged.
		const prior = disc
			? [
					`# Prior discussion`,
					`The human discussed this with a model before writing the ticket ("${disc.title}"). Its summary:`,
					disc.summary,
					...(disc.siblings.length > 0
						? [`Other tickets drafted from the same discussion (out of scope here unless this ticket depends on them):`, ...disc.siblings.map((s) => `- ${s}`)]
						: []),
					`Treat points the summary marks as settled as settled; ask only about what is still open.`,
					"",
				]
			: [];
		return [
			`# Request (${d.request.source})`,
			`Title: ${d.request.title}`,
			"",
			d.request.body,
			"",
			`# Project`,
			`Project: ${d.project}; repo binding: ${d.repo} (${ws.newRepo ? "the repo does not exist yet: this is a new product" : "existing repo: this is an incremental change"}).`,
			`Workspace (read-only for you): ${ws.path}${ws.newRepo ? " (empty)" : "; read AGENTS.md and docs/spec.md first if present"}.`,
			"",
			...prior,
			"Discuss the architecture with the human, one question at a time (ask_human), then call submit_spec.",
		].join("\n");
	}

	function builderInput(d: RunDocState): string {
		const ws = d.workspace!;
		const findings = d.pending.builderFindings ?? [];
		if (d.counters.buildSeq <= 1 && findings.length === 0) {
			return [
				`# Build`,
				`Workspace: ${ws.path} (branch ${ws.branch}, base ${ws.baseRef.slice(0, 12)}). ${ws.newRepo ? "New repo." : "Existing repo: read AGENTS.md first."}`,
				`The spec is committed at docs/spec.md and is the contract. Here it is:`,
				"",
				d.artifacts.spec?.text ?? "",
				"",
				...(d.pinned.config.ci?.mode === "required"
					? [`Delivery constraint — CI: required. The delivered commit must pass the repo's CI checks, so the repo must have CI that runs the tests.`]
					: []),
				`When the product meets the spec, call report_done (responses: []).`,
			].join("\n");
		}
		return [
			`# Findings to address (round ${d.counters.reviewRound}${d.loop === "ci" ? `, CI fix ${d.counters.ciFixes}` : ""})`,
			d.pending.builderNote ?? "",
			...findings.map(formatFinding),
			"",
			`Fix what you agree with. Answer every BLOCKING finding id in report_done.responses: "fixed", or "wontfix" with a reason. Advisory findings are optional.`,
		].join("\n");
	}

	/** Builder input with the QA findings' screenshots as images, when the builder's model takes images. */
	function builderContent(d: RunDocState): string | ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] {
		const text = builderInput(d);
		const ids = [...new Set((d.pending.builderFindings ?? []).flatMap((f) => f.screenshots ?? []))];
		if (!ids.length || !svc.acceptsImages(String(d.pinned.config.roles?.builder?.model ?? ""))) return text;
		const parts: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] = [{ type: "text", text }];
		for (const id of ids.slice(0, 12)) {
			const file = join(svc.artifactsDir, d.id, "screenshots", `${id}.png`);
			if (!existsSync(file)) continue;
			parts.push({ type: "text", text: `\nScreenshot ${id} (QA):` }, { type: "image", data: readFileSync(file).toString("base64"), mimeType: "image/png" });
		}
		return parts;
	}

	/** An agent's own prior findings (review or qa entries) with the builder's responses, plus human gate findings. */
	function priorSections(d: RunDocState, kind: "review" | "qa", label: string): string[] {
		const parts: string[] = [];
		const prior = d.findingsLog.filter((e) => e.kind === kind);
		const lastPrior = prior.at(-1);
		const responses = d.findingsLog.flatMap((e) => e.responses ?? []);
		if (lastPrior) {
			parts.push("", `## Your prior findings and the builder's responses (${label})`);
			for (const f of lastPrior.findings) {
				const r = responses.find((x) => x.findingId === f.id);
				parts.push(formatFinding(f), `  builder: ${r ? `${r.status}${r.reason ? ` — ${r.reason}` : ""}` : "(no response)"}`);
			}
		}
		const human = d.humanFindingsForReview;
		if (human.length) {
			parts.push("", "## Human findings from a gate rejection (blocking)");
			for (const f of human) {
				const r = responses.find((x) => x.findingId === f.id);
				parts.push(formatFinding(f), `  builder: ${r ? `${r.status}${r.reason ? ` — ${r.reason}` : ""}` : "(no response)"}`);
			}
		}
		return parts;
	}

	const clip = (patch: string) => (patch.length > 60_000 ? patch.slice(0, 60_000) + "\n… (truncated; inspect the workspace)" : patch);

	function reviewerInput(d: RunDocState, diff: { stat: string; patch: string; files: { path: string; status: string }[] }, since?: { base: string; stat: string; patch: string }): string {
		const ws = d.workspace!;
		const qaOn = d.pinned.config.qa?.enabled === true;
		const runScripts = (d.pinned.config.boat?.runScripts ?? []) as string[];
		const parts = [
			`# Review (review #${d.counters.reviewSeq}, round ${d.counters.reviewRound}${d.loop === "ci" ? `, after CI fix ${d.counters.ciFixes}` : ""})`,
			`Workspace (read-only): ${ws.path}. Review the WHOLE product against the spec, not only the diff.`,
			`Run the test suite yourself; do not trust the builder's report. Flag any test deleted or weakened in the diff. Run the product (bash; curl a running service) and check the acceptance behaviours.`,
			`Review the round's diff and the code it touches for quality and security (structure, duplication, maintainability, error handling; injection, unsafe input handling, secrets in code, missing access checks). Who wrote a line does not matter.`,
			...(qaOn
				? [`AQ testing is on for this project: if the product is something a user launches (an app, a service, a CLI), a missing or broken run script (one of ${runScripts.join(", ")}) is a BLOCKING finding.`]
				: []),
			"",
			`## Spec (docs/spec.md)`,
			d.artifacts.spec?.text ?? "",
			"",
			`## Diff against base ${ws.baseRef.slice(0, 12)} (repo.diff)`,
			"```",
			diff.stat,
			"```",
			"Changed files: " + diff.files.map((f) => `${f.status} ${f.path}`).join(", "),
			"```diff",
			clip(diff.patch),
			"```",
		];
		if (since)
			parts.push("", `## Changes since the previous review (${since.base.slice(0, 12)})`, "```", since.stat || "(no change)", "```", "```diff", clip(since.patch), "```");
		parts.push(...priorSections(d, "review", "reviewer"));
		parts.push("", `Call submit_review. Every finding needs evidence you observed (a command and its output, or file and lines); give specRef when a spec clause applies.`);
		return parts.join("\n");
	}

	function qaInput(d: RunDocState, r: ReviewRoundState, bootOk: boolean): string {
		const ws = d.workspace!;
		const agents = existsSync(join(ws.path, "AGENTS.md")) ? readFileSync(join(ws.path, "AGENTS.md"), "utf8").slice(0, 12_000) : "(no AGENTS.md)";
		return [
			`# AQ testing (review #${r.seq}, round ${r.round})`,
			`The reviewed build is checked out in this VM at ${svc.boat.record(r.vm!.envId)?.appDir ?? "~/app"} and ${bootOk ? "is running" : "did NOT boot cleanly (see the output below)"}. Use it like its user would, with the computer tool, and check the acceptance behaviours. The product runs on localhost; AGENTS.md says where.`,
			"",
			`## Spec (docs/spec.md)`,
			d.artifacts.spec?.text ?? "",
			"",
			`## AGENTS.md`,
			agents,
			"",
			`## Setup and run script output`,
			"```",
			(r.bootLog ?? "").slice(-8000),
			"```",
			...(bootOk ? [] : ["A product that does not boot from a clean checkout is a blocking finding: take a screenshot of the failure in the terminal and cite it."]),
			...priorSections(d, "qa", "QA"),
			"",
			`Call submit_qa. Every finding needs evidence (the UI steps and what you saw) and at least one screenshot id you took this round.`,
		].join("\n");
	}

	// ------------------------------------------------------------------ phases
	type RT = TaskRuntime<RunInput, Checkpoint, string, object>;
	const handlers: Record<Phase, (rt: RT, c: Context, d: RunDocState) => Promise<void>> = {
		RECEIVED: async (rt, c, d) => {
			await transition(rt, c, d.id, () => "PREPARING");
		},

		PREPARING: async (rt, c, d) => {
			// AQ testing needs a boat key; check that it resolves before any work (no VM yet).
			if (d.pinned.config.qa?.enabled === true && !svc.boat.keyResolves(d.pinned.config)) {
				const ref = d.pinned.config.boat?.apiKey ?? "env:BOAT_API_KEY";
				throw new Error(
					`AQ testing is on (qa.enabled) but the boat API key does not resolve (boat.apiKey = ${ref}). Either set the key (e.g. export ${String(ref).startsWith("env:") ? String(ref).slice(4) : "BOAT_API_KEY"} for the factory process), or set qa.enabled: false for project ${d.project}.`,
				);
			}
			const ws = await svc.github.open(d.repo, rc(d));
			const envs: RunDocState["envs"] = {};
			// Helpers run in the builder's environment; they get none of their own.
			for (const role of ["architect", "builder", "reviewer"] as Role[]) envs[role] = await svc.sandbox.provision(ws, role, rc(d));
			await transition(rt, c, d.id, async (doc, tx): Promise<Phase> => {
				doc.workspace = ws;
				doc.envs = envs;
				doc.conversations.architect = await createRoleConversation(rt, tx, doc, "architect");
				doc.pending.architectInput = architectFirstInput(doc);
				return "DISCUSSING";
			});
		},

		DISCUSSING: async (rt, c, d) => {
			if (d.pendingAsk?.question.kind === "discussion") {
				const resp = await awaitResponse(rt, c, d.id, d.pendingAsk.id);
				await transition(rt, c, d.id, (doc): Phase => {
					doc.counters.discussionSeq += 1;
					doc.pending.architectInput = resp.type === "answer" ? resp.text : JSON.stringify(resp);
					delete doc.pendingAsk;
					return "DISCUSSING";
				});
				return;
			}
			const conv = d.conversations.architect!;
			const key = `${d.id}:DISCUSSING:${d.counters.discussionSeq}`;
			const r = await runAgent(rt, c, d, "architect", conv, key, d.pending.architectInput ?? "", ["ask_human", "submit_spec"]);
			await transition(rt, c, d.id, (doc): Phase => {
				pushCost(doc, "architect", conv, r);
				delete doc.pending.architectInput;
				if (r.tool === "ask_human") {
					newAsk(doc, { kind: "discussion", text: r.payload.question });
					return "DISCUSSING";
				}
				const text = String(r.payload.markdown);
				const version = (doc.artifacts.spec?.version ?? 0) + 1;
				doc.artifacts.spec = { kind: "spec", path: "docs/spec.md", version, sha256: sha(text), text };
				return "SPEC_READY";
			});
		},

		SPEC_READY: async (rt, c, d) => {
			await svc.github.writeArtifact(d.workspace!, "docs/spec.md", d.artifacts.spec!.text, `docs: spec v${d.artifacts.spec!.version} (factory run ${d.id})`);
			await transition(rt, c, d.id, async (doc, tx): Promise<Phase> => {
				const next = toGateOrNext(doc, "spec", "BUILDING");
				if (next === "BUILDING") await startBuild(rt, tx, doc);
				// While the spec waits for approval, a human message may ask the architect for a change: it may answer
				// with one submit_spec, which replaces the version waiting (see AWAITING_APPROVAL).
				else await setBridgeExpect(tx, doc.conversations.architect!, { key: specGateKey(doc.pendingAsk!.id), tools: ["submit_spec"] });
				return next;
			});
		},

		AWAITING_APPROVAL: async (rt, c, d) => {
			const ask = d.pendingAsk!;
			const gate = d.gate!;
			const architect = d.conversations.architect;
			const revisedSpec =
				gate === "spec" && architect !== undefined
					? async () => (await rt.snapshot(BridgeDoc, architect as never, c))?.results[specGateKey(ask.id)]
					: undefined;
			const got = await awaitResponseOr(rt, c, d.id, ask.id, revisedSpec);
			if (got.other) {
				// The architect revised the spec after a human message: it replaces the version waiting for approval.
				const text = String(got.other.payload.markdown);
				await transition(rt, c, d.id, async (doc, tx): Promise<Phase> => {
					doc.closedAsk = { id: ask.id, by: "architect" };
					delete doc.pendingAsk;
					await setBridgeExpect(tx, architect!, null);
					const version = (doc.artifacts.spec?.version ?? 0) + 1;
					doc.artifacts.spec = { kind: "spec", path: "docs/spec.md", version, sha256: sha(text), text };
					notice(doc, { level: "info", text: `The architect revised the spec to v${version} after a message; it needs approval again` });
					return "SPEC_READY";
				});
				return;
			}
			const resp = got.response!;
			if (resp.type === "approve" && gate === "merge") {
				const pr = d.artifacts.delivery?.pr;
				if (!pr) throw new Error("merge approved but the delivery has no PR");
				await svc.github.merge(pr, "squash", rc(d));
			}
			await transition(rt, c, d.id, async (doc, tx): Promise<Phase> => {
				delete doc.pendingAsk;
				if (gate === "spec" && architect !== undefined) await setBridgeExpect(tx, architect, null);
				if (resp.type === "approve") {
					if (gate === "spec") {
						await startBuild(rt, tx, doc);
						return "BUILDING";
					}
					if (gate === "delivery") return "DELIVERING";
					notice(doc, { level: "info", text: `Merged ${doc.artifacts.delivery?.url ?? ""}` });
					return toFinal(doc, "DELIVERED");
				}
				if (resp.type !== "reject") throw new Error(`unexpected response ${resp.type} at gate ${gate}`);
				if (gate === "spec") {
					doc.counters.discussionSeq += 1;
					doc.pending.architectInput = `The human rejected the spec:\n\n${resp.feedback}\n\nContinue the discussion if you need to (one question at a time), then submit a revised spec.`;
					return "DISCUSSING";
				}
				// delivery / merge rejection: one or more blocking human findings; adds no review or CI round
				const findings = assignIds(doc, resp.findings.map((f) => ({ ...f, blocking: true, source: "human" as const })));
				doc.humanFindingsForReview.push(...findings);
				doc.findingsLog.push({ seq: doc.findingsLog.length + 1, kind: "human", round: doc.counters.reviewRound, findings });
				return toBuilding(doc, findings, `The human rejected the ${gate} gate.`);
			});
		},

		BUILDING: async (rt, c, d) => {
			const conv = d.conversations.builder!;
			const key = `${d.id}:BUILDING:${d.counters.buildSeq}`;
			const findings = d.pending.builderFindings ?? [];
			const ids = findings.filter((f) => f.blocking).map((f) => f.id!);
			const r = await runAgent(rt, c, d, "builder", conv, key, builderContent(d), ["report_done"], ids);
			const diff = await svc.github.diff(d.workspace!, d.workspace!.baseRef);
			const noProgress =
				d.counters.buildSeq > 1 && d.pinned.config.policy?.escalateOnNoProgress !== false && diff.fingerprint === d.lastFingerprint;
			await transition(rt, c, d.id, async (doc, tx): Promise<Phase> => {
				pushCost(doc, "builder", conv, r);
				const responses = r.payload.responses as FindingResponse[];
				const entry = [...doc.findingsLog].reverse().find((e) => e.findings.some((f) => ids.includes(f.id!)));
				if (entry) entry.responses = [...(entry.responses ?? []), ...responses];
				notice(doc, { level: "info", text: `Builder done (build #${doc.counters.buildSeq}): ${String(r.payload.summary).slice(0, 300)}` });
				doc.lastFingerprint = diff.fingerprint;
				if (noProgress)
					return toEscalated(doc, {
						reason: "no progress: the fix round produced an empty diff since the previous round",
						from: "BUILDING",
						cap: doc.loop === "ci" ? "ciFix" : "review",
						findings: doc.pending.builderFindings ?? [],
					});
				await enterReview(rt, tx, doc);
				return "REVIEWING";
			});
		},

		REVIEWING: async (rt, c, d) => {
			const seq = d.counters.reviewSeq;
			const ws = d.workspace!;
			const reviewer = d.conversations.reviewers.find((x) => x.seq === seq)!.id;
			// Runs that entered REVIEWING before AQ testing existed have no review record: QA is off for them.
			if (!d.reviews?.[String(seq)]) await commitReview(rt, c, d.id, seq, (r) => Object.assign(r, { reviewer, qaStatus: "off" }));
			let r = (await read(rt, d.id, c)).reviews![String(seq)]!;
			if (!r.sha) {
				const sha = await svc.github.snapshot(ws, `review-${seq}`);
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
				const diff = await svc.github.diff(ws, ws.baseRef);
				const prevSha = doc.reviews?.[String(seq - 1)]?.sha;
				const since = prevSha ? await svc.github.diff(ws, prevSha) : undefined;
				const key = `${d.id}:REVIEWING:${seq}`;
				const res = await runAgent(rt, c, doc, "reviewer", reviewer, key, reviewerInput(doc, diff, since ? { base: prevSha!, stat: since.stat, patch: since.patch } : undefined), ["submit_review"]);
				const checked = validateReview(res.payload);
				if (!checked.ok) throw new Error(`invalid review reached the core: ${checked.problems.join("; ")}`);
				await rt.commit(async (tx) => {
					const x = (await tx.doc(RunDoc, d.id, null as never)) as unknown as RunDocState;
					x.reviews![String(seq)]!.review = checked.review;
					pushCost(x, "reviewer", reviewer, res);
					return undefined;
				}, c);
			};

			const qaBranch = async () => {
				if (r.qaStatus !== "pending" && !(r.qaStatus === "ran" && !r.qaResult)) return;
				let prov: Awaited<ReturnType<Boat["provision"]>>;
				try {
					prov = await svc.boat.provision(ws, rc(d), { seq, bundle: (out) => svc.github.bundle(ws, `review-${seq}`, out) });
				} catch (e) {
					const why = e instanceof Error ? e.message : String(e);
					svc.log(`run ${d.id}: boat unavailable for review ${seq}: ${why}`);
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
					const doc = (await tx.doc(RunDoc, d.id, null as never)) as unknown as RunDocState;
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
				const res = await runAgent(rt, c, doc, "qa", qaConv, key, qaInput(doc, x, prov.bootOk), ["submit_qa"], undefined, { drive: false });
				const taken = ((await rt.snapshot(ScreenshotsDoc, qaConv as never, c)) as { ids?: string[] } | undefined)?.ids ?? [];
				const checked = validateQa(res.payload, taken);
				if (!checked.ok) throw new Error(`invalid QA verdict reached the core: ${checked.problems.join("; ")}`);
				const usage = await svc.boat.usage(prov.envId).catch(() => undefined);
				await svc.boat.dispose(prov.envId).catch((e) => svc.log(`run ${d.id}: disposing QA VM failed: ${e}`));
				await rt.commit(async (tx) => {
					const y = (await tx.doc(RunDoc, d.id, null as never)) as unknown as RunDocState;
					const z = y.reviews![String(seq)]!;
					z.qaResult = checked.review;
					z.screenshots = [...taken];
					if (z.vm) z.vm.state = "disposed";
					pushCost(y, "qa", qaConv, res);
					if (usage) {
						const roleCfg = y.pinned.config.boat ?? {};
						y.cost.push({
							role: "qa",
							round: y.counters.reviewRound,
							seq,
							conversationId: String(qaConv),
							model: `boat.dev VM (${roleCfg.size ?? "default"})`,
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

			await transition(rt, c, d.id, async (doc): Promise<Phase> => {
				const x = doc.reviews![String(seq)]!;
				const qaStatus = (x.qaStatus === "pending" ? "unavailable" : x.qaStatus) as QaStatus;
				x.qaStatus = qaStatus;
				const reviewFindings = assignIds(doc, x.review!.findings);
				const qaFindings = x.qaResult ? assignIds(doc, x.qaResult.findings) : [];
				const findings = [...reviewFindings, ...qaFindings];
				const verdict: "pass" | "fail" = findings.some((f) => f.blocking) ? "fail" : "pass";
				const review: ReviewResult = { verdict, findings };
				doc.lastReview = review;
				doc.findingsLog.push({ seq: doc.findingsLog.length + 1, kind: "review", round: doc.counters.reviewRound, reviewSeq: seq, findings: reviewFindings, reviewerConversation: reviewer });
				if (x.qaResult) doc.findingsLog.push({ seq: doc.findingsLog.length + 1, kind: "qa", round: doc.counters.reviewRound, reviewSeq: seq, findings: qaFindings, reviewerConversation: x.qa! });
				doc.humanFindingsForReview = [];
				const qaNote = `QA ${qaStatus}${x.qaResult ? ` (${x.qaResult.verdict})` : ""}`;
				if (verdict === "pass") {
					doc.advisory = findings.filter((f) => !f.blocking);
					notice(doc, { level: "info", text: `Review passed (review #${seq}; ${qaNote})${doc.advisory.length ? ` with ${doc.advisory.length} advisory finding(s)` : ""}`, qaStatus });
					return toGateOrNext(doc, "delivery", "DELIVERING");
				}
				const blocking = findings.filter((f) => f.blocking).length;
				notice(doc, { level: "warn", text: `Review round failed (review #${seq}; reviewer ${x.review!.verdict}, ${qaNote}): ${blocking} blocking finding(s)`, qaStatus });
				if (doc.loop === "ci") {
					if (doc.counters.ciFixes < doc.caps.ciFix) {
						doc.counters.ciFixes += 1;
						return toBuilding(doc, findings);
					}
					return toEscalated(doc, { reason: `review failed after CI fix ${doc.counters.ciFixes} (ci.fixRounds = ${doc.caps.ciFix} reached)`, from: "REVIEWING", cap: "ciFix", findings });
				}
				if (doc.counters.reviewRound < doc.caps.review) {
					doc.counters.reviewRound += 1;
					return toBuilding(doc, findings);
				}
				return toEscalated(doc, { reason: `review round cap reached (${doc.caps.review} rounds) with blocking findings`, from: "REVIEWING", cap: "review", findings });
			});
		},

		ESCALATED: async (rt, c, d) => {
			const resp = await awaitResponse(rt, c, d.id, d.pendingAsk!.id);
			if (resp.type !== "escalation") throw new Error(`unexpected response ${resp.type} to an escalation`);
			await transition(rt, c, d.id, (doc): Phase => {
				delete doc.pendingAsk;
				const esc = doc.escalation!;
				const choice = resp.choice;
				if ("abort" in choice) return toFinal(doc, "CANCELLED", "aborted at escalation");
				if ("accept" in choice) {
					doc.acceptedBlocking = esc.findings.filter((f) => f.blocking);
					notice(doc, { level: "warn", text: `Accepted as is with ${doc.acceptedBlocking.length} open blocking finding(s)` });
					if (esc.from === "AWAITING_CI") return afterCi(doc);
					return "DELIVERING";
				}
				const n = choice.moreRounds;
				const cap = esc.cap === "none" ? (doc.loop === "ci" ? "ciFix" : "review") : esc.cap;
				doc.caps[cap] += n;
				if (esc.from === "BUILDING") return toBuilding(doc, esc.findings, "The previous round produced no change. Address the findings below.");
				if (cap === "review") doc.counters.reviewRound += 1;
				else {
					doc.counters.ciFixes += 1;
					doc.loop = "ci";
				}
				return toBuilding(doc, esc.findings);
			});
		},

		DELIVERING: async (rt, c, d) => {
			const ws = d.workspace!;
			if (d.lastFingerprint !== undefined) {
				// A human message can lead the builder to change files after the review (at a gate or an escalation).
				// Unreviewed changes are never delivered: they go through review first.
				const now = await svc.github.diff(ws, ws.baseRef);
				if (now.fingerprint !== d.lastFingerprint) {
					await transition(rt, c, d.id, async (doc, tx): Promise<Phase> => {
						doc.lastFingerprint = now.fingerprint;
						notice(doc, { level: "warn", text: "The workspace changed after the last review (the builder acted on a message); reviewing again before delivery" });
						await enterReview(rt, tx, doc);
						return "REVIEWING";
					});
					return;
				}
			}
			if (ws.newRepo) await svc.github.create(d.repo, rc(d));
			const ctx: DeliveryContext = {
				spec: { kind: "spec", path: "docs/spec.md", version: d.artifacts.spec?.version },
				specText: d.artifacts.spec?.text ?? "",
				review: d.lastReview ?? { verdict: "pass", findings: [] },
				request: d.request,
				advisory: d.advisory,
				acceptedBlocking: d.acceptedBlocking,
				mode: ws.newRepo ? "push-main" : "pull-request",
				...(lastQaStatus(d) ? { qaStatus: lastQaStatus(d) } : {}),
			};
			const out = await svc.github.deliver(ws, ctx, rc(d));
			await transition(rt, c, d.id, (doc): Phase => {
				doc.artifacts.delivery = out;
				notice(doc, { level: "info", text: `${out.kind === "pr" ? "PR" : "Pushed to main"}: ${out.url} @ ${out.sha.slice(0, 12)}`, url: out.url });
				const mode = doc.pinned.config.ci?.mode ?? "if-present";
				if (mode === "off") return afterCi(doc);
				doc.ci = { startedAt: svc.now() };
				return "AWAITING_CI";
			});
		},

		AWAITING_CI: async (rt, c, d) => {
			const ci = d.pinned.config.ci ?? {};
			const mode = ci.mode ?? "if-present";
			const timeout = parseDuration(ci.noChecksTimeout ?? "2m");
			const names: string[] | undefined = Array.isArray(ci.checks) && ci.checks.length ? ci.checks : undefined;
			const dl = d.artifacts.delivery!;
			let st: CiStatus;
			for (;;) {
				st = await svc.github.checks(dl, names, rc(d));
				if (st.state === "green" || st.state === "red") break;
				if (st.state === "none" && svc.now() - d.ci!.startedAt >= timeout) break;
				await rt.sleep(svc.now() + svc.ciPollMs, c);
			}
			if (st.state === "none" && mode !== "required")
				await svc.github.annotate(dl, d.workspace!, "No CI checks appeared within ci.noChecksTimeout: the repo has no CI, so CI did not run.", rc(d));
			await transition(rt, c, d.id, (doc): Phase => {
				doc.ci = { ...doc.ci!, last: st };
				if (st.state === "none") {
					if (mode === "required")
						return toEscalated(doc, {
							reason: "no CI checks: ci.mode is required but no checks appeared within ci.noChecksTimeout",
							from: "AWAITING_CI",
							cap: "ciFix",
							findings: assignIds(doc, [
								{
									severity: "major",
									blocking: true,
									source: "ci",
									description: "CI is required for this project but the repo has no CI checks. Add a CI workflow (e.g. .github/workflows/ci.yml) that runs the test suite.",
								},
							]),
						});
					doc.noCi = true;
					notice(doc, { level: "info", text: "No CI checks appeared: the repo has no CI; finishing without CI.", noCi: true });
					return afterCi(doc);
				}
				if (st.state === "green") {
					notice(doc, { level: "info", text: `CI green on ${dl.sha.slice(0, 12)}` });
					return afterCi(doc);
				}
				const findings = assignIds(doc, [
					{
						severity: "major",
						blocking: true,
						source: "ci",
						description: `CI failed on the delivered commit ${dl.sha.slice(0, 12)}: ${(st.failures ?? []).join("; ") || "checks failed"}`,
						evidence: (st.failures ?? []).join("\n"),
					},
				]);
				doc.findingsLog.push({ seq: doc.findingsLog.length + 1, kind: "ci", round: doc.counters.reviewRound, findings });
				if (doc.counters.ciFixes < doc.caps.ciFix) {
					doc.counters.ciFixes += 1;
					doc.loop = "ci";
					notice(doc, { level: "warn", text: `CI red; fix round ${doc.counters.ciFixes}/${doc.caps.ciFix}` });
					return toBuilding(doc, findings);
				}
				return toEscalated(doc, { reason: `CI failed and ci.fixRounds (${doc.caps.ciFix}) is reached`, from: "AWAITING_CI", cap: "ciFix", findings });
			});
		},

		DELIVERED: async (rt, c, d) => finalize(rt, c, d),
		FAILED: async (rt, c, d) => finalize(rt, c, d),
		CANCELLED: async (rt, c, d) => finalize(rt, c, d),
		FINAL: async (rt, c, d) => finalize(rt, c, d),
	};

	const specGateKey = (askId: string) => `${askId}:spec-revision`;

	async function setBridgeExpect(tx: Tx, conversationId: string, expect: { key: string; tools: BridgeTool[] } | null) {
		const b = await tx.doc(BridgeDoc, conversationId as never);
		b.expect = expect;
	}

	/** A fresh review: a new reviewer Conversation and the review's record (QA is decided on entering REVIEWING). */
	async function enterReview(rt: TaskRuntime<any, any, any, any>, tx: Tx, doc: RunDocState) {
		doc.counters.reviewSeq += 1;
		const seq = doc.counters.reviewSeq;
		const reviewer = await createRoleConversation(rt, tx, doc, "reviewer");
		doc.conversations.reviewers.push({ id: reviewer, seq });
		doc.reviews = { ...(doc.reviews ?? {}), [String(seq)]: { seq, round: doc.counters.reviewRound, reviewer } };
	}

	/** Change the current review's record (its own commit, no transition). */
	async function commitReview(rt: TaskRuntime<any, any, any, any>, c: Context, runId: string, seq: number, change: (r: ReviewRoundState, doc: RunDocState) => void) {
		await rt.commit(async (tx) => {
			const doc = (await tx.doc(RunDoc, runId, null as never)) as unknown as RunDocState;
			doc.reviews ??= {};
			const r = (doc.reviews[String(seq)] ??= { seq, round: doc.counters.reviewRound });
			change(r, doc);
			doc.updatedAt = svc.now();
			return undefined;
		}, c);
	}

	async function startBuild(rt: TaskRuntime<any, any, any, any>, tx: Tx, d: RunDocState) {
		if (!d.conversations.builder) d.conversations.builder = await createRoleConversation(rt, tx, d, "builder");
		if (d.counters.buildSeq === 0) toBuilding(d, []);
	}

	async function sideEffectsAtEnd(d: RunDocState) {
		for (const e of Object.values(d.envs)) if (e) await svc.sandbox.dispose(e.envId).catch((err) => svc.log(`dispose failed: ${err}`));
		// any QA VM still live is deleted (delivered, failed or cancelled)
		for (const r of Object.values(d.reviews ?? {})) if (r.vm && r.vm.state !== "disposed") await svc.boat.dispose(r.vm.envId).catch((err) => svc.log(`QA VM dispose failed: ${err}`));
	}

	/** Record the QA VMs sideEffectsAtEnd deleted. */
	async function markVmsDisposed(rt: TaskRuntime<any, any, any, any>, c: Context, runId: string) {
		const d = await read(rt, runId, c);
		if (!Object.values(d.reviews ?? {}).some((r) => r.vm && r.vm.state !== "disposed")) return;
		await rt.commit(async (tx) => {
			const doc = (await tx.doc(RunDoc, runId, null as never)) as unknown as RunDocState;
			for (const r of Object.values(doc.reviews ?? {})) if (r.vm) r.vm.state = "disposed";
			return undefined;
		}, c);
	}

	async function finalize(rt: RT, c: Context, d: RunDocState) {
		await settleUsage(rt, c, d.id);
		await sideEffectsAtEnd(d);
		await markVmsDisposed(rt, c, d.id);
		await rt.commit(() => ({ status: "terminal", outcome: { status: "completed", result: d.state } }), c);
	}

	return defineTask<RunInput, Checkpoint, string>({
		name: "factory.run",
		version: 1,
		initial: (input) => ({ phase: input.start, n: 0 }),
		phases: Object.fromEntries(
			(Object.keys(handlers) as Phase[]).map((phase) => [
				phase,
				async (task: any, rt: RT, c: Context) => {
					const d = await read(rt, task.input.runId, c);
					try {
						await handlers[phase](rt, c, d);
					} catch (e) {
						if (rt.signal.aborted || e instanceof Cancelled) throw e;
						if (phase === "FINAL" || phase === "DELIVERED" || phase === "FAILED" || phase === "CANCELLED") throw e;
						const reason = e instanceof Error ? e.message : String(e);
						svc.log(`run ${d.id} failed in ${d.state}: ${reason}`);
						await transition(rt, c, d.id, (doc) => toFinal(doc, "FAILED", reason));
					}
				},
			]),
		) as any,
		abort: async (task, rt, c) => {
			const runId = task.input.runId;
			let d = await read(rt, runId, c);
			if (!["DELIVERED", "FAILED", "CANCELLED"].includes(d.state)) {
				await rt.commit(async (tx) => {
					const doc = (await tx.doc(RunDoc, runId, null as never)) as unknown as RunDocState;
					toFinal(doc, "CANCELLED", doc.cancelReason ?? "cancelled");
					delete doc.driving;
					doc.updatedAt = svc.now();
					return undefined;
				}, c);
				d = await read(rt, runId, c);
			}
			await settleUsage(rt, c, runId).catch((e) => svc.log(`usage settle failed: ${e}`));
			await sideEffectsAtEnd(d);
			await markVmsDisposed(rt, c, runId).catch(() => undefined);
			await rt.commit(() => ({ status: "terminal", outcome: { status: "aborted", reason: "cancelled" } }), c);
		},
	});
}

import { createHash } from "node:crypto";
function sha(s: string) {
	return createHash("sha256").update(s).digest("hex");
}
