# Deviations from the design spec ([`docs/design-spec.md`](docs/design-spec.md))

Each entry lists what the spec says, what was built, and why. When the spec named something that doesn't exist or
doesn't work, I took the closest faithful approach.

## Contracts (§3)

1. **Extra arguments on layer-2 calls (`StageCallOptions`).**
   - **Spec:** `open(ref)`, `create(ref)`, `merge(pr, how)`, `provision(ws, role)`, `deliver(ws, ctx)`, `checks(d, names)`.
   - **Built:** each call also receives `{ runId, settings, stages }`. These are the run's *pinned* settings for that stage, plus all pinned stage settings.
   - **Why:**
     - Extensions own their settings (§6) but must use the values the run pinned when it started (§4), not the live config.
     - `runId` keys idempotency (§4 invariant).
     - `github-delivery` reads the GitHub identity from `stages.repo`, where the spec puts it (§3.2: "identity is a setting HERE").
   - **Also:** `env()` receives the `envId` that `provision` returned. Every extension object carries `kind` and `name`, so `stages.<kind>.use` can select it.
2. **`RepoExtension.writeArtifact(ws, path, content, message)` was added.** The core must commit the spec into the workspace as `docs/spec.md` (§4 `SPEC_READY`). The core doesn't touch git itself, and the spec's `RepoExtension` has no write operation, so the repo extension got one small, idempotent method.
3. **`DeliveryExtension.annotate?(d, ws, note)` was added (optional).**
   - **Spec:** when `if-present` finds no CI, "the delivery note and final report say that there was no CI" (§2). That is only known *after* `deliver` returns and `ci.noChecksTimeout` passes.
   - **Built:** `annotate` appends that note to the PR description. For push-main it commits the note to `docs/delivery-notes.md` as a follow-up commit on `main`. That happens only when no CI exists, and the run's recorded delivery SHA stays the delivered commit.
4. **`DeliveryContext` carries more than `{ spec, review, request }`.** It also includes:
   - the spec text;
   - the advisory findings and any accepted blocking findings;
   - the delivery mode (`push-main` / `pull-request`);
   - the run ID and the pinned settings.

   Delivery needs these to write the PR description or delivery note (§2 "Findings").
5. **`RepoExtension.fork?` is declared but not implemented.** It is optional in the spec, and nothing in v1 uses it.
6. **`FactoryCore.getConversation` accepts string or numeric IDs.** Pi Durable's conversation IDs are numeric. Interfaces such as the CLI hand them back as strings, and the core normalises them.

## Bridge and findings (§3.4)

7. **The bridge enforces extra rules beyond the spec's.** These rules are additions, not relaxations:
   - `submit_spec` rejects a spec without an "Acceptance behaviours" heading (§2 says the spec ends with them).
   - Each bridge tool accepts **one** valid submission per expected input. A second `submit_*` in the same turn is refused ("Already submitted").
   - `report_done` must answer **every** blocking finding it was given, and `wontfix` needs a reason. The spec says "responses answers each finding"; this makes that rule mandatory.
   - Reviewer findings need a non-empty `specRef` as well as `evidence`.
     - The spec makes `specRef` part of every reviewer finding: it is optional only for human findings.
     - In the tool schema both are declared optional, so the validator can return an actionable error instead of a schema failure.
8. **No screenshot evidence.** The `browser` worker extension is an HTTP client (`http_request` via curl) inside the sandbox; there is no real browser, so evidence is always a command and its output. The spec allows "a browser or HTTP client".

## Environment and sandbox (§3.3)

9. **Unix-socket blocking is relaxed automatically on Ubuntu ≥ 24.04 (`sandbox.unixSockets: auto`).**
   - **Spec:** the sandbox's full Linux defaults.
   - **Problem:** this host (Ubuntu 26.04) sets `kernel.apparmor_restrict_unprivileged_userns=1`. Under it, sandbox-runtime's `apply-seccomp` helper fails with "nested userns is capability-restricted", and every sandboxed command fails.
   - **Built:**
     - In `auto` mode, `local-worktree` probes once. If the seccomp step fails, it runs with `allowAllUnixSockets: true`.
     - That drops only the seccomp filter that blocks *creating Unix sockets*. Bubblewrap's filesystem, network-namespace and PID isolation, the proxy allowlist, denyRead and the credential denial all remain, and are tested in `test/sandbox.test.ts` and the dry run.
     - `block` forces the strict mode; `allow` forces the relaxed one.
   - **Residual risk:** a sandboxed process can connect to Unix sockets it can see on the host (for example a world-accessible Docker socket). Keep such sockets unreadable, or allow nested user namespaces for bubblewrap via an AppArmor profile, and set `unixSockets: block`.
   - **Host setup:** `socat` was installed with apt; it is a sandbox-runtime dependency.
