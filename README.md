# software-factory

A general-purpose, interface-agnostic software factory built on **Pi Durable** (`@earendil-works/pi-durable@1.1.0`).
You give it a software request for a project. It runs an architecture discussion with you, writes a spec, builds the
product unattended, reviews the whole product against the spec, and delivers it to GitHub: a push to `main` for a new
repo, a pull request for an existing one. It also waits for CI and can merge. You are involved only in the discussion
and at the approval gates you turn on.

- **The core is model-free and durable** (`src/core/`). It is a state machine that runs as a Pi Durable Task, plus the
  agent bridge, projects, layered settings and durable pending asks. It never calls a model: it configures role
  Conversations (architect, builder, reviewer, plus the builder's helpers) and reads what they submit through the bridge.
  Its whole outside surface is a set of operations and an event stream (`FactoryCore` in `src/core/types.ts`).
- **Everything else is an extension** (`src/extensions/`). That covers interfaces, intake, repo, delivery and the
  execution environment, plus the worker extensions that give agents their tools.
- **v1 ships one interface: a CLI.** It is a Unix-socket server inside the factory process plus the `factory` terminal
  client. v1 has no intake extension, so runs start from the CLI.

The design is in [`docs/design-spec.md`](docs/design-spec.md). Every place the code differs from it is listed in
[`DEVIATIONS.md`](DEVIATIONS.md).

## Status

- **v1 was built in October 2026.**
- **Verified so far:** the test suite (66 tests) and a scripted end-to-end dry run of the spec's §8 trial plan (50/50
  checks, [`docs/dry-run-report.md`](docs/dry-run-report.md)). Both use a fake GitHub on the local disk and scripted
  agents in place of models.
- **Not yet done:** a live trial against github.com with real models. The real-GitHub client (`GhApiHost`) has only
  been tested against a fake `gh` binary, and the role prompts have not been tested with real models.

## Requirements

- **Node.js ≥ 22** (tested on 22.23).
- **`git`.**
- **For the sandbox:**
  - Linux: `bubblewrap` and `socat` (`sudo apt install bubblewrap socat`).
  - macOS: `sandbox-exec`.
- **For real GitHub:** the `gh` CLI and a token or a GitHub App. See [configuration](docs/configuration.md#github-identity).
- **For real models:** the providers' API keys in the environment. pi-ai reads them, for example `ANTHROPIC_API_KEY`
  and `OPENAI_API_KEY` for the default roles.

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
factory reject <run> <gate> "<feedback>"     factory findings <run> <delivery|merge> '<json>' | @file.json
factory escalation <run> accept | more <N> | abort
factory cancel <run> [reason]                factory retry <run>
factory settings [--project p]               interactive menu generated from settingsSchema()
factory settings get|set|unset <path> [<value>] [--project p]
factory doctor
```

## Tests

```sh
npm test            # vitest, 66 tests, about 30 s; no credentials or network needed
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

Notes:
- The sandbox tests need bubblewrap (and socat) installed.
- The durability tests and the fake GitHub write under `os.tmpdir()`. If `/tmp` is a small or quota-limited tmpfs,
  run `TMPDIR=/path/with/space npm test`.

## Layout

```
src/core/                 types (contracts), core (Factory), run-task (state machine), run-doc, bridge, findings, settings
src/extensions/cli/       interface: socket server + terminal client
src/extensions/github/    repo `github`, delivery `github-delivery`, GitHub hosts (gh api / local fake)
src/extensions/local-worktree/   environment: per-run worktree + sandbox-runtime
src/extensions/workers/   worker extensions (Pi Durable): coding, coding-readonly, subagent, test-runner, browser, role prompts
src/extensions/git.ts     git helpers
src/main.ts               process wiring: models, storage, the installed extensions
src/cli.ts, bin/factory   the `factory` command
src/testing/              scripted provider and dry-run agents
scripts/dry-run.ts        the §8 dry run          test/   vitest suites
docs/                     design spec, architecture, configuration, extensions, dry-run report
```

More: [architecture](docs/architecture.md) · [configuration](docs/configuration.md) · [writing extensions](docs/extensions.md)
