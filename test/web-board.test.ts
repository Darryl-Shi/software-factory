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
async function load(runs: unknown[], bundles: unknown[] = []): Promise<Win> {
	const html = read("index.html");
	const body = html.slice(html.indexOf("<body>") + 6, html.indexOf("</body>"));
	const dom = new JSDOM(`<!doctype html><html><head></head><body>${body}</body></html>`, { url: "http://127.0.0.1:7317/", runScripts: "outside-only", pretendToBeVisual: true });
	const w = dom.window as unknown as Win & Record<string, unknown>;
	const results: Record<string, unknown> = { listProjects: [{ name: "todo", repo: "o/todo" }], listRuns: runs, listDiscussions: [], listBundles: bundles };
	w.fetch = (async (url: string) => {
		const op = String(url).split("/").pop()!;
		return { status: 200, json: async () => ({ ok: true, result: results[op] ?? null }) };
	}) as unknown as typeof fetch;
	w.EventSource = class { readyState = 1; close() {} } as unknown;
	w.matchMedia = (() => ({ matches: true })) as unknown as typeof w.matchMedia; // reduced motion: no Web Animations needed
	w.eval(MARKED); w.eval(PURIFY);
	// the classic scripts share one global scope: evaluated together, with the functions under test exposed
	w.eval([read("markdown.js"), read("app.js"), read("discussions.js"), read("bundles.js"), "globalThis.__t = { PIPELINE, stageOf, stageInfo, boardColumn, ui, qaText };"].join("\n;"));
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
