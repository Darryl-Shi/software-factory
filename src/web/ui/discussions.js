"use strict";
// Discussions as a full-screen chat (discussions spec §3, amended by docs/spec.md): the Chat button next to Create opens
// the run view's sheet (#runview with data-mode="discussion") as a chat app. Its top bar holds the project, model and
// thinking dropdowns (locked once the discussion exists), the cost, Draft tickets and an overflow menu; the left rail
// (the run view's threads rail) is the history of the selected project's discussions with New chat on top; the centre
// is the run view's transcript renderer and a composer; the details slot on the right holds the drafts panel.
// A classic script loaded after app.js, so app.js's helpers (`core`, `ui`, `$`, `esc`, `md`, `act`, `toast`,
// `openModal`, `blocksFor`, `patch`, …) are shared globals. All state is a cache of core reads and events.

Object.assign(ui, {
  dtx: null, dComposerKey: null, dRenderLater: false, dSaving: Promise.resolve(),
  chat: null, models: null, chatSeq: 0, menuOpen: false, dPrev: null,
  railCollapsed: (() => { try { return localStorage.getItem("factory.chatRail") === "0"; } catch { return false; } })(),
});
ROLE_LETTER.discussant = "D";

/** `ui.open` while the chat view shows a blank new chat. */
const NEW_CHAT = "#new";
const LOCK_TIP = "Fixed for this chat; start a new chat to change it";
const DEFAULT_THINKING = ["off", "low", "medium", "high"];
const DISC_STATE = { PREPARING: ["Preparing", ""], OPEN: ["Open", "progress"], CLOSED: ["Closed", ""], FAILED: ["Failed", "bad"] };
const openDisc = () => (ui.mode === "discussion" ? ui.discs.get(ui.open) : undefined);
const isNewChat = () => ui.mode === "discussion" && ui.open === NEW_CHAT;
// A run a draft became: the live run from the board's cache, else the state the discussion reported.
const draftRun = (d, id) => ui.runs.get(id) ?? { state: d.runs.find((x) => x.id === id)?.state ?? "RECEIVED" };
const activeAgo = (t) => { const a = ago(t); return a === "now" ? "active just now" : `active ${a} ago`; };
const discTok = (n) => (n >= 10000 ? `${(n / 1000).toFixed(0)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
const discDur = (ms) => (ms < 60000 ? `${Math.max(1, Math.round(ms / 1000))}s` : `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`);
const wide = () => innerWidth >= 1180;

// A small confirmation dialog; resolves false when dismissed (Cancel, Escape, a click outside).
function confirmBox(title, text, okLabel) {
  return new Promise((resolve) => {
    const root = openModal(`<div class="modal"><div class="modal-head"><h2>${esc(title)}</h2><button type="button" class="icon-btn" data-close aria-label="Close">${CLOSE_SVG}</button></div>
      <div class="modal-body"><p style="margin:0">${esc(text)}</p></div>
      <div class="modal-foot"><button type="button" class="btn" data-close>Cancel</button><button type="button" class="btn primary" data-ok>${esc(okLabel)}</button></div></div>`);
    let done = false;
    const finish = (v) => { if (!done) { done = true; watch.disconnect(); resolve(v); } };
    const watch = new MutationObserver(() => { if (!root.isConnected) finish(false); });
    watch.observe($("#modal-root"), { childList: true });
    root.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => { finish(false); closeModal(); }));
    $("[data-ok]", root).addEventListener("click", () => { finish(true); closeModal(); });
  });
}

// ===================================================================== opening the chat view
/** The Chat button: the discussion opened last in this browser session if it still exists, else a blank new chat. */
async function openChat(opts = {}) {
  let last = null;
  if (!opts.blank) try { last = sessionStorage.getItem("factory.lastDisc"); } catch {}
  return showChat(last && ui.discs.has(last) ? last : null, $("#chat-btn"));
}
/** Open the chat view on a discussion (from a link, a toast, the boot hash). */
function openDiscussion(id, fromEl) { return showChat(id, fromEl); }

/**
 * Show `id` (a discussion id, or null for a blank new chat) in the chat view. When the sheet is closed it opens with
 * the run view's animation; when the chat view already shows, the content switches in place.
 */
async function showChat(id, fromEl, opts = {}) {
  const mine = ++ui.chatSeq;
  if (ui.open && ui.mode !== "discussion") { await closeRun(); if (ui.open) return; }
  if (ui.open && ui.open === (id ?? NEW_CHAT)) { focusComposer(); return; }
  let d = null;
  if (id) {
    try { d = await core.getDiscussion(id); }
    catch (e) {
      toast(openErrorText(e), "error");
      if (/^#disc=/.test(location.hash) && !ui.open) try { history.replaceState(null, "", location.pathname); } catch {}
      return;
    }
    ui.discs.set(id, d);
  }
  if (mine !== ui.chatSeq || (ui.open && ui.mode !== "discussion")) return;
  const fresh = !ui.open;
  if (!id) startBlankChat(opts.project);
  closeMenu();
  Object.assign(ui, { open: id ?? NEW_CHAT, mode: "discussion", dtx: null, dComposerKey: null, dRenderLater: false, stick: true, txConv: null, dPrev: null });
  try { history.replaceState(null, "", id ? `#disc=${encodeURIComponent(id)}` : "#chat"); } catch {}
  if (id) try { sessionStorage.setItem("factory.lastDisc", id); } catch {}
  const rv = $("#runview"), bd = $("#rv-backdrop");
  rv.dataset.mode = "discussion"; sheetLabels(true);
  $("#dock").hidden = true; $("#dock").innerHTML = ""; setDockPad();
  $("#composer").innerHTML = ""; $("#rv-progress").innerHTML = ""; $("#rv-details-inner").innerHTML = ""; $("#conv-head").innerHTML = "";
  $("#rv-threads").classList.remove("open");
  $("#rv-body").classList.toggle("rail-collapsed", ui.railCollapsed);
  ui.tx.clear();
  setPanel(false); showJump(false);
  $("#tx").replaceChildren();
  renderChatbar(); renderRail(); renderDiscussionView();
  if (fresh) {
    bd.hidden = false; rv.hidden = false;
    requestAnimationFrame(() => bd.classList.add("on"));
    if (!reduceMotion()) {
      rv.animate([{ clipPath: insetOf(fromEl) ?? "inset(3% 3% 3% 3% round 18px)" }, { clipPath: "inset(0px 0px 0px 0px round 0px)" }], { duration: 520, easing: "cubic-bezier(.2, .85, .25, 1)" });
      rv.querySelectorAll(".rv-top, .rv-body").forEach((el) => el.animate([{ opacity: 0 }, { opacity: 0, offset: 0.3 }, { opacity: 1 }], { duration: 520, easing: "ease-out" }));
    }
    loadModels();
  }
  if (id) await loadDiscTranscript(true);
  if (ui.open === (id ?? NEW_CHAT)) focusComposer();
}
function focusComposer() { ($("#dc-input:not(:disabled)") ?? $("#rv-close")).focus({ preventScroll: true }); }
// closeRun (app.js) calls this as the chat view starts closing.
function chatClosing() {
  closeMenu();
  ui.chatSeq++;
  $("#rv-body").classList.remove("rail-collapsed");
}

