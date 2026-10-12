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
- States: `PREPARING` → `OPEN` → `CLOSED` (reopen resyncs the checkout to the latest default branch); an error leads
  to `FAILED` (Retry). Setup scripts do not run for discussions.
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
| `DELIVERED` / `FAILED` / `CANCELLED` | Terminal. Environments disposed, worktrees kept. A final notice (`run.notice` with `final`) carries the URL, advisory and accepted findings, the QA status and any "no CI" note | `retryRun` resumes a `FAILED` or `CANCELLED` run from the state it failed in (not a cleared one) · `clearRuns` archives it off the board |

- **The builder** is the only build role the core talks to. It may spawn helpers (`subagent`) that write code in the
  same worktree and environment; the core never sees, splits, locks or merges their work. Helpers finish within the
  builder's turn, spawn no helpers and have no bridge tools. The builder commits, checks the working tree and runs the
  tests before `report_done`, which must answer every blocking finding (`fixed`, or `wontfix` with a reason).
- **Messages in `READY`:** to the builder when the run is in no active bundle; refused (`conflict`) with a pointer to
  the bundle when it is in one. A run in `READY` can be cancelled only when it is in no active bundle.
- **When a bundle merges,** each member goes `READY` → `DELIVERED`: its delivery is the bundle's PR (or push to
  `main`), its notice reads "Merged in bundle-N: <url>", and its environments are disposed.
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
| `INTEGRATING` | Fetch the default branch; create or reset `factory/<bundle-id>` at `origin/<default>` (a new repo: the clone's local `main`); `git merge --no-ff` each member branch in order. On a conflict the conflicted merge is left in the worktree and the integrator gets the ticket, the files and every member's spec; it commits the merge and calls `report_done` | clean, integrator changed nothing → `DELIVERING` · integrator resolved anything → `REVIEWING` · error, or a conflict not concluded after 3 attempts → `FAILED` |
| `FIXING` | The integrator gets blocking findings (review, QA, CI or human) | `report_done` → `REVIEWING` |
| `REVIEWING` | As §3.3, on the **whole combined product** against **every member's spec** (and `docs/spec.md` when present), with the combined diff from the integration base | pass → `DELIVERING` · fail under cap → `FIXING` · fail at cap → `ESCALATED` |
| `DELIVERING` | Unreviewed changes go back to `REVIEWING` first. Existing repo: push `factory/<bundle-id>`, open or update one PR. New repo: create the repo, push the result to `main` with `docs/delivery-notes.md` | → `AWAITING_CI` (or straight on with `ci.mode: off`) · error → `FAILED` |
| `AWAITING_CI` | `ci.mode`, `ci.checks`, `ci.noChecksTimeout` on the delivered SHA; also polls the PR | green, or no checks under `if-present` → PR: `AWAITING_MERGE`, new repo: `MERGED` · red under `ci.fixRounds` → `FIXING` · red at cap, or no checks under `required` → `ESCALATED` |
| `AWAITING_MERGE` | Pending ask: Merge / Request changes / Drop tickets; polls the PR | see below |
| `ESCALATED` | Pending ask: more rounds (N) / drop tickets / abort | more rounds → `FIXING` · drop → `INTEGRATING` · abort → `CANCELLED` (PR closed) |
| `MERGED` | Terminal; members → `DELIVERED`; VMs and environments disposed | — |
| `FAILED` | Terminal until `retryBundle`, which resumes from the failed state. Members stay in the bundle | — |
| `CANCELLED` | Terminal; the PR is closed if open; members go back to plain `READY` with their branches untouched | — |

- **Merge** (`mergeBundle`): if the default branch has not moved since the CI-checked integration, the PR is merged
  with `bundle.mergeMethod` → `MERGED`. If it moved, or GitHub refuses the merge, Merge means "merge when green on the
  latest default": the bundle re-integrates from scratch, pushes, waits for CI, and merges by itself when the update
  was clean and green; if the integrator had to change anything, the update is reviewed and comes back to
  `AWAITING_MERGE` for a fresh click.
- **Request changes** (`requestBundleChanges`): one blocking `source: human` finding → `FIXING` → `REVIEWING`; adds no
  review or CI round.
- **Drop tickets** (`dropFromBundle`, at `AWAITING_MERGE` or `ESCALATED`): dropped runs return to plain `READY`; the
  bundle re-integrates the rest from the latest default branch; an open PR is reused and its description rewritten.
  Dropping every member is the same as cancelling.
- **Outside GitHub:** a PR merged by a human is detected → `MERGED`; a PR closed without merging → `CANCELLED`.
- **PR content:** title is the ticket's title for one member, else "<N> tickets: <title 1>, …"; one section per
  ticket (title, run id, spec path, advisory and accepted findings, QA status) and an integration section (conflicts
  resolved, review rounds, advisory findings, QA status, the "no CI" note). Screenshots are never uploaded.
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
- `submit_spec` rejects a spec without an "Acceptance behaviours" heading. Each bridge tool takes one valid submission
  per expected input.
- Models: `roles.<role>.{model, thinking}`. `helper` and `integrator` default to the builder's effective values,
  `discussion.model` to the architect's. The QA model must accept images.

## 5. Core operations and events

The core's whole outside surface is `FactoryCore` (`src/core/types.ts`). Every operation but `subscribe` is in
`CORE_OPS` and served as `POST /api/op/<op>`; errors are `not_found` (404), `invalid` (400), `conflict` and
`not_pending` (409).

- **Projects:** `createProject`, `getProject`, `listProjects`.
- **Runs:** `startRun`, `getRun`, `listRuns`, `getConversation`, `cancelRun`, `retryRun`, `answer`, `approve`,
  `reject`, `submitHumanFindings`, `resolveEscalation`, `message`, `getScreenshot`, `clearRuns`.
  - `clearRuns(runs)` soft-archives terminal runs (spec `docs/specs/run-mv46ek2u-7omz.md`): it sets
    `cleared: { at, by }` on each run's Document in one commit and deletes nothing. All or nothing: an empty list is
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
  `cancelBundle`, `retryBundle`, `messageBundle`, `getBundleScreenshot`.
- **Events** (`subscribe` over `GET /api/events`, server-sent): `run.state`, `run.cleared`, `run.ask`, `run.askResolved`,
  `run.notice`, `run.message`, `conversation.updated`, `settings.changed`, `discussion.state`, `discussion.updated`,
  `discussion.conversation.updated`, `bundle.state`, `bundle.ask`, `bundle.askResolved`, `bundle.notice`,
  `bundle.conversation.updated`. Filters: `project` (matches run, discussion and bundle events), `run`, `discussion`,
  `bundle`. Member runs emit their own `run.state` as they change.
- **Views:** `RunView` (state, gate, rounds and caps, pending ask, spec and delivery artifacts, conversations, reviews
  with QA status and VM, findings log, advisory and accepted findings, notices, messages, history, cost, `specPath`,
  `bundle`, `cleared`) and `BundleView` (members with key, spec path and branch, dropped runs, merge method, delivery, CI, pending
  ask, escalation, `mergeRequested`, the latest integration, rounds, conversations, reviews, findings, notices,
  messages, history, cost, failure).
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
- **Sandbox** (`src/sandbox/`): every command a role runs goes through `@anthropic-ai/sandbox-runtime` (bubblewrap on
  Linux, Seatbelt on macOS). Writes are denied except the role's own write roots (the builder's and integrator's
  worktree and git dirs) and a per-environment scratch dir; reads of the factory home and secret paths are denied;
  network only to `allowedDomains` through the host proxy; commands start from an empty environment. Setup scripts run
  at provision.
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
- A run records its pinned config hash and the Pi Durable version (pinned in `package.json`).
- Storage is SQLite by default (`jsonl` alternative). Worktrees are kept on disk in every terminal state.

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

