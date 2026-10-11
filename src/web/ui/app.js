"use strict";
// Factory web UI: a ticket board and a full-screen run view over the core's operations and events (spec §3.6).
// It only talks to `core`: a thin client where every operation is `POST /api/op/<op>` and `subscribe` is the
// `/api/events` stream. All state below is a cache filled from core reads and events; transitions belong to the core.

// ===================================================================== core client
class FactoryError extends Error {
  constructor(code, message) { super(message); this.code = code; this.name = "FactoryError"; }
}
async function call(op, args) {
  let res;
  try {
    res = await fetch(`/api/op/${op}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ args }), credentials: "same-origin" });
  } catch {
    throw new FactoryError("offline", "The factory isn't reachable. Is `factory serve` still running?");
  }
  if (res.status === 401) { location.reload(); throw new FactoryError("unauthorized", "Your session expired."); }
  let body;
  try { body = await res.json(); } catch { throw new FactoryError("http", `HTTP ${res.status}`); }
  if (!body.ok) throw new FactoryError(body.code ?? "error", body.error ?? `HTTP ${res.status}`);
  return body.result;
}
function subscribe(filter, on) {
  const qs = new URLSearchParams(Object.entries(filter).filter(([, v]) => v)).toString();
  let es, timer = 0, stopped = false, down = false;
  const open = () => {
    es = new EventSource(`/api/events${qs ? `?${qs}` : ""}`);
    es.onopen = () => { if (down) { down = false; conn(false); resync(); } };
    es.onmessage = (m) => { try { on(JSON.parse(m.data)); } catch (e) { console.error(e); } };
    es.onerror = () => {
      if (!down) { down = true; conn(true); }
      // The browser retries by itself unless the server refused the stream (e.g. a restart with a new token).
      if (es.readyState === EventSource.CLOSED && !stopped) {
        clearTimeout(timer);
        timer = setTimeout(async () => { try { await call("listProjects", []); } catch {} open(); }, 3000);
      }
    };
  };
  open();
  return () => { stopped = true; clearTimeout(timer); es.close(); };
}
const core = new Proxy({}, { get: (_, op) => (op === "subscribe" ? subscribe : (...args) => call(op, args)) });

// ===================================================================== shared helpers
const $ = (sel, el = document) => el.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const linkify = (escaped) => escaped.replace(/https?:\/\/[^\s<"')]+/g, (u) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`);
const inline = (t) => linkify(esc(t)).replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
function md(text) {
  const out = []; let list = null, fence = null;
  const close = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const line of String(text ?? "").split("\n")) {
    let m;
    if (fence !== null) { if (/^\s*```/.test(line)) { out.push(`<pre>${esc(fence.join("\n"))}</pre>`); fence = null; } else fence.push(line); continue; }
    if (/^\s*```/.test(line)) { close(); fence = []; }
    else if ((m = line.match(/^(#{1,3}) (.*)/))) { close(); out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`); }
    else if ((m = line.match(/^\s*[-*] (.*)/))) { if (list !== "ul") { close(); out.push("<ul>"); list = "ul"; } out.push(`<li>${inline(m[1])}</li>`); }
    else if ((m = line.match(/^\s*\d+\. (.*)/))) { if (list !== "ol") { close(); out.push("<ol>"); list = "ol"; } out.push(`<li>${inline(m[1])}</li>`); }
    else if (!line.trim()) close();
    else { close(); out.push(`<p>${inline(line)}</p>`); }
  }
  if (fence !== null) out.push(`<pre>${esc(fence.join("\n"))}</pre>`);
  close(); return out.join("");
}
function ago(t) {
  const s = (Date.now() - t) / 1000;
  if (s < 60) return "now"; if (s < 3600) return `${Math.floor(s / 60)}m`; if (s < 86400) return `${Math.floor(s / 3600)}h`; return `${Math.floor(s / 86400)}d`;
}
function stamp(t) {
  const d = new Date(t), today = new Date().toDateString() === d.toDateString();
  return today ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : d.toLocaleDateString([], { month: "short", day: "numeric" });
}
const cap1 = (x) => (x ? x[0].toUpperCase() + x.slice(1) : "");
const money = (n) => `$${n.toFixed(2)}`;
const totalUsd = (run) => run.cost.reduce((a, c) => a + (c.usd || 0), 0);
const reduceMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
const same = (a, b) => a != null && b != null && String(a) === String(b);
const TERMINAL = ["DELIVERED", "FAILED", "CANCELLED"];

function toast(text, kind = "", onClick = null) {
  const el = document.createElement("div");
  el.className = `toast ${kind}`; el.textContent = text;
  if (onClick) {
    el.classList.add("clickable"); el.setAttribute("role", "button"); el.tabIndex = 0;
    const go = () => { el.remove(); onClick(); };
    el.addEventListener("click", go);
    el.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
  }
  $("#toasts").append(el);
  setTimeout(() => el.remove(), kind === "error" ? 6000 : 3800);
}
async function act(fn, ok) {
  try { await fn(); if (ok) toast(ok); return true; }
  catch (e) { toast(e instanceof FactoryError && !["offline", "http", "error"].includes(e.code) ? `${e.message} (${e.code})` : String(e.message ?? e), "error"); return false; }
}
function conn(down) {
  const el = $("#conn");
  el.hidden = !down;
  el.innerHTML = down ? `<span class="spin"></span> Reconnecting to the factory…` : "";
}

// ===================================================================== client state (filled only from core reads and events)
const ui = { runs: new Map(), discs: new Map(), mode: null, projects: [], schema: null, keys: new Map(), touched: new Map(), filter: { project: "", turn: false, active: false, closed: false, q: "" }, open: null, rendered: false };
function computeKeys() {
  const by = {};
  [...ui.runs.values()].sort((a, b) => a.createdAt - b.createdAt).forEach((r) => {
    by[r.project] = (by[r.project] ?? 0) + 1;
    const prefix = r.project.split(/[-_.]/)[0].replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 6) || "RUN";
    ui.keys.set(r.id, `${prefix}-${by[r.project]}`);
  });
}
const keyOf = (id) => ui.keys.get(id) ?? id;

const COLUMNS = [
  { key: "intake", name: "Intake", states: "RECEIVED · PREPARING" },
  { key: "discussion", name: "Discussion", states: "DISCUSSING · SPEC_READY" },
  { key: "spec", name: "Spec approval", states: "AWAITING_APPROVAL · spec" },
  { key: "build", name: "Build", states: "BUILDING" },
  { key: "review", name: "Review", states: "REVIEWING" },
  { key: "deliver", name: "Deliver", states: "AWAITING_APPROVAL · delivery, merge · DELIVERING · AWAITING_CI" },
  { key: "done", name: "Done", states: "DELIVERED" },
];
function columnOf(r) {
  let st = r.state;
  if (st === "ESCALATED") st = r.escalation?.from ?? "REVIEWING";
  if (st === "FAILED" || st === "CANCELLED" || st === "DELIVERED") return "done";
  if (st === "RECEIVED" || st === "PREPARING") return "intake";
  if (st === "DISCUSSING" || st === "SPEC_READY") return "discussion";
  if (st === "AWAITING_APPROVAL") return r.gate === "spec" ? "spec" : "deliver";
  if (st === "BUILDING") return "build";
  if (st === "REVIEWING") return "review";
  return "deliver";
}
const PIPELINE = [["intake", "Intake"], ["discussion", "Discussion"], ["spec", "Spec approval"], ["build", "Build"], ["review", "Review"], ["deliver", "Deliver"], ["done", "Done"]];
function stateLabel(r) {
  const map = {
    RECEIVED: ["Received", ""], PREPARING: ["Preparing", ""], DISCUSSING: ["Discussing", "progress"], SPEC_READY: ["Spec ready", ""],
    AWAITING_APPROVAL: [`${r.gate ?? ""} approval`, "attention"], BUILDING: ["Building", "progress"], REVIEWING: ["Reviewing", "progress"],
    ESCALATED: ["Escalated", "bad"], DELIVERING: ["Delivering", ""], AWAITING_CI: ["Awaiting CI", "progress"], DELIVERED: ["Delivered", "ok"],
    FAILED: ["Failed", "bad"], CANCELLED: ["Cancelled", ""],
  };
  const [text, cls] = map[r.state] ?? [r.state, ""];
  return `<span class="lozenge ${cls}" title="${esc(r.state)}${r.gate ? ` (${esc(r.gate)})` : ""}">${esc(text)}</span>`;
}
function roleOf(r, cid) {
  const c = r.conversations;
  if (cid == null) return null;
  if (same(cid, c.architect)) return "architect";
  if (same(cid, c.builder)) return "builder";
  if (c.reviewers.some((x) => same(x.id, cid))) return "reviewer";
  if ((c.qa ?? []).some((x) => same(x.id, cid))) return "qa";
  return "helper";
}
const activeRole = (r) => roleOf(r, r.conversations.active);
// Whether a conversation is working: exact for the open run's fetched transcripts, otherwise recent activity.
function convLive(cid) {
  if (cid == null) return false;
  const t = ui.tx?.get(String(cid));
  if (t) return t.busy;
  return Date.now() - (ui.touched.get(String(cid)) ?? 0) < 8000;
}
const runLive = (r) => !TERMINAL.includes(r.state) && convLive(r.conversations.active);
const ROLE_LETTER = { architect: "A", builder: "B", helper: "H", reviewer: "R", qa: "Q" };
const ROLE_NAME = { qa: "QA" };
const roleName = (role) => ROLE_NAME[role] ?? cap1(role);
const avatar = (role, live) => `<span class="avatar ${role}${live ? " live" : ""}" title="${roleName(role)}${live ? " (working)" : ""}">${ROLE_LETTER[role] ?? "F"}</span>`;
// QA screenshots: served by the web server from the run's artifacts (cookie-authenticated GET)
const shotUrl = (run, id) => `/api/runs/${encodeURIComponent(run)}/screenshots/${encodeURIComponent(id)}`;
const shotsHtml = (run, ids) => (ids?.length ? `<div class="shots">${ids.map((id) => `<a href="${esc(shotUrl(run, id))}" target="_blank" rel="noopener noreferrer" title="Screenshot ${esc(id)}"><img src="${esc(shotUrl(run, id))}" alt="Screenshot ${esc(id)}" loading="lazy"><span class="meta mono">${esc(id)}</span></a>`).join("")}</div>` : "");
const QA_LABEL = { ran: "QA ran", off: "QA off", skipped: "QA skipped · nothing to launch", unavailable: "QA unavailable" };
function turnText(q) {
  if (q.kind === "discussion") return "Your turn · question";
  if (q.kind === "approval") return `Your turn · ${q.gate}`;
  return "Your turn · escalation";
}
const pending = (r) => (r.pendingAsk && !r.pendingAsk.response ? r.pendingAsk : undefined);

// ===================================================================== board
function visibleRuns() {
  const f = ui.filter, q = f.q.trim().toLowerCase();
  return [...ui.runs.values()].filter((r) => {
    if (f.project && r.project !== f.project) return false;
    if (f.turn && !pending(r)) return false;
    if (f.active && TERMINAL.includes(r.state)) return false;
    if (!f.closed && (r.state === "FAILED" || r.state === "CANCELLED")) return false;
    if (q && !`${r.request.title} ${r.request.body} ${keyOf(r.id)} ${r.project}`.toLowerCase().includes(q)) return false;
    return true;
  });
}
function cardHtml(r) {
  const pa = pending(r), role = activeRole(r), live = role && runLive(r);
  const chips = [];
  if (r.conversations.reviewers.length > 0) chips.push(`<span class="rchip${r.reviewRound >= r.caps.review && r.state !== "DELIVERED" ? " hot" : ""}" title="Review round ${r.reviewRound} of ${r.caps.review}">R${r.reviewRound}/${r.caps.review}</span>`);
  if (r.qaStatus && r.qaStatus !== "off") chips.push(`<span class="rchip${r.qaStatus === "unavailable" ? " hot" : ""}" title="${esc(QA_LABEL[r.qaStatus] ?? r.qaStatus)}">QA ${r.qaStatus === "ran" ? "✓" : r.qaStatus === "skipped" ? "–" : "!"}</span>`);
  if (r.ciFixes > 0 || r.state === "AWAITING_CI") chips.push(`<span class="rchip" title="CI fix rounds used">CI ${r.ciFixes}/${r.caps.ciFix}</span>`);
  const flag = r.state === "ESCALATED" ? `<span class="flag">▲ ${r.escalation?.cap === "ciFix" ? "CI fix cap hit" : r.escalation?.cap === "review" ? "Review cap hit" : "Needs a decision"}</span>` : "";
  const cls = ["card", pa ? "turn" : "", r.state === "ESCALATED" ? "esc" : "", r.state === "FAILED" || r.state === "CANCELLED" ? "closed" : ""].join(" ");
  const from = r.request.meta?.discussion;
  return `<button type="button" class="${cls}" data-id="${esc(r.id)}">
    <div class="card-title">${esc(r.request.title)}</div>
    <div class="card-row">${stateLabel(r)}${pa ? `<span class="turn-badge">${esc(turnText(pa.question))}</span>` : ""}${flag}</div>
    <div class="card-foot">
      <div class="card-row"><span class="key">${esc(keyOf(r.id))}</span>${from ? `<span class="disc-mark" title="From discussion: ${esc(from.title)}" aria-label="From discussion: ${esc(from.title)}">${ICON.chat}</span>` : ""}${ui.filter.project ? "" : `<span class="pchip">${esc(r.project)}</span>`}<span class="rounds">${chips.join("")}</span></div>
      <div class="card-row"><span class="meta">${money(totalUsd(r))} · ${ago(r.createdAt)}</span>${role ? avatar(role, live) : ""}</div>
    </div>
  </button>`;
}
function renderBoard() {
  computeKeys();
  const board = $("#board");
  const before = new Map(), scrolls = {};
  board.querySelectorAll(".card").forEach((el) => before.set(el.dataset.id, el.getBoundingClientRect()));
  board.querySelectorAll(".col").forEach((el) => (scrolls[el.dataset.col] = $(".col-body", el).scrollTop));
  const focused = document.activeElement?.closest?.(".card")?.dataset.id;

  const runs = visibleRuns();
  const byCol = Object.fromEntries(COLUMNS.map((c) => [c.key, []]));
  runs.forEach((r) => byCol[columnOf(r)].push(r));
  for (const k in byCol) byCol[k].sort((a, b) => (pending(b) ? 1 : 0) - (pending(a) ? 1 : 0) || (k === "done" ? b.updatedAt - a.updatedAt : a.createdAt - b.createdAt));
  const first = ui.runs.size === 0;
  board.innerHTML = COLUMNS.map((c) => {
    const states = esc(c.key === "done" && ui.filter.closed ? "DELIVERED · FAILED · CANCELLED" : c.states);
    return `<section class="col${c.key === "done" ? " done-col" : ""}" data-col="${c.key}" aria-label="${c.name}">
      <div class="col-head"><span class="col-name">${c.name}</span><span class="col-count">${byCol[c.key].length}</span></div>
      <div class="col-states" title="${states}">${states}</div>
      <div class="col-body">${byCol[c.key].map(cardHtml).join("") || `<div class="col-empty">${first && c.key === "intake" ? "Press <b>Create</b> to submit your first ticket" : "No tickets"}</div>`}</div>
    </section>`;
  }).join("");
  board.querySelectorAll(".col").forEach((el) => ($(".col-body", el).scrollTop = scrolls[el.dataset.col] ?? 0));
  if (focused) [...board.querySelectorAll(".card")].find((el) => el.dataset.id === focused)?.focus({ preventScroll: true });

  if (!reduceMotion()) board.querySelectorAll(".card").forEach((el) => {
    const b = before.get(el.dataset.id);
    if (!b) { if (ui.rendered) el.animate([{ opacity: 0, transform: "translateY(-6px)" }, { opacity: 1, transform: "none" }], { duration: 260 }); return; }
    const a = el.getBoundingClientRect(), dx = b.left - a.left, dy = b.top - a.top;
    if (Math.abs(dx) > 1 || Math.abs(dy) > 1) el.animate([{ transform: `translate(${dx}px, ${dy}px)`, boxShadow: "var(--shadow-lift)" }, { transform: "none" }], { duration: 480, easing: "cubic-bezier(.2,.7,.2,1)" });
  });
  ui.rendered = true;
  ui.liveSig = liveSignature();

  const all = [...ui.runs.values()].filter((r) => !ui.filter.project || r.project === ui.filter.project);
  $("#n-turn").textContent = all.filter((r) => pending(r)).length;
  $("#n-active").textContent = all.filter((r) => !TERMINAL.includes(r.state)).length;
  $("#n-closed").textContent = all.filter((r) => r.state === "FAILED" || r.state === "CANCELLED").length;
  const p = ui.projects.find((x) => x.name === ui.filter.project);
  $("#board-title").textContent = p ? `${p.name} pipeline` : "Pipeline";
  const turns = [...ui.runs.values()].filter((r) => pending(r)).length;
  document.title = turns ? `(${turns}) Factory Board` : "Factory Board";
}
const liveSignature = () => [...ui.runs.values()].filter(runLive).map((r) => r.id).join(",");
function renderProjectFilter() {
  const sel = $("#proj-filter");
  sel.innerHTML = `<option value="">All projects</option>` + ui.projects.map((p) => `<option value="${esc(p.name)}">${esc(p.name)} · ${esc(p.repo)}</option>`).join("");
  if (ui.filter.project && !ui.projects.some((p) => p.name === ui.filter.project)) ui.filter.project = "";
  sel.value = ui.filter.project;
}

// ===================================================================== events → client cache
const pendingRuns = new Set(); let flushTimer = 0;
function refreshRun(id) { pendingRuns.add(id); if (!flushTimer) flushTimer = setTimeout(flush, 60); }
async function flush() {
  flushTimer = 0;
  const ids = [...pendingRuns]; pendingRuns.clear();
  let newProject = false;
  await Promise.all(ids.map(async (id) => {
    try {
      const r = await core.getRun(id);
      ui.runs.set(id, r);
      if (!ui.projects.some((p) => p.name === r.project)) newProject = true;
    } catch (e) { if (e.code === "not_found") ui.runs.delete(id); }
  }));
  if (newProject) { ui.projects = await core.listProjects().catch(() => ui.projects); renderProjectFilter(); }
  renderBoard();
  if (ui.open && ids.includes(ui.open)) renderRunView();
  withDiscussions(() => discussionRunsChanged(ids));
}
// Transcripts of the open run: refetched (throttled) when the conversation changes.
const convTimers = new Map();
function refreshConv(run, cid) {
  const k = String(cid);
  if (convTimers.has(k)) { convTimers.get(k).again = true; return; }
  const entry = { again: false };
  convTimers.set(k, entry);
  setTimeout(async function tick() {
    try {
      const t = await core.getConversation(run, cid);
      if (ui.open === run) onOpenConversation(cid, t);
    } catch {}
    if (entry.again && ui.open === run) { entry.again = false; setTimeout(tick, 350); return; }
    convTimers.delete(k);
  }, 120);
}
function onEvent(e) {
  if (e.type.startsWith("discussion.")) return withDiscussions(() => onDiscussionEvent(e));
  if (e.type === "conversation.updated") {
    ui.touched.set(String(e.conversationId), Date.now());
    const r = ui.runs.get(e.run);
    if (ui.open === e.run && r) {
      const k = String(e.conversationId);
      if (same(k, ui.thread) || same(k, r.conversations.active) || same(k, r.conversations.builder) || same(k, chatTarget(r).cid)) refreshConv(e.run, e.conversationId);
      else ui.tx.delete(k);
    }
    if (r && liveSignature() !== ui.liveSig) scheduleBoard();
    return;
  }
  if (e.type === "settings.changed") { if (!$("#view-settings").hidden) renderSettings(); return; }
  refreshRun(e.run);
  const key = keyOf(e.run);
  if (e.type === "run.ask" && ui.open !== e.run) toast(`${key}: ${e.question.kind === "discussion" ? "the architect has a question" : e.question.kind === "approval" ? `${e.question.gate} needs your approval` : "escalated to you"}`);
  if (e.type === "run.askResolved" && e.by !== "web" && e.by !== "core" && ui.open === e.run) toast(`${key}: ${e.by === "architect" ? "the architect revised the spec" : `answered from ${e.by}`}`);
  if (e.type === "run.notice" && e.notice.final) toast(`${key}: ${e.notice.text}`, e.notice.level === "error" ? "error" : "");
}
let boardTimer = 0;
function scheduleBoard() { if (!boardTimer) boardTimer = setTimeout(() => { boardTimer = 0; if (!$("#view-board").hidden) renderBoard(); }, 120); }
async function resync() {
  try {
    const [projects, runs, discs] = await Promise.all([core.listProjects(), core.listRuns(), core.listDiscussions()]);
    ui.projects = projects; ui.runs = new Map(runs.map((r) => [r.id, r])); ui.discs = new Map(discs.map((d) => [d.id, d]));
    renderProjectFilter(); renderBoard();
    if (ui.mode === "discussion") withDiscussions(resyncDiscussion);
    else if (ui.open) { if (ui.runs.has(ui.open)) { renderRunView(); loadThread(false); } else closeRun(); }
    if (!$("#view-settings").hidden) renderSettings();
  } catch (e) { toast(String(e.message ?? e), "error"); }
}

// ===================================================================== modals and the create dialog
const modalStack = [];
const CLOSE_SVG = `<svg viewBox="0 0 16 16"><path d="m4.1 3 3.9 3.9L11.9 3 13 4.1 9.1 8l3.9 3.9-1.1 1.1L8 9.1 4.1 13 3 11.9 6.9 8 3 4.1z"/></svg>`;
function openModal(html, wide) {
  const root = document.createElement("div");
  root.className = "scrim";
  root.innerHTML = html;
  if (wide) root.firstElementChild.classList.add("wide");
  root.addEventListener("mousedown", (e) => { if (e.target === root) closeModal(); });
  $("#modal-root").append(root); modalStack.push(root);
  setTimeout(() => root.querySelector("input, textarea, select, button.primary")?.focus(), 30);
  return root;
}
function closeModal() { modalStack.pop()?.remove(); }

function openCreate() {
  const opts = ui.projects.map((p) => `<option value="${esc(p.name)}">${esc(p.name)} · ${esc(p.repo)}</option>`).join("");
  const none = ui.projects.length === 0;
  const root = openModal(`<form class="modal" id="create-form" novalidate>
    <div class="modal-head"><h2>Create ticket</h2><button type="button" class="icon-btn" data-close aria-label="Close">${CLOSE_SVG}</button></div>
    <div class="modal-body">
      <div class="field"><label for="c-project">Project</label><select id="c-project">${opts}<option value="__new"${none ? " selected" : ""}>New project…</option></select></div>
      <div class="ff-row" id="c-newproj"${none ? "" : " hidden"}>
        <div class="field"><label for="c-pname">Name</label><input id="c-pname" placeholder="todo" autocomplete="off"></div>
        <div class="field"><label for="c-prepo">Repo</label><input id="c-prepo" placeholder="owner/name" autocomplete="off"></div>
        <p class="hint" style="grid-column:1/-1;margin:0">If the repo doesn't exist, the factory creates it as a private repo at the first delivery.</p>
      </div>
      <div class="field"><label for="c-title">Summary</label><input id="c-title" placeholder="Add due dates and an --overdue filter" autocomplete="off"></div>
      <div class="field"><label for="c-body">Description</label><textarea id="c-body" rows="5" placeholder="What should the product do? The architect will ask about anything unclear."></textarea></div>
      <p class="hint">After you submit, the architect asks you a few questions one at a time, then you approve the spec. Building, review and delivery run on their own, and you can message the agent at any point.</p>
    </div>
    <div class="modal-foot"><button type="button" class="btn" data-close>Cancel</button><button type="submit" class="btn primary">Submit to factory</button></div>
  </form>`);
  const form = $("#create-form", root);
  if (ui.filter.project) $("#c-project", root).value = ui.filter.project;
  root.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", closeModal));
  $("#c-project", root).addEventListener("change", (e) => ($("#c-newproj", root).hidden = e.target.value !== "__new"));
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    let project = $("#c-project", root).value;
    const title = $("#c-title", root).value.trim(), body = $("#c-body", root).value;
    if (!title) { toast("Add a summary first.", "error"); $("#c-title", root).focus(); return; }
    const submit = form.querySelector("button[type=submit]");
    submit.disabled = true;
    const ok = await act(async () => {
      if (project === "__new") {
        const p = await core.createProject($("#c-pname", root).value.trim(), $("#c-prepo", root).value.trim());
        project = p.name; ui.projects = await core.listProjects(); renderProjectFilter();
        $("#c-project", root).insertAdjacentHTML("afterbegin", `<option value="${esc(p.name)}">${esc(p.name)}</option>`);
        $("#c-project", root).value = p.name; $("#c-newproj", root).hidden = true;
      }
      const id = await core.startRun(project, { source: "web", title, body });
      ui.runs.set(id, await core.getRun(id));
      closeModal(); renderBoard();
      toast(`Submitted ${keyOf(id)}. Watch it move, or open it.`);
    });
    if (!ok) submit.disabled = false;
  });
}

// ===================================================================== run view: a full-screen sheet with the run's agent chat
Object.assign(ui, { thread: null, tx: new Map(), expanded: new Set(), composerKey: null, rejecting: false, structured: false, escN: 2, confirmCancel: false, stick: true, lastActive: null, details: false, txConv: null, dockKey: null, dockAsk: null, dockMin: false, lastGateMsg: "" });
const openRunData = () => ui.runs.get(ui.open);
const ICON = {
  ok: '<svg viewBox="0 0 16 16"><path fill-rule="evenodd" d="M8 1.5a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13zm3.03 4.47L7.1 9.9 4.97 7.78 3.9 8.84l3.2 3.2 5-5z"/></svg>',
  err: '<svg viewBox="0 0 16 16"><path fill-rule="evenodd" d="M8 1.5a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13zM5.9 4.8 4.8 5.9 6.9 8l-2.1 2.1 1.1 1.1L8 9.1l2.1 2.1 1.1-1.1L9.1 8l2.1-2.1-1.1-1.1L8 6.9z"/></svg>',
  wait: '<svg viewBox="0 0 16 16"><path fill-rule="evenodd" d="M8 1.5a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13zm-.75 3v4.1l2.9 2.1.9-1.2-2.3-1.7V4.5z"/></svg>',
  idle: '<svg viewBox="0 0 16 16"><path fill-rule="evenodd" d="M8 1.5a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13zm0 1.5a5 5 0 1 0 0 10A5 5 0 0 0 8 3z"/></svg>',
  doc: '<svg viewBox="0 0 16 16"><path d="M4 1.5h5.6L13 4.9V14.5H4zm1.5 1.5v10h6V5.5H9V3z"/></svg>',
  warn: '<svg viewBox="0 0 16 16"><path fill-rule="evenodd" d="M8 1.5 15.2 14H.8zm-.75 4.5v4h1.5V6zm0 5v1.5h1.5V11z"/></svg>',
  ext: '<svg viewBox="0 0 16 16"><path d="M6 3h7v7h-1.5V5.56l-6.47 6.47-1.06-1.06 6.47-6.47H6z"/></svg>',
  send: '<svg viewBox="0 0 16 16"><path d="M8 2.5 13 7.5l-1.06 1.06-3.19-3.19V13.5h-1.5V5.37L4.06 8.56 3 7.5z"/></svg>',
  check: '<svg viewBox="0 0 16 16"><path d="M6.3 11.2 2.8 7.7l1.06-1.06 2.44 2.44 5.84-5.84L13.2 4.3z"/></svg>',
  retry: '<svg viewBox="0 0 16 16"><path d="M8 2.5a5.5 5.5 0 1 1-5.2 7.3l1.42-.5A4 4 0 1 0 5.2 5.2L7 7H2.5V2.5l1.6 1.6A5.48 5.48 0 0 1 8 2.5z"/></svg>',
  stop: '<svg viewBox="0 0 16 16"><path d="M4 4h8v8H4z"/></svg>',
  chat: '<svg viewBox="0 0 16 16"><path d="M2.5 2.5h11a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H7.2L4 14v-2.5H2.5a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1zm.5 1.5v6h2.5v1.2L6.7 10H13V4z"/></svg>',
};

// ---------------------------------------------------------------- open and close (the sheet grows out of the card and shrinks back into it)
function setDetails(on) {
  ui.details = on;
  $("#rv-body").classList.toggle("with-details", on);
  $("#rv-details-btn").setAttribute("aria-pressed", String(on));
  if (innerWidth >= 1180) try { localStorage.setItem("factory.details", on ? "1" : "0"); } catch {}
}
function preferDetails() {
  if (innerWidth < 1180) return false;
  try { const v = localStorage.getItem("factory.details"); if (v !== null) return v === "1"; } catch {}
  return true;
}
const cardEl = (id) => [...document.querySelectorAll(".card")].find((el) => el.dataset.id === id);
function insetOf(el) {
  const b = el?.getBoundingClientRect();
  if (!b || !b.width || b.bottom < 0 || b.top > innerHeight || b.right < 0 || b.left > innerWidth) return null;
  return `inset(${b.top}px ${innerWidth - b.right}px ${innerHeight - b.bottom}px ${b.left}px round 10px)`;
}
async function openRun(id, fromEl) {
  const r = ui.runs.get(id); if (!r || ui.open) return;
  Object.assign(ui, { open: id, composerKey: null, rejecting: false, structured: false, escN: 2, confirmCancel: false, stick: true, txConv: null, lastActive: r.conversations.active, dockKey: null, dockAsk: null, dockMin: false, lastGateMsg: "" });
  try { history.replaceState(null, "", `#run=${encodeURIComponent(id)}`); } catch {}
  $("#dock").hidden = true; $("#dock").innerHTML = ""; $("#composer").innerHTML = "";
  ui.tx.clear();
  const convs = [r.conversations.architect, r.conversations.builder, ...r.conversations.reviewers.map((x) => x.id), ...(r.conversations.qa ?? []).map((x) => x.id)].filter((x) => x != null);
  ui.thread = r.conversations.active ?? convs.at(-1) ?? "timeline";
  const rv = $("#runview"), bd = $("#rv-backdrop");
  setDetails(preferDetails()); showJump(false);
  $("#tx").replaceChildren();
  bd.hidden = false; rv.hidden = false;
  renderRunView();
  requestAnimationFrame(() => bd.classList.add("on"));
  if (!reduceMotion()) {
    rv.animate([{ clipPath: insetOf(fromEl) ?? "inset(3% 3% 3% 3% round 18px)" }, { clipPath: "inset(0px 0px 0px 0px round 0px)" }], { duration: 520, easing: "cubic-bezier(.2, .85, .25, 1)" });
    rv.querySelectorAll(".rv-top, .rv-body").forEach((el) => el.animate([{ opacity: 0 }, { opacity: 0, offset: 0.3 }, { opacity: 1 }], { duration: 520, easing: "ease-out" }));
  }
  await loadThread(true);
  const extra = [r.conversations.builder, r.conversations.active].filter((c) => c != null && !same(c, ui.thread));
  for (const c of new Set(extra.map(String))) {
    try { ui.tx.set(c, await core.getConversation(id, c)); } catch {}
  }
  if (ui.open !== id || ui.mode === "discussion") return;
  renderThreads(openRunData()); updateComposerLive(openRunData());
  ($("#cmp-answer") ?? $("#cmp-chat") ?? $("#rv-close")).focus({ preventScroll: true });
}
let closing = false;
async function closeRun() {
  if (!ui.open || closing) return;
  closing = true;
  const id = ui.open, rv = $("#runview"), bd = $("#rv-backdrop"), wasDiscussion = ui.mode === "discussion";
  // A run shrinks back into its board card, the chat view into the Chat button.
  const home = () => (wasDiscussion ? $("#chat-btn") : cardEl(id));
  $("#rv-threads").classList.remove("open");
  if (wasDiscussion) withDiscussions(chatClosing);
  bd.classList.remove("on");
  try { history.replaceState(null, "", location.pathname); } catch {}
  if (!reduceMotion()) {
    const to = insetOf(home());
    const a = rv.animate([{ clipPath: "inset(0px 0px 0px 0px round 0px)", opacity: 1 }, { clipPath: to ?? "inset(3% 3% 3% 3% round 18px)", opacity: to ? 1 : 0 }], { duration: 380, easing: "cubic-bezier(.4, 0, .2, 1)" });
    rv.querySelectorAll(".rv-top, .rv-body").forEach((el) => el.animate([{ opacity: 1 }, { opacity: 0, offset: 0.45 }, { opacity: 0 }], { duration: 380 }));
    await a.finished.catch(() => {});
  }
  ui.open = null; ui.mode = null; delete rv.dataset.mode; sheetLabels(false); ui.tx.clear(); rv.hidden = true; bd.hidden = true; closing = false;
  renderBoard();
  const c = home();
  if (c) { c.focus({ preventScroll: true }); if (!reduceMotion()) c.animate([{ boxShadow: "0 0 0 3px var(--accent-line)" }, { boxShadow: "0 0 0 0 transparent" }], { duration: 900, easing: "ease-out" }); }
}

// ---------------------------------------------------------------- header, progress, threads
function stageInfo(r) {
  const idx = PIPELINE.findIndex(([k]) => k === columnOf(r));
  return { idx, name: PIPELINE[idx][1], cls: pending(r) ? "wait" : r.state === "ESCALATED" || r.state === "FAILED" ? "bad" : "" };
}
function renderRunView() {
  const r = openRunData(); if (!r) return;
  $("#rv-key").textContent = keyOf(r.id);
  $("#rv-title").textContent = r.request.title;
  $("#rv-state").innerHTML = stateLabel(r);
  $("#rv-cost").textContent = money(totalUsd(r));
  const { idx, name, cls } = stageInfo(r), done = r.state === "DELIVERED";
  const label = done ? "Delivered" : r.state === "FAILED" ? `Failed in ${name}` : r.state === "CANCELLED" ? "Cancelled" : `${name}${r.round > 1 ? ` · round ${r.round}` : ""}`;
  $("#rv-progress").innerHTML = `<div class="rv-track">${PIPELINE.map(([, n], i) => `<span class="rv-seg${done || i < idx ? " done" : i === idx ? ` now ${cls}` : ""}" title="${n}"></span>`).join("")}</div><span class="rv-stage">${label}</span>`;
  const act = r.conversations.active;
  if (act != null && !same(act, ui.lastActive) && (ui.lastActive == null || same(ui.thread, ui.lastActive))) { ui.thread = act; loadThread(true); }
  if (act != null) ui.lastActive = act;
  renderThreads(r); renderComposer(r); renderDock(r); renderDetails(r);
  if (ui.thread === "timeline") renderTimeline(r, false);
  else { const t = ui.tx.get(String(ui.thread)); if (t) renderTranscript(r, t, false); }
}
function modelOf(r, cid, role) {
  const c = r.cost.find((x) => same(x.conversationId, cid)) ?? [...r.cost].reverse().find((x) => x.role === role);
  return c ? `${c.model} · ${c.thinking}` : "";
}
function threadStatus(r, id, role) {
  if (convLive(id)) return ["Working", "live"];
  if (role === "architect" && pending(r)?.question.kind === "discussion") return ["Waiting for you", "wait"];
  return [modelOf(r, id, role) || "Idle", ""];
}
function renderThreads(r) {
  const c = r.conversations, rows = [], focused = document.activeElement?.closest?.(".thread")?.dataset.thread;
  const row = (id, role, name, nested) => {
    const [sub, cls] = id === "timeline" ? [`${plural(r.history.length, "transition")} · ${plural(r.notices.length, "notice")}`, ""] : threadStatus(r, id, role);
    rows.push(`<button type="button" class="thread${nested ? " nested" : ""}" data-thread="${esc(id)}" aria-current="${String(ui.thread) === String(id)}">
      ${role ? avatar(role, false) : `<span class="avatar core">F</span>`}<span style="min-width:0"><span class="t-name">${esc(name)}</span><span class="t-sub ${cls}">${esc(sub)}</span></span>${cls === "live" ? `<span class="live-dot" title="Working"></span>` : ""}</button>`);
  };
  rows.push(`<div class="rail-label">Run</div>`);
  row("timeline", null, "Timeline");
  rows.push(`<div class="rail-label">Conversations</div>`);
  if (c.architect != null) row(c.architect, "architect", "Architect");
  if (c.builder != null) { row(c.builder, "builder", "Builder"); (ui.tx.get(String(c.builder))?.helpers ?? []).forEach((h, i) => row(h, "helper", `Helper ${i + 1}`, true)); }
  const qaBySeq = new Map((c.qa ?? []).map((x) => [x.seq, x.id]));
  c.reviewers.forEach((x) => { row(x.id, "reviewer", `Reviewer · review ${x.seq}`); if (qaBySeq.has(x.seq)) row(qaBySeq.get(x.seq), "qa", `QA · review ${x.seq}`, true); });
  if (c.architect == null) rows.push(`<p class="hint" style="padding:4px 10px;margin:0">Conversations appear as each role starts.</p>`);
  const a = ago(r.createdAt);
  rows.push(`<div class="rail-foot"><span><b>${esc(r.project)}</b> · ${esc(r.repo)}</span><span>Opened ${a === "now" ? "just now" : `${a} ago`} from ${esc(r.request.source)}</span></div>`);
  $("#rv-threads").innerHTML = rows.join("");
  if (focused) [...$("#rv-threads").querySelectorAll(".thread")].find((el) => el.dataset.thread === focused)?.focus({ preventScroll: true });
}

// ---------------------------------------------------------------- transcript: keyed blocks, so live updates only touch what changed
function argSummary(args) {
  const s = Object.values(args ?? {}).map((v) => (typeof v === "string" ? v : JSON.stringify(v))).join(" · ").replace(/\s+/g, " ");
  return s.length > 160 ? `${s.slice(0, 160)}…` : s;
}
function stepHtml(call, res, t, r) {
  let ico, more;
  if (res) { ico = `<span class="s-ico ${res.isError ? "err" : "ok"}">${res.isError ? ICON.err : ICON.ok}</span>`; more = `<span class="s-more">${res.isError ? "failed" : "details"} <span class="chev">›</span></span>`; }
  else if (call.name === "ask_human" && pending(r)?.question.kind === "discussion") { ico = `<span class="s-ico wait">${ICON.wait}</span>`; more = `<span class="s-more wait">waiting for you</span>`; }
  else if (t.busy) { ico = `<span class="s-ico"><span class="spin"></span></span>`; more = `<span class="s-more run">running</span>`; }
  else { ico = `<span class="s-ico idle">${ICON.idle}</span>`; more = `<span class="s-more">pending</span>`; }
  const det = res?.details ? `<span class="mono">${esc(JSON.stringify(res.details))}</span>` : "";
  return `<details data-key="${esc(call.id)}"${ui.expanded.has(call.id) ? " open" : ""}><summary>${ico}<span class="s-name">${esc(call.name)}</span><span class="s-args">${esc(argSummary(call.args))}</span>${more}</summary>
    <div class="s-panel"><div class="s-sec"><div class="s-sec-h"><span>Input</span><button type="button" class="copy" data-copy>Copy</button></div><pre>${esc(JSON.stringify(call.args, null, 2))}</pre></div>
    ${res ? `<div class="s-sec"><div class="s-sec-h"><span>Output</span>${det}<button type="button" class="copy" data-copy>Copy</button></div><pre class="${res.isError ? "err" : ""}">${linkify(esc(res.text))}</pre>${call.name === "computer" && !res.isError ? shotsHtml(r.id, [...String(res.text).matchAll(/Screenshot (r\d+-s\d+)/g)].map((m) => m[1])) : ""}</div>` : ""}</div></details>`;
}
function factoryCard(it, role) {
  const text = it.text ?? "";
  const human = /^The human rejected|source: human|from the human at/.test(text);
  const long = text.length > 420 || text.split("\n").length > 9, k = `more:${it.entryId}`, open = ui.expanded.has(k);
  return `<div class="f-card${human ? " human" : ""}"><div class="f-head">${role === "helper" ? avatar("builder", false) : `<span class="avatar core">F</span>`}<b>${role === "helper" ? "Builder" : "Factory"}</b> → ${roleName(role)}${human ? " · carries your feedback" : ""}</div>
    <div class="f-body${long && !open ? " clamp" : ""}">${md(text)}</div>${long ? `<button type="button" class="f-more" data-more="${esc(k)}">${open ? "Show less" : "Show more"}</button>` : ""}</div>`;
}
const youBubble = (text, meta) => `<div class="you-bubble">${md(text)}</div><div class="you-meta">${meta}</div>`;
const viaText = (by) => (by === "web" ? "You" : `You via ${esc(by)}`);
function blocksFor(r, t) {
  const role = t.role ?? roleOf(r, t.conversationId) ?? "helper", out = [];
  const results = new Map(t.items.filter((i) => i.toolResult).map((i) => [i.toolResult.callId, i.toolResult]));
  const calls = new Set(t.items.flatMap((i) => (i.toolCalls ?? []).map((c) => c.id)));
  const shown = new Set();
  let last = null, openCall = false;
  for (const it of t.items) {
    if (it.role === "user" && it.author === "human") {
      shown.add(it.msgId);
      const at = (r.messages ?? []).find((m) => m.id === it.msgId)?.at;
      out.push({ k: `msg:${it.msgId}`, cls: "you", html: youBubble(it.text, `${viaText(it.by)}${at ? ` · ${stamp(at)}` : ""}`) }); last = "you"; continue;
    }
    if (it.role === "user") { out.push({ k: it.entryId, html: factoryCard(it, role) }); last = "factory"; continue; }
    if (it.role === "tool") { if (!calls.has(it.toolResult?.callId)) out.push({ k: it.entryId, cls: "indent", html: `<pre>${linkify(esc(it.toolResult?.text ?? ""))}</pre>` }); continue; }
    if (!it.text && !(it.toolCalls ?? []).length) continue;
    if (last !== "agent") out.push({ k: `${it.entryId}:h`, html: `<div class="speaker">${avatar(role, false)}<b>${roleName(role)}</b></div>` });
    last = "agent";
    if (it.text) out.push({ k: `${it.entryId}:t`, cls: "indent", html: `<div class="a-text">${md(it.text)}</div>`, stream: true });
    for (const c of it.toolCalls ?? []) { const res = results.get(c.id); if (!res) openCall = true; out.push({ k: `${it.entryId}:${c.id}`, cls: "indent step", html: stepHtml(c, res, t, r) }); }
  }
  // Waiting: in the conversation's inbox until the agent's next step boundary, or held until the core starts the role.
  const waiting = [...(t.queued ?? []).map((q) => ({ id: q.msgId, by: q.by, text: q.text }))];
  const target = chatTarget(r);
  if (target.role === role && (target.cid == null || same(target.cid, t.conversationId)))
    for (const m of r.messages ?? []) if (m.conversationId == null && m.to === role) waiting.push(m);
  for (const m of waiting) {
    if (shown.has(m.id)) continue;
    shown.add(m.id);
    out.push({ k: `msg:${m.id}`, cls: "you queued", html: youBubble(m.text, `${viaText(m.by)} · queued until the ${role} finishes its current step`) });
  }
  if (t.busy && !openCall) out.push({ k: "__working", html: `<div class="working"><span class="dots"><i></i><i></i><i></i></span><span class="shimmer">${roleName(role)} is working</span></div>` });
  if (!out.length) out.push({ k: "__empty", html: `<p class="hint">Nothing here yet.</p>` });
  return out;
}
function mkBlock(b) {
  const d = document.createElement("div");
  d.className = `blk ${b.cls ?? ""}`; d.dataset.k = b.k; d.innerHTML = b.html; d._h = b.html;
  return d;
}
function patch(container, blocks, live) {
  const old = new Map([...container.children].map((el) => [el.dataset.k, el]));
  let prev = null, added = 0;
  for (const b of blocks) {
    let el = old.get(String(b.k)); // keys come back from the DOM as strings; entry ids are numbers
    if (el) {
      old.delete(String(b.k));
      if (el._h !== b.html) {
        const n = mkBlock(b);
        if (live && /\bstep\b/.test(b.cls ?? "")) n.classList.add("upd");
        if (live && b.stream && el.textContent.length < n.textContent.length) queueMicrotask(() => streamIn(n, el.textContent.length));
        el.replaceWith(n); el = n;
      }
    } else {
      el = mkBlock(b); added++;
      if (live) { el.classList.add("enter"); if (b.stream) queueMicrotask(() => streamIn(el, 0)); }
    }
    const want = prev ? prev.nextElementSibling : container.firstElementChild;
    if (el !== want) container.insertBefore(el, want);
    prev = el;
  }
  old.forEach((el) => el.remove());
  return added;
}
// Reveal newly arrived assistant text progressively (from `from` characters on), like a stream.
function streamIn(el, from) {
  if (reduceMotion()) return;
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT), nodes = [];
  for (let n; (n = walker.nextNode());) nodes.push([n, n.textContent]);
  const total = nodes.reduce((a, [, s]) => a + s.length, 0);
  if (total <= from) return;
  const dur = Math.min(1300, 250 + (total - from) * 7), start = performance.now(), box = $("#transcript");
  const show = (count) => { let left = count; for (const [node, s] of nodes) { const k = Math.min(s.length, left); node.textContent = s.slice(0, k); left -= k; } };
  show(from);
  const step = (now) => {
    show(from + Math.ceil((total - from) * Math.min(1, (now - start) / dur)));
    if (ui.stick) box.scrollTop = box.scrollHeight;
    if (now - start < dur && el.isConnected) requestAnimationFrame(step); else nodes.forEach(([node, s]) => (node.textContent = s));
  };
  requestAnimationFrame(step);
}
function showJump(on) {
  const j = $("#jump");
  if (on && !j) {
    $("#composer-wrap").insertAdjacentHTML("afterbegin", `<button type="button" class="jump" id="jump">${ICON.send} New activity</button>`);
    $("#jump").addEventListener("click", () => { const b = $("#transcript"); b.scrollTo({ top: b.scrollHeight, behavior: reduceMotion() ? "auto" : "smooth" }); });
  } else if (!on && j) j.remove();
}
function settleScroll(first, added) {
  const box = $("#transcript");
  if (first || ui.stick) { box.scrollTop = box.scrollHeight; showJump(false); } else if (added) showJump(true);
}
async function loadThread(first) {
  const r = openRunData(); if (!r) return;
  if (ui.thread === "timeline") return renderTimeline(r, first);
  const id = ui.thread;
  let t;
  try { t = await core.getConversation(r.id, id); }
  catch (e) { toast(String(e.message ?? e), "error"); return; }
  if (ui.open !== r.id || ui.mode === "discussion" || String(ui.thread) !== String(id)) return;
  ui.tx.set(String(id), t);
  renderTranscript(openRunData(), t, first);
  renderThreads(openRunData());
}
function renderTranscript(r, t, first) {
  const role = t.role ?? roleOf(r, t.conversationId) ?? "helper", model = modelOf(r, t.conversationId, role);
  const asking = role === "architect" && pending(r)?.question.kind === "discussion";
  const [st, cls] = t.busy ? [`<span class="spin"></span> Working`, "live"] : asking ? ["Waiting for you", "wait"] : [same(r.conversations.active, t.conversationId) && !TERMINAL.includes(r.state) ? "Idle" : "Finished", ""];
  $("#conv-head").innerHTML = `${avatar(role, t.busy)}<span class="who">${roleName(role)}</span>${model ? `<span class="chip-model">${esc(model)}</span>` : ""}<span class="conv-status ${cls}">${st}</span>`;
  const tx = $("#tx");
  if (first || ui.txConv !== String(t.conversationId)) { tx.replaceChildren(); ui.txConv = String(t.conversationId); first = true; }
  settleScroll(first, patch(tx, blocksFor(r, t), !first));
}
function onOpenConversation(cid, t) {
  const r = openRunData(); if (!r) return;
  ui.tx.set(String(cid), t);
  if (String(ui.thread) === String(cid)) renderTranscript(r, t, false);
  renderThreads(r); updateComposerLive(r);
}
function renderTimeline(r, first) {
  $("#conv-head").innerHTML = `<span class="avatar core">F</span><span class="who">Timeline</span><span class="chip-model">${esc(r.id)}</span><span class="conv-status">${plural(r.history.length, "transition")}</span>`;
  const ev = [
    ...r.history.map((h, i) => ({ k: `h${i}`, at: h.at, dot: h.to === "FAILED" || h.to === "ESCALATED" ? "bad" : h.to === "DELIVERED" ? "ok" : "", html: `<span class="st">${esc(h.from ?? "start")} → ${esc(h.to)}</span> <span class="meta">round ${h.round}</span>` })),
    ...r.notices.map((n, i) => ({ k: `n${i}`, at: n.at, dot: n.level === "error" ? "bad" : "notice", html: `${linkify(esc(n.text))}${n.advisory?.length ? ` <span class="meta">· ${plural(n.advisory.length, "advisory note")}</span>` : ""}` })),
    ...(r.messages ?? []).map((m) => ({ k: `m:${m.id}`, at: m.at, dot: "", html: `<b>${viaText(m.by)} → ${esc(m.to)}:</b> ${esc(m.text.length > 200 ? `${m.text.slice(0, 200)}…` : m.text)}` })),
  ].sort((a, b) => a.at - b.at);
  const pa = pending(r);
  if (pa) ev.push({ k: `ask:${pa.id}`, at: pa.createdAt, dot: "ask", html: `<b>Waiting for you.</b> ${esc(pa.question.kind === "discussion" ? pa.question.text : pa.question.kind === "approval" ? `${cap1(pa.question.gate)} approval` : pa.question.reason)}` });
  const tx = $("#tx");
  if (first || ui.txConv !== "timeline") { tx.replaceChildren(); ui.txConv = "timeline"; first = true; }
  settleScroll(first, patch(tx, ev.map((x) => ({ k: x.k, cls: "tlb", html: `<div class="tl"><span class="tl-time">${stamp(x.at)}</span><span class="tl-dot ${x.dot}"></span><div>${x.html}</div></div>` })), !first));
}
function copyFrom(btn, text, selectEl) {
  (navigator.clipboard?.writeText(text) ?? Promise.reject()).then(() => { btn.textContent = "Copied"; setTimeout(() => (btn.textContent = "Copy"), 1400); })
    .catch(() => { if (!selectEl) return; const range = document.createRange(); range.selectNodeContents(selectEl); const s = getSelection(); s.removeAllRanges(); s.addRange(range); btn.textContent = "Selected"; });
}

// ---------------------------------------------------------------- composer: always a chat with the agent the run is with
const LIVE_STAGE = { RECEIVED: "Queued", PREPARING: "Preparing the workspace", SPEC_READY: "Checking the spec gate", DELIVERING: "Delivering", AWAITING_CI: "Waiting for CI checks" };
// Mirrors the routing rule of `message`: the agent the run is with. (The core decides; this only labels the chat box.)
function chatTarget(r) {
  const c = r.conversations;
  if (["RECEIVED", "PREPARING", "DISCUSSING", "SPEC_READY"].includes(r.state) || (r.state === "AWAITING_APPROVAL" && r.gate === "spec")) return { role: "architect", cid: c.architect ?? null };
  if (r.state === "REVIEWING") return { role: "reviewer", cid: c.reviewers.find((x) => same(x.id, c.active))?.id ?? null };
  return { role: "builder", cid: c.builder ?? null };
}
function updateComposerLive(r) {
  const line = $("#c-live"); if (!line || !r) return;
  const role = activeRole(r), cid = r.conversations.active, busy = role && convLive(cid);
  const t = cid != null ? ui.tx.get(String(cid)) : null;
  const done = new Set((t?.items ?? []).filter((i) => i.toolResult).map((i) => i.toolResult.callId));
  const tool = (t?.items ?? []).flatMap((i) => i.toolCalls ?? []).filter((c) => !done.has(c.id)).at(-1)?.name;
  const pa = pending(r), gate = pa && pa.question.kind !== "discussion";
  line.innerHTML = busy ? `<span class="shimmer">${roleName(role)} is ${tool ? `running ${esc(tool)}` : "working"}</span>`
    : LIVE_STAGE[r.state] ? `<span class="shimmer">${LIVE_STAGE[r.state]}</span>`
    : gate ? `<span style="color:var(--turn)">Waiting for your decision on the card above</span>` : `${cap1(role ?? "factory")} is between steps`;
  const tg = chatTarget(r), hint = $("#c-hint");
  if (hint) {
    const tBusy = tg.cid != null && convLive(tg.cid);
    hint.textContent = tg.cid == null ? `Delivered when the ${tg.role} starts` : tBusy || ["DISCUSSING", "BUILDING", "REVIEWING"].includes(r.state) && !gate ? `Delivered when the ${tg.role} finishes its current step` : `The ${tg.role} replies right away`;
  }
}
function endComposer(r) {
  const d = r.artifacts.delivery;
  if (r.state === "DELIVERED") return `<div class="cbox ok"><div class="c-status"><span class="c-ico ok">${ICON.check}</span><div class="c-main"><span class="c-line">Delivered</span><span class="c-sub">${d?.kind === "pr" ? `PR #${d.pr?.number ?? ""}` : "Pushed to main"} · ${plural(r.advisory.length, "advisory note")}${r.acceptedBlocking.length ? ` · ${plural(r.acceptedBlocking.length, "accepted finding")}` : ""} · start a new ticket for follow-up work</span></div>${d?.url ? `<a class="btn lg" href="${esc(d.url)}" target="_blank" rel="noopener noreferrer">${d.kind === "pr" ? "Open PR" : "Open repo"} ${ICON.ext}</a>` : ""}</div></div>`;
  const failed = r.state === "FAILED";
  return `<div class="cbox${failed ? " bad" : ""}"><div class="c-status"><span class="c-ico ${failed ? "bad" : "muted"}">${failed ? ICON.warn : ICON.stop}</span><div class="c-main"><span class="c-line">${failed ? `Failed in ${esc(r.failure?.state ?? "a stage")}` : "Cancelled"}</span><span class="c-sub">${esc(r.failure?.reason ?? "")}</span></div><button type="button" class="btn primary lg" id="c-retry">${ICON.retry} Retry</button></div></div>`;
}
function autosize(ta, send) { ta.style.height = "auto"; ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`; if (send) send.disabled = !ta.value.trim(); }
function renderComposer(r) {
  const pa = pending(r), disc = pa?.question.kind === "discussion", tg = chatTarget(r);
  const key = TERMINAL.includes(r.state) ? `end:${r.state}` : disc ? `ask:${pa.id}` : `chat:${tg.role}`;
  if (key === ui.composerKey) return updateComposerLive(r);
  const draft = $("#cmp-chat")?.value ?? "";
  ui.composerKey = key;
  const el = $("#composer");
  if (TERMINAL.includes(r.state)) { el.innerHTML = endComposer(r); $("#c-retry")?.addEventListener("click", () => act(() => core.retryRun(r.id), "Retrying")); return; }
  if (disc) return discussionComposer(el, r, pa);
  el.innerHTML = `<div class="cbox">
    <div class="c-top"><span class="to-chip">To ${avatar(tg.role, false)}<b>${cap1(tg.role)}</b></span><span class="c-live-line" id="c-live"></span></div>
    <form class="c-input" id="chat-form"><textarea id="cmp-chat" rows="1" placeholder="Message the ${tg.role}…" aria-label="Message the ${tg.role}"></textarea><button type="submit" class="send" id="chat-send" disabled aria-label="Send message">${ICON.send}</button></form>
    <div class="c-foot"><span id="c-hint"></span><span><kbd>Enter</kbd> to send · <kbd>Shift</kbd> + <kbd>Enter</kbd> for a new line</span></div></div>`;
  const ta = $("#cmp-chat"), send = $("#chat-send");
  ta.value = draft; autosize(ta, send);
  ta.addEventListener("input", () => autosize(ta, send));
  ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); $("#chat-form").requestSubmit(); } });
  $("#chat-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = ta.value.trim(); if (!text || send.dataset.busy) return;
    send.dataset.busy = "1"; send.disabled = true;
    let out;
    const ok = await act(async () => { out = await core.message(r.id, text); });
    delete send.dataset.busy;
    if (!ok) { autosize(ta, send); return; }
    ta.value = ""; autosize(ta, send);
    const now = openRunData();
    const npa = now && pending(now);
    if (npa?.question.kind === "approval" && npa.question.gate !== "spec") ui.lastGateMsg = text;
    ui.stick = true;
    if (out.conversationId == null) toast(`Queued for the ${out.to}. It's delivered when the ${out.to} starts.`);
    else if (String(ui.thread) !== String(out.conversationId)) { ui.thread = out.conversationId; renderThreads(now); loadThread(true); }
    refreshRun(r.id);
    if (out.conversationId != null) refreshConv(r.id, out.conversationId);
  });
  updateComposerLive(r);
}
function discussionComposer(el, r, pa) {
  el.innerHTML = `<div class="cbox ask"><div class="c-head turn">${avatar("architect", false)}<b>Architect</b> is asking you</div>
    <div class="c-q">${inline(pa.question.text)}</div>
    <form class="c-input" id="answer-form"><textarea id="cmp-answer" rows="1" placeholder="Write your answer…" aria-label="Your answer"></textarea><button type="submit" class="send" id="cmp-send" disabled aria-label="Send answer">${ICON.send}</button></form>
    <div class="c-foot"><span><kbd>Enter</kbd> to send · <kbd>Shift</kbd> + <kbd>Enter</kbd> for a new line</span><span>One question at a time</span></div></div>`;
  const ta = $("#cmp-answer"), send = $("#cmp-send");
  ta.addEventListener("input", () => autosize(ta, send));
  ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); $("#answer-form").requestSubmit(); } });
  $("#answer-form").addEventListener("submit", async (e) => {
    e.preventDefault(); if (!ta.value.trim() || ta.readOnly) return;
    send.disabled = true; ta.readOnly = true;
    if (!(await act(() => core.answer(r.id, pa.id, ta.value)))) { send.disabled = false; ta.readOnly = false; }
    else refreshRun(r.id);
  });
  if (ui.open && !modalStack.length) requestAnimationFrame(() => ta.focus({ preventScroll: true }));
}