// ===================================================================== the blank new chat: project, model and thinking
/** The default project: `prefer` (New chat from a discussion), the board's filter, the last active discussion's, the first. */
function startBlankChat(prefer) {
  const names = ui.projects.map((p) => p.name);
  const recent = [...ui.discs.values()].filter((d) => names.includes(d.project)).sort((a, b) => b.updatedAt - a.updatedAt)[0]?.project;
  const project = [prefer, ui.filter.project, recent, names[0]].find((p) => p && names.includes(p)) ?? "__new";
  ui.chat = { project, newName: "", newRepo: "", model: "", thinking: "", touched: false, defaults: null, levels: null, seq: 0 };
  prefillChat();
}
/** Prefill model and thinking from the selected project's effective `discussion.model`, unless the human touched them. */
async function prefillChat() {
  const c = ui.chat, mine = ++c.seq, p = c.project;
  let eff;
  try {
    ui.schema ??= await core.settingsSchema();
    eff = await core.getSettings(p && p !== "__new" ? { project: p } : { global: true });
  } catch (e) { toast(String(e.message ?? e), "error"); return; }
  if (ui.chat !== c || mine !== c.seq) return;
  const field = walk(ui.schema).find((x) => x.path === "discussion.model.thinking")?.field;
  c.levels = field?.type === "enum" ? field.values : DEFAULT_THINKING;
  c.defaults = { model: String(eff["discussion.model.model"]?.value ?? ""), thinking: String(eff["discussion.model.thinking"]?.value ?? "medium") };
  if (!c.touched) { c.model = c.defaults.model; c.thinking = c.defaults.thinking; }
  if (isNewChat()) renderChatbar();
}
/** The models the factory has credentials for; `[]` (free-text model field) when there are none or the call fails. */
async function loadModels() {
  try { const l = await core.listModels(); ui.models = Array.isArray(l) ? l : []; }
  catch { ui.models = []; }
  if (ui.mode === "discussion") renderChatbar();
}

