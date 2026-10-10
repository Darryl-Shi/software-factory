# Fixed architecture cleanup: remove the extension layer

Date: 2026-10-09 · Status: approved design, awaiting spec review

## Intent

The factory was built as a general-purpose core with pluggable stages: interface, intake, repo, delivery and
environment extensions, each selected by `stages.<kind>.use`, plus worker extensions selected per role by name.
Every stage has exactly one implementation and the pluggability adds contracts, lookups, schema merging and docs
without buying anything. This change makes the factory a fixed solution:

- **The web UI is the interface.** No CLI client, no socket server, no interface contract.
- **GitHub and the local sandbox are the backend**, called directly by the core.
- **The settings system stays** (layering, validate-on-save, per-run pinning, web Settings form); only its
  extension-driven parts go.

Success: the same run flow and behaviour as today, `npm test` and `npm run typecheck` green, the dry run passing over
the web HTTP API, and no extension contracts, stage selection or worker-extension selection left in code or docs.

Out of scope: containers (Docker as backend or as product contract was considered and dropped), new run behaviour,
a settings migrator.

## 1. Architecture and layout

```
src/
  core/      core.ts (Factory), run-task.ts, run-doc.ts, bridge.ts, findings.ts, messages.ts, usage.ts,
             settings.ts, types.ts, run-config.ts (was worker-settings.ts)
  github/    github.ts  one GitHub class: open, create, diff, writeArtifact, deliver, checks, annotate, merge
             host.ts    GitHubHost (GhApiHost, LocalGitHubHost): the only seam, kept for offline tests and the dry run
             git.ts     git helpers
  sandbox/   sandbox.ts Sandbox class: provision, env, dispose (was extensions/local-worktree)
  web/       server.ts + ui/
  agents/    tools.ts (coding, coding-readonly, subagent, test-runner, browser), web-search.ts, prompts.ts (role-*)
  main.ts    wiring: models, storage, GitHub(host), Sandbox, Factory, web server
  cli.ts     serve | stop | status | doctor | web
  testing/   scripted provider and dry-run agents
```

- `Factory` takes concrete dependencies: `{ configPath, models, github: GitHub, sandbox: Sandbox, ciPollMs?, log? }`.
- `CoreServices` in `run-task.ts` holds `github` and `sandbox` instead of the `repo/delivery/environment/intake(cfg)`
  lookups. Calls get the run's pinned settings directly (e.g. `github.open(ref, { runId, config })`).
- Removed from `types.ts`: `Configurable`, `FactoryCoreRef`, `IntakeExtension`, `InterfaceExtension`,
  `RepoExtension`, `DeliveryExtension`, `EnvironmentExtension`, `FactoryExtension`, `StageName`,
  `StageCallOptions`, `RunUpdate`. `DeliveryContext` loses `settings`/`stages`. `fork` goes (never called).
- Removed from the core: `ext()`, stage `use` resolution, `startInterfaces`, intake polling and `writeBack`,
  `extraExtensions`, extension schema merging.
