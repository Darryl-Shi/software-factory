"use strict";
// Discussions (discussions spec §3): the list, the New discussion dialog, and the discussion view. The view is the run
// view's sheet (#runview with data-mode="discussion") without the pipeline strip, the threads rail and the timeline:
// it reuses the run view's transcript renderer, composer styles and details slot, which holds the drafts panel.
// A classic script loaded after app.js, so app.js's helpers (`core`, `ui`, `$`, `esc`, `md`, `act`, `toast`,
// `openModal`, `blocksFor`, `patch`, …) are shared globals. All state is a cache of core reads and events.

Object.assign(ui, { dfilter: { closed: false }, dtx: null, dComposerKey: null, dRenderLater: false, dSaving: Promise.resolve() });
ROLE_LETTER.discussant = "D";

const DISC_STATE = { PREPARING: ["Preparing", ""], OPEN: ["Open", "progress"], CLOSED: ["Closed", ""], FAILED: ["Failed", "bad"] };
const discLabel = (d) => { const [text, cls] = DISC_STATE[d.state] ?? [d.state, ""]; return `<span class="lozenge ${cls}" title="${esc(d.state)}">${esc(text)}</span>`; };
const openDisc = () => (ui.mode === "discussion" ? ui.discs.get(ui.open) : undefined);
// A run a draft became: the live run from the board's cache, else the state the discussion reported.
const draftRun = (d, id) => ui.runs.get(id) ?? { state: d.runs.find((x) => x.id === id)?.state ?? "RECEIVED" };
const activeAgo = (t) => { const a = ago(t); return a === "now" ? "active just now" : `active ${a} ago`; };
const discTok = (n) => (n >= 10000 ? `${(n / 1000).toFixed(0)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
const discDur = (ms) => (ms < 60000 ? `${Math.max(1, Math.round(ms / 1000))}s` : `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`);

// ===================================================================== list
function visibleDiscussions() {
  return [...ui.discs.values()]
    .filter((d) => (!ui.filter.project || d.project === ui.filter.project) && (ui.dfilter.closed || d.state !== "CLOSED"))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}
function discRowHtml(d) {
  const runs = d.drafts.filter((x) => x.runId).map((x) => `<span class="disc-run"><span class="key">${esc(keyOf(x.runId))}</span>${stateLabel(draftRun(d, x.runId))}</span>`).join("");
  return `<button type="button" class="disc-row${d.state === "CLOSED" ? " closed" : ""}" data-id="${esc(d.id)}">
    <span class="dr-main"><span class="card-title">${esc(d.title)}</span>
      <span class="card-row">${discLabel(d)}${d.turn ? `<span class="live-dot" title="${d.turn.kind === "draft" ? "Drafting tickets" : "Replying"}"></span>` : ""}${ui.filter.project ? "" : `<span class="pchip">${esc(d.project)}</span>`}<span class="chip-model">${esc(d.model.model)} · ${esc(d.model.thinking)}</span></span></span>
    <span class="dr-side"><span class="meta">${plural(d.drafts.length, "draft")} · ${money(d.cost.usd)} · ${activeAgo(d.updatedAt)}</span>${runs ? `<span class="card-row">${runs}</span>` : ""}</span>
  </button>`;
}
const discRowEl = (id) => [...document.querySelectorAll(".disc-row")].find((el) => el.dataset.id === id);
function renderDiscussions() {
  const sel = $("#disc-proj");
  sel.innerHTML = `<option value="">All projects</option>` + ui.projects.map((p) => `<option value="${esc(p.name)}">${esc(p.name)} · ${esc(p.repo)}</option>`).join("");
  sel.value = ui.filter.project;
  const all = [...ui.discs.values()].filter((d) => !ui.filter.project || d.project === ui.filter.project);
  $("#disc-n-closed").textContent = all.filter((d) => d.state === "CLOSED").length;
  const focused = document.activeElement?.closest?.(".disc-row")?.dataset.id;
  const list = visibleDiscussions();
  $("#disc-list").innerHTML = list.map(discRowHtml).join("")
    || `<div class="col-empty">${all.length ? "No open discussions. <b>Show closed</b> lists the closed ones." : "Press <b>New discussion</b> to talk a problem through with a model before it becomes a ticket."}</div>`;
  if (focused) [...$("#disc-list").querySelectorAll(".disc-row")].find((el) => el.dataset.id === focused)?.focus({ preventScroll: true });
}

// ===================================================================== New discussion dialog (like Create)
function openNewDiscussion() {
  const opts = ui.projects.map((p) => `<option value="${esc(p.name)}">${esc(p.name)} · ${esc(p.repo)}</option>`).join("");
  const none = ui.projects.length === 0;
  const root = openModal(`<form class="modal" id="nd-form" novalidate>
    <div class="modal-head"><h2>New discussion</h2><button type="button" class="icon-btn" data-close aria-label="Close">${CLOSE_SVG}</button></div>
    <div class="modal-body">
      <div class="field"><label for="nd-project">Project</label><select id="nd-project">${opts}<option value="__new"${none ? " selected" : ""}>New project…</option></select></div>
      <div class="ff-row" id="nd-newproj"${none ? "" : " hidden"}>
        <div class="field"><label for="nd-pname">Name</label><input id="nd-pname" placeholder="todo" autocomplete="off"></div>
        <div class="field"><label for="nd-prepo">Repo</label><input id="nd-prepo" placeholder="owner/name" autocomplete="off"></div>
        <p class="hint" style="grid-column:1/-1;margin:0">If the repo doesn't exist, the factory creates it as a private repo at the first delivery.</p>
      </div>
      <div class="field"><label for="nd-title">Title</label><input id="nd-title" placeholder="How should exports handle large projects?" autocomplete="off"></div>
      <div class="nd-model">
        <div class="field"><label for="nd-model-in">Model</label><div class="set-ctl" id="nd-model"><span class="spin"></span></div></div>
        <div class="field"><label for="nd-thinking-in">Thinking</label><div class="set-ctl" id="nd-thinking"></div></div>
      </div>
      <div class="field"><label for="nd-message">First message</label><textarea id="nd-message" rows="5" placeholder="What's the problem? The model reads the repo, checks its claims and asks about anything unclear."></textarea></div>
      <p class="hint">The model can read the repo and search the web but can't change anything. When the problem is clear, ask it for draft tickets; each one you accept becomes a run on the board.</p>
    </div>
    <div class="modal-foot"><button type="button" class="btn" data-close>Cancel</button><button type="submit" class="btn primary">Start discussion</button></div>
  </form>`);
  const form = $("#nd-form", root), project = $("#nd-project", root);
  if (ui.filter.project) project.value = ui.filter.project;
  let touched = false, seq = 0;
  // Model and thinking: the Settings form's fields for discussion.model.*, prefilled with the project's effective value.
  const prefill = async () => {
    const mine = ++seq, p = project.value;
    let eff;
    try {
      ui.schema ??= await core.settingsSchema();
      eff = await core.getSettings(p && p !== "__new" ? { project: p } : { global: true });
    } catch (e) { toast(String(e.message ?? e), "error"); return; }
    if (touched || mine !== seq || !root.isConnected) return;
    const leaves = walk(ui.schema);
    for (const [path, slot, id] of [["discussion.model.model", "#nd-model", "nd-model-in"], ["discussion.model.thinking", "#nd-thinking", "nd-thinking-in"]]) {
      const field = leaves.find((x) => x.path === path)?.field ?? { type: "string" };
      $(slot, root).innerHTML = control(path, field, eff[path]?.value);
      $(`${slot} [data-set]`, root).id = id;
    }
  };
  for (const slot of ["#nd-model", "#nd-thinking"]) for (const ev of ["input", "change"]) $(slot, root).addEventListener(ev, () => (touched = true));
  root.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", closeModal));
  project.addEventListener("change", (e) => { $("#nd-newproj", root).hidden = e.target.value !== "__new"; prefill(); });
  prefill();
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    let p = project.value;
    const title = $("#nd-title", root).value.trim(), message = $("#nd-message", root).value.trim();
    if (!title) { toast("Add a title first.", "error"); $("#nd-title", root).focus(); return; }
    if (!message) { toast("Write the first message.", "error"); $("#nd-message", root).focus(); return; }
    const model = $("#nd-model-in", root)?.value.trim(), thinking = $("#nd-thinking-in", root)?.value;
    const submit = form.querySelector("button[type=submit]");
    submit.disabled = true;
    let id;
    const ok = await act(async () => {
      if (p === "__new") {
        const np = await core.createProject($("#nd-pname", root).value.trim(), $("#nd-prepo", root).value.trim());
        p = np.name; ui.projects = await core.listProjects(); renderProjectFilter();
        project.insertAdjacentHTML("afterbegin", `<option value="${esc(np.name)}">${esc(np.name)}</option>`);
        project.value = np.name; $("#nd-newproj", root).hidden = true;
      }
      id = await core.startDiscussion(p, { title, message, ...(model && thinking ? { model: { model, thinking } } : {}) });
      ui.discs.set(id, await core.getDiscussion(id));
      closeModal();
    });
    if (!ok) { submit.disabled = false; return; }
    if ($("#view-discussions").hidden) showView("discussions"); else renderDiscussions();
    openDiscussion(id, discRowEl(id));
  });
}

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

// ===================================================================== discussion view (the run view's sheet)
async function openDiscussion(id, fromEl) {
  if (ui.open) {
    if (ui.open === id && ui.mode === "discussion") return;
    await closeRun();
    if (ui.open) return;
  }
  let d;
  try { d = await core.getDiscussion(id); }
  catch (e) {
    toast(String(e.message ?? e), "error");
    if (/^#disc=/.test(location.hash)) try { history.replaceState(null, "", location.pathname); } catch {}
    return;
  }
  if (ui.open) return;
  ui.discs.set(id, d);
  Object.assign(ui, { open: id, mode: "discussion", dtx: null, dComposerKey: null, dRenderLater: false, stick: true, txConv: null });
  try { history.replaceState(null, "", `#disc=${encodeURIComponent(id)}`); } catch {}
  const rv = $("#runview"), bd = $("#rv-backdrop");
  rv.dataset.mode = "discussion";
  $("#dock").hidden = true; $("#dock").innerHTML = ""; setDockPad();
  $("#composer").innerHTML = ""; $("#rv-progress").innerHTML = ""; $("#rv-threads").innerHTML = ""; $("#rv-details-inner").innerHTML = "";
  ui.tx.clear();
  setDetails(preferDetails()); showJump(false);
  $("#tx").replaceChildren();
  bd.hidden = false; rv.hidden = false;
  renderDiscussionView();
  requestAnimationFrame(() => bd.classList.add("on"));
  if (!reduceMotion()) {
    rv.animate([{ clipPath: insetOf(fromEl) ?? "inset(3% 3% 3% 3% round 18px)" }, { clipPath: "inset(0px 0px 0px 0px round 0px)" }], { duration: 520, easing: "cubic-bezier(.2, .85, .25, 1)" });
    rv.querySelectorAll(".rv-top, .rv-body").forEach((el) => el.animate([{ opacity: 0 }, { opacity: 0, offset: 0.3 }, { opacity: 1 }], { duration: 520, easing: "ease-out" }));
  }
  await loadDiscTranscript(true);
  if (ui.open === id) ($("#dc-input:not(:disabled)") ?? $("#rv-close")).focus({ preventScroll: true });
}
function renderDiscussionView() {
  const d = openDisc(); if (!d) return;
  $("#rv-key").textContent = d.project;
  $("#rv-title").textContent = d.title;
  $("#rv-state").innerHTML = discLabel(d);
  $("#rv-cost").textContent = money(d.cost.usd);
  renderDiscActions(d); renderDiscComposer(d); renderDrafts(d); renderDiscTranscript(false);
}
function resyncDiscussion() {
  if (!openDisc()) return closeRun();
  renderDiscussionView(); loadDiscTranscript(false);
}
function renderDiscActions(d) {
  const el = $("#rv-disc-actions");
  el.innerHTML = d.state === "OPEN" ? `<button type="button" class="btn small" id="dh-close"${d.turn ? ` disabled title="Wait for the reply, or stop it, before closing"` : ""}>Close discussion</button>`
    : d.state === "CLOSED" ? `<button type="button" class="btn small" id="dh-reopen">${ICON.retry} Reopen</button>`
    : d.state === "FAILED" ? `<button type="button" class="btn small primary" id="dh-retry">${ICON.retry} Retry</button>` : "";
  $("#dh-close")?.addEventListener("click", (e) => { e.currentTarget.disabled = true; act(() => core.closeDiscussion(d.id), "Discussion closed. Its drafts can still become tickets.").then(() => refreshDisc(d.id)); });
  $("#dh-reopen")?.addEventListener("click", (e) => { e.currentTarget.disabled = true; act(() => core.reopenDiscussion(d.id), "Reopening").then(() => refreshDisc(d.id)); });
  $("#dh-retry")?.addEventListener("click", (e) => { e.currentTarget.disabled = true; act(() => core.retryDiscussion(d.id), "Retrying").then(() => refreshDisc(d.id)); });
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
function renderDiscTranscript(first) {
  const d = openDisc(); if (!d) return;
  const t = ui.dtx, busy = !!t?.busy || !!d.turn;
  const [st, cls] = d.state === "PREPARING" ? [`<span class="spin"></span> Preparing`, "live"]
    : busy ? [`<span class="spin"></span> ${d.turn?.kind === "draft" ? "Drafting tickets" : "Replying"}`, "live"]
    : d.state === "OPEN" ? ["Your turn", "wait"] : [DISC_STATE[d.state]?.[0] ?? d.state, ""];
  $("#conv-head").innerHTML = `${avatar("discussant", busy)}<span class="who">Discussant</span><span class="chip-model">${esc(d.model.model)} · ${esc(d.model.thinking)}</span><span class="conv-status ${cls}">${st}</span>`;
  const tx = $("#tx"), key = `disc:${d.id}`;
  if (first || ui.txConv !== key) { tx.replaceChildren(); ui.txConv = key; first = true; }
  settleScroll(first, patch(tx, discBlocks(d, t), !first));
}

// ---------------------------------------------------------------- composer: say, or Stop while a turn runs
function renderDiscComposer(d) {
  const key = `${d.state}:${d.turn?.kind ?? ""}`;
  if (key === ui.dComposerKey) return;
  const draft = $("#dc-input")?.value ?? "";
  ui.dComposerKey = key;
  const el = $("#composer");
  if (d.state === "FAILED") {
    el.innerHTML = `<div class="cbox bad"><div class="c-status"><span class="c-ico bad">${ICON.warn}</span><div class="c-main"><span class="c-line">The discussion failed</span><span class="c-sub">${esc(d.error ?? "")}</span></div><button type="button" class="btn primary lg" id="dc-retry">${ICON.retry} Retry</button></div></div>`;
    $("#dc-retry").addEventListener("click", (e) => { e.currentTarget.disabled = true; act(() => core.retryDiscussion(d.id), "Retrying").then(() => refreshDisc(d.id)); });
    return;
  }
  if (d.state === "CLOSED") {
    el.innerHTML = `<div class="cbox"><div class="c-status"><span class="c-ico muted">${ICON.stop}</span><div class="c-main"><span class="c-line">Closed</span><span class="c-sub">Drafts can still become tickets. Reopen it to keep talking; the model picks up where it left off.</span></div><button type="button" class="btn lg" id="dc-reopen">${ICON.retry} Reopen</button></div></div>`;
    $("#dc-reopen").addEventListener("click", (e) => { e.currentTarget.disabled = true; act(() => core.reopenDiscussion(d.id), "Reopening").then(() => refreshDisc(d.id)); });
    return;
  }
  const open = d.state === "OPEN", busy = !!d.turn;
  const live = !open ? `<span class="shimmer">Preparing the workspace</span>` : busy ? `<span class="shimmer">The discussant is ${d.turn.kind === "draft" ? "drafting tickets" : "replying"}</span>` : "Your turn";
  el.innerHTML = `<div class="cbox">
    <div class="c-top"><span class="to-chip">To ${avatar("discussant", false)}<b>Discussant</b></span><span class="c-live-line">${live}</span></div>
    <form class="c-input" id="dc-form"><textarea id="dc-input" rows="1" placeholder="Message the discussant…" aria-label="Message the discussant"${open ? "" : " disabled"}></textarea><button type="submit" class="send${busy ? " stop" : ""}" id="dc-send" aria-label="${busy ? "Stop the turn" : "Send message"}" title="${busy ? "Stop" : "Send"}"${open ? "" : " disabled"}>${busy ? ICON.stop : ICON.send}</button></form>
    <div class="c-foot"><span>${busy ? "Stop ends the turn; it isn't resumed" : "It reads the repo and can search the web; it can't change anything"}</span><span><kbd>Enter</kbd> to send · <kbd>Shift</kbd> + <kbd>Enter</kbd> for a new line</span></div></div>`;
  const ta = $("#dc-input"), send = $("#dc-send");
  const fit = () => { autosize(ta, busy ? null : send); if (!open) send.disabled = true; };
  ta.value = draft; fit();
  ta.addEventListener("input", fit);
  ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); if (!openDisc()?.turn) $("#dc-form").requestSubmit(); } });
  $("#dc-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const cur = openDisc(); if (!cur || send.dataset.busy) return;
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

// ---------------------------------------------------------------- drafts panel (the details slot)
const editingDraft = () => !!document.activeElement?.matches?.("#rv-details-inner [data-keep]");
function draftCard(d, x, locked) {
  if (x.runId) {
    return `<div class="draft done" data-draft="${esc(x.id)}">
      <div class="draft-top"><span class="key">${esc(x.id)}</span><span class="draft-title">${esc(x.title)}</span></div>
      <div class="draft-run"><button type="button" class="btn small" data-open-run="${esc(x.runId)}">Open ${esc(keyOf(x.runId))}</button>${stateLabel(draftRun(d, x.runId))}</div>
      <details><summary class="meta">Request</summary><div class="f-body">${md(x.body)}</div></details></div>`;
  }
  const ticket = (d.state === "OPEN" || d.state === "CLOSED") && !locked;
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
    <div class="kpis"><div class="kpi"><span class="k">State</span><span class="v">${esc(DISC_STATE[d.state]?.[0] ?? d.state)}</span></div><div class="kpi"><span class="k">Drafts</span><span class="v">${d.drafts.length}</span></div><div class="kpi"><span class="k">Cost</span><span class="v">${money(d.cost.usd)}</span></div></div>
    <section class="d-sec"><h4>Draft tickets</h4>${drafting ? `<div class="notice drafting"><span class="spin"></span> Drafting in progress. The drafts can't be edited until the model submits.</div>` : `
      <div class="field"><label for="dd-instr">Instructions <span class="meta">(optional)</span></label><textarea id="dd-instr" data-keep rows="2" placeholder="e.g. Keep the API and the UI in separate tickets"${canDraft ? "" : " disabled"}></textarea></div>
      <div class="dd-go"><button type="button" class="btn primary small" id="dd-draft"${canDraft ? "" : " disabled"}>${pendingN ? "Redraft tickets" : "Draft tickets"}</button><span class="meta">${d.state !== "OPEN" ? "Drafting needs an open discussion." : d.turn ? "Wait for the reply, or stop it." : "The model writes a summary and the tickets."}</span></div>`}
    </section>
    ${d.summary ? `<section class="d-sec"><h4>Summary</h4><div class="f-body">${md(d.summary)}</div></section>` : ""}
    ${d.drafts.length ? `<section class="d-sec"><h4>Drafts <span>${d.drafts.length}</span></h4><div class="drafts">${d.drafts.map((x) => draftCard(d, x, drafting)).join("")}</div></section>` : ""}
    <section class="d-sec"><h4>Discussion</h4><dl class="dl">
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
    try { ui.runs.set(runId, await core.getRun(runId)); } catch (e) { toast(String(e.message ?? e), "error"); return; }
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
  await Promise.all(ids.map(async (id) => {
    try { ui.discs.set(id, await core.getDiscussion(id)); } catch (e) { if (e.code === "not_found") ui.discs.delete(id); }
  }));
  if (!$("#view-discussions").hidden) renderDiscussions();
  if (ui.mode === "discussion" && ids.includes(ui.open)) { if (openDisc()) renderDiscussionView(); else closeRun(); }
}
function onDiscussionEvent(e) {
  const mine = ui.mode === "discussion" && ui.open === e.discussion;
  if (e.type === "discussion.conversation.updated") { if (mine) refreshDiscConv(e.discussion); return; }
  refreshDisc(e.discussion);
  if (mine) { refreshDiscConv(e.discussion); return; }
  const title = ui.discs.get(e.discussion)?.title ?? e.discussion;
  if (e.type === "discussion.updated" && e.what === "drafts") toast(`Draft tickets are ready in "${title}"`);
  if (e.type === "discussion.state" && e.to === "FAILED") toast(`The discussion "${title}" failed`, "error");
}
// Runs changed (app.js's flush): their state chips in the list and in the open discussion's drafts.
function discussionRunsChanged(ids) {
  const touches = (d) => d.drafts.some((x) => x.runId && ids.includes(x.runId));
  if (!$("#view-discussions").hidden && [...ui.discs.values()].some(touches)) renderDiscussions();
  const d = openDisc();
  if (d && touches(d)) renderDrafts(d);
}

// ===================================================================== wiring
(function wireDiscussions() {
  $("#disc-proj").addEventListener("change", (e) => { ui.filter.project = e.target.value; renderProjectFilter(); renderDiscussions(); });
  $("#disc-closed").addEventListener("click", (e) => { ui.dfilter.closed = !ui.dfilter.closed; e.currentTarget.setAttribute("aria-pressed", String(ui.dfilter.closed)); renderDiscussions(); });
  $("#disc-new").addEventListener("click", openNewDiscussion);
  $("#disc-list").addEventListener("click", (e) => { const row = e.target.closest(".disc-row"); if (row) openDiscussion(row.dataset.id, row); });
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
  document.addEventListener("pointerup", () => { pointerDown = false; setTimeout(flushDraftRender, 0); }, true);
  inner.addEventListener("focusout", (e) => {
    if (e.target.matches?.("[data-field]")) saveDraftField(e.target);
    if (ui.mode === "discussion" && !pointerDown) setTimeout(flushDraftRender, 0);
  });
  // Escape in a draft field ends the edit (and saves it) rather than closing the view.
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !modalStack.length && editingDraft()) { e.stopPropagation(); document.activeElement.blur(); }
  }, true);
  setInterval(() => { if (!$("#view-discussions").hidden && !ui.open) renderDiscussions(); }, 60000);
})();