// ===================================================================== the chat's top bar
const opt = (value, label, selected) => `<option value="${esc(value)}"${selected ? " selected" : ""}>${esc(label)}</option>`;
function modelOptions(value, def) {
  const list = ui.models ?? [], ids = new Set(list.map((m) => m.id));
  const label = (m) => `${m.name && m.name !== m.id.slice(m.provider.length + 1) ? `${m.name} · ${m.id}` : m.id}${m.id === def ? " (default)" : ""}`;
  const extra = [];
  // The project's default is always offered (the core validates it at start), and so is the current value.
  if (def && !ids.has(def)) extra.push(opt(def, `${def} (default)`, value === def));
  if (value && !ids.has(value) && value !== def) extra.push(opt(value, value, true));
  const groups = new Map();
  for (const m of list) { if (!groups.has(m.provider)) groups.set(m.provider, []); groups.get(m.provider).push(m); }
  const grouped = [...groups].map(([p, ms]) => `<optgroup label="${esc(p)}">${ms.map((m) => opt(m.id, label(m), m.id === value)).join("")}</optgroup>`).join("");
  return extra.join("") + grouped;
}
function renderChatbar() {
  const bar = $("#chatbar"); if (!bar || ui.mode !== "discussion") return;
  const d = openDisc(), c = ui.chat;
  if (!d && !c) { bar.innerHTML = ""; return; }
  // Keep focus and the caret in a field that is re-rendered (the new project's name and repo).
  const focused = document.activeElement?.closest?.("#chatbar") ? document.activeElement : null;
  const fid = focused?.id, sel = focused && "selectionStart" in focused ? [focused.selectionStart, focused.selectionEnd] : null;
  const locked = !!d, dis = locked ? ` disabled title="${esc(LOCK_TIP)}"` : "";
  const wrapTip = locked ? ` title="${esc(LOCK_TIP)}"` : "";
  const project = locked ? d.project : c.project;
  const known = ui.projects.some((p) => p.name === project);
  const projOpts = ui.projects.map((p) => opt(p.name, `${p.name} · ${p.repo}`, p.name === project)).join("")
    + (locked && !known ? opt(project, `${project} · ${d.repo}`, true) : "")
    + (locked ? "" : opt("__new", "New project…", project === "__new"));
  const model = locked ? d.model.model : c.model, thinking = locked ? d.model.thinking : c.thinking;
  const def = locked ? "" : c.defaults?.model ?? "";
  const freeText = !locked && Array.isArray(ui.models) && ui.models.length === 0;
  const modelCtl = freeText
    ? `<input id="ch-model" class="ch-model-in" value="${esc(model)}" placeholder="provider/model" aria-label="Model" autocomplete="off" spellcheck="false">`
    : `<select id="ch-model" aria-label="Model"${dis}>${ui.models === null && !model ? opt("", "Loading models…", true) : modelOptions(model, def)}</select>`;
  const levels = c?.levels ?? DEFAULT_THINKING;
  const lv = levels.includes(thinking) || !thinking ? levels : [thinking, ...levels];
  bar.innerHTML = `
    <span class="ch-pill ch-project"${wrapTip}><span class="ch-lab">Project</span><select id="ch-project" aria-label="Project"${dis}>${projOpts}</select></span>
    ${!locked && project === "__new" ? `<span class="ch-newproj"><input id="ch-pname" placeholder="name" aria-label="New project name" autocomplete="off" value="${esc(c.newName)}"><input id="ch-prepo" placeholder="owner/repo" aria-label="New project repo" autocomplete="off" value="${esc(c.newRepo)}" title="If the repo doesn't exist, the factory creates it as a private repo at the first delivery"></span>` : ""}
    <span class="ch-pill ch-model"${wrapTip}><span class="ch-lab">Model</span>${modelCtl}</span>
    <span class="ch-pill ch-thinking"${wrapTip}><span class="ch-lab">Thinking</span><select id="ch-thinking" aria-label="Thinking"${dis}>${lv.map((x) => opt(x, x, x === thinking)).join("")}</select></span>`;
  if (fid) { const el = $(`#${fid}`, bar); if (el) { el.focus({ preventScroll: true }); if (sel && "setSelectionRange" in el) try { el.setSelectionRange(sel[0], sel[1]); } catch {} } }
}
function chatbarInput(e) {
  const c = ui.chat; if (!isNewChat() || !c) return;
  const t = e.target;
  if (t.id === "ch-project" && e.type === "change") {
    c.project = t.value;
    renderChatbar(); renderRail(); prefillChat();
    if (t.value === "__new") $("#ch-pname")?.focus();
  } else if (t.id === "ch-model") { c.model = t.value.trim(); c.touched = true; }
  else if (t.id === "ch-thinking") { c.thinking = t.value; c.touched = true; }
  else if (t.id === "ch-pname") c.newName = t.value;
  else if (t.id === "ch-prepo") c.newRepo = t.value;
}

// ---------------------------------------------------------------- Draft tickets and the overflow menu (⋯)
function renderDiscActions(d) {
  const el = $("#rv-disc-actions");
  if (!d) { el.innerHTML = ""; return; }
  const item = (id, label, on, extra = "") => `<button type="button" role="menuitem" class="menu-item" id="${id}"${on ? "" : " disabled"}${extra}>${label}</button>`;
  const items = [
    d.state === "OPEN" || d.state === "PREPARING" ? item("dh-close", "Close discussion", d.state === "OPEN" && !d.turn, d.turn ? ` title="Wait for the reply, or stop it, before closing"` : "") : "",
    d.state === "CLOSED" ? item("dh-reopen", `${ICON.retry} Reopen`, true) : "",
    d.state === "FAILED" ? item("dh-retry", `${ICON.retry} Retry`, true) : "",
  ].join("");
  el.innerHTML = `<button type="button" class="btn small" id="dh-drafts" aria-pressed="${ui.dPanel}" title="Draft tickets: a summary and tickets from this chat">${ICON.doc} Draft tickets</button>
    <span class="more-wrap"><button type="button" class="icon-btn" id="dh-more" aria-label="More" title="More" aria-haspopup="menu" aria-expanded="${ui.menuOpen}">⋯</button>
    <div class="menu" id="dh-menu" role="menu"${ui.menuOpen ? "" : " hidden"}>${items}</div></span>`;
}
function closeMenu() {
  if (!ui.menuOpen) return;
  ui.menuOpen = false;
  $("#dh-menu")?.setAttribute("hidden", "");
  $("#dh-more")?.setAttribute("aria-expanded", "false");
}
function discActionClick(e) {
  const d = openDisc(); if (!d) return;
  const b = e.target.closest("button"); if (!b || b.disabled) return;
  if (b.id === "dh-drafts") {
    setPanel(!ui.dPanel);
    if (ui.dPanel) setTimeout(() => $("#dd-instr:not(:disabled)")?.focus({ preventScroll: true }), 30);
    return;
  }
  if (b.id === "dh-more") {
    ui.menuOpen = !ui.menuOpen;
    $("#dh-menu").hidden = !ui.menuOpen; b.setAttribute("aria-expanded", String(ui.menuOpen));
    if (ui.menuOpen) $("#dh-menu .menu-item:not(:disabled)")?.focus();
    return;
  }
  closeMenu();
  if (b.id === "dh-close") act(() => core.closeDiscussion(d.id), "Discussion closed. Its drafts can still become tickets.").then(() => refreshDisc(d.id));
  if (b.id === "dh-reopen") act(() => core.reopenDiscussion(d.id), "Reopening").then(() => refreshDisc(d.id));
  if (b.id === "dh-retry") act(() => core.retryDiscussion(d.id), "Retrying").then(() => refreshDisc(d.id));
}
/** The drafts panel (the details slot), without remembering it as the run view's preference. */
function setPanel(on) {
  ui.dPanel = on; ui.details = on;
  $("#rv-body").classList.toggle("with-details", on);
  $("#dh-drafts")?.setAttribute("aria-pressed", String(on));
}

