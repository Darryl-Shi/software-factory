"use strict";
// Factory self-update UI (spec §2.5): the version chip in the header, the Update dialog (check, preconditions, active
// work, confirm, apply, progress through the restart) and the banner with the last update's report after a restart.
// It talks to /api/version and /api/update/* (not core ops: the updater is a service next to the core). Loaded after
// app.js, whose helpers ($, esc, toast, openModal, closeModal, CLOSE_SVG, ago, stamp, plural) and markdown.js's inline()
// it uses. Everything lives in this closure so the shared global scope stays as it was.
(() => {
  const ACTIVE = ["pulling", "installing", "restarting"];
  const PHASES = [["pulling", "Pulling the new code"], ["installing", "Installing dependencies"], ["restarting", "Restarting the factory"]];
  const KIND = { run: "Ticket", bundle: "Bundle", discussion: "Chat" };
  const short = (sha) => String(sha ?? "").slice(0, 7);
  const firstLine = (s) => String(s ?? "").split("\n").find((l) => l.trim()) ?? "";
  const when = (t) => { const a = ago(t); return a === "now" ? "just now" : `${a} ago`; };
  const fmtDate = (d) => { const t = Date.parse(d); return Number.isNaN(t) ? String(d ?? "") : new Date(t).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }); };

  const st = {
    v: null, // the last VersionInfo
    bootSha: undefined, // the running full SHA when this page loaded: a different one means the factory restarted on new code
    dlg: null, // the open dialog's scrim, or null
    mode: "view", // view | confirm | updating
    busy: "", // "check" | "apply" while a request is in flight
    note: null, // { kind: "warn"|"error", text } shown at the top of the dialog
    offline: false, // the server went away (restarting)
    watching: 0, // the 2 s poll timer while an update is in progress
    reloading: false, // the factory came back on new code: the page is reloading
  };

  // ------------------------------------------------------------------ API
  async function api(path, body) {
    let res;
    try {
      res = await fetch(path, body === undefined
        ? { credentials: "same-origin", cache: "no-store" }
        : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), credentials: "same-origin" });
    } catch {
      throw Object.assign(new Error("The factory isn't reachable."), { code: "offline" });
    }
    if (res.status === 401) { location.reload(); throw Object.assign(new Error("Your session expired."), { code: "unauthorized" }); }
    let data;
    try { data = await res.json(); } catch { throw Object.assign(new Error(`HTTP ${res.status}`), { code: res.status >= 500 ? "offline" : "http", status: res.status }); }
    if (!res.ok || data?.ok === false) throw Object.assign(new Error(data?.error ?? `HTTP ${res.status}`), { code: data?.code ?? "http", status: res.status });
    return data;
  }

  // Takes a fresh VersionInfo: reloads when the factory restarted on other code, else re-renders chip, banner, dialog.
  function accept(v) {
    if (st.reloading) return;
    st.offline = false;
    if (st.bootSha === undefined) st.bootSha = v.fullSha ?? null;
    else if (v.fullSha && st.bootSha && v.fullSha !== st.bootSha) { st.reloading = true; location.reload(); return; }
    st.v = v;
    const inFlight = ACTIVE.includes(v.update?.phase);
    if (inFlight) watch();
    else if (st.mode === "updating") st.mode = "view";
    renderChip(); renderBanner(); renderDialog();
  }

  async function refresh() {
    try { accept(await api("/api/version")); }
    catch (e) {
      if (e.status === 404) { $("#ver-chip").hidden = true; return; } // no updater wired
      if (e.code === "offline" && st.watching) { st.offline = true; renderChip(); renderDialog(); }
    }
  }

  // Polls every 2 s while an update is in progress (and through the restart), until the phase settles or the page reloads.
  function watch() {
    if (st.watching || st.reloading) return;
    st.watching = setTimeout(async function tick() {
      try { const v = await api("/api/version"); st.watching = 0; accept(v); }
      catch (e) {
        if (e.code === "unauthorized") return;
        st.offline = true; renderChip(); renderDialog();
        st.watching = setTimeout(tick, 2000);
        return;
      }
    }, 2000);
  }

  // ------------------------------------------------------------------ preconditions
  function blockers(v) {
    if (!v.updatable) return [];
    const c = v.check;
    if (!c) return [];
    const out = [];
    if (c.dirty) out.push("local changes in tracked files");
    if (c.ahead > 0) out.push(`local commits not on ${c.upstream || "the upstream"}`);
    return out;
  }
  const canUpdate = (v) => !!(v?.updatable && v.check && v.check.behind > 0 && v.check.upstreamFullSha && !blockers(v).length && !ACTIVE.includes(v.update?.phase));

  // ------------------------------------------------------------------ header chip
  function renderChip() {
    const el = $("#ver-chip"), v = st.v;
    if (!el || !v) return;
    el.hidden = false;
    const label = v.sha ? short(v.sha) : `v${v.version}`;
    el.title = [v.date ? fmtDate(v.date) : "", `v${v.version}`, v.sha ? short(v.sha) : ""].filter(Boolean).join(" · ");
    el.classList.remove("avail", "busy");
    if (ACTIVE.includes(v.update?.phase) || st.offline) { el.classList.add("busy"); el.innerHTML = `<span class="spin" aria-hidden="true"></span>${st.offline ? "Restarting…" : "Updating…"}`; }
    else if (v.updatable && v.check?.behind > 0) { el.classList.add("avail"); el.innerHTML = `<span class="upd-dot" aria-hidden="true"></span>Update available (${esc(v.check.behind)})`; }
    else el.innerHTML = `<span class="mono">${esc(label)}</span>`;
    el.setAttribute("aria-label", `Factory version ${label}${v.check?.behind > 0 ? `, ${plural(v.check.behind, "update")} available` : ""}`);
  }

  // ------------------------------------------------------------------ banner
  function renderBanner() {
    const el = $("#upd-banner"), v = st.v, u = v?.update;
    if (!el) return;
    let kind = "", html = "", detail = "";
    if (u?.phase === "done" && (!u.restartRequired || v.fullSha === u.to)) { kind = "ok"; html = `Updated from <code>${esc(short(u.from))}</code> to <code>${esc(short(u.to))}</code>`; }
    else if (u?.phase === "done" && u.restartRequired) { kind = "warn"; html = `Update pulled <code>${esc(short(u.to))}</code>: ${esc(u.message || "Restart the factory to finish the update")}`; }
    else if (u?.phase === "rolled-back") { kind = "error"; html = `Update to <code>${esc(short(u.to))}</code> failed to start; rolled back to <code>${esc(short(u.from))}</code>${u.error ? `: ${esc(firstLine(u.error))}` : ""}`; detail = u.error ?? ""; }
    else if (u?.phase === "failed") { kind = "error"; html = `Update to <code>${esc(short(u.to))}</code> failed${u.error ? `: ${esc(firstLine(u.error))}` : ""}`; detail = u.error ?? ""; }
    if (!kind) { el.hidden = true; el.innerHTML = ""; return; }
    const more = detail && detail.trim() !== firstLine(detail).trim();
    el.className = `upd-banner ${kind}`;
    el.innerHTML = `<div class="upd-banner-row"><span class="upd-banner-text">${html}</span>${more ? `<button type="button" class="btn ghost small" data-act="details" aria-expanded="false">Details</button>` : ""}<button type="button" class="icon-btn" data-act="dismiss" aria-label="Dismiss" title="Dismiss">${CLOSE_SVG}</button></div>${more ? `<pre class="err" hidden>${esc(detail)}</pre>` : ""}`;
    el.hidden = false;
  }
  async function dismiss() {
    $("#upd-banner").hidden = true;
    try { accept(await api("/api/update/dismiss", {})); } catch (e) { toast(e.message, "error"); renderBanner(); }
  }

  // ------------------------------------------------------------------ dialog
  const activeList = (v) => (v.active?.length
    ? `<ul class="upd-active">${v.active.map((a) => `<li><span class="upd-kind">${esc(KIND[a.kind] ?? a.kind)}</span><span class="upd-atitle">${esc(a.title || a.id)}</span><span class="meta">${esc(a.project)} · ${esc(a.state)}</span></li>`).join("")}</ul>`
    : `<p class="hint upd-p">Nothing is running right now.</p>`);
  const activeSection = (v) => `<section class="upd-sec"><div class="lbl">Active work${v.active?.length ? ` (${v.active.length})` : ""}</div>${activeList(v)}${v.active?.length ? `<p class="hint upd-p">These resume after the restart: only the step in progress is redone.</p>` : ""}</section>`;
  const foregroundNote = (v) => (v.startedBy === "foreground" ? `<p class="notice warn">The factory runs in the foreground, so it can't restart itself: the update pulls the new code, then you restart the factory by hand to finish it.</p>` : "");
  const head = (title) => `<div class="modal-head"><h2>${esc(title)}</h2><button type="button" class="icon-btn" data-act="close" aria-label="Close">${CLOSE_SVG}</button></div>`;

  function viewBody(v) {
    const c = v.check, u = v.update, parts = [];
    if (st.note) parts.push(`<p class="notice ${st.note.kind}">${esc(st.note.text)}</p>`);
    parts.push(`<div class="upd-grid"><div class="lbl">Running</div><div>${v.sha ? `<code>${esc(short(v.sha))}</code>` : "not a git checkout"}${v.date ? ` · ${esc(fmtDate(v.date))}` : ""} · v${esc(v.version)}</div>`
      + (v.updatable && c ? `<div class="lbl">Upstream</div><div>${esc(c.upstream)} at <code>${esc(c.upstreamSha || short(c.upstreamFullSha))}</code></div>` : "") + `</div>`);
    if (u && (u.phase === "failed" || u.phase === "rolled-back")) {
      parts.push(`<section class="upd-sec"><div class="lbl">Last update to <code>${esc(short(u.to))}</code> ${u.phase === "failed" ? "failed" : "was rolled back"}</div><pre class="err">${esc(u.error || "no details")}</pre></section>`);
    } else if (u?.phase === "done" && u.restartRequired && v.fullSha !== u.to) {
      parts.push(`<p class="notice warn">Pulled <code>${esc(short(u.to))}</code>. ${esc(u.message || "Restart the factory to finish the update")}.</p>`);
    }
    if (!v.updatable) {
      parts.push(`<p class="notice warn">Updates unavailable: ${esc(v.reason || "unknown reason")}</p>`);
      return parts.join("");
    }
    const checkLine = !c ? "Not checked yet."
      : c.error ? `<span class="upd-bad">Check failed: ${esc(c.error)}</span> <span class="meta">(compared with the last fetch, ${esc(when(c.checkedAt))})</span>`
      : `Last checked ${esc(when(c.checkedAt))} <span class="meta">${esc(stamp(c.checkedAt))}</span>`;
    parts.push(`<div class="upd-check"><span>${checkLine}</span><button type="button" class="btn small" data-act="check"${st.busy ? " disabled" : ""}>${st.busy === "check" ? `<span class="spin" aria-hidden="true"></span>Checking…` : "Check now"}</button></div>`);
    if (c && c.behind > 0) {
      const extra = c.behind - (c.commits?.length ?? 0);
      parts.push(`<section class="upd-sec"><div class="lbl">${esc(plural(c.behind, "incoming commit"))}</div><ul class="upd-commits">${(c.commits ?? []).map((s) => `<li>${inline(s)}</li>`).join("")}${extra > 0 ? `<li class="meta">and ${esc(extra)} more</li>` : ""}</ul></section>`);
    }
    const b = blockers(v);
    if (b.length) parts.push(`<p class="notice error">Update blocked: ${b.map(esc).join("; ")}.</p>`);
    else if (c && c.behind === 0) parts.push(`<p class="notice">Already up to date.</p>`);
    if (c && c.behind > 0) parts.push(activeSection(v), foregroundNote(v));
    return parts.join("");
  }

  function confirmBody(v) {
    const c = v.check;
    return `<p class="upd-p">Fast-forward the factory from <code>${esc(short(v.sha))}</code> to <code>${esc(c.upstreamSha || short(c.upstreamFullSha))}</code> (${esc(plural(c.behind, "commit"))})${v.startedBy === "foreground" ? "" : ", then restart it"}.</p>`
      + activeSection(v) + foregroundNote(v);
  }

  function updatingBody(v) {
    const u = v.update, phase = st.offline ? "restarting" : u?.phase, idx = PHASES.findIndex(([p]) => p === phase);
    const steps = PHASES.map(([p, label], i) => {
      const cls = i < idx ? "done" : i === idx ? "now" : "";
      const text = p === "restarting" && st.offline ? "Restarting…" : label;
      return `<li class="${cls}">${i === idx ? `<span class="spin" aria-hidden="true"></span>` : `<span class="upd-step-dot" aria-hidden="true"></span>`}${esc(text)}</li>`;
    }).join("");
    return `<p class="upd-p">Updating to <code>${esc(short(u?.to))}</code>. The page reloads by itself once the factory is back.</p><ol class="upd-steps" aria-live="polite">${steps}</ol>`
      + (st.offline ? `<p class="hint upd-p">The factory is restarting; checking again every 2 seconds.</p>` : "")
      + (v.active?.length ? `<p class="hint upd-p">${esc(plural(v.active.length, "active item"))} resume after the restart.</p>` : "");
  }

  function renderDialog() {
    const root = st.dlg, v = st.v;
    if (!root || !v) return;
    if (!root.isConnected) { st.dlg = null; return; }
    if (ACTIVE.includes(v.update?.phase) || st.offline) st.mode = "updating";
    else if (st.mode === "updating") st.mode = "view";
    if (st.mode === "confirm" && !canUpdate(v)) st.mode = "view";
    let title = "Factory version", body = "", foot = "";
    if (st.mode === "updating") {
      title = "Updating the factory"; body = updatingBody(v);
      foot = `<button type="button" class="btn" data-act="close">Hide</button>`;
    } else if (st.mode === "confirm") {
      title = "Update the factory?"; body = confirmBody(v);
      foot = `<button type="button" class="btn" data-act="back"${st.busy ? " disabled" : ""}>Back</button><button type="button" class="btn primary" data-act="apply"${st.busy ? " disabled" : ""}>${st.busy === "apply" ? `<span class="spin" aria-hidden="true"></span>Starting…` : v.startedBy === "foreground" ? "Update" : "Update and restart"}</button>`;
    } else {
      body = viewBody(v);
      foot = `<button type="button" class="btn" data-act="close">Close</button>${canUpdate(v) ? `<button type="button" class="btn primary" data-act="update"${st.busy ? " disabled" : ""}>Update</button>` : ""}`;
    }
    const focused = document.activeElement?.dataset?.act;
    root.innerHTML = `<div class="modal upd-modal" role="dialog" aria-modal="true" aria-label="${esc(title)}">${head(title)}<div class="modal-body">${body}</div><div class="modal-foot">${foot}</div></div>`;
    (focused && root.querySelector(`[data-act="${focused}"]:not([disabled])`))?.focus();
  }

  function openDialog() {
    if (!st.v) return;
    st.mode = "view"; st.note = null;
    st.dlg = openModal(`<div class="modal upd-modal"></div>`);
    st.dlg.addEventListener("click", onDialogClick);
    renderDialog();
    setTimeout(() => st.dlg?.querySelector(".btn.primary, [data-act=check]")?.focus(), 40);
  }

  async function onDialogClick(e) {
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (!act || st.busy) { if (act === "close") closeDialog(); return; }
    if (act === "close") return closeDialog();
    if (act === "update") { st.mode = "confirm"; st.note = null; return renderDialog(); }
    if (act === "back") { st.mode = "view"; return renderDialog(); }
    if (act === "check") return check();
    if (act === "apply") return apply();
  }
  function closeDialog() {
    if (st.dlg?.isConnected) { const i = modalStack.indexOf(st.dlg); if (i >= 0) modalStack.splice(i, 1); st.dlg.remove(); }
    st.dlg = null; st.mode = "view"; st.note = null;
  }

  async function check(note) {
    st.busy = "check"; st.note = note ?? null; renderDialog();
    try { const v = await api("/api/update/check", {}); st.busy = ""; accept(v); }
    catch (e) { st.busy = ""; st.note = { kind: "error", text: e.message }; renderDialog(); }
  }

  async function apply() {
    const sha = st.v?.check?.upstreamFullSha;
    if (!sha) return;
    st.busy = "apply"; renderDialog();
    try {
      const v = await api("/api/update/apply", { sha });
      st.busy = ""; st.mode = "updating"; accept(v); watch();
    } catch (e) {
      st.busy = "";
      if (e.code === "conflict" && !/running/i.test(e.message)) {
        // The upstream moved since the check: check again so the dialog shows the commits that would land now.
        st.mode = "view";
        return check({ kind: "warn", text: "The upstream moved since the last check. Checked again: review the commits that would land now." });
      }
      st.mode = "view"; st.note = { kind: "error", text: `Update refused: ${e.message}` };
      await refresh(); renderDialog();
    }
  }

  // ------------------------------------------------------------------ wiring
  $("#ver-chip")?.addEventListener("click", openDialog);
  $("#upd-banner")?.addEventListener("click", (e) => {
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (act === "dismiss") dismiss();
    if (act === "details") {
      const pre = $("#upd-banner pre"), b = e.target.closest("[data-act]");
      pre.hidden = !pre.hidden; b.setAttribute("aria-expanded", String(!pre.hidden)); b.textContent = pre.hidden ? "Details" : "Hide details";
    }
  });
  refresh();
  // The server checks the upstream periodically; pick that up (unless an update is being watched already).
  setInterval(() => { if (!st.watching && !st.busy) refresh(); }, 5 * 60 * 1000);
})();
