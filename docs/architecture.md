# Architecture

This page covers how the code is organised and how a run, a discussion before it and a bundle after it flow through
it. [`design-spec.md`](design-spec.md) is the design the code implements, as amended by the
[fixed architecture cleanup](superpowers/specs/2026-10-09-fixed-architecture-cleanup-design.md) and extended by
[discussions](superpowers/specs/2026-10-11-discussion-flow-design.md) and [bundles](specs/run-mv4ghzj2-allm.md), and
[`../DEVIATIONS.md`](../DEVIATIONS.md) lists every place the code differs from them.

## Core and its backends

```
                    web UI (src/web)
                 │  operations ▲ events
                 ▼             │
        ┌──────────────── FactoryCore (src/core) ────────────────┐
        │ run, bundle and discussion state machines              │
        │ (Pi Durable Tasks) · bridge · projects · layered       │
        │ settings · pending asks                                │
        └───┬──────────────────────┬─────────────────────┬───────┘
            ▼                      ▼                     ▼
         GitHub                 Sandbox             role Conversations (fixed tools)
    (src/github: GhApiHost   (src/sandbox:         architect · builder (+ helpers) · reviewer
     or LocalGitHubHost)      sandbox-runtime)     · qa · integrator · discussant (src/agents)
```

**The core** (`src/core/`) is model-free and knows nothing about the web UI.
- `run-task.ts` is the state machine: one phase per run state, running as a Pi Durable Task.
- `run-doc.ts` defines the `factory.run` Document. It holds the run's state, counters, pending ask, artifacts,
  findings log, cost records and pinned config.
