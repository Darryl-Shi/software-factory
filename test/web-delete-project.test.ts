// Delete a project from the web UI (docs/specs/run-mv86f7vs-jif2.md, "Web UI"): Settings → a project's scope → Delete
// project (type the name to confirm; a conflict lists the live items as links; success toasts and goes back to Global),
// the live removal on `project.deleted` in every tab, and the not-found message for a purged item. The page is loaded
// into a test DOM the way the browser loads it, with the core's HTTP operations and the event stream faked.
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
		messages: [], advisory: [], acceptedBlocking: [], createdAt: 1000 + seq, updatedAt: 1000 + seq,
		...extra,
	};
}
function bundle(id: string, project: string, members: { run: string; title: string }[], extra: Record<string, unknown> = {}) {
	return {
		id, project, state: "AWAITING_CI", members, conversations: { integrator: null, reviewers: [], qa: [], active: null },
		reviews: [], reviewRound: 0, caps: { review: 3, ciFix: 3 }, ciFixes: 0, cost: [], history: [], notices: [], createdAt: 5000, ...extra,
	};
}
function disc(id: string, project: string, title: string) {
	return {
		id, project, repo: `o/${project}`, title, state: "CLOSED", turn: null, model: { model: "p/m", thinking: "low" }, conversationId: null,
		drafts: [], turnCosts: [], notices: [], cost: { usd: 0 }, createdAt: 1000, updatedAt: 2000,
	};
}

type Win = JSDOM["window"] & { eval(s: string): unknown; __calls: { op: string; args: unknown[] }[]; __emit(e: unknown): void };
type Reply = { ok: true; result: unknown } | { ok: false; status: number; code: string; error: string; details?: unknown };
type Handlers = Record<string, (args: unknown[]) => Reply | unknown>;
const PROJECTS = [{ name: "todo", repo: "o/todo" }, { name: "other", repo: "o/other" }];
const SCHEMA = { policy: { type: "object", fields: { autoApprove: { type: "boolean", description: "Approve gates automatically" } } } };
const SETTINGS = { "policy.autoApprove": { value: false, source: "default" } };

/** `handlers` answer operations (a `Reply` sets the HTTP status and error body); every call is recorded in `w.__calls`. */
async function load(opts: { runs?: unknown[]; bundles?: unknown[]; discs?: unknown[]; hash?: string; handlers?: Handlers } = {}): Promise<Win> {
	const html = read("index.html");
	const body = html.slice(html.indexOf("<body>") + 6, html.indexOf("</body>"));
	const dom = new JSDOM(`<!doctype html><html><head></head><body>${body}</body></html>`, { url: `http://127.0.0.1:7317/${opts.hash ?? ""}`, runScripts: "outside-only", pretendToBeVisual: true });
	const w = dom.window as unknown as Win;
	const results: Record<string, unknown> = {
		listProjects: PROJECTS, listRuns: opts.runs ?? [], listDiscussions: opts.discs ?? [], listBundles: opts.bundles ?? [],
		settingsSchema: SCHEMA, getSettings: SETTINGS, listModels: [],
	};
	w.__calls = [];
	w.fetch = (async (url: string, init?: { body?: string }) => {
		const op = String(url).split("/").pop()!;
		const args = (init?.body ? JSON.parse(init.body).args : []) as unknown[];
		w.__calls.push({ op, args });
		const h = opts.handlers?.[op];
		const out = h ? h(args) : { ok: true, result: results[op] ?? null };
		const reply = (out && typeof out === "object" && "ok" in out ? out : { ok: true, result: out ?? null }) as Reply;
		if (reply.ok) return { status: 200, json: async () => ({ ok: true, result: reply.result }) };
		return { status: reply.status, json: async () => ({ ok: false, code: reply.code, error: reply.error, ...(reply.details ? { details: reply.details } : {}) }) };
	}) as unknown as typeof fetch;
	const sources: { onmessage?: (m: { data: string }) => void }[] = [];
	w.EventSource = class { readyState = 1; onmessage?: (m: { data: string }) => void; constructor() { sources.push(this); } close() {} } as unknown as typeof EventSource;
	w.__emit = (e: unknown) => sources.forEach((s) => s.onmessage?.({ data: JSON.stringify(e) }));
	w.matchMedia = (() => ({ matches: true })) as unknown as typeof w.matchMedia; // reduced motion: no Web Animations needed
	w.eval(MARKED); w.eval(PURIFY);
	w.eval([read("markdown.js"), read("app.js"), read("discussions.js"), read("bundles.js"), "globalThis.__t = { ui };"].join("\n;"));
	await tick(30);
	return w;
}
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const $ = <T extends Element = HTMLElement>(w: Win, sel: string) => w.document.querySelector<T & HTMLElement>(sel);
const toasts = (w: Win) => [...w.document.querySelectorAll("#toasts .toast")].map((t) => t.textContent);
const scopes = (w: Win) => [...w.document.querySelectorAll<HTMLElement>("#set-nav [data-scope]")].map((b) => b.dataset.scope);
function type(w: Win, el: HTMLInputElement, value: string) {
	el.value = value;
	el.dispatchEvent(new w.Event("input", { bubbles: true }));
}
async function openDeleteDialog(w: Win, project = "todo") {
	$(w, '.nav button[data-view="settings"]')!.click();
	await tick();
	$(w, `#set-nav [data-scope="${project}"]`)!.click();
	await tick();
	$(w, `#set-main [data-delete-project="${project}"]`)!.click();
	await tick();
	return { input: $<HTMLInputElement>(w, "#dp-name")!, go: $<HTMLButtonElement>(w, "#dp-go")! };
}

