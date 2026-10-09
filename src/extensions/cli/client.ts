// The `factory` terminal client (cli interface extension, spec §7): commands over the core operations, `attach`
// (renders getRun + the active role Conversation incl. the builder's helpers, follows events, answers asks) and a
// settings menu generated from settingsSchema(). It talks to the process that owns the core over the cli socket.
import { connect, type Socket } from "node:net";
import { createInterface } from "node:readline";
import YAML from "yaml";
import { expandHome } from "../../core/settings.ts";
import type { FactoryEvent, RunView, SettingField, TranscriptItem, TranscriptView } from "../../core/types.ts";
import { DEFAULT_SOCKET } from "./server.ts";

export class Client {
	private sock!: Socket;
	private seq = 0;
	private pending = new Map<number, { resolve(v: any): void; reject(e: any): void }>();
	private subs = new Map<number, (e: FactoryEvent) => void>();
	private buf = "";

	static async connect(socket = process.env.FACTORY_SOCKET ?? DEFAULT_SOCKET): Promise<Client> {
		const c = new Client();
		await new Promise<void>((resolve, reject) => {
			c.sock = connect(expandHome(socket), () => resolve());
			c.sock.once("error", (e) => reject(new Error(`cannot reach the factory at ${socket} (${(e as any).code}); start it with \`factory serve\``)));
		});
		c.sock.on("data", (d) => c.onData(d.toString()));
		c.sock.on("close", () => {
			for (const p of c.pending.values()) p.reject(new Error("connection closed"));
		});
		return c;
	}

	private onData(d: string) {
		this.buf += d;
		let i: number;
		while ((i = this.buf.indexOf("\n")) >= 0) {
			const msg = JSON.parse(this.buf.slice(0, i));
			this.buf = this.buf.slice(i + 1);
			if (msg.event) {
				this.subs.get(msg.id)?.(msg.event);
				continue;
			}
			const p = this.pending.get(msg.id);
			if (!p) continue;
			this.pending.delete(msg.id);
			if (msg.ok) p.resolve(msg.result);
			else p.reject(Object.assign(new Error(msg.error), { code: msg.code }));
		}
	}

	call<T = any>(op: string, ...args: unknown[]): Promise<T> {
		const id = ++this.seq;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			this.sock.write(`${JSON.stringify({ id, op, args })}\n`);
		});
	}

	async subscribe(filter: { run?: string; project?: string }, on: (e: FactoryEvent) => void) {
		const id = ++this.seq;
		this.subs.set(id, on);
		await new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			this.sock.write(`${JSON.stringify({ id, op: "subscribe", args: [filter] })}\n`);
		});
	}

	close() {
		this.sock.end();
	}
}

// ------------------------------------------------------------------ rendering
const C = process.stdout.isTTY && !process.env.NO_COLOR
	? { dim: (s: string) => `\x1b[2m${s}\x1b[0m`, bold: (s: string) => `\x1b[1m${s}\x1b[0m`, cyan: (s: string) => `\x1b[36m${s}\x1b[0m`, yellow: (s: string) => `\x1b[33m${s}\x1b[0m`, green: (s: string) => `\x1b[32m${s}\x1b[0m`, red: (s: string) => `\x1b[31m${s}\x1b[0m` }
	: { dim: (s: string) => s, bold: (s: string) => s, cyan: (s: string) => s, yellow: (s: string) => s, green: (s: string) => s, red: (s: string) => s };

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

export function renderRun(v: RunView): string {
	const lines = [
		`${C.bold(v.id)}  project ${v.project} (${v.repo})  ${C.cyan(v.state + (v.gate ? `(${v.gate})` : ""))}`,
		`  request: ${clip(v.request.title, 100)}`,
		`  review round ${v.reviewRound}/${v.caps.review} · CI fixes ${v.ciFixes}/${v.caps.ciFix} · config ${v.configHash} · pi-durable ${v.piVersion}`,
	];
	if (v.artifacts.spec) lines.push(`  spec v${v.artifacts.spec.version} (docs/spec.md)`);
	if (v.artifacts.delivery) lines.push(`  delivery: ${v.artifacts.delivery.kind} ${v.artifacts.delivery.url} @ ${v.artifacts.delivery.sha.slice(0, 12)}`);
	if (v.noCi) lines.push(`  CI: none (the repo has no CI checks)`);
	if (v.failure) lines.push(C.red(`  ${v.state.toLowerCase()} in ${v.failure.state}: ${v.failure.reason}`));
	const usd = v.cost.reduce((a, c) => a + c.usd, 0);
	const tok = v.cost.reduce((a, c) => a + c.totalTokens, 0);
	lines.push(`  cost: ${tok} tokens, $${usd.toFixed(4)} (${v.cost.map((c) => `${c.role}@${c.round}`).join(", ") || "none yet"})`);
	if (v.pendingAsk) lines.push(C.yellow(`  pending ask ${v.pendingAsk.id}: ${renderQuestion(v)}`));
	return lines.join("\n");
}

