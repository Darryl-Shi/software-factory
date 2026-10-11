# AGENTS.md — software factory (`swf`)

The contract for the current change is **[docs/spec.md](docs/spec.md)** (clearing Done runs from the board).
The original design is docs/design-spec.md; departures are recorded in DEVIATIONS.md.
Architecture: docs/architecture.md · Configuration: docs/configuration.md · User docs: README.md.

## Commands

- Setup: `scripts/setup.sh` (runs `npm ci`; no build step — `bin/factory` runs `src/cli.ts` through tsx)
- Test: npm test
- Typecheck: `npm run typecheck`
- One suite: `npx vitest run test/clear.test.ts`
- Run (real credentials): `scripts/run.sh` → `bin/factory serve --foreground`
- Run (no credentials, demo data): `FACTORY_DEMO=1 scripts/run.sh` — a dry run (scripted agents, fake GitHub and
  boat) in `.dryrun/`, then serves it. Extra args go to `serve` (e.g. `--port 0`).
- Background: `bin/factory serve` / `bin/factory stop` / `bin/factory status` / `bin/factory web` (prints the link)

## URL

The web UI listens on **http://127.0.0.1:7317/** (`web.port`, or `serve --port`). Access needs the token link that
`serve` prints (`http://127.0.0.1:7317/?token=…`; also in `web-url` next to the config file). The API is
`POST /api/op/<op>` with `{"args":[...]}` (Bearer token or the cookie; content-type application/json) and
`GET /api/events` (server-sent events).

## Repo map

```
src/core/        types.ts (FactoryCore, CORE_OPS, events), core.ts (Factory: operations, events, clearRuns),
                 run-doc.ts (RunDoc state, toView), run-task.ts (state machine), discussion-*.ts, settings.ts, ...
src/web/         server.ts (HTTP + SSE, op allowlist, status mapping) and ui/ (static app.js, discussions.js,
                 app.css, index.html — no build step)
src/github/ src/boat/ src/sandbox/ src/agents/ src/models/ src/secrets/ src/setup/   platform services
src/main.ts src/daemon.ts src/cli.ts bin/factory   process wiring and the `factory` command
src/testing/     scripted provider used by tests and the dry run
scripts/         setup.sh, run.sh, dry-run.ts
test/            vitest suites (clear.test.ts: clearing runs; web.test.ts: HTTP incl. clearRuns)
docs/            spec.md (current contract), design-spec.md, architecture.md, configuration.md
```

## Notes

- Tests need no credentials or network; sandbox tests are skipped without bubblewrap/socat.
- If `/tmp` is small or read-only, run tests with `TMPDIR=/path/with/space`.
- Clearing: `clearRuns(runs)` sets `RunDoc.cleared = { at, by }` (soft archive, nothing deleted); `listRuns` hides
  cleared runs unless `includeCleared: true`; the board loads with `includeCleared: true` so ticket keys stay stable
  and filters cleared runs out itself.
- PROGRESS.md is the builder's progress log.
