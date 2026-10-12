// The board (src/web/ui/app.js): five columns, plain-language hints with a per-stage breakdown, ordering inside a
// column, bundles in Shipping, and the run view's fine-grained stage kept apart from the board column. The page is
// loaded into a test DOM the way the browser loads it (index.html's body, then the classic scripts in order), with
// the core's HTTP operations answered by a stub.
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
		conversations: { architect: null, builder: null, reviewers: [], qa: [], active: null },
		reviewRound: 0, caps: { review: 3, ciFix: 3 }, ciFixes: 0, cost: [], history: [], notices: [], findingsLog: [], artifacts: {},
		createdAt: 1000 + seq, updatedAt: 1000 + seq,
		...extra,
	};
}
function bundle(id: string, members: { run: string; title: string }[], extra: Record<string, unknown> = {}) {
	return {
		id, project: "todo", state: "AWAITING_CI", members, conversations: { integrator: null, reviewers: [], qa: [], active: null },
		reviews: [], reviewRound: 0, caps: { review: 3, ciFix: 3 }, ciFixes: 0, cost: [], createdAt: 5000, ...extra,
	};
}

type Win = JSDOM["window"] & { eval(s: string): unknown };
type Handlers = Record<string, (args: unknown[]) => unknown>;
/** `handlers` answer (or, by throwing { code, message }, refuse) operations; every call is recorded in `w.__calls`. */
async function load(runs: unknown[], bundles: unknown[] = [], handlers: Handlers = {}): Promise<Win> {
	const html = read("index.html");
	const body = html.slice(html.indexOf("<body>") + 6, html.indexOf("</body>"));
	const dom = new JSDOM(`<!doctype html><html><head></head><body>${body}</body></html>`, { url: "http://127.0.0.1:7317/", runScripts: "outside-only", pretendToBeVisual: true });
	const w = dom.window as unknown as Win & Record<string, unknown>;
	const results: Record<string, unknown> = { listProjects: [{ name: "todo", repo: "o/todo" }], listRuns: runs, listDiscussions: [], listBundles: bundles };
	const calls: { op: string; args: unknown[] }[] = [];
	(w as Record<string, unknown>).__calls = calls;
	w.fetch = (async (url: string, init?: { body?: string }) => {
		const op = String(url).split("/").pop()!;
		const args = (init?.body ? JSON.parse(init.body).args : []) as unknown[];
		calls.push({ op, args });
		if (handlers[op]) {
			try { const result = handlers[op]!(args) ?? null; return { status: 200, json: async () => ({ ok: true, result }) }; }
			catch (e) { const err = e as { code: string; message: string }; return { status: 409, json: async () => ({ ok: false, code: err.code, error: err.message }) }; }
		}
		return { status: 200, json: async () => ({ ok: true, result: results[op] ?? null }) };
	}) as unknown as typeof fetch;
	w.EventSource = class { readyState = 1; close() {} } as unknown;
	w.matchMedia = (() => ({ matches: true })) as unknown as typeof w.matchMedia; // reduced motion: no Web Animations needed
	w.eval(MARKED); w.eval(PURIFY);
	// the classic scripts share one global scope: evaluated together, with the functions under test exposed
	w.eval([read("markdown.js"), read("app.js"), read("discussions.js"), read("bundles.js"), "globalThis.__t = { PIPELINE, stageOf, stageInfo, boardColumn, ui, qaText, renderBoard, renderProjectFilter };"].join("\n;"));
	await new Promise((r) => setTimeout(r, 30));
	return w;
}
const cols = (w: Win) => [...w.document.querySelectorAll<HTMLElement>("#board .col")];
const col = (w: Win, key: string) => w.document.querySelector<HTMLElement>(`#board .col[data-col="${key}"]`)!;
const cardIds = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>(".col-body > .card, .col-body > .ship-wrap > .card")].map((c) => c.dataset.id);

