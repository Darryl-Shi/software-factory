// Interrupting agents, live cost and tool-call timing in the web UI (docs/specs/run-mv8t6vsz-pmy8.md §4 UI, §5, §6):
// tool rows with their duration, a running call's clock and Stop (stopToolCall), "queued" and "stopped after" rows,
// costs (recorded + live) that follow `cost.updated`, the Interrupt button, the paused chat box with Continue, and
// "Your turn" for a paused run. The page is loaded into a test DOM the way the browser loads it, with the core's HTTP
// operations and the event stream faked.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { JSDOM } from "jsdom";
import { describe, expect, test } from "vitest";

const require = createRequire(import.meta.url);
const UI = join(import.meta.dirname, "../src/web/ui");
const read = (f: string) => readFileSync(join(UI, f), "utf8");
const MARKED = readFileSync(join(dirname(require.resolve("marked")), "marked.umd.js"), "utf8");
const PURIFY = readFileSync(require.resolve("dompurify/dist/purify.min.js"), "utf8");

let seq = 0;
function run(state: string, extra: Record<string, unknown> = {}) {
	seq++;
	return {
		id: `run-${seq}`, project: "todo", repo: "o/todo", state, gate: undefined, round: 1,
		request: { source: "web", title: `Ticket ${seq}`, body: "" },
		conversations: { architect: "a1", builder: "b1", reviewers: [], qa: [], active: "b1" },
		reviewRound: 0, caps: { review: 3, ciFix: 3 }, ciFixes: 0, cost: [], liveCost: { usd: 0, totalTokens: 0, byRole: [] },
		history: [], notices: [], findingsLog: [], artifacts: {}, messages: [], advisory: [], acceptedBlocking: [],
		configHash: "h", piVersion: "1.1.0", specPath: "docs/specs/x.md", createdAt: 1000 + seq, updatedAt: 1000 + seq,
		...extra,
	};
}
function bundle(id: string, extra: Record<string, unknown> = {}) {
	return {
		id, project: "todo", repo: "o/todo", state: "REVIEWING", round: 1, members: [{ run: "run-x", title: "Member" }],
		conversations: { integrator: "i1", reviewers: [{ id: "rv1", seq: 1 }], qa: [], active: "rv1" },
		reviews: [{ seq: 1, round: 1 }], reviewRound: 1, caps: { review: 3, ciFix: 3 }, ciFixes: 0, cost: [], liveCost: { usd: 0, totalTokens: 0, byRole: [] },
		history: [], notices: [], messages: [], findingsLog: [], advisory: [], mergeMethod: "squash", createdAt: 5000, ...extra,
	};
}
/** A transcript: `calls` are tool calls of one assistant item; `results` their tool results; `running` the live round. */
function tx(cid: string, opts: { calls?: { id: string; name: string }[]; results?: Record<string, unknown>[]; running?: Record<string, unknown>[]; busy?: boolean; now?: number } = {}) {
	const items: Record<string, unknown>[] = [{ entryId: 1, role: "user", text: "Build it" }];
	if (opts.calls) items.push({ entryId: 2, role: "assistant", text: "", toolCalls: opts.calls.map((c) => ({ ...c, args: { command: "x" } })) });
	(opts.results ?? []).forEach((r, i) => items.push({ entryId: 10 + i, role: "tool", toolResult: { isError: false, text: "ok", ...r } }));
	return { conversationId: cid, items, helpers: [], busy: opts.busy ?? false, queued: [], running: opts.running ?? [], now: opts.now ?? Date.now() };
}

