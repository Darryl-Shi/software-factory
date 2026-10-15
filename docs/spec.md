# Software factory: product spec

This is the product spec of the software factory as it is built now. It says what the product does and the key
technical decisions behind it. It is not an implementation plan. Where the older design documents disagree with it,
the code (`src/`) is the truth. The history of the design is in `docs/design-spec.md`, as amended by
`docs/superpowers/specs/*.md` (fixed architecture cleanup, discussions, setup flow) and by the bundles spec
`docs/specs/run-mv4ghzj2-allm.md`. `DEVIATIONS.md` lists every place the code departs from those.

## 1. What the product is

The factory takes software requests ("tickets") for a project and turns them into merged code on GitHub, mostly
without supervision. The same flow handles a new project (zero to MVP) and a change to an existing repo.

- **One flow:** an optional discussion → a run per ticket (architecture discussion → spec → build → review with AQ
  testing) → **Ready** → a **bundle** of Ready tickets → one PR (or, for a new repo, a push to `main`) → CI → **Merge**.
- **The human is asked only at the ends:** the discussions, the approval gates turned on (by default only the spec
  gate), the Ship and Merge clicks, and escalations. A human may message the agent working on a run or bundle at any
  time; a message never moves the run.
- **The core is model-free and durable.** It is a set of Pi Durable Tasks (runs, discussions, bundles) that never call
  a model. It configures role Conversations, gives them input and reads what they submit through bridge tools.
- **A fixed solution, not a framework.** The web UI is the only interface. GitHub, a local sandbox and boat.dev VMs are
  the backends, called directly. Each role has a fixed tool set. There is no extension layer and no intake: requests
  enter through the web UI.
- **Single user, local.** The web UI listens on localhost behind an access token. Several runs, discussions and
  bundles of one project can be in flight at once.

Out of scope: product or market discovery inside a run (a discussion may cover it), implementation plans or an
upfront work split by the core, multi-tenant hosting, other intakes (issues, webhooks), chat bridges, bundles across
projects, automatic shipping, stacked PRs.

## 2. Concepts

- **Project:** a name, a repo binding (`owner/name`) and settings overrides, stored in the config file under
  `projects.<name>`. The repo may not exist yet; it is created (private by default) when the first bundle ships.
- **Run (ticket):** one request on one project, shown on the board with a key `PROJECT-N`. Id `run-<…>`. It ends in
  `READY` with a reviewed branch `factory/<run-id>` and later becomes `DELIVERED` when its bundle merges.
- **Discussion:** a pre-ticket chat with one model about one project (id `disc-<n>`). It ends in draft tickets that
  the human edits and turns into runs.
- **Bundle:** an ordered set of Ready runs of one project, shipped as one PR (id `bundle-<n>`).
- **Spec of a run:** a markdown document written by the architect, committed at `docs/specs/<run-id>.md`. It is the
  only contract between the stages and ends with acceptance behaviours. Runs that were past `SPEC_READY` before
  bundles keep `docs/spec.md`.
- **Product spec:** `docs/spec.md` in the product repo describes the whole product. The builder updates it to reflect
  its change only when the repo already has one.
- **Repo map:** every workspace has a short `AGENTS.md` (build, test and run commands, a map, a pointer to the specs)
  that every role reads. The builder keeps it current and ships a setup and a run script.

## 3. The pipeline

### 3.1 Discussions (optional, before a ticket)

- `startDiscussion(project, { title?, message, model? })` opens a read-only checkout of the default branch (or an empty
  workspace for a repo that doesn't exist yet) and one `discussant` Conversation. The model defaults to
  `discussion.model`, which defaults to the architect's; it is pinned for the discussion's life. A missing or blank
  title is derived from the first message (first non-empty line, markdown markers stripped, cut to 60 characters on a
  word boundary with `…`); an empty message is `invalid`.
- States: `PREPARING` → `OPEN` → `CLOSED`; an error leads to `FAILED` (Retry). Setup scripts do not run for
  discussions. Leaving `OPEN` (`CLOSED` or `FAILED`) deletes the checkout, its local branch, scratch and environment
  record (§8.1); reopen or retry re-creates the checkout from the latest default branch and provisions a new
  environment.
- Turns, one at a time: `say` (the human's text; the reply is the model's last message) and `requestDrafts` (the model
  must call `submit_tickets` with a summary and draft tickets; reminded up to twice). `stopTurn` aborts a turn.
- Drafts can be edited or deleted until they become runs; `createTicket` turns a draft into a run in any state except
  while a draft turn runs. The run's architect receives the summary and the titles of the sibling drafts. A run never
  depends on its discussion afterwards.
- The discussant reads the repo, runs commands in a read-only sandbox and searches the web; it cannot change the repo,
  and it takes no run messages (`policy.messages` cannot list it).

### 3.2 A run: from request to Ready

| State | What happens | Exits |
|---|---|---|
| `RECEIVED` | `startRun` (or `createTicket`) was called; the project's effective settings are pinned | → `PREPARING` |
| `PREPARING` | Open the repo (worktree on `factory/<run-id>`, or a local workspace when the repo doesn't exist), provision sandbox environments (runs the repo's setup script); with QA on, check that `boat.apiKey` resolves | → `DISCUSSING` · error or no boat key → `FAILED` |
| `DISCUSSING` | The architect asks one question at a time (`ask_human`) grounded in the request and repo, then `submit_spec` | → `SPEC_READY` |
| `SPEC_READY` | Commit the spec at `docs/specs/<run-id>.md` | spec gate on → `AWAITING_APPROVAL(spec)` · off → `BUILDING` |
| `AWAITING_APPROVAL` | Pending approval ask for a gate | spec: approve → `BUILDING`, reject → `DISCUSSING`; a revised `submit_spec` after a message replaces the version and asks again · delivery: approve → `DELIVERING`, reject → `BUILDING` with blocking human findings (no round added) |
| `BUILDING` | Round 1: the builder gets the spec. Later rounds: the same builder Conversation gets the findings | `report_done` → `REVIEWING` · a fix round with no change (and `escalateOnNoProgress`) → `ESCALATED` |
| `REVIEWING` | A fresh reviewer, and in parallel a fresh QA agent when AQ testing applies (§3.3) | pass → delivery gate or `DELIVERING` · fail under `reviewRoundCap` → `BUILDING` · fail at cap → `ESCALATED` |
| `ESCALATED` | Pending ask: accept as is / N more rounds / abort | accept → `DELIVERING` · more rounds → `BUILDING` · abort → `CANCELLED` |
| `DELIVERING` | If the diff differs from the last reviewed fingerprint → `REVIEWING` (no round added). Else commit what the builder left uncommitted and, for an existing repo, push `factory/<run-id>` to `origin`. No PR, no repo creation, no CI | → `READY` · error → `FAILED` |
| `READY` | Waits for a bundle. Not terminal | bundle merged → `DELIVERED` · builder changed the diff after a message → `REVIEWING` → … → `READY` |
| `DELIVERED` / `FAILED` / `CANCELLED` | Terminal. Environments disposed. `DELIVERED` deletes the worktree, manifest, local and remote branch, scratch and environment records; `FAILED` / `CANCELLED` delete only the scratch dirs until the run is cleared, then everything (§8.1). A final notice (`run.notice` with `final`) carries the URL, advisory and accepted findings, the QA status and any "no CI" note | `retryRun` resumes a `FAILED` or `CANCELLED` run from the state it failed in (not a cleared one) · `clearRuns` archives it off the board |

- **The builder** is the only build role the core talks to. It may spawn helpers (`subagent`) that write code in the
  same worktree and environment; the core never sees, splits, locks or merges their work. Helpers finish within the
  builder's turn, spawn no helpers and have no bridge tools. The builder commits, checks the working tree and runs the
  tests before `report_done`, which must answer every blocking finding (`fixed`, or `wontfix` with a reason).
- **Messages in `READY`:** to the builder when the run is in no active bundle; refused (`conflict`) with a pointer to
  the bundle when it is in one. A run in `READY` can be cancelled only when it is in no active bundle.
- **When a bundle merges,** each member goes `READY` → `DELIVERED`: its delivery is the bundle's PR (or push to
  `main`), its notice reads "Merged in bundle-N: <url>", its environments are disposed, and its own Task then deletes
  its worktree, manifest, local and remote `factory/<run-id>`, scratch and environment records (§8.1). Until then a
  `READY` run keeps everything, because the bundle merges its local branch.
- **Intake write-back:** there is no intake in the code. Where the design says `intake.writeBack`, the product's
  equivalent is the run's final notice.

### 3.3 Review rounds (runs and bundles)

