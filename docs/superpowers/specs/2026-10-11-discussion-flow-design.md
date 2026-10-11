# Discussions: talk a problem through before it becomes a ticket

Date: 2026-10-11 · Status: approved design, awaiting spec review

> **Amended after the final review** to match the code: reopen resyncs the read-only checkout instead of
> fast-forwarding it, and falls back to a fresh checkout (§1.4, §4); `createTicket` works in any state except while
> a `draft` turn runs (§2.1); a redraft is told about earlier drafts (§2.2); the next turn after a changed checkout
> carries a factory note (§1.4); the discussant's environment is disposed when the discussion leaves `OPEN` (§1.4);
> `drafts` events mark new submissions, and `states` filters are checked (§2.1). See DEVIATIONS.md 45–51.

## Intent

Some problems are too unclear to write as a ticket. Today the only conversation the factory offers is the architect's
discussion inside a run (`DISCUSSING`). It starts from a request that is already written, covers architecture only, and
always ends in one spec for one run.

A **discussion** is a free-form chat with one model about one project. It happens before any ticket exists. The model
can read the project's repo, run commands in the sandbox and search the web, so it can check ideas against the code.
When the problem is clear, the model drafts one or more tickets. You edit them and turn each one into a run. Each run
carries the discussion's summary, and its architect still runs its own discussion, which should be shorter because the
summary says what is already settled.

Success means:
- From the web UI you can:
  - start a discussion on a project;
  - chat with the model while it reads the repo, runs commands and searches the web;
  - ask it for draft tickets and edit them;
  - create runs from them.
- The architect of each run created this way receives the discussion summary and the titles of the other drafts.
- Discussions survive a `kill -9` of the factory, as runs do.
- `npm test` and `npm run typecheck` pass.

Out of scope:
- Several models in one discussion (a panel, critique rounds or a chair). Discussions have one model each.
- Changing a discussion's model after it starts.
- Discussions without a project, or across several projects.
- Write access to the repo, or code changes made in a discussion.
- A budget cap on discussions.
- Skipping the architect's discussion for runs created from a discussion.

## 1. Model

### 1.1 The discussion

A discussion belongs to one project and runs as a pi-durable Task, `createDiscussionTask` in
`src/core/discussion-task.ts`. It sits beside `createRunTask` and uses the same `CoreServices`. Its state is in a
`DiscussionDoc`:

```ts
type DiscussionId = string;                       // "disc-<n>"; never collides with run ids
type DiscussionState = "PREPARING" | "OPEN" | "CLOSED" | "FAILED";

interface DiscussionDocState {
  id: DiscussionId;
  project: string;
  repo: RepoRef;
  title: string;
  state: DiscussionState;
  error?: string;                                 // FAILED only
  model: { model: string; thinking: string };     // pinned at start (§1.3)
  pinned: { config: object };                     // the project's effective settings at start, as a run pins them
  workspace?: Workspace;                          // the read-only checkout (§1.4)
  conversationId?: string;
  turn: { kind: "say" | "draft"; key: string; startedAt: number } | null;   // the turn in progress, if any
  counters: { turnSeq: number; draftSeq: number };
  summary?: string;                               // from the latest submit_tickets
  drafts: Draft[];
  notices: { at: number; kind: "error" | "stopped" | "no_submission"; text: string }[];
  createdAt: number; updatedAt: number;
}

interface Draft {
  id: string;                                     // "D<n>"
  title: string;
  body: string;                                   // markdown; becomes the run's request body
  edited: boolean;                                // changed by the human since the model wrote it
  runId?: RunId;                                  // set once the draft became a run; the draft is then read-only
}
```

**States:**

| State | What happens | Exits |
|---|---|---|
| `PREPARING` | Open the workspace (§1.4), provision the `discussant` environment, and create and configure the Conversation if there is none yet (reopen and retry keep the existing one) | ok → `OPEN` · error → `FAILED` with the reason |
| `OPEN` | Turns (§1.2) | `closeDiscussion` → `CLOSED` |
| `CLOSED` | Read-only; drafts can still become runs | `reopenDiscussion` → `PREPARING` (resyncs the checkout to the default branch, keeps the Conversation) → `OPEN` |
| `FAILED` | Nothing; drafts can still become runs | `retryDiscussion` → `PREPARING` |

