// The core state machine (spec §4) as a Pi Durable Task. One phase per run state; every transition commits the
// `factory.run` Document together with the task checkpoint, atomically. The core never calls a model: it creates and
// configures role Conversations, submits input to them and reads what they commit through the bridge.
import type { Context } from "@earendil-works/chord";
import { defineTask, type Extension, InboxDoc, LiveDoc, type TaskRuntime, type Tx } from "@earendil-works/pi-durable";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Boat } from "../boat/boat.ts";
import type { GitHub } from "../github/github.ts";
import type { Sandbox } from "../sandbox/sandbox.ts";
import { BridgeDoc, type BridgeTool } from "./bridge.ts";
import { type Cleaner, cleanAtEnd, nextMarker, runOwner } from "./cleanup.ts";
import { formatFinding } from "./findings.ts";
import { messageContent } from "./messages.ts";
import { lastQaStatus, type ReviewRoundState, RunDoc, type RunDocState, specPathOf } from "./run-doc.ts";
import { Cancelled, clip, createTaskKit, priorFindings, WRITE_TOOLS } from "./task-kit.ts";
import type { AskResponse, DeliveryContext, DiscussionLink, EscalationInfo, Finding, FindingResponse, Gate, Role, RunState } from "./types.ts";

type Phase = RunState | "FINAL";
type Checkpoint = { phase: Phase; n: number };
type RunInput = { runId: string; start: RunState };