- **Reviewer:** a fresh Conversation per round in the local sandbox, read-only. It checks the **whole product** (not
  only the diff) against the spec(s), runs the test suite itself, flags deleted or weakened tests, runs the product
  (with `curl` through `bash`; no browser) to check the acceptance behaviours, and reviews the diff and the code it
  touches for quality and security. From round 2 it also gets the changes since the previous review, its own prior
  findings and the responses to them. With QA on, a launchable product without a working run script is blocking.
- **AQ testing (QA agent):** in parallel with the review, when `qa.enabled` and one of `boat.runScripts` exists at the
  reviewed commit. A fresh boat.dev VM per round (`noEnv`, no secrets, no GitHub access) gets the reviewed commit as a
  git bundle, runs the setup script and starts the run script. The QA agent uses the product like its user, through a
  desktop and browser (`computer`), and backs every finding with screenshots it took that round. The VM is deleted
  when the round ends; a ttl is the backstop, and a startup sweep deletes orphan VMs.
- **QA status per round:** `ran`, `off` (`qa.enabled: false`), `skipped` (no run script) or `unavailable` (boat could
  not provide a VM after 3 tries: the round is the review alone, with a notice; nothing fails or escalates).
- **Verdict:** the core waits for both submissions; the round fails if either has a blocking finding, and the fixer
  gets both sets. The reviewer and QA agent never see each other's findings. A round counts once.
- **Findings:** `{ severity, blocking, specRef?, description, evidence, screenshots?, source }`, `source` one of
  `reviewer`, `qa`, `human`, `ci`. Reviewer and QA findings need evidence; a `fail` needs a blocking finding.
  Advisory findings never fail a round; the final round's advisory findings go into the PR description or delivery
  notes. Screenshots stay in the factory (`<artifacts>/<run>/screenshots/`), never in the repo or on GitHub.
- **Caps:** `reviewRoundCap` for review rounds; a review that follows a CI fix counts toward `ci.fixRounds` instead.

### 3.4 Bundles: from Ready to merged

`createBundle(project, runs)` makes a bundle of Ready runs of one project, in the order given. A run is in at most one
active bundle; a project may have several active bundles. The bundle pins the project's effective settings (CI, QA,
role models, `reviewRoundCap`, `bundle.mergeMethod`), works in `<workdir>/bundles/<bundle-id>` on branch
`factory/<bundle-id>`, and has one integrator Conversation for its whole life.

| State | What happens | Exits |
|---|---|---|
| `INTEGRATING` | Fetch the default branch; create or reset `factory/<bundle-id>` at `origin/<default>` (a new repo: the clone's local `main`); `git merge --no-ff` each member branch in order. On a conflict the conflicted merge is left in the worktree and the integrator gets the ticket, the files and every member's spec; it commits the merge and calls `report_done` | clean with 2 or more members → `REVIEWING` (the combination is reviewed; each ticket was reviewed on its own branch) · clean with one member → `DELIVERING` · integrator resolved anything → `REVIEWING` · error, or a conflict not concluded after 3 attempts → `FAILED` |
| `FIXING` | The integrator gets blocking findings (review, QA, CI or human) | `report_done` → `REVIEWING` |
| `REVIEWING` | As §3.3, on the **whole combined product** against **every member's spec** (and `docs/spec.md` when present), with the combined diff from the integration base. After a clean merge of 2+ tickets the reviewer is told the tickets merged without conflicts, each passed its own review (and QA) on its own branch, and to look especially at how the tickets interact | pass → `DELIVERING` · fail under cap → `FIXING` · fail at cap → `ESCALATED` |
| `DELIVERING` | Unreviewed changes go back to `REVIEWING` first. Existing repo: push `factory/<bundle-id>`, open or update one PR. New repo: create the repo, push the result to `main` with `docs/delivery-notes.md`; the pushed commit becomes the integration base, so CI fixes go by PR against it and Merge does not take the factory's own push for a moved default branch | → `AWAITING_CI` (or straight on with `ci.mode: off`) · error → `FAILED` |
| `AWAITING_CI` | `ci.mode`, `ci.checks`, `ci.noChecksTimeout` on the delivered SHA; also polls the PR | green, or no checks under `if-present` → PR: `AWAITING_MERGE`, new repo: `MERGED` · red under `ci.fixRounds` → `FIXING` · red at cap, or no checks under `required` → `ESCALATED` |
| `AWAITING_MERGE` | Pending ask: Merge / Request changes / Drop tickets; polls the PR | see below |
| `ESCALATED` | Pending ask: more rounds (N) / drop tickets / abort | more rounds → `FIXING` · drop → `INTEGRATING` · abort → `CANCELLED` (PR closed) |
| `MERGED` | Terminal; members → `DELIVERED`; VMs and environments disposed; the bundle's own worktree, manifest, local and remote `factory/<bundle-id>`, scratch and environment records are deleted (§8.1) | — |
| `FAILED` | Terminal until `retryBundle`, which resumes from the failed state. Members stay in the bundle. Only the bundle's scratch dirs are deleted (worktree, branches and environment records stay for the retry) | — |
| `CANCELLED` | Terminal; the PR is closed if open; members go back to plain `READY` with their branches and worktrees untouched; the bundle's own things are deleted as for `MERGED` (also when a `FAILED` bundle is cancelled) | — |

- **Merge** (`mergeBundle`): if the default branch has not moved since the CI-checked integration, the PR is merged
  with `bundle.mergeMethod` → `MERGED`. If it moved, or GitHub refuses the merge, Merge means "merge when green on the
  latest default": the bundle re-integrates from scratch, pushes, waits for CI, and merges by itself when the update
  needed no fix and CI is green. A clean one-ticket update goes straight to CI; a clean update of 2+ tickets is
  reviewed first and still merges by itself if that review passes and no fix follows. If the integrator had to
  change anything, or any fix is needed (review, CI or Request changes), the update comes back to `AWAITING_MERGE`
  for a fresh click.
- **Request changes** (`requestBundleChanges`): one blocking `source: human` finding → `FIXING` → `REVIEWING`; adds no
  review or CI round.
- **Drop tickets** (`dropFromBundle`, at `AWAITING_MERGE` or `ESCALATED`): dropped runs return to plain `READY`; the
  bundle re-integrates the rest from the latest default branch; an open PR is reused and its description rewritten.
  Dropping every member is the same as cancelling.
- **Outside GitHub:** a PR merged by a human is detected → `MERGED`; a PR closed without merging → `CANCELLED`.
- **PR content:** title is the ticket's title for one member, else "<N> tickets: <title 1>, …"; one section per
  ticket (title, run id, spec path, advisory and accepted findings, QA status) and an integration section (conflicts
  resolved or a clean merge, review rounds, advisory findings, QA status, the "no CI" note). A clean bundle of 2+
  tickets reports its bundle review's rounds and QA status; a clean one-ticket bundle says the combined result had no
  review of its own. Screenshots are never uploaded.
- **Bundles in flight at upgrade** (the combined review of clean 2+ bundles,
  `docs/specs/run-mv4vd9xu-g2si.md`): the rule is decided per integration. Each new integration record carries the
  mark `reviewCombination: true`; a record from before the upgrade has none and ends with the old rule (clean →
  `DELIVERING`). A re-integration after a drop or a moved default branch creates a new record and follows the new rule.
- **Messages to a bundle** (`messageBundle`) go to the reviewer while `REVIEWING`, otherwise to the integrator; QA
  takes none; refused on a terminal bundle. A change after a passing review goes through `REVIEWING` before delivery
  or merge.
- **Shipping one ticket** gives the old one-ticket PR.

### 3.5 Legacy runs and the legacy merge gate

- `approvals: merge` still validates but no longer affects new runs: merging is the bundle's Merge (or merging the PR
  on GitHub). The `delivery` gate still works and sits before `READY`. `ci.*` applies to bundles, not runs.
- At startup, runs started before bundles that had already begun delivering (in `DELIVERING`, `AWAITING_CI`,
  `AWAITING_APPROVAL(merge)`, escalated from `AWAITING_CI`, or with a delivery recorded) are marked legacy and finish
  the old way: their own PR (or push to `main`), their own CI wait and fix rounds, and the merge gate (squash merge;
  without the gate the PR is left open). All other older runs take the new flow.

## 4. Roles and fixed tools

None of this is a setting. Each role's `role-<role>` prompt comes first.

