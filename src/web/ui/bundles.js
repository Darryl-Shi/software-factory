"use strict";
// Bundles (bundles spec §4): the bundle view and its action cards. The view is the run view's sheet (#runview with
// data-mode="bundle"): the left rail lists the integrator, the reviewers and QA conversations plus a timeline, the
// transcript reuses the run view's renderer, the chat box goes to `messageBundle`, and the floating card carries the
// Merge, escalation and Retry decisions. The board's bundle cards, the Ready column and the bundle cache are in app.js.
// A classic script loaded after app.js and discussions.js: their helpers (`core`, `ui`, `$`, `esc`, `md`, `act`,
// `toast`, `blocksFor`, `patch`, `confirmBox`, …) are shared globals. All state is a cache of core reads and events.

Object.assign(ui, { bdock: { key: null, ask: null, mode: null, min: false }, bComposerKey: null });
const openBundleData = () => (ui.mode === "bundle" ? ui.bundles.get(ui.open) : undefined);
// Mirrors the routing rule of `messageBundle`: the reviewer while REVIEWING, otherwise the integrator.
function bundleChatTarget(b) {
  const c = b.conversations;
  if (b.state === "REVIEWING") return { role: "reviewer", cid: (c.reviewers ?? []).find((x) => same(x.id, c.active))?.id ?? null };
  return { role: "integrator", cid: c.integrator ?? null };
}
// The run view's transcript renderer takes a run; a bundle has the parts it reads.
const bundleAsRun = (b) => ({
  id: b.id, state: b.state, cost: b.cost ?? [], messages: b.messages ?? [], interrupted: b.interrupted,
  conversations: { reviewers: b.conversations.reviewers ?? [], qa: b.conversations.qa ?? [], active: b.conversations.active },
  chatTarget: bundleChatTarget(b),
});
const BUNDLE_PIPELINE = [["integrate", "Integrate"], ["review", "Review"], ["deliver", "Deliver"], ["ci", "CI"], ["merge", "Merge"]];
const BUNDLE_STAGE = { INTEGRATING: "integrate", FIXING: "review", REVIEWING: "review", DELIVERING: "deliver", AWAITING_CI: "ci", AWAITING_MERGE: "merge" };
function bundleStage(b) {
  let st = b.state;
  if (st === "ESCALATED") st = b.escalation?.from ?? [...b.history].reverse().find((h) => h.to !== "ESCALATED")?.to ?? "REVIEWING";
  if (st === "FAILED") st = b.failure?.state ?? "INTEGRATING";
  const idx = BUNDLE_PIPELINE.findIndex(([k]) => k === (BUNDLE_STAGE[st] ?? "integrate"));
  return { idx, name: BUNDLE_PIPELINE[idx][1], cls: pending(b) ? "wait" : b.state === "ESCALATED" || b.state === "FAILED" ? "bad" : "" };
}
const BUNDLE_LIVE = { INTEGRATING: "Combining the tickets on the latest default branch", DELIVERING: "Pushing and opening the PR", AWAITING_CI: "Waiting for CI checks" };
const ciText = (b) => (b.noCi ? "no CI" : !b.ci ? "CI not run yet" : { green: "CI green", red: "CI red", pending: "CI running", none: "no CI checks" }[b.ci.state] ?? `CI ${b.ci.state}`);
// "Not reviewed: clean merge" only for a clean one-ticket integration (or one from before the rule that a clean merge of
// 2+ tickets is reviewed); before its first review, any other bundle shows that the review is still to come.
function qaText(b) {
  if (b.reviews?.length) return b.qaStatus ? QA_LABEL[b.qaStatus] ?? `QA ${b.qaStatus}` : "QA not run";
  const it = b.integration;
  const integrated = it && !it.conflict && b.state !== "INTEGRATING";
  if (integrated && !it.changed && (b.members.length < 2 || !it.reviewCombination)) return "Not reviewed: clean merge";
  return b.members.length >= 2 ? "Not reviewed yet: the combination is reviewed before the PR" : "Not reviewed yet";
}
const prText = (d) => (d?.kind === "pr" ? `PR #${d.pr?.number ?? ""}` : d ? "Pushed to main" : "No PR yet");