type Win = JSDOM["window"] & { eval(s: string): unknown; __calls: { op: string; args: unknown[] }[]; __emit(e: unknown): void };
type Handlers = Record<string, (args: unknown[]) => unknown>;
/** `handlers` answer operations (throw `{ code, message }` to refuse with a 409); every call is recorded in `w.__calls`. */
async function load(opts: { runs?: unknown[]; bundles?: unknown[]; discs?: unknown[]; handlers?: Handlers } = {}): Promise<Win> {
	const html = read("index.html");
	const body = html.slice(html.indexOf("<body>") + 6, html.indexOf("</body>"));
	const dom = new JSDOM(`<!doctype html><html><head></head><body>${body}</body></html>`, { url: "http://127.0.0.1:7317/", runScripts: "outside-only", pretendToBeVisual: true });
	const w = dom.window as unknown as Win;
	const results: Record<string, unknown> = { listProjects: [{ name: "todo", repo: "o/todo" }], listRuns: opts.runs ?? [], listDiscussions: opts.discs ?? [], listBundles: opts.bundles ?? [], listModels: [] };
	w.__calls = [];
	w.fetch = (async (url: string, init?: { body?: string }) => {
		const op = String(url).split("/").pop()!;
		const args = (init?.body ? JSON.parse(init.body).args : []) as unknown[];
		w.__calls.push({ op, args });
		const h = opts.handlers?.[op];
		if (h) {
			try { const result = h(args) ?? null; return { status: 200, json: async () => ({ ok: true, result }) }; }
			catch (e) { const err = e as { code: string; message: string }; return { status: 409, json: async () => ({ ok: false, code: err.code, error: err.message }) }; }
		}
		return { status: 200, json: async () => ({ ok: true, result: results[op] ?? null }) };
	}) as unknown as typeof fetch;
	const sources: { onmessage?: (m: { data: string }) => void }[] = [];
	w.EventSource = class { readyState = 1; onmessage?: (m: { data: string }) => void; constructor() { sources.push(this); } close() {} } as unknown as typeof EventSource;
	w.__emit = (e: unknown) => sources.forEach((s) => s.onmessage?.({ data: JSON.stringify(e) }));
	w.matchMedia = (() => ({ matches: true })) as unknown as typeof w.matchMedia; // reduced motion: no Web Animations needed
	w.eval(MARKED); w.eval(PURIFY);
	w.eval([read("markdown.js"), read("app.js"), read("discussions.js"), read("bundles.js"), "globalThis.__t = { ui, openRun, openBundle, openDiscussion, fmtDur, fmtClock };"].join("\n;"));
	await tick(30);
	return w;
}
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const $ = (w: Win, sel: string) => w.document.querySelector<HTMLElement>(sel);
const calls = (w: Win, op: string) => w.__calls.filter((c) => c.op === op);
const toasts = (w: Win) => [...w.document.querySelectorAll("#toasts .toast")].map((t) => t.textContent);
const row = (w: Win, callId: string) => w.document.querySelector<HTMLElement>(`#tx details[data-key="${callId}"]`);
async function openRun(w: Win, id: string) { w.eval(`__t.openRun(${JSON.stringify(id)}, null)`); await tick(80); }

describe("duration formatting", () => {
	test("< 1 s in ms, < 60 s with one decimal, then minutes and seconds, then hours and minutes", async () => {
		const w = await load();
		const f = (ms: number) => w.eval(`__t.fmtDur(${ms})`);
		expect([f(0), f(850), f(999), f(1000), f(12_400), f(59_900), f(60_000), f(185_000), f(3_599_000), f(3_720_000)])
			.toEqual(["0 ms", "850 ms", "999 ms", "1.0 s", "12.4 s", "59.9 s", "1m 00s", "3m 05s", "59m 59s", "1h 02m"]);
		expect(w.eval("__t.fmtClock(42_300)")).toBe("0:42");
		expect(w.eval("__t.fmtClock(3_725_000)")).toBe("1:02:05");
	});
});

