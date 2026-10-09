# software-factory

A general-purpose, interface-agnostic software factory built on **Pi Durable** (`@earendil-works/pi-durable@1.1.0`).
You give it a software request for a project. It runs an architecture discussion with you, writes a spec, builds the
product unattended, reviews the whole product against the spec, and delivers it to GitHub: a push to `main` for a new
repo, a pull request for an existing one. It also waits for CI and can merge. You are needed only in the discussion
and at the approval gates you turn on, but you can message the agent working on a run at any time.

- **The core is model-free and durable** (`src/core/`). It is a state machine that runs as a Pi Durable Task, plus the
  agent bridge, projects, layered settings and durable pending asks. It never calls a model: it configures role
  Conversations (architect, builder, reviewer, plus the builder's helpers) and reads what they submit through the bridge.
  Its whole outside surface is a set of operations and an event stream (`FactoryCore` in `src/core/types.ts`).
- **Everything else is an extension** (`src/extensions/`). That covers interfaces, intake, repo, delivery and the
  execution environment, plus the worker extensions that give agents their tools.
- **Two interfaces ship and run side by side, both extensions:**
  - a **web UI** on `http://127.0.0.1:7317`: a ticket board where each run moves through the pipeline stages on its
    own, and a full-screen run view with the agents' conversations, a chat box, and approvals in a floating card;
  - a **CLI**: a Unix-socket server inside the factory process plus the `factory` terminal client.

  There is no intake extension yet, so runs start from either interface.
- **Workers can search the web.** The default `web-search` worker extension gives every role a `web_search` tool
  backed by Parallel's Search API in `fast` mode. Set `PARALLEL_API_KEY` to turn it on.

The design is in [`docs/design-spec.md`](docs/design-spec.md). Every place the code differs from it is listed in
[`DEVIATIONS.md`](DEVIATIONS.md).

## Status

- **v1 was built in October 2026.**
- **Verified so far:** the test suite (85 tests) and a scripted end-to-end dry run of the spec's §8 trial plan
  (50/50 checks with the sandbox on, [`docs/dry-run-report.md`](docs/dry-run-report.md); the web UI checks added
  since pass with the sandbox off). Both use a fake GitHub on the local disk and scripted agents in place of models.
  The web UI was also driven end to end in a headless browser against a scripted factory.
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

`bin/factory doctor` checks the model credentials, the sandbox, the GitHub identity and `gh`.

## Install

```sh
npm install
bin/factory --help
```

There is no build step: `bin/factory` runs `src/cli.ts` through `tsx`.

## Quickstart

**Without credentials.** This drives the whole §8 trial through the CLI. It uses a fake GitHub with a local CI runner,
scripted agents, SQLite storage and the real sandbox, and takes about 2 minutes:

```sh
npm run dry-run          # DRYRUN_DIR=/some/dir to choose where it writes; report.md is the result
```

**With real GitHub and models.** Set `GH_TOKEN` and the model keys, then:

```sh
bin/factory doctor
bin/factory serve &                                   # the one process that owns storage and the core
bin/factory run todo --repo me/todo "CLI todo tool: add/list/done/remove, JSON file storage, tests" --attach
```

`run --repo` creates the project if it doesn't exist. `--attach` opens the live view, where you answer the
architect's questions and the approval prompts.

### Web UI

`factory serve` prints a link like `http://127.0.0.1:7317/?token=…`; `bin/factory web` prints it again. Open it to get:
- **Board:** one column per stage (Intake, Discussion, Spec approval, Build, Review, Deliver, Done). **Create** submits
  a ticket (a run); cards move on their own and show "Your turn" when a run waits for you.
- **Run view:** click any card, at any stage, for a full-screen view. The left rail lists the run's conversations
  (architect, builder and its helpers, each reviewer) and a timeline; the centre is the transcript, with every tool
  call as one plain row you can expand. The chat box always goes to the agent the run is with: questions from the
  architect are answered there, and at other times your message is steered into the agent's work (a busy agent sees
  it after its current step; an idle one replies). Approvals and escalations float above the conversation, so you can
  ask before you decide. At the spec gate, asking the architect for a change makes it revise the spec.
- **Settings:** the same layered settings as `factory settings`, as a form.

The UI listens on localhost only. To use it from another machine, forward the port over SSH
(`ssh -L 7317:127.0.0.1:7317 host`). Change the port with `stages.interface.port`.

To look around without credentials, reopen a dry run's factory and browse its runs:

```sh
DRYRUN_DIR=$PWD/.dryrun npm run dry-run
(cd .dryrun && ../bin/factory serve --config config.yaml --fake-github github --scripted) &
bin/factory web --config .dryrun/config.yaml
```

`factory serve` options:
- `--config <path>`: the default is `~/.factory/config.yaml` (or `$FACTORY_CONFIG`). The file is created if missing.
- `--socket <path>`
- `--fake-github <dir>`: bare git remotes and a local CI runner instead of github.com.
- `--scripted`: registers the scripted agents as provider `scripted`. Roles must be configured with
  `scripted/<role>` models, as `scripted/architect` is in `scripts/dry-run.ts`.
- `--ci-poll-ms <n>`

### CLI commands

The commands below talk to `factory serve` over its socket. `$FACTORY_SOCKET` or `--socket` overrides the socket path.

```
factory project create <name> --repo owner/name | project list
factory run <project> [--repo owner/name] [--title t] "<request>" [--attach]
factory runs [--project p] [--json]          factory status <run> [--json]
factory attach <run> [--no-input]            live view; answers questions / approvals / escalations
factory transcript <run> [architect|builder|reviewer|<conversationId>] [--json]
factory answer <run> "<text>"                factory approve <run> <spec|delivery|merge>
factory message <run> "<text>"               message the agent the run is with (never moves the run)
factory reject <run> <gate> "<feedback>"     factory findings <run> <delivery|merge> '<json>' | @file.json
factory escalation <run> accept | more <N> | abort
factory cancel <run> [reason]                factory retry <run>
factory settings [--project p]               interactive menu generated from settingsSchema()
factory settings get|set|unset <path> [<value>] [--project p]
factory web [--config path]                  print the web UI's link
factory doctor
```

## Tests

```sh
npm test            # vitest, 85 tests, a few minutes; no credentials or network needed
npm run typecheck   # tsc (noEmit)
```

| File | Covers |
|---|---|
| `test/machine.test.ts` | State transitions, gates, rejections, escalations, round and fix caps, CI modes, cancel/retry, events, pinning |
| `test/settings.test.ts` | Layering and source attribution, unset, validate-on-save, extension schemas, projects |
| `test/findings.test.ts` | Review and findings validation, builder responses, bridge enforcement, helper role tools |
| `test/durability.test.ts` | `kill -9` mid-build and at a pending approval (SQLite), then resume |
| `test/sandbox.test.ts` | The real bubblewrap sandbox: write rules, denyRead, no credential env vars, network allowlist |
| `test/github-api.test.ts` | `GhApiHost` request shapes, token handling, the GitHub App JWT exchange |
| `test/messages.test.ts` | `message`: routing, refusals, side turns and their cost, spec revision at the gate, steering a busy builder, held messages, re-review of changes made at the delivery gate |
| `test/web.test.ts` | The web interface: token and cookie, Host/Origin/content-type checks, operations and error codes, the event stream, a busy port, the static UI |
| `test/web-search.test.ts` | `web_search` against a fake Parallel endpoint: request shape, result formatting, errors, a run using pinned `workers.web-search` settings |

Notes:
- The sandbox tests need bubblewrap (and socat) installed.
- The durability tests and the fake GitHub write under `os.tmpdir()`. If `/tmp` is a small or quota-limited tmpfs,
  run `TMPDIR=/path/with/space npm test`.

## Layout

```
src/core/                 types (contracts), core (Factory), run-task (state machine), run-doc, bridge, findings, settings,
                          messages (who gets a message, and when), usage (cost records), worker-settings
src/extensions/cli/       interface: socket server + terminal client
src/extensions/web/       interface: HTTP + server-sent events server; ui/ is the static web UI (no build step)
src/extensions/github/    repo `github`, delivery `github-delivery`, GitHub hosts (gh api / local fake)
src/extensions/local-worktree/   environment: per-run worktree + sandbox-runtime
src/extensions/workers/   worker extensions (Pi Durable): coding, coding-readonly, subagent, test-runner, browser, web-search, role prompts
src/extensions/git.ts     git helpers
src/main.ts               process wiring: models, storage, the installed extensions
src/cli.ts, bin/factory   the `factory` command
src/testing/              scripted provider and dry-run agents
scripts/dry-run.ts        the §8 dry run          test/   vitest suites
docs/                     design spec, architecture, configuration, extensions, dry-run report
```

More: [architecture](docs/architecture.md) · [configuration](docs/configuration.md) · [writing extensions](docs/extensions.md)