// ===================================================================== the history rail (the run view's threads rail)
const railProject = () => openDisc()?.project ?? ui.chat?.project ?? "";
function renderRail() {
  if (ui.mode !== "discussion") return;
  const p = railProject(), cur = ui.open;
  const focused = document.activeElement?.closest?.("#rv-threads [data-chat]")?.dataset.chat;
  const list = [...ui.discs.values()].filter((d) => d.project === p).sort((a, b) => b.updatedAt - a.updatedAt);
  const row = (d) => {
    const marker = d.turn ? `<span class="live-dot" title="${d.turn.kind === "draft" ? "Drafting tickets" : "Replying"}"></span>`
      : d.state === "FAILED" ? `<span class="fail-mark" title="Failed" aria-label="Failed">${ICON.warn}</span>` : "";
    const sub = d.state === "CLOSED" ? `Closed · ${activeAgo(d.updatedAt)}` : d.state === "FAILED" ? `Failed · ${activeAgo(d.updatedAt)}` : cap1(activeAgo(d.updatedAt));
    return `<button type="button" class="thread hist${d.state === "CLOSED" ? " closed" : ""}${d.state === "FAILED" ? " failed" : ""}" data-chat="${esc(d.id)}" aria-current="${cur === d.id}" title="${esc(d.title)}">
      <span style="min-width:0"><span class="t-name">${esc(d.title)}</span><span class="t-sub">${esc(sub)}</span></span>${marker}</button>`;
  };
  $("#rv-threads").innerHTML = `<button type="button" class="thread hist new-chat" data-chat="${NEW_CHAT}" aria-current="${cur === NEW_CHAT}"><span class="t-name"><span class="nc-plus" aria-hidden="true">+</span> New chat</span></button>
    <div class="rail-label">${p && p !== "__new" ? esc(p) : "History"}</div>
    ${list.map(row).join("") || `<p class="hint" style="padding:4px 10px;margin:0">${p === "__new" ? "A new project has no chats yet." : "No chats in this project yet."}</p>`}`;
  if (focused) [...$("#rv-threads").querySelectorAll("[data-chat]")].find((el) => el.dataset.chat === focused)?.focus({ preventScroll: true });
}
function railClick(e) {
  if (ui.mode !== "discussion") return;
  const t = e.target.closest("[data-chat]"); if (!t) return;
  $("#rv-threads").classList.remove("open");
  const id = t.dataset.chat;
  if (id === NEW_CHAT) showChat(null, null, { project: railProject() });
  else showChat(id);
}
function toggleChatRail() {
  ui.railCollapsed = !ui.railCollapsed;
  $("#rv-body").classList.toggle("rail-collapsed", ui.railCollapsed);
  try { localStorage.setItem("factory.chatRail", ui.railCollapsed ? "0" : "1"); } catch {}
}

// ===================================================================== the view
function renderDiscussionView() {
  if (ui.mode !== "discussion") return;
  const d = openDisc();
  $("#rv-key").textContent = d?.project ?? "";
  $("#rv-title").textContent = d ? d.title : "New chat"; $("#rv-title").title = d ? d.title : "";
  $("#rv-state").innerHTML = "";
  $("#rv-cost").textContent = d ? money(discUsd(d)) : ""; // recorded plus the running turn's (liveCost)
  $("#rv-cost").title = d ? "Cost of this chat" : "";
  if (d) autoPanel(d);
  renderDiscActions(d); renderDiscComposer(d); if (d) renderDrafts(d); renderDiscTranscript(false);
}
// The drafts panel opens on its own when a draft turn starts and, on wide screens, when the discussion has drafts.
function autoPanel(d) {
  const drafting = d.turn?.kind === "draft", n = d.drafts.length, prev = ui.dPrev;
  ui.dPrev = { id: d.id, drafting, n };
  if (prev?.id !== d.id) { if (drafting || (n > 0 && wide())) setPanel(true); return; }
  if ((drafting && !prev.drafting) || (n > prev.n && wide())) setPanel(true);
}
function resyncDiscussion() {
  if (ui.mode !== "discussion") return;
  if (isNewChat()) { renderChatbar(); renderRail(); return; }
  if (!openDisc()) return closeRun();
  renderChatbar(); renderRail(); renderDiscussionView(); loadDiscTranscript(false);
}

