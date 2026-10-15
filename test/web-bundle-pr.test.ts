// The bundle view's Check PR now (src/web/ui/bundles.js): shown next to the PR link while the bundle has a PR and is not
// Merged or Cancelled (Failed and Escalated included); it calls checkBundlePr and says what GitHub reported. The page is
// loaded into a test DOM the way the browser loads it, with the core's HTTP operations answered by a stub.
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

function run(id: string, state: string, extra: Record<string, unknown> = {}) {
	return {
		id, project: "todo", repo: "o/todo", state, gate: undefined, round: 1,
		request: { source: "web", title: `Ticket ${id}`, body: "" },
		conversations: { architect: null, builder: null, reviewers: [], qa: [], active: null },
		reviewRound: 0, caps: { review: 3, ciFix: 3 }, ciFixes: 0, cost: [], liveCost: { usd: 0, totalTokens: 0, byRole: [] },
		history: [], notices: [], findingsLog: [], artifacts: {}, messages: [], advisory: [], acceptedBlocking: [],
		messageRoles: ["architect", "builder", "reviewer"], specPath: "docs/specs/run-1.md", createdAt: 1000, updatedAt: 1000, ...extra,
	};
}
const PR = { kind: "pr", url: "https://github.com/o/todo/pull/12", pr: { number: 12 }, sha: "abc" };
function bundle(state: string, extra: Record<string, unknown> = {}) {
	return {
		id: "bundle-1", project: "todo", repo: "o/todo", state, round: 1, members: [{ run: "run-1", title: "One", key: "TODO-1", specPath: "docs/specs/run-1.md", branch: "factory/run-1" }],
		conversations: { integrator: "i1", reviewers: [], qa: [], active: "i1" }, reviews: [], reviewRound: 0, caps: { review: 3, ciFix: 3 }, ciFixes: 0,
		cost: [], liveCost: { usd: 0, totalTokens: 0, byRole: [] }, history: [], notices: [], messages: [], findingsLog: [], advisory: [],
		mergeMethod: "squash", messageRoles: ["integrator", "reviewer"], createdAt: 5000, delivery: PR, ...extra,
	};
}

type Win = JSDOM["window"] & { eval(s: string): unknown; __calls: { op: string; args: unknown[] }[]; __emit(e: unknown): void };
type Handlers = Record<string, (args: unknown[]) => unknown>;
async function load(b: Record<string, unknown>, handlers: Handlers = {}): Promise<Win> {
	const html = read("index.html");
	const body = html.slice(html.indexOf("<body>") + 6, html.indexOf("</body>"));
	const dom = new JSDOM(`<!doctype html><html><head></head><body>${body}</body></html>`, { url: "http://127.0.0.1:7317/", runScripts: "outside-only", pretendToBeVisual: true });
	const w = dom.window as unknown as Win;
	const results: Record<string, unknown> = { listProjects: [{ name: "todo", repo: "o/todo" }], listRuns: [run("run-1", "READY", { bundle: "bundle-1" })], getRun: run("run-1", "READY", { bundle: "bundle-1" }), listDiscussions: [], listBundles: [b], getBundle: b, listModels: [],
		getBundleConversation: { conversationId: "i1", items: [{ entryId: 1, role: "user", text: "Integrate" }], helpers: [], busy: false, queued: [], running: [], now: Date.now() } };
	w.__calls = [];
	(w as unknown as { fetch: unknown }).fetch = async (url: string, init?: { body?: string }) => {
		const op = String(url).split("/").pop()!;
		const args = (init?.body ? JSON.parse(init.body).args : []) as unknown[];
		w.__calls.push({ op, args });
		if (handlers[op]) {
			try { const result = handlers[op]!(args) ?? null; return { status: 200, json: async () => ({ ok: true, result }) }; }
			catch (e) { const err = e as { code: string; message: string }; return { status: 409, json: async () => ({ ok: false, code: err.code, error: err.message }) }; }
		}
		return { status: 200, json: async () => ({ ok: true, result: results[op] ?? null }) };
	};
	const sources: { onmessage?: (m: { data: string }) => void }[] = [];
	(w as unknown as { EventSource: unknown }).EventSource = class { readyState = 1; onmessage?: (m: { data: string }) => void; constructor() { sources.push(this); } close() {} };
	w.__emit = (e: unknown) => sources.forEach((s) => s.onmessage?.({ data: JSON.stringify(e) }));
	(w as unknown as { matchMedia: unknown }).matchMedia = () => ({ matches: true });
	w.eval(MARKED); w.eval(PURIFY);
	w.eval([read("markdown.js"), read("app.js"), read("discussions.js"), read("bundles.js"), "globalThis.__t = { ui, renderBundleView };"].join("\n;"));
	await new Promise((r) => setTimeout(r, 30));
	w.eval(`openBundle("bundle-1", null)`);
	await new Promise((r) => setTimeout(r, 30));
	return w;
}
const btn = (w: Win) => w.document.querySelector<HTMLButtonElement>("#rv-check-pr");
const toasts = (w: Win) => [...w.document.querySelectorAll(".toast")].map((t) => t.textContent);
const settle = () => new Promise((r) => setTimeout(r, 120));