- **Board:** columns Intake, Discussion, Spec approval, Build, Review, **Ready**, Deliver, Done. **Create** submits a
  ticket (creating the project if it is new). Cards move on their own and show "Your turn" when the human is needed.
- **Ready column:** each card has a checkbox. Ticking a card of one project disables other projects' checkboxes, with
  a hint. While any are ticked, the header shows **Ship N tickets**, which creates the bundle (tickets in the order
  ticked) and shows a toast linking to it. A Ready run's view has **Ship this ticket**.
- **Deliver column:** bundle cards (id, state, member keys, "Your turn"); member runs show inside their bundle card.
  Legacy runs still delivering the old way show as ordinary cards. **Done** shows merged runs with a bundle chip.
- **Clearing Done runs:** **Clear all** in the Done header (two clicks) clears exactly the Done cards shown (project
  filter, search and "Show closed" apply); a finished run's view has **Clear from board** (two clicks). Cleared runs
  leave the board, its counts and counters, live in every tab (`run.cleared`), and stay off across restarts; the board
  still loads them (`includeCleared`) so ticket keys don't shift. A cleared run opened by link is read-only, marked
  cleared, with no Retry.
- **Run view:** full screen for any run: a left rail with the conversations (architect, builder and its helpers,
  reviewers, QA agents) and a timeline; the transcript with every tool call as a plain row (QA screenshots inline); a
  chat box to the agent the run is with; approval and escalation cards floating over it with the final round's
  findings, screenshots and QA status; ticket details, findings by round and source, cost by role. A member run shows
  "In bundle-N" (a link) and, once merged, the PR.
