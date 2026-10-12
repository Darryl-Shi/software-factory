# Deviations from the design spec ([`docs/design-spec.md`](docs/design-spec.md))

Each entry lists what the spec says, what was built, and why. When the spec named something that doesn't exist or
doesn't work, I took the closest faithful approach. The spec is amended by the
[fixed architecture cleanup](docs/superpowers/specs/2026-10-09-fixed-architecture-cleanup-design.md) (entry 27);
entries name the code as it is now.

## Contracts (§3)

1. **`GitHub.writeArtifact(ws, path, content, message)` was added.** The core must commit the spec into the workspace as `docs/spec.md` (§4 `SPEC_READY`; since bundles, `docs/specs/<run-id>.md`, see 62). The core doesn't touch git itself, and the spec's repo contract has no write operation, so `GitHub` got one small, idempotent method.
2. **`GitHub.annotate(d, ws, note)` was added.**
   - **Spec:** when `if-present` finds no CI, "the delivery note and final report say that there was no CI" (§2). That is only known *after* `deliver` returns and `ci.noChecksTimeout` passes.
   - **Built:** `annotate` appends that note to the PR description. For push-main it commits the note to `docs/delivery-notes.md` as a follow-up commit on `main`. That happens only when no CI exists, and the run's recorded delivery SHA stays the delivered commit.
3. **`GitHub.deliver` gets more than `{ spec, review, request }`.** Its `DeliveryContext` also includes:
   - the spec text;
   - the advisory findings and any accepted blocking findings;
   - the delivery mode (`push-main` / `pull-request`).

   `GitHub` needs these to write the PR description or delivery note (§2 "Findings"). Like every `GitHub` and `Sandbox` call that depends on settings, it also gets the run ID (which keys idempotency, §4) and the run's pinned config.
4. **`FactoryCore.getConversation` accepts string or numeric IDs.** Pi Durable's conversation IDs are numeric. The web UI hands them back as strings, and the core normalises them.

## Bridge and findings (§3.4)

5. **The bridge enforces extra rules beyond the spec's.** These rules are additions, not relaxations:
   - `submit_spec` rejects a spec without an "Acceptance behaviours" heading (§2 says the spec ends with them).
   - Each bridge tool accepts **one** valid submission per expected input. A second `submit_*` in the same turn is refused ("Already submitted").
   - `report_done` must answer **every** blocking finding it was given, and `wontfix` needs a reason. The spec says "responses answers each finding"; this makes that rule mandatory.
   - *(Obsolete since AQ testing: reviewer findings no longer need a `specRef`, as the spec now says; `evidence` is still required. QA findings need evidence and at least one screenshot the QA agent took that round.)*
6. *(Obsolete since AQ testing.)* The reviewer no longer has the `browser` tool set; screenshot evidence now comes from the QA agent driving a boat.dev VM through the Cua Driver. `browser` stays registered only so Conversations of older runs can resume.

## Environment and sandbox (§3.3)

7. **Unix-socket blocking is relaxed automatically on Ubuntu ≥ 24.04 (`sandbox.unixSockets: auto`).**
   - **Spec:** the sandbox's full Linux defaults.
   - **Problem:** this host (Ubuntu 26.04) sets `kernel.apparmor_restrict_unprivileged_userns=1`. Under it, sandbox-runtime's `apply-seccomp` helper fails with "nested userns is capability-restricted", and every sandboxed command fails.
   - **Built:**
     - In `auto` mode, `Sandbox` probes once. If the seccomp step fails, it runs with `allowAllUnixSockets: true`.
     - That drops only the seccomp filter that blocks *creating Unix sockets*. Bubblewrap's filesystem, network-namespace and PID isolation, the proxy allowlist, denyRead and the credential denial all remain, and are tested in `test/sandbox.test.ts` and the dry run. Those tests and a sandbox-on dry run need `bubblewrap` and `socat`, and have not been run since the fixed-architecture refactor (the latest dry run used `DRYRUN_SANDBOX=0`).
     - `block` forces the strict mode; `allow` forces the relaxed one.
   - **Residual risk:** a sandboxed process can connect to Unix sockets it can see on the host (for example a world-accessible Docker socket). Keep such sockets unreadable, or allow nested user namespaces for bubblewrap via an AppArmor profile, and set `unixSockets: block`.
   - **Host setup:** `socat` is a sandbox-runtime dependency; install it with apt.