describe("bundle view: Check PR now", () => {
	test("shown while the bundle has a PR and is not Merged or Cancelled (Failed and Escalated included)", async () => {
		for (const st of ["AWAITING_CI", "ESCALATED", "FAILED", "FIXING", "AWAITING_MERGE"]) {
			const w = await load(bundle(st));
			expect(w.document.getElementById("runview")!.hidden, st).toBe(false);
			expect(btn(w), st).not.toBeNull();
			expect(btn(w)!.textContent).toBe("Check PR now");
			expect(w.document.querySelector("#rv-links a")!.textContent).toBe("PR #12");
			// Cancel bundle is still there
			expect(w.document.querySelector("#rv-cancel-bundle"), st).not.toBeNull();
		}
		for (const st of ["MERGED", "CANCELLED"]) expect(btn(await load(bundle(st))), st).toBeNull();
		// no PR yet, or a push to main: no button
		expect(btn(await load(bundle("INTEGRATING", { delivery: undefined })))).toBeNull();
		expect(btn(await load(bundle("FAILED", { delivery: { kind: "push", url: "https://github.com/o/todo" } })))).toBeNull();
	});

	test("open: 'still open', nothing changes", async () => {
		const w = await load(bundle("ESCALATED"), { checkBundlePr: () => ({ pr: "open", state: "ESCALATED" }) });
		btn(w)!.click(); await settle();
		const calls = w.__calls.filter((c) => c.op === "checkBundlePr");
		expect(calls).toEqual([{ op: "checkBundlePr", args: ["bundle-1"] }]);
		expect(toasts(w)).toContain("PR #12 is still open");
		expect(btn(w)).not.toBeNull();
	});

	test("merged: says so; the view follows the bundle to Merged and the button goes", async () => {
		let b = bundle("ESCALATED");
		const w = await load(b, {
			checkBundlePr: () => { b = bundle("MERGED"); return { pr: "merged", state: "MERGED" }; },
			getBundle: () => b,
		});
		btn(w)!.click(); await settle();
		expect(toasts(w)).toContain("PR #12 was merged on GitHub — the bundle is Merged");
		expect(btn(w)).toBeNull();
		expect(w.document.querySelector("#rv-progress .rv-stage")!.textContent).toBe("Merged");
	});

	test("the view follows bundle.state live: a bundle that goes FAILED keeps the button; MERGED drops it", async () => {
		let b = bundle("FIXING");
		const w = await load(b, { getBundle: () => b });
		expect(btn(w)).not.toBeNull();
		b = bundle("FAILED");
		w.__emit({ type: "bundle.state", project: "todo", bundle: "bundle-1", from: "FIXING", to: "FAILED", at: 1 });
		await settle();
		expect(btn(w)).not.toBeNull();
		b = bundle("MERGED");
		w.__emit({ type: "bundle.state", project: "todo", bundle: "bundle-1", from: "FAILED", to: "MERGED", at: 2 });
		await settle();
		expect(btn(w)).toBeNull();
		expect(w.document.querySelector("#rv-progress .rv-stage")!.textContent).toBe("Merged");
	});

	test("closed: the tickets are back in Ready; a refusal shows the error", async () => {
		const w = await load(bundle("FAILED"), { checkBundlePr: () => ({ pr: "closed", state: "CANCELLED" }) });
		btn(w)!.click(); await settle();
		expect(toasts(w)).toContain("PR #12 was closed — the tickets are back in Ready");
		const w2 = await load(bundle("FAILED"), { checkBundlePr: () => { throw { code: "conflict", message: "bundle-1 has no PR" }; } });
		btn(w2)!.click(); await settle();
		expect(w2.document.querySelector(".toast.error")!.textContent).toContain("bundle-1 has no PR");
		expect(btn(w2)!.disabled).toBe(false);
	});
});
