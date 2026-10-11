# software-factory

A software factory built on **Pi Durable** (`@earendil-works/pi-durable@1.1.0`).
You give it a software request for a project. It runs an architecture discussion with you, writes a spec, builds the
product unattended, reviews the whole product against the spec, and delivers it to GitHub: a push to `main` for a new
repo, a pull request for an existing one. It also waits for CI and can merge. You are needed only in the discussion
and at the approval gates you turn on, but you can message the agent working on a run at any time. When a problem is
too unclear to write as a ticket, you can first talk it through with a model in a discussion, which ends in draft
tickets that you edit and turn into runs.

- **The core is model-free and durable** (`src/core/`). It is a state machine that runs as a Pi Durable Task, plus the
  agent bridge, projects, layered settings and durable pending asks. It never calls a model: it configures role
  Conversations (architect, builder and the helpers it has write code, reviewer, QA) and reads what they submit
  through the bridge.
  Its whole outside surface is a set of operations and an event stream (`FactoryCore` in `src/core/types.ts`).
- **GitHub, a local sandbox and boat.dev are the backend.** The core calls them directly: `GitHub` (`src/github/`) opens
  repos, delivers and waits for CI; `Sandbox` (`src/sandbox/`) gives each role a sandboxed environment in the run's
  worktree; `Boat` (`src/boat/`) gives each review round's QA agent a fresh boat.dev VM running the product.
- **Each review round is a code review plus AQ testing, in parallel.** The reviewer checks the product against the
  spec, runs the tests and reviews the diff for quality and security. The QA agent uses the product in the VM and
  backs every finding with a screenshot. QA is on by default (`qa.enabled`) and can be turned off per project.
- **The web UI is the interface**, on `http://127.0.0.1:7317`: a ticket board where each run moves through the pipeline
  stages on its own, a full-screen run view with the agents' conversations, a chat box, and approvals in a floating
  card, a Discussions tab, and a Settings view. The `factory` command only starts, stops and checks the process.
- **Discussions come before a ticket, when you want one.** A discussion is a chat with one model (the `discussant`
  role) about one project. It can read the repo, run commands in a read-only sandbox and search the web, but can't
  change anything. Asked for drafts, it submits a summary and draft tickets (`submit_tickets`). Each draft you create
  becomes a run whose architect gets the summary, so its own discussion can skip what is settled. Discussions are
  durable Tasks, like runs.
- **Each role has a fixed tool set** (`src/agents/`). Every role can search the web: `web_search` is backed by
  Parallel's Search API in `fast` mode. Give it a Parallel key with `factory setup search` (or `PARALLEL_API_KEY`)
  to turn it on.
- **`factory setup` is the setup wizard.** It sets up the credentials (GitHub, model providers, boat.dev, Parallel),
  pi provider packages and OpenAI- or Anthropic-compatible endpoints, the roles' models, and a user service that
  runs the factory. The factory stores what it collects, so no env vars are needed.

The design is in [`docs/design-spec.md`](docs/design-spec.md), as amended by the
[fixed architecture cleanup](docs/superpowers/specs/2026-10-09-fixed-architecture-cleanup-design.md). Every place the
code differs from them is listed in [`DEVIATIONS.md`](DEVIATIONS.md).

## Status

- **v1 was built in October 2026.**
- **Verified so far:** the test suite and a scripted end-to-end dry run of the spec's §8 trial plan
  ([`docs/dry-run-report.md`](docs/dry-run-report.md) has the checks and their results). Both use a fake GitHub on the
  local disk and scripted agents in place of models. The web UI was also driven end to end in a headless browser
  against a scripted factory. The latest dry run ran with the sandbox off (`DRYRUN_SANDBOX=0`). The bubblewrap tests
  (`test/sandbox.test.ts`) and a dry run with the sandbox on have not been run since the fixed-architecture refactor;
  both need `bubblewrap` and `socat`.
- **Discussions** were added on 11 October 2026. The test suite covers them, the dry run starts its first ticket
  from a discussion, and the Discussions tab was driven in a headless browser against the dry run's factory. The
  discussant's prompt has not been tried with a real model.
- **AQ testing and writing helpers** (design spec §9, §9.1) were added on 10 October 2026. They are verified with a
  disk-based fake boat.dev (`--fake-boat`) and a stub Cua Driver; nothing has run against the live boat.dev API yet.
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
- **For real models:** credentials for the roles' providers: an API key or a subscription login (OAuth).
- **For AQ testing:** a boat.dev key, unless `qa.enabled: false`. Without it and with QA on, runs fail at
  `PREPARING` with a message saying so.
- **For web search (optional):** a Parallel key. Without it, `web_search` tells the agent it isn't configured and the
  agent carries on.

