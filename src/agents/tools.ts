// Agent tools: plain Pi Durable extensions, visible to agents. Each role gets a fixed set (ROLE_TOOLS). They never call
// factory extensions. Role guidance lives in ./prompts.ts (prompt sections), not in the core.
import type { Context } from "@earendil-works/chord";
import { type AssistantMessage, Type } from "@earendil-works/pi-ai";
import {
	AssistantEntry,
	type ConversationId,
	AgentDoc,
	configure,
	defineExtension,
	defineTool,
	type EntryId,
	type Extension,
	section,
	type ToolExecutionApi,
	UsageDoc,
} from "@earendil-works/pi-durable";
import { createBashTool, createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-durable/tools";
import type { Role } from "../core/types.ts";
import { RoleArchitect, RoleBuilder, RoleHelper, RoleReviewer } from "./prompts.ts";
import { WebSearch } from "./web-search.ts";

export { WebSearch } from "./web-search.ts";

export const Coding = defineExtension({ name: "coding", tools: [createReadTool(), createWriteTool(), createEditTool(), createBashTool()] });
export const CodingReadonly = defineExtension({
	name: "coding-readonly",
	tools: [createReadTool(), createBashTool()],
	sections: [section("readonly", () => "Your file access is read-only: you can read files and run commands, but you cannot modify the source.", { tag: true })],
});

// ------------------------------------------------------------------ subagent (Pi's subagent pattern; helpers are owned Conversations)
async function answerText(api: ToolExecutionApi, answer: EntryId, c: Context): Promise<string> {
	const entry = await api.commit((tx) => tx.entry(AssistantEntry, answer), c);
	const message = entry?.model?.[0] as AssistantMessage | undefined;
	return message?.content.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("") ?? "";
}

export const Subagent: Extension = defineExtension({
	name: "subagent",
	tools: [
		defineTool({
			name: "subagent",
			description:
				"Delegate a self-contained READ/ANALYSIS task (search, code reading, running tests, a second opinion) to a helper and get its condensed answer. Helpers cannot write files; you stay the single writer.",
			parameters: Type.Object({ task: Type.String({ description: "What the helper should find out; ask for a short summary" }) }),
			replay: "safe",
			execute: async (args, api, c) => {
				const child = await api.commit(async (tx) => {
					const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
					if (existing !== undefined) return existing.id;
					// The host's conversationCreated hook gives the child the helper role (model, read-only env).
					const created = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
					// A host hook (the factory's conversationCreated) may already have given the helper an explicit,
					// subagent-free extension list; only fall back to "inherit minus subagent" when it did not.
					const agent = await tx.doc(AgentDoc, created.id);
					if (!Array.isArray(agent.extensions)) await configure(tx, created.id, { extensions: { remove: [Subagent] } });
					return created.id;
				}, c);
				await api.details({ conversationId: child }, c);
				const handle = (await api.conversation(child, c))!;
				const settled = await (await handle.submit({ type: "input", content: args.task, requestId: `subagent:${api.taskId}` }, c)).wait(c);
				if (settled.status !== "done" || settled.type !== "input") throw new Error(`helper failed: ${settled.status}`);
				const text = await answerText(api, settled.answer as EntryId, c);
				const u = await api.snapshot(UsageDoc, child as ConversationId, c);
				const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
				for (const v of Object.values(u?.models ?? {}) as any[]) {
					usage.input += v.input;
					usage.output += v.output;
					usage.cacheRead += v.cacheRead;
					usage.cacheWrite += v.cacheWrite;
					usage.totalTokens += v.totalTokens;
					for (const k of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) usage.cost[k] += v.cost?.[k] ?? 0;
				}
				return { content: [{ type: "text", text }], details: { conversationId: child }, usage };
			},
		}),
	],
});

// ------------------------------------------------------------------ test runner
const DETECT = `
if [ -f AGENTS.md ] && grep -qiE '^[[:space:]]*[-*]?[[:space:]]*(test|tests)[[:space:]]*:' AGENTS.md; then
  cmd=$(grep -iE '^[[:space:]]*[-*]?[[:space:]]*(test|tests)[[:space:]]*:' AGENTS.md | head -1 | sed -E 's/^[^:]*:[[:space:]]*//; s/^\`//; s/\`.*$//')
elif [ -f package.json ] && grep -q '"test"' package.json; then cmd="npm test --silent"
elif [ -f pyproject.toml ] || [ -f pytest.ini ]; then cmd="python -m pytest -q"
elif [ -f go.mod ]; then cmd="go test ./..."
elif [ -f Cargo.toml ]; then cmd="cargo test"
else echo "no test command found (add 'Test: <command>' to AGENTS.md)"; exit 2; fi
echo "\\$ $cmd"; eval "$cmd"`;

export const TestRunner = defineExtension({
	name: "test-runner",
	tools: [
		defineTool({
			name: "run_tests",
			description: "Run the project's test suite (the 'Test:' command in AGENTS.md, else detected) or a given command. Returns the command, its output and exit code.",
			parameters: Type.Object({ command: Type.Optional(Type.String({ description: "Override the test command" })) }),
			outputLimits: { retain: "tail" },
			execute: async (args, api, c) => {
				if (!api.env) throw new Error("No execution environment is configured");
				const script = args.command ? `echo "\\$ ${args.command.replace(/"/g, '\\"')}"; ${args.command}` : DETECT;
				const r = await api.env.exec(script, { onOutput: (t) => api.output(t) }, c);
				const code = r.ok ? r.value.exitCode : -1;
				api.output(`\n[exit code ${code}]${r.ok ? "" : ` ${r.error.message}`}\n`);
				return { details: { exitCode: code } };
			},
		}),
	],
});

// ------------------------------------------------------------------ browser (HTTP client; runs inside the sandboxed env)
export const Browser = defineExtension({
	name: "browser",
	tools: [
		defineTool({
			name: "http_request",
			description: "Make an HTTP request to the running product (e.g. http://localhost:3000/...) and return status, headers and body.",
			parameters: Type.Object({
				url: Type.String(),
				method: Type.Optional(Type.String()),
				body: Type.Optional(Type.String()),
				headers: Type.Optional(Type.Record(Type.String(), Type.String())),
			}),
			execute: async (args, api, c) => {
				if (!api.env) throw new Error("No execution environment is configured");
				const argv = ["curl", "-sS", "-i", "-m", "30", "-X", args.method ?? "GET", ...Object.entries(args.headers ?? {}).flatMap(([k, v]) => ["-H", `${k}: ${v}`]), ...(args.body ? ["--data-binary", args.body] : []), args.url];
				const r = await api.env.exec(argv, { onOutput: (t) => api.output(t) }, c);
				if (!r.ok) throw r.error;
				if (r.value.exitCode !== 0) throw new Error(`curl exited ${r.value.exitCode}`);
				return {};
			},
		}),
	],
});

/** The fixed tool set of each role: its role prompt first, then its tools. */
export const ROLE_TOOLS: Record<Role, Extension[]> = {
	architect: [RoleArchitect, CodingReadonly, WebSearch],
	builder: [RoleBuilder, Coding, Subagent, TestRunner, WebSearch],
	helper: [RoleHelper, CodingReadonly, WebSearch],
	reviewer: [RoleReviewer, CodingReadonly, TestRunner, Browser, WebSearch],
};

/** Every distinct agent extension, installed into the registry so persisted Conversations resolve them on resume. */
export const AGENT_EXTENSIONS: Extension[] = [...new Set(Object.values(ROLE_TOOLS).flat())];