8. **`TMPDIR` is redirected inside the sandbox.** sandbox-runtime sets `TMPDIR=/tmp/claude`, which is shared and read-only for read-only roles. `Sandbox` re-exports `TMPDIR` to the environment's own scratch dir (§3.3: "a per-run scratch dir that `TMPDIR` and tool caches point to"). `HOME` and the tool caches also point there.
9. **Worktrees are kept after `dispose`.**
   - **Spec:** `DELIVERED` disposes the environment, and only `FAILED`/`CANCELLED` keep the "workspace for inspection".
   - **Built:** `Sandbox.dispose` retires the environment record, but the git worktree, which `GitHub` made, stays on disk in every terminal state.
   - **Why:** the spec defines no workspace-removal operation, and deleting work is the riskier default. Clean up `workdir` manually. Bundles' worktrees (`<workdir>/bundles/<id>`) are kept the same way.
10. **Credential hiding is done twice.** Besides the runtime's `credentials` deny list (env-var names), sandboxed commands start from an empty environment (`inheritEnv: false`) plus a safe allowlist. A credential env var under any name never reaches an agent.

## Settings and config (§5, §6)

11. **Default model IDs.**
    - **Spec example:** `anthropic/claude-opus`, `anthropic/claude-sonnet` and `openai/gpt-6-sol`.
    - **Problem:** the first two are not model IDs that pi-ai's `createModels()` knows.
    - **Built:** `anthropic/claude-opus-5-5`, `anthropic/claude-sonnet-5-5` and `openai/gpt-6-sol`. The reviewer stays in a different model family, per §8's open risks.
12. **No `docs` tool set.** The §5 example gives the architect `[coding-readonly, docs]`. No `docs` extension exists in Pi; the architect's fixed set is `coding-readonly, web-search`, and `web_search` covers looking up library docs (see 22).
13. *(Obsolete since `factory setup`.)* `store:key` refs now resolve through the factory's own secret store, `<factory home>/secrets.json` (mode 0600), which `factory setup` writes; see [configuration](docs/configuration.md#secret-references). The validator still rejects inline secrets that look like tokens.
14. **Extra settings were added** (none weaken §6):
    - `sandbox.setupScripts` and `sandbox.enabled` (tests disable the sandbox), `sandbox.unixSockets` (see 7);
    - `workdir`;
    - `web.host` and `web.port`.

## Runs and durability (§4)

15. **Pinning to the Pi version.** Each run records the Pi Durable version it started with and the hash of its effective config, and resumes on its pinned config. Resuming "on the old Pi version after an upgrade" can't be honoured inside one process: there is only one installed Pi. The version is recorded and pinned in `package.json` (no `^`), as §8 suggests.
16. **Cost records carry `model` and `thinking`.** These are additions. The scripted provider reports tokens but $0, so the dry run's USD figures are 0.

## Interface (§7)

17. **Extra command: `factory doctor`.** It checks the config file (including removed `stages`/`workers` sections and `roles.<role>.extensions` keys), model credentials, the sandbox, the GitHub identity and `gh`.
18. **Run with tsx, no build step.** `bin/factory` runs `src/cli.ts` through tsx, so `tsx` is a runtime dependency.

## Testing substitutes (per the brief: no GitHub token, no model credentials)

19. **Fake GitHub: `LocalGitHubHost`.**
    - Bare git remotes under a directory, with PRs and check runs in a JSON state file.
    - A local CI runner executes a workflow's `run:` steps in a clone of the pushed commit and treats `uses:` steps as satisfied.
    - Tests and the dry run use it. `GhApiHost` (real GitHub via `gh api`) is covered by request-shape tests against a fake `gh` binary, but has **not** run against github.com.
20. **Scripted agents instead of models.** `src/testing/scripted.ts` is a provider on pi-ai's faux provider. `src/testing/dry-run-agents.ts` is a small scripted team that writes, tests and commits a real Node.js CLI inside the sandbox, and reviews it with real test runs and acceptance commands. The prompts and the reviewer's leniency are untested against real models.