describe("tool rows", () => {
	test("a finished row shows its duration next to its status (ok and failed)", async () => {
		const r = run("BUILDING");
		const t = tx("b1", { calls: [{ id: "c1", name: "bash" }, { id: "c2", name: "read" }, { id: "c3", name: "bash" }], results: [{ callId: "c1", name: "bash", durationMs: 850 }, { callId: "c2", name: "read", durationMs: 12_400, isError: true, text: "no such file" }, { callId: "c3", name: "bash", durationMs: 185_000 }] });
		const w = await load({ runs: [r], handlers: { getConversation: () => t, getRun: () => r } });
		await openRun(w, r.id);
		expect(row(w, "c1")!.querySelector(".s-more")!.textContent).toMatch(/details · 850 ms/);
		expect(row(w, "c2")!.querySelector(".s-more")!.textContent).toMatch(/failed · 12\.4 s/);
		expect(row(w, "c3")!.querySelector(".s-more")!.textContent).toMatch(/3m 05s/);
		expect(w.document.querySelector("#tx .s-stop")).toBeNull();
	});

	test("a running row counts up from startedAt (corrected for clock skew) and has Stop, which calls stopToolCall", async () => {
		const r = run("BUILDING");
		const serverNow = Date.now() + 1_000_000; // the server's clock runs 1000 s ahead of the browser's
		const t = tx("b1", { busy: true, now: serverNow, calls: [{ id: "c9", name: "bash" }], running: [{ callId: "c9", name: "bash", status: "running", startedAt: serverNow - 42_300 }] });
		const w = await load({ runs: [r], handlers: { getConversation: () => t, getRun: () => r, stopToolCall: () => null } });
		await openRun(w, r.id);
		const clock = () => row(w, "c9")!.querySelector(".s-clock")!.textContent!;
		expect(clock()).toMatch(/^0:4[12]$/);
		const first = Number(clock().split(":")[1]);
		await tick(1100);
		expect(Number(clock().split(":")[1])).toBeGreaterThan(first);
		// the live line under the chat box
		expect($(w, "#c-live")!.textContent).toMatch(/^Builder is running bash · 0:4\d$/);
		const stop = row(w, "c9")!.querySelector<HTMLButtonElement>(".s-stop")!;
		expect(stop.textContent).toContain("Stop");
		stop.click();
		await tick(30);
		expect(calls(w, "stopToolCall")).toEqual([{ op: "stopToolCall", args: [{ run: r.id, conversationId: "b1", callId: "c9" }] }]);
		expect((row(w, "c9") as HTMLDetailsElement).open).toBe(false); // the click doesn't toggle the row
	});

	test("bridge tools never get Stop; a pending call reads queued, without Stop", async () => {
		const r = run("BUILDING");
		const t = tx("b1", { busy: true, calls: [{ id: "d1", name: "report_done" }, { id: "d2", name: "bash" }], running: [{ callId: "d1", name: "report_done", status: "running", startedAt: Date.now() - 2000 }, { callId: "d2", name: "bash", status: "pending" }] });
		const w = await load({ runs: [r], handlers: { getConversation: () => t, getRun: () => r } });
		await openRun(w, r.id);
		expect(row(w, "d1")!.querySelector(".s-more")!.textContent).toMatch(/running/);
		expect(row(w, "d1")!.querySelector(".s-stop")).toBeNull();
		expect(row(w, "d2")!.querySelector(".s-more")!.textContent).toBe("queued");
		expect(row(w, "d2")!.querySelector(".s-stop")).toBeNull();
	});

	test("a stopped (aborted) call reads 'stopped after <duration>'", async () => {
		const r = run("BUILDING");
		const t = tx("b1", { calls: [{ id: "s1", name: "bash" }], results: [{ callId: "s1", name: "bash", isError: true, text: "Tool bash was aborted", durationMs: 7_200 }] });
		const w = await load({ runs: [r], handlers: { getConversation: () => t, getRun: () => r } });
		await openRun(w, r.id);
		expect(row(w, "s1")!.querySelector(".s-more")!.textContent).toMatch(/^stopped after 7\.2 s/);
	});

	test("a refused Stop shows the error toast and leaves the row as it was", async () => {
		const r = run("BUILDING");
		const t = tx("b1", { busy: true, calls: [{ id: "c1", name: "bash" }], running: [{ callId: "c1", name: "bash", status: "running", startedAt: Date.now() - 1000 }] });
		const w = await load({ runs: [r], handlers: { getConversation: () => t, getRun: () => r, stopToolCall: () => { throw { code: "conflict", message: "tool call c1 is not running" }; } } });
		await openRun(w, r.id);
		row(w, "c1")!.querySelector<HTMLButtonElement>(".s-stop")!.click();
		await tick(30);
		expect(toasts(w).join(" ")).toContain("tool call c1 is not running (conflict)");
		const stop = row(w, "c1")!.querySelector<HTMLButtonElement>(".s-stop")!;
		expect(stop.disabled).toBe(false);
		expect(stop.textContent).toContain("Stop");
	});

	test("discussions: a running tool has the per-tool Stop (stopToolCall with the discussion), and Stop still ends the turn", async () => {
		const d = { id: "disc-1", project: "todo", repo: "o/todo", title: "Chat", state: "OPEN", turn: { kind: "reply" }, model: { model: "p/m", thinking: "low" }, conversationId: "dc1", drafts: [], turnCosts: [], notices: [], runs: [], cost: { usd: 1, totalTokens: 10 }, liveCost: { usd: 0.25, totalTokens: 5 }, createdAt: 1000, updatedAt: 2000 };
		const t = tx("dc1", { busy: true, calls: [{ id: "w1", name: "web_search" }], running: [{ callId: "w1", name: "web_search", status: "running", startedAt: Date.now() - 5000 }] });
		const w = await load({ discs: [d], handlers: { getDiscussion: () => d, getDiscussionConversation: () => t, stopToolCall: () => null, stopTurn: () => null } });
		w.eval(`__t.openDiscussion("disc-1", null)`);
		await tick(80);
		expect($(w, "#rv-cost")!.textContent).toBe("$1.25");
		expect($(w, "#dc-live")!.textContent).toMatch(/^Discussant is running web_search · 0:0[45]$/);
		row(w, "w1")!.querySelector<HTMLButtonElement>(".s-stop")!.click();
		await tick(30);
		expect(calls(w, "stopToolCall")[0]!.args).toEqual([{ discussion: "disc-1", conversationId: "dc1", callId: "w1" }]);
		($(w, "#dc-send") as HTMLButtonElement).click();
		await tick(30);
		expect(calls(w, "stopTurn")[0]!.args).toEqual(["disc-1"]);
		// cost.updated moves the header and the KPI
		w.__emit({ type: "cost.updated", project: "todo", discussion: "disc-1", usd: 1.6, totalTokens: 40 });
		await tick();
		expect($(w, "#rv-cost")!.textContent).toBe("$1.60");
	});
});

