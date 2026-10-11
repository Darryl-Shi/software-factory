# AGENTS.md

Software factory on Pi Durable: a core that runs tickets through architect → builder → reviewer/QA → delivery,
with a local web UI. The contract for the current change is `docs/spec.md`; the overall design is
`docs/design-spec.md` (web UI: §3.6), configuration in `docs/configuration.md`.

## Commands

- Setup: `scripts/setup.sh` (npm ci; no build step)
- Test: npm test
- Typecheck: `npm run typecheck`
- Run: `scripts/run.sh` (= `bin/factory serve --foreground`; needs `bin/factory setup` first)
- Dry run without credentials: `npm run dry-run` (see README "Quickstart")

The web UI listens on http://127.0.0.1:7317 (`web.port`); `bin/factory web` prints the link with its access token.

## Map

- `bin/factory` — launcher (tsx, runs `src/cli.ts`)
- `src/core/` — the core: state machine, operations (`types.ts` has `CORE_OPS`), events
- `src/agents/`, `src/models/`, `src/sandbox/`, `src/boat/`, `src/github/` — roles, model hosts, sandboxing, QA, GitHub
- `src/setup/` — the setup wizard; `src/doctor.ts`, `src/daemon.ts`, `src/main.ts`, `src/cli.ts`
- `src/web/server.ts` — HTTP server: token/cookie auth, the `STATIC` table of exact static routes
  (including `/vendor/marked.js` and `/vendor/purify.js`, served from `node_modules`), ops, SSE, screenshots
- `src/web/ui/` — the browser UI, plain JS, no build step, strict CSP (`script-src 'self'`)
  - `index.html` loads, in order: `/vendor/marked.js`, `/vendor/purify.js`, `markdown.js`, `app.js`, `discussions.js`
  - `markdown.js` — `md()` / `inline()`: marked (GFM) + DOMPurify, sanitised HTML; plain-text fallback
  - `app.js` — board, run view, transcript (`patch`/`streamIn`), dock, modals; `discussions.js` — discussions
  - `app.css` — styles and light/dark tokens; markdown element styles at the end
- `test/` — vitest; `web.test.ts` (server, static routes), `web-markdown.test.ts` (renderer in jsdom)
- `scripts/` — `setup.sh`, `run.sh`, `dry-run.ts`

## Notes

- Dependencies are pinned to exact versions.
- Never add CDN or foreign origins to the UI; the CSP must not change.
