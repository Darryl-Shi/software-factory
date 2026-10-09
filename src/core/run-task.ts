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
import { BridgeDoc, type BridgeTool, bridgeToolsNotFor, EnvDoc } from "./bridge.ts";
import { formatFinding, validateReview } from "./findings.ts";
import { RunDoc, type RunDocState } from "./run-doc.ts";
import { parseDuration } from "./settings.ts";
import type {
	CiStatus,
	CostRecord,
	DeliveryExtension,
	EnvironmentExtension,
	EscalationInfo,
	Finding,
	FindingResponse,
	Gate,
	IntakeExtension,
	Notice,
	PendingAsk,
	Question,
	RepoExtension,
	ReviewResult,
	Role,
	RunState,
	RunUpdate,
} from "./types.ts";

type Phase = RunState | "FINAL";
type Checkpoint = { phase: Phase; n: number };
type RunInput = { runId: string; start: RunState };

export interface CoreServices {
	repo(cfg: Record<string, any>): RepoExtension;
	delivery(cfg: Record<string, any>): DeliveryExtension;
	environment(cfg: Record<string, any>): EnvironmentExtension;
	intake(cfg: Record<string, any>): IntakeExtension | undefined;
	/** Worker extensions (Pi Durable extensions) for a role, from the run's pinned role config. */
	workerExtensions(role: Role, names: string[]): Extension[];
	bridge: Extension;
	/** Resolves when the run's document changes (answers, approvals); never rejects. */
	changed(runId: string, ms: number): Promise<void>;
	now(): number;
	ciPollMs: number;
	log(msg: string): void;
}

