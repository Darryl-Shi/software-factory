// Enforced findings/evidence rules (spec §2 "Findings", §3.4). Pure functions; the bridge tools and the core both use them.
import type { Finding, FindingResponse, HumanFinding, ReviewResult } from "./types.ts";

const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;

/**
 * A reviewer submission is valid iff:
 * - verdict is "pass" or "fail";
 * - the verdict is "fail" if and only if at least one finding is blocking;
 * - every finding has a severity, a blocking flag, a description and a specRef;
 * - every reviewer finding carries evidence it observed (a command and its output, or a screenshot);
 * - reviewers cannot submit findings as `human` (or `ci`).
 */
export function validateReview(input: unknown): { ok: true; review: ReviewResult } | { ok: false; problems: string[] } {
	const problems: string[] = [];
	if (typeof input !== "object" || input === null) return { ok: false, problems: ["submission must be an object"] };
	const { verdict, findings } = input as { verdict?: unknown; findings?: unknown };
	if (verdict !== "pass" && verdict !== "fail") problems.push(`verdict must be "pass" or "fail"`);
	if (!Array.isArray(findings)) return { ok: false, problems: [...problems, "findings must be a list"] };
	const out: Finding[] = [];
	findings.forEach((raw, i) => {
		const f = raw as Partial<Finding>;
		const at = `findings[${i}]`;
		if (typeof f !== "object" || f === null) {
			problems.push(`${at}: must be an object`);
			return;
		}
		const source = f.source ?? "reviewer";
		if (source !== "reviewer") problems.push(`${at}: reviewers may only submit findings with source "reviewer"`);
		if (!nonEmpty(f.severity)) problems.push(`${at}: severity is required`);
		if (typeof f.blocking !== "boolean") problems.push(`${at}: blocking must be true or false`);
		if (!nonEmpty(f.description)) problems.push(`${at}: description is required`);
		if (!nonEmpty(f.specRef)) problems.push(`${at}: specRef (the spec clause the finding rests on) is required`);
		if (!nonEmpty(f.evidence))
			problems.push(`${at}: evidence is required: the command you ran and its output, or a screenshot, that you observed yourself`);
		out.push({
			severity: String(f.severity ?? ""),
			blocking: f.blocking === true,
			specRef: f.specRef,
			description: String(f.description ?? ""),
			evidence: f.evidence,
			source: "reviewer",
		});
	});
	const blocking = out.filter((f) => f.blocking).length;
	if (verdict === "fail" && blocking === 0) problems.push(`verdict "fail" requires at least one blocking finding`);
	if (verdict === "pass" && blocking > 0)
		problems.push(`verdict "pass" is not allowed with blocking findings: the verdict is "fail" if and only if at least one finding is blocking`);
	if (problems.length) return { ok: false, problems };
	return { ok: true, review: { verdict: verdict as "pass" | "fail", findings: out } };
}

/** Human findings (gate rejections): always blocking, source human; specRef and evidence optional. */
export function humanFindings(input: HumanFinding[]): { ok: true; findings: Finding[] } | { ok: false; problems: string[] } {
	const problems: string[] = [];
	if (!Array.isArray(input) || input.length === 0) return { ok: false, problems: ["at least one finding is required"] };
	const findings = input.map((h, i) => {
		if (!nonEmpty(h?.description)) problems.push(`findings[${i}]: description is required`);
		if (!nonEmpty(h?.severity)) problems.push(`findings[${i}]: severity is required`);
		return {
			severity: h?.severity,
			blocking: true,
			description: h?.description,
			...(h?.specRef ? { specRef: h.specRef } : {}),
			...(h?.evidence ? { evidence: h.evidence } : {}),
			source: "human" as const,
		};
	});
	if (problems.length) return { ok: false, problems };
	return { ok: true, findings };
}

/** The builder must answer each finding it was given: fixed, or won't fix + reason. */
export function validateResponses(
	expectedIds: string[],
	input: unknown,
): { ok: true; responses: FindingResponse[] } | { ok: false; problems: string[] } {
	const problems: string[] = [];
	if (!Array.isArray(input)) return { ok: false, problems: ["responses must be a list"] };
	const byId = new Map<string, FindingResponse>();
	input.forEach((raw, i) => {
		const r = raw as Partial<FindingResponse>;
		if (!nonEmpty(r?.findingId)) {
			problems.push(`responses[${i}]: findingId is required`);
			return;
		}
		if (!expectedIds.includes(r.findingId)) problems.push(`responses[${i}]: unknown finding ${r.findingId}`);
		if (r.status !== "fixed" && r.status !== "wontfix") problems.push(`responses[${i}]: status must be "fixed" or "wontfix"`);
		if (r.status === "wontfix" && !nonEmpty(r.reason)) problems.push(`responses[${i}]: "wontfix" requires a reason`);
		byId.set(r.findingId, { findingId: r.findingId, status: r.status as "fixed" | "wontfix", ...(r.reason ? { reason: r.reason } : {}) });
	});
	for (const id of expectedIds) if (!byId.has(id)) problems.push(`finding ${id} has no response (answer it as fixed, or wontfix with a reason)`);
	if (problems.length) return { ok: false, problems };
	return { ok: true, responses: [...byId.values()] };
}

export function formatFinding(f: Finding): string {
	const lines = [
		`- [${f.id ?? "?"}] (${f.source ?? "reviewer"}, ${f.blocking ? "BLOCKING" : "advisory"}, ${f.severity})${f.specRef ? ` spec: ${f.specRef}` : ""}`,
		`  ${f.description.replace(/\n/g, "\n  ")}`,
	];
	if (f.evidence) lines.push(`  evidence:\n    ${f.evidence.slice(0, 4000).replace(/\n/g, "\n    ")}`);
	return lines.join("\n");
}