describe("Settings → Delete project", () => {
	test("only a project's scope has the section; it says what is removed and what is kept", async () => {
		const w = await load();
		$(w, '.nav button[data-view="settings"]')!.click();
		await tick();
		expect($(w, "#set-main .set-danger")).toBeNull(); // Global
		$(w, '#set-nav [data-scope="todo"]')!.click();
		await tick();
		const sec = $(w, "#set-main .set-danger")!;
		expect(sec).not.toBeNull();
		expect(sec.textContent).toContain("discussions");
		expect(sec.textContent).toContain("factory/<id> branches");
		expect(sec.textContent).toContain("GitHub repo");
		expect(sec.textContent).toContain("pull requests");
		// the section is the last thing in the scope's page
		expect($(w, "#set-main")!.lastElementChild).toBe(sec);
	});

	test("the confirm button stays disabled until the project name is typed exactly", async () => {
		const w = await load();
		const { input, go } = await openDeleteDialog(w);
		expect(go.disabled).toBe(true);
		for (const v of ["tod", "Todo", "todo ", " todo"]) { type(w, input, v); expect(go.disabled, v).toBe(true); }
		type(w, input, "todo");
		expect(go.disabled).toBe(false);
		type(w, input, "todox");
		expect(go.disabled).toBe(true);
		// submitting with a wrong name (Enter) calls nothing
		$(w, "form.delete-project")!.dispatchEvent(new w.Event("submit", { cancelable: true }));
		await tick();
		expect(w.__calls.some((c) => c.op === "deleteProject")).toBe(false);
	});

	test("conflict: nothing deleted, the live items listed as links that open them", async () => {
		const ready = run("READY"), d = disc("disc-1", "todo", "Talk about due dates");
		// docs/specs/run-mv89bw5w-pykq.md: discussions are never live work; only one "still finishing" can be listed
		const live = [{ kind: "run", id: ready.id, state: "READY" }, { kind: "bundle", id: "bundle-2", state: "FAILED" }, { kind: "discussion", id: "disc-1", state: "OPEN (still finishing)" }];
		const w = await load({
			runs: [ready], bundles: [bundle("bundle-2", "todo", [], { state: "FAILED" })], discs: [d],
			handlers: { deleteProject: () => ({ ok: false, status: 409, code: "conflict", error: "todo has live work: run-1 (READY), bundle-2 (FAILED), disc-1 (OPEN (still finishing))", details: { live } }) },
		});
		const { input, go } = await openDeleteDialog(w);
		type(w, input, "todo");
		go.click();
		await tick();
		expect(w.__calls.filter((c) => c.op === "deleteProject").map((c) => c.args)).toEqual([["todo"]]);
		const box = $(w, "#dp-live")!;
		expect(box.hidden).toBe(false);
		expect(box.textContent).toContain("Cancel these first");
		expect(box.textContent).not.toContain("close");
		const links = [...box.querySelectorAll<HTMLAnchorElement>("a[data-live-kind]")];
		expect(links.map((a) => a.getAttribute("href"))).toEqual([`#run=${ready.id}`, "#bundle=bundle-2", "#disc=disc-1"]);
		expect(links[0]!.textContent).toContain(ready.request.title);
		expect(links[2]!.textContent).toBe("Talk about due dates");
		expect(box.textContent).toContain("READY");
		expect(box.textContent).toContain("FAILED");
		expect(box.textContent).toContain("OPEN (still finishing)");
		// nothing changed: the project, its cards and the dialog are all still there
		expect(scopes(w)).toEqual(["global", "todo", "other"]);
		expect((w as unknown as { __t: { ui: { runs: Map<string, unknown> } } }).__t.ui.runs.has(ready.id)).toBe(true);
		expect(go.disabled).toBe(false);
		expect(toasts(w).some((t) => t?.startsWith("Deleted project"))).toBe(false);
		// a link opens the run's view (and closes the dialog)
		links[0]!.click();
		await tick(40);
		expect($(w, "#dp-live")).toBeNull();
		expect($(w, "#runview")!.hidden).toBe(false);
		expect($(w, "#rv-title")!.textContent).toBe(ready.request.title);
	});

	test("5: a FAILED bundle refuses: the dialog lists the bundle with \"Cancel these first\" and no discussion", async () => {
		const d = { ...disc("disc-1", "todo", "Open chat"), state: "OPEN" };
		const live = [{ kind: "bundle", id: "bundle-2", state: "FAILED" }];
		const w = await load({
			bundles: [bundle("bundle-2", "todo", [], { state: "FAILED" })], discs: [d],
			handlers: { deleteProject: () => ({ ok: false, status: 409, code: "conflict", error: "project todo has live work: bundle-2 is FAILED; cancel it first (Cancel, Cancel bundle)", details: { live } }) },
		});
		const { input, go } = await openDeleteDialog(w);
		type(w, input, "todo");
		go.click();
		await tick();
		const box = $(w, "#dp-live")!;
		expect(box.hidden).toBe(false);
		expect(box.querySelector(".dp-live-h")!.textContent).toContain("Cancel these first");
		const links = [...box.querySelectorAll<HTMLAnchorElement>("a[data-live-kind]")];
		expect(links.map((a) => a.getAttribute("href"))).toEqual(["#bundle=bundle-2"]);
		expect(box.textContent).not.toContain("Discussion");
		expect(box.textContent).not.toContain("Open chat");
	});

	test("6: the dialog warns how many open discussions will be ended; no line when there are none", async () => {
		const discs = [
			{ ...disc("disc-1", "todo", "One"), state: "OPEN" },
			{ ...disc("disc-2", "todo", "Two"), state: "PREPARING" },
			disc("disc-3", "todo", "Closed"),
			{ ...disc("disc-4", "todo", "Failed"), state: "FAILED" },
			{ ...disc("disc-5", "other", "Elsewhere"), state: "OPEN" },
		];
		const w = await load({ discs, handlers: { listDiscussions: ([f]) => discs.filter((d) => !(f as { project?: string })?.project || d.project === (f as { project: string }).project) } });
		await openDeleteDialog(w);
		await tick();
		expect(w.__calls.some((c) => c.op === "listDiscussions" && JSON.stringify(c.args) === JSON.stringify([{ project: "todo" }]))).toBe(true);
		const line = $(w, "#dp-discs")!;
		expect(line.hidden).toBe(false);
		expect(line.textContent).toBe("2 open discussions will be ended");
		// the rest of the dialog is unchanged
		const body = $(w, "form.delete-project .modal-body")!.textContent!;
		expect(body).toContain("This removes its tickets (runs), bundles and discussions");
		expect(body).toContain("Kept: the GitHub repo itself");
		expect($<HTMLButtonElement>(w, "#dp-go")!.disabled).toBe(true);

		const one = await load({ discs: [{ ...disc("disc-1", "todo", "One"), state: "OPEN" }] });
		await openDeleteDialog(one);
		await tick();
		expect($(one, "#dp-discs")!.textContent).toBe("1 open discussion will be ended");

		const none = await load({ discs: [disc("disc-3", "todo", "Closed"), { ...disc("disc-5", "other", "Elsewhere"), state: "OPEN" }] });
		await openDeleteDialog(none);
		await tick();
		expect($(none, "#dp-discs")!.hidden).toBe(true);
		expect($(none, "form.delete-project")!.textContent).not.toContain("will be ended");
	});

	test("success: toast, the scope back to Global, the project gone from the scope list and the dropdowns", async () => {
		const a = run("DELIVERED"), b = run("BUILDING", { project: "other", repo: "o/other" });
		let deleted = false;
		const w = await load({
			runs: [a, b],
			handlers: {
				deleteProject: () => { deleted = true; return { project: "todo", runs: [a.id], bundles: [], discussions: [] }; },
				listProjects: () => (deleted ? PROJECTS.filter((p) => p.name !== "todo") : PROJECTS),
			},
		});
		const { input, go } = await openDeleteDialog(w);
		type(w, input, "todo");
		go.click();
		await tick(40);
		expect(toasts(w)).toContain("Deleted project todo");
		expect($(w, "#modal-root .modal")).toBeNull();
		expect(scopes(w)).toEqual(["global", "other"]);
		expect($(w, '#set-nav [data-scope="global"]')!.getAttribute("aria-current")).toBe("true");
		expect($(w, "#set-main h2")!.textContent).toBe("Global settings");
		expect([...w.document.querySelectorAll<HTMLOptionElement>("#proj-filter option")].map((o) => o.value)).toEqual(["", "other"]);
		// the core's own event arrives too: applying it again changes nothing and says nothing more
		w.__emit({ type: "project.deleted", project: "todo", runs: [a.id], bundles: [], discussions: [] });
		await tick();
		expect(scopes(w)).toEqual(["global", "other"]);
		expect(toasts(w).filter((t) => t?.includes("todo"))).toEqual(["Deleted project todo"]);
	});
});