| Role | Environment | Tools | Bridge |
|---|---|---|---|
| architect | local sandbox, read-only | `coding-readonly`, `web_search` | `ask_human`, `submit_spec` |
| builder | local sandbox, writes the run worktree | `coding` (read, write, edit, bash), `subagent`, `test-runner`, `web_search` | `report_done` |
| helper | the builder's environment | `coding`, `test-runner`, `web_search` | none |
| reviewer | local sandbox, read-only | `coding-readonly` (incl. `bash`), `test-runner`, `web_search` | `submit_review` |
| qa | boat.dev VM, throwaway copy | read-only file tools, `bash` in the VM, `computer`, `web_search` | `submit_qa` |
| discussant | local sandbox, read-only | `coding-readonly`, `web_search` | `submit_tickets` |
| integrator | write sandbox on the bundle worktree | `coding`, `test-runner`, `web_search` (the builder's write tools, **no `subagent`**) | `report_done` |

- Agents reach humans, GitHub and delivery only through the bridge tools, which commit what the core waits for.
- Every role's prompt (`prompts.ts`, `STOPPED_CALL`) says that a tool result `Tool <name> was aborted` means the human
  stopped that call (§5 `stopToolCall`, or an interrupt): the agent does not rerun it unchanged, it adapts (a shorter
  or different command, another approach) or explains in its next message why it needs it.
- `submit_spec` rejects a spec without an "Acceptance behaviours" heading. Each bridge tool takes one valid submission
  per expected input.
- Models: `roles.<role>.{model, thinking}`. `helper` and `integrator` default to the builder's effective values,
  `discussion.model` to the architect's. The QA model must accept images.

## 5. Core operations and events

The core's whole outside surface is `FactoryCore` (`src/core/types.ts`). Every operation but `subscribe` is in
`CORE_OPS` and served as `POST /api/op/<op>`; errors are `not_found` (404), `invalid` (400), `conflict` and
`not_pending` (409).

- **Projects:** `createProject`, `getProject`, `listProjects`, `deleteProject`.
  - `deleteProject(name)` (spec `docs/specs/run-mv86f7vs-jif2.md`) deletes a project and **purges** its history; it
    returns `{ project, runs, bundles, discussions }`, the purged ids. Checked before anything changes: a name that is
    not a non-empty string is `invalid`, an unknown project `not_found`, and **live work** `conflict`: any run not
    `DELIVERED` / `FAILED` / `CANCELLED` (`READY` counts), any bundle not `MERGED` / `CANCELLED` (`FAILED` counts).
    A discussion is never live work (spec `docs/specs/run-mv89bw5w-pykq.md`). The message names each live item with
    its id and state (`project p has live work: run-x is READY, bundle-2 is FAILED; cancel it first (Cancel, Cancel
    bundle)`); the error carries them as `details.live: { kind, id, state }[]` (sent in the 409 body). Runs and
    bundles are never cancelled for you, and on a refusal nothing changes (an `OPEN` discussion stays `OPEN`).
  - **Open discussions are ended by the deletion.** Once runs and bundles allow it, every discussion of the project in
    `PREPARING` or `OPEN` (a turn running, mid-reply or drafting, included; one still preparing its checkout too) is
    ended without asking: its discussion Task is aborted through the Task's `abort` path (a running turn's
    Conversation work is stopped, as Stop does, so the Task gets there; the abort cleans the checkout, local branch,
    scratch and environment and commits `FAILED`). All are aborted first, then waited for (10 s); one whose Task has
    not ended fails the deletion with `conflict`, its live item `{ kind: "discussion", id, state: "OPEN (still
    finishing)" }` (the discussions already ended stay `FAILED`, retryable). Subscribers may see `discussion.state`
    move to `FAILED` before `project.deleted`; the returned `discussions` include them. A finished owner whose Task is
    still ending is then waited for (10 s), else it counts as live (`CANCELLED (still finishing)`).
  - A per-project in-process lock serialises it with `startRun`, `createTicket`, `startDiscussion`,
    `reopenDiscussion`, `retryDiscussion`, `createBundle`, `setSetting` / `unsetSetting` on that project scope and
    `createProject` with that name: they wait for a deletion in progress and then fail with `not_found`
    (`createProject` makes a fresh project), so an ended discussion can't come back before the purge. A turn op (`say`,
    `requestDrafts`, `stopTurn`) racing with it fails with `conflict` (no longer `OPEN`) or `not_found` (purged), or
    is cut off by the abort. The deletion also waits for any in-flight cleanup of the project's owners. Steps: (1) one
    commit re-checks liveness (runs and bundles), captures what each owner's cleanup needs, retires every Document
    (every discussion, whatever its state) (`tx.retireDoc`), removes the ids from `RunIndex` / `BundleIndex` /
    `DiscussionIndex` and records the deletion in `factory.projectDeletions` (§8.1); (2) the `projects.<name>` block
    leaves the config file; (3) `project.deleted` is emitted; (4) the disk is cleaned in the background.
  - Afterwards `getProject`, `getSettings({ project })`, `getRun`, `getBundle`, `getDiscussion`, their conversations
    and screenshots are `not_found`, and the lists leave the purged items out (`listRuns` with `includeCleared` too).
    The same name can be created again and starts empty (no overrides, ticket keys from `<PREFIX>-1`, no Chat
    history). `bundle-N` and `disc-N` never repeat: the indexes keep a monotonic counter (`seq`), seeded from the
    existing ids on first use.
- **Runs:** `startRun`, `getRun`, `listRuns`, `getConversation`, `cancelRun`, `retryRun`, `answer`, `approve`,
  `reject`, `submitHumanFindings`, `resolveEscalation`, `message`, `interruptAgent`, `getScreenshot`, `clearRuns`,
  `cancelRuns`.
  - `interruptAgent(run)` (spec `docs/specs/run-mv8t6vsz-pmy8.md`) pauses the agent the run is with (its
    `messageTarget`). `conflict` when: the run is terminal; it is in an active bundle (interrupt the bundle's agent
    instead); the target's role is not in `policy.messages` (only a message continues a paused agent); the agent is
    already paused; the target's Conversation is not working ("<role> is not working"); or the run moved on to another
    agent meanwhile. QA agents and helpers are never targets (only their tool calls can be stopped). While the core
    drives the target (`DISCUSSING`, `BUILDING`, `REVIEWING`, the target being the Conversation in `driving`) one
    commit records `interrupted: { role, conversationId, key, at, by }` (`key`: the driving key) and the notice "<Role>
    interrupted by you; send a message to continue"; then the core calls `Conversation.abort()` (running tools get
    `aborted` results; a partial response stays in the transcript, marked aborted). The state does not move and
    nothing fails (the pause, §8). Otherwise (e.g. a builder replying to a message in `READY`, the architect at the
    spec gate) only the reply in progress is aborted, with the same notice and no pause. The call waits at most 10 s for
    the Conversation to go idle.
  - `message` to a paused agent is its resume: it goes in at once as the paused turn's next input (`HumanMessage.resume`
    = `<key>:resume<n>`, §8), not queued until a step boundary; the same commit clears `interrupted`.