// ===================================================================== open, resync
async function openBundle(id, fromEl) {
  if (ui.open) {
    if (ui.open === id && ui.mode === "bundle") return;
    await closeRun();
    if (ui.open) return;
  }
  let b;
  try { b = await core.getBundle(id); }
  catch (e) {
    toast(openErrorText(e), "error");
    if (/^#bundle=/.test(location.hash)) try { history.replaceState(null, "", location.pathname); } catch {}
    return;
  }
  if (ui.open) return;
  ui.bundles.set(id, b);
  Object.assign(ui, { open: id, mode: "bundle", stick: true, txConv: null, rejecting: false, structured: false, bComposerKey: null, lastActive: b.conversations.active, bdock: { key: null, ask: null, mode: null, min: false } });
  try { history.replaceState(null, "", `#bundle=${encodeURIComponent(id)}`); } catch {}
  const rv = $("#runview"), bd = $("#rv-backdrop");
  rv.dataset.mode = "bundle"; sheetLabels(false);
  $("#rv-close").setAttribute("aria-label", "Close bundle");
  $("#rv-details-btn").setAttribute("aria-label", "Bundle details"); $("#rv-details-btn").title = "Bundle details"; $("#rv-details").setAttribute("aria-label", "Bundle details");
  $("#dock").hidden = true; $("#dock").innerHTML = ""; setDockPad();
  $("#composer").innerHTML = ""; $("#rv-details-inner").innerHTML = ""; $("#rv-links").innerHTML = ""; $("#rv-extra").innerHTML = ""; delete $("#rv-extra").dataset.key;
  ui.tx.clear();
  ui.thread = b.conversations.active ?? b.conversations.integrator ?? "timeline";
  setDetails(preferDetails()); showJump(false);
  $("#tx").replaceChildren();
  bd.hidden = false; rv.hidden = false;
  renderBundleView();
  requestAnimationFrame(() => bd.classList.add("on"));
  if (!reduceMotion()) {
    rv.animate([{ clipPath: insetOf(fromEl) ?? "inset(3% 3% 3% 3% round 18px)" }, { clipPath: "inset(0px 0px 0px 0px round 0px)" }], { duration: 520, easing: "cubic-bezier(.2, .85, .25, 1)" });
    rv.querySelectorAll(".rv-top, .rv-body").forEach((el) => el.animate([{ opacity: 0 }, { opacity: 0, offset: 0.3 }, { opacity: 1 }], { duration: 520, easing: "ease-out" }));
  }
  await loadBundleThread(true);
  if (ui.open === id && ui.mode === "bundle") ($("#bc-chat") ?? $("#rv-close")).focus({ preventScroll: true });
}
function resyncBundle() {
  if (!openBundleData()) return closeRun();
  renderBundleView(); loadBundleThread(false);
}
async function openRunFromBundle(runId) {
  if (!ui.runs.has(runId)) {
    try { ui.runs.set(runId, await core.getRun(runId)); } catch (e) { toast(openErrorText(e), "error"); return; }
  }
  await closeRun();
  openRun(runId, cardEl(runId));
}

// ===================================================================== header, progress, rail
function renderBundleView() {
  const b = openBundleData(); if (!b) return;
  $("#rv-key").textContent = b.id;
  $("#rv-title").textContent = bundleTitle(b); $("#rv-title").title = bundleTitle(b);
  $("#rv-state").innerHTML = bundleStateLabel(b);
  $("#rv-cost").textContent = money(ownerUsd(b));
  const { idx, name, cls } = bundleStage(b), merged = b.state === "MERGED";
  const label = merged ? "Merged" : b.state === "FAILED" ? `Failed in ${name}` : b.state === "CANCELLED" ? "Cancelled" : `${name}${b.round > 1 ? ` · round ${b.round}` : ""}`;
  $("#rv-progress").innerHTML = `<div class="rv-track">${BUNDLE_PIPELINE.map(([, n], i) => `<span class="rv-seg${merged || i < idx ? " done" : i === idx && b.state !== "CANCELLED" ? ` now ${cls}` : ""}" title="${n}"></span>`).join("")}</div><span class="rv-stage">${esc(label)}</span>`;
  renderBundleLinks(b);
  // Follow the active conversation when it changes, unless you picked another thread.
  const active = b.conversations.active;
  if (active != null && !same(active, ui.lastActive) && (ui.lastActive == null || same(ui.thread, ui.lastActive))) { ui.thread = active; loadBundleThread(true); }
  if (active != null) ui.lastActive = active;
  renderBundleThreads(b); renderBundleComposer(b); renderBundleDock(b); renderBundleDetails(b);
  if (ui.thread === "timeline") renderBundleTimeline(b, false);
  else { const t = ui.tx.get(String(ui.thread)); if (t) renderBundleTranscript(b, t, false); }
}
// Header: the member tickets (each opens its run) and the PR link; Cancel bundle while it holds its members.
function renderBundleLinks(b) {
  const d = b.delivery;
  $("#rv-links").innerHTML = b.members.map((m) => `<button type="button" class="linkish mono" data-bundle-run="${esc(m.run)}" title="${esc(m.title)}">${esc(memberKey(m))}</button>`).join("")
    + (d?.url ? `<a href="${esc(d.url)}" target="_blank" rel="noopener noreferrer">${esc(prText(d))}</a>` : "");
  const cancellable = !BUNDLE_RELEASED.includes(b.state), extra = $("#rv-extra"), key = `bundle:${b.id}:${cancellable}`;
  if (extra.dataset.key === key) return;
  extra.dataset.key = key;
  extra.innerHTML = cancellable ? `<button type="button" class="btn small danger" id="rv-cancel-bundle" title="Close its PR and send its tickets back to Ready">Cancel bundle</button>` : "";
  $("#rv-cancel-bundle")?.addEventListener("click", () => cancelBundleFlow(b.id));
}
async function cancelBundleFlow(id) {
  if (!(await confirmBox(`Cancel ${id}?`, "Its PR is closed if one is open, and its tickets go back to Ready with their branches untouched.", "Cancel bundle"))) return;
  if (await act(() => core.cancelBundle(id, "cancelled from the web UI"), `${id} cancelled. Its tickets are back in Ready.`)) {
    refreshBundle(id);
    (ui.bundles.get(id)?.members ?? []).forEach((m) => refreshRun(m.run));
  }
}
function renderBundleThreads(b) {
  if (!b) return;
  const c = b.conversations, rows = [], focused = document.activeElement?.closest?.(".thread")?.dataset.thread;
  const row = (id, role, name, nested) => {
    const [sub, cls] = id === "timeline" ? [`${plural(b.history.length, "transition")} · ${plural(b.notices.length, "notice")}`, ""] : convLive(id) ? ["Working", "live"] : [modelOf(b, id, role) || "Idle", ""];
    rows.push(`<button type="button" class="thread${nested ? " nested" : ""}" data-thread="${esc(id)}" aria-current="${String(ui.thread) === String(id)}">
      ${role ? avatar(role, false) : `<span class="avatar core">F</span>`}<span style="min-width:0"><span class="t-name">${esc(name)}</span><span class="t-sub ${cls}">${esc(sub)}</span></span>${cls === "live" ? `<span class="live-dot" title="Working"></span>` : ""}</button>`);
  };
  rows.push(`<div class="rail-label">Bundle</div>`);
  row("timeline", null, "Timeline");
  rows.push(`<div class="rail-label">Conversations</div>`);
  if (c.integrator != null) row(c.integrator, "integrator", "Integrator");
  const qaBySeq = new Map((c.qa ?? []).map((x) => [x.seq, x.id]));
  (c.reviewers ?? []).forEach((x) => { row(x.id, "reviewer", `Reviewer · review ${x.seq}`); if (qaBySeq.has(x.seq)) row(qaBySeq.get(x.seq), "qa", `QA · review ${x.seq}`, true); });
  if (c.integrator == null && !(c.reviewers ?? []).length) rows.push(`<p class="hint" style="padding:4px 10px;margin:0">Conversations appear when the integrator or a reviewer starts. A clean one-ticket merge needs neither; a bundle of two or more tickets always gets a reviewer.</p>`);
  const a = ago(b.createdAt);
  rows.push(`<div class="rail-foot"><span><b>${esc(b.project)}</b> · ${esc(b.repo)}</span><span>Shipped ${a === "now" ? "just now" : `${a} ago`} · ${plural(b.members.length, "ticket")}</span></div>`);
  $("#rv-threads").innerHTML = rows.join("");
  if (focused) [...$("#rv-threads").querySelectorAll(".thread")].find((el) => el.dataset.thread === focused)?.focus({ preventScroll: true });
}

// ===================================================================== transcript and timeline
async function loadBundleThread(first) {
  const b = openBundleData(); if (!b) return;
  if (ui.thread === "timeline") return renderBundleTimeline(b, first);
  const id = ui.thread;
  let t;
  try { t = await core.getBundleConversation(b.id, id); }
  catch (e) { toast(String(e.message ?? e), "error"); return; }
  if (ui.mode !== "bundle" || ui.open !== b.id || String(ui.thread) !== String(id)) return;
  ui.tx.set(String(id), t);
  renderBundleTranscript(openBundleData(), t, first);
  renderBundleThreads(openBundleData());
}
function renderBundleTranscript(b, t, first) {
  const role = t.role ?? bundleRoleOf(b, t.conversationId) ?? "integrator", model = modelOf(b, t.conversationId, role);
  const [st, cls] = t.busy ? [`<span class="spin"></span> Working`, "live"] : [same(b.conversations.active, t.conversationId) && !BUNDLE_TERMINAL.includes(b.state) ? "Idle" : "Finished", ""];
  $("#conv-head").innerHTML = `${avatar(role, t.busy)}<span class="who">${roleName(role)}</span>${model ? `<span class="chip-model">${esc(model)}</span>` : ""}<span class="conv-status ${cls}">${st}</span>`;
  const tx = $("#tx");
  if (first || ui.txConv !== String(t.conversationId)) { tx.replaceChildren(); ui.txConv = String(t.conversationId); first = true; }
  settleScroll(first, patch(tx, blocksFor(bundleAsRun(b), { ...t, role }), !first));
}
function renderBundleTimeline(b, first) {
  $("#conv-head").innerHTML = `<span class="avatar core">F</span><span class="who">Timeline</span><span class="chip-model">${esc(b.id)}</span><span class="conv-status">${plural(b.history.length, "transition")}</span>`;
  const ev = [
    ...b.history.map((h, i) => ({ k: `h${i}`, at: h.at, dot: h.to === "FAILED" || h.to === "ESCALATED" ? "bad" : h.to === "MERGED" ? "ok" : "", html: `<span class="st">${esc(h.from ?? "start")} → ${esc(h.to)}</span> <span class="meta">round ${h.round}</span>` })),
    ...b.notices.map((n, i) => ({ k: `n${i}`, at: n.at, dot: n.level === "error" ? "bad" : "notice", html: `${linkify(esc(n.text))}${n.advisory?.length ? ` <span class="meta">· ${plural(n.advisory.length, "advisory note")}</span>` : ""}` })),
    ...(b.messages ?? []).map((m) => ({ k: `m:${m.id}`, at: m.at, dot: "", html: `<b>${viaText(m.by)} → ${esc(m.to)}:</b> ${esc(m.text.length > 200 ? `${m.text.slice(0, 200)}…` : m.text)}` })),
  ].sort((a, b2) => a.at - b2.at);
  const pa = pending(b);
  if (pa) ev.push({ k: `ask:${pa.id}`, at: pa.createdAt, dot: "ask", html: `<b>Waiting for you.</b> ${esc(pa.question.kind === "merge" ? "Merge, request changes or drop tickets" : pa.question.reason)}` });
  const tx = $("#tx");
  if (first || ui.txConv !== "timeline") { tx.replaceChildren(); ui.txConv = "timeline"; first = true; }
  settleScroll(first, patch(tx, ev.map((x) => ({ k: x.k, cls: "tlb", html: `<div class="tl"><span class="tl-time">${stamp(x.at)}</span><span class="tl-dot ${x.dot}"></span><div>${x.html}</div></div>` })), !first));
}
// bundle.conversation.updated for the open bundle: refetch (throttled) the transcripts on screen.
const bundleConvTimers = new Map();
function bundleConvUpdated(e) {
  const b = openBundleData(); if (!b) return;
  const k = String(e.conversationId);
  if (same(k, ui.thread) || same(k, b.conversations.active) || same(k, bundleChatTarget(b).cid)) refreshBundleConv(b.id, e.conversationId);
  else ui.tx.delete(k);
}
function refreshBundleConv(id, cid) {
  const k = String(cid);
  if (bundleConvTimers.has(k)) { bundleConvTimers.get(k).again = true; return; }
  const entry = { again: false };
  bundleConvTimers.set(k, entry);
  const mine = () => ui.mode === "bundle" && ui.open === id;
  setTimeout(async function tick() {
    try {
      const t = await core.getBundleConversation(id, cid);
      if (mine()) {
        const b = openBundleData();
        ui.tx.set(k, t);
        if (String(ui.thread) === k) renderBundleTranscript(b, t, false);
        renderBundleThreads(b); updateBundleComposerLive(b);
      }
    } catch {}
    if (entry.again && mine()) { entry.again = false; setTimeout(tick, 350); return; }
    bundleConvTimers.delete(k);
  }, 120);
}

// ===================================================================== chat box: messages go to the agent the bundle is with
function updateBundleComposerLive(b) {
  const line = $("#bc-live"); if (!line || !b) return;
  const cid = b.conversations.active, role = bundleRoleOf(b, cid), busy = role && convLive(cid);
  const running = busy ? runningToolHtml(role, cid != null ? ui.tx.get(String(cid)) : null) : null;
  line.innerHTML = b.interrupted ? `<span style="color:var(--turn)">${esc(roleName(b.interrupted.role))} is paused</span>`
    : running ? running
    : busy ? `<span class="shimmer">${roleName(role)} is working</span>`
    : BUNDLE_LIVE[b.state] ? `<span class="shimmer">${BUNDLE_LIVE[b.state]}</span>`
    : pending(b) ? `<span style="color:var(--turn)">Waiting for your decision on the card above</span>`
    : b.mergeRequested ? "Merging by itself when the update is clean and green" : `${roleName(role ?? "integrator")} is between steps`;
  const tg = bundleChatTarget(b), hint = $("#bc-hint");
  if (hint) hint.textContent = b.interrupted ? `Your message resumes the ${b.interrupted.role} right away` : tg.cid == null ? `Delivered when the ${tg.role} starts` : convLive(tg.cid) ? `Delivered when the ${tg.role} finishes its current step` : `The ${tg.role} replies right away`;
  const int = $("#bc-int");
  if (int) int.hidden = !canInterrupt(b, tg, BUNDLE_TERMINAL.includes(b.state));
  ensureClocks();
}
function renderBundleComposer(b) {
  const tg = bundleChatTarget(b);
  const key = BUNDLE_TERMINAL.includes(b.state) ? `end:${b.state}` : `chat:${tg.role}:${b.interrupted ? `paused:${b.interrupted.role}` : ""}`;
  if (key === ui.bComposerKey) return updateBundleComposerLive(b);
  const draft = $("#bc-chat")?.value ?? "";
  ui.bComposerKey = key;
  const el = $("#composer"), d = b.delivery;
  if (b.state === "MERGED") {
    el.innerHTML = `<div class="cbox ok"><div class="c-status"><span class="c-ico ok">${ICON.check}</span><div class="c-main"><span class="c-line">Merged</span><span class="c-sub">${esc(prText(d))} · ${plural(b.members.length, "ticket")} delivered · start a new ticket for follow-up work</span></div>${d?.url ? `<a class="btn lg" href="${esc(d.url)}" target="_blank" rel="noopener noreferrer">${d.kind === "pr" ? "Open PR" : "Open repo"} ${ICON.ext}</a>` : ""}</div></div>`;
    return;
  }
  if (b.state === "CANCELLED") {
    el.innerHTML = `<div class="cbox"><div class="c-status"><span class="c-ico muted">${ICON.stop}</span><div class="c-main"><span class="c-line">Cancelled</span><span class="c-sub">Its tickets went back to Ready and can ship again.</span></div></div></div>`;
    return;
  }
  if (b.state === "FAILED") {
    el.innerHTML = `<div class="cbox bad"><div class="c-status"><span class="c-ico bad">${ICON.warn}</span><div class="c-main"><span class="c-line">Failed in ${esc(b.failure?.state ?? "a stage")}</span><span class="c-sub">${esc(b.failure?.reason ?? "")}</span></div><button type="button" class="btn primary lg" id="bc-retry">${ICON.retry} Retry</button></div></div>`;
    $("#bc-retry").addEventListener("click", (e) => retryBundleFlow(b.id, e.currentTarget));
    return;
  }
  el.innerHTML = `<div class="cbox${b.interrupted ? " paused" : ""}">
    <div class="c-top"><span class="to-chip">To ${avatar(tg.role, false)}<b>${esc(roleName(tg.role))}</b></span><span class="c-live-line" id="bc-live"></span></div>
    ${b.interrupted ? pausedHtml(b.interrupted.role, "bc-continue") : ""}
    <form class="c-input" id="bc-form"><textarea id="bc-chat" rows="1" placeholder="Message the ${tg.role}…" aria-label="Message the ${tg.role}"></textarea>${interruptBtnHtml("bc-int", tg.role)}<button type="submit" class="send" id="bc-send" disabled aria-label="Send message">${ICON.send}</button></form>
    <div class="c-foot"><span id="bc-hint"></span><span><kbd>Enter</kbd> to send · <kbd>Shift</kbd> + <kbd>Enter</kbd> for a new line</span></div></div>`;
  const ta = $("#bc-chat"), send = $("#bc-send");
  ta.value = draft; autosize(ta, send);
  ta.addEventListener("input", () => autosize(ta, send));
  ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); $("#bc-form").requestSubmit(); } });
  $("#bc-int").addEventListener("click", async (e) => {
    const btn = e.currentTarget; btn.disabled = true;
    if (await act(() => core.interruptBundleAgent(b.id), `Interrupting the ${tg.role}`)) refreshBundle(b.id);
    btn.disabled = false;
  });
  $("#bc-continue")?.addEventListener("click", (e) => sendBundleChat("Continue.", e.currentTarget));
  $("#bc-form").addEventListener("submit", (e) => { e.preventDefault(); sendBundleChat(ta.value.trim()); });
  // Your text (or Continue's "Continue.") through the ordinary messageBundle op; a refused one stays in the box.
  async function sendBundleChat(text, btn) {
    if (!text || send.dataset.busy) return;
    send.dataset.busy = "1"; send.disabled = true; if (btn) btn.disabled = true;
    let out;
    const ok = await act(async () => { out = await core.messageBundle(b.id, text); });
    delete send.dataset.busy; if (btn) btn.disabled = false;
    if (!ok) { autosize(ta, send); return; }
    if (!btn) ta.value = "";
    autosize(ta, send);
    ui.stick = true;
    if (out?.conversationId == null) toast(`Queued for the ${out?.to ?? tg.role}. It's delivered when the ${out?.to ?? tg.role} starts.`);
    else if (String(ui.thread) !== String(out.conversationId)) { ui.thread = out.conversationId; renderBundleThreads(openBundleData()); loadBundleThread(true); }
    refreshBundle(b.id);
    if (out?.conversationId != null) refreshBundleConv(b.id, out.conversationId);
  }
  updateBundleComposerLive(b);
}
async function retryBundleFlow(id, btn) {
  if (btn) btn.disabled = true;
  const ok = await act(() => core.retryBundle(id), "Retrying");
  if (btn && !ok) btn.disabled = false;
  refreshBundle(id);
}