- `bundle-task.ts` is the bundle's state machine (`createBundleTask`, task `factory.bundle`), and `bundle-doc.ts`
  defines its `factory.bundle` Document: members, state, integration, review rounds, delivery, CI, pending ask,
  findings log, notices, cost and pinned settings (see [Bundles](#bundles)).
- `task-kit.ts` (`createTaskKit`) is what the run and bundle Tasks share: creating role Conversations, driving an agent
  through the bridge (`runAgent`), cost records, pending asks, a review round (a reviewer plus, when AQ testing
  applies, a QA agent in a boat.dev VM) and the CI wait. Both Documents use the same field names for these parts.
- `discussion-task.ts` is the discussion's state machine, another kind of Pi Durable Task beside the run's, and
  `discussion-doc.ts` defines its `factory.discussion` Document: state, the turn in progress, drafts, summary,
  notices, turn costs and pinned config (see [Discussions](#discussions)).
- `cleanup.ts` is the disk cleanup (see [Disk cleanup](#disk-cleanup)): the rule `cleanupScope`, the `Cleaner` that
  deletes an owner's things, and the startup sweep / `gc`.
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
| `GitHub` | `src/github/github.ts` | Runs: `open`, `diff`, `writeArtifact`, `commitAll`, `pushBranch` (and, for legacy runs, `create`, `deliver`). Bundles: `openBundle` (a worktree at `<workdir>/bundles/<id>`), `integrationBase`, `integrateStart`, `mergeMember`, `mergeState`, `concludeMerge`, `contains`, `defaultHead`, `deliverBundle` (description from `bundleReport`, title from `bundleTitle`), `describe`, `prState`, `closePr`. Both: `checks`, `annotate`, `merge`. Cleanup: `discard` (an owner's worktree, `git worktree prune`, local branch and manifest, derived from area, id and repo so it works without the manifest), `deleteRemoteBranch` (only `factory/<owner-id>`, never the default branch, skipped when the repo doesn't exist on the host), `removeOrphanWorktree`, `sweepClone`, `clones`. Git work on a project's shared clone is serialised by a per-clone lock. Commit identity: `commitIdentity(rc)` resolves the account behind the owner's pinned `github.identity` through the host, cached per process by `identityKey` (`kind`, `tokenRef`, `appId`, `installationId`, `privateKeyRef`; concurrent first calls share one lookup; failures are dropped and retried), and every commit-creating method passes it to `git()` as author and committer (`git()` refuses a commit-creating subcommand without one; `baseEnv()` carries no identity). Reads `workdir` and `github.*` |
| `GitHubHost` | `src/github/host.ts` | The GitHub API seam: `GhApiHost` uses `gh api`; `LocalGitHubHost` is a fake that keeps bare remotes on disk and runs workflow steps in a local CI runner (tests and the dry run use it). `closePr`, and `updatePr` with an optional title, serve bundles; `deleteBranch(repo, branch, identity)` deletes a remote branch for the cleanup (`GhApiHost`: `DELETE /repos/{owner}/{repo}/git/refs/heads/{branch}`, 404/422 = already gone; `LocalGitHubHost`: deletes the ref in its bare remote, no-op when absent); `LocalGitHubHost.pushCommit` is a test control for a default branch that moved. `commitIdentity(identity)` returns the account behind an identity as `{ name, email }` (ID-based no-reply email): `GhApiHost` makes direct HTTPS requests to its `apiBase` (not `gh api`): `GET /user` with the token (`pat`, `bot`), or `GET /app` with the App JWT then `GET /users/<slug>%5Bbot%5D` with the installation token (`app`), and throws `GET <path> failed: <status or network error>`; `LocalGitHubHost` returns `factory-dev <1+factory-dev@users.noreply.github.com>` unless its state file sets another account (`setAccount`) or a failure (`failIdentity`), logs each lookup as `commitIdentity` in `calls`, and makes its own GitHub-side commits (seed, PR merges and squashes) as `GitHub <noreply@github.com>` |
| `Sandbox` | `src/sandbox/sandbox.ts` | `provision`, `env`, `dispose`: per-role environments in the run's worktree, inside sandbox-runtime; `removeScratch` (an owner's `scratch/<id>-<role>` dirs, exact names; records kept), `destroy` (an environment record file and its in-memory state), `recordIds`; reads `workdir` and `sandbox.*`. `provision` takes the owner's resolved commit identity (the caller resolves it first, so a failed lookup fails that step before any agent works) and stores it as `EnvRecord.commitIdentity`; `policy()` sets `GIT_AUTHOR_*`/`GIT_COMMITTER_*` from it and refuses a record without one. For records written before it existed, the core's `env` factory resolves it from the owning run's, bundle's or discussion's pinned config (`needsCommitIdentity`/`setCommitIdentity`) before opening the environment |
| web server | `src/web/server.ts` (UI: `src/web/ui/`) | HTTP and server-sent events over the core's operations |
| agent tools | `src/agents/` | The role Conversations' tools and prompts (below) |

**Agent tools** (`src/agents/`) are ordinary Pi Durable extensions, because that is how Pi supplies tools. They are
not selectable: `ROLE_TOOLS` in `tools.ts` gives each role a fixed set, after its `role-<role>` prompt.

| Tool set | Provides | Roles |
|---|---|---|
| `coding` | read, write, edit and bash tools | builder, helper, integrator |
| `coding-readonly` | read and bash tools | architect, reviewer, qa, discussant |
| `subagent` | helpers (which write code) as owned Conversations | builder |
| `test-runner` | `run_tests` | builder, helper, integrator, reviewer |
| `computer` | the Cua Driver in the QA VM; every screenshot is stored as a run artifact | qa |
| `browser` | `http_request` over curl; no role gets it now, kept so older Conversations resume | — |
| `web-search` | `web_search`: Parallel's Search API in `fast` mode, run in the factory process | all |
| `role-*` (`prompts.ts`) | each role's prompt sections | each its own |

`src/main.ts` is the process wiring. It creates the secret store (refusing a `secrets.json` that is readable by group
or others or doesn't parse) and the model host (below), a `GitHub` on a `GhApiHost` (or a `LocalGitHubHost` with
`--fake-github`), a `Sandbox` and the `Factory`, which opens the storage, then starts the web server.
`src/daemon.ts` runs `factory serve` in the background with `factory.pid` and `factory.log`; the web server writes
`web-token` and `web-url`. All four live next to the config file.

## Model host and secret store

Both live in the factory home, the config file's directory (`~/.factory` by default).

**The model host** (`src/models/host.ts`, `createModelHost`) is where models come from.
- Role Conversations are pi-durable Conversations, and pi-durable takes a pi-ai `Models` object; it has no extension
  or package loader. Packages and extensions belong to pi-coding-agent, so the factory uses pi-coding-agent as a
  model host only (DEVIATIONS.md "pi-coding-agent as the model host").
- `createAgentSessionServices({ cwd: agentDir, agentDir })` with `agentDir = <factory home>/pi` builds pi's
  `ModelRuntime`: the built-in providers, `models.json`, the providers that installed packages' extensions register,
  and the credentials in `auth.json` (with pi's locking and OAuth refresh). `cwd` is `agentDir` on purpose, so no
  `.pi/` directory in the directory `serve` was started in is loaded. Nothing comes from `~/.pi/agent`.
- `ModelHost` is `{ models, packages, agentDir, diagnostics }`. `models` is the `ModelRuntime`, which implements
  pi-ai's `Models` and is what `Factory` receives; `packages` is pi's `DefaultPackageManager`.
- Only the providers and virtual models that extensions register are used. Their tools, commands, flags and event
  hooks attach to pi-coding-agent sessions, which the factory never creates.
- Extension and `models.json` errors become `diagnostics`, never exceptions: `serve` logs them and `doctor` prints
  them as `warn` lines.
- `ModelRuntime` reads `auth.json` when it resolves auth, so a login applies to the running factory's next request.
  Packages and `models.json` are loaded when the host is built, at startup.
- `scripted: true` (the dry run, `--scripted`) registers the scripted provider as a native provider.

**The secret store** (`src/secrets/store.ts`, `SecretStore`) backs `store:<key>` secret references.
- It is `<factory home>/secrets.json`, `{ "version": 1, "secrets": { "<key>": "<value>" } }`: the file 0600, its
  directory 0700, each write to a temp file then renamed. `get` re-reads the file, so the daemon sees new values
  without a restart, and refuses a file readable by group or others.
- `resolveSecret(ref, store?)` in `src/core/settings.ts` resolves `env:`, `file:` and `store:` refs, through the
  store it is given or else the process default. `main.ts` (`serve`) and `createSetupContext` (`setup`) set the
  default with `setDefaultSecretStore`, so `GhApiHost`, `Boat` and `web_search` resolve `store:` refs without being
  handed a store. `doctor` (`src/doctor.ts`) sets no default: it builds its own `SecretStore` and passes it to
  `resolveSecret` and `Boat.limits`.
- The sandbox always denies the factory home, wherever `--config` points. Inside it, it re-exposes only the
  environment's own worktree, git directory, scratch dir and `extraWrite` paths (a `workdir` placed in the home), and
  denies the secret and state entries regardless: `secrets.json`, `pi/` (with `auth.json`), `web-token`, `web-url`,
  `factory.log`, `factory.sqlite*`, `environments/` and `qa-vms/`, plus the `storage.path` database wherever it
  lives. No write root may reach the home or the database from outside: such a root is dropped, so no agent can read
  or rewrite a credential, the config or an environment record stored there.

## The setup wizard

`factory setup [section]` (`src/setup/`) sets up credentials, providers, role models and the service.

```
cli.ts setup ──► runSetup (wizard.ts) ──► steps/: prereqs · github · models · roles · qa · search · service
                 │                        each a Step: status(ctx) → ok | warn | missing; run(ctx)
                 ▼
                 SetupContext (context.ts): config path, factory home, SetupUi, SecretStore, model host,
                 validated settings, boat, fetch, command runner, platform, env, home dir, daemon, doctor
```

- **`cli.ts`** refuses unknown options, an unknown section and a missing TTY, then calls
  `runSetup(createSetupContext({ configPath, ui: new ClackUi() }), section)` and exits with its code (0, 1 or 130).
- **`wizard.ts`** (`runSetup`) refuses a legacy config or a bad `secrets.json` before any prompt. With no section it
  shows the status summary, runs every step (asking `Reconfigure <title>?`, the step's title, for one that is `ok`),
  offers a restart after a step that changed packages or `models.json` (`ctx.needsRestart`) while the factory runs,
  runs the doctor checks and prints the outro. With a section it runs that step alone, then makes the same restart
  offer. `SetupCancelled` from a prompt ends it with exit 130; Ctrl-C while a spinner runs is handled in `ClackUi`,
  which prints the same message and exits 130 itself. What earlier steps saved stays saved.
- **`steps/`** has one module per section, each exporting a `Step` (`name`, `title`, `status`, `run`); `index.ts`
  lists them in order. Two helper modules export no step: `endpoints.ts` (the `models` section's compatible endpoints,
  `models.json` I/O and the shared role-usage and credential helpers) and `candidate-store.ts` (a `SecretStore` that
  answers one key from memory, so `qa` and `search` verify a pasted key before writing `secrets.json`). A step writes
  settings through `ctx.settings()`, the factory's own `ConfigStore` over the current host's models, so the web UI's
  validate-on-save applies. Secrets go through `ctx.secrets`, and model
  credentials and packages through `ctx.host()` (`reloadHost()` after a change).
- **`context.ts`** builds the context. `createSetupContext` is the CLI's (the real store, host, commands and daemon);
  tests build one from stubs with `testContext` (`test/setup-context.ts`, over `buildSetupContext`), so no test
  touches the real home, the network, `gh`, `systemctl` or `launchctl`.
- **`ui.ts`:** steps depend only on the `SetupUi` interface. `ClackUi` implements it with `@clack/prompts` and turns a
  cancel into `SetupCancelled`. `authInteraction(ui)` adapts it to pi-ai's login protocol (prompts, auth URLs, device
  codes, progress); its `close()` stops the spinner a final `progress` event left running. Tests use `ScriptedUi`
  (`test/setup-helpers.ts`), which pops queued answers and records what is shown.

## The flow

A request moves through these states (`RUN_STATES` in `src/core/types.ts`):

```
RECEIVED → PREPARING → DISCUSSING ⇄ (questions) → SPEC_READY → [spec gate] → BUILDING → REVIEWING
   REVIEWING ──fail──► BUILDING (same builder, with findings)    … up to policy.reviewRoundCap, then ESCALATED
   REVIEWING ──pass──► [delivery gate] → DELIVERING → READY
   READY ──a message changed the workspace (no bundle)──► REVIEWING (no round added) → … → READY
   READY ──its bundle merged──► DELIVERED
Any non-terminal state ──cancel──► CANCELLED (not while in an active bundle);  errors → FAILED;
retry: FAILED/CANCELLED → the state at failure

Legacy runs only (had begun delivering before bundles existed):
   DELIVERING (PR or push to main) → AWAITING_CI
   AWAITING_CI ──red──► BUILDING → REVIEWING → DELIVERING        … up to ci.fixRounds, then ESCALATED
   AWAITING_CI ──green / no CI / ci off──► [merge gate, PRs only] → DELIVERED
```

1. **Preparing.** `GitHub.open` opens the project's repo. If the repo exists, it is cloned and a per-run worktree is
   made on branch `factory/<runId>`. If not, a local repo is initialised. `Sandbox.provision` then provisions an
   environment for each role.
2. **Architecture discussion.** The architect asks one question at a time through `ask_human`. Each question becomes
   a durable pending ask that the web UI shows and answers. The architect ends the discussion with `submit_spec`.
3. **Spec.** The spec must contain an "Acceptance behaviours" heading. `GitHub.writeArtifact` commits it to
   `docs/specs/<run-id>.md` (`specPathOf`, shown as `RunView.specPath`), so parallel tickets never collide on it.
   Runs that were already past `SPEC_READY` when bundles arrived keep `docs/spec.md`. `docs/spec.md` is the product
   spec: the builder updates it only when the repo already has one. If the `spec` gate is on (the default), the run
   waits for approval. A rejection sends it back to the discussion.
4. **Build.** One builder Conversation does the build and is accountable for it. It may have helpers write code in
   parallel through `subagent` (in the builder's worktree and environment; helpers use `roles.helper`, else the
   builder's model). It
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
6. **Ready.**
   - **Delivering.** If the optional `delivery` gate is on, the run waits for approval first. `DELIVERING` checks that
     the workspace diff is the one the last passing review saw (else the run goes back to `REVIEWING`, no round
     added), commits whatever the builder left uncommitted (`GitHub.commitAll`) and, for an existing repo, pushes
     `factory/<run-id>` to `origin` (`GitHub.pushBranch`). It opens no PR, creates no repo and waits for no CI.
   - **`READY`** is not terminal: the run waits for a bundle. A message to a run in no active bundle goes to its
     builder; if the builder then changes the workspace diff, the run goes back through `REVIEWING` (no round added)
     and returns to `READY`. A run in an active bundle (`RunView.bundle`) refuses messages and cancel with
     `conflict`, naming the bundle.
   - **Delivered.** When its bundle merges, the run goes `READY` → `DELIVERED`: `artifacts.delivery` is the bundle's
     PR (or push to `main`), the final notice reads "Merged in bundle-N: <url>", its environments are disposed, and
     its Task deletes its worktree, branches, scratch and environment records (full cleanup).
   - **Gate rejections.** Rejecting the delivery gate sends the human's feedback to the builder as blocking findings
     with `source: "human"`. This doesn't use up a review round.
   - **The `merge` gate is legacy.** `approvals: merge` still validates but no new run stops at it; a bundle's Merge
     merges.
7. **Legacy runs.** A run that had begun delivering under the old flow when the factory upgraded (`isLegacyDelivery`
   in `run-doc.ts`: `DELIVERING`, `AWAITING_CI`, `AWAITING_APPROVAL(merge)`, an escalation from `AWAITING_CI`, or a
   recorded delivery) finishes the old way. At startup `Factory.migrateRuns` marks such runs `legacy` and every other
   unfinished run as on the new flow (`flowVersion: 2`). A legacy run opens its own PR (or pushes to `main`), waits
   for CI (red goes back to the builder as a `source: "ci"` finding, up to `ci.fixRounds`), and stops at the `merge`
   gate if it is on (approving squash-merges the PR; without the gate the PR is left open).

## Bundles

A bundle (`bundle-<n>`) ships one or more `READY` runs of one project as one PR. `createBundle(project, runs)` checks
that every run is of that project, `READY` and in no active bundle, then starts the bundle's Pi Durable Task
(`createBundleTask`, beside the run and discussion Tasks, on the same `CoreServices`). The bundle pins the project's
effective settings, with `roles.integrator` resolved (unset = the builder's model and thinking). Members are ordered
as picked; each carries its run id, title, ticket key (`PROJECT-N`, computed as the board does), spec path and
branch.

```
INTEGRATING ──clean, one ticket──► DELIVERING → AWAITING_CI ──green / no CI──► AWAITING_MERGE ──Merge──► MERGED
     │ └──clean with 2+ tickets, or the integrator resolved a conflict──► REVIEWING ──pass──► DELIVERING
     │                                          REVIEWING ──fail──► FIXING → REVIEWING   … up to reviewRoundCap
     │                                          AWAITING_CI ──red──► FIXING → REVIEWING  … up to ci.fixRounds
     └── a new repo: AWAITING_CI ──green / no CI──► MERGED (no PR, no Merge)
AWAITING_MERGE ──default branch moved / GitHub refused──► INTEGRATING (merges by itself if green and no fix was needed)
AWAITING_MERGE / ESCALATED ──drop tickets──► INTEGRATING (fresh integration of the rest)
PR merged on GitHub → MERGED;  PR closed → CANCELLED;  cancel → CANCELLED;  errors → FAILED ──retry──► the state at failure
```

| State | What happens | Exits |
|---|---|---|
| `INTEGRATING` | The first time, `GitHub.openBundle` makes the worktree `<workdir>/bundles/<bundle-id>` on `factory/<bundle-id>` from the project's shared clone, where the members' branches are local branches; the integrator and reviewer environments are provisioned and the one integrator Conversation is created. `integrationBase` fetches and returns `origin/<default>` (for a repo that doesn't exist yet, the clone's local `main`); `integrateStart` resets the branch there. Each member is merged in order with `git merge --no-ff` (`mergeMember`). A conflict is left in the worktree and given to the integrator (the ticket, the files, every member's spec); its `report_done` must have concluded the merge, else it gets up to 3 attempts. | all merged cleanly, one member → `DELIVERING` · all merged cleanly, 2+ members → `REVIEWING` (`mergeRequested` kept; the reviewer is told the tickets merged without conflicts, each passed its own review/QA, and to look especially at how they interact) · the integrator changed anything → `REVIEWING` (`mergeRequested` cleared) · error → `FAILED`. Each new integration record carries `reviewCombination: true` (`BundleView.integration.reviewCombination`); a record from before that rule has none and keeps clean → `DELIVERING`, so bundles in flight at the upgrade are not reviewed again for an integration they already did |
| `FIXING` | The integrator gets blocking findings (review, QA, CI or human) and answers each in `report_done`. | → `REVIEWING` |
| `REVIEWING` | A fresh reviewer, and a QA agent in a boat.dev VM `factory-bundle-<n>-<seq>` when AQ testing applies, check the whole combined product against every member's spec (and `docs/spec.md` if present), with the combined diff from the integration base. The same round rules as a run. | pass → `DELIVERING` · fail under the cap → `FIXING` · at the cap → `ESCALATED` (`reviewRoundCap`; reviews after a CI fix count toward `ci.fixRounds`) |
| `DELIVERING` | The no-unreviewed-delivery check, then `deliverBundle`: an existing repo gets `factory/<bundle-id>` pushed and one PR opened or updated (title from `bundleTitle`, description from `bundleReport`: a section per ticket and an integration section); a new repo is created and the result pushed to `main` with `docs/delivery-notes.md`. | → `AWAITING_CI` (or on at once with `ci.mode: off`) · error → `FAILED` |
| `AWAITING_CI` | The run's old CI wait (`ci.mode`, `ci.checks`, `ci.noChecksTimeout`) on the delivered SHA; the PR is polled too. | green / no CI → `AWAITING_MERGE` (PR) or `MERGED` (new repo) · red under `ci.fixRounds` → `FIXING` · red at the cap, or no checks under `required` → `ESCALATED` |
| `AWAITING_MERGE` | Pending ask: Merge / Request changes / Drop tickets; the PR is polled. Merge with an unmoved default branch merges with `bundle.mergeMethod`. A moved default branch, or GitHub refusing the merge, re-integrates from scratch and merges by itself once CI is green if no fix was needed (a clean 2+ ticket update is reviewed first and keeps `mergeRequested` while that review passes); an update the integrator had to change, or any `FIXING` (review, CI or Request changes, which clears `mergeRequested`), comes back for a fresh click. GitHub refusing 3 times fails the bundle. Request changes is one blocking `source: human` finding, no round added. | see the diagram |
| `ESCALATED` | Pending ask: more rounds (N) / drop tickets / abort. | → `FIXING` · `INTEGRATING` · `CANCELLED` |
| `MERGED` | Terminal. Each member run is marked merged (`bundleMerged`) and goes `READY` → `DELIVERED`. Environments and VMs are disposed; the bundle's own things are deleted (full cleanup). | — |
| `FAILED` | Ends the Task. The members stay in the bundle until `retryBundle` (resumes at the failed state) or `cancelBundle`. Only the bundle's scratch dirs are deleted. | — |
| `CANCELLED` | Terminal. Closes an open PR; members go back to plain `READY`, their branches and worktrees untouched; the bundle's own things are deleted (full cleanup; `cancelBundle` of a `FAILED` bundle starts it in the background). | — |

- **Dropping tickets** (`dropFromBundle`, or the escalation's drop) returns the dropped runs to `READY` and restarts
  integration on the latest default branch; earlier integration commits are discarded and conflicts are resolved
  again. A note listing the remaining tickets goes with the integrator's next task. An open PR is reused and its
  title and description rewritten at the next delivery. Dropping every member is cancelling.
- **Messages** (`messageBundle`) go to the current reviewer while `REVIEWING`, otherwise the integrator, as steers
  with a header (`bundleMessageTarget` and `bundleMessageContent` in `messages.ts`); QA takes none; a terminal bundle
  refuses them. A change the integrator makes after a passing review goes back through `REVIEWING` before delivery
  or merge.
- **The integrator** (`role-integrator` in `prompts.ts`) has the builder's write tools (`coding`, `test-runner`,
  `web-search`) but no `subagent`, in a write sandbox on the bundle worktree (`WRITE_ROLES` in `sandbox.ts`).

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
   human's first message. Leaving `OPEN` deletes the checkout, its manifest, local branch, scratch and environment
   record (full cleanup), so a reopen or retry normally re-creates them: `refresh` finds no checkout and makes a fresh
   one with `GitHub.open`, and `provision` makes a new record. A reopen or retry keeps the Conversation and resyncs any checkout that is still there (`GitHub.refresh`):
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
- **One Pi Durable Task per bundle** (task `factory.bundle`). Its transitions commit the `factory.bundle` Document
  with the checkpoint, and the member runs' Documents in the same commit when membership changes or the bundle
  merges, so a crash never leaves a run half in a bundle. Integration progress (the next member, a conflict in hand,
  the attempt) is recorded as it happens; after a crash a merge still in progress in the worktree is picked up
  (a conflicted one goes back to the integrator, a resolved one is concluded). The integrator's inputs use request
  IDs such as `<bundle>:INTEGRATING:<integration>:<run>:<attempt>`, so a resumed resolution reattaches to the same
  turn of the same integrator Conversation. `test/durability.test.ts` kills the factory while the integrator
  resolves a conflict.
- **Upgrades.** `Factory.migrateRuns` runs at startup, once per run that predates bundles: it marks runs that had
  begun delivering as `legacy` (they finish the old way; `test/durability.test.ts` kills one while it waits for CI)
  and the rest as on the new flow.
- **One Pi Durable Task per discussion.** A pending `PREPARING` runs again after a crash; a turn in progress resumes
  waiting on its Conversation; a `submit_tickets` that was recorded but not applied is applied once. Turn inputs are
  submitted with the request ID `<id>:turn<n>`. `test/durability.test.ts` kills the factory mid-turn, mid-draft and
  right after `createTicket`.
- **Agent work is idempotent.** Input to a role Conversation is submitted with a request ID derived from the run,
  phase and sequence number, such as `<run>:BUILDING:<n>`. A resumed phase therefore reattaches to the same turn
  instead of submitting it twice. The builder Conversation persists across rounds, so its context survives fix
  rounds and restarts.
- **`GitHub` and `Sandbox` calls are idempotent per run and bundle.**
  - `open` keeps a per-run workspace record, `openBundle` a per-bundle one (`<workdir>/bundles/<id>.json`).
  - `mergeMember` is skipped for a branch the integration already contains, and `deliverBundle` reuses the bundle's
    PR.
  - `writeArtifact` and `annotate` are no-ops when the change is already there.
  - `provision` reuses an existing environment record.
- **Pending asks are stored in the run (or bundle) Document.** They survive restarts, and a browser that connects later sees
  them through `getRun` or as `run.ask` events. The first valid answer resolves an ask; later answers are rejected.
- **Pinning.** When a run starts, it records:
  - its effective config (global settings merged with the project's), and a hash of it;
  - the Pi Durable version.

  The run then uses that pinned config for its whole life. Settings changes affect only new runs. A bundle pins the
  project's effective settings when it is created in the same way.
- **Storage** is SQLite by default (`storage.kind: sqlite`); `jsonl` is the alternative. Tests use in-memory storage
  or SQLite.

## Disk cleanup

`src/core/cleanup.ts` (spec `docs/specs/run-mv58bn4q-q2zs.md`, rules in `docs/spec.md` §8.1). Each run, bundle and
discussion is an owner; its things live under its pinned workdir.
- **`cleanupScope(owner)`** is the one pure rule: `none`, `scratch` (only the scratch dirs; environment records stay
  so a retry resumes without provisioning) or `full` (remote branch, worktree, `git worktree prune`, local branch,
  manifest, scratch dirs, environment records, in that order). Every caller uses it.
- **`Cleaner.cleanup(owner, scope)`** never throws and returns `{ removed, failures }`. Each step is idempotent and
  attempted even if an earlier one failed; failures are logged with the owner and step. Git steps go through
  `GitHub.discard` / `deleteRemoteBranch` under the per-clone lock; scratch and records through
  `Sandbox.removeScratch` / `destroy`. The `cleanedUp: { at, scope }` marker is committed only when every step
  succeeded (Tasks in their terminal commit, the core and sweep with `root.commit`); `scratch` can become `full`,
  `full` is final, and a retry or reopen deletes it.
- **Where it is called:** the run and bundle Tasks' `finalize` and `abort` (`cleanAtEnd`, after the environments
  are disposed and before the terminal commit); the discussion Task wherever it leaves `OPEN` (closed, failed, or
  aborted); `clearRuns` and `cancelBundle` of a `FAILED` bundle (in the background, after their commit); the startup
  sweep; `gc`.
- **Per-owner serialisation:** `Cleaner.exclusive(id, …)` chains work per owner id, so two cleanups of an owner never
  overlap, and `retryRun`, `retryBundle` and discussion reopen/retry commit through it (after any in-flight
  cleanup). `cleanupsSettledForTests()` awaits background cleanups and a running sweep.
- **The sweep** (`Cleaner.sweep`, single flight) starts from `Factory.start()` after `harness.resume()`, in the
  background. Records pass: every owner whose scope isn't covered by its marker and whose Task isn't live is
  re-read and cleaned. Orphans pass: in the global and every pinned workdir, factory-named entries
  (`runs/run-*`, `bundles/bundle-*`, `discussions/disc-*`, their `.json`, `scratch/<id>-<role>`) whose id matches no
  record are removed (`GitHub.removeOrphanWorktree` for worktrees), and so are environment records without an owner.
  Clone sweep: `GitHub.sweepClone` prunes worktrees and deletes local `factory/*` branches not checked out whose owner
  is unknown or fully cleaned. It logs one summary line (`disk sweep: removed N items (…), K failures`) and one line
  per failure. `gc` (a core operation) runs it on demand and returns `{ removed, failures, summary }`.

## Operations and events

`FactoryCore` (`src/core/types.ts`) is the core's whole outside surface. It has no transport of its own; the web
server is its transport.

- **Projects:** `createProject`, `getProject`, `listProjects`.
- **Models:** `listModels()` returns `{ id: "provider/modelId", name?, provider }[]`, the models the model host
  reports as available (with credentials; `models.getAvailable()`, as `factory setup roles` uses). It is read-only and
  needs no project.
- **Runs:** `startRun`, `getRun`, `listRuns`, `getConversation`, `cancelRun`, `cancelRuns`, `retryRun`, `clearRuns`.
  - `getRun` returns a `RunView`.
  - `cancelRuns(runs, reason?)` is the bulk `cancelRun` (the board's select mode uses it). It checks the whole call
    first (`invalid` for an empty or malformed list, `not_found`, `conflict` for a terminal run or a member of an
    active bundle, `FAILED` included), re-checks inside one commit that sets `cancelReason` on every run, and only
    then aborts each run's task (`harness.abortTask`). Each run then reaches `CANCELLED` through the run task's own
    cancellation path, exactly as with `cancelRun`. Returns `{ cancelled }`.
  - `clearRuns(runs)` archives terminal runs (`DELIVERED`, `FAILED`, `CANCELLED`) so they leave the board: it sets
    `cleared: { at, by }` on each run's `RunDoc`, then starts a full cleanup of each cleared run in the background
    without waiting for it (worktree, manifest, branches, scratch, environment records; the record, conversations,
    screenshots and delivery stay; `RunIndex` is unchanged). The whole call is checked first and applied in one commit: an empty list
    is `invalid`, an unknown id `not_found`, a run that isn't terminal `conflict`. Runs already cleared are skipped and
    left out of the result `{ cleared }`, so the call is idempotent. `listRuns` leaves cleared runs out unless
    `includeCleared: true`; `getRun`, `getConversation`, `getScreenshot` and discussions' run links still work, and
    `retryRun` refuses a cleared run with `conflict`.
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
  - A run in `READY` and in no active bundle takes messages (to its builder); a run in an active bundle refuses them
    with `conflict`.
- **Maintenance:** `gc()` runs the disk sweep now (see [Disk cleanup](#disk-cleanup)); `factory gc` calls it.
- **Bundles:** `createBundle`, `getBundle` (a `BundleView`), `listBundles`, `getBundleConversation`, `mergeBundle`,
  `requestBundleChanges`, `dropFromBundle`, `resolveBundleEscalation`, `cancelBundle`, `retryBundle`,
  `messageBundle`, `getBundleScreenshot`. `cancelBundle` works on any bundle not yet `MERGED` or `CANCELLED`,
  including a `FAILED` one; `retryBundle` only on a `FAILED` one.
- **Discussions:** `startDiscussion`, `getDiscussion`, `listDiscussions`, `getDiscussionConversation`, `say`,
  `stopTurn`, `requestDrafts`, `updateDraft`, `deleteDraft`, `createTicket`, `closeDiscussion`, `reopenDiscussion`,
  `retryDiscussion`. An operation in the wrong state is refused with `conflict`, naming the state.
  `startDiscussion(project, { title?, message, model? })`: a missing or blank `title` is derived from the first
  message (its first non-empty line, whitespace collapsed, markdown heading/bullet markers stripped, cut to 60
  characters on a word boundary with `…`); an empty message is refused with `invalid`.
- **Filters:** `listRuns`, `listBundles` and `listDiscussions` take `{ project?, states? }`; `states` must be an array of known
  states, else the call is refused with `invalid`. `listRuns` also takes `includeCleared?: boolean`.
- **Settings:** `settingsSchema`, `getSettings`, `setSetting`, `unsetSetting`.
- **Events:** `subscribe(filter, on)`. A filter can select a project, a run, a bundle or a discussion; a project
  filter matches run, bundle and discussion events. Event types:
  - `run.state`: a state transition.
  - `run.cleared`: a run was cleared from the board (`clearRuns`); carries `run` and `project`.
  - `run.ask`: a question, approval or escalation is pending.
  - `run.askResolved`: carries `by`, who answered (`web` for the web UI).
  - `run.notice`: progress and the final result.
  - `conversation.updated`: a role transcript changed.
  - `run.message`: a message was sent, and again once it was handed to a Conversation.
  - `bundle.state`, `bundle.ask`, `bundle.askResolved`, `bundle.notice`, `bundle.conversation.updated`: as their
    run counterparts, for a bundle. Member runs emit their own `run.state` events.
  - `discussion.state`: a discussion's state transition.
  - `discussion.updated`: a turn started or ended, drafts were submitted (`submission: true`) or edited, a ticket was
    created, or a notice was added.
  - `discussion.conversation.updated`: the discussion's transcript changed.
  - `settings.changed`

`main.ts` gives the web server the handle `Factory.as("web")`, so the answers and messages it sends are attributed to
`web`. The operations it may call are listed in `CORE_OPS` (`src/core/types.ts`).
- The web server (`startWebServer` in `src/web/server.ts`) maps them onto HTTP on localhost: `POST /api/op/<op>` with
  `{ args }`, and `subscribe` as server-sent events at `/api/events` (`?run=`, `?project=`, `?discussion=`,
  `?bundle=`). QA screenshots are served at `GET /api/runs/<id>/screenshots/<sid>` and
  `GET /api/bundles/<id>/screenshots/<sid>`.
- It also serves the UI: a five-column board (Planning, Build & Review, Ready whose ticked cards are shipped as a
  bundle, Shipping with the bundle cards, Done), a full-screen run view with the run's conversations, a chat box
  addressed by `message`, and approvals in a card that floats over the transcript, a bundle view (`bundles.js`) that
  reuses it with the merge and escalation cards, a
  **Chat** button next to Create that opens discussions as a full-screen chat in the run view's sheet (a history
  rail, project/model/thinking dropdowns locked after the first message, a drafts panel), and a Settings form
  generated from `settingsSchema()`. The UI only calls these operations; it has no state of its own
  beyond a cache.

## The process

`factory serve` is the one process that owns the storage and the core (`src/cli.ts`, `src/daemon.ts`).
- By default it spawns `factory serve --foreground` as a detached child, waits until the child's web server listens,
  prints the link and returns. The child's output goes to `factory.log` (mode 0600) next to the config file.
- `--foreground` runs in the current process, for systemd/launchd and development. It writes `factory.pid` once the
  web server listens and removes it on SIGINT or SIGTERM.
- **The factory never runs without its web UI.** `serve` exits 1 with a one-line reason if the web port is taken, a
  live pid file names a running factory, `secrets.json` is readable by group or others or doesn't parse, the config
  can't be loaded, or the config still has a `stages` or `workers` section or a `roles.<role>.extensions` key (also under `projects.<name>`). The port is checked before any run resumes. Unknown options are refused.
- A pid file that names no running factory (a dead process, or a reused pid) is removed.
- `stop` sends SIGTERM and waits for the process to exit; `status` prints the pid and the link; `web` prints the
  link from `web-url`; `gc` (`src/gc.ts`) POSTs `/api/op/gc` to the running factory through `web-url`, prints the
  summary line, the removed items or "Nothing was removed." and any failures, and exits 1 when no factory is running
  or there were failures; `doctor` (`src/doctor.ts`) checks the config, extensions, models, sandbox, GitHub identity
  (with `commits as: <name> <<email>>` per distinct effective identity, via `GhApiHost.commitIdentity`, or a `FAIL`),
  boat.dev and Parallel keys and `gh`; `setup` runs the wizard above.
- `factory update` and the web UI's Update fast-forward the checkout and restart the process the way it was started
  (see Updates below).
- `factory setup service` can install a systemd user unit or a launchd agent that runs `serve --foreground`. It
  writes the same pid file, so `stop`, `status` and `web` work the same way; `stop` makes it exit 0, which the
  service does not restart.

## Updates

`src/update/` updates the factory to its checkout's upstream tip (spec §12). It is a service next to the core, not
a core operation: `main.ts` builds an `Updater` over the install root (`INSTALL_ROOT`, `src/`'s parent), the factory
home, how the process was started (`detectStartedBy` in `cli.ts serve`) and the active work (`activeWork`: listRuns,
listBundles, listDiscussions), and hands it to `startWebServer` (`/api/version`, `/api/update/{check,apply,dismiss}`).

```
check:  git fetch <remote>  →  rev-list --left-right --count HEAD...@{u}, log HEAD..@{u}, status --porcelain
apply:  re-check (stale SHA → conflict; dirty/ahead/up to date → invalid) → update.json pulling
        → git merge --ff-only <sha> → [installing: npm ci; failure → reset + npm ci → failed]
        → foreground: done ("Restart the factory to finish the update")
        → else restarting: spawn helper (detached; systemd-run --user under systemd)
helper: restartFactory(startedBy) → poll /api/version (≤ 90 s) for the target SHA → done
        | reset --hard <from> (+ npm ci) → restartFactory → rolled-back (reason + factory.log tail)
```

- `restart.ts` (node builtins only) holds `detectStartedBy`, `detectService` (the setup wizard's view from outside)
  and `restartFactory`; `record.ts` reads and writes `update.json`; `helper.ts` is the restart helper. The updater
  reads the three files at startup and writes them to `<home>/update-helper/` when it spawns the helper, so the helper
  that may roll back is the running version's, not the pulled one.
- `startDaemon` marks its child with `FACTORY_DAEMON_ARGS` (the serve arguments); `serve` reads and unsets it.
- `src/update/cli.ts` is `factory update`: through the running factory's HTTP API, or a local `Updater` (pull and
  install only) when none runs.

## Security boundaries

- **Agents never hold the GitHub credentials.** The core and `GitHub` push, open PRs and merge. Agents only work in
  the worktree; the integrator commits merges in the bundle's worktree, and the core pushes them. Their commits carry
  the account's name and no-reply email (`EnvRecord.commitIdentity`), which are not secrets; no token enters the
  environment.
- **Every agent command runs inside `@anthropic-ai/sandbox-runtime`.**
  - Each role has its own write rules. The builder and its helpers, and a bundle's integrator (`WRITE_ROLES`), can
    write their worktree and scratch dir; the
    architect, reviewer and discussant are read-only (they can write only their scratch dir). The QA agent runs in a boat.dev VM (created with `noEnv`), not here.
  - `denyRead` hides secret paths.
  - Network access goes through an allowlist.
  - Commands start from an empty environment, so no credential env vars reach them.
- See DEVIATIONS.md §7 for the Ubuntu ≥ 24.04 Unix-socket relaxation.
- **The web UI is local and token-protected.** It binds to `127.0.0.1`, rejects foreign `Host` headers (DNS
  rebinding) and foreign `Origin`s, requires `application/json` on operations, and needs the access token from
  `web-token` next to the config file (mode 0600). The link's token becomes an HttpOnly, SameSite=Strict cookie.
  A strict CSP allows only same-origin scripts.
- **Secrets stay in the factory home.** `secrets.json` and `pi/auth.json` are 0600, and the sandbox denies the
  factory home except the environment's own paths inside it, and its secret and state entries always. The service
  files hold no credentials.
- **Provider packages are trusted code.** Their extensions run in the factory process, outside the sandbox, with
  access to its credentials; setup says so and asks before installing one.
- **`web_search` runs outside the sandbox, in the factory process.** Its API key stays there. Query text does
  leave the machine, so the tool's section tells agents not to put secrets or private code in queries.
