# Architecture

This page covers how the code is organised and how a run, and a discussion before it, flow through it.
[`design-spec.md`](design-spec.md) is the design the code implements, as amended by the
[fixed architecture cleanup](superpowers/specs/2026-10-09-fixed-architecture-cleanup-design.md) and extended by
[discussions](superpowers/specs/2026-10-11-discussion-flow-design.md), and
[`../DEVIATIONS.md`](../DEVIATIONS.md) lists every place the code differs from them.

## Core and its backends

```
                    web UI (src/web)
                 │  operations ▲ events
                 ▼             │
        ┌──────────────── FactoryCore (src/core) ────────────────┐
        │ run and discussion state machines (Pi Durable Tasks) · │
        │ bridge · projects · layered settings · pending asks    │
        └───┬──────────────────────┬─────────────────────┬───────┘
            ▼                      ▼                     ▼
         GitHub                 Sandbox             role Conversations (fixed tools)
    (src/github: GhApiHost   (src/sandbox:         architect · builder (+ helpers) · reviewer
     or LocalGitHubHost)      sandbox-runtime)     · qa · discussant (src/agents)
```

**The core** (`src/core/`) is model-free and knows nothing about the web UI.
- `run-task.ts` is the state machine: one phase per run state, running as a Pi Durable Task.
- `run-doc.ts` defines the `factory.run` Document. It holds the run's state, counters, pending ask, artifacts,
  findings log, cost records and pinned config.