// ===================================================================== floating card: Merge, escalation, failed, merge requested
const findingHtml = (b, x) => `<div class="c-item"><span class="sev${x.blocking ? " block" : ""}">${esc(x.id ?? x.severity)}</span><span>${x.source === "qa" ? "<b>QA</b> · " : x.source === "ci" ? "<b>CI</b> · " : ""}${inline(x.description)}${shotsHtml(b.id, x.screenshots)}</span></div>`;
// The final review round's findings: the latest review/qa entries of the findings log (deduplicated against advisory).
function finalRoundFindings(b) {
  const entries = (b.findingsLog ?? []).filter((e) => e.kind === "review" || e.kind === "qa");
  if (!entries.length) return [];
  const last = Math.max(...entries.map((e) => e.reviewSeq ?? e.round));
  const seen = new Set((b.advisory ?? []).map((x) => x.id).filter(Boolean));
  return entries.filter((e) => (e.reviewSeq ?? e.round) === last).flatMap((e) => e.findings).filter((x) => !x.id || !seen.has(x.id));
}
function memberChecklist(b, name) {
  return `<div class="b-drop" role="group" aria-label="Tickets to drop">${b.members.map((m) => `<label class="b-drop-row"><input type="checkbox" name="${name}" value="${esc(m.run)}"><span class="key">${esc(memberKey(m))}</span><span>${esc(m.title)}</span></label>`).join("")}</div>
    <p class="hint b-drop-hint">At least one ticket must remain (cancel the bundle to drop them all). Dropped tickets go back to Ready, and the rest is integrated again from the latest default branch.</p>`;
}
const checkedRuns = (root, name) => [...root.querySelectorAll(`input[name="${name}"]:checked`)].map((x) => x.value);
function renderBundleDock(b) {
  const dock = $("#dock");
  if (!b) return;
  const pa = pending(b), st = ui.bdock;
  const kind = pa ? pa.question.kind : b.state === "FAILED" ? "failed" : b.mergeRequested && !BUNDLE_TERMINAL.includes(b.state) ? "requested" : null;
  if (!kind) { if (!dock.hidden) { dock.hidden = true; dock.innerHTML = ""; st.key = null; setDockPad(); } return; }
  const askKey = pa?.id ?? kind;
  if (st.ask !== askKey) { st.ask = askKey; st.mode = null; st.min = false; }
  // Rendered again only when what it shows changes, so typing and ticks survive the bundle's other updates.
  const key = `${askKey}:${st.mode}:${st.min}:${b.state}:${b.ci?.state ?? ""}:${!!b.mergeRequested}`;
  if (key === st.key) return;
  const fresh = !st.key || !st.key.startsWith(`${askKey}:`);
  st.key = key; dock.hidden = false;
  const info = kind === "merge" ? { cls: "turn", icon: ICON.doc, title: "Ready to merge", meta: `${prText(b.delivery)} · ${ciText(b)} · ${b.mergeMethod}` }
    : kind === "escalation" ? { cls: "bad", icon: ICON.warn, title: "Escalated to you", meta: b.escalation?.cap === "review" ? "review round cap reached" : b.escalation?.cap === "ciFix" ? "CI fix cap reached" : "needs a decision" }
    : kind === "failed" ? { cls: "bad", icon: ICON.warn, title: `Failed in ${b.failure?.state ?? "a stage"}`, meta: "Retry resumes from the failed state" }
    : { cls: "", icon: ICON.wait, title: "Merge requested", meta: "it merges by itself when the update is clean and green" };
  if (st.min) {
    dock.innerHTML = `<div class="dock-card mini ${info.cls}"><span class="d-ico">${info.icon}</span><span class="d-mini-text"><b>${esc(info.title)}</b><span> · ${esc(info.meta)}</span></span><button type="button" class="btn small" id="bk-expand">Open</button></div>`;
    $("#bk-expand").addEventListener("click", () => { ui.bdock.min = false; renderBundleDock(openBundleData()); });
  } else if (kind === "merge") dockMerge(dock, b, pa, info);
  else if (kind === "escalation") dockBundleEscalation(dock, b, pa, info);
  else if (kind === "failed") {
    dock.innerHTML = `<div class="dock-card ${info.cls}">${dockHead(info)}<div class="c-q" style="font-size:14px">${esc(b.failure?.reason ?? "")}</div>
      <div class="c-actions"><button type="button" class="btn primary" id="bk-retry">${ICON.retry} Retry</button><span class="grow"></span><span class="hint">The tickets stay in the bundle until you retry or cancel it.</span></div></div>`;
    $("#bk-retry").addEventListener("click", (e) => retryBundleFlow(b.id, e.currentTarget));
  } else {
    dock.innerHTML = `<div class="dock-card">${dockHead(info)}<div class="c-q" style="font-size:13.5px">You clicked Merge. The default branch had moved, so the bundle is being updated onto it and checked again. It merges by itself when the update is clean and CI is green; if the integrator has to change anything, it is reviewed and asks you again.</div><div class="c-actions"><span class="meta">${esc(BUNDLE_STATE[b.state]?.[0] ?? b.state)} · ${esc(ciText(b))}</span></div></div>`;
  }
  $("#dk-min")?.addEventListener("click", () => { ui.bdock.min = true; renderBundleDock(openBundleData()); });
  if (fresh && !reduceMotion()) dock.firstElementChild.animate([{ opacity: 0, transform: "translateY(-12px) scale(.98)" }, { opacity: 1, transform: "none" }], { duration: 360, easing: "cubic-bezier(.2, .8, .2, 1)" });
  setDockPad();
}
function dockMerge(dock, b, pa, info) {
  const st = ui.bdock, d = b.delivery, adv = (b.advisory ?? []).filter((x) => !x.blocking), fin = finalRoundFindings(b);
  const checks = (b.ci?.checks ?? []).map((c) => `<span class="rchip" title="${esc(c.state)}">${esc(c.name)} · ${esc(c.state)}</span>`).join(" ");
  const facts = `<div class="loc b-facts"><span><b>CI</b> · ${esc(ciText(b))}${b.noCi ? ` <span class="meta">(the repo has no CI checks)</span>` : ""}</span>${checks ? `<span>${checks}</span>` : ""}<span><b>QA</b> · ${esc(qaText(b))}</span>${b.reviews?.length ? `<span class="meta">${plural(b.reviews.length, "bundle review")} · round ${b.reviewRound}/${b.caps.review}</span>` : ""}</div>`;
  const findings = (adv.length ? `<div class="b-sub">Advisory notes</div><div class="c-list">${adv.map((x) => findingHtml(b, x)).join("")}</div>` : "")
    + (fin.length ? `<div class="b-sub">Final review round</div><div class="c-list">${fin.map((x) => findingHtml(b, x)).join("")}</div>` : "");
  const requested = b.mergeRequested ? `<div class="notice b-note">Merge was clicked: it merges by itself when the update is green and needed no fix.</div>` : "";
  const link = d?.url ? `<a class="btn ghost" href="${esc(d.url)}" target="_blank" rel="noopener noreferrer">${d.kind === "pr" ? "Open PR" : "Open repo"} ${ICON.ext}</a>` : "";
  const one = b.members.length < 2;
  let body;
  if (st.mode === "changes") {
    body = `<div class="reject"><label for="bk-feedback">What should the integrator change?</label><textarea id="bk-feedback" placeholder="e.g. Keep both tickets' flags in the help text"></textarea></div>
      <div class="c-actions"><button type="button" class="btn dangerfill" id="bk-send-changes">Send to the integrator</button><button type="button" class="btn ghost" data-bk-back>Cancel</button><span class="grow"></span><span class="hint">One blocking finding for the integrator, then a review; no review or CI round added.</span></div>`;
  } else if (st.mode === "drop") {
    body = `<div class="reject">${memberChecklist(b, "bk-drop")}</div>
      <div class="c-actions"><button type="button" class="btn dangerfill" id="bk-send-drop" disabled>Drop tickets</button><button type="button" class="btn ghost" data-bk-back>Cancel</button></div>`;
  } else {
    body = facts + requested + findings + `<div class="c-actions"><button type="button" class="btn primary" id="bk-merge">${ICON.check} Merge</button><button type="button" class="btn" id="bk-changes">Request changes</button><button type="button" class="btn" id="bk-drop"${one ? ` disabled title="A bundle keeps at least one ticket; cancel the bundle instead"` : ""}>Drop tickets…</button><span class="grow"></span>${link}</div>`;
  }
  dock.innerHTML = `<div class="dock-card ${info.cls}">${dockHead(info)}${body}</div>`;
  $("#bk-merge")?.addEventListener("click", async (e) => {
    const btn = e.currentTarget; btn.disabled = true;
    if (await act(() => core.mergeBundle(b.id), "Merging. If the default branch moved, it updates first and merges when green.")) refreshBundle(b.id); else btn.disabled = false;
  });
  $("#bk-changes")?.addEventListener("click", () => { ui.bdock.mode = "changes"; renderBundleDock(openBundleData()); $("#bk-feedback")?.focus(); });
  $("#bk-drop")?.addEventListener("click", () => { ui.bdock.mode = "drop"; renderBundleDock(openBundleData()); });
  dock.querySelectorAll("[data-bk-back]").forEach((x) => x.addEventListener("click", () => { ui.bdock.mode = null; renderBundleDock(openBundleData()); }));
  $("#bk-send-changes")?.addEventListener("click", async (e) => {
    const text = $("#bk-feedback").value.trim();
    if (!text) { toast("Write what should change first.", "error"); $("#bk-feedback").focus(); return; }
    const btn = e.currentTarget; btn.disabled = true;
    if (await act(() => core.requestBundleChanges(b.id, text), "Sent to the integrator")) { ui.bdock.mode = null; refreshBundle(b.id); } else btn.disabled = false;
  });
  wireDropList(dock, b, "bk-drop", $("#bk-send-drop"), (runs) => core.dropFromBundle(b.id, runs));
}
// The member checklist's confirm button: enabled for 1..n-1 ticked tickets; `send(runs)` does the core call.
function wireDropList(root, b, name, btn, send) {
  if (!btn) return;
  const sync = () => {
    const n = checkedRuns(root, name).length;
    btn.disabled = n === 0 || n >= b.members.length;
    btn.textContent = n >= b.members.length ? "At least one must remain" : n ? `Drop ${plural(n, "ticket")}` : "Drop tickets";
  };
  root.querySelectorAll(`input[name="${name}"]`).forEach((x) => x.addEventListener("change", sync));
  sync();
  btn.addEventListener("click", async () => {
    const runs = checkedRuns(root, name);
    if (!runs.length || runs.length >= b.members.length) return;
    btn.disabled = true;
    if (await act(() => send(runs), `Dropped ${runs.map((id) => keyOf(id)).join(", ")}. They are back in Ready.`)) {
      ui.bdock.mode = null; refreshBundle(b.id); runs.forEach(refreshRun);
    } else sync();
  });
}
function dockBundleEscalation(dock, b, pa, info) {
  const fs = b.escalation?.findings ?? [], one = b.members.length < 2;
  const n0 = Math.min(10, Math.max(1, Number(ui.escN) || 2));
  dock.innerHTML = `<div class="dock-card ${info.cls}">${dockHead(info)}
    <div class="c-q" style="font-size:14.5px">${esc(b.escalation?.reason ?? pa.question.reason)}</div>
    <div class="meta" style="padding:4px 14px 0">${esc(ciText(b))} · ${esc(qaText(b))}</div>
    ${fs.length ? `<div class="c-list">${fs.map((x) => findingHtml(b, x)).join("")}</div>` : ""}
    <div class="tiles" role="radiogroup" aria-label="Decision">
      <div class="tile" role="radio" tabindex="0" data-choice="more" aria-checked="false"><b>More rounds</b><span>The integrator carries on with the findings and your messages.</span>
        <div class="stepper"><button type="button" data-step="-1" aria-label="Fewer rounds">−</button><input id="besc-n" type="number" min="1" max="10" value="${n0}" aria-label="Extra rounds"><button type="button" data-step="1" aria-label="More rounds">+</button></div></div>
      <div class="tile${one ? " off" : ""}" role="radio" tabindex="0" data-choice="drop" aria-checked="false"${one ? ` aria-disabled="true" title="A bundle keeps at least one ticket; abort instead"` : ""}><b>Drop tickets…</b><span>Send some tickets back to Ready and integrate the rest again.</span></div>
      <div class="tile danger" role="radio" tabindex="0" data-choice="abort" aria-checked="false"><b>Abort</b><span>Cancel the bundle. Its tickets go back to Ready.</span></div>
    </div>
    <div class="reject" id="besc-drop" hidden>${memberChecklist(b, "besc-drop")}</div>
    <div class="c-actions"><span class="hint">Message the integrator below if you want to discuss first.</span><span class="grow"></span><button type="button" class="btn primary" id="besc-go" disabled>Continue</button></div></div>`;
  let choice = null;
  const go = $("#besc-go"), n = $("#besc-n"), drop = $("#besc-drop");
  const clamp = () => { const v = Math.round(Number(n.value)); n.value = String(Math.min(10, Math.max(1, Number.isFinite(v) ? v : 1))); };
  const label = () => {
    const picked = checkedRuns(dock, "besc-drop").length;
    go.className = `btn ${choice === "abort" || choice === "drop" ? "dangerfill" : "primary"}`;
    go.disabled = !choice || (choice === "drop" && (picked === 0 || picked >= b.members.length));
    go.textContent = choice === "more" ? `Grant ${plural(Number(n.value), "more round")}` : choice === "drop" ? (picked >= b.members.length ? "At least one must remain" : picked ? `Drop ${plural(picked, "ticket")}` : "Pick tickets to drop") : choice === "abort" ? "Abort bundle" : "Continue";
  };
  const pick = (c) => {
    if (c === "drop" && one) return;
    choice = c; drop.hidden = c !== "drop";
    dock.querySelectorAll(".tile").forEach((t) => t.setAttribute("aria-checked", String(t.dataset.choice === c)));
    label();
  };
  dock.querySelectorAll(".tile").forEach((t) => {
    t.addEventListener("click", (e) => { if (!e.target.closest(".stepper")) pick(t.dataset.choice); });
    t.addEventListener("keydown", (e) => { if ((e.key === "Enter" || e.key === " ") && e.target === t) { e.preventDefault(); pick(t.dataset.choice); } });
  });
  dock.querySelectorAll("[data-step]").forEach((x) => x.addEventListener("click", () => { n.value = Number(n.value) + Number(x.dataset.step); clamp(); ui.escN = Number(n.value); pick("more"); }));
  n.addEventListener("input", () => { ui.escN = Number(n.value); pick("more"); });
  n.addEventListener("change", () => { clamp(); ui.escN = Number(n.value); label(); });
  dock.querySelectorAll('input[name="besc-drop"]').forEach((x) => x.addEventListener("change", label));
  go.addEventListener("click", async () => {
    clamp();
    const runs = checkedRuns(dock, "besc-drop");
    const c = choice === "more" ? { moreRounds: Number(n.value) } : choice === "drop" ? { drop: runs } : { abort: true };
    if (choice === "abort" && !(await confirmBox(`Abort ${b.id}?`, "The bundle is cancelled: its PR is closed if one is open, and its tickets go back to Ready.", "Abort bundle"))) return;
    go.disabled = true;
    const ok = await act(() => core.resolveBundleEscalation(b.id, pa.id, c), choice === "more" ? `Granted ${plural(Number(n.value), "more round")}` : choice === "drop" ? `Dropped ${runs.map((id) => keyOf(id)).join(", ")}. They are back in Ready.` : "Bundle aborted. Its tickets are back in Ready.");
    if (ok) { refreshBundle(b.id); if (choice === "drop") runs.forEach(refreshRun); else if (choice === "abort") b.members.forEach((m) => refreshRun(m.run)); } else label();
  });
}

