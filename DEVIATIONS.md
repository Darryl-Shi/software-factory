# Deviations from the design spec ([`docs/design-spec.md`](docs/design-spec.md))

Each entry lists what the spec says, what was built, and why. When the spec named something that doesn't exist or
doesn't work, I took the closest faithful approach. The spec is amended by the
[fixed architecture cleanup](docs/superpowers/specs/2026-10-09-fixed-architecture-cleanup-design.md) (entry 27);
entries name the code as it is now.

## Contracts (§3)

1. **`GitHub.writeArtifact(ws, path, content, message)` was added.** The core must commit the spec into the workspace as `docs/spec.md` (§4 `SPEC_READY`). The core doesn't touch git itself, and the spec's repo contract has no write operation, so `GitHub` got one small, idempotent method.
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
   - **Why:** the spec defines no workspace-removal operation, and deleting work is the riskier default. Clean up `workdir` manually.
10. **Credential hiding is done twice.** Besides the runtime's `credentials` deny list (env-var names), sandboxed commands start from an empty environment (`inheritEnv: false`) plus a safe allowlist. A credential env var under any name never reaches an agent.

## Settings and config (§5, §6)

11. **Default model IDs.**
    - **Spec example:** `anthropic/claude-opus`, `anthropic/claude-sonnet` and `openai/gpt-6-sol`.
    - **Problem:** the first two are not model IDs that pi-ai's `createModels()` knows.
    - **Built:** `anthropic/claude-opus-5-5`, `anthropic/claude-sonnet-5-5` and `openai/gpt-6-sol`. The reviewer stays in a different model family, per §8's open risks.
12. **No `docs` tool set.** The §5 example gives the architect `[coding-readonly, docs]`. No `docs` extension exists in Pi; the architect's fixed set is `coding-readonly, web-search`, and `web_search` covers looking up library docs (see 22).
13. **`secretRef` supports `env:NAME` and `file:/path` only.** A `store:` key needs a secret-store integration, which Pi doesn't provide as a ready service here. The validator rejects inline secrets that look like tokens.
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

## AQ testing and helpers that write (§2, §3.7, §9, §9.1 — added after the fixed architecture)

28. **Boat is called through `@boatdev/sdk@1.9.2`** (pinned). The SDK's base path defaults to `https://boat.dev/api/v1`; `BOAT_BASE_URL` overrides it. The key is the SDK's bearer `accessToken`. This has not been tested against the live boat.dev API (no key here); the tests and the dry run use `LocalBoatBackend` (`--fake-boat <dir>`), a disk-based fake whose "VMs" are directories, whose `cua-driver` is a stub that writes a tiny PNG, and which can simulate an outage (a `fail-create` file) or a ttl stop.
29. **How the reviewed build reaches the VM.** The core writes a commit of the worktree (including uncommitted files) under `refs/factory/<run>/review-<seq>` with a temporary index, bundles it with `git bundle`, uploads the bundle with `writeFile`, and checks it out in `~/app`. The VM never gets GitHub access or credentials (`noEnv: true`). The same snapshot is the baseline for the next reviewer's "changes since the previous review".
30. **One VM per review round**, named `factory-<run>-<seq>`, created with the idempotency key `factory:<run>:<seq>:<attempt>`. The setup script (the first of `sandbox.setupScripts` that exists) runs in the foreground; the first of `boat.runScripts` that exists is started detached (`setsid nohup … > ~/factory-run.log`). If no run script exists the round's QA status is `skipped` and no VM is created. A VM found stopped (ttl) is resumed and the run script restarted on the QA agent's next command, which is told so; a VM that is gone is replaced (attempt + 1) and the QA agent is told. At startup the core deletes VMs named `factory-<run>-<seq>` that do not belong to a run currently in `REVIEWING` at that seq.
31. **QA agent environment.** The QA agent's `bash` runs inside the VM; its `read` reads the VM through a local cache; it cannot write the source (`CodingReadonly`). Its `computer` tool runs `cua-driver call <action> <json> --screenshot-out-file`, copies the PNG out and stores it at `<artifactsDir>/<run>/screenshots/r<seq>-s<n>.png` (default `artifactsDir` = `<config dir>/artifacts`). Ids are recorded per round so `submit_qa` can check them. Screenshots are never committed; the web server serves them at `GET /api/runs/<run>/screenshots/<id>` (and the `getScreenshot` op, base64 over JSON). When the builder's model accepts images, QA screenshots are attached to its findings input as images.
32. **QA status.** Each review round records `ran`, `off`, `skipped` or `unavailable`. `unavailable` (boat could not provide a VM after 3 tries) does not fail or escalate the run: the round is the review alone and a notice says so. The run's status is the last round's; it goes into the final notice, the PR description / delivery notes and the run view. Runs started before this change have no review records and are reported as QA off.
33. **Cost.** QA agent tokens are recorded under role `qa` for the review round; the VM's machine time is a separate `qa` record with `vmSeconds` (from create to dispose) and no USD figure, because the SDK's usage call is account-wide.
34. **Helpers write code** in the builder's environment (its worktree, scratch dir and write rules). No helper environment is provisioned for new runs. `roles.helper` has no defaults; unset, it takes the builder's effective model and thinking (shown with source `default`).
35. **Combined round verdict.** The reviewer and the QA agent run in parallel (`Promise.allSettled`); the round fails if either submitted a blocking finding. Findings are numbered across both (`F1…`), logged as separate `review` and `qa` entries with the same `reviewSeq`, and the next round's reviewer and QA agent each see only their own prior findings plus the builder's responses.
