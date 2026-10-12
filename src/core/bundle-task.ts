// The bundle state machine (bundles spec §2.2) as a Pi Durable Task, beside the run and discussion Tasks and sharing
// their CoreServices. A bundle combines Ready runs' branches on the latest default branch (the integrator resolves
// conflicts), reviews the combined result when the integrator changed anything or the bundle has 2 or more members (a
// clean one-ticket merge is not reviewed again), delivers one PR (or, for a new repo, a push to `main`), waits for CI and
// merges when the human clicks Merge. Every transition commits the `factory.bundle`
// Document with the task checkpoint; member runs' Documents change in the same commits (membership, merged).
import type { Context } from "@earendil-works/chord";
import { defineTask, type TaskRuntime, type Tx } from "@earendil-works/pi-durable";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { BundleDeliveryContext } from "../github/github.ts";
import { BundleDoc, type BundleDocState, mergeMethodOf } from "./bundle-doc.ts";
import { bundleOwner, cleanAtEnd, nextMarker } from "./cleanup.ts";
import { formatFinding } from "./findings.ts";
import { bundleMessageContent } from "./messages.ts";
import { lastQaStatus, type ReviewRoundState, RunDoc, type RunDocState, specPathOf } from "./run-doc.ts";
import type { CoreServices } from "./run-task.ts";
import { Cancelled, clip, createTaskKit, priorFindings } from "./task-kit.ts";
import type { BundleState, CiStatus, Delivery, EscalationInfo, Finding, FindingResponse, Role, RunId } from "./types.ts";

type Phase = BundleState | "FINAL";
type Checkpoint = { phase: Phase; n: number };
export type BundleInput = { bundleId: string; start: BundleState };
type RT = TaskRuntime<BundleInput, Checkpoint, string, object>;

/** Attempts the integrator gets to leave a conflicted merge resolved before the bundle fails. */
const CONFLICT_ATTEMPTS = 3;
/** Merges GitHub may refuse in a row (each followed by an update onto the latest default branch) before the bundle fails. */
const MERGE_REFUSALS = 3;

/** The integrator's model and thinking default to the builder's, as the helper's do. */
export function bundleRoleConfig(config: Record<string, any>, role: Role): { model?: string; thinking?: string } {
	const roles = config.roles ?? {};
	if (role === "integrator") return { model: roles.integrator?.model ?? roles.builder?.model, thinking: roles.integrator?.thinking ?? roles.builder?.thinking };
	return roles[role] ?? {};
}