- **Tool calls:** `stopToolCall({ run? | bundle? | discussion?, conversationId, callId })` stops one tool call of any
  agent. Exactly one owner, a `conversationId` and a `callId`, else `invalid`. The Conversation must belong to that
  owner (its roles, the builder's helpers, QA agents; the discussant), else `not_found`. The call must be in the
  Conversation's current `pi.live.tools` round as `running` or `pending`, else `conflict` ("tool call <id> is not
  running"); the bridge tools (`ask_human`, `submit_spec`, `report_done`, `submit_review`, `submit_qa`,
  `submit_tickets`) are `conflict` too. The core aborts the call's tool task (`harness.abortTask`; tasks it owns, such
  as a `subagent` call's helper Conversation, stop with it); a `pending` call with no task yet is remembered in memory
  and aborted as soon as its task appears (or gets pi's `aborted` result when the round is aborted). The agent gets
  `Tool <name> was aborted` and keeps working; the owner's state, rounds and pending asks do not change. Logged as
  `<owner> <id>: <by> stopped <name> (<callId>) in conversation <id>`.
  - `cancelRuns(runs, reason?)` cancels several live runs at once (spec `docs/specs/run-mv545v95-rg77.md`), with the
    same effect per run as `cancelRun`. All or nothing, checked before anything changes: an empty list, a non-array or
    an id that is not a non-empty string is `invalid` (duplicates are collapsed), an unknown id `not_found`, a terminal
    run or a run in an active bundle (a `FAILED` bundle included) `conflict`, naming the run and its state or bundle.
    One commit sets `cancelReason` on every run (`reason`, or `cancelled by <interface>`, the interface captured
    before the first await); then each run's task is aborted, and each run reaches `CANCELLED` through the run task's
    own cancellation path (final notice, environments and QA VM disposed, `run.state`). Returns `{ cancelled }`, the
    runs whose tasks were aborted.
  - `clearRuns(runs)` soft-archives terminal runs (spec `docs/specs/run-mv46ek2u-7omz.md`): it sets
    `cleared: { at, by }` on each run's Document in one commit, then starts a full cleanup of each cleared run in the
    background (§8.1; it returns without waiting for the deletion). All or nothing: an empty list is
    `invalid`, an unknown id `not_found`, a non-terminal run `conflict`; already-cleared runs are skipped (idempotent).
    `listRuns` leaves cleared runs out unless `includeCleared: true`; `getRun` still returns them; `retryRun` refuses
    them with `conflict`.
- **Models:** `listModels()` returns the models the model host has credentials for
  (`{ id: "provider/modelId", name?, provider }[]`); read-only, no project.
- **Settings:** `settingsSchema`, `getSettings`, `setSetting`, `unsetSetting`.
- **Discussions:** `startDiscussion`, `getDiscussion`, `listDiscussions`, `getDiscussionConversation`, `say`,
  `stopTurn`, `requestDrafts`, `updateDraft`, `deleteDraft`, `createTicket`, `closeDiscussion`, `reopenDiscussion`,
  `retryDiscussion`.
- **Bundles:** `createBundle` (`invalid` if empty, another project's run or a run not `READY`; `conflict` if a run is
  already in an active bundle), `getBundle`, `listBundles`, `getBundleConversation`, `mergeBundle`,
  `requestBundleChanges`, `dropFromBundle`, `resolveBundleEscalation` (`{ moreRounds }` | `{ drop }` | `{ abort }`),
  `cancelBundle`, `retryBundle`, `messageBundle`, `interruptBundleAgent`, `getBundleScreenshot`.
  - `interruptBundleAgent(bundle)` is `interruptAgent` for the agent the bundle is with (the reviewer while
    `REVIEWING`, else the integrator); `INTEGRATING` (conflict resolution), `FIXING` and `REVIEWING` are core-driven.
    As with `messageBundle`, the integrator always takes messages, so only the reviewer is refused for
    `policy.messages` (when it leaves the reviewer out). Same other refusals; a `messageBundle` to the paused agent
    resumes it.
- **Maintenance:** `gc()` runs the disk sweep now (§8.1) and returns `{ removed, failures, summary }`; while a sweep
  is running it waits for it and returns its result. No web UI button; `factory gc` calls it.
- **Events** (`subscribe` over `GET /api/events`, server-sent): `run.state`, `run.cleared`, `run.ask`, `run.askResolved`,
  `run.notice`, `run.message`, `conversation.updated`, `settings.changed`, `discussion.state`, `discussion.updated`,
  `discussion.conversation.updated`, `bundle.state`, `bundle.ask`, `bundle.askResolved`, `bundle.notice`,
  `bundle.conversation.updated`, `cost.updated`, `project.deleted { project, runs, bundles, discussions }` (to
  unfiltered subscribers and those filtering on that project). Filters: `project` (matches run, discussion and bundle
  events), `run`, `discussion`, `bundle`. Member runs emit their own `run.state` as they change.
  - `cost.updated { project, run? | bundle? | discussion?, usd, totalTokens }` (exactly one owner) carries the owner's
    **total**, recorded plus live. It is checked on the same hook as `conversation.updated` (an owner's Conversation
    changed) and sent only when the total changed, at most once per 2 s per owner (a change during the window is sent
    when it ends). It follows the usual filters. A first look at an owner with a zero total sends nothing.
- **Views:** `RunView` (state, gate, rounds and caps, pending ask, spec and delivery artifacts, conversations, reviews
  with QA status and VM, findings log, advisory and accepted findings, notices, messages, history, cost, `liveCost`,
  `interrupted`, `specPath`, `bundle`, `cleared`) and `BundleView` (members with key, spec path and branch, dropped
  runs, merge method, delivery, CI, pending ask, escalation, `mergeRequested`, the latest integration, rounds,
  conversations, reviews, findings, notices, messages, history, cost, `liveCost`, `interrupted`, failure).
  - **Live cost:** `liveCost: { usd, totalTokens, byRole: { role, conversationId, usd, totalTokens }[] }` is the usage
    of the owner's Conversations that no cost record contains yet: per Conversation, its `pi.usage` now minus the larger
    of what the Document recorded (`usage`) and what the core's current turn on it started from (`usageBase`, set when
    `runAgent` submits); a builder's running helpers count in full under the builder until their `subagent` result
    lands in its `tools` bucket. When the turn's cost record is written the recorded total rises by exactly the live
    part and the live part drops to zero, so recorded plus live never counts tokens twice. It moves per completed model
    response and per tool result with usage, not per streamed token; zero for a terminal owner. Cost records and
    `turnCosts` are still written only at the end of a turn.
  - `interrupted: { role, conversationId, key, at, by }` is set while the agent is paused by an interrupt.
  - `DiscussionView.cost` is the **recorded** total (the turns that ended); `DiscussionView.liveCost: { usd,
    totalTokens }` is the running turn's usage not yet in `turnCosts` (from the turn's starting usage, `turn.usage0`;
    zero between turns).
  - `HumanMessage.resume`: on a message that resumed a paused agent, the request id it went in with.
  - **Transcripts** (`TranscriptView`, from `getConversation`, `getBundleConversation`, `getDiscussionConversation`):
    `toolResult.durationMs` is the execution time of the call's last attempt from the result message; a result
    without one (a stopped or aborted call) gets the time from the calling response to the result. `running: {
    callId, name, status: "pending" | "running", startedAt? }[]` lists the current round's unfinished calls
    (`pi.live.tools`; `startedAt`, wall-clock ms, from the tool task once it runs), and `now` is the server's clock
    when the view was read, so interfaces correct for clock skew.
- **Pending asks are core state,** stored in the Document and published as events. The first valid answer resolves an
  ask; later ones are rejected.

## 6. Settings

Layers: schema default → global (top of the config file) → project (`projects.<name>`). Objects merge per key;
scalars and lists replace. Validated on save (an invalid change is rejected, the file unchanged). Runs, discussions
and bundles pin the effective settings when they start; changes apply to new ones only. Secrets are references
(`env:`, `file:`, `store:`), never values.

| Path | Default |
|---|---|
| `roles.architect` / `builder` | `anthropic/claude-opus-5-5`, `high` |
| `roles.reviewer` | `openai/gpt-6-sol`, `high` |
| `roles.qa` | `anthropic/claude-sonnet-5-5`, `medium` |
| `roles.helper`, `roles.integrator` | unset = the builder's |
| `discussion.model` | unset = the architect's |
| `bundle.mergeMethod` | `squash` (`merge` \| `squash` \| `rebase`) |
| `policy.approvals` | `[spec]` (any of `spec`, `delivery`, `merge`; `merge` is legacy) |
| `policy.reviewRoundCap` | `3` (1–20) |
| `policy.escalateOnNoProgress` | `true` |
| `policy.messages` | `[architect, builder, reviewer]` |
| `ci.mode` / `fixRounds` / `checks` / `noChecksTimeout` | `if-present` (`off`, `required`) / `2` (0–3) / `[]` (all) / `2m` |
| `github.identity` | `{ kind: pat, tokenRef: env:GH_TOKEN }` (`pat`, `bot`, `app`) |
| `github.visibility` | `private` |
| `qa.enabled` | `true` |
| `boat.apiKey` / `size` / `ttl` / `runScripts` | `env:BOAT_API_KEY` / `default` / `1h` (10m–24h) / `[scripts/run.sh, bin/run]` |
| `sandbox.enabled`, `allowedDomains`, `deniedDomains`, `denyRead`, `extraWrite`, `unixSockets`, `setupScripts` | on; npm, PyPI and Go registries; `[]`; secret paths; `[]`; `auto`; `[scripts/setup.sh, setup.sh, bin/setup]` |
| `webSearch.mode` / `maxResults` / `apiKey` / `endpoint` / `maxCharsTotal` | `fast` / `10` / `env:PARALLEL_API_KEY` / Parallel's search API / unset |
| `workdir` | `~/factory/work` |
| `web.host` / `web.port` (global only) | `127.0.0.1` / `7317` |
| `storage.kind` / `path` (global only) | `sqlite` / `~/.factory/factory.sqlite` |

Not configurable: tool sets and write access per role, the evidence rules, messaging QA or helpers, cost caps (cost is
recorded per role and round, boat VM time included, never capped). A config with legacy `stages` or `workers` keys
stops `serve` with an error naming the new paths.

## 7. Backends