describe("board: five columns", () => {
	test("exactly five columns in order, each with a plain-language hint and the raw states as its tooltip", async () => {
		const w = await load([]);
		expect(cols(w).map((c) => c.dataset.col)).toEqual(["planning", "build", "ready", "shipping", "done"]);
		expect(cols(w).map((c) => c.querySelector(".col-name")!.textContent)).toEqual(["Planning", "Build & Review", "Ready", "Shipping", "Done"]);
		const hints = cols(w).map((c) => c.querySelector(".col-hint")!);
		expect(hints.map((h) => h.textContent)).toEqual(["Specifying with the architect", "Being built and reviewed", "Reviewed. Tick tickets of one project, then Ship", "Bundles, PRs and CI", "Merged"]);
		expect(hints[0]!.getAttribute("title")).toContain("RECEIVED");
		expect(w.document.querySelector(".col-states")).toBeNull();
		expect(col(w, "planning").querySelector(".col-empty")!.innerHTML).toBe("Press <b>Create</b> to submit your first ticket");
		expect(col(w, "ready").querySelector(".col-empty")!.textContent).toBe("Reviewed tickets wait here to ship");
	});

	test("runs land in the column of their state", async () => {
		const ask = { question: { kind: "approval", gate: "spec" } };
		const r = {
			received: run("RECEIVED"), preparing: run("PREPARING"), discussing: run("DISCUSSING"), specReady: run("SPEC_READY"),
			specGate: run("AWAITING_APPROVAL", { gate: "spec", pendingAsk: ask }),
			building: run("BUILDING"), reviewing: run("REVIEWING"), escB: run("ESCALATED", { escalation: { from: "BUILDING" } }), escNone: run("ESCALATED"),
			ready: run("READY"), deliveryGate: run("AWAITING_APPROVAL", { gate: "delivery" }), delivering: run("DELIVERING"), ci: run("AWAITING_CI"),
			escCi: run("ESCALATED", { escalation: { from: "AWAITING_CI" } }), done: run("DELIVERED"), failed: run("FAILED"), cancelled: run("CANCELLED"),
		};
		const w = await load(Object.values(r));
		const where = (x: { id: string }) => w.document.querySelector<HTMLElement>(`.card[data-id="${x.id}"]`)?.closest<HTMLElement>(".col")?.dataset.col;
		for (const k of ["received", "preparing", "discussing", "specReady", "specGate"] as const) expect(where(r[k]), k).toBe("planning");
		for (const k of ["building", "reviewing", "escB", "escNone"] as const) expect(where(r[k]), k).toBe("build");
		expect(where(r.ready)).toBe("ready");
		for (const k of ["deliveryGate", "delivering", "ci", "escCi"] as const) expect(where(r[k]), k).toBe("shipping");
		expect(where(r.done)).toBe("done");
		// failed and cancelled only with Show closed
		expect(where(r.failed)).toBeUndefined();
		w.document.getElementById("f-closed")!.click();
		await new Promise((res) => setTimeout(res, 10));
		expect(where(r.failed)).toBe("done");
		expect(where(r.cancelled)).toBe("done");
		expect(col(w, "done").querySelector(".col-hint span")!.textContent).toBe("Merged, failed or cancelled");
		// the spec gate keeps its lozenge and "Your turn" badge
		const gate = w.document.querySelector(`.card[data-id="${r.specGate.id}"]`)!;
		expect(gate.querySelector(".lozenge")!.textContent).toBe("spec approval");
		expect(gate.querySelector(".turn-badge")!.textContent).toContain("Your turn");
	});

	test("Planning: per-stage breakdown, Your turn first, then pipeline order, oldest first", async () => {
		const spec = run("AWAITING_APPROVAL", { gate: "spec", pendingAsk: { question: { kind: "approval", gate: "spec" } } });
		const d2 = run("DISCUSSING"), d1 = run("DISCUSSING", { createdAt: 10 }), rec = run("RECEIVED");
		const w = await load([d2, spec, rec, d1]);
		const p = col(w, "planning");
		expect(p.querySelector(".col-break")!.textContent).toBe("1 received · 2 discussing · 1 spec approval");
		expect(cardIds(p)).toEqual([spec.id, rec.id, d1.id, d2.id]);
		// a column of one stage has no breakdown
		const w2 = await load([run("DISCUSSING"), run("DISCUSSING")]);
		expect(col(w2, "planning").querySelector(".col-break")).toBeNull();
	});

	test("Shipping holds bundles (with their Ready members inside) before plain run cards; Done shows the bundle chip", async () => {
		const a = run("READY", { bundle: "bundle-1" }), b = run("READY", { bundle: "bundle-1" }), legacy = run("AWAITING_CI");
		const merged = run("DELIVERED", { bundle: "bundle-0" });
		const w = await load([a, b, legacy, merged], [bundle("bundle-1", [{ run: a.id, title: "A very long member title ".repeat(6) }, { run: b.id, title: "Second" }]), bundle("bundle-0", [{ run: merged.id, title: "x" }], { state: "MERGED" })]);
		const s = col(w, "shipping");
		expect(cardIds(s)).toEqual(["bundle-1", legacy.id]);
		expect(s.querySelector(".col-break")!.textContent).toBe("1 bundle · 1 awaiting CI");
		expect(s.querySelectorAll(".bmember").length).toBe(2);
		expect(s.querySelector(".bm-title")!.getAttribute("title")).toContain("A very long member title");
		expect(col(w, "ready").querySelector(".card")).toBeNull();
		expect(col(w, "done").querySelector(".bchip")!.textContent).toBe("bundle-0");
	});

	test("Ready: ticks, the one-project rule and Ship N tickets in the header", async () => {
		const x = run("READY"), y = run("READY"), other = run("READY", { project: "other", repo: "o/other" });
		const w = await load([x, y, other]);
		const tick = (id: string) => w.document.querySelector<HTMLInputElement>(`input[data-ship="${id}"]`)!;
		tick(x.id).click(); tick(y.id).click();
		await new Promise((res) => setTimeout(res, 10));
		expect(tick(other.id).disabled).toBe(true);
		expect(col(w, "ready").querySelector("[data-ship-go]")!.textContent).toBe("Ship 2 tickets");
	});

	test("cards carry tooltips for truncated tokens and the full title; the footer has a left and a right side", async () => {
		const long = run("BUILDING", { project: "a-really-long-project-name-that-will-not-fit", request: { source: "web", title: "T".repeat(300), body: "" }, cost: [{ usd: 1.5 }], conversations: { architect: null, builder: "c1", reviewers: [{ id: "r1", seq: 1 }], qa: [], active: "c1" }, reviewRound: 1, qaStatus: "ran" });
		const w = await load([long]);
		const card = w.document.querySelector<HTMLElement>(`.card[data-id="${long.id}"]`)!;
		expect(card.getAttribute("title")).toBe("T".repeat(300));
		expect(card.querySelector(".pchip")!.getAttribute("title")).toBe(long.project);
		expect(card.querySelector(".foot-l .key")!.getAttribute("title")).toBeTruthy();
		expect(card.querySelector(".foot-r .meta")!.textContent).toContain("$1.50");
		expect(card.querySelector(".foot-r .avatar")).not.toBeNull();
	});

	test("the run view keeps the eight fine-grained stages, apart from the board column", async () => {
		const failed = run("FAILED", { history: [{ from: "RECEIVED", to: "BUILDING", at: 1, round: 1 }, { from: "BUILDING", to: "FAILED", at: 2, round: 1 }] });
		const gate = run("AWAITING_APPROVAL", { gate: "spec" });
		const w = await load([failed, gate]);
		expect(w.eval("__t.PIPELINE.map(([, n]) => n)")).toEqual(["Intake", "Discussion", "Spec approval", "Build", "Review", "Ready", "Deliver", "Done"]);
		expect(w.eval(`[__t.stageOf(__t.ui.runs.get("${failed.id}")), __t.stageInfo(__t.ui.runs.get("${failed.id}")).name]`)).toEqual(["build", "Build"]);
		expect(w.eval(`[__t.stageOf(__t.ui.runs.get("${gate.id}")), __t.boardColumn(__t.ui.runs.get("${gate.id}"))]`)).toEqual(["spec", "planning"]);
	});
});