A discussion never appears on the run board, and runs never depend on it after they are created (§2.3).

### 1.2 Turns

Each discussion has exactly one Conversation, configured with the pinned model (§1.3) and the `discussant` role
(§1.5). The transcript shown in the UI is that Conversation.

**Rules for turns:**
- **One at a time.** `say` and `requestDrafts` are refused while `turn` is set.
- **How a turn starts:** the core submits the input to the Conversation, sets `turn`, waits for the Conversation to go
  idle, then clears `turn`. The submission is idempotent by its key, `<id>:turn<turnSeq>`, as in `runAgent`.
- **A `say` turn** submits the human's text as is. It ends when the model stops; the reply is the model's last
  assistant message, and nothing passes through the bridge.
- **A `draft` turn** submits drafting instructions (§2.2) plus any instructions from the human. It ends when
  `submit_tickets` is recorded. If the model stops without submitting, the core reminds it up to 2 times
  (`MAX_NUDGES`, as for the roles). After the second reminder it gives up: a notice is added and the existing drafts
  and summary stay unchanged.
- **Stop:** `stopTurn` calls `conversation.abort(context)`, which withdraws queued input and aborts the current work.
  It then clears `turn` and adds a `stopped` notice. A stopped turn is never resumed. Stopping a `draft` turn leaves the
  drafts and summary unchanged.
- **Model errors** (auth, rate limit, unknown model, provider failure) end the turn with an `error` notice that carries
  the provider's message. The discussion stays `OPEN`.

The first message comes with `startDiscussion`. After `PREPARING`, the core submits a first input made of the project
context (§1.5), followed by the human's first message.

### 1.3 Model setting

A new setting is added to the layered settings schema in `src/core/settings.ts`:

```yaml
discussion:
  model: { model: anthropic/…, thinking: high }   # unset → the architect's effective model and thinking
```

- `discussion.model.model` and `discussion.model.thinking` behave like `roles.<role>.*`:
  - the same validation (a model the factory knows, a valid thinking level);
  - source attribution;
  - project overrides.
- If either is unset at every layer, the effective value is the architect's. This follows the
  `roles.helper` → builder rule, implemented in the same function.
- `startDiscussion` takes an optional `model: {model, thinking}`. The web UI prefills it from the project's effective
  `discussion.model`. The value is validated, then pinned in `DiscussionDoc.model` and never changed.

### 1.4 Workspace and sandbox

- **Opening the workspace:** `PREPARING` calls `GitHub.open` on the project's repo binding, as a run's `PREPARING`
  does, with `{ runId: <discussion id>, config: pinned }` as the `RunCtx`. The checkout lives under
  `<workdir>/discussions/<id>/`.
  - **Existing repo:** a worktree of the default branch.
  - **No repo yet:** an empty local workspace, `newRepo: true`.
- **Reopening:** `reopenDiscussion` (and `retryDiscussion`) resyncs the worktree to the latest default branch
  (`GitHub.refresh`). The checkout is read-only, so it is reset to `origin/<default>` and cleaned rather than merged:
  a force-pushed default branch or stray local changes don't matter. A missing checkout, manifest or clone (or a
  worktree git can't reset) is made again with `GitHub.open`; so is a new-repo workspace whose repo now exists. Only
  a git failure, such as a remote that is gone, sends the discussion to `FAILED` with git's message; Retry tries again.
  `GitHub.open` ignores a manifest whose repo isn't the one asked for (a reused id) and makes the checkout again.
- **Telling the model:** when a reopen or retry changed the checkout (another head, or the repo now exists), the next
  turn's input carries a short factory note saying so ("The repo checkout was updated to <sha>…", "The repo <repo>
  now exists…"): in a `say` turn in the message header after the sender, in a `draft` turn as a `# Factory note`
  section at the end of the drafting input.
- **Disposal:** when the discussion leaves `OPEN` (closed or failed), the discussant's environment is disposed, as a
  run's are when it ends; a reopen or retry provisions it again.
