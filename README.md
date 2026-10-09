# software-factory

A software factory built on **Pi Durable** (`@earendil-works/pi-durable@1.1.0`).
You give it a software request for a project. It runs an architecture discussion with you, writes a spec, builds the
product unattended, reviews the whole product against the spec, and delivers it to GitHub: a push to `main` for a new
repo, a pull request for an existing one. It also waits for CI and can merge. You are needed only in the discussion
and at the approval gates you turn on, but you can message the agent working on a run at any time.

- **The core is model-free and durable** (`src/core/`). It is a state machine that runs as a Pi Durable Task, plus the
  agent bridge, projects, layered settings and durable pending asks. It never calls a model: it configures role
  Conversations (architect, builder, reviewer, plus the builder's helpers) and reads what they submit through the bridge.
  Its whole outside surface is a set of operations and an event stream (`FactoryCore` in `src/core/types.ts`).
- **GitHub and a local sandbox are the backend.** The core calls them directly: `GitHub` (`src/github/`) opens repos,
  delivers and waits for CI; `Sandbox` (`src/sandbox/`) gives each role a sandboxed environment in the run's worktree.
- **The web UI is the interface**, on `http://127.0.0.1:7317`: a ticket board where each run moves through the pipeline
  stages on its own, a full-screen run view with the agents' conversations, a chat box, and approvals in a floating
  card, and a Settings view. The `factory` command only starts, stops and checks the process.
- **Each role has a fixed tool set** (`src/agents/`). Every role can search the web: `web_search` is backed by
  Parallel's Search API in `fast` mode. Set `PARALLEL_API_KEY` to turn it on.

The design is in [`docs/design-spec.md`](docs/design-spec.md), as amended by the
[fixed architecture cleanup](docs/superpowers/specs/2026-10-09-fixed-architecture-cleanup-design.md). Every place the
code differs from them is listed in [`DEVIATIONS.md`](DEVIATIONS.md).

## Status

- **v1 was built in October 2026.**
- **Verified so far:** the test suite and a scripted end-to-end dry run of the spec's §8 trial plan
  ([`docs/dry-run-report.md`](docs/dry-run-report.md) has the checks and their results). Both use a fake GitHub on the
  local disk and scripted agents in place of models. The web UI was also driven end to end in a headless browser
  against a scripted factory.
- **Not yet done:** a live trial against github.com with real models. The real-GitHub client (`GhApiHost`) has only
  been tested against a fake `gh` binary, `web_search` only against a fake Parallel endpoint, and the role prompts
  have not been tested with real models.

## Requirements

- **Node.js ≥ 22** (tested on 22.23).
- **`git`.**
- **For the sandbox:**
  - Linux: `bubblewrap` and `socat` (`sudo apt install bubblewrap socat`).
  - macOS: `sandbox-exec`.
- **For real GitHub:** the `gh` CLI and a token or a GitHub App. See [configuration](docs/configuration.md#github-identity).
- **For real models:** the providers' API keys in the environment. pi-ai reads them, for example `ANTHROPIC_API_KEY`
  and `OPENAI_API_KEY` for the default roles.
- **For web search (optional):** `PARALLEL_API_KEY`. Without it, `web_search` tells the agent it isn't configured
  and the agent carries on.

`bin/factory doctor` checks the config file, the model credentials, the sandbox, the GitHub identity and `gh`.

## Install

```sh
npm install
bin/factory --help
```

There is no build step: `bin/factory` runs `src/cli.ts` through `tsx`.

## Quickstart

**Without credentials.** This drives the whole §8 trial through the web UI's HTTP API. It uses a fake GitHub with a
local CI runner, scripted agents, SQLite storage and the real sandbox, and takes a few minutes:

```sh
npm run dry-run          # DRYRUN_DIR=/some/dir to choose where it writes; report.md is the result
```

**With real GitHub and models.** Set `GH_TOKEN` and the model keys, then:

```sh
bin/factory doctor
bin/factory serve        # starts the factory in the background and prints the web UI's link
```

Open the link. **Create** a ticket with a project name, its repo (`owner/name`; created at the first delivery if it
doesn't exist) and the request, then answer the architect's questions and the approvals in the run view.

## Commands

```
factory serve [--config p] [--port n] [--fake-github dir] [--scripted] [--ci-poll-ms n] [--foreground]
factory stop [--config p]
factory status [--config p]
factory web [--config p]          print the web UI's link
factory doctor [--config p]
```

- **`serve`** starts the factory as a background process and prints the web UI's link once it listens. It is the one
  process that owns storage and the core.
  - `--foreground` keeps it attached to the terminal, for systemd/launchd and development. SIGINT or SIGTERM stops it.
  - It exits 1 with a one-line reason, and nothing keeps running, if the web port is taken, a factory already runs
    for this config, or the config is invalid or still has the removed `stages`/`workers` sections (see
    [configuration](docs/configuration.md#old-config-files)). The factory never runs without its web UI.
  - Unknown options are refused.
- **`stop`** stops the running factory and waits for it to exit.
- **`status`** prints `running (pid N)` and the link, or `not running` (exit 1).
- **`web`** prints the link again.
- **`doctor`** checks the setup and prints one `ok`/`warn`/`FAIL` line per check.

`serve` options:
- `--config <path>`: the default is `~/.factory/config.yaml` (or `$FACTORY_CONFIG`). The file is created if missing.
- `--port <n>`: overrides `web.port`; `0` picks a free port.
- `--fake-github <dir>`: bare git remotes and a local CI runner instead of github.com.
- `--scripted`: registers the scripted agents as provider `scripted`. Roles must be configured with
  `scripted/<role>` models, as `scripted/architect` is in `scripts/dry-run.ts`.
- `--ci-poll-ms <n>`: how often to poll CI, in milliseconds.

The factory keeps its files next to the config file (`~/.factory/` by default):
- `factory.pid`: the running factory's pid. A pid file that names no running factory is removed.
- `factory.log`: the background process's output (mode 0600; it carries the link).
- `web-token`: the web UI's access token (mode 0600).
- `web-url`: the link, written while the web UI listens.

## Web UI

`factory serve` prints a link like `http://127.0.0.1:7317/?token=…`; `bin/factory web` prints it again. Open it to get:
- **Board:** one column per stage (Intake, Discussion, Spec approval, Build, Review, Deliver, Done). **Create** submits
  a ticket (a run), and creates the project if it is new; cards move on their own and show "Your turn" when a run
  waits for you.
- **Run view:** click any card, at any stage, for a full-screen view. The left rail lists the run's conversations
  (architect, builder and its helpers, each reviewer) and a timeline; the centre is the transcript, with every tool
  call as one plain row you can expand. The chat box always goes to the agent the run is with: questions from the
  architect are answered there, and at other times your message is steered into the agent's work (a busy agent sees
  it after its current step; an idle one replies). Approvals and escalations float above the conversation, so you can
  ask before you decide. At the spec gate, asking the architect for a change makes it revise the spec.
- **Settings:** the layered settings as a form. Pick Global or a project; each field shows its source and a
  Reset/Inherit button.

The UI listens on localhost only. To use it from another machine, forward the port over SSH
(`ssh -L 7317:127.0.0.1:7317 host`). Change the port with `web.port` or `serve --port`.

To look around without credentials, reopen a dry run's factory and browse its runs:

```sh
DRYRUN_DIR=$PWD/.dryrun npm run dry-run
bin/factory serve --config .dryrun/config.yaml --fake-github .dryrun/github --scripted   # prints the link
bin/factory stop --config .dryrun/config.yaml        # when you are done
```

## Tests

```sh
npm test            # vitest, 98 tests, about a minute; no credentials or network needed
npm run typecheck   # tsc (noEmit)
```

| File | Covers |
|---|---|
| `test/machine.test.ts` | State transitions, gates, rejections, escalations, round and fix caps, CI modes, cancel/retry, events, pinning |
| `test/settings.test.ts` | Layering and source attribution, unset, validate-on-save, the fixed schema and role tool sets, refusing a legacy `stages`/`workers` config, projects |
| `test/findings.test.ts` | Review and findings validation, builder responses, bridge enforcement, helper role tools |
| `test/durability.test.ts` | `kill -9` mid-build and at a pending approval (SQLite), then resume |
| `test/sandbox.test.ts` | The real bubblewrap sandbox: write rules, denyRead, no credential env vars, network allowlist |
| `test/github-api.test.ts` | `GhApiHost` request shapes, token handling, the GitHub App JWT exchange |
| `test/messages.test.ts` | `message`: routing, refusals, side turns and their cost, spec revision at the gate, steering a busy builder, held messages, re-review of changes made at the delivery gate |
| `test/web.test.ts` | The web server: token and cookie, Host/Origin/content-type checks, operations and error codes, the event stream, a busy port as an error, the static UI |
| `test/web-search.test.ts` | `web_search` against a fake Parallel endpoint: request shape, result formatting, errors, a run using pinned `webSearch` settings |
| `test/daemon.test.ts` | `serve`/`stop`/`status`/`web` as real processes: detaching, a second `serve`, a busy port, a bad or legacy config, unknown options, stale pid files, a fresh install |

Notes:
- The 6 sandbox tests need bubblewrap and socat installed; without them they are skipped (92 passed, 6 skipped).
- The durability tests and the fake GitHub write under `os.tmpdir()`. If `/tmp` is a small or quota-limited tmpfs,
  run `TMPDIR=/path/with/space npm test`.

## Layout

```
src/core/          core.ts (Factory), run-task.ts (state machine), run-doc.ts, bridge.ts, findings.ts, settings.ts,
                   messages.ts (who gets a message, and when), usage.ts (cost records), types.ts, run-config.ts
src/github/        github.ts (GitHub: open, create, diff, writeArtifact, deliver, checks, annotate, merge),
                   host.ts (GitHubHost: GhApiHost for github.com, LocalGitHubHost as a local fake), git.ts (git helpers)
src/sandbox/       sandbox.ts (Sandbox: per-role environments in the run's worktree, inside sandbox-runtime)
src/web/           server.ts (HTTP + server-sent events) and ui/ (the static web UI, no build step)
src/agents/        tools.ts (coding, coding-readonly, subagent, test-runner, browser; each role's fixed set),
                   web-search.ts, prompts.ts (role-* prompts)
src/main.ts        process wiring: models, storage, GitHub, Sandbox, Factory, web server
src/daemon.ts      serve in the background: pid, log and link files
src/cli.ts, bin/factory   the `factory` command: serve | stop | status | web | doctor
src/testing/       scripted provider and dry-run agents
scripts/dry-run.ts the §8 dry run          test/   vitest suites
docs/              design spec, architecture, configuration, dry-run report
```

More: [architecture](docs/architecture.md) · [configuration](docs/configuration.md)