// ---------------------------------------------------------------- transcript: the run view's renderer, plus turn costs and notices
// The renderer takes a run; a discussion has one conversation and none of a run's parts.
const discAsRun = (d) => ({ id: d.id, cost: [], conversations: { reviewers: [], qa: [] }, messages: [] });
async function loadDiscTranscript(first) {
  const d = openDisc(); if (!d) return;
  if (d.conversationId == null) { ui.dtx = null; return renderDiscTranscript(first); }
  let t;
  try { t = await core.getDiscussionConversation(d.id); }
  catch (e) { if (e.code !== "not_found") toast(String(e.message ?? e), "error"); return; }
  if (ui.mode !== "discussion" || ui.open !== d.id) return;
  ui.dtx = t;
  renderDiscTranscript(first);
}
// Transcript refresh on discussion.conversation.updated: throttled like refreshConv.
let discConvTimer = null;
function refreshDiscConv(id) {
  if (discConvTimer) { discConvTimer.again = true; return; }
  const entry = (discConvTimer = { again: false });
  setTimeout(async function tick() {
    if (ui.mode === "discussion" && ui.open === id) await loadDiscTranscript(false);
    if (entry.again && ui.mode === "discussion" && ui.open === id) { entry.again = false; setTimeout(tick, 350); return; }
    discConvTimer = null;
  }, 120);
}
const NOTICE_HEAD = { error: "The model failed", stopped: "Turn stopped", no_submission: "No drafts submitted" };
const noticeCard = (n) => `<div class="f-card disc-notice ${esc(n.kind)}"><div class="f-head"><span class="avatar core">F</span><b>Factory</b> · ${esc(NOTICE_HEAD[n.kind] ?? n.kind)} · ${stamp(n.at)}</div><div class="f-body">${md(n.text)}</div></div>`;
// Where each turn starts in the transcript: the first input is turn 1, a human message carries its turn in its id
// (`<id>-msg<seq>`), and a factory input after that starts a draft turn (otherwise it's a reminder within one).
function turnStarts(d, t) {
  const kindOf = (n) => d.turnCosts.find((c) => c.turn === n)?.kind ?? d.turn?.kind;
  const starts = [];
  let seq = 0;
  for (const it of t?.items ?? []) {
    if (it.role !== "user") continue;
    const m = it.author === "human" ? /-msg(\d+)$/.exec(it.msgId ?? "") : null;
    const s = m ? Number(m[1]) : seq === 0 ? 1 : kindOf(seq + 1) === "draft" ? seq + 1 : 0;
    if (s <= seq) continue;
    seq = s;
    starts.push({ k: it.author === "human" ? `msg:${it.msgId}` : it.entryId, seq: s });
  }
  return starts;
}
function discBlocks(d, t) {
  const blocks = t ? blocksFor(discAsRun(d), t) : [{ k: "__prep", html: `<p class="hint">${d.state === "FAILED" ? "The discussion failed before it started." : "Preparing the workspace. The conversation starts in a moment."}</p>` }];
  // Each finished turn's cost, then its notice, go after the turn: before the next turn's first block, or at the end.
  const extras = [
    ...d.turnCosts.map((c) => ({ after: c.turn, order: 0, at: 0, b: { k: `cost:${c.turn}`, cls: "turn-cost", html: `<span title="Cost of turn ${c.turn}">Turn ${c.turn}${c.kind === "draft" ? " · drafting" : ""} · ${money(c.usd)} · ${discTok(c.totalTokens)} tokens · ${discDur(c.durationMs)}</span>` } })),
    ...d.notices.map((n, i) => ({ after: n.turn ?? Infinity, order: 1, at: n.at, b: { k: `notice:${i}`, html: noticeCard(n) } })),
  ].sort((a, b) => a.after - b.after || a.order - b.order || a.at - b.at);
  const starts = turnStarts(d, t), slots = new Map();
  for (const x of extras) {
    const k = starts.find((s) => s.seq > x.after)?.k ?? "__end";
    if (!slots.has(k)) slots.set(k, []);
    slots.get(k).push(x.b);
  }
  const out = [];
  for (const b of blocks) {
    if (b.k === "__empty" && extras.length) continue;
    if (b.k === "__working") { out.push(...(slots.get("__end") ?? [])); slots.delete("__end"); }
    out.push(...(slots.get(b.k) ?? []), b);
  }
  out.push(...(slots.get("__end") ?? []));
  return out;
}
const NEW_CHAT_HINT = `<div class="chat-hint"><span class="chat-hint-ico">${ICON.chat}</span><b>Talk a problem through</b>
  <p>The model reads the repo and searches the web, but it can't change anything. When the problem is clear, ask it for draft tickets; each one you accept becomes a run on the board.</p></div>`;
function renderDiscTranscript(first) {
  if (isNewChat()) {
    $("#conv-head").innerHTML = "";
    const tx = $("#tx");
    if (ui.txConv !== NEW_CHAT) { tx.replaceChildren(); ui.txConv = NEW_CHAT; patch(tx, [{ k: "__hint", html: NEW_CHAT_HINT }], false); }
    return;
  }
  const d = openDisc(); if (!d) return;
  const t = ui.dtx, busy = !!t?.busy || !!d.turn;
  const [st, cls] = d.state === "PREPARING" ? [`<span class="spin"></span> Preparing`, "live"]
    : busy ? [`<span class="spin"></span> ${d.turn?.kind === "draft" ? "Drafting tickets" : "Replying"}`, "live"]
    : d.state === "OPEN" ? ["Your turn", "wait"] : [DISC_STATE[d.state]?.[0] ?? d.state, ""];
  $("#conv-head").innerHTML = `${avatar("discussant", busy)}<span class="who">Discussant</span><span class="conv-status ${cls}">${st}</span>`;
  const tx = $("#tx"), key = `disc:${d.id}`;
  if (first || ui.txConv !== key) { tx.replaceChildren(); ui.txConv = key; first = true; }
  settleScroll(first, patch(tx, discBlocks(d, t), !first));
  updateDiscLive(d, t);
}
// The live line while a turn runs a tool: "Discussant is running web_search · 0:12"; otherwise the composer's own text.
function updateDiscLive(d, t) {
  const line = $("#dc-live"); if (!line) return;
  const running = d.turn && t?.busy ? runningToolHtml("discussant", t) : null;
  line.innerHTML = running ?? line.dataset.base ?? "";
  ensureClocks();
}