## Web UI, messages and web search (added after v1)

The spec was amended for this release (§1, §3.3, §3.4, §3.6, §4, §6, §7): a local web UI ships, humans can message
the agent a run is with, and every role gets a `web_search` tool. The entries below are the choices the amended spec
leaves open, and the places where the code still differs from it.

21. **Web transport and access.**
    - **Built:** HTTP on `127.0.0.1:7317`: `POST /api/op/<op>` with `{ args }` (allowlist `CORE_OPS` in `src/core/types.ts`) and `GET /api/events` as server-sent events for `subscribe`. Core error codes map to HTTP statuses (`not_found` 404, `invalid` 400, `conflict` and `not_pending` 409).
    - **Access:** a token in `web-token` next to the config file (mode 0600, kept across restarts). The link `factory serve` prints carries it; the first visit swaps it for an HttpOnly, SameSite=Strict cookie and drops it from the address bar. `Authorization: Bearer` also works. The server rejects foreign `Host` headers (DNS rebinding) and `Origin`s, requires `application/json` on operations, and sends a CSP that allows only same-origin scripts.
    - **Extra command:** `factory web` prints the link again (from `web-url` next to the token file, written while the server runs).
22. **`web_search` runs in the factory process, not in the sandbox.** Like `subagent`, its `execute` runs where the core runs, so the Parallel API key never enters the sandbox and `api.parallel.ai` needs no `allowedDomains` entry. The cost: query text is an outbound channel from agents that the sandbox's network allowlist doesn't cover. Queries are kept in the transcript and the tool's section warns against secrets in queries. Every role has the tool; without a key it returns an actionable error instead of failing the run.
23. **Run settings for tools travel in a Document.** Pi Durable's `configure({ extensions, tools, cwd })` has no slot for per-run values. The core writes the run's pinned `webSearch` settings into each role Conversation (and helpers) as a `factory.runConfig` Document (conversation scope, forked as initial) that the `web_search` tool reads with `runConfigOf()`.
24. **How messages are delivered.**
    - A message is a two-part user input: a header with the sender and message id plus a note on where the run is, then the human's text. The web UI gets the text back from `getConversation` as items with `author: "human"`; `TranscriptView.queued` lists messages still in the inbox.
    - Messages the core can't hand over yet (the role hasn't started, or the core is about to submit its next input) wait in the run Document and are steered in right after that input. Request ids make each delivery idempotent across crashes.
    - Turns that a message starts while the agent is idle are recorded with `trigger: "message"`. To avoid counting a turn twice, the run Document keeps the usage already accounted per Conversation, and every cost record is the difference from that baseline.
25. **The re-review before delivery compares fingerprints.** `DELIVERING` compares the workspace diff's fingerprint with the one the last passing review saw; any difference (including uncommitted or untracked files) sends the run back to `REVIEWING` with a fresh reviewer and no added round.
26. **Scripted agents understand messages.** `src/testing/scripted.ts` keeps human messages out of a script's `input`/`turn`/`results`, routes side turns to an optional `onMessage`, and acknowledges steers. The dry-run architect revises the spec when a message at the spec gate asks for a change. As with entry 20, real models are untested here.

## Fixed architecture (added after v1)

27. **The pluggable extension layer was removed on purpose** (see the [cleanup spec](docs/superpowers/specs/2026-10-09-fixed-architecture-cleanup-design.md)).
    - **Spec:** every stage (intake, interface, repo, delivery, environment) is an extension selected by `stages.<kind>.use`, and each role's worker extensions are chosen in its settings (§3.2, §3.3, §5, §6).
    - **Built:** the core calls a `GitHub` class and a `Sandbox` class directly; the web UI is the only interface; each role has a fixed tool set; settings live at `workdir`, `github.*`, `ci.*`, `sandbox.*`, `web.*` and `webSearch.*`. `factory serve` runs in the background, and `stop`, `status`, `web` and `doctor` are the only other commands.
    - **Why:** every stage had exactly one implementation, so the pluggability added contracts, lookups, schema merging and docs without buying anything.
    - *(Since then, `factory setup` was added as a further command; see 52–58.)*

