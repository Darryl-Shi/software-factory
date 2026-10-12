# AGENTS.md

The software factory: a model-free, durable core (Pi Durable Tasks) that takes a request through an architecture
discussion, a spec, an unattended build, a review (code review + AQ testing) to **Ready**, and ships Ready tickets of
one project together as a **bundle**: one PR (or a push to `main` for a new repo), CI, and Merge.

- **Product spec:** [`docs/spec.md`](docs/spec.md). Per-change specs: `docs/specs/<run-id>.md` (the bundles change:
  [`docs/specs/run-mv4ghzj2-allm.md`](docs/specs/run-mv4ghzj2-allm.md); clearing Done runs:
  [`docs/specs/run-mv46ek2u-7omz.md`](docs/specs/run-mv46ek2u-7omz.md); the Chat button and full-screen chat:
  [`docs/specs/run-mv46hn3a-f4fa.md`](docs/specs/run-mv46hn3a-f4fa.md); markdown rendering:
  [`docs/specs/run-mv46mros-6c1p.md`](docs/specs/run-mv46mros-6c1p.md); the five-column board and UI sizing:
  [`docs/specs/run-mv4rgjw0-ch4q.md`](docs/specs/run-mv4rgjw0-ch4q.md); the combined review of clean multi-ticket
  bundles: [`docs/specs/run-mv4vd9xu-g2si.md`](docs/specs/run-mv4vd9xu-g2si.md)).
- **Design and deviations:** `docs/design-spec.md`, `docs/superpowers/specs/*`, `DEVIATIONS.md`.
- **How it fits together:** `docs/architecture.md`; settings: `docs/configuration.md`.

## Commands

Setup: `scripts/setup.sh` (runs `npm ci`; Node ≥ 22 and `git` needed; no build step, `bin/factory` runs `src/cli.ts`
through `tsx`).

Test: `npm test`

- Typecheck: `npm run typecheck`
- One file: `npx vitest run test/bundle.test.ts` (the board's layout and columns: `test/web-board.test.ts`, jsdom)
- `test/sandbox.test.ts` and `test/sandbox-write.test.ts` need a working bubblewrap + socat (they fail where user
  namespaces are not available, e.g. inside another sandbox).
- Dry run (end to end through the HTTP API, scripted agents, fake GitHub): `DRYRUN_SANDBOX=0 npm run dry-run`
  (`DRYRUN_DIR=$PWD/.dryrun` to keep it; `report.md` is the result; `docs/dry-run-report.md` is the committed copy).

Run: `scripts/run.sh` starts a credential-free factory in the foreground (scripted agents, fake GitHub and boat.dev
under `.factory-dev/`, sandbox off). The web UI listens on **http://127.0.0.1:7317** (`PORT=` to change); open the
printed link (it carries the access token; also in `.factory-dev/web-url`).

Real use: `bin/factory setup` (credentials, models, service), then `bin/factory serve` (background) /
`bin/factory web` (prints the link) / `bin/factory stop` / `bin/factory status` / `bin/factory doctor`.

## Map

```
bin/factory              CLI entry (tsx src/cli.ts)
src/cli.ts               serve/stop/status/web/doctor/setup
src/main.ts              process wiring: secret store, model host, GitHub, Sandbox, Boat, Factory, web server
src/daemon.ts            background serve (factory.pid, factory.log)
src/core/
  types.ts               FactoryCore contract: states, views, operations (CORE_OPS), events
  core.ts                Factory: implements FactoryCore; caches, events, migrations, bundle/run/discussion ops
  run-task.ts            the run state machine (Pi Durable Task): ... REVIEWING → DELIVERING → READY (legacy: old delivery)
  run-doc.ts             factory.run Document, RunView, specPathOf, isLegacyDelivery
  bundle-task.ts         the bundle state machine: INTEGRATING/FIXING/REVIEWING/DELIVERING/AWAITING_CI/AWAITING_MERGE/...
                         (reviews the combination when the integrator changed anything or 2+ tickets merged cleanly)
  bundle-doc.ts          factory.bundle Document, BundleView
  task-kit.ts            shared by run and bundle Tasks: role Conversations, runAgent, review rounds + QA, CI wait
  discussion-task.ts     discussions (pre-ticket chats), discussion-doc.ts its Document
  bridge.ts              agent → core tools (ask_human, submit_spec, report_done, submit_review, submit_qa, submit_tickets)
  findings.ts            submission validation; messages.ts human messages (runs and bundles); usage.ts costs
  settings.ts            layered config + schema (bundle.mergeMethod, roles.integrator, ...)
src/agents/              role prompts (prompts.ts) and fixed tool sets (tools.ts), web_search
src/github/              GitHub (worktrees, diff, deliver, bundles: integrate/merge/PR), host.ts (gh API / LocalGitHubHost fake)
src/sandbox/             sandbox-runtime environments per role (builder and integrator write)
src/boat/                boat.dev VMs for AQ testing (fake backend in backend.ts)
src/web/                 HTTP + SSE server; ui/ (app.js board + run view, bundles.js bundle view, discussions.js the full-screen chat behind the Chat button)
                         ui/markdown.js: md()/inline() (marked + DOMPurify, served at /vendor/marked.js, /vendor/purify.js
                         from node_modules as exact STATIC routes); index.html loads vendor → markdown.js → app.js →
                         discussions.js → bundles.js (classic scripts, one global scope; strict CSP, no build step)
src/setup/               the setup wizard
src/testing/             scripted model provider and the dry run's scripted agents
scripts/                 setup.sh, run.sh, dry-run.ts
test/                    vitest suites (helpers.ts: makeFactory, scripted agents' Control, shipAndMerge)
```

## Conventions

- The core never calls a model; agents hand results to it through the bridge tools only.
- Every state change is one commit of the Task's Document with its checkpoint (durable across `kill -9`).
- Tests use the fake GitHub (`LocalGitHubHost`) and scripted agents (`test/helpers.ts`); never weaken a test.
- Commit messages: `area: what changed`. Keep `PROGRESS.md` (build notes) current during a build.
