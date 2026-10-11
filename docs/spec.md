# Spec: full markdown rendering in the web UI

## Context

The factory's web UI (`src/web/ui/`) is plain JavaScript with no build step. The server serves it as static files under a strict CSP: `script-src 'self'`, `default-src 'self'`. Today all prose goes through a small hand-written `md()` in `src/web/ui/app.js`, and some short texts go through its `inline()` subset. `md()` handles only these:

- h1–h3
- flat `-`/`1.` lists
- ``` fences
- `` `code` ``, `**bold**` and bare URLs
- one `<p>` per source line

Agent replies, discussant replies, chat bubbles, specs, requests and draft tickets often use more than that. They contain tables, nested lists, links, italics, blockquotes, h4+ headings, multi-line paragraphs and task lists, and today those show up broken.

This change replaces the hand-written renderer with real CommonMark and GitHub-Flavoured Markdown (GFM) rendering. Everything else in the UI stays as it is.

## Key decisions

1. **Renderer libraries.** Parsing uses `marked`, with GFM on. Sanitising uses `DOMPurify`. Both are added to `package.json` as runtime dependencies, pinned to exact versions like the other deps (current: `marked` 18.1.0, `dompurify` 3.4.16).
2. **Served locally, no build step, no CDN.** `src/web/server.ts` serves each library's prebuilt browser build straight from `node_modules`. Each gets its own fixed static route under the same auth and headers as the other static files, for example `/vendor/marked.js` and `/vendor/purify.js`.
   - The routes are exact entries in the existing `STATIC` table. No directory or path-based serving is added.
   - `index.html` loads both with `<script defer>` before `app.js` and `discussions.js`.
   - The CSP stays unchanged and must not gain `unsafe-eval` or any foreign origin.
3. **One rendering module.** A single shared function replaces the current `md()`. Every caller of `md()` in `app.js` and `discussions.js` keeps working through it with the same name and signature.
   - It renders a string to sanitised HTML.
   - A second variant, for one-line texts, replaces `inline()`. It renders inline markdown without wrapping block elements.
   - Rendering is synchronous and deterministic: the same text always gives the same HTML. The transcript's diff-and-patch logic (`patch`, `_h` comparison) and the `streamIn` text animation must keep working on the rendered HTML.
4. **Markdown features supported:**
   - headings h1–h6
   - paragraphs with soft line breaks: single newlines inside a paragraph render as line breaks, since agents and humans write chat-style text
   - emphasis, strong and strikethrough
   - inline code and fenced or indented code blocks
   - ordered, unordered and nested lists, plus GFM task lists (checkboxes rendered read-only/disabled)
   - blockquotes, horizontal rules and GFM tables
   - links, autolinks and bare URLs (GFM autolink)
   - images (see the safety rules below)
5. **Safety.** Every rendered output passes through DOMPurify before it reaches `innerHTML`.
   - Raw HTML in the markdown is never executed. Script, style, iframe, object, form, on*-handler and `javascript:`/`data:` link content is stripped or neutralised. Harmless inline tags may remain.
   - Every link gets `target="_blank" rel="noopener noreferrer"`.
   - Images may only load from the UI's own origin or `data:` URIs, as the existing `img-src` CSP requires. Anything else falls back to a link or alt text, with no broken-image request to a foreign host.
6. **Where it applies.** These render as full markdown:
   - agent and discussant text in transcripts
   - factory/notice cards
   - the human's chat bubbles (sent and queued)
   - the spec modal and the spec preview in the approval dock
   - the run's request body
   - the discussion summary
   - draft ticket bodies (preview)
   - the architect's `ask_human` question in the composer card (previously inline-only)

   These use the inline variant:
   - finding descriptions, in the dock and the details pane
   - one-line labels that use `inline()` today

   These stay raw:
   - tool input/output panels (`<pre>`)
   - evidence blocks
   - raw textareas
7. **Styling.** `app.css` gains styles for the new elements inside every markdown container (`.a-text`, `.f-body`, `.you-bubble`, `.spec-doc`, `.c-preview`, `.c-q`, draft previews). The styles must fit the existing light/dark design tokens:
   - **Tables:** bordered and compact. A wide table scrolls horizontally inside its container instead of stretching the layout.
   - **Blockquotes:** a left rule and muted text.
   - **Other elements:** h4–h6, nested list indentation, `hr`, task-list checkboxes and images capped at the container width.
   - **Code blocks:** they keep the existing `pre` look. Syntax highlighting is out of scope.

   The "Show more" clamp on long factory cards and the spec-preview fade keep working.
8. **Failure mode.** If the libraries fail to load, prose falls back to escaped plain text with line breaks preserved. The UI never shows raw unescaped input and never breaks.
9. **Tests and docs.**
   - Tests cover the server's new vendor routes: served with the correct JavaScript content type, behind the same auth as other static files, and with no path traversal.
   - Tests cover the rendering function's safety, either through the module running in a test DOM or an equivalent check. At minimum: script tags and `javascript:` links are neutralised, and links get `rel="noopener noreferrer"`.
   - The builder updates the design doc's web-UI section (`docs/design-spec.md` §3.6, or `docs/spec.md` if present) and the README where they describe the UI.

## Out of scope

- Syntax highlighting.
- Math/LaTeX and Mermaid diagrams.
- Markdown in the setup wizard or CLI output.
- Changes to how agents or the core produce text.

## Acceptance behaviours

1. **Agent reply.** An agent or discussant reply with a GFM table, a nested bulleted list, a blockquote, an `### h3` and a `#### h4`, *italic*, ~~strikethrough~~ and a `[label](https://example.com)` link appears in the transcript as a formatted table, nested list, quote, headings, italics, strikethrough and a clickable "label" link. No literal `|`, `>` or `[` markup is shown.
2. **Links open safely.** Clicking a rendered link opens it in a new tab. The anchor has `rel="noopener noreferrer"`.
3. **Line breaks.** A two-line paragraph without a blank line between the lines shows as two lines in one paragraph. A blank line starts a new paragraph.
4. **Task lists.** A `- [ ] todo` / `- [x] done` list in a draft ticket body preview shows checkboxes that cannot be toggled.
5. **Fenced code.** A ```` ```ts ```` fenced block shows as a monospace code block with its content verbatim, including `<`, `>` and `&`. Markdown inside the fence is not rendered.
6. **Raw HTML is harmless.** A human chat message containing `<script>alert(1)</script>`, `<img src=x onerror=alert(1)>` or `[x](javascript:alert(1))` shows no alert, runs no script and produces no clickable `javascript:` link.
7. **Spec modal and preview.** The spec modal (`docs/spec.md`) shows a spec with tables and nested lists properly formatted. The approval dock's spec preview still shows a truncated, faded preview.
8. **Ask question.** An architect `ask_human` question that has a bulleted list and bold text shows formatted in the composer's question card.
9. **Raw panels stay raw.** Tool input and output panels still show raw preformatted text. Markdown inside them is not rendered.
10. **Wide tables.** A table wider than the transcript scrolls horizontally inside its block. The page layout does not widen.
11. **Local only, CSP unchanged.** With the browser's network panel open, the UI loads the markdown libraries only from the factory's own origin (e.g. `/vendor/...`), and no CSP violations are reported. An unauthenticated request to a vendor route is refused like other protected routes, or follows the same rule as `/app.js`.
12. **Streaming and clamping still work.** A streamed agent reply still animates in and renders as markdown once complete. A long factory card still clamps with "Show more" / "Show less".
13. **Tests and typecheck pass.** `npm test` and `npm run typecheck` pass, including the new tests for the vendor routes and sanitising.