export interface CoreServices {
	github: GitHub;
	sandbox: Sandbox;
	/** Disk cleanup of finished owners (src/core/cleanup.ts). */
	cleanup: Cleaner;
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


export { WRITE_TOOLS };

export function createRunTask(svc: CoreServices) {
	// ------------------------------------------------------------------ helpers
	const kit = createTaskKit<RunDocState>(svc, RunDoc, { noun: "run", messageContent });
	const { read, rc, newAsk, notice, assignIds, createRoleConversation, runAgent, pushCost, awaitResponseOr, enterReview, runReview, reviewOutcome, waitForCi, sideEffectsAtEnd, markVmsDisposed } = kit;

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
			delete d.interrupted;
			d.updatedAt = svc.now();
			return { status: "running", checkpoint: { phase: next, n } };
		}, c);
	}

	function gates(d: RunDocState): Gate[] {
		return (d.pinned.config.policy?.approvals ?? []) as Gate[];
	}

	/** At the end of a run: usage of turns nobody recorded yet (a message's turn the core didn't see finish). */
	async function settleUsage(rt: TaskRuntime<any, any, any, any>, c: Context, runId: string) {
		const d = await read(rt, runId, c);
		const convs: [Role, string][] = [
			...(d.conversations.architect !== undefined ? [["architect", d.conversations.architect] as [Role, string]] : []),
			...(d.conversations.builder !== undefined ? [["builder", d.conversations.builder] as [Role, string]] : []),
			...d.conversations.reviewers.map((r) => ["reviewer", r.id] as [Role, string]),
			...(d.conversations.qa ?? []).map((r) => ["qa", r.id] as [Role, string]),
		];
		await kit.settleUsage(rt, c, runId, convs);
	}

	async function awaitResponse(rt: TaskRuntime<any, any, any, any>, c: Context, runId: string, askId: string): Promise<AskResponse> {
		const r = await awaitResponseOr(rt, c, runId, askId);
		return r.response as AskResponse;
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
					? { kind: "spec" as const, path: specPathOf(d), version: d.artifacts.spec?.version, sha256: d.artifacts.spec?.sha256 }
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

	function toFinal(d: RunDocState, state: "DELIVERED" | "FAILED" | "CANCELLED", reason?: string, deliveredText?: string): Phase {
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
			state === "DELIVERED" && deliveredText
				? deliveredText
				: state === "DELIVERED"
				? `Delivered${url ? `: ${url}` : ""}${d.artifacts.delivery?.kind === "pr" && !gates(d).includes("merge") ? " (PR left open, no auto-merge)" : ""}${d.noCi ? " — the repo has no CI checks; CI did not run" : ""}`
				: `${state === "FAILED" ? "Failed" : "Cancelled"} in ${d.state}: ${reason ?? ""}`;
		const qa = lastQaStatus(d);
		const textQa = state === "DELIVERED" && qa && !deliveredText ? `${text} · QA status: ${qa}` : text;
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
		// Interfaces may pass any meta to startRun: read it defensively.
		const disc = d.request.meta?.discussion as Partial<DiscussionLink> | undefined;
		// The discussion the ticket was drafted in (discussions spec §2.3); without one, the input is unchanged.
		const prior = disc
			? [
					`# Prior discussion`,
					`The human discussed this with a model before writing the ticket ("${disc.title ?? ""}"). Its summary:`,
					String(disc.summary ?? ""),
					...(Array.isArray(disc.siblings) && disc.siblings.length > 0
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
				`The spec is committed at ${specPathOf(d)} and is the contract. Here it is:`,
				...(specPathOf(d) !== "docs/spec.md"
					? [ws.newRepo || !existsSync(join(ws.path, "docs", "spec.md")) ? `The repo has no docs/spec.md (the product spec); do not create one.` : `docs/spec.md is the product spec: update it to reflect this change.`]
					: []),
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

	const priorSections = (d: RunDocState, kind: "review" | "qa", label: string) => priorFindings(d, kind, label, "builder");

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
			`## Spec (${specPathOf(d)})`,
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
			`## Spec (${specPathOf(d)})`,
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
			// The commit identity (the GitHub account behind github.identity) before any work: a failed lookup fails here.
			const who = await svc.github.commitIdentity(rc(d));
			const ws = await svc.github.open(d.repo, rc(d));
			const envs: RunDocState["envs"] = {};
			// Helpers run in the builder's environment; they get none of their own.
			for (const role of ["architect", "builder", "reviewer"] as Role[]) envs[role] = await svc.sandbox.provision(ws, role, rc(d), who);
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
				doc.artifacts.spec = { kind: "spec", path: specPathOf(doc), version, sha256: sha(text), text };
				return "SPEC_READY";
			});
		},

		SPEC_READY: async (rt, c, d) => {
			await svc.github.writeArtifact(d.workspace!, specPathOf(d), d.artifacts.spec!.text, `docs: spec v${d.artifacts.spec!.version} (factory run ${d.id})`, rc(d));
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
					doc.artifacts.spec = { kind: "spec", path: specPathOf(doc), version, sha256: sha(text), text };
					notice(doc, { level: "info", text: `The architect revised the spec to v${version} after a message; it needs approval again` });
					return "SPEC_READY";
				});
				return;
			}
			const resp = got.response! as AskResponse;
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
			await runReview(rt, c, d, { base: d.workspace!.baseRef, reviewerInput, qaInput });
			await transition(rt, c, d.id, async (doc): Promise<Phase> => {
				const { verdict, findings } = reviewOutcome(doc);
				if (verdict === "pass") return toGateOrNext(doc, "delivery", "DELIVERING");
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
			if (!d.legacy) {
				// Bundles (spec §1.1): the reviewed branch is committed and, for an existing repo, pushed; it waits in READY
				// for a bundle. No PR, no repo, no CI.
				await svc.github.commitAll(ws, "factory: commit uncommitted builder changes", rc(d));
				if (!ws.newRepo) await svc.github.pushBranch(ws, rc(d));
				await transition(rt, c, d.id, (doc): Phase => {
					doc.readyChecked = (doc.messages ?? []).filter((m) => m.to === "builder").length;
					notice(doc, {
						level: "info",
						text: `Ready to ship: branch ${ws.branch}${ws.newRepo ? " (the repo is created when a bundle ships it)" : " pushed"}`,
						...(lastQaStatus(doc) ? { qaStatus: lastQaStatus(doc) } : {}),
					});
					return "READY";
				});
				return;
			}
			if (ws.newRepo) await svc.github.create(d.repo, rc(d));
			const ctx: DeliveryContext = {
				spec: { kind: "spec", path: specPathOf(d), version: d.artifacts.spec?.version },
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
			// Legacy runs only (spec §1.1): new runs stop at READY; CI applies to bundles.
			const mode = d.pinned.config.ci?.mode ?? "if-present";
			const dl = d.artifacts.delivery!;
			const st = (await waitForCi(rt, c, d, dl, d.ci!.startedAt))!;
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
						description: `CI failed on the delivered commit ${dl.sha.slice(0, 12)}: ${(st.failures ?? []).map((f) => f.split("\n")[0]).join("; ") || "checks failed"}`,
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

		READY: async (rt, c, d) => {
			// Waits for a bundle (spec §1.1). A merged bundle delivers the run; a message to the builder outside any bundle
			// that changes the workspace sends the run back through review (no round added).
			const builder = d.conversations.builder;
			for (;;) {
				const doc = await read(rt, d.id, c);
				if (doc.bundleMerged) {
					const m = doc.bundleMerged;
					await transition(rt, c, d.id, (x): Phase => {
						x.artifacts.delivery = m.delivery;
						return toFinal(x, "DELIVERED", undefined, `Merged in ${m.bundle}: ${m.delivery.url}`);
					});
					return;
				}
				const toBuilder = (doc.messages ?? []).filter((m) => m.to === "builder").length;
				if (!doc.bundle && builder !== undefined && toBuilder > (doc.readyChecked ?? 0)) {
					const live = (await rt.snapshot(LiveDoc, builder as never, c)) as { run?: unknown; generation?: unknown; tools?: unknown[] } | undefined;
					const inbox = (await rt.snapshot(InboxDoc, builder as never, c)) as { items?: unknown[] } | undefined;
					const idle = (!live || (live.run === undefined && live.generation === undefined && !Object.keys(live.tools ?? {}).length)) && !(inbox?.items ?? []).length;
					const held = (doc.messages ?? []).some((m) => m.to === "builder" && m.conversationId === undefined);
					if (idle && !held) {
						const ws = doc.workspace!;
						const now = await svc.github.diff(ws, ws.baseRef);
						await transition(rt, c, d.id, async (x, tx): Promise<Phase> => {
							x.readyChecked = toBuilder;
							if (x.bundle || now.fingerprint === x.lastFingerprint) return "READY";
							x.lastFingerprint = now.fingerprint;
							notice(x, { level: "warn", text: "The workspace changed in Ready (the builder acted on a message); reviewing again" });
							await enterReview(rt, tx, x);
							return "REVIEWING";
						});
						return;
					}
				}
				if (rt.signal.aborted) throw new Cancelled();
				await Promise.race([svc.changed(d.id, 1000), rt.sleep(svc.now() + 1000, c).catch(() => undefined)]);
				if (rt.signal.aborted) throw new Cancelled();
			}
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

	async function startBuild(rt: TaskRuntime<any, any, any, any>, tx: Tx, d: RunDocState) {
		if (!d.conversations.builder) d.conversations.builder = await createRoleConversation(rt, tx, d, "builder");
		if (d.counters.buildSeq === 0) toBuilding(d, []);
	}

	async function finalize(rt: RT, c: Context, d: RunDocState) {
		await settleUsage(rt, c, d.id);
		await sideEffectsAtEnd(d);
		await markVmsDisposed(rt, c, d.id);
		const cleaned = await cleanAtEnd(svc.cleanup, runOwner(await read(rt, d.id, c)));
		await rt.commit(async (tx) => {
			await recordCleanup(tx, d.id, cleaned);
			return { status: "terminal", outcome: { status: "completed", result: d.state } };
		}, c);
	}

	/** The cleanedUp marker, in the Task's terminal commit (never downgraded). */
	async function recordCleanup(tx: Tx, runId: string, scope: "scratch" | "full" | undefined) {
		if (!scope) return;
		const doc = (await tx.doc(RunDoc, runId, null as never)) as unknown as RunDocState;
		doc.cleanedUp = nextMarker(doc.cleanedUp, scope, svc.now());
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
					delete doc.interrupted;
					doc.updatedAt = svc.now();
					return undefined;
				}, c);
				d = await read(rt, runId, c);
			}
			await settleUsage(rt, c, runId).catch((e) => svc.log(`usage settle failed: ${e}`));
			await sideEffectsAtEnd(d);
			await markVmsDisposed(rt, c, runId).catch(() => undefined);
			const cleaned = await cleanAtEnd(svc.cleanup, runOwner(await read(rt, runId, c))).catch(() => undefined);
			await rt.commit(async (tx) => {
				await recordCleanup(tx, runId, cleaned);
				return { status: "terminal", outcome: { status: "aborted", reason: "cancelled" } };
			}, c);
		},
	});
}

import { createHash } from "node:crypto";
function sha(s: string) {
	return createHash("sha256").update(s).digest("hex");
}