`bin/factory setup` checks the prerequisites and stores the credentials: tokens and keys in `secrets.json` (mode
0600), model credentials in `pi/auth.json`, both next to the config file. Environment variables still work, but only
for a factory started from a shell that has them: `GH_TOKEN`, `BOAT_API_KEY`, `PARALLEL_API_KEY`, and the providers'
keys that pi-ai reads, such as `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` for the default roles. A service installed
by setup gets only `PATH`, so setup warns before installing one when a credential would come from the environment.

`bin/factory doctor` checks the config file, the provider packages' extensions, the model credentials, the sandbox,
the GitHub identity, the boat.dev and Parallel keys, and `gh`. Each credential line names where the credential comes
from, and a credential or prerequisite problem ends with the `factory setup <section>` that fixes it.

## Install

```sh
npm install
bin/factory --help
```

There is no build step: `bin/factory` runs `src/cli.ts` through `tsx`.

## Quickstart

**Without credentials.** This drives the whole §8 trial through the web UI's HTTP API. It uses a fake GitHub with a
local CI runner, scripted agents, SQLite storage and the real sandbox (unless `DRYRUN_SANDBOX=0`), and takes a few
minutes. On a Linux host without `socat`, run it with `DRYRUN_SANDBOX=0`:

```sh
npm run dry-run          # DRYRUN_DIR=/some/dir to choose where it writes; report.md is the result
```

**With real GitHub and models.**

```sh
npm install
bin/factory setup        # credentials, providers, role models, and optionally a user service
bin/factory serve        # starts the factory in the background and prints the web UI's link
```

If setup installed the service, the service runs the factory: skip `bin/factory serve`. Setup's last line shows the
link only if the web UI was already listening when setup finished; otherwise, with the service active, it says
`the service is starting; factory web prints the link`. `bin/factory web` prints the link once the service is up.