// ---------------------------------------------------------------- composer: say (or start the chat), or Stop while a turn runs
function renderDiscComposer(d) {
  const key = d ? `${d.id}:${d.state}:${d.turn?.kind ?? ""}` : NEW_CHAT;
  if (key === ui.dComposerKey) return;
  const draft = $("#dc-input")?.value ?? "";
  ui.dComposerKey = key;
  const el = $("#composer");
  if (d?.state === "FAILED") {
    el.innerHTML = `<div class="cbox bad"><div class="c-status"><span class="c-ico bad">${ICON.warn}</span><div class="c-main"><span class="c-line">Failed</span><span class="c-sub">${esc(d.error ?? "")}</span></div><button type="button" class="btn primary lg" id="dc-retry">${ICON.retry} Retry</button></div></div>`;
    $("#dc-retry").addEventListener("click", (e) => { e.currentTarget.disabled = true; act(() => core.retryDiscussion(d.id), "Retrying").then(() => refreshDisc(d.id)); });
    return;
  }
  if (d?.state === "CLOSED") {
    el.innerHTML = `<div class="cbox"><div class="c-status"><span class="c-ico muted">${ICON.stop}</span><div class="c-main"><span class="c-line">Closed</span><span class="c-sub">Drafts can still become tickets. Reopen it to keep talking; the model picks up where it left off.</span></div><button type="button" class="btn lg" id="dc-reopen">${ICON.retry} Reopen</button></div></div>`;
    $("#dc-reopen").addEventListener("click", (e) => { e.currentTarget.disabled = true; act(() => core.reopenDiscussion(d.id), "Reopening").then(() => refreshDisc(d.id)); });
    return;
  }
  const open = !d || d.state === "OPEN", busy = !!d?.turn;
  const live = !d ? "New chat" : !open ? `<span class="shimmer">Preparing the workspace</span>` : busy ? `<span class="shimmer">The discussant is ${d.turn.kind === "draft" ? "drafting tickets" : "replying"}</span>` : "Your turn";
  el.innerHTML = `<div class="cbox">
    <div class="c-top"><span class="to-chip">To ${avatar("discussant", false)}<b>Discussant</b></span><span class="c-live-line" id="dc-live" data-base="${esc(live)}">${live}</span></div>
    <form class="c-input" id="dc-form"><textarea id="dc-input" rows="1" placeholder="${d ? "Message the discussant…" : "What's the problem? Ask anything about the repo…"}" aria-label="Message the discussant"${open ? "" : " disabled"}></textarea><button type="submit" class="send${busy ? " stop" : ""}" id="dc-send" aria-label="${busy ? "Stop the turn" : "Send message"}" title="${busy ? "Stop" : "Send"}"${open ? "" : " disabled"}>${busy ? ICON.stop : ICON.send}</button></form>
    <div class="c-foot"><span>${busy ? "Stop ends the turn; it isn't resumed" : "It reads the repo and can search the web; it can't change anything"}</span><span><kbd>Enter</kbd> to send · <kbd>Shift</kbd> + <kbd>Enter</kbd> for a new line</span></div></div>`;
  const ta = $("#dc-input"), send = $("#dc-send");
  const fit = () => { autosize(ta, busy ? null : send); if (!open) send.disabled = true; };
  ta.value = draft; fit();
  ta.addEventListener("input", fit);
  ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); if (!openDisc()?.turn) $("#dc-form").requestSubmit(); } });
  $("#dc-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (send.dataset.busy) return;
    if (!d) {
      const text = ta.value.trim(); if (!text || !isNewChat()) return;
      send.dataset.busy = "1"; send.disabled = true;
      const id = await startFromChat(text);
      delete send.dataset.busy;
      if (!id) return fit();
      ta.value = "";
      return showChat(id);
    }
    const cur = openDisc(); if (!cur) return;
    send.dataset.busy = "1"; send.disabled = true;
    if (busy) {
      const ok = await act(() => core.stopTurn(cur.id), "Stopping the turn");
      delete send.dataset.busy;
      if (!ok) send.disabled = false;
      return refreshDisc(cur.id);
    }
    const text = ta.value.trim();
    const ok = text ? await act(() => core.say(cur.id, text)) : false;
    delete send.dataset.busy;
    if (!ok) return fit();
    ta.value = ""; fit();
    ui.stick = true;
    refreshDisc(cur.id); refreshDiscConv(cur.id);
  });
}
/** The first message of a blank new chat: create the project if it is new, then start the discussion (no title). */
async function startFromChat(text) {
  const c = ui.chat;
  let id;
  const ok = await act(async () => {
    if (c.project === "__new") {
      const name = c.newName.trim(), repo = c.newRepo.trim();
      if (!name || !repo) throw new Error("Name the new project and its repo (owner/name) first.");
      const np = await core.createProject(name, repo);
      c.project = np.name;
      ui.projects = await core.listProjects(); renderProjectFilter();
      if (!c.touched) await prefillChat();
    }
    const model = c.model.trim(), thinking = c.thinking;
    id = await core.startDiscussion(c.project, { message: text, ...(model && thinking ? { model: { model, thinking } } : {}) });
    ui.discs.set(id, await core.getDiscussion(id));
  });
  if (ui.chat === c && isNewChat()) { renderChatbar(); renderRail(); }
  return ok ? id : null;
}