describe("live cost", () => {
	test("board cards show recorded + live and follow cost.updated in place; the run header and cost table match", async () => {
		const r = run("BUILDING", { cost: [{ role: "builder", round: 1, usd: 1, totalTokens: 1000, conversationId: "b1", model: "m", thinking: "low" }], liveCost: { usd: 0.5, totalTokens: 500, byRole: [{ role: "builder", conversationId: "b1", usd: 0.5, totalTokens: 500 }] } });
		const b = bundle("bundle-1", { cost: [{ role: "reviewer", round: 1, usd: 2 }], liveCost: { usd: 0.1, totalTokens: 10, byRole: [] } });
		let current: Record<string, unknown> = r;
		const w = await load({ runs: [r], bundles: [b], handlers: { getRun: () => current, getConversation: () => tx("b1", { busy: true }), getBundle: () => b } });
		const cardCost = (id: string) => w.document.querySelector(`.card[data-id="${id}"] .card-cost`)!.textContent;
		expect(cardCost(r.id)).toBe("$1.50");
		expect(cardCost("bundle-1")).toBe("$2.10");
		const card = w.document.querySelector(`.card[data-id="${r.id}"]`);
		w.__emit({ type: "cost.updated", project: "todo", run: r.id, usd: 1.75, totalTokens: 1700 });
		w.__emit({ type: "cost.updated", project: "todo", bundle: "bundle-1", usd: 2.4, totalTokens: 50 });
		await tick();
		expect(cardCost(r.id)).toBe("$1.75");
		expect(cardCost("bundle-1")).toBe("$2.40");
		expect(w.document.querySelector(`.card[data-id="${r.id}"]`)).toBe(card); // updated in place, not redrawn
		// the run view: header, KPI and the cost-by-role table with its "in progress" row
		current = { ...r, liveCost: { usd: 0.75, totalTokens: 700, byRole: [{ role: "builder", conversationId: "b1", usd: 0.75, totalTokens: 700 }] } };
		await openRun(w, r.id);
		expect($(w, "#rv-cost")!.textContent).toBe("$1.75");
		const total = () => w.document.querySelector("#rv-details-inner table.cost tr.total td:last-child")!.textContent;
		expect(w.document.querySelector("#rv-details-inner tr.live-cost")!.textContent).toMatch(/Builder · in progress.*\$0\.75/);
		expect(total()).toBe("$1.75");
		const txBefore = w.document.querySelector("#tx .blk");
		current = { ...r, liveCost: { usd: 1.2, totalTokens: 900, byRole: [{ role: "builder", conversationId: "b1", usd: 1.2, totalTokens: 900 }] } };
		w.__emit({ type: "cost.updated", project: "todo", run: r.id, usd: 2.2, totalTokens: 1900 });
		await tick();
		expect($(w, "#rv-cost")!.textContent).toBe("$2.20");
		expect(w.document.querySelector("#rv-details-inner .kpi-cost")!.textContent).toBe("$2.20");
		await tick(250); // the refetch for the table
		expect(total()).toBe("$2.20");
		expect(w.document.querySelector("#tx .blk")).toBe(txBefore); // the transcript was not redrawn
	});
});