function renderQuestion(v: RunView): string {
	const q = v.pendingAsk!.question;
	if (q.kind === "discussion") return `architect asks: ${q.text}`;
	if (q.kind === "approval") return `approve ${q.gate}? (approve | reject <feedback>)${q.artifact.url ? ` ${q.artifact.url}` : ""}`;
	return `escalation: ${q.reason} (accept | more <N> | abort)`;
}

export function renderItem(i: TranscriptItem, indent = ""): string {
	if (i.role === "user") return `${indent}${C.dim("▶ input:")} ${clip(i.text ?? "", 400).replace(/\n/g, `\n${indent}  `)}`;
	if (i.role === "assistant") {
		const parts: string[] = [];
		if (i.text) parts.push(`${indent}${C.bold("◆")} ${clip(i.text, 600).replace(/\n/g, `\n${indent}  `)}`);
		for (const t of i.toolCalls ?? []) parts.push(`${indent}${C.cyan("⚙ " + t.name)} ${clip(JSON.stringify(t.args), 200)}`);
		return parts.join("\n");
	}
	if (i.toolResult) return `${indent}  ${i.toolResult.isError ? C.red("✗") : C.green("✓")} ${C.dim(clip(i.toolResult.text.trim(), 300).replace(/\n/g, `\n${indent}    `))}`;
	return "";
}

// ------------------------------------------------------------------ attach
export async function attach(client: Client, run: string, opts: { interactive: boolean; out?: (s: string) => void }): Promise<RunView> {
	const out = opts.out ?? ((s: string) => console.log(s));
	let v = await client.call<RunView>("getRun", run);
	out(renderRun(v));
	const shown = new Map<string, number>();
	const showConversation = async (id: string, indent = "") => {
		let tr: TranscriptView;
		try {
			tr = await client.call<TranscriptView>("getConversation", run, id);
		} catch {
			return;
		}
		const from = shown.get(id) ?? 0;
		if (from === 0 && tr.items.length) out(C.dim(`${indent}── ${tr.role ?? "conversation"} ${id} ──`));
		for (const item of tr.items.slice(from)) {
			const s = renderItem(item, indent);
			if (s) out(s);
		}
		shown.set(id, tr.items.length);
		for (const h of tr.helpers) await showConversation(h, indent + "    ");
	};
	if (v.conversations.active) await showConversation(v.conversations.active);
	let rl: ReturnType<typeof lineReader> | undefined;
	let asking: string | undefined;
	const terminal = () => ["DELIVERED", "FAILED", "CANCELLED"].includes(v.state);
	const prompt = async () => {
		if (!opts.interactive || !v.pendingAsk || asking === v.pendingAsk.id) return;
		asking = v.pendingAsk.id;
		rl ??= lineReader("");
		const ask = v.pendingAsk;
		const answer = await rl.ask(C.yellow(`${renderQuestion(v)}\n> `));
		if (!answer) return;
		try {
			await respond(client, v, answer);
		} catch (e) {
			out(C.red(String((e as Error).message)));
			asking = undefined;
			if (v.pendingAsk?.id === ask.id) void prompt();
		}
	};
	let queue = Promise.resolve();
	const done = new Promise<void>((resolve) => {
		void client.subscribe({ run }, (e) => {
			queue = queue.then(async () => {
				if (e.type === "run.state") out(C.cyan(`● ${e.from ?? "∅"} → ${e.to}  (round ${e.round})`));
				else if (e.type === "run.notice") out(`${e.notice.level === "error" ? C.red("!") : e.notice.level === "warn" ? C.yellow("!") : "i"} ${e.notice.text}`);
				else if (e.type === "run.ask") out(C.yellow(`? ${e.question.kind}: ${e.question.kind === "discussion" ? e.question.text : e.question.kind === "approval" ? e.question.gate : e.question.reason}`));
				else if (e.type === "run.askResolved") out(C.dim(`  (answered by ${e.by})`));
				else if (e.type === "conversation.updated") await showConversation(e.conversationId, e.role === "helper" ? "    " : "");
				v = await client.call<RunView>("getRun", run);
				if (terminal()) {
					out(renderRun(v));
					resolve();
				} else void prompt();
			});
		});
	});
	if (terminal()) return v;
	void prompt();
	await done;
	rl?.close();
	return v;
}