const MAX_NUDGES = 2;
const WRITE_TOOLS: ToolRegistration[] = [createWriteTool() as ToolRegistration, createEditTool() as ToolRegistration];

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

	function stage(d: RunDocState, name: string): Record<string, any> {
		return d.pinned.config.stages?.[name] ?? {};
	}

	function opts(d: RunDocState, name: string) {
		return { runId: d.id, settings: stage(d, name), stages: d.pinned.config.stages ?? {} };
	}

	async function createRoleConversation(rt: TaskRuntime<any, any, any, any>, tx: Tx, d: RunDocState, role: Role): Promise<string> {
		const roleCfg = d.pinned.config.roles?.[role] ?? {};
		const env = d.envs[role] ?? d.envs.builder;
		const conv = await tx.createConversation({ ownership: { kind: "task", taskId: rt.taskId } });
		const [provider, ...rest] = String(roleCfg.model ?? "").split("/");
		const extensions = [...svc.workerExtensions(role, roleCfg.extensions ?? []), svc.bridge];
		const remove = [...bridgeToolsNotFor(role), ...(role === "builder" ? [] : WRITE_TOOLS)];
		await configure(tx, conv.id, {
			model: { provider: provider!, modelId: rest.join("/") },
			thinkingLevel: (roleCfg.thinking ?? "medium") as any,
			extensions,
			tools: { remove },
			...(env ? { cwd: env.cwd } : {}),
		});
		const b = await tx.doc(BridgeDoc, conv.id);
		b.runId = d.id;
		b.role = role;
		const e = await tx.doc(EnvDoc, conv.id);
		e.runId = d.id;
		e.role = role;
		if (env) e.envId = env.envId;
		return conv.id as unknown as string;
	}

	type AgentResult = { tool: BridgeTool; payload: any; cost: CostRecord };

	/** Submit input to a role Conversation (idempotent by request key) and read what it committed through the bridge. */
	async function runAgent(
		rt: TaskRuntime<RunInput, Checkpoint, string, object>,
		c: Context,
		d: RunDocState,
		role: Role,
		conversationId: string,
		key: string,
		content: string,
		tools: BridgeTool[],
		findingIds?: string[],
	): Promise<AgentResult> {
		if (d.counters.attempt) key = `${key}:retry${d.counters.attempt}`;
		await rt.commit(async (tx) => {
			const b = await tx.doc(BridgeDoc, conversationId as never);
			if (b.expect?.key !== key) b.expect = { key, tools, ...(findingIds ? { findingIds } : {}) };
			const r = await tx.doc(RunDoc, d.id, null as never);
			r.conversations.active = conversationId;
			return undefined;
		}, c);
		const usageOf = async () => {
			const u = await rt.snapshot(UsageDoc, conversationId as never, c);
			const sum = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, usd: 0 };
			for (const bucket of [u?.models ?? {}, u?.tools ?? {}])
				for (const v of Object.values(bucket) as any[]) {
					sum.input += v.input ?? 0;
					sum.output += v.output ?? 0;
					sum.cacheRead += v.cacheRead ?? 0;
					sum.cacheWrite += v.cacheWrite ?? 0;
					sum.totalTokens += v.totalTokens ?? 0;
					sum.usd += v.cost?.total ?? 0;
				}
			return sum;
		};
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
			const sub = await handle.submit({ type: "input", content: text, requestId }, c);
			const settled = await sub.wait(c);
			result = (await rt.snapshot(BridgeDoc, conversationId as never, c))?.results[key];
			if (result === undefined && settled.status === "unanswered") {
				lastStatus = `unanswered (${(settled as any).reason ?? "unknown"}${(settled as any).error ? `: ${JSON.stringify((settled as any).error)}` : ""})`;
				if ((settled as any).reason !== "stale") break;
			}
		}
		if (result === undefined) throw new Error(`${role} conversation finished without calling ${tools.join("/")}${lastStatus ? `; last input ${lastStatus}` : ""}`);
		const after = await usageOf();
		const round = role === "reviewer" || role === "builder" ? d.counters.reviewRound : d.counters.discussionSeq;
		const cost: CostRecord = {
			role,
			round,
			seq: role === "reviewer" ? d.counters.reviewSeq : role === "builder" ? d.counters.buildSeq : d.counters.discussionSeq,
			conversationId,
			model: String(d.pinned.config.roles?.[role]?.model ?? ""),
			thinking: String(d.pinned.config.roles?.[role]?.thinking ?? ""),
			input: after.input - before.input,
			output: after.output - before.output,
			cacheRead: after.cacheRead - before.cacheRead,
			cacheWrite: after.cacheWrite - before.cacheWrite,
			totalTokens: after.totalTokens - before.totalTokens,
			usd: after.usd - before.usd,
			durationMs: svc.now() - startedAt,
		};
		return { ...result, cost };
	}

	async function awaitResponse(rt: TaskRuntime<any, any, any, any>, c: Context, runId: string, askId: string) {
		for (;;) {
			const d = await read(rt, runId, c);
			if (d.pendingAsk?.id === askId && d.pendingAsk.response) return d.pendingAsk.response;
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
		notice(d, {
			level: state === "DELIVERED" ? "info" : state === "FAILED" ? "error" : "warn",
			text,
			...(url ? { url } : {}),
			advisory: d.advisory,
			acceptedBlocking: d.acceptedBlocking,
			...(d.noCi ? { noCi: true } : {}),
			final: true,
		});
		d.history.push({ from: d.state, to: state, at: svc.now(), round: d.counters.reviewRound });
		d.state = state;
		return "FINAL";
	}

	// ------------------------------------------------------------------ prompts the core hands to roles (data, not guidance)
	function architectFirstInput(d: RunDocState): string {
		const ws = d.workspace!;
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
				...(stage(d, "delivery").ci?.mode === "required"
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

	function reviewerInput(d: RunDocState, diff: { stat: string; patch: string; files: { path: string; status: string }[] }): string {
		const ws = d.workspace!;
		const prior = d.findingsLog.filter((e) => e.kind === "review");
		const lastPrior = prior.at(-1);
		const parts = [
			`# Review (review #${d.counters.reviewSeq}, round ${d.counters.reviewRound}${d.loop === "ci" ? `, after CI fix ${d.counters.ciFixes}` : ""})`,
			`Workspace (read-only): ${ws.path}. Review the WHOLE product against the spec, not only the diff.`,
			`Run the test suite yourself; do not trust the builder's report. Flag any test deleted or weakened in the diff.`,
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
			diff.patch.length > 60_000 ? diff.patch.slice(0, 60_000) + "\n… (truncated; inspect the workspace)" : diff.patch,
			"```",
		];
		if (lastPrior) {
			const responses = d.findingsLog.filter((e) => e.kind !== "review" || e.seq > lastPrior.seq).flatMap((e) => e.responses ?? []);
			const allResponses = [...(lastPrior.responses ?? []), ...responses];
			parts.push("", "## Your prior findings and the builder's responses");
			for (const f of lastPrior.findings) {
				const r = allResponses.find((x) => x.findingId === f.id);
				parts.push(formatFinding(f), `  builder: ${r ? `${r.status}${r.reason ? ` — ${r.reason}` : ""}` : "(no response)"}`);
			}
		}
		const human = d.humanFindingsForReview;
		if (human.length) {
			parts.push("", "## Human findings from a gate rejection (blocking)");
			const responses = d.findingsLog.flatMap((e) => e.responses ?? []);
			for (const f of human) {
				const r = responses.find((x) => x.findingId === f.id);
				parts.push(formatFinding(f), `  builder: ${r ? `${r.status}${r.reason ? ` — ${r.reason}` : ""}` : "(no response)"}`);
			}
		}
		parts.push("", `Call submit_review. Every finding needs specRef and evidence you observed.`);
		return parts.join("\n");
	}

	// ------------------------------------------------------------------ phases
	type RT = TaskRuntime<RunInput, Checkpoint, string, object>;
	const handlers: Record<Phase, (rt: RT, c: Context, d: RunDocState) => Promise<void>> = {
		RECEIVED: async (rt, c, d) => {
			await transition(rt, c, d.id, () => "PREPARING");
		},

		PREPARING: async (rt, c, d) => {
			const repo = svc.repo(stage(d, "repo"));
			const ws = await repo.open(d.repo, opts(d, "repo"));
			const env = svc.environment(stage(d, "environment"));
			const envs: RunDocState["envs"] = {};
			for (const role of ["architect", "builder", "reviewer", "helper"] as Role[]) envs[role] = await env.provision(ws, role, opts(d, "environment"));
			const intake = svc.intake(stage(d, "intake"));
			if (intake && d.request.meta?.intake) await intake.writeBack(d.request, { status: "started", state: "PREPARING" });
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
				doc.cost.push(r.cost);
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
			const repo = svc.repo(stage(d, "repo"));
			await repo.writeArtifact(d.workspace!, "docs/spec.md", d.artifacts.spec!.text, `docs: spec v${d.artifacts.spec!.version} (factory run ${d.id})`);
			await transition(rt, c, d.id, async (doc, tx): Promise<Phase> => {
				const next = toGateOrNext(doc, "spec", "BUILDING");
				if (next === "BUILDING") await startBuild(rt, tx, doc);
				return next;
			});
		},

		AWAITING_APPROVAL: async (rt, c, d) => {
			const ask = d.pendingAsk!;
			const gate = d.gate!;
			const resp = await awaitResponse(rt, c, d.id, ask.id);
			if (resp.type === "approve" && gate === "merge") {
				const pr = d.artifacts.delivery?.pr;
				if (!pr) throw new Error("merge approved but the delivery has no PR");
				await svc.repo(stage(d, "repo")).merge(pr, "squash", opts(d, "repo"));
			}
			await transition(rt, c, d.id, async (doc, tx): Promise<Phase> => {
				delete doc.pendingAsk;
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
			const r = await runAgent(rt, c, d, "builder", conv, key, builderInput(d), ["report_done"], ids);
			const diff = await svc.repo(stage(d, "repo")).diff(d.workspace!, d.workspace!.baseRef);
			const noProgress =
				d.counters.buildSeq > 1 && d.pinned.config.policy?.escalateOnNoProgress !== false && diff.fingerprint === d.lastFingerprint;
			await transition(rt, c, d.id, async (doc, tx): Promise<Phase> => {
				doc.cost.push(r.cost);
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
				doc.counters.reviewSeq += 1;
				const reviewer = await createRoleConversation(rt, tx, doc, "reviewer");
				doc.conversations.reviewers.push({ id: reviewer, seq: doc.counters.reviewSeq });
				return "REVIEWING";
			});
		},

		REVIEWING: async (rt, c, d) => {
			const conv = d.conversations.reviewers.find((x) => x.seq === d.counters.reviewSeq)!.id;
			const key = `${d.id}:REVIEWING:${d.counters.reviewSeq}`;
			const diff = await svc.repo(stage(d, "repo")).diff(d.workspace!, d.workspace!.baseRef);
			const r = await runAgent(rt, c, d, "reviewer", conv, key, reviewerInput(d, diff), ["submit_review"]);
			const checked = validateReview(r.payload);
			if (!checked.ok) throw new Error(`invalid review reached the core: ${checked.problems.join("; ")}`);
			await transition(rt, c, d.id, async (doc, tx): Promise<Phase> => {
				doc.cost.push(r.cost);
				const findings = assignIds(doc, checked.review.findings);
				const review: ReviewResult = { verdict: checked.review.verdict, findings };
				doc.lastReview = review;
				doc.findingsLog.push({ seq: doc.findingsLog.length + 1, kind: "review", round: doc.counters.reviewRound, findings, reviewerConversation: conv });
				doc.humanFindingsForReview = [];
				if (review.verdict === "pass") {
					doc.advisory = findings.filter((f) => !f.blocking);
					notice(doc, { level: "info", text: `Review passed (review #${doc.counters.reviewSeq})${doc.advisory.length ? ` with ${doc.advisory.length} advisory finding(s)` : ""}` });
					return toGateOrNext(doc, "delivery", "DELIVERING");
				}
				const blocking = findings.filter((f) => f.blocking).length;
				notice(doc, { level: "warn", text: `Review failed (review #${doc.counters.reviewSeq}): ${blocking} blocking finding(s)` });
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
			const repo = svc.repo(stage(d, "repo"));
			if (ws.newRepo) await repo.create(d.repo, opts(d, "repo"));
			const delivery = svc.delivery(stage(d, "delivery"));
			const out = await delivery.deliver(ws, {
				spec: { kind: "spec", path: "docs/spec.md", version: d.artifacts.spec?.version },
				specText: d.artifacts.spec?.text ?? "",
				review: d.lastReview ?? { verdict: "pass", findings: [] },
				request: d.request,
				advisory: d.advisory,
				acceptedBlocking: d.acceptedBlocking,
				mode: ws.newRepo ? "push-main" : "pull-request",
				runId: d.id,
				settings: stage(d, "delivery"),
				stages: d.pinned.config.stages ?? {},
			});
			await transition(rt, c, d.id, (doc): Phase => {
				doc.artifacts.delivery = out;
				notice(doc, { level: "info", text: `${out.kind === "pr" ? "PR" : "Pushed to main"}: ${out.url} @ ${out.sha.slice(0, 12)}`, url: out.url });
				const mode = stage(doc, "delivery").ci?.mode ?? "if-present";
				if (mode === "off") return afterCi(doc);
				doc.ci = { startedAt: svc.now() };
				return "AWAITING_CI";
			});
		},

		AWAITING_CI: async (rt, c, d) => {
			const ci = stage(d, "delivery").ci ?? {};
			const mode = ci.mode ?? "if-present";
			const timeout = parseDuration(ci.noChecksTimeout ?? "2m");
			const names: string[] | undefined = Array.isArray(ci.checks) && ci.checks.length ? ci.checks : undefined;
			const delivery = svc.delivery(stage(d, "delivery"));
			const dl = d.artifacts.delivery!;
			let st: CiStatus;
			for (;;) {
				st = await delivery.checks(dl, names, opts(d, "delivery"));
				if (st.state === "green" || st.state === "red") break;
				if (st.state === "none" && svc.now() - d.ci!.startedAt >= timeout) break;
				await rt.sleep(svc.now() + svc.ciPollMs, c);
			}
			if (st.state === "none" && mode !== "required" && delivery.annotate)
				await delivery.annotate(dl, d.workspace!, "No CI checks appeared within ci.noChecksTimeout: the repo has no CI, so CI did not run.", opts(d, "delivery"));
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

	async function startBuild(rt: TaskRuntime<any, any, any, any>, tx: Tx, d: RunDocState) {
		if (!d.conversations.builder) d.conversations.builder = await createRoleConversation(rt, tx, d, "builder");
		if (d.counters.buildSeq === 0) toBuilding(d, []);
	}

	async function sideEffectsAtEnd(d: RunDocState) {
		const intake = svc.intake(stage(d, "intake"));
		const update: RunUpdate = {
			status: d.state === "DELIVERED" ? "done" : d.state === "FAILED" ? "failed" : "cancelled",
			state: d.state,
			...(d.artifacts.delivery?.url ? { url: d.artifacts.delivery.url } : {}),
			advisory: d.advisory,
			acceptedBlocking: d.acceptedBlocking,
			...(d.noCi ? { noCi: true } : {}),
			...(d.failure ? { message: d.failure.reason } : {}),
		};
		if (intake && d.request.meta?.intake) await intake.writeBack(d.request, update).catch((e) => svc.log(`writeBack failed: ${e}`));
		const env = svc.environment(stage(d, "environment"));
		for (const e of Object.values(d.envs)) if (e) await env.dispose(e.envId).catch((err) => svc.log(`dispose failed: ${err}`));
	}

	async function finalize(rt: RT, c: Context, d: RunDocState) {
		await sideEffectsAtEnd(d);
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
					doc.updatedAt = svc.now();
					return undefined;
				}, c);
				d = await read(rt, runId, c);
			}
			await sideEffectsAtEnd(d);
			await rt.commit(() => ({ status: "terminal", outcome: { status: "aborted", reason: "cancelled" } }), c);
		},
	});
}

import { createHash } from "node:crypto";
function sha(s: string) {
	return createHash("sha256").update(s).digest("hex");
}