- **Bundle view:** the same layout: integrator, reviewers and QA conversations and a timeline, a chat box to
  `messageBundle`, a header with the member tickets (each links to its run) and the PR link. Cards: the merge card
  (CI status, findings with screenshots, QA status or "Not reviewed: clean merge", **Merge**, **Request changes**,
  **Drop tickets…**), the escalation card (reason, findings, **More rounds**, **Drop tickets…**, **Abort**), and a
  failed bundle's **Retry**. **Cancel bundle** is available on every bundle that is not merged or cancelled,
  including a failed one.
- **Chat** (spec `docs/specs/run-mv46hn3a-f4fa.md`; the Discussions tab is gone): a **Chat** button next to
  **Create** opens discussions as a full-screen chat in the run view's sheet: the last discussion of the browser
  session or a blank new chat (`#chat`; a discussion is `#disc=<id>`). Project (or **New project…**), model
  (`listModels`, the project's `discussion.model` marked "(default)") and thinking dropdowns at the top, locked to the
  pinned values after the first message; a collapsible history rail of the project's discussions with **New chat**;
  the transcript and composer (**Stop**); a drafts panel (**Draft tickets**, edit drafts, **Create ticket**); a ⋯ menu
  with **Close discussion**, **Reopen**, **Retry**. The chat is continuous (spec `docs/specs/run-mv4rfo5d-i74d.md`):
  the composer is always visible, pinned to the bottom of the sheet, whatever the transcript's length, at every
  breakpoint, with the rail collapsed or expanded and the drafts panel open or closed, in every composer state
  (blank, Preparing, replying/Stop, Your turn, Closed/Reopen, Failed/Retry); only the transcript scrolls. A
  discussion ends only when the human closes it or it fails, never after a reply. (The center grid places the
  header, transcript and composer in explicit rows, so hiding the header in chat mode cannot shift them.)
- **Settings:** a form generated from `settingsSchema()`, global or per project, each field with its source and a
  Reset/Inherit button.

## 10. The CLI

`bin/factory` (run through tsx) only manages the process; the web UI is the interface.

- `factory serve [--config p] [--port n] [--fake-github dir] [--fake-boat dir] [--scripted] [--ci-poll-ms n]
  [--foreground]`: starts the factory detached (log at `~/.factory/factory.log`), waits until the web server listens
  and prints the link. One instance only (pid file); a busy port or a live pid file is a non-zero exit with the reason.
- `factory stop`: SIGTERM to the running factory, waits, removes the pid file.
- `factory status`: running or not, the pid and the link. `factory web`: prints the link again.
- `factory doctor`: checks the config, model credentials for every role, the sandbox, the GitHub identity and `gh`,
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
  to resolve or findings to fix); a clean re-integration needs no integrator task.
- **A moved default branch or a refused merge re-integrates from scratch:** a fresh integration from the latest
  default branch; earlier integration commits are discarded.
- **GitHub refusing a merge 3 times fails the bundle.** An integrator that leaves a conflict unconcluded after 3
  attempts also fails it.
- **There is no intake in the code,** so "`intake.writeBack`" is the run's final notice.
- The legacy merge gate merges with `squash`.

## Acceptance behaviours

1. Two tickets of an existing-repo project run in parallel. Each stops in **Ready** after its review passes, with
   branch `factory/<run-id>` pushed and no PR open.
2. Each new run commits its spec at `docs/specs/<run-id>.md`; two Ready tickets never conflict on their spec files.
3. Ticking two Ready cards of one project and clicking **Ship 2 tickets** creates one bundle card in Deliver holding
   both; cards of another project cannot be ticked meanwhile.
4. When the branches merge cleanly, one PR opens with a section per ticket and no bundle review round; after CI,
   **Merge** merges it with `bundle.mergeMethod`, and both runs show Done with the same PR URL and a bundle chip.
5. When two tickets edit the same lines, the bundle view shows the integrator resolving the conflict, then a fresh
   reviewer (and QA agent, if QA is on) reviewing the whole combined diff against both specs before the PR opens.
6. Red CI on a bundle PR goes to the integrator as a CI finding, followed by a review and a new CI run; at
   `ci.fixRounds` the bundle escalates with More rounds / Drop tickets / Abort.
7. **Drop tickets** at the merge card returns the dropped run to Ready (shippable again); the bundle re-integrates the
   rest and the PR description lists only the remaining tickets.
8. **Cancel bundle** (also on a failed bundle) closes its PR and returns its runs to Ready. A run inside an active or
   failed bundle cannot be cancelled, messaged or shipped in a second bundle; each attempt shows a clear error.
9. If another bundle merges first, Merge on the second updates it onto the new default branch, reruns CI and merges
   without a second click when the update was clean.
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