describe("stylesheet: sizing rules", () => {
	const css = read("app.css");
	test("columns grow from a comfortable minimum to a maximum; the board scrolls sideways with proximity snapping", () => {
		expect(css).toMatch(/--col-min:\s*272px/);
		expect(css).toMatch(/--col-max:\s*440px/);
		expect(css).toMatch(/\.col \{[^}]*flex: 1 0 var\(--col-min\)[^}]*max-width: var\(--col-max\)/);
		expect(css).toMatch(/\.board \{[^}]*overflow-x: auto[^}]*scroll-snap-type: x proximity/);
		expect(css).toMatch(/min\(85vw, 360px\)/);
	});
	test("one set of breakpoints: phone 640, tablet 1024, wide 1600 (plus the run view's 1180 and 760)", () => {
		const widths = new Set([...css.matchAll(/@media \((?:max|min)-width: (\d+)px\)/g)].map((m) => m[1]));
		expect([...widths].sort()).toEqual(["1024", "1180", "1600", "640", "760"].sort());
	});
	test("a long approval or escalation card scrolls inside itself and keeps its action buttons reachable", () => {
		expect(css).toMatch(/\.dock \{[^}]*max-height: calc\(100% - 28px\)[^}]*display: flex; flex-direction: column/);
		expect(css).toMatch(/\.dock-card \{[^}]*min-height: 0; overflow-y: auto/);
		expect(css).toMatch(/\.dock \.c-actions \{[^}]*position: sticky; bottom: 0/);
		expect(css).toMatch(/\.modal-foot \{[^}]*position: sticky; bottom: 0/);
	});
});