// ---------------------------------------------------------------- drafts panel (the details slot)
const editingDraft = () => !!document.activeElement?.matches?.("#rv-details-inner [data-keep]");
function draftCard(d, x, locked) {
  if (x.runId) {
    return `<div class="draft done" data-draft="${esc(x.id)}">
      <div class="draft-top"><span class="key">${esc(x.id)}</span><span class="draft-title">${esc(x.title)}</span></div>
      <div class="draft-run"><button type="button" class="btn small" data-open-run="${esc(x.runId)}">Open ${esc(keyOf(x.runId))}</button>${stateLabel(draftRun(d, x.runId))}</div>
      <details><summary class="meta">Request</summary><div class="f-body">${md(x.body)}</div></details></div>`;
  }
  const ticket = !locked; // any discussion state (a run never depends on it); only drafting locks the drafts
  return `<div class="draft${locked ? " locked" : ""}" data-draft="${esc(x.id)}" data-disc="${esc(d.id)}">
    <div class="draft-top"><span class="key">${esc(x.id)}</span>${x.edited ? `<span class="meta">edited</span>` : ""}</div>
    <input class="draft-title-in" data-keep data-field="title" value="${esc(x.title)}" aria-label="Title of draft ${esc(x.id)}" autocomplete="off"${locked ? " disabled" : ""}>
    <div class="draft-body f-body" data-preview${locked ? "" : ` tabindex="0" role="button" title="Click to edit" aria-label="Edit the body of draft ${esc(x.id)}"`}>${md(x.body)}</div>
    <textarea class="draft-body-in" data-keep data-field="body" rows="10" hidden aria-label="Body of draft ${esc(x.id)} (markdown)"${locked ? " disabled" : ""}>${esc(x.body)}</textarea>
    <div class="draft-actions"><button type="button" class="btn small primary" data-ticket${ticket ? "" : " disabled"}>Create ticket</button><button type="button" class="btn small ghost" data-delete${locked ? " disabled" : ""}>Delete</button></div></div>`;
}
function renderDrafts(d) {
  // Don't pull a field out from under the human: render again once focus leaves it.
  if (editingDraft()) { ui.dRenderLater = true; return; }
  ui.dRenderLater = false;
  const instr = $("#dd-instr")?.value ?? "";
  const drafting = d.turn?.kind === "draft", canDraft = d.state === "OPEN" && !d.turn;
  const pendingN = d.drafts.filter((x) => !x.runId).length;
  const ws = d.workspace, a = ago(d.createdAt);
  $("#rv-details-inner").innerHTML = `
    <div class="kpis"><div class="kpi"><span class="k">State</span><span class="v">${esc(DISC_STATE[d.state]?.[0] ?? d.state)}</span></div><div class="kpi"><span class="k">Drafts</span><span class="v">${d.drafts.length}</span></div><div class="kpi"><span class="k">Cost</span><span class="v kpi-cost">${money(discUsd(d))}</span></div></div>
    <section class="d-sec"><h4>Draft tickets</h4>${drafting ? `<div class="notice drafting"><span class="spin"></span> Drafting in progress. The drafts can't be edited until the model submits.</div>` : `
      <div class="field"><label for="dd-instr">Instructions <span class="meta">(optional)</span></label><textarea id="dd-instr" data-keep rows="2" placeholder="e.g. Keep the API and the UI in separate tickets"${canDraft ? "" : " disabled"}></textarea></div>
      <div class="dd-go"><button type="button" class="btn primary small" id="dd-draft"${canDraft ? "" : " disabled"}>${pendingN ? "Redraft tickets" : "Draft tickets"}</button><span class="meta">${d.state !== "OPEN" ? "Drafting needs an open discussion." : d.turn ? "Wait for the reply, or stop it." : "The model writes a summary and the tickets."}</span></div>`}
    </section>
    ${d.summary ? `<section class="d-sec"><h4>Summary</h4><div class="f-body">${md(d.summary)}</div></section>` : ""}
    ${d.drafts.length ? `<section class="d-sec"><h4>Drafts <span>${d.drafts.length}</span></h4><div class="drafts">${d.drafts.map((x) => draftCard(d, x, drafting)).join("")}</div></section>` : ""}
    <section class="d-sec"><h4>Discussion</h4><dl class="dl">
      <dt>Title</dt><dd>${esc(d.title)}</dd>
      <dt>Project</dt><dd>${esc(d.project)}</dd><dt>Repo</dt><dd>${esc(d.repo)}</dd>
      <dt>Model</dt><dd class="mono">${esc(d.model.model)} · ${esc(d.model.thinking)}</dd>
      ${ws ? `<dt>Workspace</dt><dd class="mono">${esc(ws.path)}</dd>` : ""}
      <dt>Id</dt><dd class="mono">${esc(d.id)}</dd><dt>Opened</dt><dd>${a === "now" ? "just now" : `${a} ago`}</dd></dl></section>`;
  const ta = $("#dd-instr");
  if (ta) ta.value = instr;
}
function flushDraftRender() {
  if (!ui.dRenderLater || editingDraft()) return;
  const d = openDisc(); if (d) renderDrafts(d);
}
function editBody(card) {
  const pv = $("[data-preview]", card), ta = $("textarea[data-field]", card);
  if (!pv || !ta || ta.disabled) return;
  pv.hidden = true; ta.hidden = false; ta.focus();
}
async function draftAction(e) {
  const d = openDisc(); if (!d) return;
  const t = e.target;
  if (t.closest("#dd-draft")) {
    const n = d.drafts.filter((x) => !x.runId).length;
    if (n && !(await confirmBox("Redraft tickets?", `This replaces ${plural(n, "draft")}. Drafts that became tickets are kept.`, "Redraft"))) return;
    const instr = $("#dd-instr")?.value.trim() ?? "";
    if (await act(() => (instr ? core.requestDrafts(d.id, instr) : core.requestDrafts(d.id)), "Drafting tickets")) { if ($("#dd-instr")) $("#dd-instr").value = ""; ui.stick = true; }
    return refreshDisc(d.id);
  }
  const card = t.closest("[data-draft]"); if (!card) return;
  const x = d.drafts.find((y) => y.id === card.dataset.draft); if (!x) return;
  const run = t.closest("[data-open-run]");
  if (run) return openRunFromDiscussion(run.dataset.openRun);
  if (t.closest("[data-preview]")) return editBody(card);
  if (t.closest("[data-delete]")) {
    if (!(await confirmBox(`Delete ${x.id}?`, `"${x.title}" is removed from the drafts.`, "Delete draft"))) return;
    await ui.dSaving;
    await act(() => core.deleteDraft(d.id, x.id), `Deleted ${x.id}`);
    return refreshDisc(d.id);
  }
  if (t.closest("[data-ticket]")) {
    const b = t.closest("[data-ticket]");
    b.disabled = true;
    await ui.dSaving; // an edit saved on blur goes in first
    let runId;
    if (!(await act(async () => { runId = await core.createTicket(d.id, x.id); }))) { b.disabled = false; return; }
    toast(`${x.id} is now a ticket on the board.`);
    refreshRun(runId); refreshDisc(d.id);
  }
}
// Edits are saved when a field loses focus, and only when the text changed.
function saveDraftField(f) {
  const card = f.closest("[data-draft]"), d = ui.discs.get(card?.dataset.disc);
  const x = d?.drafts.find((y) => y.id === card?.dataset.draft);
  const field = f.dataset.field;
  if (field === "body") { const pv = $("[data-preview]", card); pv.innerHTML = md(f.value); pv.hidden = false; f.hidden = true; }
  if (!x || x.runId) return;
  const value = field === "title" ? f.value.trim() : f.value;
  if (value === x[field]) return;
  if (!value.trim()) { toast(`A draft needs a ${field}.`, "error"); f.value = x[field]; if (field === "body") $("[data-preview]", card).innerHTML = md(x.body); return; }
  const before = x[field];
  x[field] = value; x.edited = true; // shown at once; the refresh below brings the core's view
  ui.dSaving = ui.dSaving.then(async () => {
    if (!(await act(() => core.updateDraft(d.id, x.id, { [field]: value })))) x[field] = before;
    refreshDisc(d.id);
  });
}
async function openRunFromDiscussion(runId) {
  if (!ui.runs.has(runId)) {
    try { ui.runs.set(runId, await core.getRun(runId)); } catch (e) { toast(openErrorText(e), "error"); return; }
  }
  await closeRun();
  openRun(runId, cardEl(runId));
}