- **GitHub** (`src/github/`): one `GitHub` class over a `GitHubHost` seam: `GhApiHost` (real GitHub via `gh api`) and
  `LocalGitHubHost` (bare local remotes, PRs and checks in a JSON file, a local CI runner) for tests and the dry run.
  It opens per-run worktrees from a shared clone per project, commits spec artifacts, pushes branches, integrates
  bundle branches, creates repos, opens and updates PRs, reads checks, merges and closes PRs. Calls are idempotent
  per run or bundle. The GitHub credential never enters a sandbox or VM.
  - **Commit identity** ([`docs/specs/run-mv6dwfsi-7xli.md`](specs/run-mv6dwfsi-7xli.md)): every commit the factory
    makes, host-side or by an agent in its environment, is authored and committed by the GitHub account behind the
    pinned `github.identity`: `<login> <id+login@users.noreply.github.com>` (`pat`, `bot`; `GET /user`) or
    `<slug>[bot] <id+slug[bot]@users.noreply.github.com>` (`app`; `GET /app` with the App JWT, then
    `GET /users/<slug>%5Bbot%5D`). The seam is `GitHubHost.commitIdentity(identity)`; `GitHub.commitIdentity(rc)`
    caches it per process and identity settings (failures not cached). There is no configured author and no
    placeholder: a failed lookup fails the step (run `PREPARING`, a bundle step, discussion open) with a message naming
    the identity and the failing call, and nothing is committed. Commits are unsigned; commits GitHub makes itself
    (API merges and squashes) are GitHub's. The fake host's account is `factory-dev <1+factory-dev@users.noreply.github.com>`.
- **Sandbox** (`src/sandbox/`): every command a role runs goes through `@anthropic-ai/sandbox-runtime` (bubblewrap on
  Linux, Seatbelt on macOS). Writes are denied except the role's own write roots (the builder's and integrator's
  worktree and git dirs) and a per-environment scratch dir; reads of the factory home and secret paths are denied;
  network only to `allowedDomains` through the host proxy; commands start from an empty environment. Setup scripts run
  at provision. Each environment record carries the owner's commit identity (`EnvRecord.commitIdentity`), which sets
  `GIT_AUTHOR_*` and `GIT_COMMITTER_*` in its commands; a record written before it existed gets it from the owner's
  pinned config when it is next opened (the environment isn't recreated).
- **Boat** (`src/boat/`, `@boatdev/sdk`): one VM per review round, created with an idempotency key so a resume finds
  the same VM; a stopped VM is resumed, a lost one replaced, and boat calls retry 3 times. `LocalBoatBackend`
  (`--fake-boat`) fakes it offline.
- **Models** (`src/models/`): pi-coding-agent's model runtime over `<factory home>/pi` gives built-in providers, pi
  provider packages, `models.json` endpoints and stored logins (API key or OAuth). Credentials apply live; new
  packages need a restart.
- **Secrets** (`src/secrets/`): `store:` refs resolve from `<factory home>/secrets.json` (mode 0600).
- **Web search:** `web_search({ objective, queries })` on Parallel's Search API runs in the factory process, so its
  key never enters a sandbox; without a key it returns an actionable error.

## 8. Durability

- Each run, discussion and bundle is a Pi Durable Task whose Document (`factory.run`, `factory.discussion`,
  `factory.bundle`) commits atomically with the task checkpoint at every transition. A `kill -9` resumes at the last
  committed step, with the same Conversations (their transcripts persist) and the same pending asks.
- Input to a Conversation is submitted with a request id derived from the Document, phase and sequence, so a resume
  reattaches to the same turn. Backend calls are idempotent (workspace records, existing PR found before creating one,
  merge state of the bundle worktree inspected on resume).
- Helpers keep no core state; an in-flight tool call returns `interrupted`, and the working tree is the record.
- **The interrupt pause** (spec `docs/specs/run-mv8t6vsz-pmy8.md`) is durable. `interruptAgent` /
  `interruptBundleAgent` commit `interrupted` on the RunDoc or BundleDoc **before** aborting the Conversation. When
  `runAgent` (`task-kit.ts`) sees its input settle `unanswered` / `aborted` while `interrupted` names that
  Conversation and turn key, it neither fails the owner nor uses a nudge: it waits durably for the human, watching the
  Document (as `awaitResponseOr` does). The owner stays in its state (e.g. `BUILDING`), and a `kill -9` while paused
  resumes paused. The next `message` / `messageBundle` to that agent commits `resume: <key>:resume<n>` on the message
  and clears `interrupted` in the same commit; the Task submits it as the turn's next input with that request id (so a
  resume reattaches to it), with the usual header and situation note. The turn then goes on as before: the agent must
  still end with its bridge tool, and the nudges apply if it stops without one. An agent can be paused any number of
  times. If the agent called its bridge tool before the abort landed, the result is taken as usual and `interrupted`
  is cleared. `cancelRun` / `cancelBundle` work while paused; a transition, a cancel and a retry clear `interrupted`.
- A run records its pinned config hash and the Pi Durable version (pinned in `package.json`).
- Storage is SQLite by default (`jsonl` alternative). What a finished run, bundle or discussion leaves on disk is
  deleted as soon as nothing uses it (§8.1).

### 8.1 Disk cleanup, the startup sweep and `gc`

Spec: `docs/specs/run-mv58bn4q-q2zs.md` (`src/core/cleanup.ts`). Each run, bundle and discussion is an **owner**; its
things are found under its **pinned** workdir, never only the current global one:

| Thing | Where |
|---|---|
| worktree / checkout | `<workdir>/runs/<id>`, `<workdir>/bundles/<id>`, `<workdir>/discussions/<id>` |
| manifest | `<workdir>/<area>/<id>.json` |
| local branch | `factory/<id>` in the shared clone `<workdir>/repos/<owner>__<repo>` |
| remote branch | `factory/<id>` on the host (runs and bundles; discussion branches are never pushed) |
| scratch | `<workdir>/scratch/<id>-<role>` for every role |
| environment records | `<factory home>/environments/<id>-<role>.json` |

**Scopes:** `full` removes all six (each only where it exists); `scratch` removes only the scratch dirs and **keeps
the environment records**, so a retried owner resumes without provisioning again (`policy()` recreates the scratch
dirs on next use). One pure function, `cleanupScope(owner)`, decides:

| Owner | State | Scope |
|---|---|---|
| Run | `DELIVERED` | full |
| Run | `FAILED` / `CANCELLED`, cleared | full |
| Run | `FAILED` / `CANCELLED`, not cleared | scratch |
| Run | `READY` and every non-terminal state | none |
| Bundle | `MERGED` / `CANCELLED` | full, of the bundle's own things only (members' branches are never touched) |
| Bundle | `FAILED` | scratch |
| Discussion | `CLOSED` / `FAILED` | full |
| Discussion | `PREPARING` / `OPEN` | none |

- **Order of a full cleanup:** remote branch (`GitHubHost.deleteBranch`; only `factory/<owner-id>`, never the default
  branch, skipped when the repo doesn't exist on the host), worktree (`git worktree remove --force`, then the
  directory), `git worktree prune`, local branch (`git branch -D`), manifest, scratch dirs, environment records. Git
  work runs under the per-clone lock. Every step is attempted even if an earlier one failed and is idempotent (missing
  counts as success); failures are logged with the owner and step, and never block the owner's state transition.
- **Where it runs:** run and bundle Tasks at their end (finalize and abort), the discussion Task when it leaves
  `OPEN`, `clearRuns` and `cancelBundle` of a `FAILED` bundle (in the background), the startup sweep and `gc`. Two
  cleanups of the same owner never run at once; `retryRun`, `retryBundle` and discussion reopen/retry wait for an
  in-flight cleanup before they commit.
- **Marker:** `cleanedUp: { at, scope }` on the RunDoc, BundleDoc or DiscussionDoc, set only when every step of that
  scope succeeded (otherwise absent or left at the lower scope, so the sweep retries). `scratch` can be upgraded to
  `full`; `full` is final. `retryRun`, `retryBundle` and discussion reopen/retry delete it in the commit that restarts
  the owner.
- **Startup sweep:** started from `Factory.start()` after resume, in the background (never delays the web server),
  one owner at a time:
  1. **Records:** every owner whose scope isn't `none`, isn't covered by its marker and has no live Task is re-read
     and cleaned. This backfills older records and retries failed cleanups.
  2. **Orphans:** in the global workdir and every pinned one, factory-named entries whose id matches no record
     (`runs/run-*`, `bundles/bundle-*`, `discussions/disc-*` and their `.json`, `scratch/<id>-<role>`), and environment
     records with no owner, are removed. No other names are touched.
  3. **Clone sweep:** in each `repos/*` clone, `git worktree prune`, then every local `factory/*` branch that no
     worktree has checked out and whose owner has no record, or is fully cleaned with scope `full`, is deleted.
  4. One summary line: `disk sweep: removed N items (runs a, bundles b, discussions c, scratch d, env records e,
     branches f local / g remote), K failures`, and one line per failure.

  A second sweep over the same data removes nothing. `gc` runs the same sweep on demand.
