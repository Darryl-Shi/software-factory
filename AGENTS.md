# AGENTS.md

Software factory on Pi Durable: a ticket board where runs move through architect → builder → review → delivery, plus
pre-ticket discussions (the full-screen chat behind the **Chat** button). TypeScript run with `tsx`, no build step.

- **Spec of the current change:** [docs/spec.md](docs/spec.md) (the contract). Design docs: `docs/design-spec.md`,
  `docs/superpowers/specs/*.md`; architecture: `docs/architecture.md`; settings: `docs/configuration.md`.
- **Progress log of the current build:** PROGRESS.md.

## Commands

```sh
scripts/setup.sh          # npm ci (Node 24+, git)
Test: npm test
npm run typecheck         # tsc -p . (noEmit)
npx vitest run test/web.test.ts -t "chat ops"    # one file / one test
DRYRUN_SANDBOX=0 DRYRUN_DIR=$PWD/.dryrun npm run dry-run   # end-to-end trial through the HTTP API (~3 min)
scripts/run.sh            # the product with scripted agents, fake GitHub and boat.dev; seeds .dryrun/ on first start
```

`npm test` needs no credentials or network; it takes a few minutes. The sandbox tests skip without bubblewrap/socat.
If `/tmp` is small or read-only, set `TMPDIR`.

## Running

`scripts/run.sh` serves the web UI in the foreground on **http://127.0.0.1:7317** (`PORT=` to change). It prints
`web UI: http://127.0.0.1:7317/?token=…`; open that link (the token becomes a cookie). Without the token you get a
login page (HTTP 401). The real product is `bin/factory serve` (see README) and needs credentials (`factory setup`).

## Repo map

```
src/core/        Factory (core.ts) implementing FactoryCore (types.ts; CORE_OPS = the ops the web server exposes),
                 run state machine (run-task.ts), discussions (discussion-task.ts, discussion-doc.ts: deriveTitle),
                 settings.ts (layered config, THINKING_LEVELS), bridge.ts, findings.ts, messages.ts, usage.ts
src/web/         server.ts (POST /api/op/<op>, GET /api/events SSE, static UI)
src/web/ui/      index.html, app.css, app.js (board, run view, settings, Create), discussions.js (the Chat view:
                 chat bar dropdowns, history rail, transcript, composer, drafts panel) — classic scripts, no build
src/github/      GitHub client + LocalGitHubHost fake;  src/sandbox/  bubblewrap sandbox;  src/boat/  QA VMs
src/models/      model host (pi-ai models; getAvailable() backs listModels);  src/setup/  `factory setup` wizard
src/testing/     scripted model provider and dry-run agents
src/cli.ts, src/main.ts, src/daemon.ts           the `factory` command and process wiring
scripts/dry-run.ts                               dry run (spec §8) through the web API
test/            vitest suites (helpers.ts: makeFactory with scripted agents and fake GitHub)
docs/            spec.md (current change), architecture.md, configuration.md, design docs
```

## Conventions

- The UI only calls `core.<op>(...)` for ops listed in `CORE_OPS`; test/web.test.ts checks this.
- index.html loads `/app.js` then `/discussions.js` (deferred classic scripts sharing globals); no inline scripts (CSP).
- Tabs in TypeScript; UI files use two spaces. Never weaken tests to make them pass.
- Commit often; keep PROGRESS.md short.