- `FactoryCore` and `CORE_OPS` stay: they are the web server's typed allowlist of operations.
- **Agent tools:** a constant `ROLE_TOOLS` gives each role a fixed tool set (today's defaults):
  *(Superseded for the helper, reviewer and new qa roles by design-spec §9/§9.1: helpers write code, the reviewer has no `browser`, and `qa` gets `computer`.)*
  - architect: coding-readonly, web-search
  - builder: coding, subagent, test-runner, web-search
  - helper: coding-readonly, web-search
  - reviewer: coding-readonly, test-runner, browser, web-search

  > Superseded by [design-spec.md §3.3](../../design-spec.md#33-worker-extensions-layer-3-the-agents-environment). The reviewer
  > has no `browser`. Helpers write code: they get `coding`, `test-runner` and `web-search` (no `subagent`, no bridge tools)
  > and run in the builder's sandbox environment, the same worktree with the same write rules. Their
  > `roles.helper.{model, thinking}` default to the builder's (default, changeable). The builder is still the only role the core talks to.

  The `role-<role>` prompt is always added. These remain Pi Durable extensions internally (that is how Pi supplies
  tools), but are not selectable and have no name-based registry lookup.
- **Web server:** `main.ts` calls `startWebServer(factory, { host, port, tokenFile, log })` directly.
- **Deleted:** `src/extensions/cli/` (socket server and terminal client, settings menu), every CLI command except
  those listed below, `docs/extensions.md`, the `src/extensions/` directory.

## 2. Settings and data flow

The layering engine is unchanged (schema default → global → project; validate on save; pinned per run with a
config hash; source attribution; `settings.changed` events; the web Settings form). `coreSchema()` is the whole
schema; nothing is merged in from extensions.

| Path | Default | Was |
|---|---|---|
| `roles.<role>.{model, thinking}` | as today | same; `extensions` removed |
| `policy.*`, `storage.*` (global only), `version` | as today | unchanged |
| `workdir` | `~/factory/work` | `stages.repo.workdir` and `stages.environment.root` (merged) |
| `github.identity` | `{ kind: pat, tokenRef: env:GH_TOKEN }` | `stages.repo.identity` |
| `github.visibility` | `private` | `stages.repo.visibility` |
| `ci.{mode, fixRounds, checks, noChecksTimeout}` | `if-present`, `2`, `[]`, `2m` | `stages.delivery.ci.*` |
| `sandbox.{enabled, allowedDomains, deniedDomains, denyRead, extraWrite, unixSockets}` | as today | `stages.environment.sandbox.*` |
| `sandbox.setupScripts` | `[scripts/setup.sh, setup.sh, bin/setup]` | `stages.environment.setupScripts` |
| `web.{host, port}` (global only, applied at start) | `127.0.0.1`, `7317` | `stages.interface.{host, port}` |
| `webSearch.{mode, maxResults, maxCharsTotal, apiKey, endpoint}` | as today | `workers.web-search.*` |

Deleted settings: `stages.*.use`, `stages.interface.socket`, the intake stage, `stages.delivery.newRepo` /
`existingRepo` (single-valued: a new repo is always pushed to `main`, an existing repo always gets a PR),
`roles.<role>.extensions`, `workers.*`.

**Validation.** The former extension `validate` hooks become plain checks in the core's rules: a GitHub `app`
identity needs `appId`, `installationId` and `privateKeyRef`; `sandbox.extraWrite` must not make home or `/`
writable or overlap a denied path; CI values are checked by the schema. The "worker extension is installed" and
"`use` is installed" rules go.

**Data flow.** A run's pinned config holds everything. `run-task` passes the pinned `github`, `ci`, `sandbox` and
`workdir` values to `GitHub` and `Sandbox` calls. The web-search tool runs inside a role Conversation and needs its
pinned settings there: `WorkerSettingsDoc` (`factory.workers`) becomes `RunConfigDoc` (`factory.runConfig`) carrying
`{ runId, webSearch }`, written when the core creates a role or helper Conversation.

**Old config files.** No migrator (v1 was never released). Unknown keys fail validation as today. At startup, if the
config file has top-level `stages` or `workers` keys, `serve` exits with one error that names the new paths.

## 3. Process: serve as a daemon

`bin/factory` keeps only process commands:

```
factory serve [--config p] [--port n] [--fake-github dir] [--scripted] [--ci-poll-ms n] [--foreground]
factory stop [--config p]
factory status [--config p]
factory web [--config p]          print the web UI's link
factory doctor [--config p]
```

- **`serve`** detaches by default: it checks the pid file and the port, spawns itself with `--foreground` as a
  detached child (stdout/stderr to `~/.factory/factory.log`, next to the config file), waits until the child reports
  the web server is listening (or fails), prints the link and returns. Exit code is non-zero if the child failed to
  start.
- **`serve --foreground`** runs in the current process (for development, tests and systemd/launchd). It writes
  `~/.factory/factory.pid` once the web server listens and removes it on clean shutdown (SIGINT/SIGTERM).
- **Single instance.** If the pid file names a live process, `serve` exits non-zero ("already running, pid N").
  A stale pid file (dead process) is removed. **If the web port is taken, `serve` exits non-zero** with the port in
  the message; the factory never runs without its web UI.
- **`stop`** sends SIGTERM to the pid in the pid file, waits for the process to exit (bounded), and removes a stale
  file. **`status`** prints running/not running, the pid and the web link.
- `doctor` loses its socket check; it still checks model credentials, the sandbox, the GitHub identity and `gh`.

## 4. Testing

- All current suites keep their coverage, adjusted to the new constructors and paths. `test/helpers.ts` builds
  `new Factory({ github: new GitHub(new LocalGitHubHost(dir)), sandbox: new Sandbox(...), models, configPath })`.
- `settings.test.ts`: paths become `ci.*`, `sandbox.*`, `github.*`. The extension-schema and "not an installed
  worker extension" cases are replaced by: `roles.builder.extensions` is an unknown setting; a config file with
  `stages:` makes startup fail with the clear error.
- `web.test.ts` starts the server through `startWebServer`; it adds a case that a busy port is an error.
- New `daemon.test.ts`: `serve` detaches and `status` reports it; a second `serve` refuses; a busy port fails
  `serve` with non-zero exit; `stop` stops it and clears the pid file; a stale pid file is cleaned up.
- `sandbox.test.ts`, `github-api.test.ts`, `web-search.test.ts`, `machine.test.ts`, `messages.test.ts`,
  `findings.test.ts`, `durability.test.ts`: import and path changes only.
- **Dry run** (`scripts/dry-run.ts`): drives `factory serve --fake-github --scripted` (daemonized) through the web
  HTTP API (`POST /api/op/<op>` with the access token, events over SSE) instead of the socket CLI. Same §8 checks;
  checks that only exercised CLI commands (e.g. the settings menu) are dropped and the report lists which. It stops
  the factory with `factory stop`. `docs/dry-run-report.md` is
  regenerated.
- Done means `npm test`, `npm run typecheck` and `npm run dry-run` all pass.

## 5. Errors

Unchanged: a `GitHub` or `Sandbox` call that throws fails the run (`FAILED`); `retryRun` resumes it; calls stay
idempotent per `runId` (per-run records, check-before-write, `findPr` before `createPr`). New: busy port, a live
pid file, or a legacy `stages`/`workers` config all stop `serve` with a non-zero exit and a one-line reason.

## 6. Docs

- Delete `docs/extensions.md`.
- Rewrite `README.md`: the web UI as the interface, daemon commands, quickstart, layout; no CLI command list.
- Rewrite `docs/configuration.md` for the new paths; no stage or worker ownership.
- Update `docs/architecture.md`: direct modules instead of core-vs-extensions.
- `docs/design-spec.md`: add a note at the top and at each affected place that this spec supersedes it there, with a
  link; no full rewrite. Affected: the "everything varies via extensions" goal and the interfaces-as-extensions
  non-goal (§1), §3.2 and §3.3 (extension contracts, worker-extension selection), the interface parts of §3.6, and
  the setting paths in §5 and §6.
- `DEVIATIONS.md`: drop entries about extension contracts and the CLI; add one entry stating the pluggable layer
  was removed on purpose.