export async function respond(client: Client, v: RunView, input: string) {
	const ask = v.pendingAsk;
	if (!ask) throw new Error("nothing is pending");
	const text = input.trim();
	if (ask.question.kind === "discussion") return client.call("answer", v.id, ask.id, text);
	if (ask.question.kind === "approval") {
		if (/^a(pprove)?$/i.test(text)) return client.call("approve", v.id, ask.question.gate);
		const m = /^r(eject)?\s+([\s\S]+)$/i.exec(text);
		if (m) return client.call("reject", v.id, ask.question.gate, m[2]);
		throw new Error('type "approve" or "reject <feedback>"');
	}
	if (/^accept$/i.test(text)) return client.call("resolveEscalation", v.id, ask.id, { accept: true });
	if (/^abort$/i.test(text)) return client.call("resolveEscalation", v.id, ask.id, { abort: true });
	const m = /^more\s+(\d+)$/i.exec(text);
	if (m) return client.call("resolveEscalation", v.id, ask.id, { moreRounds: Number(m[1]) });
	throw new Error('type "accept", "more <N>" or "abort"');
}

/** Line reader that works for TTYs and piped input alike (lines that arrive before a prompt are queued). */
export function lineReader(onEof = "q") {
	const rl = createInterface({ input: process.stdin, terminal: false });
	const queue: string[] = [];
	const waiting: ((l: string) => void)[] = [];
	let closed = false;
	rl.on("line", (l) => (waiting.length ? waiting.shift()!(l) : queue.push(l)));
	rl.on("close", () => {
		closed = true;
		for (const w of waiting.splice(0)) w(onEof);
	});
	return {
		ask(prompt: string): Promise<string> {
			process.stdout.write(prompt);
			if (queue.length) return Promise.resolve(queue.shift()!);
			if (closed) return Promise.resolve(onEof);
			return new Promise((r) => waiting.push(r));
		},
		close: () => rl.close(),
	};
}

// ------------------------------------------------------------------ settings
export function fieldAt(schema: Record<string, SettingField>, path: string): SettingField | undefined {
	let fields: Record<string, SettingField> | undefined = schema;
	let f: SettingField | undefined;
	for (const k of path.split(".")) {
		f = fields?.[k];
		if (!f) return undefined;
		fields = f.type === "object" ? f.fields : undefined;
	}
	return f;
}

/** Parse a CLI value according to the schema (YAML syntax for lists, e.g. '[spec, delivery, merge]'). */
export function parseValue(field: SettingField | undefined, raw: string): unknown {
	const v = YAML.parse(raw);
	if (!field) return v;
	if ((field.type === "string" || field.type === "secretRef" || field.type === "enum") && typeof v !== "string") return raw;
	if (field.type === "list" && typeof v === "string") return v.split(",").map((s) => s.trim()).filter(Boolean);
	return v;
}

export async function settingsMenu(client: Client, project: string | undefined) {
	const scope = project ? { project } : { global: true };
	const schema = await client.call<Record<string, SettingField>>("settingsSchema");
	const rl = lineReader();
	const ask = rl.ask;
	const groups: [string, string][] = [
		["policy", "Policy"],
		["roles", "Roles"],
		["stages", "Stages"],
		...(project ? [] : ([["storage", "Storage (global only)"]] as [string, string][])),
	];
	let path: string[] = [];
	for (;;) {
		const eff = await client.call<Record<string, { value: unknown; source: string }>>("getSettings", scope);
		console.log(C.bold(`\nSettings — ${project ? `project ${project}` : "global"}${path.length ? ` › ${path.join(" › ")}` : ""}`));
		let entries: [string, string][];
		if (path.length === 0) entries = groups;
		else {
			const f = fieldAt(schema, path.join("."));
			entries = f?.type === "object" ? Object.keys(f.fields).map((k) => [k, k] as [string, string]) : [];
		}
		entries.forEach(([key, label], i) => {
			const full = [...path, key].join(".");
			const f = fieldAt(schema, full);
			const e = eff[full];
			const val = f?.type === "object" ? C.dim("›") : `${JSON.stringify(e?.value)} ${C.dim(`(${e?.source ?? "default"})`)}`;
			console.log(`  ${i + 1}. ${label.padEnd(18)} ${val}${f && f.type !== "object" ? C.dim(`  — ${f.description}`) : ""}`);
		});
		const a = (await ask(`number, ${path.length ? "b = back, " : ""}q = quit: `)).trim();
		if (a === "q" || a === "") break;
		if (a === "b") {
			path.pop();
			continue;
		}
		const sel = entries[Number(a) - 1];
		if (!sel) continue;
		const full = [...path, sel[0]].join(".");
		const f = fieldAt(schema, full)!;
		if (f.type === "object") {
			path = [...path, sel[0]];
			continue;
		}
		const hint = f.type === "enum" ? ` (${f.values.join(" | ")})` : f.type === "list" ? " (e.g. [a, b])" : "";
		const nv = (await ask(`${full}${hint} — new value, "-" to unset${project ? " (inherit)" : ""}, empty to keep: `)).trim();
		if (!nv) continue;
		try {
			if (nv === "-") await client.call("unsetSetting", scope, full);
			else await client.call("setSetting", scope, full, parseValue(f, nv));
			console.log(C.green("saved"));
		} catch (e) {
			console.log(C.red(`rejected: ${(e as Error).message}`));
		}
	}
	rl.close();
}