describe("interrupt", () => {
	test("Interrupt calls interruptAgent; the paused chat box offers Continue, which sends 'Continue.'", async () => {
		let r: Record<string, unknown> = run("BUILDING");
		const id = r.id as string;
		const w = await load({
			runs: [r],
			handlers: {
				getRun: () => r,
				getConversation: () => tx("b1", { busy: !r.interrupted }),
				interruptAgent: () => { r = { ...r, interrupted: { role: "builder", conversationId: "b1", key: "build:1", at: 1, by: "web" } }; return null; },
				message: () => ({ message: "m1", to: "builder", conversationId: "b1" }),
			},
		});
		await openRun(w, id);
		const int = $(w, "#chat-int") as HTMLButtonElement;
		expect(int.hidden).toBe(false);
		expect(int.textContent).toContain("Interrupt");
		expect(int.parentElement!.id).toBe("chat-form"); // next to Send
		int.click();
		await tick(150);
		expect(calls(w, "interruptAgent")[0]!.args).toEqual([id]);
		expect($(w, "#composer")!.textContent).toContain("Builder is paused. Send a message to continue");
		expect(($(w, "#chat-int") as HTMLButtonElement).hidden).toBe(true);
		expect($(w, "#c-hint")!.textContent).toBe("Your message resumes the builder right away");
		// Your turn on the board
		const card = w.document.querySelector(`.card[data-id="${id}"]`)!;
		expect(card.classList.contains("turn")).toBe(true);
		expect(card.querySelector(".turn-badge")!.textContent).toBe("Your turn · paused");
		($(w, "#c-continue") as HTMLButtonElement).click();
		await tick(50);
		expect(calls(w, "message")[0]!.args).toEqual([id, "Continue."]);
	});

	test("a message waiting for a paused agent isn't shown as queued until the current step", async () => {
		const r = run("BUILDING", { interrupted: { role: "builder", conversationId: "b1", key: "k", at: 1, by: "web" } });
		const t = { ...tx("b1"), queued: [{ msgId: "m1", by: "web", text: "Use sqlite instead" }] };
		const w = await load({ runs: [r], handlers: { getRun: () => r, getConversation: () => t } });
		await openRun(w, r.id);
		const bubble = w.document.querySelector('#tx .blk[data-k="msg:m1"]')!;
		expect(bubble.classList.contains("queued")).toBe(false);
		expect(bubble.textContent).not.toContain("queued until");
		expect(bubble.textContent).toContain("resuming the builder");
	});

	test("a refused interrupt shows the error toast and changes nothing", async () => {
		const r = run("BUILDING");
		const w = await load({ runs: [r], handlers: { getRun: () => r, getConversation: () => tx("b1", { busy: true }), interruptAgent: () => { throw { code: "conflict", message: "builder is not working" }; } } });
		await openRun(w, r.id);
		($(w, "#chat-int") as HTMLButtonElement).click();
		await tick(100);
		expect(toasts(w).join(" ")).toContain("builder is not working (conflict)");
		expect($(w, "#composer")!.textContent).not.toContain("is paused");
		expect(($(w, "#chat-int") as HTMLButtonElement).hidden).toBe(false);
	});

	test("no Interrupt while the target is idle, or when its role isn't in the pinned policy.messages", async () => {
		const idle = run("BUILDING"), barred = run("BUILDING", { policy: { messages: ["architect"] } });
		const w = await load({ runs: [idle], handlers: { getRun: () => idle, getConversation: () => tx("b1", { busy: false }) } });
		await openRun(w, idle.id);
		expect(($(w, "#chat-int") as HTMLButtonElement).hidden).toBe(true);
		const w2 = await load({ runs: [barred], handlers: { getRun: () => barred, getConversation: () => tx("b1", { busy: true }) } });
		await openRun(w2, barred.id);
		expect($(w2, "#c-live")!.textContent).toContain("Builder is working");
		expect(($(w2, "#chat-int") as HTMLButtonElement).hidden).toBe(true);
	});

	test("bundle: Interrupt calls interruptBundleAgent; Continue sends 'Continue.' through messageBundle; the card is Your turn", async () => {
		let b: Record<string, unknown> = bundle("bundle-1");
		const w = await load({
			bundles: [b],
			handlers: {
				getBundle: () => b,
				getBundleConversation: () => tx("rv1", { busy: !b.interrupted }),
				interruptBundleAgent: () => { b = { ...b, interrupted: { role: "reviewer", conversationId: "rv1", key: "review:1", at: 1, by: "web" } }; return null; },
				messageBundle: () => ({ message: "m1", to: "reviewer", conversationId: "rv1" }),
			},
		});
		w.eval(`__t.openBundle("bundle-1", null)`);
		await tick(80);
		($(w, "#bc-int") as HTMLButtonElement).click();
		await tick(150);
		expect(calls(w, "interruptBundleAgent")[0]!.args).toEqual(["bundle-1"]);
		expect($(w, "#composer")!.textContent).toContain("Reviewer is paused. Send a message to continue");
		expect(w.document.querySelector('.card[data-id="bundle-1"] .turn-badge')!.textContent).toBe("Your turn · paused");
		($(w, "#bc-continue") as HTMLButtonElement).click();
		await tick(50);
		expect(calls(w, "messageBundle")[0]!.args).toEqual(["bundle-1", "Continue."]);
	});
});

describe("board: Your turn", () => {
	test("an interrupted run counts as Your turn: badge, first in its column, the Your turn filter and count", async () => {
		const other = run("BUILDING", { createdAt: 1 });
		const paused = run("BUILDING", { interrupted: { role: "builder", conversationId: "b1", key: "k", at: 1, by: "web" } });
		const w = await load({ runs: [other, paused] });
		const ids = () => [...w.document.querySelectorAll<HTMLElement>('#board .col[data-col="build"] .card')].map((c) => c.dataset.id);
		expect(ids()).toEqual([paused.id, other.id]);
		expect(w.document.querySelector(`.card[data-id="${paused.id}"] .turn-badge`)!.textContent).toBe("Your turn · paused");
		expect($(w, "#n-turn")!.textContent).toBe("1");
		$(w, "#f-turn")!.click();
		await tick();
		expect(ids()).toEqual([paused.id]);
	});
});