- `discussion-task.ts` is the discussion's state machine, a second kind of Pi Durable Task beside the run's, and
  `discussion-doc.ts` defines its `factory.discussion` Document: state, the turn in progress, drafts, summary,
  notices, turn costs and pinned config (see [Discussions](#discussions)).
- `bridge.ts` holds the tools agents use to hand results to the core: `ask_human`, `submit_spec`, `report_done`,
  `submit_review`, `submit_qa` and `submit_tickets`. `findings.ts` validates what agents submit through them.
- `messages.ts` decides who a human message goes to and when (`message`), and builds what the agent sees.
  `usage.ts` turns Conversation usage into cost records without counting a turn twice.
- `run-config.ts` is the `factory.runConfig` Document that carries a run's pinned `webSearch` settings to the
  `web_search` tool.
- `settings.ts` is the layered config store and the whole schema (`coreSchema()`). `core.ts` (`Factory`) wires all of
  this together and implements `FactoryCore`.

**The backends** are plain classes the core calls directly. Calls that depend on settings get the run's pinned settings.

| Module | File | Does |
|---|---|---|
| `GitHub` | `src/github/github.ts` | `open`, `create`, `diff`, `writeArtifact`, `deliver`, `checks`, `annotate`, `merge`; reads `workdir` and `github.*` |
| `GitHubHost` | `src/github/host.ts` | The GitHub API seam: `GhApiHost` uses `gh api`; `LocalGitHubHost` is a fake that keeps bare remotes on disk and runs workflow steps in a local CI runner (tests and the dry run use it) |
| `Sandbox` | `src/sandbox/sandbox.ts` | `provision`, `env`, `dispose`: per-role environments in the run's worktree, inside sandbox-runtime; reads `workdir` and `sandbox.*` |
| web server | `src/web/server.ts` (UI: `src/web/ui/`) | HTTP and server-sent events over the core's operations |
| agent tools | `src/agents/` | The role Conversations' tools and prompts (below) |

**Agent tools** (`src/agents/`) are ordinary Pi Durable extensions, because that is how Pi supplies tools. They are
not selectable: `ROLE_TOOLS` in `tools.ts` gives each role a fixed set, after its `role-<role>` prompt.

| Tool set | Provides | Roles |
|---|---|---|
| `coding` | read, write, edit and bash tools | builder, helper |
| `coding-readonly` | read and bash tools | architect, reviewer, qa, discussant |
| `subagent` | helpers (which write code) as owned Conversations | builder |
| `test-runner` | `run_tests` | builder, helper, reviewer |
| `computer` | the Cua Driver in the QA VM; every screenshot is stored as a run artifact | qa |
| `browser` | `http_request` over curl; no role gets it now, kept so older Conversations resume | — |
| `web-search` | `web_search`: Parallel's Search API in `fast` mode, run in the factory process | all |
| `role-*` (`prompts.ts`) | each role's prompt sections | each its own |

`src/main.ts` is the process wiring. It creates the pi-ai models, a `GitHub` on a `GhApiHost` (or a `LocalGitHubHost`
with `--fake-github`), a `Sandbox` and the `Factory`, which opens the storage, then starts the web server.
`src/daemon.ts` runs `factory serve` in the background with `factory.pid` and `factory.log`; the web server writes
`web-token` and `web-url`. All four live next to the config file.

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

1. **Preparing.** `GitHub.open` opens the project's repo. If the repo exists, it is cloned and a per-run worktree is
   made on branch `factory/<runId>`. If not, a local repo is initialised. `Sandbox.provision` then provisions an
   environment for each role.
2. **Architecture discussion.** The architect asks one question at a time through `ask_human`. Each question becomes
   a durable pending ask that the web UI shows and answers. The architect ends the discussion with `submit_spec`.
3. **Spec.** The spec must contain an "Acceptance behaviours" heading. `GitHub.writeArtifact` commits it to
   `docs/spec.md`. If the `spec` gate is on (the default), the run waits for approval. A rejection sends it back to
   the discussion.
4. **Build.** One builder Conversation does the build and is accountable for it. It may have helpers write code in
   parallel through `subagent` (in its own worktree; helpers use `roles.helper`, else the builder's model). It
   finishes with `report_done`, which must answer every blocking finding it was given.
5. **Review and AQ testing, in parallel.** A fresh reviewer Conversation with read-only tools reviews the whole
   product against the spec, runs the tests, and reviews the round's diff for quality and security; it submits
   `submit_review` (every finding needs `evidence`; `specRef` is optional). If `qa.enabled` and the repo has a run
   script, a fresh QA Conversation uses the product in a boat.dev VM (`src/boat/`) and submits `submit_qa`, where
   every finding cites a screenshot it took. The round fails exactly when either submitted a blocking finding.
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

## Discussions

A discussion is a chat with one model, the **discussant**, about one project, before any ticket exists. It is optional:
Create still starts a run directly. It runs as its own Pi Durable Task (`createDiscussionTask`), beside the run Tasks
and on the same services, and never appears on the board.

```
PREPARING ──ok──► OPEN ──closeDiscussion──► CLOSED ──reopenDiscussion──► PREPARING
    └──error──► FAILED ──retryDiscussion──► PREPARING
```

1. **Preparing.** `GitHub.open` makes a checkout of the project's repo under `<workdir>/discussions/<id>` (an empty
   workspace if the repo doesn't exist yet), and `Sandbox.provision` gives the `discussant` role the architect's
   rules: the worktree is read-only, its scratch dir is writable, setup scripts don't run. The first time, the core
   creates the discussion's one Conversation with the pinned model and submits the project context followed by the
   human's first message. A reopen or retry keeps the Conversation and resyncs the checkout (`GitHub.refresh`):
   the checkout is read-only, so it is reset to `origin/<default>` and cleaned rather than merged, which survives a
   force-pushed default branch or stray local changes. A missing checkout, manifest or clone is made again with
   `GitHub.open`, as is a new-repo workspace whose repo now exists. Only a git failure (e.g. the remote is gone)
   fails the discussion. When the checkout changed (another head, or the repo now exists), the next turn's input
   carries a short factory note saying so. Leaving `OPEN` (close or failure) disposes the discussant's environment,
   as a run's end does; a reopen or retry provisions it again.
2. **Turns.** One at a time. `say` submits the human's text as a message; the turn ends when the model stops.
   `requestDrafts` submits drafting instructions; the turn ends when the model calls `submit_tickets`, after up to
   2 reminders. `stopTurn` asks for the turn to stop and aborts the Conversation's work; it returns at once, and the
   discussion Task clears the turn and adds the `stopped` notice when that work has ended. A stopped turn is not
   resumed. A provider error ends the turn with a notice and leaves the discussion `OPEN`.
3. **Drafts.** A valid `submit_tickets` sets the summary and replaces the drafts that haven't become runs. A redraft's
   input lists the drafts that already became tickets (title and run, not to be submitted again) and the current
   drafts' texts, with the human's edits marked, so the model builds on them. The human edits or deletes drafts with
   `updateDraft` and `deleteDraft`.
4. **Handoff.** `createTicket` works in any discussion state, except while a `draft` turn runs; it creates the run and
   records the draft's `runId` in one commit, through the same helper
   as `startRun`, so a crash can't leave one without the other. The run's request has `source: "discussion"` and a
   copy of the link in `meta.discussion` (discussion id and title, draft id, summary, the titles of the other drafts
   of the same submission). The run never reads the discussion again. Its architect gets a `# Prior discussion`
   section with the summary and those titles, and still runs its own discussion, which the summary should make
   shorter.

The discussant's tools are `coding-readonly` and `web-search`; `submit_tickets` is its only bridge tool, accepted
only during a `draft` turn. It can't be messaged through `message`: the human talks to it with `say`.

## Durability

- **One Pi Durable Task per run** (task `factory.run`). Each phase does its side effects and then commits a
  *transition*: the `factory.run` Document and the task checkpoint are written atomically. After a crash, the task
  resumes at the last committed phase. `test/durability.test.ts` checks this with `kill -9` at two points (mid-build
  and at a pending approval), followed by a reopen.
- **One Pi Durable Task per discussion.** A pending `PREPARING` runs again after a crash; a turn in progress resumes
  waiting on its Conversation; a `submit_tickets` that was recorded but not applied is applied once. Turn inputs are
  submitted with the request ID `<id>:turn<n>`. `test/durability.test.ts` kills the factory mid-turn, mid-draft and
  right after `createTicket`.
- **Agent work is idempotent.** Input to a role Conversation is submitted with a request ID derived from the run,
  phase and sequence number, such as `<run>:BUILDING:<n>`. A resumed phase therefore reattaches to the same turn
  instead of submitting it twice. The builder Conversation persists across rounds, so its context survives fix
  rounds and restarts.
- **`GitHub` and `Sandbox` calls are idempotent per run.**
  - `open` keeps a per-run workspace record.
  - `writeArtifact` and `annotate` are no-ops when the change is already there.
  - `provision` reuses an existing environment record.
- **Pending asks are stored in the run Document.** They survive restarts, and a browser that connects later sees
  them through `getRun` or as `run.ask` events. The first valid answer resolves an ask; later answers are rejected.
- **Pinning.** When a run starts, it records:
  - its effective config (global settings merged with the project's), and a hash of it;
  - the Pi Durable version.

  The run then uses that pinned config for its whole life. Settings changes affect only new runs.
- **Storage** is SQLite by default (`storage.kind: sqlite`); `jsonl` is the alternative. Tests use in-memory storage
  or SQLite.

## Operations and events

`FactoryCore` (`src/core/types.ts`) is the core's whole outside surface. It has no transport of its own; the web
server is its transport.

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
- **Discussions:** `startDiscussion`, `getDiscussion`, `listDiscussions`, `getDiscussionConversation`, `say`,
  `stopTurn`, `requestDrafts`, `updateDraft`, `deleteDraft`, `createTicket`, `closeDiscussion`, `reopenDiscussion`,
  `retryDiscussion`. An operation in the wrong state is refused with `conflict`, naming the state.
- **Filters:** `listRuns` and `listDiscussions` take `{ project?, states? }`; `states` must be an array of known
  states, else the call is refused with `invalid`.
- **Settings:** `settingsSchema`, `getSettings`, `setSetting`, `unsetSetting`.
- **Events:** `subscribe(filter, on)`. A filter can select a project, a run or a discussion; a project filter matches
  both run and discussion events. Event types:
  - `run.state`: a state transition.
  - `run.ask`: a question, approval or escalation is pending.
  - `run.askResolved`: carries `by`, who answered (`web` for the web UI).
  - `run.notice`: progress and the final result.
  - `conversation.updated`: a role transcript changed.
  - `run.message`: a message was sent, and again once it was handed to a Conversation.
  - `discussion.state`: a discussion's state transition.
  - `discussion.updated`: a turn started or ended, drafts were submitted (`submission: true`) or edited, a ticket was
    created, or a notice was added.
  - `discussion.conversation.updated`: the discussion's transcript changed.
  - `settings.changed`

`main.ts` gives the web server the handle `Factory.as("web")`, so the answers and messages it sends are attributed to
`web`. The operations it may call are listed in `CORE_OPS` (`src/core/types.ts`).
- The web server (`startWebServer` in `src/web/server.ts`) maps them onto HTTP on localhost: `POST /api/op/<op>` with
  `{ args }`, and `subscribe` as server-sent events at `/api/events` (`?run=`, `?project=`, `?discussion=`).
- It also serves the UI: a board whose columns are pipeline stages, a full-screen run view with the run's
  conversations, a chat box addressed by `message`, and approvals in a card that floats over the transcript, a
  Discussions tab whose discussion view reuses the run view's sheet with a drafts panel, and a Settings form
  generated from `settingsSchema()`. The UI only calls these operations; it has no state of its own
  beyond a cache.

## The process

`factory serve` is the one process that owns the storage and the core (`src/cli.ts`, `src/daemon.ts`).
- By default it spawns `factory serve --foreground` as a detached child, waits until the child's web server listens,
  prints the link and returns. The child's output goes to `factory.log` (mode 0600) next to the config file.
- `--foreground` runs in the current process, for systemd/launchd and development. It writes `factory.pid` once the
  web server listens and removes it on SIGINT or SIGTERM.
- **The factory never runs without its web UI.** `serve` exits 1 with a one-line reason if the web port is taken, a
  live pid file names a running factory, the config can't be loaded, or the config still has a `stages` or `workers`
  section or a `roles.<role>.extensions` key (also under `projects.<name>`). The port is checked before any run resumes. Unknown options are refused.
- A pid file that names no running factory (a dead process, or a reused pid) is removed.
- `stop` sends SIGTERM and waits for the process to exit; `status` prints the pid and the link; `web` prints the
  link from `web-url`; `doctor` checks the config, models, sandbox, GitHub identity and `gh`.

## Security boundaries

- **Agents never hold the GitHub credentials.** The core and `GitHub` push, open PRs and merge. Agents only work in
  the worktree.
- **Every agent command runs inside `@anthropic-ai/sandbox-runtime`.**
  - Each role has its own write rules. The builder and its helpers can write the worktree and scratch dir; the
    architect, reviewer and discussant are read-only (they can write only their scratch dir). The QA agent runs in a boat.dev VM (created with `noEnv`), not here.
  - `denyRead` hides secret paths.
  - Network access goes through an allowlist.
  - Commands start from an empty environment, so no credential env vars reach them.
- See DEVIATIONS.md §7 for the Ubuntu ≥ 24.04 Unix-socket relaxation.
- **The web UI is local and token-protected.** It binds to `127.0.0.1`, rejects foreign `Host` headers (DNS
  rebinding) and foreign `Origin`s, requires `application/json` on operations, and needs the access token from
  `web-token` next to the config file (mode 0600). The link's token becomes an HttpOnly, SameSite=Strict cookie.
  A strict CSP allows only same-origin scripts.
- **`web_search` runs outside the sandbox, in the factory process.** Its API key stays there. Query text does
  leave the machine, so the tool's section tells agents not to put secrets or private code in queries.
