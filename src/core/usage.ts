// Cost accounting per role Conversation. A Conversation's usage ledger (`pi.usage`) only grows; the run Document
// remembers how much of it is already in a cost record (`usage`), so a turn the core drives and a turn a human message
// started are each counted once, even when they overlap.
import type { RunDocState } from "./run-doc.ts";
import type { CostRecord, Role } from "./types.ts";

export type UsageSum = { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number; usd: number };
const KEYS = ["input", "output", "cacheRead", "cacheWrite", "totalTokens", "usd"] as const;
export const ZERO_USAGE: UsageSum = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, usd: 0 };

/** Sum a `pi.usage` snapshot (model and tool buckets; helpers report through the builder's tool bucket). */
export function sumUsage(u: { models?: Record<string, any>; tools?: Record<string, any> } | undefined): UsageSum {
	const sum = { ...ZERO_USAGE };
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
}

const max = (a: UsageSum, b: UsageSum | undefined): UsageSum => (b ? (Object.fromEntries(KEYS.map((k) => [k, Math.max(a[k], b[k])])) as UsageSum) : a);

/** Round and sequence number a role's cost records carry. */
export function roundSeq(d: RunDocState, role: Role): { round: number; seq: number } {
	if (role === "reviewer" || role === "qa") return { round: d.counters.reviewRound, seq: d.counters.reviewSeq };
	if (role === "builder" || role === "integrator") return { round: d.counters.reviewRound, seq: d.counters.buildSeq };
	return { round: d.counters.discussionSeq, seq: d.counters.discussionSeq };
}

/**
 * Record the usage of one turn (inside a commit): `after` minus what is already accounted for this Conversation
 * (or `before`, whichever is later). Returns the record, or undefined when nothing new was used.
 */
export function addCost(
	d: RunDocState,
	role: Role,
	conversationId: string,
	before: UsageSum,
	after: UsageSum,
	durationMs: number,
	opts: { trigger?: "message"; always?: boolean } = {},
): CostRecord | undefined {
	const key = String(conversationId);
	d.usage ??= {};
	const base = max(before, d.usage[key]);
	const delta = Object.fromEntries(KEYS.map((k) => [k, Math.max(0, after[k] - base[k])])) as UsageSum;
	d.usage[key] = max(after, d.usage[key]);
	if (!opts.always && delta.totalTokens === 0 && delta.usd === 0) return undefined;
	const roleCfg = d.pinned.config.roles?.[role] ?? {};
	const record: CostRecord = {
		role,
		...roundSeq(d, role),
		conversationId,
		model: String(roleCfg.model ?? ""),
		thinking: String(roleCfg.thinking ?? ""),
		...delta,
		durationMs,
		...(opts.trigger ? { trigger: opts.trigger } : {}),
	};
	d.cost.push(record);
	return record;
}
