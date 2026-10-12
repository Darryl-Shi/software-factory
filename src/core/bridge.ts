// factory.bridge (spec §3.4): the only path from agents to the pipeline. Its tools only commit a Document the core
// is waiting on; they never call layer-2 code. The core turns what they commit into state transitions.
import { Type } from "@earendil-works/pi-ai";
import { defineDoc, defineExtension, defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { validateQa, validateResponses, validateReview, validateTickets } from "./findings.ts";
import type { Role } from "./types.ts";

export type BridgeTool = "ask_human" | "submit_spec" | "report_done" | "submit_review" | "submit_qa" | "submit_tickets";

export type BridgeState = {
	runId?: string;
	role?: Role;
	/** What the core is waiting for right now: the request key and the tools that may answer it. */
	expect?: { key: string; tools: BridgeTool[]; findingIds?: string[] } | null;
	results: Record<string, { tool: BridgeTool; payload: any; at: number }>;
};

export const BridgeDoc = defineDoc<BridgeState>({
	kind: "factory.bridge",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ results: {} }),
});

/** Which conversation runs which role in which run, and its environment. Read by the Harness env function. */
export type EnvBinding = { runId?: string; role?: Role; envId?: string };
export const EnvDoc = defineDoc<EnvBinding>({
	kind: "factory.env",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({}),
});

/** Screenshots the QA agent took in its VM (§3.7), stored by the core; the ids its findings may cite. */
export const ScreenshotsDoc = defineDoc<{ ids: string[] }>({
	kind: "factory.screenshots",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ ids: [] }),
});

export const ROLE_TOOLS: Record<Role, BridgeTool[]> = {
	architect: ["ask_human", "submit_spec"],
	builder: ["report_done"],
	integrator: ["report_done"],
	reviewer: ["submit_review"],
	qa: ["submit_qa"],
	helper: [],
	discussant: ["submit_tickets"],
};

const text = (t: string) => [{ type: "text" as const, text: t }];

function bridgeTool<P extends Parameters<typeof defineTool>[0]["parameters"]>(
	name: BridgeTool,
	description: string,
	parameters: P,
	check: (args: any, expect: NonNullable<BridgeState["expect"]>, taken: string[]) => { ok: true; payload: unknown; reply: string } | { ok: false; problems: string[] },
): ToolRegistration {
	return defineTool({
		name,
		description,
		parameters,
		replay: "safe",
		executionMode: "sequential",
		execute: async (args, api, context) => {
			const outcome = await api.commit(async (tx) => {
				const doc = await tx.doc(BridgeDoc, api.conversationId);
				const expect = doc.expect;
				if (!expect || !expect.tools.includes(name))
					return { error: `${name} is not available right now: the factory is not waiting for it from this conversation.` };
				const existing = doc.results[expect.key];
				if (existing !== undefined)
					return existing.tool === name && JSON.stringify(existing.payload) === JSON.stringify(args)
						? { reply: "Already recorded." }
						: { error: `Already submitted ${existing.tool} for this turn; one submission at a time. Stop and wait.` };
				const taken = name === "submit_qa" ? [...((await tx.doc(ScreenshotsDoc, api.conversationId)).ids ?? [])] : [];
				const checked = check(args, expect as NonNullable<BridgeState["expect"]>, taken);
				if (!checked.ok) return { error: `Rejected by the factory:\n- ${checked.problems.join("\n- ")}\nFix these and call ${name} again.` };
				doc.results[expect.key] = { tool: name, payload: checked.payload as any, at: Date.now() };
				return { reply: checked.reply };
			}, context);
			if ("error" in outcome) return { content: text(outcome.error!), isError: true };
			return { content: text(outcome.reply!), control: { terminate: true } };
		},
	}) as ToolRegistration;
}

const FindingSchema = Type.Object({
	severity: Type.String({ description: "critical | major | minor | nit" }),
	blocking: Type.Boolean({ description: "Only blocking findings fail a round" }),
	specRef: Type.Optional(Type.String({ description: "The spec clause this finding rests on, when there is one (code-quality and security findings often have none)" })),
	description: Type.String(),
	// evidence is required; the factory's own validator enforces that with an actionable message.
	evidence: Type.Optional(Type.String({ description: "REQUIRED: what you observed yourself: the exact command and its output, or the code you point to (file and lines)" })),
	source: Type.Optional(Type.String({ description: 'Always "reviewer" (default)' })),
});

const QaFindingSchema = Type.Object({
	severity: Type.String({ description: "critical | major | minor | nit" }),
	blocking: Type.Boolean({ description: "Only blocking findings fail a round" }),
	specRef: Type.Optional(Type.String({ description: "The spec clause (e.g. an acceptance behaviour) this finding rests on, when there is one" })),
	description: Type.String(),
	evidence: Type.Optional(Type.String({ description: "REQUIRED: the UI steps you took and what you saw" })),
	screenshots: Type.Optional(Type.Array(Type.String(), { description: "REQUIRED: ids of screenshots you took this round (from the computer tool) that show it" })),
	source: Type.Optional(Type.String({ description: 'Always "qa" (default)' })),
});