describe("bundle QA/review text (qaText)", () => {
	test("'Not reviewed: clean merge' only for a clean one-ticket integration; a 2+ bundle shows the review to come, then its QA status", async () => {
		const w = await load([]);
		const qaText = (w.eval("__t") as { qaText: (b: unknown) => string }).qaText;
		const one = [{ run: "run-a", title: "a" }];
		const two = [...one, { run: "run-b", title: "b" }];
		const clean = { n: 1, base: "abc", resolved: [], changed: false, reviewCombination: true };
		expect(qaText(bundle("bundle-1", one, { integration: clean }))).toBe("Not reviewed: clean merge");
		expect(qaText(bundle("bundle-2", two, { integration: clean }))).toBe("Not reviewed yet: the combination is reviewed before the PR");
		expect(qaText(bundle("bundle-3", two, { state: "INTEGRATING" }))).toBe("Not reviewed yet: the combination is reviewed before the PR");
		expect(qaText(bundle("bundle-4", one, { state: "INTEGRATING" }))).toBe("Not reviewed yet");
		// reviewed: QA status (or "QA not run"), as a conflicted bundle shows
		expect(qaText(bundle("bundle-5", two, { integration: clean, reviews: [{ seq: 1, round: 1 }] }))).toBe("QA not run");
		expect(qaText(bundle("bundle-6", two, { integration: clean, reviews: [{ seq: 1, round: 1 }], qaStatus: "ran" }))).not.toMatch(/clean merge|not run/);
		// an integration from before the combined-review rule (no mark) was clean and is not reviewed
		expect(qaText(bundle("bundle-7", two, { integration: { ...clean, reviewCombination: undefined } }))).toBe("Not reviewed: clean merge");
	});
});