Open the link. **Create** a ticket with a project name, its repo (`owner/name`; created at the first delivery if it
doesn't exist) and the request, then answer the architect's questions and the approvals in the run view.

## Commands

```
factory serve [--config p] [--port n] [--fake-github dir] [--scripted] [--ci-poll-ms n] [--foreground]
factory stop [--config p]
factory status [--config p]
factory web [--config p]          print the web UI's link
factory doctor [--config p]
factory setup [section] [--config p]
```

- **`serve`** starts the factory as a background process and prints the web UI's link once it listens. It is the one
  process that owns storage and the core.
  - `--foreground` keeps it attached to the terminal, for systemd/launchd and development. SIGINT or SIGTERM stops it.
  - It exits 1 with a one-line reason, and nothing keeps running, if the web port is taken, a factory already runs
    for this config, `secrets.json` is readable by group or others or doesn't parse, or the config can't be parsed
    or still has the removed `stages`/`workers` sections or `roles.<role>.extensions` keys (see [configuration](docs/configuration.md#old-config-files)). The factory never runs without its web UI.
  - Unknown options are refused.
- **`stop`** stops the running factory and waits for it to exit.
- **`status`** prints `running (pid N)` and the link, or `not running` (exit 1).
- **`web`** prints the link again.
- **`doctor`** checks the setup and prints one `ok`/`warn`/`FAIL` line per check.
- **`setup`** is the interactive setup wizard. It needs a terminal: without one (stdin or stdout not a TTY) it exits 1
  with `factory setup is interactive; run it in a terminal`. There is no non-interactive mode.
  - With no section, it shows a status line per section, runs the sections in order (asking `Reconfigure <title>?`,
    e.g. `Reconfigure GitHub?`, for those already set up), runs `doctor`'s checks, and ends with the web UI's link,
    `the service is starting; factory web prints the link` (the service is active but has no link yet), or
    `next: factory serve`.
  - With a section, it runs only that one: `prereqs`, `github`, `models`, `roles`, `qa`, `search` or `service`. An
    unknown section exits 1 and lists them.
  - Each section saves when it finishes. Ctrl-C, at a prompt or while a spinner runs, prints
    `setup cancelled; completed sections were saved` and exits 130.
  - It works whether or not the factory is running. See [configuration](docs/configuration.md#setup) for what each
    section does.

`serve` options:
- `--config <path>`: the default is `~/.factory/config.yaml` (or `$FACTORY_CONFIG`). The file is created if missing.
- `--port <n>`: overrides `web.port`; `0` picks a free port.
- `--fake-github <dir>`: bare git remotes and a local CI runner instead of github.com.
- `--scripted`: registers the scripted agents as provider `scripted`. Roles must be configured with
  `scripted/<role>` models, as `scripted/architect` and `scripted/discussant` are in `scripts/dry-run.ts`.
- `--ci-poll-ms <n>`: how often to poll CI, in milliseconds.

The factory keeps its files next to the config file (`~/.factory/` by default):
- `factory.pid`: the running factory's pid. A pid file that names no running factory is removed.
- `factory.log`: the background process's output (mode 0600; it carries the link).
- `web-token`: the web UI's access token (mode 0600).
- `web-url`: the link, written while the web UI listens.
- `secrets.json`: the secrets `factory setup` stored (mode 0600; see
  [configuration](docs/configuration.md#secret-references)).
- `pi/`: the model host's directory: provider packages, `models.json` and `auth.json` (see
  [configuration](docs/configuration.md#model-providers)).

## Web UI

`factory serve` prints a link like `http://127.0.0.1:7317/?token=…`; `bin/factory web` prints it again. Open it to get:
- **Board:** one column per stage (Intake, Discussion, Spec approval, Build, Review, Deliver, Done). **Create** submits
  a ticket (a run), and creates the project if it is new; cards move on their own and show "Your turn" when a run
  waits for you.
- **Run view:** click any card, at any stage, for a full-screen view. The left rail lists the run's conversations
  (architect, builder and its helpers, each reviewer and its round's QA agent) and a timeline; the centre is the transcript, with every tool
  call as one plain row you can expand. The chat box always goes to the agent the run is with: questions from the
  architect are answered there, and at other times your message is steered into the agent's work (a busy agent sees
  it after its current step; an idle one replies). Approvals and escalations float above the conversation, so you can
  ask before you decide. At the spec gate, asking the architect for a change makes it revise the spec.
- **Discussions:** talk a problem through with one model before it becomes a ticket. **New discussion** asks for the
  project, a title, the model (prefilled from `discussion.model`) and the first message. The discussion view reuses
  the run view: the transcript and a chat box (**Stop** while the model is replying), and a drafts panel on the
  right. **Draft tickets** asks the model for a summary and draft tickets; edit a draft's title and body in place,
  then **Create ticket** turns it into a run on the board. That run's ticket details link back with "From
  discussion", and its board card has a small discussion marker. **Close discussion** makes it read-only (drafts can
  still become tickets, as they can in any state while the model isn't drafting); **Reopen** picks it up again with
  the latest default branch, and **Retry** brings back a discussion that failed.
- **Settings:** the layered settings as a form. Pick Global or a project; each field shows its source and a
  Reset/Inherit button.

Agent replies, chat bubbles, specs, requests, summaries and draft tickets render as GitHub-flavoured markdown
(tables, nested and task lists, quotes, links, code blocks), sanitised so raw HTML in them never runs; links open in a
new tab. The markdown libraries (`marked`, `DOMPurify`) are served by the factory itself from `/vendor/`, so the UI
loads nothing from other origins.

The UI listens on localhost only. To use it from another machine, forward the port over SSH
(`ssh -L 7317:127.0.0.1:7317 host`). Change the port with `web.port` or `serve --port`.

To look around without credentials, reopen a dry run's factory and browse its runs and the discussion its first
ticket came from:

```sh
DRYRUN_DIR=$PWD/.dryrun npm run dry-run
DRYRUN_BOAT_KEY=x bin/factory serve --config .dryrun/config.yaml --fake-github .dryrun/github --fake-boat .dryrun/boat --scripted   # prints the link
bin/factory stop --config .dryrun/config.yaml        # when you are done
```

## Tests

```sh
npm test            # vitest, 376 tests, a few minutes; no credentials or network needed
npm run typecheck   # tsc (noEmit)
```

| File | Covers |
|---|---|
| `test/machine.test.ts` | State transitions, gates, rejections, escalations, round and fix caps, CI modes, cancel/retry, events, pinning |
| `test/settings.test.ts` | Layering and source attribution, unset, validate-on-save, the fixed schema and role tool sets, refusing a legacy `stages`/`workers` config or `roles.<role>.extensions` key, projects, `discussion.model` and its fallback to the architect |
| `test/findings.test.ts` | Review and QA findings validation, builder responses, bridge enforcement, helpers that write |
| `test/qa.test.ts` | AQ testing on the fake boat: QA pass/fail with screenshots, `submit_qa` rules, statuses ran/off/skipped/unavailable, missing key, cancel, ttl stop and resume, the startup sweep |
| `test/discussion.test.ts` | Discussions: the checkout and its resync (diverged, force-pushed, deleted, remote gone, a reused id), start, close/reopen (the environment disposed and provisioned again, a factory note after the checkout changed), a failed start and retry, refusals and events; `say`, Stop (also a late one) and provider errors; no write tools; the pinned model; drafting with `submit_tickets` (invalid payloads, reminders, redrafts and what they are told about earlier drafts, Stop), draft edits and their refusals; `createTicket` (also on a `FAILED` discussion) and the architect's `# Prior discussion` |
| `test/durability.test.ts` | `kill -9` mid-build, at a pending approval, mid-helper and mid-QA (and a VM deleted while down), then resume; a discussion killed mid-turn, mid-draft and right after `createTicket` |
| `test/sandbox.test.ts` | The real bubblewrap sandbox: write rules (including the discussant's read-only worktree), denyRead, the factory home's secrets, no credential env vars, network allowlist |
| `test/sandbox-write.test.ts` | A write root around the factory home: neither the home nor the storage is writable; the builder's worktree inside the home still is |
| `test/github-api.test.ts` | `GhApiHost` request shapes, token handling, the GitHub App JWT exchange |
| `test/messages.test.ts` | `message`: routing, refusals, side turns and their cost, spec revision at the gate, steering a busy builder, held messages, re-review of changes made at the delivery gate |
| `test/web.test.ts` | The web server: token and cookie, Host/Origin/content-type checks, operations and error codes (discussion operations too), the event stream and its `discussion` filter, a busy port as an error, the static UI |
| `test/web-search.test.ts` | `web_search` against a fake Parallel endpoint: request shape, result formatting, errors, a run using pinned `webSearch` settings |
| `test/daemon.test.ts` | `serve`/`stop`/`status`/`web` as real processes: detaching, a second `serve`, a busy port, a bad or legacy config, unknown options, stale pid files, a fresh install |
| `test/secrets.test.ts` | The secret store: file and directory modes, atomic writes, refusing a loose or unparseable file, `store:` refs |
| `test/model-host.test.ts` | The model host: built-in providers, `models.json`, an installed provider package, extension errors as diagnostics, no `.pi/` from the cwd, live `auth.json` |
| `test/doctor.test.ts` | `doctor`: credential sources, extension diagnostics, `→ factory setup <section>` hints |
| `test/setup-*.test.ts` | `factory setup`: the UI adapter, the wizard, each section against stubs and local servers, and the command's refusals |

Notes:
- The 11 sandbox tests (`test/sandbox.test.ts`, `test/sandbox-write.test.ts`) need bubblewrap and socat installed; without them they are skipped. Where bubblewrap is installed but the kernel forbids unprivileged user namespaces, the ones that run a command in the sandbox fail with "bwrap: No permissions to create a new namespace".
- The durability tests and the fake GitHub write under `os.tmpdir()`. If `/tmp` is a small or quota-limited tmpfs,
  run `TMPDIR=/path/with/space npm test`.

## Layout

```
src/core/          core.ts (Factory), run-task.ts (state machine), run-doc.ts, bridge.ts, findings.ts, settings.ts,
                   messages.ts (who gets a message, and when), usage.ts (cost records), types.ts, run-config.ts,
                   discussion-task.ts (a discussion's state machine), discussion-doc.ts
src/github/        github.ts (GitHub: open, create, diff, writeArtifact, deliver, checks, annotate, merge),
                   host.ts (GitHubHost: GhApiHost for github.com, LocalGitHubHost as a local fake), git.ts (git helpers)
src/boat/          boat.ts (Boat: QA VMs per review round, BoatEnv), backend.ts (BoatApiBackend on @boatdev/sdk, LocalBoatBackend fake)
src/sandbox/       sandbox.ts (Sandbox: per-role environments in the run's worktree, inside sandbox-runtime)
src/web/           server.ts (HTTP + server-sent events) and ui/ (the static web UI, no build step;
                   discussions.js is the Discussions tab and discussion view)
src/agents/        tools.ts (coding, coding-readonly, subagent, test-runner, computer, browser; each role's fixed set),
                   web-search.ts, prompts.ts (role-* prompts)
src/models/        host.ts (the model host: pi-coding-agent's ModelRuntime and package manager over <factoryHome>/pi)
src/secrets/       store.ts (SecretStore over <factoryHome>/secrets.json; backs `store:` refs)
src/setup/         ui.ts (SetupUi, ClackUi), context.ts (SetupContext), wizard.ts (runSetup),
                   steps/ (one file per section: prereqs, github, models, roles, qa, search, service)
src/main.ts        process wiring: model host, secret store, storage, GitHub, Sandbox, Factory, web server
src/daemon.ts      serve in the background: pid, log and link files
src/doctor.ts      the `doctor` checks (also run at the end of `factory setup`)
src/cli.ts, bin/factory   the `factory` command: serve | stop | status | web | doctor | setup
src/testing/       scripted provider and dry-run agents
scripts/dry-run.ts the §8 dry run          test/   vitest suites
docs/              design spec, architecture, configuration, dry-run report
```

More: [architecture](docs/architecture.md) · [configuration](docs/configuration.md)