// ---------------------------------------------------------------- floating request card: approvals and escalations (button-based asks)
function setDockPad() {
  const d = $("#dock");
  $("#tx").style.paddingTop = d.hidden ? "" : `${d.offsetHeight + 30}px`;
  d.parentElement.classList.toggle("docked", !d.hidden);
}
function dockInfo(r, pa) {
  const q = pa.question, d = r.artifacts.delivery, sp = r.artifacts.spec;
  if (q.kind === "escalation") return { cls: "bad", icon: ICON.warn, title: "Escalated to you", meta: r.escalation?.cap === "review" ? "review round cap reached" : r.escalation?.cap === "ciFix" ? "CI fix cap reached" : "needs a decision" };
  const adv = r.advisory.filter((x) => !x.blocking);
  if (q.gate === "spec") return { cls: "turn", icon: ICON.doc, title: `Spec v${sp?.version ?? 1} needs your approval`, meta: `docs/spec.md · ${plural((sp?.text ?? "").split("\n").length, "line")}` };
  if (q.gate === "delivery") return { cls: "turn", icon: ICON.doc, title: "Ready to deliver", meta: `review passed${adv.length ? ` with ${plural(adv.length, "advisory note")}` : ""}` };
  return { cls: "turn", icon: ICON.doc, title: "Ready to merge", meta: `${d?.pr ? `PR #${d.pr.number}` : "PR"}${r.noCi ? " · no CI" : " · CI green"}` };
}
function renderDock(r) {
  const pa = pending(r), dock = $("#dock");
  const show = pa && pa.question.kind !== "discussion" && !TERMINAL.includes(r.state);
  if (!show) { if (!dock.hidden) { dock.hidden = true; dock.innerHTML = ""; ui.dockKey = null; setDockPad(); } return; }
  if (ui.dockAsk !== pa.id) { ui.dockAsk = pa.id; ui.dockMin = false; ui.rejecting = false; ui.structured = false; }
  const key = `${pa.id}:${ui.rejecting}:${ui.structured}:${ui.dockMin}`;
  if (key === ui.dockKey) return;
  const fresh = !ui.dockKey || !ui.dockKey.startsWith(`${pa.id}:`);
  ui.dockKey = key; dock.hidden = false;
  const info = dockInfo(r, pa);
  if (ui.dockMin) {
    dock.innerHTML = `<div class="dock-card mini ${info.cls}"><span class="d-ico">${info.icon}</span><span class="d-mini-text"><b>${esc(info.title)}</b><span> · ${esc(info.meta)}</span></span>${pa.question.kind === "approval" ? `<button type="button" class="btn primary small" id="dk-quick">${ICON.check} Approve</button>` : ""}<button type="button" class="btn small" id="dk-expand">Open</button></div>`;
    $("#dk-quick")?.addEventListener("click", (e) => { e.currentTarget.disabled = true; act(() => core.approve(r.id, pa.question.gate), `${cap1(pa.question.gate)} approved`).then(() => refreshRun(r.id)); });
    $("#dk-expand").addEventListener("click", () => { ui.dockMin = false; renderDock(openRunData()); });
  } else if (pa.question.kind === "approval") dockApproval(dock, r, pa.question.gate, info);
  else dockEscalation(dock, r, pa, info);
  $("#dk-min")?.addEventListener("click", () => { ui.dockMin = true; renderDock(openRunData()); });
  if (fresh && !reduceMotion()) dock.firstElementChild.animate([{ opacity: 0, transform: "translateY(-12px) scale(.98)" }, { opacity: 1, transform: "none" }], { duration: 360, easing: "cubic-bezier(.2, .8, .2, 1)" });
  setDockPad();
}
const dockHead = (info) => `<div class="d-head"><span class="d-ico">${info.icon}</span><div class="d-title"><b>${esc(info.title)}</b><span>${esc(info.meta)}</span></div><button type="button" class="icon-btn" id="dk-min" aria-label="Minimize" title="Minimize"><svg viewBox="0 0 16 16"><path d="M3 7.25h10v1.5H3z"/></svg></button></div>`;
function dockApproval(dock, r, g, info) {
  const d = r.artifacts.delivery, sp = r.artifacts.spec, who = g === "spec" ? "architect" : "builder";
  const adv = r.advisory.filter((x) => !x.blocking);
  const ws = r.workspace, art = pending(r).question.artifact ?? {};
  const where = g === "delivery" ? `<div class="loc"><span class="lbl">Review the changes in the workspace before you approve</span><span class="mono" id="dk-path">${esc(art.path ?? ws?.path ?? "")}</span>${ws ? `<span class="meta">branch <span class="mono">${esc(ws.branch)}</span> · base <span class="mono">${esc(String(ws.baseRef).slice(0, 12))}</span></span>` : ""}</div>` : "";
  const body = g === "spec" ? `<div class="c-preview">${md((sp?.text ?? "").split("\n").slice(0, 14).join("\n"))}</div>`
    : where + (r.qaStatus ? `<div class="meta">${esc(QA_LABEL[r.qaStatus] ?? r.qaStatus)}</div>` : "") + (adv.length ? `<div class="c-list">${adv.map((x) => `<div class="c-item"><span class="sev">${esc(x.severity)}</span><span>${x.source === "qa" ? "<b>QA</b> · " : ""}${inline(x.description)}${shotsHtml(r.id, x.screenshots)}</span></div>`).join("")}</div>` : "");
  const url = g === "merge" ? d?.url : art.url;
  const link = g === "spec" ? `<button type="button" class="btn ghost" data-open-spec>Read full spec</button>`
    : url ? `<a class="btn ghost" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${g === "merge" ? "Open PR" : "View changes"} ${ICON.ext}</a>`
    : art.path || ws?.path ? `<button type="button" class="btn ghost" id="dk-copy">Copy</button>` : "";
  const approveLabel = { spec: "Approve and start building", delivery: "Approve delivery", merge: "Approve and merge" }[g];
  const actions = `<div class="c-actions"><button type="button" class="btn primary" id="dk-approve">${ICON.check} ${approveLabel}</button><button type="button" class="btn" id="dk-reject">Request changes</button><span class="grow"></span>${link}</div>`;
  const prefill = g !== "spec" ? ui.lastGateMsg ?? "" : "";
  const reject = `<div class="reject">
      ${g !== "spec" ? `<div class="seg2" role="group" aria-label="Feedback format"><button type="button" data-fmt="comment" aria-pressed="${!ui.structured}">Comment</button><button type="button" data-fmt="structured" aria-pressed="${ui.structured}">Structured findings</button></div>` : ""}
      ${ui.structured ? `<div id="hf-list" style="display:grid;gap:8px">${hfRow(0)}</div><button type="button" class="btn small ghost" id="hf-add" style="justify-self:start">+ Add another finding</button>`
        : `<label for="dk-feedback">What should the ${who} change?</label><textarea id="dk-feedback" placeholder="${g === "spec" ? "e.g. Keep the JSON file format backwards compatible" : "e.g. The 409 response needs a machine-readable error code"}">${esc(prefill)}</textarea>`}
    </div>
    <div class="c-actions"><button type="button" class="btn dangerfill" id="dk-send-reject">Send back to the ${who}</button><button type="button" class="btn ghost" id="dk-cancel-reject">Cancel</button><span class="grow"></span><span class="hint">${g === "spec" ? "Returns the run to the discussion." : "Blocking finding for the same builder; no review or CI round added."}</span></div>`;
  dock.innerHTML = `<div class="dock-card ${info.cls}">${dockHead(info)}${ui.rejecting ? reject : body + actions}</div>`;
  dock.querySelector("[data-open-spec]")?.addEventListener("click", () => openSpec(r));
  $("#dk-copy")?.addEventListener("click", (e) => copyFrom(e.currentTarget, $("#dk-path")?.textContent ?? "", $("#dk-path")));
  $("#dk-approve")?.addEventListener("click", (e) => { const b = e.currentTarget; b.disabled = true; act(() => core.approve(r.id, g), `${cap1(g)} approved`).then((ok) => { if (!ok) b.disabled = false; else refreshRun(r.id); }); });
  $("#dk-reject")?.addEventListener("click", () => { ui.rejecting = true; renderDock(openRunData()); ($("#dk-feedback") ?? $("#hf-desc-0"))?.focus(); });
  $("#dk-cancel-reject")?.addEventListener("click", () => { ui.rejecting = false; ui.structured = false; renderDock(openRunData()); });
  dock.querySelectorAll("[data-fmt]").forEach((b) => b.addEventListener("click", () => { ui.structured = b.dataset.fmt === "structured"; renderDock(openRunData()); }));
  $("#hf-add")?.addEventListener("click", () => $("#hf-list").insertAdjacentHTML("beforeend", hfRow($("#hf-list").children.length)));
  $("#dk-send-reject")?.addEventListener("click", async (e) => {
    const b = e.currentTarget; b.disabled = true;
    let ok;
    if (ui.structured) {
      const findings = [...$("#hf-list").children].map((row) => ({ severity: $("select", row).value, description: $(".hf-desc", row).value.trim(), ...($(".hf-ref", row).value.trim() ? { specRef: $(".hf-ref", row).value.trim() } : {}), ...($(".hf-ev", row).value.trim() ? { evidence: $(".hf-ev", row).value.trim() } : {}) })).filter((x) => x.description || x.specRef || x.evidence);
      ok = await act(() => core.submitHumanFindings(r.id, g, findings.length ? findings : [{ severity: "major", description: "" }]), "Sent back to the builder");
    } else ok = await act(() => core.reject(r.id, g, $("#dk-feedback").value), `Sent back to the ${who}`);
    if (ok) { ui.rejecting = false; ui.structured = false; ui.lastGateMsg = ""; refreshRun(r.id); } else b.disabled = false;
  });
}
function hfRow(i) {
  return `<div class="hf">
    <div class="ff-row"><label class="lbl" for="hf-sev-${i}">Severity</label><select id="hf-sev-${i}"><option>critical</option><option selected>major</option><option>minor</option></select></div>
    <div class="ff-row"><label class="lbl" for="hf-desc-${i}">Finding</label><input id="hf-desc-${i}" class="hf-desc" placeholder="What is wrong"></div>
    <div class="ff-row"><label class="lbl" for="hf-ref-${i}">Spec clause</label><input id="hf-ref-${i}" class="hf-ref" placeholder="Optional, e.g. Acceptance behaviours #2"></div>
    <div class="ff-row"><label class="lbl" for="hf-ev-${i}">Evidence</label><input id="hf-ev-${i}" class="hf-ev" placeholder="Optional: a command and its output, or a link"></div></div>`;
}
function dockEscalation(dock, r, pa, info) {
  const fs = r.escalation?.findings ?? [];
  dock.innerHTML = `<div class="dock-card ${info.cls}">${dockHead(info)}
    <div class="c-q" style="font-size:14.5px">${esc(pa.question.reason)}</div>
    ${r.qaStatus ? `<div class="meta">${esc(QA_LABEL[r.qaStatus] ?? r.qaStatus)}</div>` : ""}
    ${fs.length ? `<div class="c-list">${fs.map((x) => `<div class="c-item"><span class="sev block">${esc(x.id ?? x.severity)}</span><span>${x.source === "qa" ? "<b>QA</b> · " : ""}${inline(x.description)}${shotsHtml(r.id, x.screenshots)}</span></div>`).join("")}</div>` : ""}
    <div class="tiles" role="radiogroup" aria-label="Decision">
      <div class="tile" role="radio" tabindex="0" data-choice="accept" aria-checked="false"><b>Accept as is</b><span>Deliver now. Open findings go into the delivery description.</span></div>
      <div class="tile" role="radio" tabindex="0" data-choice="more" aria-checked="false"><b>Grant more rounds</b><span>Resume the same builder with the findings and your messages.</span>
        <div class="stepper"><button type="button" data-step="-1" aria-label="Fewer rounds">−</button><input id="esc-n" type="number" min="1" max="10" value="${ui.escN}" aria-label="Extra rounds"><button type="button" data-step="1" aria-label="More rounds">+</button></div></div>
      <div class="tile danger" role="radio" tabindex="0" data-choice="abort" aria-checked="false"><b>Abort run</b><span>Cancel it. The workspace is kept for inspection.</span></div>
    </div>
    <div class="c-actions"><span class="hint">Message the builder below if you want to discuss first.</span><span class="grow"></span><button type="button" class="btn primary" id="esc-go" disabled>Continue</button></div></div>`;
  let choice = null;
  const go = $("#esc-go"), n = $("#esc-n");
  const label = () => {
    ui.escN = Number(n.value);
    go.disabled = !choice;
    go.className = `btn ${choice === "abort" ? "dangerfill" : "primary"}`;
    go.textContent = choice === "accept" ? "Accept and deliver" : choice === "more" ? `Grant ${plural(Number(n.value), "more round")}` : choice === "abort" ? "Abort run" : "Continue";
  };
  const pick = (c) => { choice = c; dock.querySelectorAll(".tile").forEach((t) => t.setAttribute("aria-checked", String(t.dataset.choice === c))); label(); };
  dock.querySelectorAll(".tile").forEach((t) => {
    t.addEventListener("click", (e) => { if (!e.target.closest(".stepper")) pick(t.dataset.choice); });
    t.addEventListener("keydown", (e) => { if ((e.key === "Enter" || e.key === " ") && e.target === t) { e.preventDefault(); pick(t.dataset.choice); } });
  });
  dock.querySelectorAll("[data-step]").forEach((b) => b.addEventListener("click", () => { n.value = Number(n.value) + Number(b.dataset.step); pick("more"); }));
  n.addEventListener("input", () => pick("more"));
  go.addEventListener("click", async () => {
    const c = choice === "accept" ? { accept: true } : choice === "more" ? { moreRounds: Number(n.value) } : { abort: true };
    go.disabled = true;
    const ok = await act(() => core.resolveEscalation(r.id, pa.id, c), choice === "accept" ? "Accepted. Delivering." : choice === "more" ? `Granted ${plural(Number(n.value), "more round")}` : "Run aborted");
    if (ok) refreshRun(r.id); else go.disabled = false;
  });
}

function openSpec(r) {
  const sp = r.artifacts.spec, pa = pending(r), gate = pa?.question.kind === "approval" && pa.question.gate === "spec";
  const root = openModal(`<div class="modal"><div class="modal-head"><h2>docs/spec.md${sp ? ` · v${sp.version ?? 1}` : ""}</h2><button type="button" class="icon-btn" data-close aria-label="Close">${CLOSE_SVG}</button></div>
    <div class="modal-body"><div class="spec-doc">${sp ? md(sp.text) : "<p>No spec yet.</p>"}</div></div>
    <div class="modal-foot">${gate ? `<button type="button" class="btn lg" id="spec-changes">Request changes</button><button type="button" class="btn primary lg" id="spec-approve">${ICON.check} Approve and start building</button>` : `<button type="button" class="btn primary" data-close>Close</button>`}</div></div>`, true);
  root.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", closeModal));
  $("#spec-approve", root)?.addEventListener("click", async () => { if (await act(() => core.approve(r.id, "spec"), "Spec approved")) { closeModal(); refreshRun(r.id); } });
  $("#spec-changes", root)?.addEventListener("click", () => { closeModal(); ui.rejecting = true; ui.dockMin = false; renderDock(openRunData()); $("#dk-feedback")?.focus(); });
}

// ---------------------------------------------------------------- details panel
function renderDetails(r) {
  const { idx, name, cls } = stageInfo(r), allDone = r.state === "DELIVERED", terminal = TERMINAL.includes(r.state);
  const pipe = PIPELINE.map(([, n], i) => `<div class="pstep${allDone || i < idx ? " done" : i === idx ? ` now ${cls}` : ""}"><span class="pd"></span><span>${n}${i === idx && !allDone ? ` <span class="meta">· ${esc(r.state)}${r.gate ? ` (${esc(r.gate)})` : ""}</span>` : ""}</span></div>`).join("");
  const ci = r.notices.filter((n) => /^CI |No CI checks/.test(n.text)).at(-1), d = r.artifacts.delivery;
  const findings = r.findingsLog.map((e) => `<div class="round-h">${e.kind === "human" ? `Your feedback · round ${e.round}` : e.kind === "ci" ? `CI failure · round ${e.round}` : e.kind === "qa" ? `QA · round ${e.round} · ${e.findings.some((x) => x.blocking) ? "fail" : "pass"}` : `Review round ${e.round} · ${e.findings.some((x) => x.blocking) ? "fail" : "pass"}`}</div>
    ${e.findings.map((x) => { const resp = e.responses?.find((y) => y.findingId === x.id); return `<div class="finding${x.blocking ? " blocking" : ""}">
      <div class="f-top"><span class="key">${esc(x.id ?? "")}</span><span class="sev${x.blocking ? " block" : ""}">${x.blocking ? "blocking" : "advisory"}</span><span class="sev">${esc(x.severity)}</span>${x.specRef ? `<span class="meta">${esc(x.specRef)}</span>` : ""}</div>
      <div>${inline(x.description)}</div>${x.evidence ? `<details><summary class="meta">Evidence</summary><pre>${esc(x.evidence)}</pre></details>` : ""}${shotsHtml(r.id, x.screenshots)}
      ${resp ? `<div class="f-resp">${resp.status === "fixed" ? "✓ Fixed by the builder" : `Won't fix · ${esc(resp.reason ?? "")}`}</div>` : ""}</div>`; }).join("")}`).join("");
  const byRole = {};
  r.cost.forEach((c) => { const k = `${c.role}:${c.round}:${c.trigger ?? ""}`; byRole[k] ??= { role: c.role, round: c.round, trigger: c.trigger, tokens: 0, usd: 0 }; byRole[k].tokens += c.totalTokens || 0; byRole[k].usd += c.usd || 0; });
  const ktok = (n) => (n >= 10000 ? `${(n / 1000).toFixed(0)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  const costRows = Object.values(byRole).map((c) => `<tr><td>${roleName(c.role)}${c.trigger === "message" ? ` <span class="meta" title="Turns your messages started">· replies</span>` : ""}</td><td class="n">${c.round}</td><td class="n">${ktok(c.tokens)}</td><td class="n">${money(c.usd)}</td></tr>`).join("");
  const from = r.request.meta?.discussion;
  $("#rv-details-inner").innerHTML = `
    ${from ? `<section class="d-sec from-disc">${ICON.chat}<span>From discussion: <button type="button" class="linkish" id="d-disc">${esc(from.title)}</button></span></section>` : ""}
    <div class="kpis"><div class="kpi"><span class="k">Stage</span><span class="v">${allDone ? "Done" : name}</span></div><div class="kpi"><span class="k">Review</span><span class="v">${r.conversations.reviewers.length ? `${r.reviewRound}/${r.caps.review}` : "—"}</span></div>${r.qaStatus ? `<div class="kpi"><span class="k">AQ testing</span><span class="v" title="${esc(QA_LABEL[r.qaStatus] ?? r.qaStatus)}">${esc(cap1(r.qaStatus))}</span></div>` : ""}<div class="kpi"><span class="k">Cost</span><span class="v">${money(totalUsd(r))}</span></div></div>
    <section class="d-sec"><h4>Progress</h4><div class="pipeline">${pipe}</div></section>
    ${r.request.body ? `<section class="d-sec"><h4>Request</h4><div class="f-body">${md(r.request.body)}</div></section>` : ""}
    <section class="d-sec"><h4>Artifacts</h4><div style="display:grid;gap:8px;font-size:13px">
      ${r.artifacts.spec ? `<button type="button" class="btn small" id="d-spec" style="justify-self:start">${ICON.doc} Spec v${r.artifacts.spec.version ?? 1}</button>` : `<span class="meta">The spec isn't written yet.</span>`}
      ${d ? `<div>${d.kind === "pr" ? `PR #${d.pr?.number ?? ""}` : "Repo"} · <a href="${esc(d.url)}" target="_blank" rel="noopener noreferrer">${esc(String(d.url).replace(/^https?:\/\//, ""))}</a><div class="meta mono">${esc(String(d.sha ?? "").slice(0, 12))}</div></div>` : ""}
      ${ci ? `<div class="notice">${esc(ci.text)}</div>` : ""}</div></section>
    ${r.findingsLog.length ? `<section class="d-sec"><h4>Findings <span>${r.findingsLog.reduce((a, e) => a + e.findings.length, 0)}</span></h4>${findings}</section>` : ""}
    ${r.cost.length ? `<section class="d-sec"><h4>Cost by role</h4><div class="scroll-x"><table class="cost"><thead><tr><th>Role</th><th class="n">Round</th><th class="n">Tokens</th><th class="n">USD</th></tr></thead><tbody>${costRows}<tr class="total"><td>Total</td><td></td><td class="n">${ktok(r.cost.reduce((a, c) => a + (c.totalTokens || 0), 0))}</td><td class="n">${money(totalUsd(r))}</td></tr></tbody></table></div></section>` : ""}
    <section class="d-sec"><h4>Activity</h4><div style="display:grid;gap:6px">${r.notices.slice(-5).reverse().map((n) => `<div class="notice ${esc(n.level)}">${linkify(esc(n.text))}<span class="meta">${stamp(n.at)}</span></div>`).join("") || `<span class="meta">Nothing yet</span>`}</div></section>
    <section class="d-sec"><h4>Run</h4><dl class="dl">
      <dt>Project</dt><dd>${esc(r.project)}</dd><dt>Repo</dt><dd>${esc(r.repo)}${r.workspace?.newRepo ? ` <span class="meta">(created at delivery)</span>` : ""}</dd>
      <dt>Source</dt><dd>${esc(r.request.source)}</dd><dt>Run id</dt><dd class="mono">${esc(r.id)}</dd>
      ${r.workspace ? `<dt>Branch</dt><dd class="mono">${esc(r.workspace.branch)}</dd><dt>Workspace</dt><dd class="mono">${esc(r.workspace.path)}</dd>` : ""}
      <dt>CI fixes</dt><dd class="tnum">${r.ciFixes}/${r.caps.ciFix}</dd>
      <dt>Created</dt><dd>${new Date(r.createdAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}</dd>
      <dt>Pinned</dt><dd class="mono">${esc(r.configHash)} · ${esc(r.piVersion)}</dd></dl></section>
    <section class="d-sec"><h4>Actions</h4><div class="actions" style="display:flex;gap:8px;flex-wrap:wrap">
      ${terminal ? (r.state !== "DELIVERED" ? `<button type="button" class="btn primary" id="d-retry">${ICON.retry} Retry run</button>` : `<span class="meta">Delivered runs are final.</span>`) : `<button type="button" class="btn danger" id="d-cancel">${ui.confirmCancel ? "Click again to cancel" : "Cancel run"}</button>`}
    </div></section>`;
  $("#d-spec")?.addEventListener("click", () => openSpec(r));
  $("#d-disc")?.addEventListener("click", () => withDiscussions(() => openDiscussion(from.id)));
  $("#d-retry")?.addEventListener("click", () => act(() => core.retryRun(r.id), "Retrying").then(() => refreshRun(r.id)));
  $("#d-cancel")?.addEventListener("click", () => {
    if (!ui.confirmCancel) { ui.confirmCancel = true; renderDetails(r); setTimeout(() => { ui.confirmCancel = false; if (ui.open === r.id) renderDetails(openRunData()); }, 4000); return; }
    ui.confirmCancel = false; act(() => core.cancelRun(r.id, "cancelled from the web UI"), "Run cancelled").then(() => refreshRun(r.id));
  });
}

// ===================================================================== settings (generated from settingsSchema())
ui.setScope = "global";
function walk(schema, prefix = "", out = []) {
  for (const [k, fld] of Object.entries(schema)) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (fld.type === "object") walk(fld.fields, p, out); else out.push({ path: p, field: fld });
  }
  return out;
}
function groupOf(path) {
  const [a, b] = path.split(".");
  return a === "roles" && path.split(".").length > 2 ? `${a}.${b}` : a;
}
const GROUP_NAME = (g) => { const [a, b] = g.split("."); return b ? `${cap1(a)} · ${b}` : cap1(a); };
const GROUP_ORDER = ["policy", "roles", "github", "ci", "sandbox", "qa", "boat", "webSearch", "web", "workdir", "storage"];
async function renderSettings() {
  const scope = ui.setScope === "global" ? { global: true } : { project: ui.setScope };
  let eff;
  try {
    ui.schema ??= await core.settingsSchema();
    eff = await core.getSettings(scope);
  } catch (e) { toast(String(e.message ?? e), "error"); return; }
  $("#set-nav").innerHTML = `<div class="pane-label">Scope</div><button type="button" data-scope="global" aria-current="${ui.setScope === "global"}">Global</button>` +
    ui.projects.map((p) => `<button type="button" data-scope="${esc(p.name)}" aria-current="${ui.setScope === p.name}">${esc(p.name)}</button>`).join("");
  const leaves = walk(ui.schema).filter(({ path }) => path in eff && path !== "version");
  const rank = (p) => { const i = GROUP_ORDER.indexOf(p.split(".")[0]); return i < 0 ? GROUP_ORDER.length : i; };
  leaves.sort((a, b) => rank(a.path) - rank(b.path));
  const rows = []; let group = null;
  for (const { path, field } of leaves) {
    const g = groupOf(path);
    if (g !== group) { group = g; rows.push(`<div class="set-group">${esc(GROUP_NAME(g))}</div>`); }
    const { value, source } = eff[path];
    const name = path.slice(g.length + 1) || path;
    const own = scope.project ? source === "project" : source === "global";
    rows.push(`<div class="set-row" data-path="${esc(path)}">
      <div><div class="s-name">${esc(name)}</div><div class="s-desc">${esc(field.description)}</div><div class="s-path">${esc(path)}</div></div>
      <div class="set-ctl">${control(path, field, value)}</div>
      <div class="set-side"><span class="src ${esc(source)}" title="Where the effective value comes from">${esc(source)}</span>${own ? `<button type="button" class="btn small ghost" data-unset="${esc(path)}">${scope.project ? "Inherit" : "Reset"}</button>` : ""}</div>
    </div>`);
  }
  $("#set-main").innerHTML = `<h2>${scope.project ? `${esc(scope.project)} overrides` : "Global settings"}</h2>
    <p class="set-intro">Every value resolves default → global → project. ${scope.project ? "Values you set here override the global ones for this project only; Inherit removes the override." : "Pick a project on the left to override values for it."} Changes apply to new runs; running ones stay pinned to the config they started with. Interface settings (like this page's port) apply when the factory restarts.</p>${rows.join("")}`;
}
function control(path, fld, v) {
  const id = `set-${path.replace(/[^a-z0-9]/gi, "-")}`;
  if (fld.type === "enum") return `<select id="${id}" data-set="${esc(path)}" data-kind="enum">${fld.values.map((x) => `<option${x === v ? " selected" : ""}>${esc(x)}</option>`).join("")}</select>`;
  if (fld.type === "boolean") return `<button type="button" class="tog" data-set="${esc(path)}" data-kind="bool" aria-pressed="${!!v}">${v ? "On" : "Off"}</button>`;
  if (fld.type === "number") return `<input id="${id}" type="number" data-set="${esc(path)}" data-kind="num" value="${esc(v ?? "")}" style="max-width:120px">${fld.min != null ? `<span class="hint">${fld.min}–${fld.max ?? "∞"}</span>` : ""}`;
  if (fld.type === "list" && fld.of.type === "enum") return fld.of.values.map((x) => `<button type="button" class="tog" data-set="${esc(path)}" data-kind="enumlist" data-val="${esc(x)}" aria-pressed="${(v ?? []).includes(x)}">${esc(x)}</button>`).join("");
  if (fld.type === "list" && ["string", "secretRef"].includes(fld.of.type)) return `<input id="${id}" data-set="${esc(path)}" data-kind="list" value="${esc((v ?? []).join(", "))}" placeholder="comma-separated">`;
  if (fld.type === "list" && fld.of.type === "number") return `<input id="${id}" data-set="${esc(path)}" data-kind="numlist" value="${esc((v ?? []).join(", "))}" placeholder="comma-separated">`;
  if (fld.type === "list") return `<input id="${id}" class="mono" data-set="${esc(path)}" data-kind="json" value="${esc(JSON.stringify(v ?? []))}">`;
  return `<input id="${id}" data-set="${esc(path)}" data-kind="str" value="${esc(v ?? "")}"${fld.type === "secretRef" ? ` class="mono" placeholder="env:NAME or file:/path"` : ""}>`;
}
async function saveSetting(el) {
  const scope = ui.setScope === "global" ? { global: true } : { project: ui.setScope };
  const path = el.dataset.set, kind = el.dataset.kind;
  let value;
  if (kind === "enum" || kind === "str") value = el.value;
  else if (kind === "num") value = el.value === "" ? null : Number(el.value);
  else if (kind === "bool") value = el.getAttribute("aria-pressed") !== "true";
  else if (kind === "list") value = el.value.split(",").map((x) => x.trim()).filter(Boolean);
  else if (kind === "numlist") value = el.value.split(",").map((x) => x.trim()).filter(Boolean).map(Number);
  else if (kind === "json") { try { value = JSON.parse(el.value); } catch { toast(`${path}: not valid JSON`, "error"); return renderSettings(); } }
  else if (kind === "enumlist") {
    const cur = [...el.parentElement.querySelectorAll("[data-set]")].filter((b) => b.getAttribute("aria-pressed") === "true").map((b) => b.dataset.val);
    value = cur.includes(el.dataset.val) ? cur.filter((x) => x !== el.dataset.val) : [...cur, el.dataset.val];
  }
  const ok = await act(() => core.setSetting(scope, path, value), `Saved ${path}${scope.project ? ` for ${scope.project}` : ""}. New runs use it.`);
  renderSettings();
  return ok;
}

// ===================================================================== wiring
function showView(name) {
  if (!["board", "settings"].includes(name)) name = "board";
  for (const v of ["board", "settings"]) $(`#view-${v}`).hidden = v !== name;
  document.querySelectorAll(".nav button").forEach((b) => (b.dataset.view === name ? b.setAttribute("aria-current", "page") : b.removeAttribute("aria-current")));
  if (name === "settings") renderSettings(); else renderBoard();
}
// discussions.js (a deferred script after this one) defines the discussion globals; run `f` once it has loaded.
function withDiscussions(f) {
  if (typeof openDiscussion === "function") return f();
  addEventListener("DOMContentLoaded", () => { if (typeof openDiscussion === "function") f(); }, { once: true });
}
// The sheet's labels: a run's ticket, or a discussion.
function sheetLabels(discussion) {
  const close = discussion ? "Close discussion view" : "Close ticket", details = discussion ? "Discussion details" : "Ticket details";
  $("#rv-close").setAttribute("aria-label", close); $("#rv-close").title = `${discussion ? "Back to the board" : "Close"} (Esc)`;
  $("#rv-details-btn").setAttribute("aria-label", details); $("#rv-details-btn").title = details;
  $("#rv-details").setAttribute("aria-label", details);
  $("#rv-threads-btn").setAttribute("aria-label", discussion ? "Show or hide the chat history" : "Show conversations");
  $("#rv-threads").setAttribute("aria-label", discussion ? "Chat history" : "Conversations");
}
function wire() {
  document.querySelectorAll(".nav button").forEach((b) => b.addEventListener("click", () => showView(b.dataset.view)));
  $("#create-btn").addEventListener("click", openCreate);
  $("#chat-btn").addEventListener("click", () => withDiscussions(openChat));
  $("#board").addEventListener("click", (e) => { const c = e.target.closest(".card"); if (c) openRun(c.dataset.id, c); });
  $("#proj-filter").addEventListener("change", (e) => { ui.filter.project = e.target.value; renderBoard(); });
  $("#q").addEventListener("input", (e) => { ui.filter.q = e.target.value; if ($("#view-board").hidden) showView("board"); else renderBoard(); });
  for (const [id, k] of [["#f-turn", "turn"], ["#f-active", "active"], ["#f-closed", "closed"]]) $(id).addEventListener("click", (e) => {
    ui.filter[k] = !ui.filter[k]; e.currentTarget.setAttribute("aria-pressed", String(ui.filter[k])); renderBoard();
  });
  $("#rv-close").addEventListener("click", closeRun);
  $("#rv-threads").addEventListener("click", (e) => {
    if (ui.mode === "discussion") return; // the chat view's history rail (discussions.js)
    const t = e.target.closest(".thread"); if (!t) return;
    ui.thread = t.dataset.thread;
    ui.stick = true; showJump(false);
    $("#rv-threads").classList.remove("open");
    renderThreads(openRunData()); loadThread(true);
  });
  $("#rv-threads-btn").addEventListener("click", () => {
    if (ui.mode === "discussion" && innerWidth > 760) return withDiscussions(toggleChatRail);
    $("#rv-threads").classList.toggle("open");
  });
  $("#rv-details-btn").addEventListener("click", () => setDetails(!ui.details));
  $("#transcript").addEventListener("click", () => $("#rv-threads").classList.remove("open"));
  $("#transcript").addEventListener("scroll", () => {
    const b = $("#transcript");
    ui.stick = b.scrollHeight - b.scrollTop - b.clientHeight < 80;
    if (ui.stick) showJump(false);
  });
  $("#tx").addEventListener("click", (e) => {
    const cp = e.target.closest("[data-copy]");
    if (cp) { const pre = cp.closest(".s-sec").querySelector("pre"); return copyFrom(cp, pre.textContent, pre); }
    const mo = e.target.closest("[data-more]");
    if (mo) {
      const k = mo.dataset.more, body = mo.previousElementSibling, open = !ui.expanded.has(k);
      if (open) ui.expanded.add(k); else ui.expanded.delete(k);
      body.classList.toggle("clamp", !open); mo.textContent = open ? "Show less" : "Show more";
    }
  });
  document.addEventListener("toggle", (e) => {
    const k = e.target.dataset?.key; if (!k) return;
    if (e.target.open) ui.expanded.add(k); else ui.expanded.delete(k);
  }, true);
  if (window.ResizeObserver) new ResizeObserver(() => setDockPad()).observe($("#dock"));
  $("#set-nav").addEventListener("click", (e) => { const b = e.target.closest("[data-scope]"); if (b) { ui.setScope = b.dataset.scope; renderSettings(); } });
  $("#set-main").addEventListener("change", (e) => { if (e.target.matches("select[data-set], input[data-set]")) saveSetting(e.target); });
  $("#set-main").addEventListener("click", (e) => {
    const t = e.target.closest("button[data-set]"); if (t) return saveSetting(t);
    const u = e.target.closest("[data-unset]");
    if (u) act(() => core.unsetSetting(ui.setScope === "global" ? { global: true } : { project: ui.setScope }, u.dataset.unset), `Removed ${u.dataset.unset}`).then(renderSettings);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (modalStack.length) return closeModal();
    if ($("#rv-threads").classList.contains("open")) return $("#rv-threads").classList.remove("open");
    if (ui.open && ui.details && innerWidth < 1180) return setDetails(false);
    if (ui.open && ui.rejecting && document.activeElement?.closest("#dock")) { ui.rejecting = false; ui.structured = false; return renderDock(openRunData()); }
    if (ui.open) closeRun();
  });
  // Card ages tick every minute; live pulses fade a few seconds after a conversation goes quiet.
  setInterval(() => { if (!$("#view-board").hidden && !ui.open) renderBoard(); }, 60000);
  setInterval(() => {
    if (liveSignature() !== ui.liveSig && !$("#view-board").hidden) renderBoard();
    if (ui.open) { const r = openRunData(); if (r) { renderThreads(r); updateComposerLive(r); } }
  }, 3000);
}

async function boot() {
  wire();
  core.subscribe({}, onEvent); // empty filter: settings.changed only reaches unfiltered subscribers
  try {
    const [projects, runs, discs] = await Promise.all([core.listProjects(), core.listRuns(), core.listDiscussions()]);
    ui.projects = projects;
    for (const r of runs) ui.runs.set(r.id, r);
    for (const d of discs) ui.discs.set(d.id, d);
  } catch (e) { toast(String(e.message ?? e), "error"); }
  renderProjectFilter(); renderBoard();
  // #run=<id> and #disc=<id> reopen a run or a discussion; #chat a blank new chat; anything else is the board.
  const m = /^#run=(.+)$/.exec(location.hash), d = /^#disc=(.+)$/.exec(location.hash);
  if (m && ui.runs.has(decodeURIComponent(m[1]))) openRun(decodeURIComponent(m[1]), null);
  else if (d) withDiscussions(() => openDiscussion(decodeURIComponent(d[1])));
  else if (location.hash === "#chat") withDiscussions(() => openChat({ blank: true }));
  else if (location.hash) try { history.replaceState(null, "", location.pathname); } catch {}
}
boot();