- **Sandbox:** `Sandbox.provision(ws, "discussant", rc)` gives the role the same environment as the architect:
  - the worktree is readable but not writable;
  - the scratch folder (`home`, `tmp`, caches) is writable;
  - the network policy is the one the run would get.
- **Setup scripts** (`sandbox.setupScripts`) do not run for discussions. They prepare a build, and discussions don't
  build.
- `EnvDoc` and `RunConfigDoc` on the Conversation are filled as for a role conversation, with `runId` set to the
  discussion id, so the Harness env function and `web_search` work unchanged.

### 1.5 The `discussant` role

- `Role` gains `"discussant"`. Every `Record<Role, …>` is updated accordingly:
  - `ROLE_TOOLS` in `src/agents/tools.ts`: `[RoleDiscussant, CodingReadonly, WebSearch]`;
  - `ROLE_TOOLS` in `src/core/bridge.ts`: `["submit_tickets"]`;
  - prompts;
  - `bridgeToolsNotFor`.
- Write tools are removed from the role, as for every role but the builder.
- `policy.messages` cannot list `discussant`. It has nothing to do with runs: the human talks to it through `say`.
- **`RoleDiscussant` prompt section** (`src/agents/prompts.ts`):
  - You are helping a human think through a problem that is not yet well defined, before it becomes a ticket for the
    software factory. It may be a product question as well as a technical one.
  - Ground what you say in the repo: read the code and run commands to check claims. Search the web for outside facts.
    Say which claims you checked and which are guesses.
  - Ask questions when the problem is unclear. Push back on ideas that don't hold up.
  - You cannot change the repo. Don't write the solution, only what is needed to show an idea, in your scratch folder.
  - When asked for drafts, call `submit_tickets` (§2.2).
- **First input**, the data the core hands over (same shape as `architectFirstInput`):

  ```
  # Discussion
  Title: <title>
  # Project
  Project: <project>; repo binding: <repo> (<the repo does not exist yet | existing repo>).
  Workspace (read-only for you): <path>[; read AGENTS.md and docs/spec.md first if present].
  # The human's first message
  <text>
  ```

## 2. Core operations, bridge and handoff

### 2.1 Operations and events

These are added to `FactoryCore` and `CORE_OPS` in `src/core/types.ts`, so the web server exposes them with no
change of its own.

```ts
startDiscussion(project: string, d: { title: string; message: string; model?: { model: string; thinking: string } }): Promise<DiscussionId>;
getDiscussion(id: DiscussionId): Promise<DiscussionView>;
listDiscussions(filter?: { project?: string; states?: DiscussionState[] }): Promise<DiscussionView[]>;
getDiscussionConversation(id: DiscussionId): Promise<TranscriptView>;
say(id: DiscussionId, text: string): Promise<void>;
stopTurn(id: DiscussionId): Promise<void>;
requestDrafts(id: DiscussionId, instructions?: string): Promise<void>;
updateDraft(id: DiscussionId, draft: string, change: { title?: string; body?: string }): Promise<void>;
deleteDraft(id: DiscussionId, draft: string): Promise<void>;
createTicket(id: DiscussionId, draft: string): Promise<RunId>;
closeDiscussion(id: DiscussionId): Promise<void>;
reopenDiscussion(id: DiscussionId): Promise<void>;
retryDiscussion(id: DiscussionId): Promise<void>;
```

- **`DiscussionView`:** the `DiscussionDocState` fields the UI needs, plus:
  - `cost: UsageSum` from the Conversation's `pi.usage`, summed with `sumUsage`;
  - `turnCosts`: the cost of each finished turn, computed like `addCost` for runs;
  - `runs: { id, state }[]` for the drafts that became runs.
- **`startDiscussion`:** the project must exist. The web UI creates a new project first with `createProject`, as
  Create does.
- **Refusals:** an operation in the wrong state is refused with `conflict` and a message that names the state, as run
  operations are:

  | Operation | Allowed when |
  |---|---|
  | `say`, `requestDrafts` | `OPEN` and no turn running |
  | `stopTurn` | a turn running |
  | `updateDraft`, `deleteDraft` | the draft has no `runId` and no `draft` turn is running |
  | `createTicket` | any state; the draft has no `runId` and no `draft` turn is running |
  | `closeDiscussion` | `OPEN` with no turn running |
  | `reopenDiscussion` | `CLOSED` |
  | `retryDiscussion` | `FAILED` |