describe("project.deleted: live in every tab", () => {
	test("cards, bundles, counts and Chat history leave; the filter resets; dropdowns lose the project", async () => {
		const a = run("BUILDING"), b = run("READY", { bundle: "bundle-1" }), c = run("FAILED"), keep = run("BUILDING", { project: "other", repo: "o/other" });
		const w = await load({ runs: [a, b, c, keep], bundles: [bundle("bundle-1", "todo", [{ run: b.id, title: "B" }])], discs: [disc("disc-1", "todo", "Old chat"), disc("disc-2", "other", "Keep chat")] });
		const filter = $<HTMLSelectElement>(w, "#proj-filter")!;
		filter.value = "todo";
		filter.dispatchEvent(new w.Event("change"));
		await tick();
		expect($(w, `#board .card[data-id="${a.id}"]`)).not.toBeNull();
		expect($(w, '#board .card[data-id="bundle-1"]')).not.toBeNull();
		expect($(w, "#n-active")!.textContent).toBe("2");
		$(w, "#create-btn")!.click();
		await tick();
		w.__emit({ type: "project.deleted", project: "todo", runs: [a.id, b.id, c.id], bundles: ["bundle-1"], discussions: ["disc-1"] });
		await tick();
		expect($(w, `#board .card[data-id="${a.id}"]`)).toBeNull();
		expect($(w, '#board .card[data-id="bundle-1"]')).toBeNull();
		expect(filter.value).toBe("");
		expect([...filter.options].map((o) => o.value)).toEqual(["", "other"]);
		expect($(w, `#board .card[data-id="${keep.id}"]`)).not.toBeNull();
		expect($(w, "#n-active")!.textContent).toBe("1");
		expect($(w, "#n-closed")!.textContent).toBe("0");
		expect([...w.document.querySelectorAll<HTMLOptionElement>("#c-project option")].map((o) => o.value)).toEqual(["other", "__new"]);
		const ui = (w as unknown as { __t: { ui: { discs: Map<string, unknown>; bundles: Map<string, unknown>; projects: { name: string }[] } } }).__t.ui;
		expect([...ui.discs.keys()]).toEqual(["disc-2"]);
		expect([...ui.bundles.keys()]).toEqual([]);
		expect(ui.projects.map((p) => p.name)).toEqual(["other"]);
	});

	test("an open run view of the project closes with a toast", async () => {
		const a = run("BUILDING");
		const w = await load({ runs: [a] });
		$<HTMLButtonElement>(w, `#board .card[data-id="${a.id}"]`)!.click();
		await tick();
		expect($(w, "#runview")!.hidden).toBe(false);
		w.__emit({ type: "project.deleted", project: "todo", runs: [a.id], bundles: [], discussions: [] });
		await tick();
		expect($(w, "#runview")!.hidden).toBe(true);
		expect(toasts(w)).toContain("Project todo was deleted");
	});

	test("8: an open discussion ended by another tab's deletion (FAILED, then purged) closes with the deletion's toast only", async () => {
		const d = { ...disc("disc-1", "todo", "Live chat"), state: "OPEN" };
		let purged = false;
		const w = await load({
			discs: [d],
			handlers: {
				getDiscussion: () => (purged ? { ok: false, status: 404, code: "not_found", error: "discussion disc-1 does not exist" } : d),
				getDiscussionConversation: () => ({ conversationId: "c", items: [], helpers: [], busy: false, queued: [] }),
			},
		});
		w.eval("openDiscussion('disc-1')");
		await tick(40);
		expect($(w, "#runview")!.hidden).toBe(false);
		// the deletion ends it (FAILED) and purges it before project.deleted reaches this tab
		purged = true;
		w.__emit({ type: "discussion.state", discussion: "disc-1", project: "todo", from: "OPEN", to: "FAILED" });
		await tick(150);
		expect($(w, "#runview")!.hidden).toBe(true);
		expect(toasts(w)).toContain("Project todo was deleted");
		w.__emit({ type: "project.deleted", project: "todo", runs: [], bundles: [], discussions: ["disc-1"] });
		await tick(1700);
		expect(toasts(w).filter((t) => t?.includes("was deleted"))).toEqual(["Project todo was deleted"]);
		expect(toasts(w).some((t) => t?.includes("failed"))).toBe(false);
	});

	test("a discussion that fails on its own (its project stays) still toasts; one ended by a deletion does not", async () => {
		const d1 = { ...disc("disc-1", "todo", "Lives"), state: "OPEN" }, d2 = { ...disc("disc-2", "other", "Purged"), state: "OPEN" };
		const w = await load({
			discs: [d1, d2],
			handlers: { getDiscussion: ([id]) => (id === "disc-1" ? { ...d1, state: "FAILED" } : { ok: false, status: 404, code: "not_found", error: "gone" }) },
		});
		w.__emit({ type: "discussion.state", discussion: "disc-1", project: "todo", from: "OPEN", to: "FAILED" });
		w.__emit({ type: "discussion.state", discussion: "disc-2", project: "other", from: "OPEN", to: "FAILED" });
		await tick(1700);
		expect(toasts(w).filter((t) => t?.includes("failed"))).toEqual(['The discussion "Lives" failed']);
	});

	test("an open discussion of the project closes with a toast; its Chat history is gone", async () => {
		const d = disc("disc-1", "todo", "Old chat");
		const w = await load({ discs: [d], handlers: { getDiscussion: () => d } });
		w.eval("openDiscussion('disc-1')");
		await tick(40);
		expect($(w, "#runview")!.hidden).toBe(false);
		expect($(w, '#rv-threads [data-chat="disc-1"]')).not.toBeNull();
		w.__emit({ type: "project.deleted", project: "todo", runs: [], bundles: [], discussions: ["disc-1"] });
		await tick();
		expect($(w, "#runview")!.hidden).toBe(true);
		expect(toasts(w)).toContain("Project todo was deleted");
		// the Chat view now starts on the remaining project, without the old chat
		w.eval("openChat({ blank: true })");
		await tick(40);
		expect($(w, '#rv-threads [data-chat="disc-1"]')).toBeNull();
		expect([...w.document.querySelectorAll<HTMLOptionElement>("#ch-project option")].map((o) => o.value)).toEqual(["other", "__new"]);
	});

	test("an open bundle view of the project closes with a toast", async () => {
		const b = bundle("bundle-1", "todo", []);
		const w = await load({ bundles: [b], handlers: { getBundle: () => b } });
		w.eval("openBundleById('bundle-1')");
		await tick(40);
		expect($(w, "#runview")!.hidden).toBe(false);
		w.__emit({ type: "project.deleted", project: "todo", runs: [], bundles: ["bundle-1"], discussions: [] });
		await tick();
		expect($(w, "#runview")!.hidden).toBe(true);
		expect(toasts(w)).toContain("Project todo was deleted");
	});

	test("a Settings page on the deleted project's scope goes back to Global", async () => {
		const w = await load();
		$(w, '.nav button[data-view="settings"]')!.click();
		await tick();
		$(w, '#set-nav [data-scope="todo"]')!.click();
		await tick();
		w.__emit({ type: "project.deleted", project: "todo", runs: [], bundles: [], discussions: [] });
		await tick();
		expect(scopes(w)).toEqual(["global", "other"]);
		expect($(w, "#set-main h2")!.textContent).toBe("Global settings");
	});
});

describe("links to purged items", () => {
	const notFound = () => ({ ok: false, status: 404, code: "not_found", error: "no such run" });
	const MSG = "Not found (its project was deleted or it never existed)";
	test("#run= of a purged run", async () => {
		const w = await load({ hash: "#run=run-999", handlers: { getRun: notFound } });
		await tick();
		expect(toasts(w)).toContain(MSG);
		expect($(w, "#runview")!.hidden).toBe(true);
	});
	test("#bundle= of a purged bundle", async () => {
		const w = await load({ hash: "#bundle=bundle-9", handlers: { getBundle: notFound } });
		await tick();
		expect(toasts(w)).toContain(MSG);
	});
	test("#disc= of a purged discussion", async () => {
		const w = await load({ hash: "#disc=disc-9", handlers: { getDiscussion: notFound } });
		await tick();
		expect(toasts(w)).toContain(MSG);
		expect($(w, "#runview")!.hidden).toBe(true);
	});
});