// ===================================================================== details panel
function renderBundleDetails(b) {
  const { name } = bundleStage(b), d = b.delivery, merged = b.state === "MERGED";
  const memberRows = b.members.map((m) => {
    const r = ui.runs.get(m.run);
    return `<div class="b-member"><div class="card-row"><button type="button" class="linkish mono" data-bundle-run="${esc(m.run)}">${esc(memberKey(m))}</button>${r ? stateLabel(r) : ""}</div><div>${esc(m.title)}</div><div class="meta mono">${esc(m.specPath ?? "")}${m.branch ? ` · ${esc(m.branch)}` : ""}</div></div>`;
  }).join("");
  const integ = b.integration;
  const resolved = integ?.resolved?.length ? integ.resolved.map((x) => `<div class="meta">${esc(keyOf(x.run))}: <span class="mono">${esc(x.files.join(", "))}</span></div>`).join("") : "";
  const findings = (b.findingsLog ?? []).map((e) => `<div class="round-h">${e.kind === "human" ? `Your feedback · round ${e.round}` : e.kind === "ci" ? `CI failure · round ${e.round}` : e.kind === "qa" ? `QA · review ${e.reviewSeq ?? e.round} · ${e.findings.some((x) => x.blocking) ? "fail" : "pass"}` : `Review ${e.reviewSeq ?? e.round} · ${e.findings.some((x) => x.blocking) ? "fail" : "pass"}`}</div>
    ${e.findings.map((x) => { const resp = e.responses?.find((y) => y.findingId === x.id); return `<div class="finding${x.blocking ? " blocking" : ""}">
      <div class="f-top"><span class="key">${esc(x.id ?? "")}</span><span class="sev${x.blocking ? " block" : ""}">${x.blocking ? "blocking" : "advisory"}</span><span class="sev">${esc(x.severity)}</span>${x.specRef ? `<span class="meta">${esc(x.specRef)}</span>` : ""}</div>
      <div>${inline(x.description)}</div>${x.evidence ? `<details><summary class="meta">Evidence</summary><pre>${esc(x.evidence)}</pre></details>` : ""}${shotsHtml(b.id, x.screenshots)}
      ${resp ? `<div class="f-resp">${resp.status === "fixed" ? "✓ Fixed by the integrator" : `Won't fix · ${esc(resp.reason ?? "")}`}</div>` : ""}</div>`; }).join("")}`).join("");
  const byRole = {};
  (b.cost ?? []).forEach((c) => { const k = `${c.role}:${c.round}`; byRole[k] ??= { role: c.role, round: c.round, usd: 0 }; byRole[k].usd += c.usd || 0; });
  const costRows = Object.values(byRole).map((c) => `<tr><td>${roleName(c.role)}</td><td class="n">${c.round}</td><td class="n">${money(c.usd)}</td></tr>`).join("")
    + liveCostRows(b).map((c) => `<tr class="live-cost"><td>${roleName(c.role)} <span class="meta" title="The turn in progress: not recorded yet">· in progress</span></td><td class="n">${b.round ?? ""}</td><td class="n">${money(c.usd || 0)}</td></tr>`).join("");
  const cancellable = !BUNDLE_RELEASED.includes(b.state);
  $("#rv-details-inner").innerHTML = `
    <div class="kpis"><div class="kpi"><span class="k">Stage</span><span class="v">${merged ? "Merged" : esc(name)}</span></div><div class="kpi"><span class="k">Review</span><span class="v">${b.reviews?.length ? `${b.reviewRound}/${b.caps.review}` : "—"}</span></div><div class="kpi"><span class="k">CI fixes</span><span class="v">${b.ciFixes}/${b.caps.ciFix}</span></div><div class="kpi"><span class="k">Cost</span><span class="v kpi-cost">${money(ownerUsd(b))}</span></div></div>
    <section class="d-sec"><h4>Tickets <span>${b.members.length}</span></h4><div class="b-members">${memberRows}</div>
      ${b.dropped?.length ? `<div class="meta" style="margin-top:6px">Dropped: ${b.dropped.map((id) => esc(keyOf(id))).join(", ")}</div>` : ""}</section>
    <section class="d-sec"><h4>Delivery</h4><div style="display:grid;gap:6px;font-size:13px">
      ${d ? `<div>${esc(prText(d))} · <a href="${esc(d.url)}" target="_blank" rel="noopener noreferrer">${esc(String(d.url).replace(/^https?:\/\//, ""))}</a><div class="meta mono">${esc(String(d.sha ?? "").slice(0, 12))}</div></div>` : `<span class="meta">No PR yet.</span>`}
      <div class="meta">${esc(ciText(b))} · ${esc(qaText(b))} · merge method ${esc(b.mergeMethod)}</div>
      ${b.mergeRequested ? `<div class="notice">Merge was clicked: it merges by itself when the update is green and needed no fix.</div>` : ""}</div></section>
    ${integ ? `<section class="d-sec"><h4>Integration ${integ.n ? `<span>#${esc(integ.n)}</span>` : ""}</h4><div style="display:grid;gap:4px;font-size:13px">
      <div class="meta">Base <span class="mono">${esc(String(integ.base ?? "").slice(0, 12))}</span> · ${integ.changed ? "the integrator changed the combined result" : "merged cleanly"}</div>
      ${integ.conflict ? `<div class="notice warn">${b.state === "INTEGRATING" ? "Resolving a conflict with" : "Unresolved conflict with"} ${esc(keyOf(integ.conflict.run))}: <span class="mono">${esc(integ.conflict.files.join(", "))}</span></div>` : ""}
      ${resolved ? `<div class="meta">Conflicts resolved:</div>${resolved}` : ""}</div></section>` : ""}
    ${findings ? `<section class="d-sec"><h4>Findings <span>${b.findingsLog.reduce((a, e) => a + e.findings.length, 0)}</span></h4>${findings}</section>` : ""}
    ${costRows ? `<section class="d-sec"><h4>Cost by role</h4><div class="scroll-x"><table class="cost"><thead><tr><th>Role</th><th class="n">Round</th><th class="n">USD</th></tr></thead><tbody>${costRows}<tr class="total"><td>Total</td><td></td><td class="n">${money(ownerUsd(b))}</td></tr></tbody></table></div></section>` : ""}
    <section class="d-sec"><h4>Activity</h4><div style="display:grid;gap:6px">${b.notices.slice(-5).reverse().map((n) => `<div class="notice ${esc(n.level)}">${linkify(esc(n.text))}<span class="meta">${stamp(n.at)}</span></div>`).join("") || `<span class="meta">Nothing yet</span>`}</div></section>
    <section class="d-sec"><h4>Bundle</h4><dl class="dl">
      <dt>Project</dt><dd>${esc(b.project)}</dd><dt>Repo</dt><dd>${esc(b.repo)}</dd><dt>Bundle id</dt><dd class="mono">${esc(b.id)}</dd>
      ${b.workspace ? `<dt>Branch</dt><dd class="mono">${esc(b.workspace.branch)}</dd><dt>Workspace</dt><dd class="mono">${esc(b.workspace.path)}</dd>` : ""}
      <dt>Created</dt><dd>${new Date(b.createdAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}</dd></dl></section>
    <section class="d-sec"><h4>Actions</h4><div class="actions" style="display:flex;gap:8px;flex-wrap:wrap">
      ${b.state === "FAILED" ? `<button type="button" class="btn primary" id="bd-retry">${ICON.retry} Retry</button>` : ""}
      ${cancellable ? `<button type="button" class="btn danger" id="bd-cancel">Cancel bundle</button>` : `<span class="meta">${merged ? "Merged bundles are final." : "Cancelled. Its tickets are back in Ready."}</span>`}
    </div></section>`;
  $("#bd-retry")?.addEventListener("click", (e) => retryBundleFlow(b.id, e.currentTarget));
  $("#bd-cancel")?.addEventListener("click", () => cancelBundleFlow(b.id));
}

// ===================================================================== wiring
(function wireBundles() {
  // Member tickets in the bundle view's header and details open their run's view.
  $("#runview").addEventListener("click", (e) => {
    const m = e.target.closest("[data-bundle-run]");
    if (m && ui.mode === "bundle") openRunFromBundle(m.dataset.bundleRun);
  });
})();