export const askHuman = bridgeTool(
	"ask_human",
	"Ask the human ONE architecture question, grounded in the request and the repo. Your turn ends; the answer arrives as the next message.",
	Type.Object({ question: Type.String() }),
	(args) =>
		typeof args.question === "string" && args.question.trim()
			? { ok: true, payload: { question: args.question.trim() }, reply: "Question sent to the human. Stop now; the answer will arrive as the next message." }
			: { ok: false, problems: ["question is required"] },
);

export const submitSpec = bridgeTool(
	"submit_spec",
	"Submit the final spec: one markdown document that ends with a short list of acceptance behaviours (observable, product-level scenarios).",
	Type.Object({ markdown: Type.String() }),
	(args) => {
		const md = typeof args.markdown === "string" ? args.markdown : "";
		const problems: string[] = [];
		if (md.trim().length < 20) problems.push("the spec is empty");
		if (!/^#{1,6}\s*acceptance behaviou?rs\b/im.test(md)) problems.push('the spec must end with an "Acceptance behaviours" section');
		return problems.length ? { ok: false, problems } : { ok: true, payload: { markdown: md }, reply: "Spec submitted." };
	},
);

export const reportDone = bridgeTool(
	"report_done",
	"Report that the build (or this fix round) is done. `responses` must answer every finding you were given: fixed, or wontfix with a reason.",
	Type.Object({
		summary: Type.String(),
		responses: Type.Array(
			Type.Object({
				findingId: Type.String(),
				status: Type.Union([Type.Literal("fixed"), Type.Literal("wontfix")]),
				reason: Type.Optional(Type.String()),
			}),
		),
	}),
	(args, expect) => {
		const checked = validateResponses(expect.findingIds ?? [], args.responses ?? []);
		if (!checked.ok) return checked;
		return { ok: true, payload: { summary: String(args.summary ?? ""), responses: checked.responses }, reply: "Reported done." };
	},
);

export const submitReview = bridgeTool(
	"submit_review",
	'Submit your review verdict. "fail" if and only if at least one finding is blocking. Every finding needs evidence you observed (a command and its output, or file and lines); specRef when a spec clause applies. Blocking findings may be spec violations, failing/deleted/weakened tests, or code-quality and security problems serious enough to stop delivery.',
	Type.Object({ verdict: Type.Union([Type.Literal("pass"), Type.Literal("fail")]), findings: Type.Array(FindingSchema) }),
	(args) => {
		const checked = validateReview(args);
		return checked.ok ? { ok: true, payload: checked.review, reply: "Review submitted." } : checked;
	},
);

export const submitQa = bridgeTool(
	"submit_qa",
	'Submit your QA verdict after using the product like its user. "fail" if and only if at least one finding is blocking. Every finding needs evidence (the UI steps you took and what you saw) and at least one screenshot id you took this round.',
	Type.Object({ verdict: Type.Union([Type.Literal("pass"), Type.Literal("fail")]), findings: Type.Array(QaFindingSchema) }),
	(args, _expect, taken) => {
		const checked = validateQa(args, taken);
		return checked.ok ? { ok: true, payload: checked.review, reply: "QA verdict submitted." } : checked;
	},
);

export const submitTickets = bridgeTool(
	"submit_tickets",
	"Submit draft tickets and a summary of the discussion. Write one ticket per piece of work that can be specified, built and reviewed on its own. Each body is a self-contained request for the factory's architect: the goal, the constraints, what is in and out of scope, and acceptance criteria; refer to other tickets by title where they depend on each other. 1 to 20 tickets.",
	Type.Object({
		summary: Type.String({
			description: "What the discussion established, in markdown: the problem, decisions (marked as settled), rejected options and why, open questions, risks",
		}),
		tickets: Type.Array(Type.Object({ title: Type.String({ description: "At most 200 characters" }), body: Type.String() })),
	}),
	(args) => {
		const checked = validateTickets(args);
		return checked.ok ? { ok: true, payload: checked.payload, reply: "Tickets submitted." } : checked;
	},
);

const ALL: Record<BridgeTool, ToolRegistration> = {
	ask_human: askHuman,
	submit_spec: submitSpec,
	report_done: reportDone,
	submit_review: submitReview,
	submit_qa: submitQa,
	submit_tickets: submitTickets,
};

export const Bridge = defineExtension({ name: "factory.bridge", tools: Object.values(ALL) });

/** The bridge tools a role must NOT be offered (removed with `configure({ tools: { remove } })`). */
export function bridgeToolsNotFor(role: Role): ToolRegistration[] {
	return (Object.keys(ALL) as BridgeTool[]).filter((t) => !ROLE_TOOLS[role].includes(t)).map((t) => ALL[t]);
}
