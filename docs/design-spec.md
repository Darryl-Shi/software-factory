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
- Implementation plans or splitting the work upfront. The builder decides how to break up the work. **[decided]**
- Business-specific concepts such as customers, billing or tickets-as-products.
- Telegram or assistant chat as the factory's interface. Every interface is an extension over the core's operations (§3.6); a bridge to either would be one more such extension. v1 ships two interfaces, a terminal CLI with attach and a local web UI (a ticket board with a full-screen run view); both are extensions. **[decided]**
- Multi-tenant hosting and parallel runs on one repo (not in v1). The web UI is single-user and local: it listens on localhost behind an access token.

---

## 2. Flow **[decided]**

```
intake → architecture discussion → spec → [approve spec] → build (one builder + its own helpers)
       → whole-product review vs spec ──fail──► resume same builder with findings (≤ reviewRoundCap, default 3)
                                        └pass─► [approve delivery?] ──reject──► resume same builder, comment as blocking finding
                                                └approve/gate off─► deliver
       → wait for CI on the delivered commit ──fail──► same builder fixes → review → redeliver (≤ ci.fixRounds, default 2) → escalate
                                                  └pass or CI skipped─► [approve merge?] ──reject──► resume same builder, comment as blocking finding
                                                                        └approve─► merge → done
                                                  └pass or CI skipped, merge gate off─► done (PR left open, no auto-merge)
                                                  └pass or CI skipped, push-main (no PR)─► done
```

CI is skipped when `ci.mode` is `off`, or `if-present` and the repo has no checks; with `required` and no checks, the run escalates to the human (§4).

- **Architecture discussion:** Superpowers-style. The architect asks **one question at a time** and grounds each question in the request and the repo, if one exists. It stops when the architecture is settled.
- **Spec:** a single markdown document produced by the architect. It is the only contract between the stages, and both the build and the review are judged against it. It ends with a short list of **acceptance behaviours**: observable, product-level scenarios the reviewer can check. They say what the product does, not how to build it.
- **Repo map:** every workspace has a short `AGENTS.md` (about 100 lines): build, test and run commands, a map of the repo, and a pointer to `docs/spec.md`. The architect, builder and reviewer all read it. New repos ship one; the builder keeps it current on incremental changes.
- **Build:** one builder Conversation. It spawns helpers as it sees fit, as owned Conversations (Pi's subagent pattern). The core never sees or manages those helpers. Builder guidance (in its worker extension's prompt, not the core):
  - commit often, and keep its own short progress log so it keeps state across compaction. The log is the builder's notes, **not an implementation plan**;
  - the git diff against the base (`repo.diff(base)`) is the record of changed files;
  - use helpers only for reading and analysis; the builder is the single writer;
  - ship a working setup/run script, so the reviewer, CI and the next run on the project can boot the product.