- **Input checks:** empty text, title or body is refused with `invalid`, and an unknown id with `not_found`. A
  `states` filter (`listDiscussions`, and `listRuns`) must be an array of known states, else `invalid`.

**Events**, added to `FactoryEvent`:

```ts
| { type: "discussion.state"; discussion: DiscussionId; project: string; from: DiscussionState | null; to: DiscussionState }
| { type: "discussion.updated"; discussion: DiscussionId; project: string;
    what: "turn.started" | "turn.ended" | "drafts" | "ticket" | "notice"; submission?: true }
| { type: "discussion.conversation.updated"; discussion: DiscussionId; conversationId: string }
```

- `what: "drafts"` is emitted for a new submission (with `submission: true`) and for a human's edit or delete
  (without it), so interfaces refresh on both but announce only new drafts.
- `subscribe`'s filter gains `discussion?: DiscussionId`. A `project` filter matches both run and discussion events.
- The web server's event stream needs no change.

### 2.2 `submit_tickets` (bridge)

`BridgeTool` gains `submit_tickets`, which is available only to `discussant` and only while a `draft` turn expects it.

**Parameters**

```ts
{
  summary: string;   // what the discussion established: the problem, decisions (marked as settled), rejected
                     // options and why, open questions, risks; markdown
  tickets: { title: string; body: string }[];   // 1–20
}
```

**Checks**
- The summary must not be empty.
- There must be 1–20 tickets, each with a title (at most 200 characters) and a non-empty body.
- On failure, the problems go back to the model as a tool error, as `submit_review` does, and the turn continues.

**Drafting instructions** that the core submits at the start of a `draft` turn:
- Write one ticket per piece of work that can be specified, built and reviewed on its own.
- Each body is a self-contained request for the factory's architect: the goal, the constraints, what is in and out of
  scope, and acceptance criteria. Refer to other tickets by title where they depend on each other.
- The summary separates what is settled from what is still open.
- On a redraft, the drafts so far: those that already became tickets (title and run id, "do not re-submit these";
  refer to them by title where a new ticket depends on them), then the current drafts' titles and bodies, marking
  the ones the human edited, to build on (the submission replaces them).
- Then come the human's instructions, if any.

**What the core does with it**
- On a valid submission it sets `summary`.
- It removes every draft without a `runId`, then appends the new drafts with fresh ids (`D<draftSeq>`,
  `edited: false`).
- It emits `discussion.updated {what: "drafts"}`.
- Drafts that already became runs are kept.

### 2.3 Handoff to runs

`createTicket(id, draftId)` creates the run and records the draft's `runId` in one `root.commit`. That commit writes
the `RunIndex` entry, the `RunDoc` seed, the run Task and the draft's `runId`. To do this, the seed and the commit body
of `startRun` (`src/core/core.ts`) move into a private helper that both operations call. A crash can therefore never
leave a run without its draft link, or a draft link without its run. The request is:

```ts
{
  source: "discussion",
  title: draft.title,
  body: draft.body,
  meta: {
    discussion: {
      id, title: <discussion title>, draftId,
      summary: <DiscussionDoc.summary>,                       // copied: the run never reads the discussion again
      siblings: <titles of the other drafts from the same submission>,
    },
  },
}
```

When `request.meta.discussion` is present, `architectFirstInput` adds a section before its last line:

```
# Prior discussion
The human discussed this with a model before writing the ticket ("<discussion title>"). Its summary:
<summary>
Other tickets drafted from the same discussion (out of scope here unless this ticket depends on them):
- <sibling title> …
Treat points the summary marks as settled as settled; ask only about what is still open.
```

The architect's discussion otherwise runs unchanged: it still asks with `ask_human` and still calls `submit_spec`.
`RunView.request.meta` carries the link back to the discussion for the UI.

## 3. Web UI (`src/web/ui/`)

**Navigation**
- The top bar gets a **Discussions** tab between Board and Settings (`data-view="discussions"`). The Board stays
  runs-only.

