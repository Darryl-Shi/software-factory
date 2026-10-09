# Architecture

This page covers how the code is organised and how a run flows through it. [`design-spec.md`](design-spec.md) is the
design the code implements, and [`../DEVIATIONS.md`](../DEVIATIONS.md) lists every place the code differs from it.

## Core vs extensions

```
        interfaces (cli, web)          intake (none in v1)
                 │  operations ▲ events       │ requests ▲ writeBack
                 ▼             │              ▼          │
        ┌──────────────── FactoryCore (src/core) ────────────────┐
        │ state machine (Pi Durable Task) · bridge · projects ·  │
        │ layered settings · durable pending asks                │
        └───┬──────────────┬───────────────┬─────────────────────┘
            │ repo         │ delivery      │ environment         role Conversations
            ▼              ▼               ▼                     (worker extensions)
       github         github-delivery   local-worktree        architect · builder (+ helpers) · reviewer
```

**The core** (`src/core/`) is model-free and interface-agnostic.
- `run-task.ts` is the state machine: one phase per run state, running as a Pi Durable Task.
- `run-doc.ts` defines the `factory.run` Document. It holds the run's state, counters, pending ask, artifacts,
  findings log, cost records and pinned config.
- `bridge.ts` holds the tools agents use to hand results to the core: `ask_human`, `submit_spec`, `report_done` and
  `submit_review`. `findings.ts` validates what agents submit through them.
- `messages.ts` decides who a human message goes to and when (`message`), and builds what the agent sees.
  `usage.ts` turns Conversation usage into cost records without counting a turn twice.
- `worker-settings.ts` is the `factory.workers` Document that carries a run's pinned `workers.<name>` settings to
  worker extensions' tools.
- `settings.ts` is the layered config store. `core.ts` (`Factory`) wires all of this together and implements
  `FactoryCore`.

**Factory extensions** fill the pipeline stages. Each is a plain object with a `kind`, a `name`, its operations and
optionally a settings schema (see [extensions.md](extensions.md)). The ones v1 includes:

| Stage | Extension | File |
|---|---|---|
| interface | `cli` | `src/extensions/cli/server.ts` (client: `client.ts`, `src/cli.ts`) |
| interface | `web` | `src/extensions/web/server.ts` (UI: `src/extensions/web/ui/`) |
| intake | none | runs start through `startRun` |
| repo | `github` | `src/extensions/github/repo.ts` |
| delivery | `github-delivery` | `src/extensions/github/delivery.ts` |
| environment | `local-worktree` | `src/extensions/local-worktree/index.ts` |

Both GitHub extensions talk to GitHub through a `GitHubHost`:
- `GhApiHost` uses `gh api`.
- `LocalGitHubHost` is a fake that keeps bare remotes on disk and runs workflow steps in a local CI runner. Tests and
  the dry run use it.

**Worker extensions** (`src/extensions/workers/`) are ordinary Pi Durable extensions that give role Conversations their
tools:

| Extension | Provides |
|---|---|
| `coding` | read, write, edit and bash tools |
| `coding-readonly` | read and bash tools |
| `subagent` | helpers as owned Conversations |
| `test-runner` | `run_tests` |
| `browser` | `http_request`: an HTTP client over curl, not a real browser |
| `web-search` | `web_search`: Parallel's Search API in `fast` mode, run in the factory process |
| `role-*` | each role's prompt sections |

Which worker extensions a role gets comes from the settings (`roles.<role>.extensions`).

`src/main.ts` is the process wiring. It creates the pi-ai models, installs the extensions listed above and starts the
configured interfaces. Extensions are registered in code; nothing is loaded dynamically.

## The flow

A request moves through these states (`RUN_STATES` in `src/core/types.ts`):

```
RECEIVED → PREPARING → DISCUSSING ⇄ (questions) → SPEC_READY → [spec gate] → BUILDING → REVIEWING
   REVIEWING ──fail──► BUILDING (same builder, with findings)    … up to policy.reviewRoundCap, then ESCALATED
   REVIEWING ──pass──► [delivery gate] → DELIVERING → AWAITING_CI
   AWAITING_CI ──red──► BUILDING → REVIEWING → DELIVERING        … up to ci.fixRounds, then ESCALATED
   AWAITING_CI ──green / no CI / ci off──► [merge gate, PRs only] → DELIVERED
Any non-terminal state ──cancel──► CANCELLED;  errors → FAILED;  retry: FAILED/CANCELLED → the state at failure
```

1. **Preparing.** The repo extension calls `open` on the project's repo. If the repo exists, it is cloned and a
   per-run worktree is made on branch `factory/<runId>`. If not, a local repo is initialised. The environment
   extension then provisions an environment for each role.
2. **Architecture discussion.** The architect asks one question at a time through `ask_human`. Each question becomes
   a durable pending ask that any interface can answer. The architect ends the discussion with `submit_spec`.
3. **Spec.** The spec must contain an "Acceptance behaviours" heading. The repo extension commits it to
   `docs/spec.md`. If the `spec` gate is on (the default), the run waits for approval. A rejection sends it back to
   the discussion.
4. **Build.** One builder Conversation does the build. It is the only writer, and it may spawn read-only helpers
   through `subagent`. It finishes with `report_done`, which must answer every blocking finding it was given.
5. **Whole-product review.** A fresh reviewer Conversation with read-only tools reviews the whole product against
   the spec. It submits a verdict with `submit_review`. The verdict is `fail` exactly when a blocking finding exists,
   and every finding needs `evidence` and a `specRef`.
   - On `fail`, the findings go back to the same builder.
   - The run escalates when the round cap is reached, or when a fix round leaves the diff unchanged
     (`policy.escalateOnNoProgress`).
   - On an escalation, the human chooses *accept as is*, *N more rounds* or *abort*.
