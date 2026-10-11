// Human messages to a running agent (`FactoryCore.message`). The core routes a message to the agent the run is with and
// hands it to that Conversation as a Pi steer: placed after the agent's current tool round, or as a short turn of its
// own when the agent is idle. A message never moves the run; gates and escalations stay explicit operations.
import type { RunDocState } from "./run-doc.ts";
import type { HumanMessage, Role, RunState } from "./types.ts";

export const DEFAULT_MESSAGE_ROLES: Role[] = ["architect", "builder", "reviewer"];

/** States where the core itself drives a role Conversation (runAgent). */
const AGENT_STATES: RunState[] = ["DISCUSSING", "BUILDING", "REVIEWING"];

/** Who receives a message right now: the agent the run is with. */
export function messageTarget(d: Pick<RunDocState, "state" | "gate" | "conversations" | "counters">): { role: Role; conversationId?: string } {
	const c = d.conversations;
	if (["RECEIVED", "PREPARING", "DISCUSSING", "SPEC_READY"].includes(d.state) || (d.state === "AWAITING_APPROVAL" && d.gate === "spec"))
		return { role: "architect", ...(c.architect !== undefined ? { conversationId: c.architect } : {}) };
	if (d.state === "REVIEWING") {
		const r = c.reviewers.find((x) => x.seq === d.counters.reviewSeq) ?? c.reviewers.at(-1);
		return { role: "reviewer", ...(r ? { conversationId: r.id } : {}) };
	}
	return { role: "builder", ...(c.builder !== undefined ? { conversationId: c.builder } : {}) };
}

/**
 * Whether a message must wait for the core to start the role's next turn instead of being handed over now: the role
 * hasn't started yet, or the core is about to drive it and hasn't submitted its input. The core delivers held messages
 * as steers right after it submits that input.
 */
export function holdMessage(d: Pick<RunDocState, "state" | "driving">, target: { conversationId?: string }): boolean {
	if (target.conversationId === undefined) return true;
	return AGENT_STATES.includes(d.state) && String(d.driving?.conversationId) !== String(target.conversationId);
}

const HEADER = /^\[Message from the human via (\S+) · ([A-Za-z0-9._:-]+)\]\n/;

/** A human message with no situation note (a discussion's `say`): the header `parseMessage` reads, then the text. */
export function humanContent(by: string, msgId: string, text: string): { type: "text"; text: string }[] {
	return [
		{ type: "text", text: `[Message from the human via ${by} · ${msgId}]\n\n` },
		{ type: "text", text },
	];
}

/** What the agent receives: a header naming the sender, a note on where the run is, then the human's text. */
export function messageContent(d: RunDocState, msg: HumanMessage): { type: "text"; text: string }[] {
	const [head, body] = humanContent(msg.by, msg.id, msg.text) as [{ type: "text"; text: string }, { type: "text"; text: string }];
	return [{ type: "text", text: `${head.text.slice(0, -1)}${situation(d, msg.to)}\n\n` }, body];
}

/** Recognise a human message in a user entry's content (see `messageContent`). */
export function parseMessage(content: unknown): { by: string; msgId: string; text: string } | undefined {
	if (Array.isArray(content)) {
		const head = content[0]?.type === "text" ? String(content[0].text) : "";
		const m = HEADER.exec(head);
		if (!m) return undefined;
		return { by: m[1]!, msgId: m[2]!, text: content.slice(1).map((p: any) => (p?.type === "text" ? p.text : "")).join("") };
	}
	if (typeof content === "string") {
		const m = HEADER.exec(content);
		if (!m) return undefined;
		const body = content.indexOf("\n\n", m[0].length - 1);
		return { by: m[1]!, msgId: m[2]!, text: body >= 0 ? content.slice(body + 2) : "" };
	}
	return undefined;
}

function situation(d: RunDocState, role: Role): string {
	if (role === "architect") {
		const specGate = ((d.pinned.config.policy?.approvals ?? []) as string[]).includes("spec");
		if (d.state === "AWAITING_APPROVAL" || (d.state === "SPEC_READY" && specGate))
			return `Spec v${d.artifacts.spec?.version ?? 1} is waiting for the human's approval. Reply in text and do not call ask_human. If the human asks for a change, revise the spec and call submit_spec with the full revised document: it replaces the version waiting for approval.`;
		if (d.state === "SPEC_READY") return "The spec is submitted and the build is starting, so the spec can no longer change in this run. Reply in text.";
		return "You are in the architecture discussion. Take this into account; you still end your turn with ask_human (one question) or submit_spec.";
	}
	if (role === "reviewer")
		return `You are reviewing (review #${d.counters.reviewSeq}). Take this into account, but your verdict rests on the spec and on evidence you observe yourself. You still finish with submit_review.`;
	switch (d.state) {
		case "BUILDING":
			return `You are building (round ${d.counters.reviewRound}). Take this into account and carry on; you still finish with report_done.`;
		case "AWAITING_APPROVAL":
			return d.gate === "merge"
				? `Your work is delivered${d.artifacts.delivery?.url ? ` (${d.artifacts.delivery.url})` : ""} and waiting for the human's merge approval. Reply in text and do not call report_done. Changes you make now are not part of the delivery; the human can request changes at the gate.`
				: "Your reviewed work is waiting for the human's delivery approval. Reply in text and do not call report_done. If you change files now, the change goes back through review before delivery.";
		case "ESCALATED":
			return `The run is escalated to the human (${d.escalation?.reason ?? "needs a decision"}). Reply in text and do not call report_done; the human decides how the run continues. If they grant more rounds, the findings come back to you.`;
		case "DELIVERING":
		case "AWAITING_CI":
			return "Your work is being delivered and checked by CI. Reply in text and do not call report_done. If CI fails, the failure comes back to you as a finding.";
		default:
			return "Reply in text and do not call report_done.";
	}
}