describe("board: select mode and bulk actions", () => {
	const tick = () => new Promise((res) => setTimeout(res, 10));
	const sel = (w: Win) => [...w.document.querySelectorAll<HTMLInputElement>("#board input[data-sel]")].map((i) => i.dataset.sel);
	const selCol = (w: Win, key: string) => w.document.querySelector<HTMLInputElement>(`#board input[data-sel-col="${key}"]`);
	const bar = (w: Win) => w.document.getElementById("sel-bar")!;
	const bulk = (w: Win, kind: string) => w.document.querySelector<HTMLButtonElement>(`#sel-bar [data-bulk="${kind}"]`);
	const check = async (w: Win, id: string) => { w.document.querySelector<HTMLInputElement>(`#board input[data-sel="${id}"]`)!.click(); await tick(); };
	const calls = (w: Win, op: string) => ((w as unknown as { __calls: { op: string; args: unknown[] }[] }).__calls).filter((c) => c.op === op);
	const selecting = async (w: Win) => { w.document.getElementById("f-select")!.click(); await tick(); };

	test("a checkbox on run cards in every column, none on bundle cards or bundle members; a select-all per column", async () => {
		const plan = run("DISCUSSING"), build = run("BUILDING"), ready = run("READY"), legacy = run("AWAITING_CI"), done = run("DELIVERED");
		const m1 = run("READY", { bundle: "bundle-1" }), m2 = run("READY", { bundle: "bundle-2" }); // m2: its bundle failed (still held), not on the board's bundle list
		const w = await load([plan, build, ready, legacy, done, m1, m2], [bundle("bundle-1", [{ run: m1.id, title: "m1" }]), bundle("bundle-2", [{ run: m2.id, title: "m2" }], { state: "FAILED" })]);
		expect(sel(w)).toEqual([]);
		expect(w.document.querySelector("#board input[data-sel-col]")).toBeNull();
		expect(bar(w).hidden).toBe(true);
		await selecting(w);
		expect(w.document.getElementById("f-select")!.getAttribute("aria-pressed")).toBe("true");
		expect(sel(w).sort()).toEqual([plan.id, build.id, ready.id, legacy.id, done.id].sort());
		for (const k of ["planning", "build", "ready", "shipping", "done"]) expect(selCol(w, k), k).not.toBeNull();
		const shipping = col(w, "shipping");
		expect(shipping.querySelector('.card[data-bundle="bundle-1"]')!.closest(".sel-wrap")).toBeNull();
		expect(shipping.querySelector("input[data-sel]")!.getAttribute("data-sel")).toBe(legacy.id);
		// the cards keep their order and the test selector still finds them
		expect(cardIds(col(w, "planning"))).toEqual([plan.id]);
		// ticking a card selects it; it does not open the run
		await check(w, plan.id);
		expect(w.document.getElementById("runview")!.hidden).toBe(true);
		expect(bar(w).hidden).toBe(false);
		expect(bar(w).querySelector(".sel-n")!.textContent).toBe("1 selected");
		// leaving select mode clears the selection
		await selecting(w);
		expect(sel(w)).toEqual([]);
		expect(bar(w).hidden).toBe(true);
		await selecting(w);
		expect(bar(w).hidden).toBe(true);
	});

	test("a column's select-all acts on exactly the cards it shows: project filter, search and Show closed apply", async () => {
		const a1 = run("DISCUSSING"), a2 = run("RECEIVED", { request: { source: "web", title: "needle here", body: "" } });
		const b1 = run("DISCUSSING", { project: "other", repo: "o/other" });
		const d1 = run("DELIVERED"), c1 = run("CANCELLED"), f1 = run("FAILED");
		const w = await load([a1, a2, b1, d1, c1, f1]);
		await selecting(w);
		const proj = w.document.getElementById("proj-filter") as HTMLSelectElement;
		w.eval(`__t.ui.projects = [{ name: "todo", repo: "o/todo" }, { name: "other", repo: "o/other" }]; __t.renderProjectFilter();`);
		proj.value = "todo"; proj.dispatchEvent(new w.Event("change"));
		await tick();
		selCol(w, "planning")!.click(); await tick();
		expect([...(w.eval("__t.ui.sel") as Set<string>)].sort()).toEqual([a1.id, a2.id].sort());
		expect(selCol(w, "planning")!.checked).toBe(true);
		// again: unselects the column
		selCol(w, "planning")!.click(); await tick();
		expect((w.eval("__t.ui.sel") as Set<string>).size).toBe(0);
		// the search box
		proj.value = ""; proj.dispatchEvent(new w.Event("change"));
		const q = w.document.getElementById("q") as HTMLInputElement;
		q.value = "needle"; q.dispatchEvent(new w.Event("input"));
		await tick();
		selCol(w, "planning")!.click(); await tick();
		expect([...(w.eval("__t.ui.sel") as Set<string>)]).toEqual([a2.id]);
		q.value = ""; q.dispatchEvent(new w.Event("input")); await tick();
		// some selected: the header box is indeterminate; ticking it selects the rest
		expect(selCol(w, "planning")!.indeterminate).toBe(true);
		selCol(w, "planning")!.click(); await tick();
		expect([...(w.eval("__t.ui.sel") as Set<string>)].sort()).toEqual([a1.id, a2.id, b1.id].sort());
		// Done without Show closed: only the delivered card; with it, the failed and cancelled ones too
		selCol(w, "done")!.click(); await tick();
		expect((w.eval("__t.ui.sel") as Set<string>).has(d1.id)).toBe(true);
		expect((w.eval("__t.ui.sel") as Set<string>).has(c1.id)).toBe(false);
		w.document.getElementById("f-closed")!.click(); await tick();
		expect(selCol(w, "done")!.indeterminate).toBe(true);
		selCol(w, "done")!.click(); await tick();
		expect([...(w.eval("__t.ui.sel") as Set<string>)].sort()).toEqual([a1.id, a2.id, b1.id, d1.id, c1.id, f1.id].sort());
		expect(bar(w).querySelector(".sel-n")!.textContent).toBe("6 selected");
		// a filter that hides selected cards drops them from the selection
		proj.value = "other"; proj.dispatchEvent(new w.Event("change")); await tick();
		expect([...(w.eval("__t.ui.sel") as Set<string>)]).toEqual([b1.id]);
	});

	test("Cancel K and Clear M for a mixed selection: two clicks each, one call each on its own subset", async () => {
		const l1 = run("DISCUSSING"), l2 = run("BUILDING"), t1 = run("DELIVERED"), t2 = run("FAILED"), t3 = run("CANCELLED");
		const state = new Map<string, Record<string, unknown>>([l1, l2, t1, t2, t3].map((r) => [r.id, r]));
		const w = await load([...state.values()], [], {
			cancelRuns: ([ids]) => { for (const id of ids as string[]) state.set(id, { ...state.get(id)!, state: "CANCELLED", updatedAt: 9000 }); return { cancelled: ids }; },
			clearRuns: ([ids]) => { for (const id of ids as string[]) state.set(id, { ...state.get(id)!, cleared: { at: 1, by: "web" } }); return { cleared: ids }; },
			getRun: ([id]) => state.get(id as string),
		});
		w.document.getElementById("f-closed")!.click(); await tick();
		await selecting(w);
		for (const r of [l1, l2, t1, t2, t3]) await check(w, r.id);
		expect(bar(w).querySelector(".sel-n")!.textContent).toBe("5 selected");
		expect(bulk(w, "cancel")!.textContent).toBe("Cancel 2");
		expect(bulk(w, "clear")!.textContent).toBe("Clear 3");
		expect(bulk(w, "none")!.textContent).toBe("Clear selection");
		bulk(w, "cancel")!.click(); await tick();
		expect(bulk(w, "cancel")!.textContent).toBe("Click again to cancel 2");
		expect(calls(w, "cancelRuns")).toEqual([]);
		bulk(w, "cancel")!.click(); await new Promise((res) => setTimeout(res, 150));
		expect(calls(w, "cancelRuns")).toHaveLength(1);
		expect((calls(w, "cancelRuns")[0]!.args[0] as string[]).sort()).toEqual([l1.id, l2.id].sort());
		// the cancelled runs left the selection and moved to Done
		expect([...(w.eval("__t.ui.sel") as Set<string>)].sort()).toEqual([t1.id, t2.id, t3.id].sort());
		expect(col(w, "done").querySelector(`.card[data-id="${l1.id}"]`)).not.toBeNull();
		expect(bulk(w, "cancel")).toBeNull();
		expect(bulk(w, "clear")!.textContent).toBe("Clear 3");
		bulk(w, "clear")!.click(); await tick();
		expect(bulk(w, "clear")!.textContent).toBe("Click again to clear 3");
		bulk(w, "clear")!.click(); await new Promise((res) => setTimeout(res, 150));
		expect(calls(w, "clearRuns")).toHaveLength(1);
		expect((calls(w, "clearRuns")[0]!.args[0] as string[]).sort()).toEqual([t1.id, t2.id, t3.id].sort());
		expect((w.eval("__t.ui.sel") as Set<string>).size).toBe(0);
		expect(bar(w).hidden).toBe(true);
		for (const r of [t1, t2, t3]) expect(w.document.querySelector(`.card[data-id="${r.id}"]`)).toBeNull();
		// the remaining cards keep their ticket keys
		expect(w.document.querySelector(`.card[data-id="${l2.id}"] .key`)!.textContent).toBe("TODO-2");
	});

	test("a refused bulk call shows the error and changes nothing; a confirmation resets when clicking elsewhere", async () => {
		const l1 = run("DISCUSSING"), l2 = run("BUILDING");
		const w = await load([l1, l2], [], { cancelRuns: () => { throw { code: "conflict", message: `run ${l2.id} is in bundle-3; drop it from the bundle or cancel the bundle first` }; } });
		await selecting(w);
		await check(w, l1.id); await check(w, l2.id);
		bulk(w, "cancel")!.click(); await tick();
		w.document.body.click(); await tick();
		expect(bulk(w, "cancel")!.textContent).toBe("Cancel 2");
		bulk(w, "cancel")!.click(); await tick();
		bulk(w, "cancel")!.click(); await new Promise((res) => setTimeout(res, 50));
		expect(calls(w, "cancelRuns")).toHaveLength(1);
		expect(w.document.querySelector(".toast.error")!.textContent).toContain("bundle-3");
		expect((w.eval("__t.ui.sel") as Set<string>).size).toBe(2);
		expect(bulk(w, "cancel")!.textContent).toBe("Cancel 2");
	});

	test("live updates: a selected card that is cleared or joins a bundle drops out, and the counts follow", async () => {
		const l1 = run("READY"), l2 = run("BUILDING"), t1 = run("DELIVERED");
		const w = await load([l1, l2, t1]);
		await selecting(w);
		for (const r of [l1, l2, t1]) await check(w, r.id);
		expect(bulk(w, "cancel")!.textContent).toBe("Cancel 2");
		w.eval(`const ui = __t.ui; ui.runs.set("${t1.id}", { ...ui.runs.get("${t1.id}"), cleared: { at: 1, by: "web" } }); ui.runs.set("${l1.id}", { ...ui.runs.get("${l1.id}"), bundle: "bundle-9" }); __t.renderBoard();`);
		expect([...(w.eval("__t.ui.sel") as Set<string>)]).toEqual([l2.id]);
		expect(bulk(w, "cancel")!.textContent).toBe("Cancel 1");
		expect(bulk(w, "clear")).toBeNull();
		// a live run that finished elsewhere moves from Cancel to Clear
		w.eval(`__t.ui.runs.set("${l2.id}", { ...__t.ui.runs.get("${l2.id}"), state: "DELIVERED" }); __t.renderBoard();`);
		expect(bulk(w, "cancel")).toBeNull();
		expect(bulk(w, "clear")!.textContent).toBe("Clear 1");
	});

	test("Ready: in select mode no Ship N tickets and no ship ticks; leaving select mode restores shipping", async () => {
		const x = run("READY"), y = run("READY");
		const w = await load([x, y]);
		const shipTick = (id: string) => w.document.querySelector<HTMLInputElement>(`input[data-ship="${id}"]`);
		shipTick(x.id)!.click(); await tick();
		expect(col(w, "ready").querySelector("[data-ship-go]")!.textContent).toBe("Ship 1 ticket");
		await selecting(w);
		expect(col(w, "ready").querySelector("[data-ship-go]")).toBeNull();
		expect(col(w, "ready").querySelector(".ship-note")).toBeNull();
		expect(shipTick(x.id)).toBeNull();
		expect(sel(w).sort()).toEqual([x.id, y.id].sort());
		await check(w, y.id);
		expect(col(w, "ready").querySelector("[data-ship-go]")).toBeNull();
		await selecting(w);
		expect(shipTick(x.id)!.checked).toBe(true);
		expect(shipTick(y.id)!.checked).toBe(false);
		expect(col(w, "ready").querySelector("[data-ship-go]")!.textContent).toBe("Ship 1 ticket");
		expect(sel(w)).toEqual([]);
	});
});