## AQ testing and helpers that write (§2, §3.7, §9, §9.1 — added after the fixed architecture)

28. **Boat is called through `@boatdev/sdk@1.9.2`** (pinned). The SDK's base path defaults to `https://boat.dev/api/v1`; `BOAT_BASE_URL` overrides it. The key is the SDK's bearer `accessToken`. This has not been tested against the live boat.dev API (no key here); the tests and the dry run use `LocalBoatBackend` (`--fake-boat <dir>`), a disk-based fake whose "VMs" are directories, whose `cua-driver` is a stub that writes a tiny PNG, and which can simulate an outage (a `fail-create` file) or a ttl stop.
29. **How the reviewed build reaches the VM.** The core writes a commit of the worktree (including uncommitted files) under `refs/factory/<run>/review-<seq>` with a temporary index, bundles it with `git bundle`, uploads the bundle with `writeFile`, and checks it out in `~/app`. The VM never gets GitHub access or credentials (`noEnv: true`). The same snapshot is the baseline for the next reviewer's "changes since the previous review".
30. **One VM per review round**, named `factory-<run>-<seq>`, created with the idempotency key `factory:<run>:<seq>:<attempt>`. The setup script (the first of `sandbox.setupScripts` that exists) runs in the foreground; the first of `boat.runScripts` that exists is started detached (`setsid nohup … > ~/factory-run.log`). If no run script exists the round's QA status is `skipped` and no VM is created. A VM found stopped (ttl) is resumed and the run script restarted on the QA agent's next command, which is told so; a VM that is gone is replaced (attempt + 1) and the QA agent is told. At startup the core deletes VMs named `factory-<run>-<seq>` that do not belong to a run currently in `REVIEWING` at that seq.
31. **QA agent environment.** The QA agent's `bash` runs inside the VM; its `read` reads the VM through a local cache; it cannot write the source (`CodingReadonly`). Its `computer` tool runs `cua-driver call <action> <json> --screenshot-out-file`, copies the PNG out and stores it at `<artifactsDir>/<run>/screenshots/r<seq>-s<n>.png` (default `artifactsDir` = `<config dir>/artifacts`). Ids are recorded per round so `submit_qa` can check them. Screenshots are never committed; the web server serves them at `GET /api/runs/<run>/screenshots/<id>` (and the `getScreenshot` op, base64 over JSON). When the builder's model accepts images, QA screenshots are attached to its findings input as images.
32. **QA status.** Each review round records `ran`, `off`, `skipped` or `unavailable`. `unavailable` (boat could not provide a VM after 3 tries) does not fail or escalate the run: the round is the review alone and a notice says so. The run's status is the last round's; it goes into the final notice, the PR description / delivery notes and the run view. Runs started before this change have no review records and are reported as QA off.
33. **Cost.** QA agent tokens are recorded under role `qa` for the review round; the VM's machine time is a separate `qa` record with `vmSeconds` (from create to dispose) and no USD figure, because the SDK's usage call is account-wide.
34. **Helpers write code** in the builder's environment (its worktree, scratch dir and write rules). No helper environment is provisioned for new runs. `roles.helper` has no defaults; unset, it takes the builder's effective model and thinking (shown with source `default`).
35. **Combined round verdict.** The reviewer and the QA agent run in parallel (`Promise.allSettled`); the round fails if either submitted a blocking finding. Findings are numbered across both (`F1…`), logged as separate `review` and `qa` entries with the same `reviewSeq`, and the next round's reviewer and QA agent each see only their own prior findings plus the builder's responses.

## Discussions (added after AQ testing)

The [discussions spec](docs/superpowers/specs/2026-10-11-discussion-flow-design.md) adds a chat with one model about
one project before any ticket exists. The entries below are where the code differs from it, or from the design spec
because of it.

