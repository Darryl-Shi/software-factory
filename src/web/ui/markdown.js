// Markdown rendering for the web UI (spec: "full markdown rendering"). A classic script loaded after the vendored
// /vendor/marked.js and /vendor/purify.js and before app.js; it defines the globals md(text) (block markdown) and
// inline(text) (one-line markdown, no block wrappers). Both return sanitised HTML, synchronously and deterministically.
// Without the libraries both fall back to escaped plain text (line breaks kept).
(function (root) {
  "use strict";
  const escape = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const plainBlock = (t) => { const s = String(t ?? ""); return s.trim() ? `<p>${escape(s).replace(/\r?\n/g, "<br>")}</p>` : ""; };
  const plainInline = (t) => escape(t).replace(/\r?\n/g, "<br>");

  // Images may load only from this origin or data: URIs (the CSP's img-src); anything else becomes a link or alt text.
  const imageOk = (src) => {
    if (/^data:image\//i.test(src)) return true;
    try {
      const base = root.location && root.location.href;
      const u = new URL(src, base);
      return !!base && /^https?:$/.test(u.protocol) && u.origin === new URL(base).origin;
    } catch { return false; }
  };

  let engine; // undefined: not set up yet; null: libraries missing
  function setup() {
    if (engine !== undefined) return engine;
    const M = root.marked, P = root.DOMPurify;
    if (!M || typeof M.Marked !== "function" || !P || typeof P.sanitize !== "function" || P.isSupported === false) return (engine = null);
    const marked = new M.Marked({ gfm: true, breaks: true, async: false });
    const purify = typeof P === "function" ? P(root) : P; // a private instance, so our hooks stay ours
    purify.addHook("afterSanitizeAttributes", (node) => {
      const tag = node.nodeName;
      if (tag === "A") {
        node.setAttribute("target", "_blank");
        node.setAttribute("rel", "noopener noreferrer");
      } else if (tag === "INPUT") {
        // only GFM task-list checkboxes, read-only
        if ((node.getAttribute("type") ?? "").toLowerCase() !== "checkbox") { node.remove(); return; }
        node.setAttribute("disabled", "");
        node.removeAttribute("name");
      } else if (tag === "IMG") {
        const src = node.getAttribute("src") ?? "";
        if (src && imageOk(src)) { node.setAttribute("loading", "lazy"); return; }
        const doc = node.ownerDocument, alt = node.getAttribute("alt") ?? "";
        let repl;
        if (/^https?:\/\//i.test(src)) {
          repl = doc.createElement("a");
          repl.setAttribute("href", src);
          repl.setAttribute("target", "_blank");
          repl.setAttribute("rel", "noopener noreferrer");
          repl.textContent = alt || src;
        } else repl = doc.createTextNode(alt);
        node.replaceWith(repl);
      }
    });
    const cfg = {
      FORBID_TAGS: ["style", "form", "button", "textarea", "select", "option", "iframe", "frame", "object", "embed", "link", "meta", "base", "svg", "math", "video", "audio", "source", "picture", "dialog", "template"],
      FORBID_ATTR: ["style", "srcset", "id", "name", "action", "formaction"],
      ALLOW_DATA_ATTR: false,
    };
    return (engine = { marked, sanitize: (html) => purify.sanitize(html, cfg) });
  }

  function md(text) {
    const s = String(text ?? "");
    const e = setup();
    if (!e) return plainBlock(s);
    try { return e.sanitize(e.marked.parse(s)); } catch { return plainBlock(s); }
  }
  function inline(text) {
    const s = String(text ?? "");
    const e = setup();
    if (!e) return plainInline(s);
    try { return e.sanitize(e.marked.parseInline(s)); } catch { return plainInline(s); }
  }
  root.md = md;
  root.inline = inline;
})(typeof window !== "undefined" ? window : globalThis);
