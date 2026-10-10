// The fixed per-role agent tools: plain Pi Durable extensions, visible to agents. Each role gets a fixed set
// (ROLE_TOOLS). Role guidance lives in ./prompts.ts (prompt sections), not in the core.
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
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ScreenshotsDoc } from "../core/bridge.ts";
import { runConfigOf } from "../core/run-config.ts";
import type { Role } from "../core/types.ts";
import { RoleArchitect, RoleBuilder, RoleHelper, RoleQa, RoleReviewer } from "./prompts.ts";
import { WebSearch } from "./web-search.ts";

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
				"Delegate a task to a helper, writing code included: it works in your workspace with read, write, edit, bash, run_tests and web_search, and returns a short summary of what it did. Call several at once to have parts built in parallel; keep their tasks apart. Helpers leave changes uncommitted unless you tell them otherwise. Check what they actually changed (git status, git diff) and run the tests before report_done.",
			parameters: Type.Object({ task: Type.String({ description: "The task: what to build or find out, which files it owns, and to end with a short summary of what it changed" }) }),
			replay: "safe",
			execute: async (args, api, c) => {
				const child = await api.commit(async (tx) => {
					const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
					if (existing !== undefined) return existing.id;
					// The host's conversationCreated hook gives the child the helper role (its model, the builder's environment).
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

// ------------------------------------------------------------------ computer (the QA agent's desktop, through boat's Cua Driver)
export const COMPUTER_ACTIONS = [
	"list_apps",
	"list_windows",
	"get_window_state",
	"click",
	"type_text",
	"press_key",
	"scroll",
	"launch_app",
	"browser_navigate",
	"browser_click",
	"browser_type",
	"get_browser_state",
] as const;

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export const Computer = defineExtension({
	name: "computer",
	tools: [
		defineTool({
			name: "computer",
			description:
				"Drive the VM's desktop and Chrome through the Cua Driver (`cua-driver call <action> <args>`): list_apps, list_windows, get_window_state ({pid, window_id}: a screenshot of ONE window plus its accessibility tree), click, type_text, press_key, scroll, launch_app, browser_navigate ({url}), browser_click, browser_type, get_browser_state. Every screenshot is shown to you and stored under an id (e.g. r1-s3); cite those ids in submit_qa findings.",
			parameters: Type.Object({
				action: Type.Union(COMPUTER_ACTIONS.map((a) => Type.Literal(a)) as any, { description: "The Cua Driver tool to call" }),
				args: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "The tool's JSON arguments, e.g. {pid, window_id} or {url}" })),
			}),
			execute: async (args, api, c) => {
				if (!api.env) throw new Error("No execution environment is configured");
				const cfg = await runConfigOf(api as any, c);
				const json = JSON.stringify(args.args ?? {});
				const shot = "$HOME/.factory-shot.png";
				const script = `F=${shot}; rm -f "$F"; cua-driver call ${shq(String(args.action))} ${shq(json)} --screenshot-out-file "$F"; code=$?; if [ -s "$F" ]; then echo; echo "__SHOT=$F"; fi; exit $code`;
				let out = "";
				const r = await api.env.exec(script, { onOutput: (t) => (out += t) }, c);
				if (!r.ok) throw r.error;
				const m = /__SHOT=(.+)\s*$/m.exec(out);
				const text = out.replace(/\n?__SHOT=.+\s*$/m, "").slice(-20_000);
				const content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] = [];
				if (m && cfg.qa && cfg.runId) {
					const bytes = await api.env.readBinaryFile(m[1]!.trim(), c);
					if (bytes.ok) {
						const id = await api.commit(async (tx) => {
							const doc = await tx.doc(ScreenshotsDoc, api.conversationId);
							const next = `r${cfg.qa!.seq}-s${doc.ids.length + 1}`;
							// stored outside every sandbox and VM before the id is recorded, so a cited id always has its file
							const dir = join(cfg.qa!.artifactsDir, cfg.runId!, "screenshots");
							mkdirSync(dir, { recursive: true });
							writeFileSync(join(dir, `${next}.png`), bytes.value);
							doc.ids.push(next);
							return next;
						}, c);
						content.push({ type: "text", text: `${text}\n[exit code ${r.value.exitCode}] Screenshot ${id} (cite it in submit_qa findings as screenshots: ["${id}"])` });
						content.push({ type: "image", data: Buffer.from(bytes.value).toString("base64"), mimeType: "image/png" });
						return { content, details: { exitCode: r.value.exitCode, screenshot: id }, ...(r.value.exitCode !== 0 ? { isError: true } : {}) } as any;
					}
				}
				content.push({ type: "text", text: `${text}\n[exit code ${r.value.exitCode}]` });
				return { content, details: { exitCode: r.value.exitCode }, ...(r.value.exitCode !== 0 ? { isError: true } : {}) } as any;
			},
		}),
	],
});

/** The fixed tool set of each role (spec §3.3): its role prompt first, then its tools. Not a setting. */
export const ROLE_TOOLS: Record<Role, Extension[]> = {
	architect: [RoleArchitect, CodingReadonly, WebSearch],
	builder: [RoleBuilder, Coding, Subagent, TestRunner, WebSearch],
	// helpers write code in the builder's environment; no subagent (they spawn no helpers) and no bridge tools
	helper: [RoleHelper, Coding, TestRunner, WebSearch],
	reviewer: [RoleReviewer, CodingReadonly, TestRunner, WebSearch],
	qa: [RoleQa, CodingReadonly, Computer, WebSearch],
};

/**
 * Every distinct agent extension, installed into the registry so persisted Conversations resolve them on resume.
 * `Browser` is in no role's set any more; it stays registered for reviewer Conversations of runs started before.
 */
export const AGENT_EXTENSIONS: Extension[] = [...new Set([...Object.values(ROLE_TOOLS).flat(), Browser])];