- **Never deleted:** QA screenshots (`<factory home>/artifacts`), conversations and the storage records; views load in
  every state. A closed PR whose head branch was deleted can't be reopened. **Exceptions, for a deleted project
  only:** its owners' `artifacts/<id>/` dirs are deleted, their Documents are retired, and their Conversations become
  unreachable (below).

#### Deleting a project (purge)

Spec: `docs/specs/run-mv86f7vs-jif2.md` (`deleteProject`, §5; `src/core/project-deletion.ts`). The purge is logical,
through Pi Durable's API only: every `factory.run` / `factory.bundle` / `factory.discussion` Document of the project is
retired and its id leaves its index, in one commit; nothing in the factory can read that history afterwards. Pi
Durable has no delete for Conversations, entries, tasks or document revisions: those stay in `factory.sqlite` / the
JSONL files as unreachable rows (the store does not shrink). No raw SQL, no `VACUUM`; SQLite and JSONL behave alike.

- **The record:** the purge commit appends `{ id, project, repo, at, by, owners: [{ kind, id, repo, workdir, github,
  repoExists }], configRemoved: false, clone: <global workdir's clone>|null, otherClones: [...] }` to the session
  Document `factory.projectDeletions`. `configRemoved` turns true once the `projects.<name>` block is gone; each owner
  leaves `owners` once its cleanup succeeded, each clone once removed (or kept); the entry is dropped when empty.