6. **PR / merge.**
   - **Delivery.** If the optional `delivery` gate is on, the run waits for approval first. A new repo is created
     (private by default) and pushed to `main`. For an existing repo, the run branch is pushed and a PR is opened.
     Advisory findings go into the PR description, or into `docs/delivery-notes.md` for a new repo.
   - **CI.** The run then waits for CI according to `ci.mode`. A red CI goes back to the builder as a finding with
     `source: "ci"`.
   - **Merge.** The optional `merge` gate applies only to PRs. Approving it squash-merges the PR. Without the gate,
     the PR is left open.
   - **Gate rejections.** Rejecting the delivery or merge gate sends the human's feedback to the builder as blocking
     findings with `source: "human"`. This doesn't use up a review round or a CI fix round.

## Durability

- **One Pi Durable Task per run** (task `factory.run`). Each phase does its side effects and then commits a
  *transition*: the `factory.run` Document and the task checkpoint are written atomically. After a crash, the task
  resumes at the last committed phase. `test/durability.test.ts` checks this with `kill -9` at two points (mid-build
  and at a pending approval), followed by a reopen.
- **Agent work is idempotent.** Input to a role Conversation is submitted with a request ID derived from the run,
  phase and sequence number, such as `<run>:BUILDING:<n>`. A resumed phase therefore reattaches to the same turn
  instead of submitting it twice. The builder Conversation persists across rounds, so its context survives fix
  rounds and restarts.
- **Stage operations are idempotent per run.**
  - `open` keeps a per-run workspace record.
  - `writeArtifact` and `annotate` are no-ops when the change is already there.
  - `provision` reuses an existing environment record.
- **Pending asks are stored in the run Document.** They survive restarts, and an interface that connects later sees
  them through `getRun` or as `run.ask` events. The first valid answer resolves an ask; later answers are rejected.
- **Pinning.** When a run starts, it records:
  - its effective config (global settings merged with the project's), and a hash of it;
  - the Pi Durable version.

  The run then uses that pinned config for its whole life. Settings changes affect only new runs.
- **Storage** is SQLite by default (`storage.kind: sqlite`); `jsonl` is the alternative. Tests use in-memory storage
  or SQLite.

## Operations and events

`FactoryCore` (`src/core/types.ts`) is the whole interface surface. It has no transport of its own.

- **Projects:** `createProject`, `getProject`, `listProjects`.
- **Runs:** `startRun`, `getRun`, `listRuns`, `getConversation`, `cancelRun`, `retryRun`.
  - `getRun` returns a `RunView`.
  - `getConversation` returns a read-only transcript, including the builder's helpers.
- **Answers to the pending ask:** `answer`, `approve`, `reject`, `submitHumanFindings`, `resolveEscalation`.
- **Messages:** `message(run, text)` sends a message to the agent the run is with: the architect through the spec
  gate, the current reviewer while reviewing, otherwise the builder. It never moves the run.
  - The core steers it into the Conversation's inbox. A working agent sees it after its current tool round; an idle
    one answers in a turn of its own, whose cost is recorded with `trigger: "message"`.
  - If the role hasn't started, or the core is about to submit its next input, the message is held and delivered
    right after that input.
  - At the spec gate the architect may revise the spec (`submit_spec`), which replaces the version waiting for
    approval. If the builder changes files after the review, delivery first sends the run back through review.
- **Settings:** `settingsSchema`, `getSettings`, `setSetting`, `unsetSetting`.
- **Events:** `subscribe(filter, on)`. A filter can select a project or a run. Event types:
  - `run.state`: a state transition.
  - `run.ask`: a question, approval or escalation is pending.
  - `run.askResolved`: carries `by`, the interface that answered.
  - `run.notice`: progress and the final result.
  - `conversation.updated`: a role transcript changed.
  - `run.message`: a message was sent, and again once it was handed to a Conversation.
  - `settings.changed`

Interfaces receive a handle from `Factory.as(name)`, so the answers and messages they send are attributed to them.
The operations a transport may call are listed in `CORE_OPS` (`src/core/types.ts`).
- The `cli` interface maps them onto JSON lines over a Unix socket (mode 0600).
- The `web` interface maps them onto HTTP on localhost: `POST /api/op/<op>` with `{ args }`, and `subscribe` as
  server-sent events at `/api/events`. It also serves the UI: a board whose columns are pipeline stages, and a
  full-screen run view with the run's conversations, a chat box addressed by `message`, and approvals in a card that
  floats over the transcript. The UI only calls these operations; it has no state of its own beyond a cache.

## Security boundaries

- **Agents never hold the GitHub credentials.** The core and the repo and delivery extensions push, open PRs and
  merge. Agents only work in the worktree.
- **Every agent command runs inside `@anthropic-ai/sandbox-runtime`.**
  - Each role has its own write rules. The builder can write its worktree and scratch dir; the architect, reviewer
    and helpers are read-only.
  - `denyRead` hides secret paths.
  - Network access goes through an allowlist.
  - Commands start from an empty environment, so no credential env vars reach them.
- See DEVIATIONS.md §9 for the Ubuntu ≥ 24.04 Unix-socket relaxation.
- **The web UI is local and token-protected.** It binds to `127.0.0.1`, rejects foreign `Host` headers (DNS
  rebinding) and foreign `Origin`s, requires `application/json` on operations, and needs the access token from
  `~/.factory/web-token` (mode 0600). The link's token becomes an HttpOnly, SameSite=Strict cookie. A strict CSP
  allows only same-origin scripts.
- **`web_search` runs outside the sandbox, in the factory process.** Its API key stays there. Query text does
  leave the machine, so the tool's section tells agents not to put secrets or private code in queries.
