# Interrupting agents, live cost and tool-call timing

Spec of an incremental change to the software factory (`docs/spec.md`). The builder adds what follows to the product
spec: §4 (the prompt note), §5 (ops, view fields and events), §8 (the durable pause) and §9 (the UI). It also adds a
pointer to this file in `AGENTS.md`.

The change has three parts:

1. The human can **stop a single running tool call** of any agent, and can **interrupt the agent the run or bundle
   is with**. An interrupted agent pauses until the human's next message, and nothing fails.
2. **Cost updates live**, on the board cards, in the run, bundle and Chat views, and in the cost tables, while agents
   work. Today it only changes when a turn ends.
3. **Every tool call shows how long it took.** A running call shows a clock that keeps counting.

## 1. Background (pi-durable 1.1.0, as used today)

- Each tool call of a Conversation's current round is its own task: `pi.live.tools[]` has
  `{ callId, name, taskId?, status: pending|running|done }`. `harness.getTask(taskId)` gives `startedAt`, and later
  `endedAt`, in wall-clock ms.
  - `harness.abortTask(taskId)` on a tool task settles it with the result `Tool <name> was aborted` (`isError`). The
    generation then carries on with that result. Tasks the call owns are aborted too: a `subagent` call's helper
    Conversation stops.
- A `pi.tool-result` message carries `durationMs`, the execution time of its last attempt, and `timestamp`.
- `Conversation.abort()` aborts the current generation and its tools. The input settles `unanswered`, reason
  `aborted`.
  - Today, in a run or bundle, `runAgent` treats that as "finished without calling <bridge tool>", and the owner goes
    to `FAILED`.
  - Discussions already use `Conversation.abort()` for **Stop**. That stays as it is.
- `pi.usage` of a Conversation grows each time a model response completes, and each time a tool result with usage
  lands. The helpers' spend reaches the builder's `tools` bucket only when their `subagent` call returns.
- Cost records (`CostRecord`, `turnCosts`) are still written only at the end of a turn (`usage.ts`). That does not
  change.

## 2. Stopping one tool call

**Operation:** `stopToolCall({ run? | bundle? | discussion?, conversationId, callId })`. It is in `CORE_OPS`, served
as `POST /api/op/stopToolCall`.

- **Owner:** exactly one of `run`, `bundle` or `discussion` is given; otherwise `invalid`.
- **Conversation:** it must belong to that owner. This includes helpers (found as `getConversation` finds them) and QA
  agents. Otherwise `not_found`.
- **Call:**
  - It must be in the Conversation's current `pi.live.tools` round with status `running` or `pending`. Otherwise
    `conflict` ("tool call <id> is not running").
  - Bridge tools (`ask_human`, `submit_spec`, `report_done`, `submit_review`, `submit_qa`, `submit_tickets`) can't be
    stopped: `conflict`.
- **Effect:**
  - `harness.abortTask(slot.taskId)`. A `pending` slot with no task yet is aborted once its task exists, or receives
    pi's `aborted` result when the round is aborted.
  - The agent receives pi's `Tool <name> was aborted` result and keeps working. The owner's state, rounds and pending
    asks do not change.
  - The stop is logged as `<owner>: <by> stopped <name> (<callId>) in conversation <id>`.
- **Prompt:** every role's prompt (`prompts.ts`) gains one line. It says that a result `Tool <name> was aborted` means
  the human stopped that call, so the agent should not rerun it unchanged. It should adapt, or explain in its next
  message.

## 3. Interrupting the agent the run or bundle is with

**Operations:** `interruptAgent(run)` and `interruptBundleAgent(bundle)`, both in `CORE_OPS`.

### Target

- **Which agent:** the agent the chat box targets, from `messageTarget` for runs and from the bundle's rule for
  bundles (the reviewer while `REVIEWING`, otherwise the integrator).
- **Refusals:**
  - The target's role is not in `policy.messages`: `conflict`. A resumed agent can only continue through a message.
  - The target's Conversation is not working (`busy` false): `conflict` ("<role> is not working").
  - The owner is terminal: `conflict`.
  - The QA agent and helpers are never targets. Only their individual tool calls can be stopped (§2).

### When the core is driving the target

This means the core is waiting for the target's bridge tool:

- a run in `DISCUSSING`, `BUILDING` or `REVIEWING`;
- a bundle in `INTEGRATING` (conflict resolution), `FIXING` or `REVIEWING`.

What happens:

- **Pause first, then abort:** one commit sets `interrupted: { role, conversationId, key, at, by }` on the
  RunDoc or BundleDoc (`key` is the driving key), then the core calls `Conversation.abort()`. Running tools get
  `aborted` results; any partial response stays in the transcript, marked aborted.
- **The turn does not fail:** `runAgent` sees its input settle `unanswered` / `aborted` while `interrupted` is set for
  that Conversation. It does not fail the owner, and it does not consume a nudge. It waits durably for the human,
  watching the Document as `awaitResponseOr` does.
- **The state does not move:** the owner stays in its state, e.g. `BUILDING`. A `kill -9` while paused resumes paused.
- **Resuming:** the next `message` / `messageBundle` to that agent is submitted at once as the turn's next input, not
  as a steer.
  - It goes in with request id `<key>:resume<n>`, carrying the usual header and situation note.
  - The same commit clears `interrupted`.
  - The turn then continues as before: the agent must still end with its bridge tool, and the existing nudges apply
    if it stops without one.
- **Repeats:** an agent can be interrupted again any number of times.
- **Race with the bridge tool:** the agent may call its bridge tool before the abort lands. The core then takes the
  result as usual and clears `interrupted`.
- **Cancel still works:** `cancelRun` and `cancelBundle` work while paused.

### When the target is not core-driven