- **Disk, in the background:** each captured owner gets a full cleanup in the order above (remote branch skipped
  when the repo did not exist on the host), driven from the captured data, then `<factory home>/artifacts/<id>/` is
  deleted. After all owners, the shared clone `<workdir>/repos/<owner>__<repo>` goes in the global workdir and in
  each workdir the owners pinned, **only if no remaining project binds the same repo** (otherwise it stays, logged,
  and only the project's `factory/<id>` branches went). A failed step is logged with its owner and step and stays in
  the entry.
- **Never touched:** the GitHub repo, its default branch, PRs (open or closed) and their descriptions, merged
  history, global settings and other projects' settings. Only the project's own `factory/<run-id>` and
  `factory/<bundle-id>` branches are removed on the host.
- **Resuming:** `Factory.start()` finishes any missing config removal before serving; the startup sweep and `gc`
  first finish every unfinished entry (owners, then clones). Their items count in the summary line (worktrees,
  manifests and artifacts dirs under runs / bundles / discussions, a removed clone under local branches). A factory
  killed at any point after the purge commit ends with the project fully deleted; a crash before it changes nothing.
  The orphan and clone sweeps treat purged ids as having no record.

## 9. The web UI

Served by the factory at `http://127.0.0.1:7317` (static files, no build step). Access needs the token from the link
`factory serve` prints; the first visit swaps it for an HttpOnly cookie. Foreign `Host` and `Origin` headers are
rejected.

- **Markdown** (spec `docs/specs/run-mv46mros-6c1p.md`): prose (transcripts, notices, chat bubbles, the spec modal and
  preview, the request, the discussion summary, draft bodies, the architect's question) renders as CommonMark + GFM
  through `markdown.js` (`md()`; `inline()` for finding descriptions and one-line labels): `marked` parses, `DOMPurify`
  sanitises, links open in a new tab with `rel="noopener noreferrer"`, images load only from the UI's origin or
  `data:`. Both libraries are served from `node_modules` at the exact routes `/vendor/marked.js` and
  `/vendor/purify.js`; the CSP is unchanged. Without them, prose falls back to escaped text. Tool panels and evidence
  stay raw.

- **Board** (spec `docs/specs/run-mv4rgjw0-ch4q.md`): five columns, **Planning** (received, preparing, discussing,
  spec ready, the spec gate), **Build & Review** (building, reviewing, escalated from either), **Ready** (Ready and in
  no active bundle), **Shipping** (bundles, the delivery gate, delivering, awaiting CI, legacy escalations from CI and
  any other non-terminal state) and **Done** (delivered; with "Show closed" also failed and cancelled). One function
  maps a run to its column; the run view's eight fine-grained stages (Intake … Done, "Failed in <stage>") are a
  separate mapping. Each card shows its exact stage as its lozenge. In a column, "Your turn" cards come first, then
  pipeline order of the stage, oldest first (Done: most recently updated first; bundle cards before run cards in
  Shipping). Under each column name is a plain-language hint (raw states as its tooltip) and, when the column holds
  several stages, a breakdown such as "2 discussing · 1 spec approval". **Create** submits a ticket (creating the
  project if it is new). Cards move on their own and show "Your turn" when the human is needed.
- **Sizing:** one set of breakpoints (phone ≤ 640px, tablet ≤ 1024px, wide ≥ 1600px; the run view also uses 1180px
  and 760px). Columns grow equally from 272px to 440px; when they don't fit, the board (never the page) scrolls
  sideways with proximity snapping, and each column scrolls vertically on its own. On phones a column is
  `min(85vw, 360px)` wide so the next one peeks in; the search box takes its own row. Card titles wrap (3 lines max,
  full title as the tooltip), the footer's left side wraps and its right side (cost · age, avatar) stays on one line;
  keys, project names and bundle ids truncate with an ellipsis and a tooltip. Approval and escalation cards and modals
  scroll inside themselves with their action buttons pinned at the bottom.
- **Ready column:** each card has a checkbox. Ticking a card of one project disables other projects' checkboxes, with
  a hint. While any are ticked, the header shows **Ship N tickets**, which creates the bundle (tickets in the order
  ticked) and shows a toast linking to it. A Ready run's view has **Ship this ticket**.
- **Shipping column:** bundle cards (id, state, member keys, "Your turn"); member runs show inside their bundle card.
  Legacy runs still delivering the old way show as ordinary cards. **Done** shows merged runs with a bundle chip.
- **Clearing Done runs:** **Clear all** in the Done header (two clicks) clears exactly the Done cards shown (project
  filter, search and "Show closed" apply); a finished run's view has **Clear from board** (two clicks). Cleared runs
  leave the board, its counts and counters, live in every tab (`run.cleared`), and stay off across restarts; the board
  still loads them (`includeCleared`) so ticket keys don't shift. A cleared run opened by link is read-only, marked
  cleared, with no Retry.
- **Select mode (bulk cancel and clear):** **Select** in the board header turns it on and off. Every run card in every
  column gets a checkbox (Planning, Build & Review, Ready, the legacy run cards in Shipping, Done); bundle cards and
  runs in an active bundle get none. Each column header gets a "select all" checkbox acting on exactly the cards the
  column shows (project filter, search and "Show closed" apply; indeterminate when some are selected). The selection
  may span projects and columns, and holds only cards the board shows: a selected card that leaves the board (cleared,
  hidden by a filter) or becomes unselectable (joined a bundle) drops out, live. In select mode the Ready column's
  ship checkboxes become selection checkboxes and **Ship N tickets** is hidden; leaving select mode clears the
  selection and brings the ship ticks back as they were. While anything is selected, an action bar shows "N
  selected", **Cancel K** (the K live selected runs; two clicks, "Click again to cancel K"; one `cancelRuns` call),
  **Clear M** (the M terminal, not yet cleared selected runs; two clicks; one `clearRuns` call) and **Clear
  selection**; each button shows only when its count is at least 1. Runs acted on leave the selection; cancelled runs
  move to Done (visible with "Show closed"). A refused call shows the error toast and changes nothing.
- **Run view:** full screen for any run: a left rail with the conversations (architect, builder and its helpers,
  reviewers, QA agents) and a timeline; the transcript with every tool call as a plain row (QA screenshots inline); a
  chat box to the agent the run is with; approval and escalation cards floating over it with the final round's
  findings, screenshots and QA status; ticket details, findings by round and source, cost by role. A member run shows
  "In bundle-N" (a link) and, once merged, the PR.
- **Tool rows and their timing** (spec `docs/specs/run-mv8t6vsz-pmy8.md`; runs, bundles, discussions and helpers alike):
  a finished row shows its duration next to its status (`850 ms`, `12.4 s`, `3m 05s`, `1h 02m`); a running row shows
  a clock counting up every second on the client (`0:42`, from `running[].startedAt` corrected with `now`) and a
  **Stop** button (`stopToolCall`; the agent gets the call as aborted and carries on); a pending row reads "queued";
  bridge tools and pending rows have no Stop; a stopped or aborted row reads "stopped after <duration>". The live line
  at the top of the chat box reads e.g. "Builder is running bash · 0:42" (or "<Role> is paused").
- **Interrupt** (run and bundle views): the chat box shows **Interrupt** next to Send while its target is working and
  interruptible (not terminal, not paused, its role allowed by `policy.messages`); it calls `interruptAgent` /
  `interruptBundleAgent`. While paused, the chat box shows a banner "<Role> is paused. Send a message to continue" with
  a **Continue** quick action that sends "Continue." through the ordinary `message` / `messageBundle`; the hint says
  "Your message resumes the <role> right away", and the message is shown as "resuming the <role>", not "queued until
  the current step". A paused run or bundle counts as "Your turn" on the board (badge "Your turn · paused", first in its
  column, in the counts). A refused call shows the error toast and changes nothing.
- **Live cost:** run and bundle cards, the run, bundle and Chat headers (`#rv-cost`) and the details KPI show recorded
  plus live; the cost-by-role table adds an "in progress" row per working role from `liveCost.byRole`, and its total
  includes them. All of these update from `cost.updated` without reloading the view (an open run or bundle refetches
  its view to refresh the table).
- **Bundle view:** the same layout: integrator, reviewers and QA conversations and a timeline, a chat box to
  `messageBundle`, a header with the member tickets (each links to its run) and the PR link. Until a conversation
  starts, the rail hints "A clean one-ticket merge needs neither; a bundle of two or more tickets always gets a
  reviewer." After Merge on a moved default branch, a note says it merges by itself when the update is green and
  needed no fix. Cards: the merge card (CI status, findings with screenshots, QA status or, for a clean one-ticket
  bundle or a pre-upgrade clean integration, "Not reviewed: clean merge"; before its first review a 2+ ticket bundle
  shows "Not reviewed yet: the combination is reviewed before the PR"; **Merge**, **Request changes**,
  **Drop tickets…**), the escalation card (reason, findings, **More rounds**, **Drop tickets…**, **Abort**), and a
  failed bundle's **Retry**. **Cancel bundle** is available on every bundle that is not merged or cancelled,
  including a failed one.
- **Chat** (spec `docs/specs/run-mv46hn3a-f4fa.md`; the Discussions tab is gone): a **Chat** button next to
  **Create** opens discussions as a full-screen chat in the run view's sheet: the last discussion of the browser
  session or a blank new chat (`#chat`; a discussion is `#disc=<id>`). Project (or **New project…**), model
  (`listModels`, the project's `discussion.model` marked "(default)") and thinking dropdowns at the top, locked to the
  pinned values after the first message; a collapsible history rail of the project's discussions with **New chat**;
  the transcript and composer (**Stop**, which ends the turn as before; tool rows get the per-call **Stop** and timing
  above, and the header cost includes the running turn's `liveCost`); a drafts panel (**Draft tickets**, edit drafts, **Create ticket**); a ⋯ menu
  with **Close discussion**, **Reopen**, **Retry**. The chat is continuous (spec `docs/specs/run-mv4rfo5d-i74d.md`):
  the composer is always visible, pinned to the bottom of the sheet, whatever the transcript's length, at every
  breakpoint, with the rail collapsed or expanded and the drafts panel open or closed, in every composer state
  (blank, Preparing, replying/Stop, Your turn, Closed/Reopen, Failed/Retry); only the transcript scrolls. A
  discussion ends only when the human closes it or it fails, never after a reply. (The center grid places the
  header, transcript and composer in explicit rows, so hiding the header in chat mode cannot shift them.)
- **Settings:** a form generated from `settingsSchema()`, global or per project, each field with its source and a
  Reset/Inherit button.
  - **Delete project** (spec `docs/specs/run-mv86f7vs-jif2.md`): a section at the bottom of a project's scope says
    what is removed (runs, bundles, discussions and their history, worktrees, `factory/<id>` branches, screenshots,
    the project's settings) and what is kept (the GitHub repo, its default branch and PRs, global settings). Its
    button opens a confirmation that requires typing the project name exactly (the confirm button stays disabled until
    it matches). The confirmation warns about the project's `PREPARING` / `OPEN` discussions (from
    `listDiscussions({ project })`): "2 open discussions will be ended" (no line when there are none); deleting ends
    them. On `conflict` the dialog lists the live items (runs and bundles, or a discussion "still finishing"), each a
    link to its run, bundle or discussion, with the hint "Cancel these first"; nothing is deleted. On success: toast "Deleted project <name>", the scope goes
    back to Global and the project leaves the scope list.
  - **Live removal, in every open tab** (`project.deleted`): the project's run and bundle cards and discussions leave
    the board, the counts, the Chat history rail and the project dropdowns (board filter, Create, Chat); a board filter
    on that project resets to "All projects"; an open run, bundle or discussion view of it closes with the toast
    "Project <name> was deleted". A link (`#run=`, `#bundle=`, `#disc=`) to a purged item shows "Not found (its project
    was deleted or it never existed)". No CLI command; `factory gc` finishes interrupted deletions.
- **Version and updates** (§12): a version chip in the header shows the running short SHA (tooltip: commit date and
  package version), or **Update available (N)** when the upstream has N new commits. It opens the **Update dialog**:
  running and upstream versions, the incoming commit subjects (`inline()`), **Check now** with the last check's time
  or error, any precondition that blocks the update, the active work (runs and bundles in `PREPARING`, `DISCUSSING`,
  `BUILDING`, `REVIEWING`, `DELIVERING`, `INTEGRATING`, `FIXING`, `AWAITING_CI`, discussions with a turn running) with
  a note that they resume after the restart and only the step in progress is redone, and **Update** behind a
  confirmation that lists the active work again. In foreground mode it says the factory needs a manual restart. While
  updating it shows the phase; once the server goes away, "Restarting…", polling `/api/version` every 2 s, and the
  page reloads when the running SHA changes. A stale SHA (the upstream moved) re-checks and shows the new commits.
  After a restart the last update's report shows once as a dismissible banner. Not updatable: the chip shows the
  version and the dialog "Updates unavailable: <reason>", with no Update button. `update.js`, a classic script; no
  inline script, no CSP change.

## 10. The CLI

`bin/factory` (run through tsx) only manages the process; the web UI is the interface.

- `factory serve [--config p] [--port n] [--fake-github dir] [--fake-boat dir] [--scripted] [--ci-poll-ms n]
  [--foreground]`: starts the factory detached (log at `~/.factory/factory.log`), waits until the web server listens
  and prints the link. One instance only (pid file); a busy port or a live pid file is a non-zero exit with the reason.
- `factory stop`: SIGTERM to the running factory, waits, removes the pid file.
- `factory status`: running or not, the pid and the link, and a second line `version <short SHA> (<date>, v<package
  version>)` with the running SHA (from `/api/version`; the checkout's HEAD when the factory doesn't answer).
  `factory web`: prints the link again.
- `factory gc`: runs the disk sweep (§8.1) on the running factory (`POST /api/op/gc` through its `web-url`) and prints
  the summary line, the removed items (or "Nothing was removed.") and any failures. Exits 1 when no factory is running
  or when there were failures.
- `factory update [--yes]`: the web UI's check and apply from a terminal (§12). With a factory running it goes through
  that factory's `/api/update/*` (so it restarts the same way), prints the incoming commits and the active work, asks
  for confirmation (`--yes` skips it; without a terminal `--yes` is required) and waits for `done`, `failed` or
  `rolled-back`. With no factory running it only pulls and installs.
- `factory doctor`: checks the config, model credentials for every role, the sandbox, the GitHub identity (and prints
  the account commits are made as, `commits as: <name> <<email>>`, per distinct effective identity) and `gh`,
  the boat key wherever QA is on (`FAIL` if unresolved), and reports model-host diagnostics as warnings.
- `factory setup [section]`: an interactive wizard with sections `prereqs`, `github`, `models`, `roles`, `qa`,
  `search`, `service`. It stores credentials in the factory (no env vars needed), installs pi provider packages and
  compatible endpoints, picks role models, and can install a user service. It ends with the doctor checks.

## 11. Decisions made in the bundles build

These are choices the bundles spec left open:

- **A FAILED bundle keeps its members** until it is retried or cancelled. **Cancel bundle works on a FAILED bundle**:
  it closes the PR and releases the members to plain `READY`.
- **The integrator has the builder's write tools but no helpers** (no `subagent`).
- **The note listing the remaining tickets after a drop** is given to the integrator with its next task (a conflict
  to resolve or findings to fix); a clean re-integration needs no integrator task unless the review of the remaining
  combination (2+ tickets) has findings.
- **A moved default branch or a refused merge re-integrates from scratch:** a fresh integration from the latest
  default branch; earlier integration commits are discarded.
- **GitHub refusing a merge 3 times fails the bundle.** An integrator that leaves a conflict unconcluded after 3
  attempts also fails it.
- **There is no intake in the code,** so "`intake.writeBack`" is the run's final notice.
- The legacy merge gate merges with `squash`.

## 12. Updating the factory

Spec: `docs/specs/run-mv4rp25k-mqna.md`. The factory updates itself to the tip of the **upstream branch of its own git
checkout** (normally `origin/main` of `Darryl-Shi/software-factory`). There are no tags, releases or channels, no
downgrades from the UI, and no automatic updates.

- **Install root:** `src/`'s parent (what `bin/factory` and the service unit run). **Updatable** only on a branch with
  an upstream (`@{u}`); otherwise "Updates unavailable: not a git checkout | detached HEAD | no upstream branch".
  **Version:** HEAD's short SHA and commit date (read at startup: the running code) and `package.json`'s `version`.
- **Check** (`src/update/updater.ts`): `git fetch` of the upstream remote (the user's own git config and credential
  helpers, `GIT_TERMINAL_PROMPT=0`, not sandboxed), then HEAD vs `@{u}`: `behind`, `ahead`, the upstream SHA, up to 50
  incoming subjects newest first, `dirty` (tracked files only), the time. Runs 30 s after startup, every 6 hours and on
  demand. A failed fetch is the check's `error` and one log line; the comparison uses the last fetched upstream.
- **Apply** (one at a time, else `conflict`): the SHA must be the latest check's upstream SHA (else `conflict`); a
  fresh check re-verifies it (an upstream that moved is `conflict`) and the preconditions (`invalid`: "local changes
  in tracked files", "local commits not on origin/main", "already up to date"). Then `<home>/update.json` (0600)
  records `from`, `to`, `startedAt` and the phase `pulling` → `installing` → `restarting` → `done` | `failed` |
  `rolled-back` (plus `error`, `message`, `restartRequired`, `lockChanged`). `git merge --ff-only <sha>`; `npm ci
  --no-audit --no-fund` if `package.json`/`package-lock.json` changed — if it fails, `git reset --hard <from>`,
  `npm ci` again, `failed` with npm's last lines, and no restart.
- **Restart** by how the factory was started (`src/update/restart.ts`, shared with the setup wizard): systemd
  (`INVOCATION_ID` and the unit active) → `systemctl --user restart software-factory`; launchd (`XPC_SERVICE_NAME` is
  `dev.software-factory`) → `launchctl kickstart -k gui/<uid>/dev.software-factory`; daemon (`startDaemon` sets
  `FACTORY_DAEMON_ARGS` to the JSON serve arguments on its child) → SIGTERM the pid, then `bin/factory serve` with the
  same arguments; foreground → no restart, `done` with "Restart the factory to finish the update" until the running
  SHA equals the target.
- **The restart helper** (`src/update/helper.ts`) runs detached outside the factory (its own process group; under
  systemd a transient `systemd-run --user` unit, since a unit restart kills its control group), from a copy of the
  running version's helper sources in `<home>/update-helper/`, logging to `factory.log`. It triggers the restart and
  waits up to 90 s for `GET /api/version` to report the target SHA → `done`; otherwise it resets the checkout,
  reinstalls if the lockfile had changed, restarts again → `rolled-back` with the reason and `factory.log`'s last
  lines.
- **After the restart** the factory reads `update.json`: "Updated from `abc1234` to `def5678`", or "Update to
  `def5678` failed to start; rolled back to `abc1234`: <reason>", until dismissed. A record left in `pulling` or
  `installing` by a factory that died is `failed`; one left `restarting` for over 5 minutes is settled.
- **Work in flight:** an update is allowed at any time and cancels nothing; shutdown is the normal SIGTERM path and
  §8's durability resumes every run, bundle and discussion (the interrupted agent step is redone).
- **Interface:** a service wired in `src/main.ts`, not a core operation. Same token/cookie auth and Host/Origin checks
  as `/api/op` (POSTs need `application/json`): `GET /api/version` → `{ version, sha, fullSha, date, updatable,
  reason?, check?, update?, startedBy, active[] }`; `POST /api/update/check`; `POST /api/update/apply { sha }`;
  `POST /api/update/dismiss` (each returns the same body; refusals use `{ ok: false, error, code }`). Every apply,
  check failure and rollback is logged to `factory.log` with both SHAs.

## Acceptance behaviours

1. Two tickets of an existing-repo project run in parallel. Each stops in **Ready** after its review passes, with
   branch `factory/<run-id>` pushed and no PR open.
2. Each new run commits its spec at `docs/specs/<run-id>.md`; two Ready tickets never conflict on their spec files.
3. Ticking two Ready cards of one project and clicking **Ship 2 tickets** creates one bundle card in **Shipping**
   holding both; cards of another project cannot be ticked meanwhile.
4. When the branches merge cleanly, a fresh reviewer (and QA agent, if QA is on) reviews the combination in one bundle
   review round, then one PR opens with a section per ticket; after CI,
   **Merge** merges it with `bundle.mergeMethod`, and both runs show Done with the same PR URL and a bundle chip.
5. When two tickets edit the same lines, the bundle view shows the integrator resolving the conflict, then a fresh
   reviewer (and QA agent, if QA is on) reviewing the whole combined diff against both specs before the PR opens.
6. Red CI on a bundle PR goes to the integrator as a CI finding, followed by a review and a new CI run; at
   `ci.fixRounds` the bundle escalates with More rounds / Drop tickets / Abort.
7. **Drop tickets** at the merge card returns the dropped run to Ready (shippable again); the bundle re-integrates the
   rest and the PR description lists only the remaining tickets.
8. **Cancel bundle** (also on a failed bundle) closes its PR and returns its runs to Ready. A run inside an active or
   failed bundle cannot be cancelled, messaged or shipped in a second bundle; each attempt shows a clear error.
9. If another bundle merges first, Merge on the second updates it onto the new default branch, reviews the combination
   again (2+ tickets), reruns CI and merges
   without a second click when the update needed no fix (its combined review passed at once); after a fix it asks
   for a fresh click.
10. Merging or closing the bundle PR directly on GitHub is picked up: the bundle becomes Merged, or Cancelled with its
    runs back in Ready.
11. **Ship this ticket** on one Ready run gives one PR for that ticket.
12. For a project whose repo does not exist, shipping creates the private repo and pushes the combined result to
    `main` with `docs/delivery-notes.md`; there is no Merge step, and the runs show Done once CI passes or is skipped.
13. Killing the factory (`kill -9`) while the integrator resolves a conflict and starting it again resumes the same
    bundle and integrator Conversation, and the bundle goes on to the PR.
14. A run that was already waiting for CI or the merge gate before the upgrade finishes with its own PR.
15. A failing review round sends the reviewer's and QA agent's findings together to the same builder Conversation;
    hitting `reviewRoundCap` escalates with accept / more rounds / abort.
16. With QA on and no resolvable boat key, a new run fails at `PREPARING` with a message naming both fixes, and
    `factory doctor` reports a `FAIL`.
17. A message to a running agent reaches it without moving the run; at the spec gate, asking the architect for a
    change produces a revised spec to approve.
18. A discussion's draft turned into a ticket starts a run whose architect receives the discussion summary.
19. Killing the factory mid-build and starting it again resumes the run at the same round with the same builder
    Conversation.
20. Setting an invalid value (e.g. `ci.fixRounds` 5 or `bundle.mergeMethod` `fast`) is rejected and the config file
    is unchanged; a valid change affects only new runs and bundles.
21. With **Select** on, ticking Planning and Build & Review cards and clicking **Cancel N** twice stops them all in one
    `cancelRuns` call; they move to Done as Cancelled. A selection mixing live and finished runs shows both **Cancel
    K** and **Clear M**, each acting only on its own subset; a run inside a bundle cannot be selected, and
    `cancelRuns` with it is refused (409, naming the bundle) without cancelling anything.
22. A project with a `READY` run, a `FAILED` bundle or an `OPEN` discussion can't be deleted: `deleteProject` answers
    409 naming each live item and its state, nothing changes, and the Settings dialog lists them as links. After
    cancelling and closing everything, deleting it (typing its name) purges it: its cards, bundles and Chat history
    leave the board in every open tab, its former ids are 404 everywhere, `projects.<name>` leaves the config (other
    projects untouched), its worktrees, manifests, scratch, environment records, artifacts and `factory/<id>` branches
    (local and remote) are gone while the repo, its default branch and PRs remain, and the shared clone goes unless
    another project binds the repo. A `kill -9` right after the purge commit is finished by the startup sweep (a
    second `gc` removes nothing); a project created again under that name starts empty, and new bundle and discussion
    ids are never reused.