- **Review:** a fresh reviewer Conversation checks the **whole product** (not only the diff) against the spec. It has read-only access to the source and cannot modify code, plus tools to execute and run the product (test runner, HTTP client). It reviews in a **review VM** on boat.dev, with a desktop and a browser, where the product is running (§3.7). There it **uses the product the way its user would**: it clicks through the UI flows in the browser (or the desktop app, or the terminal for a CLI) and sees broken screens itself, instead of only calling endpoints. It runs the test suite itself rather than trusting the builder's report, and flags any tests that were deleted or weakened in the diff. Every finding must be backed by evidence it observed (a command and its output, or the steps it took and a screenshot). It returns `pass` or `fail` plus findings. Only **blocking** findings fail a round: the verdict is `fail` if and only if at least one finding is blocking. We expect to tune the reviewer prompt from transcripts. Cognition found that reviewers do better without the spec; we keep the spec-anchored review deliberately, because the spec is the contract and the review always covers the whole product.
- **Findings:** each finding has a `severity`, a `blocking` flag, a `specRef` (the spec clause it rests on; optional for human findings), `evidence` (what the reviewer observed: a command and its output, or the UI steps it took and what it saw; required for reviewer findings, optional for human findings), optional `screenshots` (ids of screenshots the reviewer took in the review VM, §3.7) and an optional `source` (`reviewer` by default, or `human`). **Advisory** (non-blocking) findings never fail a round. The core keeps cited screenshots as run artifacts: the builder gets them as images with the findings, and the web UI shows them with the finding. The core collects the advisory findings of the final review in the run Document, and `delivery` writes them into the PR description or, for a new repo, into a delivery note committed to the repo (`docs/delivery-notes.md`) and the final report (`intake.writeBack`). If a human accepts a run as is after an escalation, the open blocking findings are listed there too. The builder may answer a finding with "won't fix" plus a reason. From round 2 on, the reviewer gets its prior findings and the builder's responses.
- **Failed review:** the core submits the findings as new input to the **same** builder Conversation. That conversation keeps its transcript, so its context survives. When the round cap is reached, or earlier when a round produces no change (empty diff since the previous round), the core escalates to the human through a pending ask (§3.6), with three options: accept as is, grant N more rounds, or abort.
- **Delivery and CI:** CI is a setting of the delivery extension (`stages.delivery.ci`, §6), not a fixed step. `ci.mode` is `off` (skip CI; the run finishes at delivery), `if-present` (default: wait for the repo's existing checks if it has any, otherwise skip) or `required` (checks must pass; if the repo has none, the run escalates to the human). `ci.checks` optionally names the checks that count (default: all). The CI fix loop runs only when the mode isn't `off` and checks exist: the core waits for CI on the delivered commit: for a PR, the PR's checks; for `push-main`, the commit statuses and check runs for the pushed commit SHA on the default branch. If CI fails, the failure goes back to the same builder for at most `ci.fixRounds` (0–3, default 2) fix rounds, then the core escalates. The review that follows a CI fix counts toward `ci.fixRounds`, not `reviewRoundCap`. The same modes apply to both delivery kinds. When CI runs, this is what enforces "tests pass in CI".
- **No CI checks [decided]:** after delivery, if no CI checks appear within `ci.noChecksTimeout` (default 2 minutes), the core treats the repo as having no CI. If CI is required for the project (`ci.mode` is `required`), the run escalates to the human through a pending ask (§3.6) instead of finishing. Otherwise the run finishes, and the delivery note and final report say that there was no CI.
- **Merge gate:** after green CI (or right after delivery when CI is skipped), if the `merge` approval is enabled for the project, the core asks for it; approve → `repo.merge` → done. Without that gate the PR is left open (no auto-merge) and the run is `DELIVERED`. The merge gate does not apply to `push-main` deliveries (new repos), because there is no PR to merge.
- **Rejection at the delivery or merge gate:** the run goes back to the same builder, and the human's rejection comment is passed to it as a blocking finding (`source: human`) in the same shape as review findings. A gate rejection adds no review or CI round, and the next reviewer sees the human findings along with its own prior findings.

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

**Default worker extensions:** `coding`, `coding-readonly`, `subagent`, `test-runner`, `browser` and `web-search`. `web-search` adds one tool, `web_search({ objective, queries[1..5] })`, backed by Parallel's Search API in `fast` mode (one request; Parallel runs the queries in parallel and returns ranked results with excerpts). Its settings are `workers.web-search.{mode, maxResults, maxCharsTotal, apiKey, endpoint}`, with the key held as a reference (default `env:PARALLEL_API_KEY`). The tool runs in the factory process, like `subagent`, not through `env.exec`: the key never enters the sandbox and the API host needs no `allowedDomains` entry. Query text leaves the machine and is kept in the transcript; a role that must not search drops `web-search` from `roles.<role>.extensions`.

**Bootable environment:** `provision` runs the repo's setup script, if one exists, so every role starts on a working checkout. Environments do not impose tight CPU or RAM limits; tight limits measurably change outcomes.

**Default environment sandbox [decided]:** the default environment extension, `local-worktree`, runs every command it executes inside Anthropic's sandbox runtime (`@anthropic-ai/sandbox-runtime`, the runtime behind Claude Code's sandboxed bash; Apache-2.0, beta research preview, so we pin it like Pi Durable). It is a setting of that extension (`environment.sandbox`), not a core concept; the core and the bridge do not know about it.
- **Mechanism:** the runtime uses OS primitives instead of a container: bubblewrap on Linux (network namespace removed, PID namespace) and `sandbox-exec` with a generated Seatbelt profile on macOS. The limits apply to the whole process tree. Network traffic can leave only through HTTP and SOCKS5 proxies on the host. On Linux they are reached over bind-mounted Unix sockets; on macOS, through one allowed localhost port. The proxies check each host against an allow/deny list.
- **Wiring:** we use it as a library, not through the `srt` CLI and `~/.srt-settings.json`. The extension calls `SandboxManager.initialize(config)` once per process, which starts the proxies. Then `env().exec` wraps each command with `wrapWithSandbox(cmd, shell, perRunConfig)`, so every `bash` call and every test run from the builder, its helpers and the architect goes through it (and the reviewer's, when the review VM is off, §3.7). In-process file tools (`read`/`write`/`edit`) are not processes, so the sandbox does not cover them. `env()` applies the same path rules to their file readers and writers.
- **Filesystem:** writes are denied by default (allow-only). Per run, `allowWrite` is the run's worktree, its git dirs (so the builder can commit) and a per-run scratch dir that `TMPDIR` and tool caches point to. Read-only roles (architect, reviewer) get no writes to the worktree; commands they run may write only to their scratch dir. Reads are allowed by default (deny-then-allow), and `denyRead` hides `~/.factory`, `~/.ssh` and other secret paths.
- **Network:** denied by default. Only `allowedDomains` from config is reachable, for example package registries. `deniedDomains` wins over allows. GitHub is not on the default list, because agents reach the remote only through the bridge.
- **No GitHub token:** the core's GitHub credentials (PAT, App key) are never put in the sandboxed environment. The runtime's `credentials` section also lists them with `mode: deny`: env vars by name, key files by path.

### 3.4 Core-owned bridge (the only path from agents to the pipeline)
The core installs one small extension, `factory.bridge`, into each role Conversation. Its tools only **commit a Document or Submission** that the core is waiting on. They never call layer-2 code directly.

| Role | Bridge tools |
|---|---|
| architect | `ask_human(question)`: one question, blocks until answered · `submit_spec(markdown)` |
| builder | `report_done(summary, responses[])`: `responses` answers each finding (fixed, or won't fix + reason); the builder does not ask the human anything mid-build |
| reviewer | `submit_review({ verdict: "pass" \| "fail", findings[] })`; each finding is `{ severity, blocking, specRef, description, evidence, screenshots?, source? }` (`source` defaults to `"reviewer"`); `fail` requires at least one blocking finding, every reviewer finding must have `evidence`, and every cited screenshot must be one the reviewer took this round; the tool rejects a submission that breaks any of these rules |

At the spec gate the architect may also call `submit_spec` while it answers a human message (§3.6): the revised spec replaces the version waiting for approval, and the run asks for approval again. That is the only bridge call a message can lead to.

A human's rejection comment at the delivery or merge gate reaches the builder in the same finding shape, with `source: "human"` and `blocking: true`; `specRef` and `evidence` are optional for these findings. The builder answers it in `report_done` like any other finding.

### 3.5 Projects
A **project** is a factory record: a name, a repo binding (`owner/name`) and settings overrides (§6). It is stored in the config file under `projects.<name>` and exists before any run; every run belongs to one project.

Interfaces create the record with `createProject(name, repo)` (the same call whether or not the repo exists) and start runs on it with `startRun(project, request)` (§3.6).

- **Repo exists:** the project binds to it; runs are incremental and deliver PRs.
- **Repo doesn't exist:** the record is created now; the repo is created as a private repo on the first run's delivery (`repo.create`; the RepoExtension owns creation). Until then runs work in a local workspace. The first delivery is `push-main` (no PR); later runs deliver PRs.
- **Overrides** belong to the project record (set with `setSetting({ project }, …)`, §6), so they apply from the first run, before the repo exists. A run pins the merged global + project settings when it starts (§4).

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
- **Messages reach the agent the run is with.** The architect from `RECEIVED` through the spec gate, the current reviewer while `REVIEWING`, the builder otherwise (including the delivery and merge gates and escalations). A message is refused (`conflict`) on a terminal run, while a discussion question is pending (that takes `answer`), or when the role is not in `policy.messages`. `RunView.messages` records each message with its sender (`by`) and, once handed over, its Conversation.
  - *Delivery:* the message goes into the Conversation's inbox as a steer (Pi Durable's `whenBusy: "steer"`): a working agent sees it after its current tool round and carries on; an idle agent answers it in a turn of its own. A role that hasn't started yet, or that the core is about to drive, gets the message right after the core's own input instead. The agent sees a header naming the sender and a note on where the run is (e.g. "you are building; you still finish with report_done").
  - *It never moves the run:* only bridge calls the core is waiting on and the human's answers move it. The one case where a message can change an artifact is the spec gate: the architect may revise the spec with `submit_spec` (§3.4), which closes the pending ask (`run.askResolved` with `by: "architect"`) and asks for approval of the new version.
  - *No unreviewed delivery:* if the builder changes files after the review (for example after a message at the delivery gate), the core sees a different diff when it starts delivering and sends the run back through review (and the delivery gate, if set) first.
  - *Cost:* turns a message starts while the agent is idle are recorded as cost records with `trigger: "message"`, in the role's current round.
- **Intake uses the same entry point.** For each Request an intake extension delivers, the core calls `startRun` itself. Results reach intakes through `writeBack` and interfaces through events.
- **Transport belongs to the extension.** One process owns the storage and the core. An interface that runs elsewhere (a terminal client, a web server, a chat bridge) brings its own transport to that process; the core defines none. The `cli` extension uses a Unix socket; the `web` extension serves HTTP on localhost (`POST /api/op/<op>` for operations, server-sent events for `subscribe`) behind an access token.

*Example interface, not part of the core:* a CLI extension might map `createProject` to `factory project create`, `startRun` to `factory run`, `getRun`/`subscribe`/`getConversation` and the answer operations to `factory attach <run>`, `cancelRun`/`retryRun` to `factory cancel`/`factory retry`, and the settings operations to `factory settings`.

### 3.7 Review VM (boat.dev) **[decided]**
The reviewer must be able to use the product like a user, so it reviews in a [boat.dev](https://docs.boat.dev) sandbox: a full Linux VM (4 vCPU / 8 GB by default) with Docker and the usual toolchains, a desktop (Xorg, 1920x1080) and Chrome. A `Boat` class (`src/boat/`) gives the reviewer its environment with the same shape as `Sandbox` (`provision`, `env`, `dispose`); the core calls it directly, over boat's HTTP API (`@boatdev/sdk`), and every other role stays in the local `Sandbox`.
- **Where the app runs:** on entering `REVIEWING`, `Boat.provision` creates a VM with `noEnv: true` (none of the boat account's secrets, GitHub access or model keys go in) and an `Idempotency-Key` from run + round, so a resume after a crash finds the same VM. It copies in the reviewed commit as a git bundle (the remote may not exist yet, and the VM gets no GitHub access), runs the repo's setup script (`sandbox.setupScripts`), then starts the first run script that exists (`boat.runScripts`) in the background. The product runs inside the VM, and the reviewer reaches it on `localhost` at the URL `AGENTS.md` gives; no public URL is opened (`boat host` is not used). The reviewer may restart the product itself.
- **Lifecycle:** one fresh VM per review round, like the reviewer Conversation. `Boat.dispose` deletes it once the review is submitted or the run ends; boat's auto-stop (`boat.ttl`) is the backstop, so a crash never leaves a VM billing.
- **Tools:** the reviewer's `env().exec` runs commands in the VM (boat's commands API) and its file readers read the VM's checkout, so the tests it runs and the product it clicks through are the same build. The reviewer's fixed tool set gains `computer`, which drives the VM's desktop through the Cua Driver that boat preinstalls (`cua-driver call <tool>` against the desktop daemon, run through the same `env().exec`): `get_window_state` (a screenshot plus the accessibility tree), `click`, `type_text`, `press_key`, `scroll`, `launch_app`, and `browser_navigate`, `browser_click`, `browser_type`, `get_browser_state`. Each screenshot is shown to the model and stored under an id the reviewer can cite in a finding's `screenshots` (§3.4). The reviewer prompt asks for a screenshot of one window, not the whole desktop, to keep images small.
- **Read-only still holds:** the VM holds a throwaway copy; nothing in it flows back to the run's worktree, so the builder stays the single writer. The reviewer still has no write or edit tools.
- **Credential:** the boat API key is a reference, `boat.apiKey` (default `env:BOAT_API_KEY`), like `webSearch.apiKey`; only `Boat` in the factory process resolves it, and it never enters any VM or sandbox. A scoped boat key (create, commands, files, delete) is enough. With `boat.enabled` and the key unresolved, the run fails at `PREPARING`, before any work, and `doctor` reports it.
- **Settings** (layered and pinned like the rest, §6): `boat.enabled` (default `true`), `boat.apiKey`, `boat.size` (`small` / `default` / `large`, default `default`), `boat.ttl` (default `1h`), `boat.runScripts` (default `[scripts/run.sh, bin/run]`). Any of them can be set per project: a larger VM for a heavy app, or `boat.enabled: false` for a project whose code must not leave the machine, which reviews in the local `Sandbox` with the HTTP client only and no screenshots.

---

## 4. Core state machine **[decided: no model calls]**

The core is a Pi Durable **Task** that checkpoints at every transition, plus a `factory.run` Document that holds the state, round counters (review rounds and CI fix rounds), conversation IDs, artifact refs and pending ask. The Document also keeps cost (tokens, USD, duration) **per role per round**, as a record with no cap, and the hash of the effective config (global values plus the project's overrides, §6) and the Pi version the run started with. The core never calls a model itself. It only creates and configures Conversations for roles, submits input to them, and reads what they commit through the bridge.

| State | Entry action | Exit → next |
|---|---|---|
| `RECEIVED` | `startRun(project, request)` was called, by an interface or by the core for a Request from `intake.pull/subscribe`; pin the effective config | → `PREPARING` |
| `PREPARING` | `repo.open` on the project's repo binding (clone, or a local workspace if the repo doesn't exist yet), `environment.provision` (runs the repo's setup script), `intake.writeBack(started)` | ok → `DISCUSSING` · error → `FAILED` |
| `DISCUSSING` | open architect Conversation (role model) with request + repo context | `ask_human` → pending ask (discussion), `answer` resubmitted (stay) · `submit_spec` → `SPEC_READY` |
| `SPEC_READY` | store spec artifact (and commit it to the workspace as `docs/spec.md`) | gate `spec` on → `AWAITING_APPROVAL(spec)` · off → `BUILDING` |
| `AWAITING_APPROVAL(g)` | pending ask (approval g) | `approve` → next stage (spec → `BUILDING`, delivery → `DELIVERING`, merge → `repo.merge` → `DELIVERED`) · `reject(feedback)` → `DISCUSSING` (spec) / `BUILDING` with the comment as a blocking finding, `source: human` (delivery, merge; adds no review or CI round; `submitHumanFindings` is the same with structured findings) · spec only: the architect revises the spec with `submit_spec` after a human message (§3.6) → `SPEC_READY` with the new version, which closes this ask |
| `BUILDING` | round 1: open builder Conversation with spec · round n>1: **submit findings (review findings, CI failure, or a human rejection comment) to the same Conversation** | `report_done` → `REVIEWING` · round n>1 with empty diff since the previous round → `ESCALATED` |
| `REVIEWING` | `Boat.provision` at the reviewed commit, which boots the product (§3.7), then open fresh reviewer Conversation in that VM with spec + workspace + `repo.diff(base)`; from round 2, also its prior findings + the builder's responses, and any human findings from a gate rejection | pass (no blocking findings; advisory ones stored for delivery) → gate `delivery` ? `AWAITING_APPROVAL(delivery)` : `DELIVERING` · fail & round < `reviewRoundCap` → `round++`, `BUILDING` · fail & round = `reviewRoundCap` → `ESCALATED` · a review that follows a CI fix counts toward `ci.fixRounds`, not `reviewRoundCap`: fail & CI fixes < `ci.fixRounds` → `BUILDING` · fail & CI fixes = `ci.fixRounds` → `ESCALATED` · on every exit `Boat.dispose`; cited screenshots are kept as run artifacts |
| `ESCALATED` | pending ask (escalation), resolved by `resolveEscalation` | accept → `DELIVERING`, except when escalated from `AWAITING_CI`: then gate `merge` on for a PR delivery ? `AWAITING_APPROVAL(merge)` : `DELIVERED` · more rounds(N) → the cap that was hit `+=N`, `BUILDING` · abort → `CANCELLED` |
| `DELIVERING` | first, if the workspace diff differs from the one the last review saw (the builder acted on a message after the review): → `REVIEWING` with a fresh reviewer, adding no round · otherwise, if `ws.newRepo`: `repo.create` then `delivery.deliver` as `push-main`; else `delivery.deliver` as a PR (advisory findings go into the PR description / delivery note) | ok & `ci.mode` ≠ `off` → `AWAITING_CI` · ok & `ci.mode` = `off` → gate `merge` on for a PR delivery ? `AWAITING_APPROVAL(merge)` : `DELIVERED` · error → `FAILED` |
| `AWAITING_CI` | wait for CI on the delivered commit SHA: the PR head, or for `push-main` the pushed commit on the default branch (`delivery.checks`, limited to `ci.checks` if set) | no checks within `ci.noChecksTimeout` & `if-present` → same as CI green, noting no CI · no checks within `ci.noChecksTimeout` & `required` → `ESCALATED` (reason: no CI checks) · CI green → gate `merge` on for the project and a PR delivery ? `AWAITING_APPROVAL(merge)` : `DELIVERED` · CI red & fixes < `ci.fixRounds` → `BUILDING` with CI failure (the review after the fix counts toward `ci.fixRounds`, not `reviewRoundCap`) · CI red at cap → `ESCALATED` · error → `FAILED` |
| `DELIVERED` | `intake.writeBack(done, url)`, `run.notice` event, `environment.dispose`; without an approved merge the PR stays open (no auto-merge) | terminal |
| `FAILED` / `CANCELLED` | `writeBack`, `run.notice` event, dispose (workspace kept for inspection) | terminal; `retryRun(run)` → state at failure |

Every transition is also published as a `run.state` event (§3.6); that is how interfaces follow a run. `intake.writeBack` applies only to runs whose Request came from an intake.

Invariants:
- A transition either commits atomically with its checkpoint or does not happen at all.
- Layer-2 calls are idempotent and keyed by `runId + state + round`. For example, `delivery` reuses the existing PR, and `ask` reuses a pending question.
- A human can abort a run from any non-terminal state (`cancelRun`).
- A run is pinned to the effective config (global values plus its project's overrides) and Pi version it started with, and resumes on them even after an upgrade.

---

## 5. Config schema example

> Superseded: there are no `stages`, `workers` or `roles.<role>.extensions`. See the cleanup spec's [§2](superpowers/specs/2026-10-09-fixed-architecture-cleanup-design.md#2-settings-and-data-flow) and [configuration.md](configuration.md) for the current paths.

Config is plain data, versioned in a repo or at `~/.factory/`. It maps roles to models and stages to extensions, and it sets policy. **[decided]**

```yaml
version: 1
roles:                                   # role → model (+ worker extensions)
  architect: { model: anthropic/claude-opus, thinking: high,   extensions: [coding-readonly, docs] }
  builder:   { model: anthropic/claude-opus, thinking: high,   extensions: [coding, subagent, test-runner] }
  helper:    { model: anthropic/claude-sonnet, thinking: medium }   # used for the helpers the builder spawns
  reviewer:  { model: openai/gpt-6-sol,    thinking: high,     extensions: [coding-readonly, test-runner, browser] }
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

**Layering:** every setting resolves in the same layers: schema default → global (top level of the config file) → project (`projects.<name>`). Any setting can be overridden per project with the same path: policy (including approval gates), role models, thinking and extensions, the sandbox, and every stage extension's settings, including CI. A project value overrides the global one, and a value the project leaves unset inherits it. Objects merge key by key; scalars and lists replace as a whole (a project's `approvals` replaces the global list). `storage` is global only, because one process owns it.

**What can be configured**
- **Policy** (core): approval gates (default `[spec]`), `reviewRoundCap` (default 3), `escalateOnNoProgress` (default on), `messages` (the roles a human can message while a run is going, §3.6; default architect, builder and reviewer; drop the reviewer for a review no human can sway).
- **CI** (owned by the delivery extension, `stages.delivery.ci`): `mode` (`off` / `if-present` / `required`, default `if-present`; see §2), `fixRounds` (default 2, allowed range 0–3, enforced by validate-on-save), `checks` (optional list of check names that count; default all) and `noChecksTimeout` (default 2 minutes; if no checks appear by then, the repo is treated as having no CI).
- **Roles** (core): for each of architect, builder, helper and reviewer: `model` (from the providers `createModels()` knows), `thinking` (`off` / `low` / `medium` / `high`) and `extensions` (from the installed worker extensions; every role gets `web-search` by default).
- **Workers** (owned by each worker extension, `workers.<name>`, §3.3): e.g. `workers.web-search.mode` (`turbo` / `fast` / `basic` / `advanced`, default `fast`) and its API key reference.
- **Sandbox** (owned by the default environment extension, `stages.environment.sandbox`): `allowedDomains`, `deniedDomains`, `extraWrite`, `denyRead`. Write access is fixed by role (§3.3) and is not a setting: the architect and reviewer never get write access to the worktree, and the builder stays the single writer.
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
- **Validate on save:** a change is checked against the schema, the extension's `validate`, and the core's rules (for example, the §3.3 write limits), applied to the resulting effective config of each affected project. An invalid change is rejected and the file is left unchanged.
- A change applies to **new runs only**. A running run stays pinned to the effective config it started with (§4).

**Not configurable:** cost caps (rejected earlier; cost is recorded, not capped), per-role write access (fixed by role, §3.3), and any setting that lets the builder escalate or ask the human mid-build. (Messages go from the human to the agent only; the builder still cannot ask the human anything.)

---

## 7. v1 scope

**In**
- Core state machine on Pi Durable with SQLite storage; resume after a crash.
- Core operations and events (§3.6): projects (`createProject`, §3.5), runs (`startRun`, `getRun`, `listRuns`, `cancelRun`, `retryRun`), answers at asks and gates (`answer`, `approve`, `reject`, `submitHumanFindings`, `resolveEscalation`), messages to the running agent (`message`), settings, and `subscribe`.
- Intake: none. Runs start through `startRun` from an interface.
- Interface `web` (installed and on by default): a local web UI. A ticket board whose columns are the pipeline stages, where each run moves on its own as the core transitions it, and a full-screen run view for any run at any time: the run's conversations (architect, builder with its helpers, reviewers, a timeline), the transcript with every tool call shown the same plain way, a chat box addressed to the agent the run is with (`message`), and approvals and escalations in a card that floats over the conversation. Ticket details, findings by round, cost by role and settings forms generated from `settingsSchema()` complete it. Static files, no build step.
- Interface `cli` (one example interface extension): terminal commands over the core operations, e.g. `factory project create <name> --repo owner/name`, `factory run <name> "<request>"` (with a shorthand that also creates the project) and `factory attach <run>`. Attach renders `getRun` (the run Document's `viewState()`) and the active role Conversation through `getConversation` (including the builder's helpers, found through tool `details`), follows events, and answers pending asks and approvals. One process owns the storage; the CLI client connects to that process.
- Repo `github`: `open` (clone, or a local workspace before the repo exists), `create` (private repo, at the first delivery), `diff`, `merge`. The identity is configurable (PAT, bot or App).
- Delivery `github-delivery`: push to `main` for a new repo, open a PR from a branch for an existing repo.
- Environment `local-worktree` (one git worktree per run, commands wrapped in the sandbox runtime). Tools: `CodingTools`, Pi's subagent pattern and `web-search` (§3.3).
- Review VM on boat.dev (§3.7): one VM per review round with the product running, and the reviewer's `computer` tools (screen, clicks, typing, browser, screenshots as evidence).
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
   - Force a review failure and confirm the same builder Conversation receives the findings.
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
   - No agent reached GitHub except through the core.
   - Cost per role per round and round counts are recorded in the run Document.
   - The repo is throwaway; delete it afterwards.

**Open risks:**
- Pi Durable API churn: pin the version.
- Reviewer leniency: give the reviewer a different model family by default, and tune its prompt from transcripts.
- Review VM (boat.dev, §3.7): the reviewed code leaves the machine for a third-party cloud VM, and that VM has open outbound internet (`sandbox.allowedDomains` does not apply there). It holds no secrets (`noEnv`, no GitHub access, the boat key stays in the factory), so what is exposed is the code itself. A project that must keep its code local sets `boat.enabled: false`.
- Sandbox residual risks. The sandbox closes the shell's open network path from earlier drafts, but some risk remains:
  - **Allowlisted domains:** the proxy filters by host name and does not inspect traffic. Any allowed domain is a possible exfiltration channel: package registries accept uploads, and domain fronting may get around the filter. Keep the list short, and never add broad hosts like `github.com`.
  - **Escapes and bugs:** this is a beta research preview, so it can have escape bugs. A worktree with write access can also plant hooks or scripts that run later outside the sandbox. Mitigations: pin the version, never let repo-local config widen the sandbox, and run `delivery`/CI outside the run's machine.
  - **Platform support:** v1 targets Linux and macOS. Linux needs `bubblewrap` and `socat`; Ubuntu 24.04+ AppArmor can block bubblewrap's user namespaces; macOS has no PID namespace; Windows is alpha. Inside Docker the runtime needs `enableWeakerNestedSandbox`, which weakens it considerably, so the later container envs must provide their own isolation.
