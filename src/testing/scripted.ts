// A scripted "model" provider for tests and dry runs (no model credentials needed). Built on pi-ai's faux provider:
// each model id runs a script that looks at the transcript and returns the next assistant message (text or tool
// calls). Tools still really execute (CodingTools, sandboxed bash, the factory bridge), so the whole pipeline runs.
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { parseMessage } from "../core/messages.ts";

export interface ScriptContext {
	model: string;
	messages: Message[];
	/** Text of the latest user message from the core (human messages, see `human`, don't count here or below). */
	input: string;
	/** All user messages from the core (oldest first). */
	inputs: string[];
	/** Assistant turns since the latest core input. */
	turn: number;
	/** Tool results since the latest core input, oldest first. */
	results: { name: string; text: string; isError: boolean }[];
	systemPrompt: string;
	/** Human messages (`message` op), full text including the factory's header, oldest first. */
	human: string[];
	/**
	 * Set while the agent handles a human message that arrived when it was idle (a side turn the message started):
	 * the message, and the agent's turns and tool results since it.
	 */
	side?: { message: string; turn: number; results: { name: string; text: string; isError: boolean }[] };
}
/** `onMessage` answers side turns (default: a one-line acknowledgement). Steers mid-run go to the script itself. */
export type Script = ((ctx: ScriptContext) => AssistantMessage | Promise<AssistantMessage>) & {
	onMessage?: (ctx: ScriptContext) => AssistantMessage | Promise<AssistantMessage> | undefined;
};
const BRIDGE_TOOLS = ["ask_human", "submit_spec", "report_done", "submit_review", "submit_qa", "submit_tickets"];
/** The human's own text of a message (without the factory's header and situation note). */
export const humanText = (full: string) => parseMessage(full)?.text ?? full;

export const say = (text: string) => fauxAssistantMessage([fauxText(text)]);
/** A model call that fails (provider error), e.g. to exercise a turn that ends in error. */
export const fail = (message: string) => fauxAssistantMessage([], { stopReason: "error", errorMessage: message });
let callSeq = 0;
export const call = (name: string, args: Record<string, unknown>) =>
	fauxAssistantMessage([fauxToolCall(name, args as any, { id: `call_${Date.now().toString(36)}_${++callSeq}` })], { stopReason: "toolUse" });
export const calls = (...cs: [string, Record<string, unknown>][]) =>
	fauxAssistantMessage(
		cs.map(([n, a]) => fauxToolCall(n, a as any, { id: `call_${Date.now().toString(36)}_${++callSeq}` })),
		{ stopReason: "toolUse" },
	);

const textOf = (m: any): string =>
	typeof m.content === "string" ? m.content : (m.content ?? []).map((p: any) => (p.type === "text" ? p.text : "")).join("");

export function scriptedProvider(scripts: Record<string, Script>, providerId = "scripted") {
	const faux = fauxProvider({
		provider: providerId,
		models: Object.keys(scripts).map((id) => ({ id, reasoning: true, input: (id.endsWith("-textonly") ? ["text"] : ["text", "image"]) as ("text" | "image")[], contextWindow: 400_000, maxTokens: 32_000, cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } })),
	});
	const step = async (context: any, _opts: unknown, _state: unknown, model: { id: string }) => {
		const messages = (context.messages ?? []) as Message[];
		const isHuman = (m: Message) => m.role === "user" && parseMessage(textOf(m)) !== undefined;
		const resultsOf = (ms: Message[]) => ms.filter((m) => m.role === "toolResult").map((m: any) => ({ name: m.toolName, text: textOf(m), isError: !!m.isError }));
		let lastUser = -1;
		let lastHuman = -1;
		messages.forEach((m, i) => {
			if (isHuman(m)) lastHuman = i;
			else if (m.role === "user") lastUser = i;
		});
		const after = messages.slice(lastUser + 1).filter((m) => !isHuman(m));
		const ctx: ScriptContext = {
			model: model.id,
			messages,
			input: lastUser >= 0 ? textOf(messages[lastUser]) : "",
			inputs: messages.filter((m) => m.role === "user" && !isHuman(m)).map(textOf),
			turn: after.filter((m) => m.role === "assistant").length,
			results: resultsOf(after),
			systemPrompt: String(context.systemPrompt ?? ""),
			human: messages.filter(isHuman).map(textOf),
		};
		const script = scripts[model.id];
		if (!script) return say(`no script for ${model.id}`);
		try {
			if (lastHuman > lastUser) {
				// A human message the core hasn't followed with input of its own. If the agent had finished (its last
				// message before the message ended a turn), the message started a side turn; otherwise it is a steer.
				const before = messages.slice(0, lastHuman).filter((m) => !isHuman(m)).at(-1) as any;
				const since = messages.slice(lastHuman + 1);
				// (a factory bridge tool that succeeded ends the agent's run, like a final text reply does)
				// (a message to a Conversation that never had input of the core's starts a side turn too)
				const sideStart =
					before === undefined || before.role === "system" ||
					(before?.role === "assistant" && !(before.content ?? []).some((p: any) => p.type === "toolCall")) ||
					(before?.role === "toolResult" && BRIDGE_TOOLS.includes(before.toolName) && !before.isError);
				if (sideStart) {
					ctx.side = { message: textOf(messages[lastHuman]), turn: since.filter((m) => m.role === "assistant").length, results: resultsOf(since) };
					const out = await script.onMessage?.(ctx);
					return out ?? say(ctx.side.turn === 0 ? `Noted: ${humanText(ctx.side.message).split("\n")[0]}` : "Done.");
				}
				const out = await script(ctx);
				if (since.some((m) => m.role === "assistant")) return out;
				// first step after a steer: acknowledge it, then carry on with the script
				return { ...out, content: [fauxText(`Noted your message: ${humanText(textOf(messages[lastHuman])).split("\n")[0]}\n\n`), ...out.content] };
			}
			return await script(ctx);
		} catch (e) {
			return say(`script error: ${e instanceof Error ? e.stack : e}`);
		}
	};
	const refill = () => faux.setResponses(Array.from({ length: 10_000 }, () => step));
	refill();
	return {
		provider: faux.provider,
		refill,
		/** Replace or add a script at runtime (tests). */
		set(id: string, s: Script) {
			scripts[id] = s;
		},
		scripts,
	};
}