export function createBundleTask(svc: CoreServices) {
	const kit = createTaskKit<BundleDocState>(svc, BundleDoc, {
		noun: "bundle",
		messageContent: bundleMessageContent,
		roleConfig: (d, role) => bundleRoleConfig(d.pinned.config, role),
	});
	const { read, docIn, rc, newAsk, notice, assignIds, createRoleConversation, runAgent, pushCost, awaitResponseOr, enterReview, runReview, reviewOutcome, waitForCi, sideEffectsAtEnd, markVmsDisposed } = kit;

	/** Commit a document change and the next checkpoint together. */
	async function transition(rt: RT, c: Context, id: string, change: (d: BundleDocState, tx: Tx) => Phase | Promise<Phase>): Promise<void> {
		await rt.commit(async (tx, current) => {
			const d = await docIn(tx, id);
			const before = d.state;
			const next = await change(d, tx);
			if (next !== "FINAL" && next !== before) {
				d.history.push({ from: before, to: next, at: svc.now(), round: d.counters.reviewRound });
				d.state = next;
			}
			delete d.driving;
			d.updatedAt = svc.now();
			return { status: "running", checkpoint: { phase: next, n: current.state.checkpoint.n + 1 } };
		}, c);
	}

	/** The member runs' Documents, in member order. */
	async function memberRuns(rt: RT, c: Context, d: BundleDocState): Promise<RunDocState[]> {
		const out: RunDocState[] = [];
		for (const m of d.members) {
			const r = (await rt.snapshot(RunDoc, m.run, c)) as RunDocState | undefined;
			if (!r) throw new Error(`member run ${m.run} has no document`);
			out.push(r);
		}
		return out;
	}

	async function runIn(tx: Tx, run: RunId): Promise<RunDocState | undefined> {
		const r = (await tx.doc(RunDoc, run, null as never)) as unknown as RunDocState;
		return r?.id ? r : undefined;
	}

	// ------------------------------------------------------------------ state changes shared by several phases
	function toFixing(d: BundleDocState, findings: Finding[], note?: string): Phase {
		d.counters.buildSeq += 1;
		d.pending.findings = findings;
		if (note) d.pending.note = note;
		else delete d.pending.note;
		// a fix changes the integration: it goes through review and CI and comes back for a fresh Merge click
		delete d.mergeRequested;
		return "FIXING";
	}

	/** A clean integration under the combined-review rule with 2 or more members is reviewed before delivery. */
	function reviewsCleanCombination(d: BundleDocState): boolean {
		return !d.integration!.changed && d.integration!.reviewCombination === true && d.members.length >= 2;
	}

	function toEscalated(d: BundleDocState, info: Omit<EscalationInfo, "from"> & { from: BundleState }): Phase {
		d.escalation = info;
		newAsk(d, { kind: "escalation", reason: info.reason, options: ["more-rounds", "drop", "abort"] });
		notice(d, { level: "warn", text: `Escalated: ${info.reason}` });
		return "ESCALATED";
	}

	/** Start a fresh integration from the latest default branch (a drop, a moved default branch, a refused merge). */
	function toReintegrate(d: BundleDocState, why: string): Phase {
		d.counters.integration += 1;
		d.loop = "review";
		delete d.pendingAsk;
		notice(d, { level: "info", text: why });
		return "INTEGRATING";
	}

	/** Drop members (they return to plain READY) and restart the integration with the rest. */
	async function dropMembers(tx: Tx, d: BundleDocState, runs: RunId[], by: string): Promise<Phase> {
		const dropped = d.members.filter((m) => runs.includes(m.run));
		d.members = d.members.filter((m) => !runs.includes(m.run));
		d.dropped.push(...dropped.map((m) => m.run));
		for (const m of dropped) {
			const r = await runIn(tx, m.run);
			if (r && r.bundle === d.id) {
				delete r.bundle;
				r.notices.push({ at: svc.now(), level: "info", text: `Dropped from ${d.id} by ${by}; back in Ready` });
				r.updatedAt = svc.now();
			}
		}
		delete d.mergeRequested;
		const remaining = d.members.map((m) => `${m.key} "${m.title}" (${m.run})`).join(", ");
		d.pending.notes = [...(d.pending.notes ?? []), `The human dropped ${dropped.map((m) => `${m.key} "${m.title}"`).join(", ")} from the bundle. The bundle now has: ${remaining}. It is integrated again from the latest default branch; earlier integration commits are discarded.`];
		return toReintegrate(d, `Dropped ${dropped.map((m) => m.key).join(", ")} (by ${by}); re-integrating ${d.members.length} ticket(s) from the latest default branch`);
	}

	/** Members go back to plain READY (cancel, abort, a PR closed without merging). */
	async function releaseMembers(tx: Tx, d: BundleDocState, why: string) {
		for (const m of d.members) {
			const r = await runIn(tx, m.run);
			if (r && r.bundle === d.id) {
				delete r.bundle;
				r.notices.push({ at: svc.now(), level: "info", text: `Released from ${d.id} (${why}); back in Ready` });
				r.updatedAt = svc.now();
			}
		}
	}

	async function toFinal(tx: Tx, d: BundleDocState, state: "MERGED" | "FAILED" | "CANCELLED", reason?: string): Promise<Phase> {
		if (state === "FAILED") d.failure = { state: d.state, reason: reason ?? "failed", ...(d.pendingAsk && !d.pendingAsk.response ? { pendingAsk: d.pendingAsk } : {}) };
		if (state === "CANCELLED") {
			d.failure = { state: d.state, reason: reason ?? "cancelled" };
			await releaseMembers(tx, d, reason ?? "cancelled");
		}
		if (state === "MERGED") {
			// every member run goes READY → DELIVERED with the bundle's PR (or push to main) as its delivery
			for (const m of d.members) {
				const r = await runIn(tx, m.run);
				if (r) {
					r.bundleMerged = { bundle: d.id, delivery: JSON.parse(JSON.stringify(d.delivery!)) as Delivery };
					r.updatedAt = svc.now();
				}
			}
		}
		delete d.pendingAsk;
		delete d.mergeRequested;
		const url = d.delivery?.url;
		notice(d, {
			level: state === "MERGED" ? "info" : state === "FAILED" ? "error" : "warn",
			text: state === "MERGED" ? `Merged${url ? `: ${url}` : ""}${d.noCi ? " — the repo has no CI checks; CI did not run" : ""}` : `${state === "FAILED" ? "Failed" : "Cancelled"} in ${d.state}: ${reason ?? ""}`,
			...(url ? { url } : {}),
			advisory: d.advisory,
			...(d.noCi ? { noCi: true } : {}),
			...(lastQaStatus(d as any) ? { qaStatus: lastQaStatus(d as any) } : {}),
			final: true,
		});
		d.history.push({ from: d.state, to: state, at: svc.now(), round: d.counters.reviewRound });
		d.state = state;
		return "FINAL";
	}

	/** After CI is green or skipped: a PR waits for Merge (or merges at once when Merge was already clicked); a new repo is done. */
	function afterCi(d: BundleDocState): Phase {
		if (d.delivery?.kind !== "pr") return "MERGED";
		if (!d.mergeRequested) newAsk(d, { kind: "merge", options: ["merge", "request-changes", "drop"] });
		return "AWAITING_MERGE";
	}

	// ------------------------------------------------------------------ inputs the core hands to roles (data, not guidance)
	function specsSection(d: BundleDocState, runs: RunDocState[]): string[] {
		const parts: string[] = [];
		for (const [i, r] of runs.entries()) {
			const m = d.members[i]!;
			parts.push(`### ${m.key}: ${m.title} (run ${m.run}; ${specPathOf(r)})`, r.artifacts.spec?.text ?? "(no spec)", "");
		}
		const product = d.workspace ? join(d.workspace.path, "docs", "spec.md") : undefined;
		if (product && existsSync(product) && !runs.some((r) => specPathOf(r) === "docs/spec.md"))
			parts.push(`### The product spec (docs/spec.md)`, readFileSync(product, "utf8").slice(0, 30_000), "");
		return parts;
	}

	function membersList(d: BundleDocState, upTo?: number): string[] {
		return d.members.map((m, i) => `${i + 1}. ${m.key} "${m.title}" (run ${m.run}, branch ${m.branch}, spec ${m.specPath})${upTo !== undefined ? (i < upTo ? " — merged" : i === upTo ? " — merging now" : " — next") : ""}`);
	}

	function takeNotes(d: BundleDocState): string[] {
		return (d.pending.notes ?? []).flatMap((n) => [`[factory] ${n}`, ""]);
	}

	function conflictInput(d: BundleDocState, runs: RunDocState[]): string {
		const ws = d.workspace!;
		const it = d.integration!;
		const conflict = it.conflict!;
		const m = d.members.find((x) => x.run === conflict.run)!;
		return [
			...takeNotes(d),
			`# Merge conflict (${d.id}, integration #${it.n}${conflict.attempts ? `, attempt ${conflict.attempts + 1}` : ""})`,
			`Workspace: ${ws.path} (branch ${ws.branch}, integrating on ${it.base.slice(0, 12)} of the default branch).`,
			`The tickets are merged in this order with git merge --no-ff:`,
			...membersList(d, it.next),
			"",
			`Merging ${m.key} "${m.title}" (branch ${m.branch}) conflicted in: ${conflict.files.join(", ")}.`,
			...(conflict.attempts ? [`The previous attempt did not conclude the merge: files still conflicted or the merge was aborted. The conflicted merge is in the worktree again.`] : []),
			`The conflicted merge is left in the worktree. Resolve every conflicted file so that every ticket's behaviour survives, run the tests, then \`git add\` the files and \`git commit --no-edit\` to conclude the merge. Do not abort it. Then call report_done (responses: []).`,
			"",
			`## Every member's spec (each is the contract for its ticket)`,
			...specsSection(d, runs),
		].join("\n");
	}

	function fixInput(d: BundleDocState): string {
		const findings = d.pending.findings ?? [];
		return [
			...takeNotes(d),
			`# Findings to address on ${d.id} (round ${d.counters.reviewRound}${d.loop === "ci" ? `, CI fix ${d.counters.ciFixes}` : ""})`,
			`Workspace: ${d.workspace!.path} (branch ${d.workspace!.branch}). The bundle's tickets:`,
			...membersList(d),
			d.pending.note ?? "",
			...findings.map(formatFinding),
			"",
			`Fix what you agree with and commit. Answer every BLOCKING finding id in report_done.responses: "fixed", or "wontfix" with a reason. Advisory findings are optional.`,
		].join("\n");
	}

	function reviewerInput(d: BundleDocState, runs: RunDocState[], diff: { stat: string; patch: string; files: { path: string; status: string }[] }, since?: { base: string; stat: string; patch: string }): string {
		const ws = d.workspace!;
		const it = d.integration!;
		const qaOn = d.pinned.config.qa?.enabled === true;
		const runScripts = (d.pinned.config.boat?.runScripts ?? []) as string[];
		const cleanMulti = !it.changed && it.resolved.length === 0 && d.members.length >= 2;
		const parts = [
			`# Review of ${d.id} (review #${d.counters.reviewSeq}, round ${d.counters.reviewRound}${d.loop === "ci" ? `, after CI fix ${d.counters.ciFixes}` : ""})`,
			`${d.id} combines ${d.members.length} ticket(s), each built and reviewed on its own branch, on the latest default branch. ${it.resolved.length ? `The integrator resolved conflicts: ${it.resolved.map((r) => `${r.run} (${r.files.join(", ")})`).join("; ")}.` : ""}`,
			`Workspace (read-only): ${ws.path}. Review the WHOLE combined product against EVERY member's spec below, not only the diff: each ticket's behaviour must survive the combination.`,
			`Run the test suite yourself; do not trust anyone's report. Flag any test deleted or weakened in the diff. Run the product (bash; curl a running service) and check the acceptance behaviours of every spec.`,
			...(cleanMulti
				? [
						`The tickets merged without conflicts (the integrator resolved none), and each ticket already passed its own review (and AQ testing where it applied) on its own branch. What has not been checked is the combination.`,
						`Review the diff and the code it touches for quality and security, especially how the tickets interact: shared code, files, data, config, APIs, UI and tests, and behaviour one ticket changes that another relies on. Who wrote a line does not matter.`,
					]
				: [`Review the diff and the code it touches for quality and security, especially where the tickets meet (conflict resolutions). Who wrote a line does not matter.`]),
			...(qaOn ? [`AQ testing is on for this project: if the product is something a user launches (an app, a service, a CLI), a missing or broken run script (one of ${runScripts.join(", ")}) is a BLOCKING finding.`] : []),
			"",
			`## Tickets`,
			...membersList(d),
			"",
			`## Specs`,
			...specsSection(d, runs),
			`## Combined diff against the integration base ${it.base.slice(0, 12)} (the default branch)`,
			"```",
			diff.stat,
			"```",
			"Changed files: " + diff.files.map((f) => `${f.status} ${f.path}`).join(", "),
			"```diff",
			clip(diff.patch),
			"```",
		];
		if (since) parts.push("", `## Changes since the previous review (${since.base.slice(0, 12)})`, "```", since.stat || "(no change)", "```", "```diff", clip(since.patch), "```");
		parts.push(...priorFindings(d, "review", "reviewer", "integrator"));
		parts.push("", `Call submit_review. Every finding needs evidence you observed (a command and its output, or file and lines); give specRef (the ticket and clause) when a spec clause applies.`);
		return parts.join("\n");
	}

	function qaInput(d: BundleDocState, runs: RunDocState[], r: ReviewRoundState, bootOk: boolean): string {
		const ws = d.workspace!;
		const agents = existsSync(join(ws.path, "AGENTS.md")) ? readFileSync(join(ws.path, "AGENTS.md"), "utf8").slice(0, 12_000) : "(no AGENTS.md)";
		return [
			`# AQ testing of ${d.id} (review #${r.seq}, round ${r.round})`,
			`${d.id} combines ${d.members.length} ticket(s). The combined build is checked out in this VM at ${svc.boat.record(r.vm!.envId)?.appDir ?? "~/app"} and ${bootOk ? "is running" : "did NOT boot cleanly (see the output below)"}. Use it like its user would, with the computer tool, and check the acceptance behaviours of EVERY ticket's spec. The product runs on localhost; AGENTS.md says where.`,
			"",
			`## Specs`,
			...specsSection(d, runs),
			`## AGENTS.md`,
			agents,
			"",
			`## Setup and run script output`,
			"```",
			(r.bootLog ?? "").slice(-8000),
			"```",
			...(bootOk ? [] : ["A product that does not boot from a clean checkout is a blocking finding: take a screenshot of the failure in the terminal and cite it."]),
			...priorFindings(d, "qa", "QA", "integrator"),
			"",
			`Call submit_qa. Every finding needs evidence (the UI steps and what you saw) and at least one screenshot id you took this round.`,
		].join("\n");
	}

	function deliveryContext(d: BundleDocState, runs: RunDocState[]): BundleDeliveryContext {
		return {
			mode: d.workspace!.newRepo ? "push-main" : "pull-request",
			...(d.delivery?.pr ? { pr: d.delivery.pr } : {}),
			members: d.members.map((m, i) => {
				const r = runs[i]!;
				const qa = lastQaStatus(r);
				return { run: m.run, title: m.title, specPath: specPathOf(r), specVersion: r.artifacts.spec?.version, advisory: r.advisory, acceptedBlocking: r.acceptedBlocking, ...(qa ? { qaStatus: qa } : {}) };
			}),
			integration: {
				resolved: d.integration?.resolved ?? [],
				reviewRounds: Object.keys(d.reviews ?? {}).length,
				advisory: d.advisory,
				acceptedBlocking: d.acceptedBlocking,
				...(lastQaStatus(d as any) ? { qaStatus: lastQaStatus(d as any) } : {}),
			},
			...(d.noCi ? { noCi: true } : {}),
		};
	}

	/**
	 * Messages to the integrator held while the bundle was integrating (no task of its own ran): hand them over now, so a
	 * clean integration never strands one. Any change they lead to goes through review before delivery or Merge.
	 */
	async function flushHeld(rt: RT, c: Context, d: BundleDocState) {
		const conv = d.conversations.integrator;
		if (conv === undefined || !(d.messages ?? []).some((m) => m.to === "integrator" && m.conversationId === undefined)) return;
		const handle = await rt.conversation(conv as never, c);
		if (handle) await kit.deliverHeld(rt, c, d.id, "integrator", conv, handle);
	}

	// ------------------------------------------------------------------ phases
	/** Resolve the conflicted merge in the worktree with the integrator; concludes it, or retries, or fails. */
	async function resolveConflict(rt: RT, c: Context, d: BundleDocState) {
		const ws = d.workspace!;
		const it = d.integration!;
		const conflict = it.conflict!;
		const m = d.members.find((x) => x.run === conflict.run)!;
		const conv = d.conversations.integrator!;
		const runs = await memberRuns(rt, c, d);
		const key = `${d.id}:INTEGRATING:${it.n}:${conflict.run}:${conflict.attempts}`;
		const r = await runAgent(rt, c, d, "integrator", conv, key, conflictInput(d, runs), ["report_done"], []);
		let st = await svc.github.mergeState(ws);
		if (st.inProgress && st.conflicted.length === 0) {
			await svc.github.concludeMerge(ws);
			st = await svc.github.mergeState(ws);
		}
		const done = !st.inProgress && st.conflicted.length === 0 && (await svc.github.contains(ws, m.branch));
		if (!done) {
			if (conflict.attempts + 1 >= CONFLICT_ATTEMPTS) throw new Error(`the integrator did not conclude the merge of ${m.branch} after ${CONFLICT_ATTEMPTS} attempts${st.conflicted.length ? ` (still conflicted: ${st.conflicted.join(", ")})` : ""}`);
			// The merge was aborted or left conflicted: set the conflicted merge up again and give it another attempt.
			let files = st.conflicted;
			if (!st.inProgress) {
				const again = await svc.github.mergeMember(ws, m.branch, `Merge ${m.branch} (${m.title}) into ${ws.branch}`);
				files = again.clean ? [] : again.files;
			}
			await rt.commit(async (tx) => {
				const doc = await docIn(tx, d.id);
				pushCost(doc, "integrator", conv, r);
				if (files.length) doc.integration!.conflict = { run: conflict.run, files, attempts: conflict.attempts + 1 };
				else {
					// merged cleanly this time (the integrator changed the base meanwhile): count it as the integrator's change
					doc.integration!.resolved.push({ run: conflict.run, files: conflict.files });
					doc.integration!.changed = true;
					delete doc.integration!.conflict;
					doc.integration!.next += 1;
				}
				notice(doc, { level: "warn", text: `The integrator did not conclude the merge of ${m.key}; ${files.length ? `attempt ${conflict.attempts + 2} of ${CONFLICT_ATTEMPTS}` : "it merged again cleanly"}` });
				doc.updatedAt = svc.now();
				return undefined;
			}, c);
			return;
		}
		await rt.commit(async (tx) => {
			const doc = await docIn(tx, d.id);
			pushCost(doc, "integrator", conv, r);
			doc.counters.buildSeq += 1;
			doc.integration!.resolved.push({ run: conflict.run, files: conflict.files });
			doc.integration!.changed = true;
			delete doc.integration!.conflict;
			doc.integration!.next += 1;
			delete doc.pending.notes;
			notice(doc, { level: "info", text: `The integrator resolved the conflict merging ${m.key} (${conflict.files.join(", ")}): ${String(r.payload.summary ?? "").slice(0, 300)}` });
			doc.updatedAt = svc.now();
			return undefined;
		}, c);
	}

	const handlers: Record<Phase, (rt: RT, c: Context, d: BundleDocState) => Promise<void>> = {
		INTEGRATING: async (rt, c, d) => {
			if (!d.workspace) {
				const ws = await svc.github.openBundle(d.repo, rc(d));
				const envs: BundleDocState["envs"] = {};
				for (const role of ["integrator", "reviewer"] as Role[]) envs[role] = await svc.sandbox.provision(ws, role, rc(d));
				await rt.commit(async (tx) => {
					const doc = await docIn(tx, d.id);
					doc.workspace = ws;
					doc.envs = envs;
					if (doc.conversations.integrator === undefined) doc.conversations.integrator = await createRoleConversation(rt, tx, doc, "integrator");
					doc.updatedAt = svc.now();
					return undefined;
				}, c);
				d = await read(rt, d.id, c);
			}
			const ws = d.workspace!;
			if (!d.integration || d.integration.n !== d.counters.integration) {
				const { base, newRepo } = await svc.github.integrationBase(ws, rc(d));
				await svc.github.integrateStart(ws, base);
				await rt.commit(async (tx) => {
					const doc = await docIn(tx, d.id);
					// reviewCombination: this integration follows the rule that a clean merge of 2+ tickets is reviewed (records
					// created before that rule have no mark and keep the old exit: clean → DELIVERING)
					doc.integration = { n: doc.counters.integration, base, next: 0, resolved: [], changed: false, reviewCombination: true };
					doc.workspace = { ...doc.workspace!, baseRef: base, newRepo };
					notice(doc, { level: "info", text: `Integrating ${doc.members.length} ticket(s) on ${newRepo ? "the new repo's main" : "the default branch"} at ${base.slice(0, 12)}` });
					doc.updatedAt = svc.now();
					return undefined;
				}, c);
			}
			for (;;) {
				const doc = await read(rt, d.id, c);
				const it = doc.integration!;
				if (it.conflict) {
					await resolveConflict(rt, c, doc);
					continue;
				}
				if (it.next >= doc.members.length) break;
				const m = doc.members[it.next]!;
				let res: { clean: true } | { clean: false; files: string[] };
				const st = await svc.github.mergeState(ws);
				if (st.inProgress) {
					// a crash between the merge and its record: the conflicted merge is still there
					if (st.conflicted.length) res = { clean: false, files: st.conflicted };
					else {
						await svc.github.concludeMerge(ws);
						res = { clean: true };
					}
				} else if (await svc.github.contains(ws, m.branch)) res = { clean: true };
				else res = await svc.github.mergeMember(ws, m.branch, `Merge ${m.branch} (${m.title}) into ${ws.branch}`);
				await rt.commit(async (tx) => {
					const x = await docIn(tx, d.id);
					if (res.clean) x.integration!.next += 1;
					else {
						x.integration!.conflict = { run: m.run, files: res.files, attempts: 0 };
						notice(x, { level: "warn", text: `Conflict merging ${m.key} "${m.title}": ${res.files.join(", ")}; the integrator resolves it` });
					}
					x.updatedAt = svc.now();
					return undefined;
				}, c);
			}
			const fresh = await read(rt, d.id, c);
			const diff = await svc.github.diff(ws, fresh.integration!.base);
			await transition(rt, c, d.id, async (doc, tx): Promise<Phase> => {
				doc.lastFingerprint = diff.fingerprint;
				if (doc.integration!.changed) {
					// the integrator changed the combination: a fresh reviewer (and QA agent) review the whole result
					delete doc.mergeRequested;
					notice(doc, { level: "info", text: `Integrated with ${doc.integration!.resolved.length} conflict(s) resolved; reviewing the combined result` });
					await enterReview(rt, tx, doc);
					return "REVIEWING";
				}
				if (reviewsCleanCombination(doc)) {
					// a clean merge of 2+ tickets: each was reviewed on its own branch, the combination is reviewed now.
					// mergeRequested is kept: with no fix needed, a Merge-triggered update still merges by itself.
					notice(doc, { level: "info", text: `All ${doc.members.length} tickets merged cleanly; reviewing the combination (each ticket was reviewed on its own branch)` });
					await enterReview(rt, tx, doc);
					return "REVIEWING";
				}
				notice(doc, { level: "info", text: `All ${doc.members.length} ticket(s) merged cleanly; no review of the combination needed` });
				return "DELIVERING";
			});
		},

		FIXING: async (rt, c, d) => {
			const conv = d.conversations.integrator!;
			const key = `${d.id}:FIXING:${d.counters.buildSeq}`;
			const findings = d.pending.findings ?? [];
			const ids = findings.filter((f) => f.blocking).map((f) => f.id!);
			const r = await runAgent(rt, c, d, "integrator", conv, key, fixInput(d), ["report_done"], ids);
			const diff = await svc.github.diff(d.workspace!, d.integration!.base);
			await transition(rt, c, d.id, async (doc, tx): Promise<Phase> => {
				pushCost(doc, "integrator", conv, r);
				const responses = r.payload.responses as FindingResponse[];
				const entry = [...doc.findingsLog].reverse().find((e) => e.findings.some((f) => ids.includes(f.id!)));
				if (entry) entry.responses = [...(entry.responses ?? []), ...responses];
				delete doc.pending.notes;
				notice(doc, { level: "info", text: `Integrator done (task #${doc.counters.buildSeq}): ${String(r.payload.summary).slice(0, 300)}` });
				doc.lastFingerprint = diff.fingerprint;
				await enterReview(rt, tx, doc);
				return "REVIEWING";
			});
		},

		REVIEWING: async (rt, c, d) => {
			const runs = await memberRuns(rt, c, d);
			await runReview(rt, c, d, {
				base: d.integration!.base,
				reviewerInput: (doc, diff, since) => reviewerInput(doc, runs, diff, since),
				qaInput: (doc, r, bootOk) => qaInput(doc, runs, r, bootOk),
			});
			await transition(rt, c, d.id, (doc): Phase => {
				const { verdict, findings } = reviewOutcome(doc);
				if (verdict === "pass") return "DELIVERING";
				if (doc.loop === "ci") {
					if (doc.counters.ciFixes < doc.caps.ciFix) {
						doc.counters.ciFixes += 1;
						return toFixing(doc, findings);
					}
					return toEscalated(doc, { reason: `review failed after CI fix ${doc.counters.ciFixes} (ci.fixRounds = ${doc.caps.ciFix} reached)`, from: "REVIEWING", cap: "ciFix", findings });
				}
				if (doc.counters.reviewRound < doc.caps.review) {
					doc.counters.reviewRound += 1;
					return toFixing(doc, findings);
				}
				return toEscalated(doc, { reason: `review round cap reached (${doc.caps.review} rounds) with blocking findings`, from: "REVIEWING", cap: "review", findings });
			});
		},

		DELIVERING: async (rt, c, d) => {
			await flushHeld(rt, c, d);
			const ws = d.workspace!;
			const now = await svc.github.diff(ws, d.integration!.base);
			if (d.lastFingerprint !== undefined && now.fingerprint !== d.lastFingerprint) {
				// The integrator changed files after the last review (a message): never delivered unreviewed.
				await transition(rt, c, d.id, async (doc, tx): Promise<Phase> => {
					doc.lastFingerprint = now.fingerprint;
					delete doc.mergeRequested;
					notice(doc, { level: "warn", text: "The worktree changed after the last review (the integrator acted on a message); reviewing again before delivery" });
					await enterReview(rt, tx, doc);
					return "REVIEWING";
				});
				return;
			}
			const runs = await memberRuns(rt, c, d);
			const out = await svc.github.deliverBundle(ws, deliveryContext(d, runs), rc(d));
			await transition(rt, c, d.id, (doc): Phase => {
				doc.delivery = out;
				doc.deliveredBase = doc.integration!.base;
				delete doc.noCi;
				if (out.kind === "repo") doc.workspace = { ...doc.workspace!, newRepo: false };
				notice(doc, { level: "info", text: `${out.kind === "pr" ? "PR" : "Pushed to main"}: ${out.url} @ ${out.sha.slice(0, 12)}`, url: out.url });
				if ((doc.pinned.config.ci?.mode ?? "if-present") === "off") return afterCi(doc);
				doc.ci = { startedAt: svc.now(), sha: out.sha };
				return "AWAITING_CI";
			});
		},

		AWAITING_CI: async (rt, c, d) => {
			const mode = d.pinned.config.ci?.mode ?? "if-present";
			const dl = d.delivery!;
			let external: "merged" | "closed" | undefined;
			let lastPoll = 0;
			const poll = async () => {
				if (dl.kind !== "pr" || !dl.pr || svc.now() - lastPoll < svc.ciPollMs) return false;
				lastPoll = svc.now();
				const s = await svc.github.prState(dl.pr, rc(d));
				if (s !== "open") external = s;
				return s !== "open";
			};
			const st = await waitForCi(rt, c, d, dl, d.ci!.startedAt, poll);
			if (!st) return externalEnd(rt, c, d, external!);
			if (st.state === "none" && mode !== "required")
				await svc.github.annotate(dl, d.workspace!, "No CI checks appeared within ci.noChecksTimeout: the repo has no CI, so CI did not run.", rc(d));
			await transition(rt, c, d.id, async (doc, tx): Promise<Phase> => {
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
					notice(doc, { level: "info", text: "No CI checks appeared: the repo has no CI; going on without CI.", noCi: true });
					const next = afterCi(doc);
					return next === "MERGED" ? toFinal(tx, doc, "MERGED") : next;
				}
				if (st.state === "green") {
					notice(doc, { level: "info", text: `CI green on ${dl.sha.slice(0, 12)}` });
					const next = afterCi(doc);
					return next === "MERGED" ? toFinal(tx, doc, "MERGED") : next;
				}
				return ciRed(doc, dl, st);
			});
		},

		AWAITING_MERGE: async (rt, c, d) => {
			await flushHeld(rt, c, d);
			const pr = d.delivery!.pr!;
			if (d.mergeRequested && !d.pendingAsk) return merge(rt, c, d, "auto");
			const ask = d.pendingAsk!;
			let lastPoll = 0;
			const got = await awaitResponseOr(rt, c, d.id, ask.id, async () => {
				if (svc.now() - lastPoll < svc.ciPollMs) return undefined;
				lastPoll = svc.now();
				const s = await svc.github.prState(pr, rc(d));
				return s === "open" ? undefined : s;
			});
			if (got.other) return externalEnd(rt, c, d, got.other as "merged" | "closed");
			const resp = got.response!;
			if (resp.type === "merge") return merge(rt, c, d, resp.by);
			await transition(rt, c, d.id, async (doc, tx): Promise<Phase> => {
				delete doc.pendingAsk;
				if (resp.type === "drop") return dropMembers(tx, doc, resp.runs, resp.by);
				if (resp.type !== "changes") throw new Error(`unexpected response ${resp.type} at the merge card`);
				// one blocking human finding; adds no review or CI round
				const findings = assignIds(doc, [{ severity: "major", blocking: true, source: "human", description: resp.feedback }]);
				doc.humanFindingsForReview.push(...findings);
				doc.findingsLog.push({ seq: doc.findingsLog.length + 1, kind: "human", round: doc.counters.reviewRound, findings });
				notice(doc, { level: "info", text: `${resp.by} requested changes` });
				return toFixing(doc, findings, "The human requested changes at the merge card.");
			});
		},

		ESCALATED: async (rt, c, d) => {
			await flushHeld(rt, c, d);
			const got = await awaitResponseOr(rt, c, d.id, d.pendingAsk!.id);
			const resp = got.response!;
			const choice = resp.type === "drop" ? { drop: resp.runs } : resp.type === "escalation" ? resp.choice : undefined;
			if (!choice) throw new Error(`unexpected response ${resp.type} to an escalation`);
			if ("abort" in choice && d.delivery?.pr) await svc.github.closePr(d.delivery.pr, rc(d)).catch((e) => svc.log(`bundle ${d.id}: closing the PR failed: ${e}`));
			await transition(rt, c, d.id, async (doc, tx): Promise<Phase> => {
				delete doc.pendingAsk;
				const esc = doc.escalation!;
				if ("abort" in choice) return toFinal(tx, doc, "CANCELLED", `aborted at escalation by ${resp.by}`);
				if ("drop" in choice) return dropMembers(tx, doc, choice.drop, resp.by);
				const cap = esc.cap === "none" ? (doc.loop === "ci" ? "ciFix" : "review") : esc.cap;
				doc.caps[cap] += choice.moreRounds;
				if (cap === "review") doc.counters.reviewRound += 1;
				else {
					doc.counters.ciFixes += 1;
					doc.loop = "ci";
				}
				return toFixing(doc, esc.findings);
			});
		},

		MERGED: async (rt, c, d) => finalize(rt, c, d),
		FAILED: async (rt, c, d) => finalize(rt, c, d),
		CANCELLED: async (rt, c, d) => finalize(rt, c, d),
		FINAL: async (rt, c, d) => finalize(rt, c, d),
	};

	function ciRed(doc: BundleDocState, dl: Delivery, st: CiStatus): Phase {
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
			return toFixing(doc, findings);
		}
		return toEscalated(doc, { reason: `CI failed and ci.fixRounds (${doc.caps.ciFix}) is reached`, from: "AWAITING_CI", cap: "ciFix", findings });
	}

	/** The PR was merged or closed outside the factory. */
	async function externalEnd(rt: RT, c: Context, d: BundleDocState, how: "merged" | "closed") {
		await transition(rt, c, d.id, async (doc, tx) => {
			if (how === "merged") {
				notice(doc, { level: "info", text: `The PR was merged on GitHub` });
				return toFinal(tx, doc, "MERGED");
			}
			return toFinal(tx, doc, "CANCELLED", "the PR was closed without merging");
		});
	}

	/**
	 * Merge (bundles spec §2.3). Unreviewed changes go through review first. When the default branch moved since the
	 * CI-checked integration, or GitHub refuses the merge, the bundle is updated onto the latest default branch and
	 * merges by itself once that update is green and needed no fix (a clean update of 2+ tickets is reviewed first; any
	 * FIXING clears mergeRequested and the bundle comes back for a fresh Merge click).
	 */
	async function merge(rt: RT, c: Context, d: BundleDocState, by: string) {
		const ws = d.workspace!;
		const pr = d.delivery!.pr!;
		const now = await svc.github.diff(ws, d.integration!.base);
		if (d.lastFingerprint !== undefined && now.fingerprint !== d.lastFingerprint) {
			await transition(rt, c, d.id, async (doc, tx): Promise<Phase> => {
				delete doc.pendingAsk;
				delete doc.mergeRequested;
				doc.lastFingerprint = now.fingerprint;
				notice(doc, { level: "warn", text: "The worktree changed after the last review (the integrator acted on a message); reviewing again before it can merge" });
				await enterReview(rt, tx, doc);
				return "REVIEWING";
			});
			return;
		}
		const head = await svc.github.defaultHead(ws, rc(d));
		if (head !== d.deliveredBase) {
			await transition(rt, c, d.id, (doc): Phase => {
				doc.mergeRequested = true;
				return toReintegrate(doc, `Merge (${by}): the default branch moved since the CI-checked integration; updating onto ${head.slice(0, 12)}. It merges by itself when the update needs no fix and CI is green.`);
			});
			return;
		}
		const method = mergeMethodOf(d);
		try {
			await svc.github.merge(pr, method, rc(d));
		} catch (e) {
			const why = e instanceof Error ? e.message : String(e);
			const refusals = d.notices.filter((n) => n.text.startsWith("GitHub refused the merge")).length;
			if (refusals + 1 >= MERGE_REFUSALS) throw new Error(`GitHub refused the merge ${MERGE_REFUSALS} times: ${why}`);
			await transition(rt, c, d.id, (doc): Phase => {
				doc.mergeRequested = true;
				return toReintegrate(doc, `GitHub refused the merge (${why.slice(0, 200)}); updating onto the latest default branch`);
			});
			return;
		}
		await transition(rt, c, d.id, async (doc, tx) => {
			notice(doc, { level: "info", text: `Merged by ${by === "auto" ? "the factory after a clean update (Merge was clicked)" : by} with ${method}` });
			return toFinal(tx, doc, "MERGED");
		});
	}

	async function settleUsage(rt: RT, c: Context, id: string) {
		const d = await read(rt, id, c);
		const convs: [Role, string][] = [
			...(d.conversations.integrator !== undefined ? [["integrator", d.conversations.integrator] as [Role, string]] : []),
			...d.conversations.reviewers.map((r) => ["reviewer", r.id] as [Role, string]),
			...(d.conversations.qa ?? []).map((r) => ["qa", r.id] as [Role, string]),
		];
		await kit.settleUsage(rt, c, id, convs);
	}

	async function finalize(rt: RT, c: Context, d: BundleDocState) {
		await settleUsage(rt, c, d.id);
		await sideEffectsAtEnd(d);
		await markVmsDisposed(rt, c, d.id);
		// Only the bundle's own things: member runs' branches and worktrees are the runs' (bundles merge them).
		const cleaned = await cleanAtEnd(svc.cleanup, bundleOwner(await read(rt, d.id, c)));
		await rt.commit(async (tx) => {
			await recordCleanup(tx, d.id, cleaned);
			return { status: "terminal", outcome: { status: "completed", result: d.state } };
		}, c);
	}

	/** The cleanedUp marker, in the Task's terminal commit (never downgraded). */
	async function recordCleanup(tx: Tx, id: string, scope: "scratch" | "full" | undefined) {
		if (!scope) return;
		const doc = await docIn(tx, id);
		doc.cleanedUp = nextMarker(doc.cleanedUp, scope, svc.now());
	}

	return defineTask<BundleInput, Checkpoint, string>({
		name: "factory.bundle",
		version: 1,
		initial: (input) => ({ phase: input.start, n: 0 }),
		phases: Object.fromEntries(
			(Object.keys(handlers) as Phase[]).map((phase) => [
				phase,
				async (task: any, rt: RT, c: Context) => {
					const d = await read(rt, task.input.bundleId, c);
					try {
						await handlers[phase](rt, c, d);
					} catch (e) {
						if (rt.signal.aborted || e instanceof Cancelled) throw e;
						if (phase === "FINAL" || phase === "MERGED" || phase === "FAILED" || phase === "CANCELLED") throw e;
						const reason = e instanceof Error ? e.message : String(e);
						svc.log(`bundle ${d.id} failed in ${d.state}: ${reason}`);
						await transition(rt, c, d.id, (doc, tx) => toFinal(tx, doc, "FAILED", reason));
					}
				},
			]),
		) as any,
		abort: async (task, rt, c) => {
			const id = task.input.bundleId;
			let d = await read(rt, id, c);
			if (!["MERGED", "FAILED", "CANCELLED"].includes(d.state)) {
				if (d.delivery?.pr) await svc.github.closePr(d.delivery.pr, rc(d)).catch((e) => svc.log(`bundle ${id}: closing the PR failed: ${e}`));
				await rt.commit(async (tx) => {
					const doc = await docIn(tx, id);
					await toFinal(tx, doc, "CANCELLED", doc.cancelReason ?? "cancelled");
					delete doc.driving;
					doc.updatedAt = svc.now();
					return undefined;
				}, c);
				d = await read(rt, id, c);
			}
			await settleUsage(rt, c, id).catch((e) => svc.log(`usage settle failed: ${e}`));
			await sideEffectsAtEnd(d);
			await markVmsDisposed(rt, c, id).catch(() => undefined);
			const cleaned = await cleanAtEnd(svc.cleanup, bundleOwner(await read(rt, id, c))).catch(() => undefined);
			await rt.commit(async (tx) => {
				await recordCleanup(tx, id, cleaned);
				return { status: "terminal", outcome: { status: "aborted", reason: "cancelled" } };
			}, c);
		},
	});
}