36. **Discussions may cover product questions.** Design spec §1 says "the discussion covers architecture only". That still holds for the architect's discussion inside a run. A discussion is a separate, optional step before a ticket, and the discussant's prompt invites product questions as well as technical ones.
37. **The `# Prior discussion` section drops the sibling line when there are no siblings.** Discussions spec §2.3 shows "Other tickets drafted from the same discussion (out of scope here unless this ticket depends on them):" unconditionally. When the draft was the only ticket of its submission, that line and its empty list are left out: an empty list tells the architect nothing. Siblings are the other drafts of the same `submit_tickets` submission, which `Draft.batch` records.
38. **Labels in the discussion view.**
    - The header's action reads **Close discussion**, not **Close**.
    - The sheet's exit button (the run view's close button, top right) reads **Close discussion view**. "Close discussion" was already taken by the header action, which closes the discussion itself; two controls with the same name would be ambiguous to screen readers and tests.
    - The first input (the project context and the human's first message) shows as a factory card addressed to the discussant, as the model saw it, not as a message bubble from you.
39. **`GET /api/events` takes `?discussion=<id>`.** Discussions spec §2.1 says the event stream needs no change. It passes `run`, `project` and now `discussion` to `subscribe`, so the UI can follow one discussion.
40. **Stop is asynchronous.** Spec §1.2: `stopTurn` aborts, clears `turn` and adds the notice. Built: `stopTurn` marks the turn as stopped and aborts the Conversation's work; the discussion Task clears `turn` and adds the `stopped` notice ("Stopped by <who>") once that work has ended. Right after `stopTurn` returns, a `say` can still be refused for a moment. `stopTurn` aborts only while the stopped turn is still the one running, so a late Stop doesn't abort the next turn (a tiny window remains between that check and the abort).
41. **Close and reopen wait for the discussion Task.** `closeDiscussion` waits up to 10 s for the discussion's Task to end, so a reopen can follow at once. `reopenDiscussion` and `retryDiscussion` are refused with `conflict` ("still finishing") while the previous Task is still running.
42. **The checkout is on a local branch.** Spec §1.4 says a worktree of the default branch. Built: a worktree on branch `factory/<discussion id>`, started (or restarted, if the branch is left over) from the default branch and resynced to `origin/<default>` on reopen and retry (`GitHub.refresh`, see 45). If the discussion started before its repo existed and the repo exists at reopen, the empty workspace is replaced by a checkout of the repo.
43. **Small additions to the spec's types and checks.**
    - `DiscussionView.cost` is `{ usd, totalTokens }`, not the whole `UsageSum`.
    - Each notice carries the `turn` it belongs to, so the UI can place it after that turn.
    - `updateDraft` refuses an empty change and a title over 200 characters (the `submit_tickets` limit). Drafts can be edited and deleted in a `CLOSED` discussion and during a `say` turn; only a `draft` turn locks them.
    - A model error during a `draft` turn ends it with an `error` notice and no reminders.
44. **`factory doctor` doesn't check `discussion.model`.** It checks the role models. A `discussion.model.model` the factory doesn't know is still refused on save and at `startDiscussion`.
45. **Reopen resyncs the checkout instead of fast-forwarding it** (changed after the final review; the spec was amended to match). The first design fast-forwarded the checkout on reopen and failed the discussion when it couldn't, so a deleted checkout, a force-pushed default branch or a stray local change (possible only with the sandbox off) made every Retry fail the same way. Because the checkout is read-only by design, `GitHub.refresh` now resets it to `origin/<default>` (`checkout -f -B`) and cleans untracked files; a missing checkout, manifest or clone, or a worktree git can't reset, is made again with `GitHub.open`. Only a git failure such as a missing remote fails the discussion, with git's message. Cost: a local change in the checkout is discarded on reopen. `GitHub.open` also ignores a manifest whose repo differs from the one asked for (a discussion id reused after the factory's storage was reset) and makes the checkout again.
46. **`createTicket` works in every discussion state** except while a `draft` turn runs (spec §2.1 first allowed only `OPEN` and `CLOSED`; amended). A run never depends on the discussion, so a `FAILED` or `PREPARING` discussion must not strand its drafts.
47. **A redraft is told about earlier drafts** (spec §2.2 amended). The drafting input lists the drafts that already became tickets (title and run id, "do not re-submit these") and the current drafts' texts, marking the ones the human edited, so the model doesn't re-submit a ticket that is already a run and can keep the human's edits. The submission still replaces every draft that hasn't become a run.
48. **The next turn after a changed checkout carries a factory note** (spec §1.4 amended). When a reopen or retry moved the checkout to another commit, or the repo now exists where the workspace was empty, the next turn tells the model: in a `say` turn the note is in the message's header after the sender (the UI still shows the human's text alone); in a `draft` turn it is a `# Factory note` section at the end of the drafting input.
49. **The discussant's environment is disposed when the discussion leaves `OPEN`** (closed or failed), as a run's environments are when it ends, so its allowed domains leave the process-wide network allowlist. A reopen or retry provisions it again (`Sandbox.provision` reuses the record and clears its `disposed` mark).
50. **`discussion.updated {what: "drafts"}` carries `submission: true` for a new submission.** Edits and deletes emit the same event without it, so interfaces refresh on both but only announce new drafts (the web UI's "Draft tickets are ready" toast).
51. **`states` filters are checked.** `listRuns` and `listDiscussions` refuse a `states` filter that isn't an array of known states with `invalid` (a string used to match by substring and a number gave HTTP 500).

## Setup and model providers (added after AQ testing; [setup spec](docs/superpowers/specs/2026-10-11-setup-flow-design.md))

52. **pi-coding-agent as the model host.** The factory now depends on `@earendil-works/pi-coding-agent@1.1.0` (pinned; it depends on the same `pi-ai ^1.1.0`, so there is one copy of pi-ai).
    - **Spec:** the core receives `createModels()` with pi-ai's providers "straight from Pi" (§3), and a role's `model` is one that `createModels()` knows (§6).
    - **Built:** `createModelHost` (`src/models/host.ts`) runs pi-coding-agent's services over `<factory home>/pi`, with that directory as `cwd` too, so nothing is read from `~/.pi/agent` or from a `.pi/` directory where `serve` starts. `Factory` receives the `ModelRuntime` as its `Models` and is otherwise unchanged. Only what extensions register as **providers and virtual models** is used; their tools, commands, flags and event hooks attach to pi-coding-agent sessions, which the factory never creates, and each role's tool set stays fixed (27).
    - **Why:** pi-durable takes a pi-ai `Models` object and has no extension or package loader. Provider packages, `models.json` endpoints and stored logins (API key or OAuth, with locking and refresh in `auth.json`) are pi-coding-agent's: its `DefaultPackageManager` installs packages, its resource loader runs their extensions, and its `ModelRuntime` combines all of them into one `Models`. Using it avoids reimplementing that, and keeps the formats `pi` users know.
    - **Cost:** extensions are loaded and **run in-process**, outside the sandbox, with access to the factory's credentials. `factory setup` shows a warning and asks before it installs a package. Extension load errors are diagnostics (`serve` logs them, `doctor` warns), never a failed start. New packages and `models.json` changes need a restart; credentials apply live.
53. **A failed login offers Retry / Skip, not Save anyway.**
    - **Spec:** a check that fails, a failed login included, always offers Retry / Save anyway / Skip (§3.4, §5).
    - **Built:** a failed login, and a failed save of a compatible endpoint's key, offer **Retry** / **Skip**. A missing `gh` in the `github` section does too. Failed verifications (`GET /user`, missing token scopes, the App token, boat, the Parallel test search, the endpoint test call) offer all three.
    - **Why:** a login that failed stored nothing, so there is nothing to save anyway.
54. **A rejected setting is not asked again, except in `roles`.**
    - **Spec:** when validation rejects a value, setup shows the message and prompts again; the file is unchanged (§3.3, §5).
    - **Built:** `roles` offers **Retry**, which asks again for the roles the error names, or **Skip**. `github` puts back the secrets it just stored, shows the error with `fix the problem (e.g. factory setup roles), then run factory setup github`, and returns; the wizard goes on to the next section. `prereqs`, `qa` and `search` show the error and return. The config file is unchanged in every case.
    - **Why:** the config is validated as a whole, so outside `roles` a rejection is about another setting (for example a role model pi doesn't know); asking the same question again can't fix it.
55. **A package install shows no spinner.**
    - **Spec:** `packages.install(source)` with a progress spinner (§3.4).
    - **Built:** setup prints a plain `Installing <source>…` line, and npm's and git's output streams to the terminal.
    - **Why:** pi runs npm and git with the terminal inherited, so their output would garble a spinner's animation.
56. **Package removal and re-installs.**
    - **Spec:** removing a package is refused while a role uses a provider it supplied; a package that registers no provider is offered for removal (§3.4).
    - **Built:** setup records the providers each package it installs adds, in `pi/factory-packages.json`, and the in-use refusal applies to those. A package installed another way gets a confirm instead: `setup can't tell which providers <source> supplies; remove it anyway?` (default No). Installing the same package at another version or ref replaces it (pi's own behaviour); setup then warns about providers it no longer supplies and never offers removal. Removal is offered only for a new source that registers no provider.
    - **Why:** pi doesn't record which providers a package registered, and removing the replaced package would bypass the in-use refusal.
57. **Additions to the wizard** (none relax the spec):
    - **Credentials the service won't see.** Before installing the service, setup lists the credentials the factory would read from the environment (`env:` refs that resolve, providers whose key pi reads from an env var), since the unit or plist sets only `PATH`, and asks `Install the service anyway?` (default Yes). The `Keep env:…` options in `github`, `qa` and `search` carry the hint `not seen by a service`.
    - **The outro.** The spec ends with the link "if the service is running, else `next: factory serve`" (§3.1). Setup shows the link whenever the factory runs and has written it, and `the service is starting; factory web prints the link` when the service is active but has not written it yet.
    - **Endpoint keys.** Adding a compatible endpoint first deletes a credential left under its id, and removing one deletes its key from `auth.json` unless a provider with that id remains (a built-in or package provider the entry overrode).
58. **The sandbox re-exposes the environment's own paths inside the factory home.**
    - **Spec:** the sandbox always denies the factory home (`dirname(configPath)`) (§2.3).
    - **Built:** it still denies the whole home, but re-exposes the environment's own worktree, git directory, scratch dir and `extraWrite` paths when they lie inside it. `secrets.json`, `pi/`, `web-token`, `web-url`, `factory.log`, `factory.sqlite*`, `environments/` and `qa-vms/` are denied regardless, as is the `storage.path` database. A write root at, inside or around the home (or around the database) is dropped, and `extraWrite` rejects one at config time.
    - **Why:** a `workdir` inside the factory home (a custom `--config` layout, or the dry run) otherwise hid the agents' own worktrees from them.

## Bundles (added after setup; [bundles spec](docs/specs/run-mv4ghzj2-allm.md))

The bundles spec splits "done building" from "delivered": a run stops at `READY`, and a bundle of one or more Ready
runs of a project delivers them as one PR. Entries 59–63 are where the design spec's single-run delivery no longer
holds; 64–72 are choices the bundles spec left open.

59. **Runs no longer deliver.**
    - **Spec:** `REVIEWING` pass → delivery gate → `DELIVERING` (repo creation, push to `main` or a PR) → `AWAITING_CI` → merge gate → `DELIVERED` (§4).
    - **Built:** `DELIVERING` keeps the no-unreviewed-delivery check (25), commits what the builder left uncommitted and, for an existing repo, pushes `factory/<run-id>`. The run then waits in `READY`, which is not terminal: a message to a run in no bundle goes to its builder (a change goes back through `REVIEWING`, no round added); a run in an active bundle refuses messages and cancel with `conflict`. A run becomes `DELIVERED` when its bundle merges, with the bundle's PR as `artifacts.delivery`. Repo creation, PRs and merging belong to the bundle (`src/core/bundle-task.ts`, `GitHub.openBundle`, `integrationBase`, `mergeMember`, `deliverBundle`, `prState`, `closePr`; `GitHubHost.closePr`, and `updatePr` with a title).
    - **Why:** parallel tickets of one project otherwise competed with each other, and there was no way to ship several together.
60. **CI runs per bundle, not per run.** `ci.mode`, `ci.checks`, `ci.noChecksTimeout` and `ci.fixRounds` (§2, §4 `AWAITING_CI`) now apply to a bundle's delivered commit; a red CI goes to the bundle's integrator, and a review after a CI fix counts toward `ci.fixRounds`. A new run never waits for CI.
61. **The merge gate is legacy; Merge belongs to the bundle.**
    - **Spec:** the optional `merge` gate squash-merges the run's PR; without it the PR is left open (§4, §6).
    - **Built:** `policy.approvals: merge` still validates but no new run stops at it. The bundle's **Merge** (`mergeBundle`) merges its PR with `bundle.mergeMethod` (`merge`, `squash` or `rebase`, default `squash`); merging the PR on GitHub also counts. Until then the PR stays open.
62. **The run's spec is committed at `docs/specs/<run-id>.md`, not `docs/spec.md`** (§4 `SPEC_READY`), so two tickets never collide on it; `RunView.specPath` names it. Runs already past `SPEC_READY` when bundles arrived keep `docs/spec.md`. `docs/spec.md` is now the product spec, which the builder updates only when the repo already has one.
63. **Legacy runs finish the old way.** A run that had begun delivering before the upgrade (`isLegacyDelivery` in `src/core/run-doc.ts`: `DELIVERING`, `AWAITING_CI`, `AWAITING_APPROVAL(merge)`, an escalation from `AWAITING_CI`, or a recorded delivery) is marked `legacy` by `Factory.migrateRuns` at startup and keeps its own PR, CI and merge gate. Every other unfinished run takes the new flow (`flowVersion: 2`).
64. **A `FAILED` bundle keeps its members until it is retried or cancelled.** The spec makes `FAILED` terminal until Retry and says members stay, but not how to free them otherwise. **Cancel bundle** also works on a `FAILED` bundle: it closes the PR and releases the members to plain `READY`. Until then they can't be shipped elsewhere, messaged or cancelled.
65. **The integrator has the builder's write tools but no helpers.** Its tool set is `coding`, `test-runner` and `web-search`, without `subagent`, in a write sandbox on the bundle's worktree (`WRITE_ROLES` in `src/sandbox/sandbox.ts`); its only bridge tool is `report_done`. Conflict resolution is narrow, sequential work on one worktree, where parallel writers would only collide.
66. **The note listing the remaining tickets after a drop goes with the integrator's next task** (a conflict or a findings input), as a `[factory]` line at its top. The spec says the Conversation "gets a note" but not when; sending it on its own would start an idle turn. If the remaining tickets merge cleanly and the integrator has nothing more to do (one ticket left, or the review of the remaining combination passes), it never sees the note; findings from that review carry it.
67. **A moved default branch, a refused merge or a drop re-integrates from scratch.** The bundle's branch is reset to the latest default branch and every member merged again; earlier integration commits are discarded and conflicts are resolved again (with the integrator's Conversation carrying its earlier resolutions in context). Rebasing the old integration was the alternative, but it would carry stale conflict resolutions onto a base they were not reviewed against.
68. **Limits that fail a bundle.** GitHub refusing the merge 3 times over the bundle's life (each refusal followed by an update onto the latest default branch) fails the bundle, as does an integrator that has not concluded a conflicted merge after 3 attempts. Both go to `FAILED`, where Retry or Cancel applies (64).
69. **There is no intake in the code, so `intake.writeBack(done, url)` is the run's final notice.** The spec's §1.1 step for merged members becomes the `DELIVERED` run's final notice, "Merged in bundle-N: <url>", which the web UI shows and the event stream carries.
70. **Ticket keys (`PROJECT-N`) are computed by the core the same way as the web UI**: the project name's first segment, upper-cased and cut to 6 characters, and N counting the project's runs by creation. `BundleView.members[].key` uses it, and so do the bundle's notices and the integrator's inputs.
71. **QA VMs of a bundle are named `factory-bundle-<n>-<seq>`** (entry 30's `factory-<id>-<seq>` with the bundle id), and the startup sweep keeps a bundle's VM only while that bundle is in `REVIEWING` at that seq.
72. **The PR's title and description are rewritten at the next delivery.** After a drop, the bundle re-integrates and goes through `DELIVERING` again, which updates the open PR's title and description to the remaining tickets; it is not rewritten at the moment of the drop.