Examples: a builder replying to a message in `READY`, or the architect replying at the spec gate.

- The interrupt only aborts that reply. No pause is recorded, because nothing waits for it.

### What the interrupt records and shows

- **Notice:** a notice "<Role> interrupted by you; send a message to continue" (`run.notice` / `bundle.notice`).
- **View field:** `interrupted` is exposed on `RunView` and `BundleView`.
- **Your turn:** an owner with `interrupted` counts as "Your turn" on the board.

## 4. Live cost

### What counts

- **Definition:** an owner's live cost is the usage of its Conversations that no cost record contains yet.
- **The formula:** for each Conversation the owner is working with, the current `pi.usage` sum minus what the
  Document already accounts for that Conversation. Running helpers count through their own `pi.usage`, until their
  `subagent` result lands in the builder's `tools` bucket.
- **No double counting:** when a turn ends and its cost record is written, the recorded total rises by exactly what
  the live part was, and the live part drops to zero. Recorded plus live never counts the same tokens twice.
- **What "live" means:** it moves per completed model response and per tool result with usage, not per streamed
  token.

### Views

- `RunView` and `BundleView` gain `liveCost: { usd, totalTokens, byRole: { role, conversationId, usd, totalTokens }[] }`.
- `DiscussionView` gains `liveCost: { usd, totalTokens }`, the running turn's unrecorded usage. Its `cost` stays the
  recorded total.

### Event

`cost.updated { project, run? | bundle? | discussion?, usd, totalTokens }` carries the owner's **total** (recorded
plus live).

- **When:** it is emitted when an owner's Conversation changes, which is the same hook as `conversation.updated`, and
  the total changed.
- **Throttle:** at most once per 2 s per owner.
- **Filters:** it follows the existing event filters (project, run, bundle, discussion).

### UI

- **Board cards:** run and bundle cards show recorded plus live.
- **Headers:** the run, bundle and Chat headers (`#rv-cost`) and the discussion KPI show the same total.
- **Cost by role:** the table shows the live part as an "in progress" row for the working role. The total includes it.
- **Updates:** all of these update from `cost.updated` without reloading the view.

## 5. Tool-call timing

### In the transcript

`TranscriptView` (from `getConversation`, `getBundleConversation` and `getDiscussionConversation`) gains:

- `toolResult.durationMs`, taken from the result message when present;
- `running: { callId, status: "pending" | "running", startedAt? }[]`, from `pi.live.tools`, with `startedAt` from the
  tool task's record;
- `now`, the server's clock, so the UI can correct for clock skew.

### In the UI

Runs, bundles, discussions and helpers all render tool rows the same way:

- **A finished row** shows its duration next to its status (e.g. `850 ms`, `12.4 s`, `3m 05s`).
- **A running row** shows the elapsed time, counting up every second on the client, plus a **Stop** button
  (`stopToolCall`).
- **Pending rows and bridge tools** have no Stop. A pending row reads "queued".
- **A stopped or aborted row** reads "stopped after <duration>".
- **The live line** under the chat box reads e.g. "Builder is running bash · 0:42".

## 6. The interrupt in the UI

- **The Interrupt button:** in the run and bundle views, the chat box shows **Interrupt** next to Send while its
  target is working and is interruptible (§3).
- **While paused:** the chat box shows "<Role> is paused. Send a message to continue", and a **Continue** quick
  action that sends the message "Continue." through the ordinary `message` / `messageBundle`.
- **Your next message** resumes the agent right away. It is not shown as "queued until the current step".
- **Discussions** keep **Stop** (which ends the turn) and gain the per-tool **Stop** of §5.
- **Errors:** a refused call shows the error toast and changes nothing.

## 7. What does not change

- A message still never moves a run or bundle.
- Cost is still never capped.
- Cost records and `turnCosts` are written as before.
- Discussion Stop semantics are unchanged.
- Tests use the scripted agents and the fake GitHub. Scripted agents need a way to run a slow tool, so that a running
  call can be stopped or interrupted in tests and in the dry run.

## Acceptance behaviours

1. While the builder runs a long `bash` command, its row in the run view shows a running clock that increases each
   second, and a Stop button. Clicking Stop ends the call: the row shows "stopped after Ns". The builder keeps
   working, and the run stays in `BUILDING`.
2. A finished tool row in any transcript (run, bundle, discussion, helper) shows how long the call took.
3. Calling `stopToolCall` on a call that has already finished returns 409 `conflict`. Calling it on `report_done` or
   `ask_human` also returns 409. Calling it with a Conversation of another run returns 404.
4. Clicking Interrupt while the builder is working in `BUILDING` stops its generation and tools. The run stays
   `BUILDING`, the card shows "Your turn", a notice says the builder is paused, and nothing fails. Sending a message
   resumes the same builder Conversation with that message. The builder later calls `report_done` and the run moves to
   `REVIEWING`.
5. Restarting the factory (`kill -9`, then serve) while an agent is paused keeps it paused. A message afterwards
   resumes it.
6. `interruptAgent` on a run whose agent is idle returns 409. On a run whose target role is not in `policy.messages`
   it also returns 409. A paused run can still be cancelled.
7. Interrupting the reviewer of a bundle in `REVIEWING` pauses it. "Continue" resumes it, and it still submits its
   review.
8. While an agent works, the cost on its board card and in the run view header goes up between model responses,
   without a page reload, through `cost.updated`. When the turn ends, the total does not drop and does not jump by the
   same amount twice. The cost-by-role table matches the header.
9. While a builder's helper works, the run's live cost includes the helper's spend. When the `subagent` call returns,
   the total stays consistent.
10. In a Chat discussion, the header cost rises while a reply is being generated. Stop still ends the turn as before.