10. **`TMPDIR` is redirected inside the sandbox.** sandbox-runtime sets `TMPDIR=/tmp/claude`, which is shared and read-only for read-only roles. `local-worktree` re-exports `TMPDIR` to the environment's own scratch dir (§3.3: "a per-run scratch dir that `TMPDIR` and tool caches point to"). `HOME` and the tool caches also point there.
11. **Worktrees are kept after `dispose`.**
    - **Spec:** `DELIVERED` disposes the environment, and only `FAILED`/`CANCELLED` keep the "workspace for inspection".
    - **Built:** `dispose` retires the environment record, but the git worktree, which the repo extension owns, stays on disk in every terminal state.
    - **Why:** the spec defines no workspace-removal operation on `RepoExtension`, and deleting work is the riskier default. Clean up `stages.repo.workdir` manually.
12. **Credential hiding is done twice.** Besides the runtime's `credentials` deny list (env-var names), sandboxed commands start from an empty environment (`inheritEnv: false`) plus a safe allowlist. A credential env var under any name never reaches an agent.

## Settings and config (§5, §6)

13. **Default model IDs.**
    - **Spec example:** `anthropic/claude-opus`, `anthropic/claude-sonnet` and `openai/gpt-6-sol`.
    - **Problem:** the first two are not model IDs that pi-ai's `createModels()` knows.
    - **Built:** `anthropic/claude-opus-5-5`, `anthropic/claude-sonnet-5-5` and `openai/gpt-6-sol`. The reviewer stays in a different model family, per §8's open risks.
14. **No `docs` worker extension.** The §5 example gives the architect `[coding-readonly, docs]`. No `docs` extension exists in Pi, so the architect's default is `[coding-readonly]`.
15. **`secretRef` supports `env:NAME` and `file:/path` only.** A `store:` key needs a secret-store integration, which Pi doesn't provide as a ready service here. The validator rejects inline secrets that look like tokens.
16. **Extra settings were added** (each owned by its extension; none weaken §6):
    - `stages.environment.setupScripts` and `sandbox.enabled` (tests disable the sandbox), `sandbox.unixSockets` (see 9);
    - `stages.repo.workdir`;
    - `stages.interface.socket`.

## Runs and durability (§4)

17. **Pinning to the Pi version.** Each run records the Pi Durable version it started with and the hash of its effective config, and resumes on its pinned config. Resuming "on the old Pi version after an upgrade" can't be honoured inside one process: there is only one installed Pi. The version is recorded and pinned in `package.json` (no `^`), as §8 suggests.
18. **Cost records carry `model` and `thinking`.** These are additions. The scripted provider reports tokens but $0, so the dry run's USD figures are 0.

## Interface (§7)

19. **CLI transport is JSON lines over a Unix socket** (`~/.factory/factory.sock`, mode 0600). `factory serve` is the one process that owns storage and the core; every other `factory` command is a client. The spec leaves the transport to the extension (§3.6).
20. **Extra command: `factory doctor`.** It checks model credentials, the sandbox, the GitHub identity and `gh`.
21. **Run with tsx, no build step.** `bin/factory` runs `src/cli.ts` through tsx, so `tsx` is a runtime dependency.

## Testing substitutes (per the brief: no GitHub token, no model credentials)

22. **Fake GitHub: `LocalGitHubHost`.**
    - Bare git remotes under a directory, with PRs and check runs in a JSON state file.
    - A local CI runner executes a workflow's `run:` steps in a clone of the pushed commit and treats `uses:` steps as satisfied.
    - Tests and the dry run use it. `GhApiHost` (real GitHub via `gh api`) is covered by request-shape tests against a fake `gh` binary, but has **not** run against github.com.
23. **Scripted agents instead of models.** `src/testing/scripted.ts` is a provider on pi-ai's faux provider. `src/testing/dry-run-agents.ts` is a small scripted team that writes, tests and commits a real Node.js CLI inside the sandbox, and reviews it with real test runs and acceptance commands. The prompts and the reviewer's leniency are untested against real models.
