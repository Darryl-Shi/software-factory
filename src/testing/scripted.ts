// A scripted "model" provider for tests and dry runs (no model credentials needed). Built on pi-ai's faux provider:
// each model id runs a script that looks at the transcript and returns the next assistant message (text or tool
// calls). Tools still really execute (CodingTools, sandboxed bash, the factory bridge), so the whole pipeline runs.
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";

export interface ScriptContext {
	model: string;
	messages: Message[];
	/** Text of the latest user message. */
	input: string;
	/** All user messages (oldest first). */
	inputs: string[];
	/** Assistant turns since the latest user message. */
	turn: number;
	/** Tool results since the latest user message, oldest first. */
	results: { name: string; text: string; isError: boolean }[];
	systemPrompt: string;
}
export type Script = (ctx: ScriptContext) => AssistantMessage | Promise<AssistantMessage>;

export const say = (text: string) => fauxAssistantMessage([fauxText(text)]);
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
		models: Object.keys(scripts).map((id) => ({ id, reasoning: true, contextWindow: 400_000, maxTokens: 32_000, cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } })),
	});
	const step = async (context: any, _opts: unknown, _state: unknown, model: { id: string }) => {
		const messages = (context.messages ?? []) as Message[];
		let lastUser = -1;
		messages.forEach((m, i) => {
			if (m.role === "user") lastUser = i;
		});
		const after = messages.slice(lastUser + 1);
		const ctx: ScriptContext = {
			model: model.id,
			messages,
			input: lastUser >= 0 ? textOf(messages[lastUser]) : "",
			inputs: messages.filter((m) => m.role === "user").map(textOf),
			turn: after.filter((m) => m.role === "assistant").length,
			results: after.filter((m) => m.role === "toolResult").map((m: any) => ({ name: m.toolName, text: textOf(m), isError: !!m.isError })),
			systemPrompt: String(context.systemPrompt ?? ""),
		};
		const script = scripts[model.id];
		if (!script) return say(`no script for ${model.id}`);
		try {
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
