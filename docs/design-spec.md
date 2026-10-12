# Software Factory on Pi Durable: Design Spec

> **Superseded in part** by [the fixed architecture cleanup](superpowers/specs/2026-10-09-fixed-architecture-cleanup-design.md): no extension layer, web UI only, fixed tool sets, new setting paths.

Status: draft v0.1. Items marked **[decided]** are settled and not open for discussion here. Items marked **[default, changeable]** are what we adopt unless someone finds a reason to change them.

Pi Durable terms used below: a **Harness** is one storage backend plus the machinery that runs agents on it. A **Conversation** is a transcript that runs with an **Agent** (model, extensions, tools, cwd). A **Task** is a durable state machine that saves a checkpoint at every step. A **Document** is typed JSON committed atomically alongside the transcript. An **Extension** bundles tools, sections, hooks, wraps and tasks, and is installed in a **Registry**. **ExecutionEnv** is where tools run. Pi Durable is marked experimental and its API can change between releases, so we pin a version.

---

## 1. Goals / Non-goals

> Superseded: the "everything that varies via extensions" goal and the interfaces-as-extensions non-goal. The factory is a fixed solution: the web UI is its only interface, and GitHub and a local sandbox are its backend ([cleanup spec](superpowers/specs/2026-10-09-fixed-architecture-cleanup-design.md)).

**Goals**
- Take a software request to a delivered repo or PR without supervision. The same flow handles a new project (zero to MVP) and an incremental change to an existing repo; there is no mode split. **[decided]**
- Involve the human only for approvals and for the architecture discussion. Approval gates are set per project; the default gates the spec only. **[decided]** The human may also message the agent a run is with (§3.6); the run never waits for a message, and a message never moves the run.
- Make every run durable: a crash or restart resumes from the last committed step, using Pi Durable's guarantees.
- Stay general-purpose. Everything that varies (models, extensions, policy) lives in config, which is data. **[decided]**

**Non-goals**
- Product or market discovery. The discussion covers architecture only. **[decided]**
- Implementation plans or splitting the work upfront. The builder decides how to break up the work, including whether to hand parts of it to helpers that write code (§2). The core does not split, assign, lock or merge anyone's work. **[decided]**
- Business-specific concepts such as customers, billing or tickets-as-products.
- Telegram or assistant chat as the factory's interface. Every interface is an extension over the core's operations (§3.6); a bridge to either would be one more such extension. v1 ships two interfaces, a terminal CLI with attach and a local web UI (a ticket board with a full-screen run view); both are extensions. **[decided]**
- Multi-tenant hosting and parallel runs on one repo (not in v1). The web UI is single-user and local: it listens on localhost behind an access token.

---

## 2. Flow **[decided]**

```
intake → architecture discussion → spec → [approve spec] → build (one builder, which may spawn helpers that write code)
       → review (product vs spec + code) ∥ AQ testing (optional)
                                        ──fail──► resume same builder with both sets of findings (≤ reviewRoundCap, default 3)
                                        └pass─► [approve delivery?] ──reject──► resume same builder, comment as blocking finding
                                                └approve/gate off─► deliver
       → wait for CI on the delivered commit ──fail──► same builder fixes → review ∥ AQ testing → redeliver (≤ ci.fixRounds, default 2) → escalate
                                                  └pass or CI skipped─► [approve merge?] ──reject──► resume same builder, comment as blocking finding
                                                                        └approve─► merge → done
                                                  └pass or CI skipped, merge gate off─► done (PR left open, no auto-merge)
                                                  └pass or CI skipped, push-main (no PR)─► done
```

CI is skipped when `ci.mode` is `off`, or `if-present` and the repo has no checks; with `required` and no checks, the run escalates to the human (§4).