// ===================================================================== events → cache
const pendingDiscs = new Set(); let discFlushTimer = 0;
function refreshDisc(id) { pendingDiscs.add(id); if (!discFlushTimer) discFlushTimer = setTimeout(flushDiscs, 60); }
async function flushDiscs() {
  discFlushTimer = 0;
  const ids = [...pendingDiscs]; pendingDiscs.clear();
  const gone = new Map(); // id → project of a discussion that no longer exists (only a project deletion retires one)
  await Promise.all(ids.map(async (id) => {
    try { ui.discs.set(id, await core.getDiscussion(id)); } catch (e) { if (e.code === "not_found") { gone.set(id, ui.discs.get(id)?.project); ui.discs.delete(id); } }
  }));
  if (ui.mode !== "discussion") return;
  renderRail();
  if (!ids.includes(ui.open)) return;
  const d = openDisc();
  if (!d) {
    // Its project was deleted (the purge came before project.deleted reached this tab): say so, as projectDeleted does.
    const project = gone.get(ui.open);
    await closeRun();
    if (project) toast(`Project ${project} was deleted`);
    return;
  }
  renderDiscussionView();
  // The conversation exists now (its updates may have come before this view of the discussion did).
  if (d.conversationId != null && !ui.dtx) loadDiscTranscript(false);
}
function onDiscussionEvent(e) {
  const mine = ui.mode === "discussion" && ui.open === e.discussion;
  if (e.type === "discussion.conversation.updated") { if (mine) refreshDiscConv(e.discussion); return; }
  refreshDisc(e.discussion);
  if (mine) { refreshDiscConv(e.discussion); return; }
  const title = ui.discs.get(e.discussion)?.title ?? e.discussion;
  const go = () => openDiscussion(e.discussion);
  if (e.type === "discussion.updated" && e.what === "drafts" && e.submission) toast(`Draft tickets are ready in "${title}"`, "", go);
  // Not when its project is being deleted (deleteProject ends open discussions just before the purge): wait for that.
  if (e.type === "discussion.state" && e.to === "FAILED")
    setTimeout(() => { if (ui.discs.has(e.discussion) && ui.projects.some((p) => p.name === e.project)) toast(`The discussion "${ui.discs.get(e.discussion)?.title ?? title}" failed`, "error", go); }, 1500);
}
// Runs changed (app.js's flush): their state chips in the open discussion's drafts.
function discussionRunsChanged(ids) {
  const d = openDisc();
  if (d && d.drafts.some((x) => x.runId && ids.includes(x.runId))) renderDrafts(d);
}

// ===================================================================== wiring
(function wireDiscussions() {
  $("#rv-threads").addEventListener("click", railClick);
  const bar = $("#chatbar");
  bar.addEventListener("change", chatbarInput);
  bar.addEventListener("input", (e) => { if (e.target.matches("input")) chatbarInput(e); });
  $("#rv-disc-actions").addEventListener("click", discActionClick);
  // The overflow menu closes on a click elsewhere and on Escape (before Escape closes the chat view).
  document.addEventListener("click", (e) => { if (ui.menuOpen && !e.target.closest?.(".more-wrap")) closeMenu(); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && ui.menuOpen && !modalStack.length) { e.stopPropagation(); closeMenu(); $("#dh-more")?.focus(); }
  }, true);
  const inner = $("#rv-details-inner");
  inner.addEventListener("click", (e) => { if (ui.mode === "discussion") draftAction(e); });
  inner.addEventListener("keydown", (e) => {
    if (ui.mode !== "discussion") return;
    const pv = e.target.closest?.("[data-preview]");
    if (pv && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); editBody(pv.closest("[data-draft]")); }
  });
  // A render held back while a field had focus happens when focus leaves; after a click, once the click is handled.
  let pointerDown = false;
  document.addEventListener("pointerdown", () => (pointerDown = true), true);
  for (const ev of ["pointerup", "pointercancel"]) document.addEventListener(ev, () => { pointerDown = false; setTimeout(flushDraftRender, 0); }, true);
  inner.addEventListener("focusout", (e) => {
    if (e.target.matches?.("[data-field]")) saveDraftField(e.target);
    if (ui.mode === "discussion" && !pointerDown) setTimeout(flushDraftRender, 0);
  });
  // Escape in a draft field ends the edit (and saves it) rather than closing the view.
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !modalStack.length && editingDraft()) { e.stopPropagation(); document.activeElement.blur(); }
  }, true);
  // The rail's "active … ago" ticks while the chat view shows.
  setInterval(() => { if (ui.mode === "discussion") renderRail(); }, 60000);
})();