**Discussions list**
- **Filters:** it uses the same project filter as the board, and **Show closed** shows `CLOSED` discussions as well.
  `FAILED` discussions are always shown.
- **Rows:**
  - title, project, model and state;
  - when it was last active;
  - the number of drafts;
  - a state chip for each run it produced.
- **New discussion** opens a modal with:
  - the project (existing or new, like Create);
  - the title;
  - the model and thinking level, prefilled from the project's effective `discussion.model`, using the same text and
    enum fields as the Settings form for `roles.<role>.*` (the core validates the model at start);
  - the first message.

**Discussion view**
- **What it reuses:** it's the same full-screen shell as the run view. The transcript rendering, the expandable tool
  rows, streaming, the composer and the cost display are reused.
- **What it drops:** the pipeline progress strip and the timeline. The left rail has a single conversation, so it's
  hidden.
- **Header:**
  - title, project, model and the total cost;
  - **Close**/**Reopen**, and **Retry** when `FAILED`.
  - Each finished turn shows its cost in the transcript margin.
- **Composer:**
  - it sends with `say`, and its button becomes **Stop** while a turn runs;
  - it is disabled when the discussion isn't `OPEN`;
  - notices (errors, stops, drafting without a submission) appear inline as factory rows, the same style the run view
    already uses for factory items.
- **Drafts panel:** it uses the run view's details slot on the right, which becomes a drawer on narrow screens.
  - **Draft tickets** has an optional field for instructions and runs `requestDrafts`. If drafts that haven't become
    tickets already exist, it asks first ("This replaces N drafts").
  - The summary appears at the top, rendered as markdown.
  - Under it, each draft is a card with:
    - an editable title and body (a textarea that shows rendered markdown when not focused);
    - **Delete** and **Create ticket**.
  - Edits are saved with `updateDraft` when a field loses focus.
  - A draft that became a run shows a link to the run view and the run's live state chip in place of its controls.
  - While a `draft` turn runs, the panel shows that drafting is in progress, and the cards can't be edited.

**Elsewhere**
- **Run view:** the ticket details of a run with `request.meta.discussion` show "From discussion: <title>", which opens
  the discussion.
- **Board cards:** these runs show a small discussion marker.
- **Settings:** the schema-driven form shows `discussion.model` with no UI change.
- **URLs:** the view has its own hash route, like a run's, so a discussion can be linked to and survives a reload.

## 4. Durability and errors

**Durability**
- **The discussion Task:** it is pi-durable. After a `kill -9`, the factory resumes it:
  - a pending `PREPARING` runs again (opening the worktree is idempotent);
  - a turn in progress resumes waiting on its Conversation, which pi-durable resumes;
  - a `draft` turn whose `submit_tickets` was already recorded applies it once.
- **Stop:** a stopped turn has no `turn` set and isn't resumed.
- **`createTicket`:** it is atomic (§2.3). After a crash the draft either has a `runId` and its run exists, or it has
  neither, and `createTicket` can be called again.
- **Factory startup:** `harness.resume()` resumes discussion Tasks along with run Tasks. The core's document watch
  rebuilds its cache of discussions the way it does for runs, and maps their `factory.env` conversations to the
  discussion.

**Errors**

| Case | Result |
|---|---|
| Opening the repo or provisioning the sandbox fails | `FAILED` with the reason; Retry |
| Updating the checkout on reopen or retry fails (git fails, e.g. the remote is gone; a missing or diverged checkout is made again instead) | `FAILED` with git's message; Retry |
| Provider error during a turn | `error` notice with the provider message; stays `OPEN` |
| No `submit_tickets` after 2 reminders | notice; drafts and summary unchanged |
| Invalid `submit_tickets` payload | problems returned to the model; the turn continues |
| Pinned model unknown at start (e.g. provider package removed) | `startDiscussion` refused with `invalid` |
| Pinned model unknown later | each turn ends with an `error` notice; start a new discussion |

## 5. Code changes

| File | Change |
|---|---|
| `src/core/types.ts` | `Role` + `discussant`; `DiscussionId`, `DiscussionState`, `DiscussionView`, `Draft`; new ops in `FactoryCore` and `CORE_OPS`; new events; `subscribe` filter |
| `src/core/discussion-doc.ts` (new) | `DiscussionDoc` |
| `src/core/discussion-task.ts` (new) | the Task: states, turns, nudges, stop, applying `submit_tickets` |
| `src/core/core.ts` | the operations; a discussion cache and index beside runs; `startRun`'s seed and commit moved into a helper shared with `createTicket` |
| `src/core/run-task.ts` | `architectFirstInput` adds `# Prior discussion` |
| `src/core/bridge.ts` | `submit_tickets` and its checks; `ROLE_TOOLS.discussant` |
| `src/core/findings.ts` | `validateTickets` beside the other validators |
| `src/core/settings.ts` | `discussion.model` and its fallback to the architect; `policy.messages` refuses `discussant` |
| `src/agents/tools.ts`, `src/agents/prompts.ts` | `discussant` tool set; `RoleDiscussant` |
| `src/sandbox/sandbox.ts`, `src/github/github.ts` | accept the `discussant` role and the `discussions/` layout; no setup scripts for it |
| `src/web/ui/*` | Discussions tab, list, modal, discussion view, drafts panel, run-view link, card marker |
| `src/testing/scripted.ts`, `src/testing/dry-run-agents.ts` | a scripted `discussant` |
| `scripts/dry-run.ts` | a discussion step before the first §8 ticket (below) |

## 6. Testing

All tests use the scripted provider and need no credentials.

**`test/discussion.test.ts` (new)**
- **Life cycle:**
  - start → `OPEN`, with the first input containing the project context and the first message;
  - close → reopen, where the worktree is updated to a new commit on the fake remote, also after a force-push and
    after the checkout was deleted;
  - a `FAILED` start, then retry.
- **Turns:**
  - `say` gets a reply;
  - `say` during a turn is refused;
  - Stop aborts a long turn and adds a notice;
  - a provider error adds a notice and leaves the discussion `OPEN`.
- **Sandbox:** the discussant can read the repo and run a command in it. Writing to the worktree fails, and writing to
  its scratch folder succeeds.
- **Drafting:**
  - a valid `submit_tickets`;
  - an invalid payload, then a valid one;
  - no submission after 2 reminders (drafts unchanged);
  - a redraft replaces only drafts that haven't become runs;
  - edits and deletes, and their refusals.
- **Handoff:**
  - `createTicket` starts a run with the request meta;
  - the architect's first input contains `# Prior discussion`, the summary and the sibling titles;
  - a second `createTicket` on the draft is refused;
  - `createTicket` on a `CLOSED` or `FAILED` discussion works.
- **Settings:** `discussion.model` falls back to the architect's model, a project override is respected, and an
  unknown model is refused at start.

**Other suites**
- **`test/durability.test.ts`:**
  - `kill -9` mid-turn, then resume and finish the turn;
  - `kill -9` after `submit_tickets` is recorded but before it's applied;
  - `kill -9` right after `createTicket` commits, then restart: exactly one run, linked to the draft, and it proceeds.
- **`test/web.test.ts`:** the new operations over HTTP, their error codes, and the `discussion` subscribe filter.
- **`test/settings.test.ts`:**
  - `discussion.model` in the schema, layering and source attribution;
  - `policy.messages: [discussant]` is refused.

**Dry run** (`scripts/dry-run.ts`)
- Before the first §8 ticket:
  - start a discussion on the project;
  - exchange two messages;
  - request drafts;
  - edit one draft;
  - create the ticket from it.
- That run then continues as the first §8 ticket did. The report checks that the architect's first input carried the
  summary.

## 7. Docs

- **`README.md`:** the Discussions tab in "Web UI"; the new files in "Layout"; the test count and the new suite in
  "Tests".
- **`docs/architecture.md`:** the discussion Task beside the run Task; the `discussant` role; the handoff.
- **`docs/configuration.md`:** `discussion.model`.
- **`DEVIATIONS.md`:** design spec §1 says "the discussion covers architecture only". That still holds for the
  architect's discussion in a run. Discussions are a separate, optional step before a ticket and may cover product
  questions.