- **Architecture discussion:** Superpowers-style. The architect asks **one question at a time** and grounds each question in the request and the repo, if one exists. It stops when the architecture is settled.
- **Spec:** a single markdown document produced by the architect. It is the only contract between the stages, and both the build and the review are judged against it. It ends with a short list of **acceptance behaviours**: observable, product-level scenarios the reviewer can check. They say what the product does, not how to build it.
- **Repo map:** every workspace has a short `AGENTS.md` (about 100 lines): build, test and run commands, a map of the repo, and a pointer to `docs/spec.md`. The architect, builder, reviewer and QA agent all read it. New repos ship one; the builder keeps it current on incremental changes.
- **Build:** one builder Conversation. It is the only build role the core talks to: the spec, findings (review, QA, CI, human) and messages go to it, and only it calls `report_done`. It is accountable for everything in the worktree, whoever wrote it.
  - *Helpers write code.* The builder spawns helpers as it sees fit, as owned Conversations (Pi's subagent pattern). Helpers have the same write tools as the builder (`read`, `write`, `edit`, `bash`) and work in the same sandbox and worktree, so the builder can have parts built in parallel by calling several helpers at once. They may also read, search and analyse.
  - *Orchestration is the builder's.* Whether to use helpers, how many, what each one does and how their changes fit together is the builder's decision. The core sets up no work split, no plan, no file locks and no merge step, and it never sees or manages helpers. They are not a role in the pipeline: they get no findings, no messages and no bridge tools (§3.4), and the human never deals with them. Their transcripts stay readable under the builder's (§3.6).
  - *Helpers finish within the builder's turn.* A `subagent` call returns only when its helper is done, and the builder's turn ends only when all its tool calls have returned. So by the time the core reads `report_done` and takes the diff, no helper is still writing. Helpers spawn no helpers of their own. **[default, changeable]**
  - *Builder guidance* (in its prompt, not the core):
    - commit often, and keep its own short progress log so it keeps state across compaction. The log is the builder's notes, **not an implementation plan**;
    - the git diff against the base (`repo.diff(base)`) is the record of changed files, whoever changed them;
    - when it uses helpers, keep their tasks apart where it can, check what they actually changed in the working tree (`git status`, `git diff`) instead of trusting their summaries, and run the tests before `report_done`;
    - the builder makes the commits; helpers leave files uncommitted unless the builder tells them otherwise (concurrent commits race on git's index lock) **[default, changeable]**;
    - ship a working setup/run script, so the reviewer, the QA agent, CI and the next run on the project can boot the product.
- **Review:** one fresh reviewer Conversation per round, with a wide remit. It has read-only access to the source and cannot modify code, and works in the run's local sandbox (§3.3) with tools to execute and run the product: the test runner and the terminal, through which it calls a running product's endpoints (e.g. with `curl`). It has no browser and no desktop; using the product like a user is AQ testing's job.
  - *Product vs spec:* it checks the **whole product** (not only the diff) against the spec. It runs the test suite itself rather than trusting the builder's report, flags any tests that were deleted or weakened in the diff, and runs the product to check the acceptance behaviours.
  - *Code:* it reviews the round's diff (`repo.diff(base)`, and from round 2 also the changes since the previous review) and the code it touches for quality and security. It does not know or care whether the builder or a helper wrote a line. It looks at: structure, duplication, maintainability, error handling, and security issues such as injection, unsafe input handling, secrets in code or missing access checks.
  - *Launchable:* when AQ testing is on for the project and the product is something a user launches (an app, a service, a CLI), a missing or broken run script (`boat.runScripts`) is a blocking finding, so the builder cannot skip AQ testing by not shipping one.
  - Every finding must be backed by evidence it observed: a command and its output, or the code it points to (file and lines). It returns `pass` or `fail` plus findings. A finding is **blocking** when it must be fixed before delivery: a spec violation, a failing, deleted or weakened test, or a code-quality or security problem serious enough to stop delivery, **whether or not a spec clause covers it**. Smaller code-quality points are advisory and reach the builder as advice. We expect to tune the reviewer prompt from transcripts. Cognition found that reviewers do better without the spec; we keep the spec as the contract for what the product does, and the code half of the review judges the code on its own merits.
- **AQ testing (agentic QA, optional):** in the same round and **in parallel with the review**, a fresh QA Conversation **uses the product the way its user would**, in a boat.dev VM with a desktop and a browser where the product is running (§3.7). It clicks through the UI flows in the browser (or the desktop app, or the terminal for a CLI), checks the acceptance behaviours, sees broken screens and flows itself, and attaches screenshots as evidence. It does not review code or run the test suite; that is the reviewer's job. It returns `pass` or `fail` plus findings, under the same rules. It is on by default (`qa.enabled`, §6) and can be turned off per project; it is most useful for products with a UI. The core skips it for a product with nothing to launch (none of the run scripts exists, e.g. a library). When it is off or skipped, the round is the review alone, and the reviewer still runs the product and its tests in the local sandbox. It runs alongside the review rather than after it, so a round costs one wait and the builder gets both sets of findings together.
- **Round verdict:** the core waits for the reviewer and, when AQ testing runs, the QA agent; it waits for both even when one has already failed, so the builder gets one combined set. The round fails if and only if at least one finding from either is blocking; a QA `fail` fails the round exactly like a review `fail`. A round counts once toward `reviewRoundCap` whether one agent or both ran. The two work independently: neither sees the other's findings, in the same round or later.
- **QA status:** each round records whether AQ testing `ran`, was `off` (`qa.enabled: false`), was `skipped` (no run script) or was `unavailable` (boat could not provide a VM, §3.7). The delivery note and the final report state the final round's status, and the web UI shows it at the gates, so the human judging the result knows whether a QA agent ever used the product.
- **Findings:** each finding has a `severity`, a `blocking` flag, an optional `specRef` (the spec clause it rests on, when there is one; code-quality and security findings often have none), `evidence` (what the agent observed: a command and its output, the code it points to, or the UI steps it took and what it saw; required for reviewer and QA findings, optional for human findings), optional `screenshots` (ids of screenshots the QA agent took in its VM, §3.7; every QA finding cites at least one) and an optional `source` (`reviewer` by default, `qa`, or `human`). **Advisory** (non-blocking) findings never fail a round. On a failed round they go to the builder together with the blocking ones, marked as advice: it may act on them or not. The core keeps cited screenshots as run artifacts (§3.7): the builder gets them as images with the findings, and the web UI shows them with the finding (§7). They never go into the repo or onto GitHub: the PR description and the delivery note give each QA finding's text and evidence and say its screenshots are in the factory's run view. The core collects the advisory findings of the final round (review and AQ testing) in the run Document, and `delivery` writes them into the PR description or, for a new repo, into a delivery note committed to the repo (`docs/delivery-notes.md`) and the final report (`intake.writeBack`). If a human accepts a run as is after an escalation, the open blocking findings are listed there too. The builder may answer a finding with "won't fix" plus a reason. From round 2 on, the reviewer and the QA agent each get their own prior findings and the builder's responses.
- **Failed round:** the core submits the round's findings (reviewer and QA, blocking and advisory, with the QA screenshots as images) as new input to the **same** builder Conversation, which answers every blocking one by id in `report_done`, including the ones it gave to helpers to fix. That conversation keeps its transcript, so its context survives. When the round cap is reached, or earlier when a round produces no change (empty diff since the previous round), the core escalates to the human. The "no change" check uses the working tree, committed or not, so a change a helper made counts exactly like one the builder made. The escalation is a pending ask (§3.6), with three options: accept as is, grant N more rounds, or abort.
- **Delivery and CI:** CI is a setting of the delivery extension (`stages.delivery.ci`, §6), not a fixed step. `ci.mode` is `off` (skip CI; the run finishes at delivery), `if-present` (default: wait for the repo's existing checks if it has any, otherwise skip) or `required` (checks must pass; if the repo has none, the run escalates to the human). `ci.checks` optionally names the checks that count (default: all). The CI fix loop runs only when the mode isn't `off` and checks exist: the core waits for CI on the delivered commit: for a PR, the PR's checks; for `push-main`, the commit statuses and check runs for the pushed commit SHA on the default branch. If CI fails, the failure goes back to the same builder for at most `ci.fixRounds` (0–3, default 2) fix rounds, then the core escalates. The review round (with AQ testing, if on) that follows a CI fix counts toward `ci.fixRounds`, not `reviewRoundCap`. The same modes apply to both delivery kinds. When CI runs, this is what enforces "tests pass in CI". AQ testing belongs to the round before delivery and never to CI: CI does not run it, it never waits for CI, and a passing QA does not stand in for missing checks when `ci.mode` is `required`.
- **Escalation stays at the ends [decided]:** the human is asked only at the start (discussion, spec gate) and at the end (delivery and merge gates, and the escalations above: round cap, no progress, CI cap, missing required CI). AQ testing adds no escalation and no mid-build ask: a QA failure is a finding, and a skipped or unavailable QA is a status the human sees at the end.
- **No CI checks [decided]:** after delivery, if no CI checks appear within `ci.noChecksTimeout` (default 2 minutes), the core treats the repo as having no CI. If CI is required for the project (`ci.mode` is `required`), the run escalates to the human through a pending ask (§3.6) instead of finishing. Otherwise the run finishes, and the delivery note and final report say that there was no CI.
- **Merge gate:** after green CI (or right after delivery when CI is skipped), if the `merge` approval is enabled for the project, the core asks for it; approve → `repo.merge` → done. Without that gate the PR is left open (no auto-merge) and the run is `DELIVERED`. The merge gate does not apply to `push-main` deliveries (new repos), because there is no PR to merge.
- **Rejection at the delivery or merge gate:** the run goes back to the same builder, and the human's rejection comment is passed to it as a blocking finding (`source: human`) in the same shape as review findings. A gate rejection adds no review or CI round, and the next reviewer and QA agent see the human findings along with their own prior findings.

---

## 3. Layers & contracts **[decided]**

```
┌───────────────────────────── Core (state machine, no model calls) ─────────────────────────────┐
│ reads Config · drives Run state · opens role Conversations · routes asks/approvals/delivery    │
└───────┬───────────────────────────────────────────────────────────────────────┬────────────────┘
   (2) Factory extensions: the pipeline                   (3) Worker extensions: the agent's world
   intake · interface · delivery · repo                    environment · tools · providers
        └──────────────── (1) Platform: Pi / Pi Durable services ────────────────┘
          model providers (pi-ai) · secrets · storage (SQLite/JSONL) · logging/telemetry
```

**Separation rule:** factory extensions are never visible to agents. Intake, delivery and repo extensions are called by the core; interface extensions work the other way round and call the core's operations (§3.6). Worker extensions are visible to agents and never call factory extensions. An agent reaches humans, the repo remote and delivery **only** through core-owned bridge tools (§3.4), which the core turns into state transitions.

### 3.1 Platform (layer 1)
These services come straight from Pi and Pi Durable and the factory does not wrap them: `createModels()` with pi-ai providers, Harness storage (SQLite by default), secrets from env or a secret store, and Pi telemetry and logging. The core receives them through dependency injection.

### 3.2 Factory extensions (layer 2): the pipeline

> Superseded: there are no factory extensions, stage selection or intake. The core calls a `GitHub` class and a `Sandbox` class directly, and the web server is its interface ([cleanup spec §1](superpowers/specs/2026-10-09-fixed-architecture-cleanup-design.md#1-architecture-and-layout)).

```ts
type RunId = string;
interface Request { id: string; source: string; title: string; body: string;
                    project: string;                // project name (§3.5); the repo comes from its binding
                    meta?: Record<string, unknown> }

interface IntakeExtension {                     // where requests come from / results go back
  pull(): Promise<Request[]>;                   // poll the source
  subscribe?(onRequest: (r: Request) => void): Unsubscribe;  // push sources
  writeBack(req: Request, update: RunUpdate): Promise<void>; // status, links, final result
}

interface InterfaceExtension {                  // how humans reach the factory: CLI, web UI, HTTP API, chat bridge, …
  name: string;                                 // used as Request.source for the runs it starts
  start(core: FactoryCore): Promise<{ stop(): Promise<void> }>;  // calls core operations, subscribes to events, renders them (§3.6)
}                                               // the core never calls an interface and knows none by name
type Question =                                 // a run's pending ask; persisted by the core, published as a `run.ask` event (§3.6)
  | { kind: "discussion"; text: string }                         // architect, one at a time
  | { kind: "approval"; gate: Gate; artifact: ArtifactRef;        // approvals ARE asks
      options: ["approve", "reject"]; }                           // reject carries feedback text
  | { kind: "escalation"; reason: string; options: string[] };

interface RepoExtension {                       // GitHub identity (own account / bot / App) is a setting HERE
  open(ref: RepoRef): Promise<Workspace>;       // clone if the repo exists, else init a local workspace (no remote yet)
  create(ref: RepoRef): Promise<void>;          // create the remote (private by default); idempotent; called at first delivery
  fork?(ref: RepoRef): Promise<RepoRef>;
  diff(ws: Workspace, base: string, head?: string): Promise<Diff>;
  merge(pr: PrRef, how: "merge" | "squash" | "rebase"): Promise<void>;
}
interface Workspace { repo: RepoRef; path: string; baseRef: string; branch: string; newRepo: boolean }  // newRepo: remote did not exist at run start

interface DeliveryExtension {                   // turns a reviewed workspace into a deliverable
  deliver(ws: Workspace, ctx: { spec: ArtifactRef; review: ReviewResult; request: Request })
    : Promise<Delivery>;                        // e.g. push to new repo's main, or open PR from branch;
                                                // writes advisory findings into the PR description / delivery note
  checks(d: Delivery, names?: string[]): Promise<CiStatus>;   // CI checks for d.sha (PR head, or the pushed commit on the default branch); all, or only `names`
}                                               // owns the `ci` setting (§6) through Configurable
type Delivery = { kind: "repo" | "pr"; url: string; ref: string; sha: string };   // sha = the delivered commit
type CiStatus = { state: "none" | "pending" | "green" | "red"; failures?: string[] };   // none = the repo has no (matching) checks
```

### 3.3 Worker extensions (layer 3): the agent's environment

> Superseded: there is no `EnvironmentExtension` and no worker-extension selection. `Sandbox` provides the environment, each role has a fixed tool set, and the web-search settings are `webSearch.*`, carried in a `factory.runConfig` Document ([cleanup spec](superpowers/specs/2026-10-09-fixed-architecture-cleanup-design.md)).

**Fixed tool sets [decided]** (replacing the cleanup spec's `ROLE_TOOLS` list, whose reviewer still had `browser`). Each role's `role-<role>` prompt comes first; none of this is a setting:

| Role | Environment | Tools |
|---|---|---|
| architect | local `Sandbox`, read-only | `coding-readonly`, `web-search` |
| builder | local `Sandbox`, writes the worktree | `coding`, `subagent`, `test-runner`, `web-search` |
| helper | the builder's `Sandbox` environment (same worktree, same write rules) | `coding` (`read`, `write`, `edit`, `bash`), `test-runner`, `web-search`; no `subagent`, no bridge tools |
| reviewer | local `Sandbox`, read-only | `coding-readonly` (incl. `bash`, so `curl` against a running product), `test-runner`, `web-search`; no `browser`, no `computer` |
| qa | boat.dev VM (§3.7), throwaway copy | read-only file tools and `bash` in the VM, `computer` (desktop, browser, screenshots), `web-search`; no `test-runner`, no write tools |

Helpers get the builder's tool set minus `subagent` (so they cannot spawn helpers) and minus the bridge (so they cannot finish the build or reach the pipeline) **[default, changeable]**. Only the builder and its helpers write the worktree.

The `browser` tool (an HTTP client over `curl`) is in no role's set any more; it stays registered only so reviewer Conversations of runs started before this change resolve on resume.

**[default, changeable]:** worker extensions **are Pi Durable extensions** (`defineExtension`: tools, sections, hooks, wraps). We do not invent a factory-specific contract. The core selects them for each role Conversation with `configure({ extensions, tools, cwd })`.

```ts
// environment = Pi Durable ExecutionEnv (exec / file readers / cleanup), built per tool call by the env fn
interface EnvironmentExtension {
  provision(ws: Workspace, role: Role): Promise<{ envId: string; cwd: string }>; // local dir, container, microVM (e.g. gondolin); runs the repo's setup script if present
  env(input: { conversationId: string; cwd?: string }): ExecutionEnv;           // exec(argv), openBinaryReader, openDirReader
  dispose(envId: string): Promise<void>;                                         // = ExecutionEnv.cleanup + teardown
}
type ToolsExtension    = Extension;  // e.g. CodingTools (read/write/edit/bash), subagent (spawns helpers), browser, test runners
type ProvidersExtension = Extension; // e.g. language toolchains, MCP servers, docs lookup, exposed as tools/sections
```

**Worker settings:** a worker extension may declare settings (a `SettingField` schema, like `Configurable`). They live under `workers.<name>`, layer and validate like every other setting (§6), and are pinned per run. The core writes the run's pinned values into each role Conversation (and the builder's helpers) as a `factory.workers` Document, and the extension's tools read the values for the Conversation they run in. This is the core's whole contract with worker extensions beyond Pi Durable's own.

**Default worker extensions:** `coding`, `coding-readonly`, `subagent`, `test-runner`, `computer` (the QA agent's desktop tools, §3.7) and `web-search`. `web-search` adds one tool, `web_search({ objective, queries[1..5] })`, backed by Parallel's Search API in `fast` mode (one request; Parallel runs the queries in parallel and returns ranked results with excerpts). Its settings are `workers.web-search.{mode, maxResults, maxCharsTotal, apiKey, endpoint}`, with the key held as a reference (default `env:PARALLEL_API_KEY`). The tool runs in the factory process, like `subagent`, not through `env.exec`: the key never enters the sandbox and the API host needs no `allowedDomains` entry. Query text leaves the machine and is kept in the transcript; a role that must not search drops `web-search` from `roles.<role>.extensions`.

**Bootable environment:** `provision` runs the repo's setup script, if one exists, so every role starts on a working checkout. Environments do not impose tight CPU or RAM limits; tight limits measurably change outcomes.

**Default environment sandbox [decided]:** the default environment extension, `local-worktree`, runs every command it executes inside Anthropic's sandbox runtime (`@anthropic-ai/sandbox-runtime`, the runtime behind Claude Code's sandboxed bash; Apache-2.0, beta research preview, so we pin it like Pi Durable). It is a setting of that extension (`environment.sandbox`), not a core concept; the core and the bridge do not know about it.
- **Mechanism:** the runtime uses OS primitives instead of a container: bubblewrap on Linux (network namespace removed, PID namespace) and `sandbox-exec` with a generated Seatbelt profile on macOS. The limits apply to the whole process tree. Network traffic can leave only through HTTP and SOCKS5 proxies on the host. On Linux they are reached over bind-mounted Unix sockets; on macOS, through one allowed localhost port. The proxies check each host against an allow/deny list.
- **Wiring:** we use it as a library, not through the `srt` CLI and `~/.srt-settings.json`. The extension calls `SandboxManager.initialize(config)` once per process, which starts the proxies. Then `env().exec` wraps each command with `wrapWithSandbox(cmd, shell, perRunConfig)`, so every `bash` call and every test run from the builder, its helpers, the architect and the reviewer goes through it (the QA agent works in its boat.dev VM instead, §3.7). In-process file tools (`read`/`write`/`edit`) are not processes, so the sandbox does not cover them. `env()` applies the same path rules to their file readers and writers.
- **Filesystem:** writes are denied by default (allow-only). Per run, `allowWrite` is the run's worktree, its git dirs (so the builder can commit) and a per-run scratch dir that `TMPDIR` and tool caches point to. Helpers run in the builder's environment: the same worktree, write rules and scratch dir, with no environment of their own **[default, changeable]**. Read-only roles (architect, reviewer) get no writes to the worktree; commands they run may write only to their scratch dir. Reads are allowed by default (deny-then-allow), and `denyRead` hides `~/.factory`, `~/.ssh` and other secret paths.
- **Network:** denied by default. Only `allowedDomains` from config is reachable, for example package registries. `deniedDomains` wins over allows. GitHub is not on the default list, because agents reach the remote only through the bridge.
- **No GitHub token:** the core's GitHub credentials (PAT, App key) are never put in the sandboxed environment. The runtime's `credentials` section also lists them with `mode: deny`: env vars by name, key files by path. The same holds for the boat API key (§3.7): the env var or file `boat.apiKey` names is denied the same way, so no role's commands can read it, and it never enters a boat VM either.

### 3.4 Core-owned bridge (the only path from agents to the pipeline)
The core installs one small extension, `factory.bridge`, into each role Conversation. Its tools only **commit a Document or Submission** that the core is waiting on. They never call layer-2 code directly.

| Role | Bridge tools |
|---|---|
| architect | `ask_human(question)`: one question, blocks until answered · `submit_spec(markdown)` |
| builder | `report_done(summary, responses[])`: `responses` answers each finding (fixed, or won't fix + reason); the builder does not ask the human anything mid-build |
| helper | none: a helper's result goes back to the builder as the `subagent` call's result, and the builder reports for the work |
| reviewer | `submit_review({ verdict: "pass" \| "fail", findings[] })`; each finding is `{ severity, blocking, specRef?, description, evidence, source? }` (`source` defaults to `"reviewer"`); `fail` requires at least one blocking finding (with or without a `specRef`), and every reviewer finding must have `evidence`; the tool rejects a submission that breaks either rule |
| QA agent (AQ testing) | `submit_qa({ verdict: "pass" \| "fail", findings[] })`; same finding shape plus `screenshots` (`source` is `"qa"`); `fail` requires at least one blocking finding, every finding must have `evidence` and cite at least one screenshot, and every cited screenshot must be one the QA agent took this round; the tool rejects a submission that breaks any of these rules |

At the spec gate the architect may also call `submit_spec` while it answers a human message (§3.6): the revised spec replaces the version waiting for approval, and the run asks for approval again. That is the only bridge call a message can lead to.

A human's rejection comment at the delivery or merge gate reaches the builder in the same finding shape, with `source: "human"` and `blocking: true`; `evidence` is optional for these findings. The builder answers it in `report_done` like any other blocking finding. In `report_done`, the builder answers every blocking finding; advisory findings need no answer.

### 3.5 Projects
A **project** is a factory record: a name, a repo binding (`owner/name`) and settings overrides (§6). It is stored in the config file under `projects.<name>` and exists before any run; every run belongs to one project.

Interfaces create the record with `createProject(name, repo)` (the same call whether or not the repo exists) and start runs on it with `startRun(project, request)` (§3.6).

- **Repo exists:** the project binds to it; runs are incremental and deliver PRs.
- **Repo doesn't exist:** the record is created now; the repo is created as a private repo on the first run's delivery (`repo.create`; the RepoExtension owns creation). Until then runs work in a local workspace. The first delivery is `push-main` (no PR); later runs deliver PRs.
- **Overrides** belong to the project record (set with `setSetting({ project }, …)`, §6), so they apply from the first run, before the repo exists. A run pins the merged global + project settings when it starts (§4).

- **Web UI rendering.** The web UI (`src/web/ui/`, plain JavaScript, no build step) renders prose as CommonMark + GitHub-Flavoured Markdown through one module, `markdown.js`: `md(text)` for block markdown and `inline(text)` for one-line texts. Parsing is `marked` (GFM, soft line breaks as `<br>`), and every result passes through `DOMPurify` before it reaches the page: raw HTML never runs (script, style, iframe, object, form, `on*` handlers and `javascript:`/`data:` links are stripped), links get `target="_blank" rel="noopener noreferrer"`, task-list checkboxes are disabled, and images load only from the UI's own origin or `data:` (others become a link or their alt text). The server serves the two libraries' prebuilt browser builds from `node_modules` at the exact routes `/vendor/marked.js` and `/vendor/purify.js`, behind the same token and headers as the other static files; the CSP (`script-src 'self'`) is unchanged. Full markdown covers transcripts, factory/notice cards, the human's chat bubbles, the spec modal and preview, the request body, discussion summaries, draft ticket previews and the architect's question card; finding descriptions use `inline`; tool panels, evidence and textareas stay raw. Without the libraries, prose falls back to escaped plain text with line breaks kept.

*Example interface, not part of the core:* a CLI extension might expose these as `factory project create todo --repo me/todo` and `factory run todo "add due dates"`, plus a shorthand that calls both for a project's first run.

### 3.6 Core operations and events (the interface surface)

> Superseded: the interface parts. There are no interface extensions, no CLI client and no Unix socket. The web server is the one transport, and the operations and events below are what it calls ([cleanup spec](superpowers/specs/2026-10-09-fixed-architecture-cleanup-design.md)).

The core's whole surface for humans is a set of transport-neutral operations plus a stream of events. Interface extensions (§3.2) call the operations and render the events; nothing else reaches the core from outside. The core knows nothing about any specific interface, so a CLI, a web UI, an HTTP API or a chat bridge is each just an interface extension over the same surface, and several can run at once.

```ts
type Scope = { global: true } | { project: string };
type AskId = string;

interface FactoryCore {
  // projects (§3.5)
  createProject(name: string, repo: RepoRef): Promise<Project>;   // same call whether or not the repo exists
  getProject(name: string): Promise<Project>;
  listProjects(): Promise<Project[]>;
  // runs (§4)
  startRun(project: string, request: Omit<Request, "id" | "project">): Promise<RunId>;  // → RECEIVED
  getRun(run: RunId): Promise<RunView>;         // viewState() of the run Document: state, rounds, pending ask, artifacts, conversation IDs, cost
  listRuns(filter?: { project?: string; states?: RunState[] }): Promise<RunView[]>;
  getConversation(run: RunId, conversationId: string): Promise<TranscriptView>;  // read-only: role Conversations and the builder's helpers
  cancelRun(run: RunId, reason?: string): Promise<void>;   // abort from any non-terminal state → CANCELLED
  retryRun(run: RunId): Promise<void>;                     // FAILED / CANCELLED → the state at failure
  // answers to the run's pending ask (§3.2 Question); rejected unless that ask is pending
  answer(run: RunId, ask: AskId, text: string): Promise<void>;                  // discussion question
  approve(run: RunId, gate: Gate): Promise<void>;
  reject(run: RunId, gate: Gate, feedback: string): Promise<void>;              // spec → DISCUSSING; delivery/merge → one blocking human finding
  submitHumanFindings(run: RunId, gate: "delivery" | "merge", findings: HumanFinding[]): Promise<void>;  // structured reject: each is blocking, source: human
  resolveEscalation(run: RunId, ask: AskId,
                    choice: { accept: true } | { moreRounds: number } | { abort: true }): Promise<void>;
  // a message to the agent the run is with; never moves the run (rules below)
  message(run: RunId, text: string): Promise<{ message: string; to: Role; conversationId?: string }>;
  getScreenshot(run: RunId, id: string): Promise<{ mime: string; bytes: Uint8Array }>;  // a QA screenshot (§3.7); the web serves it at GET /api/runs/<run>/screenshots/<id> behind the access token
  // settings (§6)
  settingsSchema(): Record<string, SettingField>;          // the core's schemas + every installed extension's
  getSettings(scope: Scope): Promise<EffectiveSettings>;  // each value with its source: default | global | project
  setSetting(scope: Scope, path: string, value: unknown): Promise<void>;  // validate on save; invalid → rejected, file unchanged
  unsetSetting(scope: Scope, path: string): Promise<void>;                // project scope: back to inheriting
  // events
  subscribe(filter: { project?: string; run?: RunId }, on: (e: FactoryEvent) => void): Unsubscribe;
}
type HumanFinding = { severity: string; description: string; specRef?: string; evidence?: string };  // shape of §3.4, blocking: true, source: "human"

type FactoryEvent =
  | { type: "run.state"; run: RunId; project: string; from: RunState | null; to: RunState; round: number }
  | { type: "run.ask"; run: RunId; ask: AskId; question: Question }          // discussion, approval or escalation is pending
  | { type: "run.askResolved"; run: RunId; ask: AskId; by: string }          // by = the interface that answered
  | { type: "run.notice"; run: RunId; notice: Notice }                       // progress and final result (url, advisory findings)
  | { type: "conversation.updated"; run: RunId; conversationId: string; role: Role }
  | { type: "run.message"; run: RunId; message: { id: string; to: Role; conversationId?: string } }  // sent, then handed to a Conversation
  | { type: "settings.changed"; scope: Scope; path: string };
```
- **Pending asks are core state.** The core persists each Question in the run Document and publishes it as `run.ask`; it survives restarts and `getRun` returns it, so an interface that connects later still sees it. Any interface may answer; the first valid answer resolves the ask, and later answers are rejected.
- **Messages reach the agent the run is with.** The architect from `RECEIVED` through the spec gate, the current reviewer while `REVIEWING` (the QA agent and the builder's helpers take no messages, and `policy.messages` cannot list `qa` or `helper`), the builder otherwise (including the delivery and merge gates and escalations). A message is refused (`conflict`) on a terminal run, while a discussion question is pending (that takes `answer`), or when the role is not in `policy.messages`. `RunView.messages` records each message with its sender (`by`) and, once handed over, its Conversation.
  - *Delivery:* the message goes into the Conversation's inbox as a steer (Pi Durable's `whenBusy: "steer"`): a working agent sees it after its current tool round and carries on; an idle agent answers it in a turn of its own. A role that hasn't started yet, or that the core is about to drive, gets the message right after the core's own input instead. The agent sees a header naming the sender and a note on where the run is (e.g. "you are building; you still finish with report_done").
  - *It never moves the run:* only bridge calls the core is waiting on and the human's answers move it. The one case where a message can change an artifact is the spec gate: the architect may revise the spec with `submit_spec` (§3.4), which closes the pending ask (`run.askResolved` with `by: "architect"`) and asks for approval of the new version.
  - *No unreviewed delivery:* if the builder or a helper it spawns changes files after the review (for example after a message at the delivery gate), the core sees a different diff when it starts delivering and sends the run back through review and AQ testing (and the delivery gate, if set) first.
  - *Cost:* turns a message starts while the agent is idle are recorded as cost records with `trigger: "message"`, in the role's current round.
- **Intake uses the same entry point.** For each Request an intake extension delivers, the core calls `startRun` itself. Results reach intakes through `writeBack` and interfaces through events.
- **Transport belongs to the extension.** One process owns the storage and the core. An interface that runs elsewhere (a terminal client, a web server, a chat bridge) brings its own transport to that process; the core defines none. The `cli` extension uses a Unix socket; the `web` extension serves HTTP on localhost (`POST /api/op/<op>` for operations, server-sent events for `subscribe`) behind an access token.

*Example interface, not part of the core:* a CLI extension might map `createProject` to `factory project create`, `startRun` to `factory run`, `getRun`/`subscribe`/`getConversation` and the answer operations to `factory attach <run>`, `cancelRun`/`retryRun` to `factory cancel`/`factory retry`, and the settings operations to `factory settings`.

### 3.7 AQ testing (agentic QA) on boat.dev **[decided]**
AQ testing is the optional stage in which a QA agent uses the product like a user (§2). It runs in a [boat.dev](https://docs.boat.dev) sandbox: a full Linux VM (4 vCPU / 8 GB by default) with Docker and the usual toolchains, a desktop (Xorg, 1920x1080) and Chrome. A `Boat` class (`src/boat/`) gives the QA agent its environment with the same shape as `Sandbox` (`provision`, `env`, `dispose`); the core calls it directly, over boat's HTTP API (`@boatdev/sdk`). Every other role, the reviewer included, stays in the local `Sandbox`.
- **When it runs:** on entering `REVIEWING`, if `qa.enabled` is on for the project and one of `boat.runScripts` exists at the reviewed commit. Otherwise the core skips it and the round is the review alone (§2).
- **Where the app runs:** `Boat.provision` creates a VM with `noEnv: true` (none of the boat account's secrets, GitHub access or model keys go in) and an `Idempotency-Key` from run + round, so a resume after a crash finds the same VM. It copies in the reviewed commit as a git bundle (the remote may not exist yet, and the VM gets no GitHub access), runs the repo's setup script (`sandbox.setupScripts`), then starts the first run script that exists (`boat.runScripts`) in the background. The product runs inside the VM, and the QA agent reaches it on `localhost` at the URL `AGENTS.md` gives; no public URL is opened (`boat host` is not used). The QA agent may restart the product itself. If the setup or run script fails, the QA Conversation still opens, with the script's output in its input: a product that does not boot from a clean checkout is a blocking finding like any other, with a screenshot of the failure in the terminal.
- **Lifecycle:** one fresh VM per round, like the QA Conversation, named `factory-<runId>-<round>`. `Boat.dispose` permanently deletes it (VM and snapshots) once the QA agent has submitted, and when the run is cancelled, fails or is delivered. `boat.ttl` is the backstop: when it runs out boat stops the VM, which ends compute billing but keeps a snapshot of the code. So at startup the core also lists its VMs by name and deletes any whose run is not in `REVIEWING` for that round (orphans of a crash or of a factory that was down). If the ttl stops a VM while its QA agent is still working, the next tool call resumes it from the snapshot, the core restarts the run script, and the QA agent is told the product was restarted.
- **Persisted state and resume:** the run Document records, per round, the QA Conversation id, the VM id and attempt, its status (`provisioning` / `ready` / `disposed`), the round's QA status (§2) and each submission as it arrives: `submit_review` and `submit_qa` commit separately. After a crash in `REVIEWING` the core resumes both Conversations where they stood (Pi Durable), waits only for the submission still missing, and calls `Boat.provision` again with the same `Idempotency-Key`, which returns the same VM. A stopped VM is resumed and the product restarted; a deleted or broken one is replaced (key + attempt) and the QA agent is told. Screenshots already taken survive, because the core stores each one when it is taken, outside the VM.
- **When boat fails:** boat API calls retry with backoff (3 attempts). If boat still cannot provide a working VM for the round (outage, quota, a key it refuses), the round goes ahead as the review alone with QA status `unavailable` and a `run.notice`; the run neither fails nor escalates. This holds for the final round too: the run delivers without QA, and the delivery note and final report state the QA status as `unavailable` (a run that finishes on its own and says so is more useful than one that waits on boat).
- **Screenshots:** stored by the core at `~/.factory/artifacts/<runId>/screenshots/<id>.png` (under `~/.factory`, which every sandbox's `denyRead` hides) and referenced by id from the run Document. They live as long as the run's record, are served to the web UI through `getScreenshot` (§3.6), and are never committed to the repo or sent to GitHub.
- **Tools:** the QA agent's `env().exec` runs commands in the VM (boat's commands API) and its file readers read the VM's checkout, so the product it clicks through is the reviewed build. Its fixed tool set is read-only file tools, `bash` in the VM (to start, restart or inspect the product), `web_search` and `computer`, which drives the VM's desktop through the Cua Driver that boat preinstalls (`cua-driver call <tool>` against the desktop daemon, run through the same `env().exec`): `get_window_state` (a screenshot plus the accessibility tree), `click`, `type_text`, `press_key`, `scroll`, `launch_app`, and `browser_navigate`, `browser_click`, `browser_type`, `get_browser_state`. Each screenshot is shown to the model and stored under an id the QA agent can cite in a finding's `screenshots` (§3.4). The QA prompt asks for a screenshot of one window, not the whole desktop, to keep images small.
- **Read-only still holds:** the VM holds a throwaway copy; nothing in it flows back to the run's worktree, so only the builder and its helpers write it. The QA agent has no write or edit tools.
- **Credential:** the boat API key is a reference, `boat.apiKey` (default `env:BOAT_API_KEY`), like `webSearch.apiKey`; only `Boat` in the factory process resolves it, and it never enters any VM or sandbox. A scoped boat key (create, list, commands, files, delete) is enough. The key's value is never written to the config file, the run Document, a transcript or the log; the pinned config holds only the reference. With `qa.enabled` and the key unresolved, the run fails at `PREPARING`, before any work, with an error that names both fixes (set the key, or `qa.enabled: false` for the project); a project with QA off never needs a key. Validate on save does not resolve the key (it may live only in the daemon's environment); `doctor` reports a `FAIL` for every scope where QA is on and the key does not resolve. With QA on by default, an install without a boat key therefore fails every new run at `PREPARING` until the human sets one or turns QA off: loud and at the start, like the factory's other credential problems.
- **Settings** (layered and pinned like the rest, §6): `qa.enabled` (default `true`) turns the stage on or off; `boat.apiKey`, `boat.size` (`small` / `default` / `large`, default `default`), `boat.ttl` (default `1h`) and `boat.runScripts` (default `[scripts/run.sh, bin/run]`) configure its VM. Any of them can be set per project: a larger VM for a heavy app, or `qa.enabled: false` for a product without a UI or a project whose code must not leave the machine. With the stage off, the reviewer still runs the product and its tests in the local `Sandbox`, no VM is created, no QA Conversation exists and the QA status is `off`.
- **Cost:** the VM's machine time for the round (boat's usage call) is recorded with the qa role's cost for that round, as a record with no cap, like model cost.

---

## 4. Core state machine **[decided: no model calls]**

The core is a Pi Durable **Task** that checkpoints at every transition, plus a `factory.run` Document that holds the state, round counters (review rounds and CI fix rounds), conversation IDs (per round a reviewer and, when AQ testing runs, a QA agent), the round's QA VM, QA status and the submissions received so far (§3.7), artifact refs (spec, screenshots) and pending ask. The Document also keeps cost (tokens, USD, duration, and the QA VM's machine time) **per role per round**, the qa role included, as a record with no cap, and the hash of the effective config (global values plus the project's overrides, §6) and the Pi version the run started with. The core never calls a model itself. It only creates and configures Conversations for roles, submits input to them, and reads what they commit through the bridge.

| State | Entry action | Exit → next |
|---|---|---|
| `RECEIVED` | `startRun(project, request)` was called, by an interface or by the core for a Request from `intake.pull/subscribe`; pin the effective config | → `PREPARING` |
| `PREPARING` | `repo.open` on the project's repo binding (clone, or a local workspace if the repo doesn't exist yet), `environment.provision` (runs the repo's setup script), `intake.writeBack(started)`; if `qa.enabled`, check that `boat.apiKey` resolves (no VM yet) | ok → `DISCUSSING` · error, or QA on and no boat key → `FAILED` |
| `DISCUSSING` | open architect Conversation (role model) with request + repo context | `ask_human` → pending ask (discussion), `answer` resubmitted (stay) · `submit_spec` → `SPEC_READY` |
| `SPEC_READY` | store spec artifact (and commit it to the workspace as `docs/spec.md`) | gate `spec` on → `AWAITING_APPROVAL(spec)` · off → `BUILDING` |
| `AWAITING_APPROVAL(g)` | pending ask (approval g) | `approve` → next stage (spec → `BUILDING`, delivery → `DELIVERING`, merge → `repo.merge` → `DELIVERED`) · `reject(feedback)` → `DISCUSSING` (spec) / `BUILDING` with the comment as a blocking finding, `source: human` (delivery, merge; adds no review or CI round; `submitHumanFindings` is the same with structured findings) · spec only: the architect revises the spec with `submit_spec` after a human message (§3.6) → `SPEC_READY` with the new version, which closes this ask |
| `BUILDING` | round 1: open builder Conversation with spec · round n>1: **submit findings (review and QA findings, CI failure, or a human rejection comment) to the same Conversation** | `report_done` → `REVIEWING` · round n>1 with empty diff since the previous round → `ESCALATED` |
| `REVIEWING` | open fresh reviewer Conversation in the local sandbox with spec + workspace + `repo.diff(base)` (from round 2 also the diff since the previous review); in parallel, if AQ testing applies (`qa.enabled` and a run script exists, §3.7), `Boat.provision` at the reviewed commit, which boots the product, then open fresh QA Conversation in that VM with spec + `AGENTS.md` (+ the script output if setup or the run script failed); boat unavailable after retries → QA status `unavailable`, review alone; from round 2, each gets its own prior findings + the builder's responses, and any human findings from a gate rejection. VM id, QA status and each submission are committed as they happen (resume rules in §3.7) | wait for `submit_review` and, if AQ testing runs, `submit_qa`; the round's verdict is fail if either has a blocking finding, and on fail the builder gets both sets · pass (no blocking findings; advisory ones stored for delivery) → gate `delivery` ? `AWAITING_APPROVAL(delivery)` : `DELIVERING` · fail & round < `reviewRoundCap` → `round++`, `BUILDING` · fail & round = `reviewRoundCap` → `ESCALATED` · a review that follows a CI fix counts toward `ci.fixRounds`, not `reviewRoundCap`: fail & CI fixes < `ci.fixRounds` → `BUILDING` · fail & CI fixes = `ci.fixRounds` → `ESCALATED` · on every exit `Boat.dispose` (if a VM was provisioned); cited screenshots are kept as run artifacts |
| `ESCALATED` | pending ask (escalation), resolved by `resolveEscalation` | accept → `DELIVERING`, except when escalated from `AWAITING_CI`: then gate `merge` on for a PR delivery ? `AWAITING_APPROVAL(merge)` : `DELIVERED` · more rounds(N) → the cap that was hit `+=N`, `BUILDING` · abort → `CANCELLED` |
| `DELIVERING` | first, if the workspace diff differs from the one the last review saw (the builder acted on a message after the review): → `REVIEWING` with a fresh reviewer (and QA agent, if AQ testing applies), adding no round · otherwise, if `ws.newRepo`: `repo.create` then `delivery.deliver` as `push-main`; else `delivery.deliver` as a PR (advisory findings go into the PR description / delivery note) | ok & `ci.mode` ≠ `off` → `AWAITING_CI` · ok & `ci.mode` = `off` → gate `merge` on for a PR delivery ? `AWAITING_APPROVAL(merge)` : `DELIVERED` · error → `FAILED` |
| `AWAITING_CI` | wait for CI on the delivered commit SHA: the PR head, or for `push-main` the pushed commit on the default branch (`delivery.checks`, limited to `ci.checks` if set) | no checks within `ci.noChecksTimeout` & `if-present` → same as CI green, noting no CI · no checks within `ci.noChecksTimeout` & `required` → `ESCALATED` (reason: no CI checks) · CI green → gate `merge` on for the project and a PR delivery ? `AWAITING_APPROVAL(merge)` : `DELIVERED` · CI red & fixes < `ci.fixRounds` → `BUILDING` with CI failure (the review after the fix counts toward `ci.fixRounds`, not `reviewRoundCap`) · CI red at cap → `ESCALATED` · error → `FAILED` |
| `DELIVERED` | `intake.writeBack(done, url)`, `run.notice` event (with the final QA status), `environment.dispose`, `Boat.dispose` of any VM still live; without an approved merge the PR stays open (no auto-merge) | terminal |
| `FAILED` / `CANCELLED` | `writeBack`, `run.notice` event, dispose (workspace and screenshots kept for inspection; any QA VM deleted) | terminal; `retryRun(run)` → state at failure |

Every transition is also published as a `run.state` event (§3.6); that is how interfaces follow a run. `intake.writeBack` applies only to runs whose Request came from an intake.

Invariants:
- A transition either commits atomically with its checkpoint or does not happen at all.
- Layer-2 calls are idempotent and keyed by `runId + state + round`. For example, `delivery` reuses the existing PR, `ask` reuses a pending question, and `Boat.provision` reuses the round's VM through its `Idempotency-Key` (run + round + attempt).
- A human can abort a run from any non-terminal state (`cancelRun`). Cancelling aborts the builder's calls, and with them any helpers still running; the worktree is kept, as for any cancelled run.
- **Helpers across a crash:** the core keeps no state for helpers and rolls nothing back. The worktree is on disk, so every write that landed before the crash is still there. On resume the builder's `subagent` call reruns (it is replay-safe), finds the same helper Conversation and the same submission, and the helper carries on from its transcript (Pi Durable). A helper tool call that was in flight (`write`, `edit` or `bash`) is not rerun: the helper gets an `interrupted` result, and its change may or may not have landed, possibly in part. So the working tree, not a transcript, is the record. The helper re-reads what it was changing before it goes on, and the builder reconciles from the working tree (`git status`, `git diff`, the tests) before `report_done`, as it does after every helper. A helper call that fails outright returns an error to the builder, which reconciles the same way. The core adds no step for any of this.
- A run is pinned to the effective config (global values plus its project's overrides) and Pi version it started with, and resumes on them even after an upgrade. A run whose pinned config predates AQ testing (no `qa` key) resumes with QA off, so a resumed run never gains a stage it did not start with.

---

## 5. Config schema example

> Superseded: there are no `stages`, `workers` or `roles.<role>.extensions`. See the cleanup spec's [§2](superpowers/specs/2026-10-09-fixed-architecture-cleanup-design.md#2-settings-and-data-flow) and [configuration.md](configuration.md) for the current paths.

Config is plain data, versioned in a repo or at `~/.factory/`. It maps roles to models and stages to extensions, and it sets policy. **[decided]**

```yaml
version: 1
roles:                                   # role → model (+ worker extensions)
  architect: { model: anthropic/claude-opus, thinking: high,   extensions: [coding-readonly, docs] }
  builder:   { model: anthropic/claude-opus, thinking: high,   extensions: [coding, subagent, test-runner] }
  helper:    {}                                                     # the builder's helpers (they write code); unset = the builder's model and thinking
  reviewer:  { model: openai/gpt-6-sol,    thinking: high,     extensions: [coding-readonly, test-runner] }   # spec, tests, code quality and security; local sandbox
  qa:        { model: anthropic/claude-sonnet, thinking: medium, extensions: [coding-readonly, computer] }   # AQ testing in the boat.dev VM (§3.7)
stages:                                  # stage → factory extension (+ its settings)
  intake:    { use: none }                                 # external request sources (GitHub issues, webhooks); none in v1, runs start via startRun (§3.6)
  interface: { use: [cli, web] }                           # one or more interface extensions (§3.6); default: all installed
  repo:      { use: github, identity: { kind: app, appId: 123, installationId: 456 }, visibility: private }
  delivery:
    use: github-delivery
    newRepo: push-main
    existingRepo: pull-request
    ci:                                  # owned by the delivery extension
      mode: if-present                   # default; off | if-present | required
      fixRounds: 2                       # default; range 0–3
      checks: []                         # optional: names of the checks that count; empty = all
      noChecksTimeout: 2m                # default; no checks by then = the repo has no CI
  environment:                           # alt: docker, gondolin
    use: local-worktree
    root: ~/factory/work
    sandbox:                             # @anthropic-ai/sandbox-runtime; wraps every exec in this env
      allowedDomains: [registry.npmjs.org, pypi.org, files.pythonhosted.org, proxy.golang.org]
      deniedDomains: []
      denyRead: [~/.factory, ~/.ssh, ~/.config/gh]
      extraWrite: []                     # added to the run's worktree + scratch dir; default empty
qa: { enabled: true }                    # AQ testing stage (§3.7); default on
boat: { apiKey: env:BOAT_API_KEY, size: default, ttl: 1h, runScripts: [scripts/run.sh, bin/run] }   # its VM
storage: { kind: sqlite, path: ~/.factory/factory.sqlite }
policy:
  approvals: [spec]                      # default; any of: spec, delivery, merge
  reviewRoundCap: 3                      # default
  escalateOnNoProgress: true             # default; escalate when a fix round leaves an empty diff
projects:                                # project records (§3.5): repo binding + overrides; same paths as above, unset = inherit
  payments:
    repo: acme/payments                  # binding; the repo may not exist yet (created on first delivery)
    policy: { approvals: [spec, delivery, merge] }
    roles:  { reviewer: { thinking: medium } }
    stages: { delivery: { ci: { mode: required } } }
    qa:     { enabled: false }           # e.g. a headless service: the reviewer alone, in the local sandbox
```

---

## 6. Settings **[default, changeable]**

> Superseded: the setting paths, extension-owned schemas (`Configurable`) and the `factory settings` CLI. The schema is the core's alone, and the web UI's Settings view is the editor. See the cleanup spec's [§2](superpowers/specs/2026-10-09-fixed-architecture-cleanup-design.md#2-settings-and-data-flow) and [configuration.md](configuration.md).

Settings are a view over the config file (§5), not a second store. Config stays plain data; the core reads, validates and writes it through the settings operations (`settingsSchema`, `getSettings`, `setSetting`, `unsetSetting`, §3.6), each taking a scope: global or one project. Interfaces render these operations, for example as a menu.

*Example interface, not part of the core:* a CLI extension might expose them as:
```
factory settings                                   # interactive menu: Policy · Roles · Stages
factory settings get roles.reviewer.thinking       # → high   (global)
factory settings set roles.reviewer.thinking medium
factory settings --project payments                # same menu, edits that project's overrides
factory settings set --project payments policy.approvals '[spec, delivery, merge]'
factory settings set --project payments stages.delivery.ci.mode required
factory settings unset --project payments roles.reviewer.thinking   # back to inheriting the global value
```
Every value is shown with its effective value and where it comes from: `default` (the schema), `global` (the config file) or `project` (`projects.<name>`). Project overrides can be set as soon as the project exists, before its repo does. Paths are the config paths from §5.

**Layering:** every setting resolves in the same layers: schema default → global (top level of the config file) → project (`projects.<name>`). Any setting can be overridden per project with the same path: policy (including approval gates), role models, thinking and extensions, the sandbox, AQ testing and its VM, and every stage extension's settings, including CI. A project value overrides the global one, and a value the project leaves unset inherits it. Objects merge key by key; scalars and lists replace as a whole (a project's `approvals` replaces the global list). `storage` is global only, because one process owns it.

**What can be configured**
- **Policy** (core): approval gates (default `[spec]`), `reviewRoundCap` (default 3), `escalateOnNoProgress` (default on), `messages` (the roles a human can message while a run is going, §3.6; default architect, builder and reviewer; drop the reviewer for a review no human can sway; `qa` is not a valid value).
- **CI** (owned by the delivery extension, `stages.delivery.ci`): `mode` (`off` / `if-present` / `required`, default `if-present`; see §2), `fixRounds` (default 2, allowed range 0–3, enforced by validate-on-save), `checks` (optional list of check names that count; default all) and `noChecksTimeout` (default 2 minutes; if no checks appear by then, the repo is treated as having no CI).
- **Roles** (core): for each of architect, builder, helper, reviewer and qa (the AQ testing agent): `model` (from the providers `createModels()` knows), `thinking` (`off` / `low` / `medium` / `high`) and `extensions` (superseded: tool sets are fixed, §3.3). `roles.qa` defaults to `anthropic/claude-sonnet-5-5`, `medium`, and its model must accept image input, because it works from screenshots. `roles.helper.model` and `roles.helper.thinking` have no defaults of their own. Unset, each takes the builder's effective value, because helpers now write production code; set them (globally or per project) to use cheaper helpers **[default, changeable]**. A builder model without image input gets QA findings as text with screenshot ids.
- **Workers** (owned by each worker extension, `workers.<name>`, §3.3): e.g. `workers.web-search.mode` (`turbo` / `fast` / `basic` / `advanced`, default `fast`) and its API key reference.
- **AQ testing** (core, §3.7): `qa.enabled` (default on) turns the stage on or off; `boat.apiKey` (secret reference, default `env:BOAT_API_KEY`), `boat.size` (`small` / `default` / `large`), `boat.ttl` (a duration, 10 minutes to 24 hours, default `1h`) and `boat.runScripts` (a non-empty list of repo-relative paths, default `[scripts/run.sh, bin/run]`) configure its VM. All of them are global with per-project overrides like every other setting, `boat.apiKey` included (a project may bill a different boat account). Set `qa.enabled: false` on a project without a UI, or whose code must not leave the machine. A config file without `qa` or `boat` keys gets the defaults, so AQ testing is on for every project and needs a boat key (§3.7); there is nothing to migrate.
- **Sandbox** (owned by the default environment extension, `stages.environment.sandbox`): `allowedDomains`, `deniedDomains`, `extraWrite`, `denyRead`. Write access is fixed by role (§3.3) and is not a setting: the architect and reviewer never get write access to the worktree, the QA agent only ever touches its VM's throwaway copy, and only the builder and its helpers (in the builder's environment) write it.
- **Stage extensions** (intake, interface, repo, delivery, environment): which extension each stage uses, plus that extension's own settings, e.g. the GitHub identity under `stages.repo`. `stages.interface.use` defaults to every installed interface, so the CLI and the web UI run side by side; the web UI's address is `stages.interface.host` (default `127.0.0.1`) and `port` (default 7317). Secrets are stored as references (env var name or secret-store key), never as values.

**Architecture**
```ts
type SettingField =
  | { type: "string" | "number" | "boolean" | "secretRef"; default?: unknown; description: string; min?: number; max?: number }
  | { type: "enum"; values: string[]; default?: string; description: string }
  | { type: "list"; of: SettingField; default?: unknown[]; description: string }
  | { type: "object"; fields: Record<string, SettingField>; description: string };

interface Configurable {                        // implemented by any factory extension and the environment extension
  settings?: { schema: Record<string, SettingField>;
               validate?(value: unknown): string[] };   // extra checks beyond the schema; returns problems
}
```
- The core owns only the policy and role schemas. Each extension declares its own schema through `Configurable`, and its settings live under it (the sandbox under the environment extension, the GitHub identity under the repo extension, CI under the delivery extension).
- Interfaces generate their settings views (a menu, a form) from `settingsSchema()`, not hand-coded per extension, so a newly installed extension shows up in them automatically.
- **Validate on save:** a change is checked against the schema, the extension's `validate`, and the core's rules (for example, the §3.3 write limits), applied to the resulting effective config of each affected project. The AQ testing rules are: `boat.ttl` parses as a duration in range, `boat.runScripts` is non-empty with no absolute paths or `..`, `boat.apiKey` is a reference (`env:` / `file:` / `store:`), never a value, and `roles.qa.model` accepts images. Whether the key resolves is a run-time and `doctor` check, not a save check. An invalid change is rejected and the file is left unchanged.
- A change applies to **new runs only**. A running run stays pinned to the effective config it started with (§4).

**Not configurable:** cost caps (rejected earlier; cost is recorded, not capped, boat VM time included), per-role write access and tool sets (fixed by role, §3.3), the QA evidence rules (§3.4), messaging the QA agent or a helper, how the builder uses helpers (how many, what they do; that is the builder's call), and any setting that lets the builder escalate or ask the human mid-build. (Messages go from the human to the agent only; the builder still cannot ask the human anything.)

---

## 7. v1 scope

**In**
- Core state machine on Pi Durable with SQLite storage; resume after a crash.
- Core operations and events (§3.6): projects (`createProject`, §3.5), runs (`startRun`, `getRun`, `listRuns`, `cancelRun`, `retryRun`), answers at asks and gates (`answer`, `approve`, `reject`, `submitHumanFindings`, `resolveEscalation`), messages to the running agent (`message`), settings, and `subscribe`.
- Intake: none. Runs start through `startRun` from an interface.
- Interface `web` (installed and on by default): a local web UI. A ticket board whose columns are the pipeline stages, where each run moves on its own as the core transitions it, and a full-screen run view for any run at any time: the run's conversations (architect, builder with its helpers, reviewers, QA agents, a timeline), the transcript with every tool call shown the same plain way (a QA agent's `computer` calls with their screenshots inline), a chat box addressed to the agent the run is with (`message`), and approvals and escalations in a card that floats over the conversation. Ticket details, findings by round, cost by role (boat VM time with qa) and settings forms generated from `settingsSchema()` complete it. Static files, no build step.
  - *Where the human judges:* findings are grouped by round and labelled by source (reviewer, QA, human, CI); each QA finding shows its screenshots as thumbnails that open full size (`getScreenshot`). The delivery and merge approval cards and the escalation card show the final round's findings, blocking and advisory, with their screenshots and the round's QA status (`ran` / `off` / `skipped` / `unavailable`), so the human can judge without opening transcripts. The ticket shows a QA chip next to the review round.
- Interface `cli` (one example interface extension): terminal commands over the core operations, e.g. `factory project create <name> --repo owner/name`, `factory run <name> "<request>"` (with a shorthand that also creates the project) and `factory attach <run>`. Attach renders `getRun` (the run Document's `viewState()`) and the active role Conversation through `getConversation` (including the builder's helpers, found through tool `details`), follows events, and answers pending asks and approvals. One process owns the storage; the CLI client connects to that process.
- Repo `github`: `open` (clone, or a local workspace before the repo exists), `create` (private repo, at the first delivery), `diff`, `merge`. The identity is configurable (PAT, bot or App).
- Delivery `github-delivery`: push to `main` for a new repo, open a PR from a branch for an existing repo.
- Environment `local-worktree` (one git worktree per run, commands wrapped in the sandbox runtime). Tools: `CodingTools`, Pi's subagent pattern and `web-search` (§3.3).
- Build: one builder that may spawn helpers with write tools in the same worktree to build parts in parallel (§2); the core does not coordinate them.
- Review: one reviewer per round in the local sandbox, covering the product against the spec, the tests, and code quality and security (§2).
- AQ testing on boat.dev (§3.7), on by default and switchable per project (`qa.enabled`): one VM per round with the product running, and the QA agent's `computer` tools (screen, clicks, typing, browser, screenshots as evidence), in parallel with the review.
- Policy: approval gates, round cap. CI setting: `off` / `if-present` / `required`, fix rounds, checks that count, no-checks timeout.
- Settings: the settings operations (layered global + project overrides), with views generated from the core's and extensions' schemas; the `cli` extension exposes them as `factory settings` (interactive menu, `get`/`set`/`unset`, `--project`).

**Out (later)**
- Other intakes (GitHub issues, webhooks) and other interfaces (chat bridges, a hosted multi-user web UI).
- Container or microVM environments.
- Concurrent runs on the same repo.
- Learning from past runs.

**Later / optional**
- Reviewer-only scenarios (`policy.holdoutScenarios`): the acceptance behaviours are shown only to the reviewer, not the builder, so they work like a holdout set the builder can't game.

---

## 8. Trial plan **[default, changeable]**

The trial drives the core through the v1 `cli` interface extension; each step names the core operation, and the CLI command is just how that interface exposes it.

1. **Zero-to-MVP:** `createProject("todo", <me>/todo)` then `startRun("todo", "CLI todo tool: add/list/done/remove, JSON file storage, tests")` (the repo doesn't exist yet; via the CLI shorthand, e.g. `factory run todo --repo <me>/todo "…"`).
   - Expect a short discussion (language, storage format, CLI library) and then a spec approval.
   - The build runs unattended and finishes with a passing review, possibly after one or more fix rounds.
   - Delivery is a **new private repo**, pushed to `main`, with the code, tests, README and `docs/spec.md`.
2. **Incremental:** `startRun("todo", "add due dates and an --overdue filter")` (e.g. `factory run todo "…"`). Expect a **PR** on the same repo that passes review, with the spec as the only approval.
3. **Fault checks during the trial:**
   - Kill the process mid-build and confirm the run resumes at the same round.
   - Helpers write: on the zero-to-MVP run, confirm the builder has at least one helper write files (the helper's `write`/`edit` calls in its transcript). Confirm those files are in the round's diff, are reviewed, and are in the delivered repo. Then kill the process while a helper is writing, and confirm that on resume the same helper Conversation carries on, the files it wrote before the kill are still in the worktree, the builder reconciles from the working tree (`git status`/`git diff`) before `report_done`, and the run goes on to review with no step added by the core.
   - Force a review failure and confirm the same builder Conversation receives the findings. Plant a security hole that no spec clause mentions and confirm the reviewer's blocking finding fails the round.
   - On a project with a web UI, break one UI flow and confirm the QA agent's blocking finding, with a screenshot, fails the round and reaches the builder alongside the reviewer's findings. Set `qa.enabled: false` on that project and confirm the next run's rounds are the review alone, with the reviewer running the product and tests locally.
   - Kill the process while the QA agent is working. Confirm the run resumes in `REVIEWING` with the same VM (same `Idempotency-Key`) and the same QA Conversation, keeps any submission already made, and that no VM named for the run is left once the run ends. Delete the VM by hand while the factory is down and confirm the startup sweep and a replacement VM handle it.
   - With `qa.enabled` on and no boat key, confirm a new run fails at `PREPARING` with a message naming both fixes, and `doctor` reports it. Set `boat.ttl` to `30s` and confirm the change is rejected.
   - Hit the round cap and confirm it escalates.
   - Reject the spec once and confirm the run returns to the discussion.
   - On the incremental run, with the `delivery` and `merge` gates on for that project, reject once at each gate. Confirm the same builder receives the comment as a blocking `source: human` finding, no review or CI round is added, and the next reviewer sees that finding.
   - Set `stages.delivery.ci.fixRounds` to 0, force a CI failure and confirm the run escalates without a fix round.
   - Set `stages.delivery.ci.mode` to `off` and confirm the run finishes at delivery without waiting for CI. Set it to `required` on a repo with no CI checks and confirm the run escalates with "no CI checks" after `ci.noChecksTimeout`. Set it to `if-present` on the same repo and confirm the run finishes and notes that there was no CI.
   - Create a second project for a repo that doesn't exist (`createProject("todo2", <me>/todo2)`), set `stages.delivery.ci.mode` to `required` on it (`setSetting({ project: "todo2" }, …)`), then start its first run with `startRun("todo2", "…")`. Confirm the builder ships a CI workflow, and the run waits for and passes CI on the pushed commit on `main`.
4. **Settings checks:**
   - Start a run, then change the reviewer's model and thinking level with `setSetting` (e.g. `factory settings set`). Confirm the next new run's reviewer uses them and the in-flight run's reviewer does not.
   - Set an invalid value with `setSetting` (e.g. `stages.delivery.ci.fixRounds 5`) and confirm it is rejected and the config file is unchanged.
5. **Pass criteria:**
   - Both deliveries happen with human input only for the discussion and the spec approval.
   - The reviewer's own test run passes on each delivery, and CI is green on every delivery where the repo has checks.
   - No agent reached GitHub except through the core, and the boat key appears in no transcript, log, run Document or VM.
   - Each delivery note states the final round's QA status.
   - Cost per role per round and round counts are recorded in the run Document.
   - The repo is throwaway; delete it afterwards.

**Open risks:**
- Pi Durable API churn: pin the version.
- Reviewer leniency: give the reviewer a different model family by default, and tune its prompt from transcripts.
- AQ testing VM (boat.dev, §3.7): the reviewed code leaves the machine for a third-party cloud VM, and that VM has open outbound internet (`sandbox.allowedDomains` does not apply there). It holds no secrets (`noEnv`, no GitHub access, the boat key stays in the factory), so what is exposed is the code itself. A VM the ttl stopped keeps a snapshot of that code until the core deletes it (§3.7 startup sweep). A project that must keep its code local sets `qa.enabled: false`.
- Helpers writing at once: two helpers can change the same file or make changes that don't fit together. Pi serializes `write`/`edit` calls to one file within the process, so single writes don't tear, but nothing stops one helper's change from overwriting or contradicting another's, and `bash` (formatters, codegen, `git`) is not serialized at all. Concurrent `git commit`s race on the index lock, which is why the builder makes the commits by default. The core adds no locks or merge step. The builder is responsible: it decides how to split the work, checks the working tree and runs the tests before `report_done`, and the reviewer judges the result whoever wrote it. If transcripts show this going wrong often, the fix is the builder's prompt, not ceremony in the core.
- Helper cost: helpers inherit the builder's model by default and can run in parallel, so a build can cost more than with one writer. Their usage is recorded as the builder's cost (through the `subagent` call), not capped; set `roles.helper` to a cheaper model if that matters.
- Reviewer over-strictness: blocking code-quality and security findings no longer need a spec clause, so a reviewer could block on taste. The prompt keeps blocking for real problems (security holes, bugs, deleted or weakened tests, structure that will not hold up), everything else is advice, and the round cap bounds the cost.
- Sandbox residual risks. The sandbox closes the shell's open network path from earlier drafts, but some risk remains:
  - **Allowlisted domains:** the proxy filters by host name and does not inspect traffic. Any allowed domain is a possible exfiltration channel: package registries accept uploads, and domain fronting may get around the filter. Keep the list short, and never add broad hosts like `github.com`.
  - **Escapes and bugs:** this is a beta research preview, so it can have escape bugs. A worktree with write access (the builder and its helpers alike) can also plant hooks or scripts that run later outside the sandbox. Mitigations: pin the version, never let repo-local config widen the sandbox, and run `delivery`/CI outside the run's machine.
  - **Platform support:** v1 targets Linux and macOS. Linux needs `bubblewrap` and `socat`; Ubuntu 24.04+ AppArmor can block bubblewrap's user namespaces; macOS has no PID namespace; Windows is alpha. Inside Docker the runtime needs `enableWeakerNestedSandbox`, which weakens it considerably, so the later container envs must provide their own isolation.

---

## 9. Required follow-on changes

The code and the user docs still describe the reviewer with `browser` and no QA stage. To implement §2–§8 as they stand:

**`src/core/settings.ts`**
- `coreSchema().roles`: add `qa: roleField("anthropic/claude-sonnet-5-5", "medium", "QA agent: uses the product in a boat.dev VM (AQ testing)")`; reword `reviewer` to "whole product vs spec, tests, code quality and security".
- Add `qa: { enabled: boolean, default true }` and `boat: { apiKey: secretRef "env:BOAT_API_KEY", size: enum small|default|large "default", ttl: string "1h", runScripts: list of string ["scripts/run.sh", "bin/run"] }`. Neither goes in `GLOBAL_ONLY`.
- Leave `policy.messages` without `qa`.

**`src/core/core.ts` (`coreRules`)**: `boat.ttl` parses with `parseDuration` and is 10m–24h; `boat.runScripts` is non-empty, relative, no `..`; `roles.qa.model` has image input.

**`src/core/types.ts`**: `Role` gains `"qa"`; `Finding.source` gains `"qa"` and `Finding` gains `screenshots?: string[]`; `RunView.conversations` gains `qa: { id; seq }[]` and `RunView` a per-round `qaStatus`; `FindingsLogEntry.kind` gains `"qa"`; `Notice` gains `qaStatus`; `FactoryCore` and `CORE_OPS` gain `getScreenshot`.

**`src/core/findings.ts`**: `specRef` optional for reviewer findings and the "evidence" wording (command and output, or file and lines); a new `validateQa` (evidence and at least one screenshot this agent took this round per finding; `source: "qa"`); `formatFinding` lists screenshot ids.

**`src/core/bridge.ts`**: `submit_qa`; `submit_review` description updated.

**`src/core/run-doc.ts`**: per-round QA state (conversation, VM id, attempt, status, QA status, submissions), `conversations.qa`, screenshot refs.

**`src/core/run-task.ts`**: the `PREPARING` key check; `REVIEWING` runs reviewer and QA in parallel, commits each submission on arrival, combines verdicts, handles resume, replacement and `unavailable` (§3.7); builder input carries both sets plus screenshots; reviewer input drops the required `specRef`, adds the code review and the run-script check; `Boat.dispose` on every exit and terminal state; a pinned config without `qa` means QA off.

**`src/core/messages.ts`**: unchanged in behaviour (`REVIEWING` → reviewer); add a test that `qa` is never a target.

**New `src/boat/boat.ts`** (`@boatdev/sdk`): `provision` (`noEnv`, idempotency key, git bundle, setup and run scripts), `env`, `dispose` (permanent delete), `resume`, `sweep` (startup orphan delete by name), usage for cost. Wire it in `src/main.ts`.

**`src/agents/tools.ts` and `prompts.ts`**: `computer` tool (Cua Driver through `env().exec`, screenshots stored via the core); `ROLE_TOOLS.reviewer` drops `Browser`; `ROLE_TOOLS.qa`; keep `Browser` in `AGENT_EXTENSIONS` for resumed old runs; `role-reviewer` (code and security review, `curl` via `bash`) and a new `role-qa`.

**`src/sandbox/sandbox.ts`**: deny the env var or file named by `boat.apiKey` in the runtime's `credentials`, like the GitHub token.

**`src/github/github.ts` (`deliver`)**: QA findings and the final QA status in the PR description and `docs/delivery-notes.md`; no screenshots, only a pointer to the run view.

**`src/web/server.ts` and `ui/app.js`**: the screenshot route; a `Q` role letter and QA conversations in the run view; findings by source with thumbnails; findings, screenshots and QA status on the approval and escalation cards; a QA chip on the ticket; the `qa` and `boat` settings in the generated form.

**`src/cli.ts` (`doctor`)**: check `roles.qa.model` like the other roles; a `FAIL` for each scope with QA on and an unresolved boat key; a `warn` if boat's limits call fails.

**`docs/configuration.md`**: rows for `roles.qa`, `qa.enabled` and `boat.*`; the reviewer row's meaning; the tool table (reviewer without `browser`, a `qa` row); the new validation rules; an "AQ testing" subsection (what leaves the machine, `noEnv`, the scoped key, ttl and snapshots, turning it off per project); under "Old config files": missing `qa`/`boat` keys take defaults so QA turns on and needs a key, and in-flight runs stay QA-off; the example.

**Elsewhere**: `docs/architecture.md` (tool table, flow step 5, roles), `README.md` (roles, `BOAT_API_KEY`), `DEVIATIONS.md` (entries on required `specRef` and "no screenshot evidence" become obsolete), the cleanup spec's `ROLE_TOOLS` (note it is superseded here), tests (`findings`, `settings`, `machine`, `durability`, `messages`, `web`) and the dry run with a fake `Boat` (e.g. `serve --fake-boat`) and a scripted QA agent; regenerate `docs/dry-run-report.md`.

### 9.1 Helpers that write (not yet built)

The code still enforces read-only helpers. To implement the helper changes in §2, §3.3, §3.4, §4, §6 and §8:

**`src/agents/tools.ts`**: `ROLE_TOOLS.helper` becomes `[RoleHelper, Coding, TestRunner, WebSearch]` (was `CodingReadonly`). The `subagent` tool's description drops "READ/ANALYSIS" and "Helpers cannot write files; you stay the single writer": it delegates a task, writing included, and the helper returns a short summary of what it did. The comment "the helper role (model, read-only env)" goes.

**`src/agents/prompts.ts`**: `role-builder` drops "the single writer of this workspace" and "Use helpers … only for reading and analysis; never ask a helper to write". In their place it says the builder may have helpers write code in parallel, owns the result, checks the working tree (`git status`/`git diff`) and runs the tests before `report_done`, and makes the commits itself unless it tells a helper otherwise. `role-helper` drops "never modify files": the helper does the task it was given in the shared worktree. Others may be changing files at the same time, so it re-reads a file before editing it and after an `interrupted` result. It does not commit unless told to, and it ends with a short summary of what it changed.

**`src/core/core.ts` (`conversationCreated` for helpers)**: stop removing `createWriteTool()` and `createEditTool()`. Keep removing the bridge tools. Use the builder's environment (`run.envs.builder`) for `cwd` and `EnvDoc.envId`, not `run.envs.helper`. Take `model` and `thinking` from `roles.helper` if set, else from `roles.builder`. Fix the comment ("read-only").

**`src/core/run-task.ts` (`PREPARING`)**: stop provisioning a `helper` environment. Runs already in flight keep any `envs.helper` they have, but new helpers use the builder's environment.

**`src/sandbox/sandbox.ts`**: no rule change, because helpers use the builder's env record and so its write roots and `denyWrite`. Update the header comment ("only the builder may write … the architect, reviewer and helpers may write only their scratch dir").

**`src/core/settings.ts`**: `roles.helper` gets no `model`/`thinking` defaults (unset = the builder's effective value), and its description becomes "Helpers the builder spawns; they write code (unset = the builder's)". The `builder` description drops "the single writer". Settings resolution, and the web form's "default" source label, must show the builder's value as the helper's effective value.

**`src/cli.ts` (`doctor`)**: check `roles.helper.model` only when it is set (otherwise it is the builder's).

**Tests**: `test/findings.test.ts` "the builder's helper runs with the helper role" expects `write` to succeed (and `helper.txt` in the delivered diff) instead of `write:error`. `test/helpers.ts` drops the scripted helper's "write must fail" premise. `test/machine.test.ts` "read-only roles…" adds the helper's tool list (`bash`, `edit`, `read`, `run_tests`, `web_search`, `write`; no `subagent`, no bridge tools). `test/settings.test.ts`: an unset `roles.helper` resolves to the builder's model and thinking. `test/durability.test.ts`: a new kill -9 while a helper is mid-task, after one `write` has landed, checks that the file survives, that the same helper Conversation resumes and that the run reaches `REVIEWING` (a new `crash-child.ts` mode).

**Dry run** (`scripts/dry-run.ts`, `src/testing/dry-run-agents.ts`): the scripted builder has a helper write one part of the product (e.g. the tests file), and the run checks that file is in the delivered repo. Regenerate `docs/dry-run-report.md`.

**Docs**: `docs/architecture.md` (tool table: `coding-readonly` no longer lists helper, and `coding` does; flow step 4 "the only writer … read-only helpers"; the sandbox bullet "the architect, reviewer and helpers are read-only"). `docs/configuration.md` (the `roles.helper` row: default = the builder's, writes code; the tool table's helper row). `README.md` where it describes the builder's helpers.
