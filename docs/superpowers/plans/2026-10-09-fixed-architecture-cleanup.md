# Fixed Architecture Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the extension layer so the factory is one fixed solution: the web UI is the interface, GitHub and the local sandbox are the backend, `factory serve` is a daemon, and the layered settings system keeps only fixed, core-owned settings.

**Architecture:** `Factory` takes concrete `GitHub` and `Sandbox` objects and calls them directly with a `RunCtx` (`{ runId, config }` = the run's pinned config). `main.ts` starts the web server directly. Each role gets a fixed tool set (`ROLE_TOOLS`). The settings schema is one constant in `settings.ts`.

**Tech Stack:** Node ≥ 22, TypeScript run through tsx (no build), Pi Durable 1.1.0, pi-ai, `@anthropic-ai/sandbox-runtime`, vitest.

**Spec:** `docs/superpowers/specs/2026-10-09-fixed-architecture-cleanup-design.md`

## Global Constraints

- Run behaviour is unchanged: same states, gates, caps, CI modes, idempotency per `runId`, crash/resume.
- Every task ends with `npm run typecheck` clean and `npm test` green (sandbox tests need bubblewrap + socat; use `TMPDIR=/path/with/space` if `/tmp` is small).
- New setting paths (exact): `workdir`; `github.{identity, visibility}`; `ci.{mode, fixRounds, checks, noChecksTimeout}`; `sandbox.{enabled, allowedDomains, deniedDomains, denyRead, extraWrite, unixSockets, setupScripts}`; `web.{host, port}`; `webSearch.{mode, maxResults, maxCharsTotal, apiKey, endpoint}`. Defaults are today's defaults.
- Global-only: `storage`, `version`, `web`.
- Deleted settings: `stages.*` (including every `use`, `interface.socket`, `delivery.newRepo/existingRepo`), `roles.<role>.extensions`, `workers.*`.
- Fixed tool sets: architect `coding-readonly, web-search`; builder `coding, subagent, test-runner, web-search`; helper `coding-readonly, web-search`; reviewer `coding-readonly, test-runner, browser, web-search`; the `role-<role>` prompt always first.
- `serve` never runs without its web UI: busy port, live pid file or a legacy `stages`/`workers` config → non-zero exit with a one-line reason.
- Files live next to the config file: `factory.pid`, `factory.log`, `web-token`, `web-url`.
- No settings migrator, no Docker.

## Review Focus

1. `serve --config rel/path` from any cwd: the detached child must get absolute paths, and `status`/`stop` from another cwd with the absolute path must find it → test in Task 5.
2. The child fails while starting (legacy config, busy port): the parent must exit 1 within the start timeout, print the child's error, and leave no pid file → test in Task 5.
3. `stop`, `status`, `web` with nothing running: `stop` prints "not running" and exits 0; `status` prints "not running" and exits 1; `web` exits 1 with "not running" → test in Task 5.
4. `web.port` / `web.host` set at project scope must be rejected as global-only, like `storage` → test in Task 2.
5. After `kill -9` of the daemon, the stale pid file must not block the next `serve` → test in Task 5, and exercised by the dry run (Task 6).

---

### Task 1: New layout, CLI client removed

Mechanical move plus CLI deletion. No behaviour change except that the CLI commands other than `serve`, `doctor` and `web` are gone. The dry run will not *run* again until Task 6, but it must still typecheck.

**Files:**
- Move (`git mv`): `src/extensions/github/{host,repo,delivery}.ts` → `src/github/`; `src/extensions/git.ts` → `src/github/git.ts`; `src/extensions/local-worktree/index.ts` → `src/sandbox/sandbox.ts`; `src/extensions/web/{server.ts,ui/}` → `src/web/`; `src/extensions/workers/web-search.ts` → `src/agents/web-search.ts`
- Split: `src/extensions/workers/index.ts` → `src/agents/tools.ts` (Coding, CodingReadonly, Subagent, TestRunner, Browser, `DEFAULT_WORKER_EXTENSIONS`, `DEFAULT_WORKER_SETTINGS`) + `src/agents/prompts.ts` (RoleArchitect, RoleBuilder, RoleReviewer, RoleHelper)
- Delete: `src/extensions/cli/`, the `src/extensions/` directory
- Modify: `src/main.ts` (drop `cliInterface`, the `socket` option), `src/cli.ts` (keep only `serve`, `doctor`, `web`; drop `--socket`), `scripts/dry-run.ts` (import path only), every importer in `src/` and `test/`

- [ ] **Step 1:** Do the moves and the split, then fix the imports (`rg -l "extensions/" src test scripts`).
- [ ] **Step 2:** Strip `src/cli.ts` down to `serve`, `doctor` and `web`, with matching `HELP` text. In `doctor`, build the `Factory` without `cliInterface()`.
- [ ] **Step 3:** Verify. Run `rg -n "extensions/(cli|github|web|workers|local-worktree)|extensions/git" src test scripts`; expected: no output. Run `npm run typecheck && npm test`; expected: clean, all green.
- [ ] **Step 4:** Commit: `refactor: move to github/sandbox/web/agents layout; remove CLI client and socket server`.

---

### Task 2: Web server started directly; interface and intake machinery removed

**Files:**
- Modify: `src/web/server.ts`, `src/main.ts`, `src/core/core.ts`, `src/core/settings.ts`, `src/core/run-task.ts`, `src/core/types.ts`
- Test: `test/web.test.ts`, `test/settings.test.ts`

**Interfaces:**
- Produces: `startWebServer(core: FactoryCore, opts: { host: string; port: number; tokenFile?: string; log?: (m: string) => void }): Promise<{ url: string; stop(): Promise<void> }>` in `src/web/server.ts`. It throws `Error(\`web UI: ${host}:${port} is in use (set web.port or pass --port)\`)` on `EADDRINUSE` and `Error(\`web UI: ${host}:${port} is not allowed\`)` on `EACCES`. It still writes `web-url` (0600) next to `tokenFile` and removes it on `stop`.
- Produces: `startFactoryProcess(opts: ProcessOptions): Promise<{ factory: Factory; host: GitHubHost; web: { url: string; stop(): Promise<void> }; close(): Promise<void> }>` in `src/main.ts`. `ProcessOptions` = `{ configPath?, fakeGithub?, scripted?, webPort?, ciPollMs?, log? }` (no `socket`, no `extraExtensions`). Host and port come from `factory.config.effective({ global: true }).web`; `webPort` overrides the port. The server gets `factory.as("web")`. `close()` stops the web server, then the factory.
- Schema: `web: { host: string default "127.0.0.1", port: number default 7317 min 0 max 65535 }`; `GLOBAL_ONLY = ["storage", "version", "web"]`.

- [ ] **Step 1: Write the failing tests**

`test/web.test.ts`: `serve()` uses `startWebServer(t.factory.as("web"), { host: "127.0.0.1", port: opts.port ?? 0, tokenFile, log })`. Replace the busy-port case with:
```ts
test("a busy port is an error, not a silent no-UI start", async () => {
	const blocker = createServer().listen(0, "127.0.0.1");
	await once(blocker, "listening");
	const port = (blocker.address() as AddressInfo).port;
	t = await makeFactory();
	await expect(startWebServer(t.factory.as("web"), { host: "127.0.0.1", port })).rejects.toThrow(`127.0.0.1:${port} is in use`);
	blocker.close();
});
```
`test/settings.test.ts`: add `[{ project: "p" }, "web.port", 8000, /global only/]` and `[G, "web.port", 70000, /above the maximum 65535/]` to the `bad` table, and change the expected top-level schema keys to `["version", "roles", "policy", "web", "storage", "stages", "workers"]` (insert `web` after `policy` in `coreSchema()`); the expected `stages` keys become `["repo", "delivery", "environment"]`.

- [ ] **Step 2:** Run `npx vitest run test/web.test.ts test/settings.test.ts`. Expected: FAIL (`startWebServer` is not exported; `web.port` is an unknown setting).
- [ ] **Step 3:** Implement:
  - Convert `webInterface()` to `startWebServer` as specified above.
  - Add `web` to `coreSchema()` and `GLOBAL_ONLY`.
  - Delete `stages.interface` and `stages.intake` from `settingsSchema()`, and drop them from the `coreRules` loop.
  - Delete `Factory.startInterfaces`, `interfaces`, `intakeStops` and their teardown in `close()`.
  - In `run-task.ts`, delete `svc.intake`, both `writeBack` calls and the `RunUpdate` construction (`sideEffectsAtEnd` keeps only the env disposal).
  - In `types.ts`, delete `IntakeExtension`, `InterfaceExtension`, `RunUpdate` and `FactoryCoreRef`, and remove `"intake" | "interface"` from `FactoryExtension` / `StageName`.
  - Rewire `main.ts` per its Interfaces entry, and update `cli.ts serve` to call `close()` on SIGINT/SIGTERM.
- [ ] **Step 4:** Run `npm run typecheck && npm test`. Expected: clean, all green.
- [ ] **Step 5:** Commit: `refactor: start the web server directly; remove interface and intake extension points`.

---

### Task 3: Fixed agent tool sets; `webSearch` settings; `RunConfigDoc`

**Files:**
- Create: `src/core/run-config.ts` (replaces `src/core/worker-settings.ts`, deleted)
- Modify: `src/agents/tools.ts`, `src/agents/web-search.ts`, `src/core/core.ts`, `src/core/run-task.ts`, `src/core/settings.ts`, `src/web/ui/app.js`
- Test: `test/web-search.test.ts`, `test/settings.test.ts`, `test/helpers.ts`

**Interfaces:**
- Produces in `src/agents/tools.ts`:
  - `ROLE_TOOLS: Record<Role, Extension[]>`, with the role prompt first, then the Global Constraints sets;
  - `AGENT_EXTENSIONS: Extension[]`, every distinct extension in `ROLE_TOOLS`, installed into the registry by `Factory.start()`.

  Removes `DEFAULT_WORKER_EXTENSIONS` and `DEFAULT_WORKER_SETTINGS`.
- Produces in `src/core/run-config.ts`:
  - `RunConfigDoc = defineDoc<{ runId?: string; webSearch: Record<string, any> }>({ kind: "factory.runConfig", version: 1, scope: "conversation", history: "latest", fork: "initial", initial: () => ({ webSearch: {} }) })`;
  - `runConfigOf(api, c): Promise<{ runId?: string; webSearch: Record<string, unknown> }>`.
- Schema: `webSearch` object with today's `workers.web-search` fields and defaults. `roles.<role>` keeps only `{ model, thinking }`. `src/agents/web-search.ts` stops exporting `webSearchSettings`; its parameter checks (maxCharsTotal range etc.) are covered by the schema.
- `CoreOptions` loses `workerExtensions` and `workerSettings`.

- [ ] **Step 1: Write the failing tests**

`test/settings.test.ts`:
- Replace the `teleport` row with `[G, "roles.builder.extensions", ["coding"], /unknown setting/]`.
- Expected top-level schema keys become `["version", "roles", "policy", "web", "webSearch", "storage", "stages"]`.
- Add a test, `"roles have fixed tool sets"`. It asserts `Object.keys((t.factory.settingsSchema().roles as any).fields.builder.fields)` equals `["model", "thinking"]`, and that `ROLE_TOOLS.reviewer.map((e) => e.name)` equals `["role-reviewer", "coding-readonly", "test-runner", "browser", "web-search"]`.

`test/web-search.test.ts`:
- Schema assertions read `(coreSchema().webSearch as any).fields.mode` (default `"fast"`) and `.apiKey` (`{ type: "secretRef", default: "env:PARALLEL_API_KEY" }`).
- The run test's config uses `webSearch: { endpoint: ..., apiKey: ... }` instead of `workers: { web-search: ... }`.
- Keep its assertion that the tool used the pinned values.

- [ ] **Step 2:** Run `npx vitest run test/settings.test.ts test/web-search.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement:
  - `workerExtensionsFor(role, names)` becomes `ROLE_TOOLS[role]`, and its callers stop reading `roleCfg.extensions`.
  - `run-task.ts` and the helper `conversationCreated` hook write `RunConfigDoc` (`runId`, `webSearch: pinned.config.webSearch ?? {}`) where they wrote `WorkerSettingsDoc`.
  - `web-search.ts` reads `runConfigOf(api, c).webSearch`, and its error text names `webSearch.apiKey`.
  - In `settingsSchema()`, delete the `workers` merge. In `coreRules`, delete the installed-worker-extension and `workerSettings.validate` checks.
  - `test/helpers.ts` drops the worker options.
  - In `src/web/ui/app.js`, change `groupOf` so only `roles` groups at depth 2, and set `GROUP_ORDER = ["policy", "roles", "github", "ci", "sandbox", "webSearch", "web", "workdir", "storage"]`.
- [ ] **Step 4:** Run `rg -n "workerSettings|WorkerSettingsDoc|DEFAULT_WORKER|workers\." src test`. Expected: no output. Run `npm run typecheck && npm test`. Expected: green.
- [ ] **Step 5:** Commit: `refactor: fixed per-role tool sets; webSearch settings; RunConfigDoc`.

---

### Task 4: Concrete `GitHub` and `Sandbox`; fixed schema; legacy-config check

This removes the rest of the extension layer.

**Files:**
- Create: `src/github/github.ts` (merges `repo.ts` and `delivery.ts`, both deleted)
- Modify: `src/sandbox/sandbox.ts`, `src/core/{core,run-task,settings,types}.ts`, `src/main.ts`, `src/cli.ts` (`doctor`)
- Test: `test/helpers.ts`, `test/settings.test.ts`, `test/sandbox.test.ts`, `test/machine.test.ts`, `test/web.test.ts`, `test/fixtures/crash-child.ts` (any `stages:` config strings)

**Interfaces:**
- Produces in `types.ts`: `interface RunCtx { runId: string; config: Record<string, any> }` (the run's pinned effective config). It deletes `Configurable`, `RepoExtension`, `DeliveryExtension`, `EnvironmentExtension`, `FactoryExtension`, `StageName` and `StageCallOptions`. `DeliveryContext` loses `runId`, `settings` and `stages`.
- Produces `class GitHub` in `src/github/github.ts`:
  - `constructor(readonly host: GitHubHost)`
  - `open(ref: RepoRef, rc: RunCtx): Promise<Workspace>`, `create(ref: RepoRef, rc: RunCtx): Promise<void>`
  - `diff(ws: Workspace, base: string, head?: string): Promise<Diff>`, `writeArtifact(ws, path, content, message): Promise<void>`
  - `deliver(ws: Workspace, ctx: DeliveryContext, rc: RunCtx): Promise<Delivery>`, `checks(d: Delivery, names: string[] | undefined, rc: RunCtx): Promise<CiStatus>`
  - `annotate(d: Delivery, ws: Workspace, note: string, rc: RunCtx): Promise<void>`, `merge(pr: PrRef, how: "merge" | "squash" | "rebase", rc: RunCtx): Promise<void>`
  - It reads `rc.config.workdir`, `rc.config.github.identity` and `rc.config.github.visibility`. `fork` is gone.
  - Also exports `githubProblems(github: Obj): string[]` (app identity needs `appId`, `installationId`, `privateKeyRef`; message text unchanged).
- Produces `class Sandbox` in `src/sandbox/sandbox.ts`:
  - `constructor(opts: { stateDir: string })`
  - `provision(ws: Workspace, role: Role, rc: RunCtx): Promise<{ envId: string; cwd: string }>`, `env(input: { conversationId: string; cwd?: string; envId: string }): ExecutionEnv`, `dispose(envId: string): Promise<void>`, `status(): { initialized: boolean; unixSockets?: string }`
  - It reads `rc.config.workdir` (scratch root) and `rc.config.sandbox.*` (including `setupScripts`).
  - Also exports `sandboxProblems(sandbox: Obj): string[]`, the extraWrite rules with today's message text.
- `CoreOptions` = `{ configPath, models, github: GitHub, sandbox: Sandbox, storage?, now?, ciPollMs?, log? }`. `CoreServices` replaces `repo/delivery/environment(cfg)` with `github: GitHub` and `sandbox: Sandbox`.
- Produces in `settings.ts`: `coreSchema()` is the complete schema (top-level keys in this order: `version, workdir, roles, policy, github, ci, sandbox, web, webSearch, storage`). `ci.noChecksTimeout` is validated as a duration and `ci.fixRounds` as a whole number, inside `coreRules`.
- Produces `assertNoLegacySections(configPath: string): void` in `settings.ts`. If the file has top-level `stages` or `workers`, it throws `FactoryError("invalid", …)` with this exact message:
  `config uses removed sections (stages, workers); move stages.repo.{identity,visibility} → github.*, stages.repo.workdir and stages.environment.root → workdir, stages.delivery.ci.* → ci.*, stages.environment.sandbox.* → sandbox.*, stages.environment.setupScripts → sandbox.setupScripts, stages.interface.{host,port} → web.*, workers.web-search.* → webSearch.*`
  The parenthesis lists only the sections actually present (`stages`, `workers` or both); the move list is always complete. `Factory.start()` calls it first.

- [ ] **Step 1: Write the failing tests**

`test/settings.test.ts`:
- Rewrite every `stages.delivery.ci.*` path to `ci.*`, `stages.environment.sandbox.*` to `sandbox.*`, and `stages.repo.identity.*` to `github.identity.*`. Expected messages are unchanged.
- Replace the "settingsSchema includes … extension's schemas" test with `"settingsSchema is the fixed core schema"`. It asserts:
  - `Object.keys(schema)` equals `["version", "workdir", "roles", "policy", "github", "ci", "sandbox", "web", "webSearch", "storage"]`;
  - `ci` fields equal `["mode", "fixRounds", "checks", "noChecksTimeout"]`;
  - `sandbox` fields equal `["enabled", "allowedDomains", "deniedDomains", "denyRead", "extraWrite", "unixSockets", "setupScripts"]`.
- Add `"a config with the removed stages/workers sections refuses to start"`: `makeFactory({ config: "version: 1\nstages:\n  delivery: { ci: { mode: off } }\n" })` rejects with `/removed sections \(stages\).*ci\.\*/`.

`test/sandbox.test.ts`: build `new Sandbox({ stateDir })`, and call `provision(ws, role, { runId: "r1", config: { workdir, sandbox: settings.sandbox } })`.

`test/helpers.ts`: the default config uses `workdir: ${dir}/work`, `sandbox: { enabled: false }` and `ci: { noChecksTimeout: 300ms }`, and builds `new Factory({ configPath, models, github: new GitHub(host), sandbox: new Sandbox({ stateDir: join(dir, "state", "environments") }), storage, ciPollMs: 50, log })`.

- [ ] **Step 2:** Run `npx vitest run test/settings.test.ts test/sandbox.test.ts`. Expected: FAIL (imports and paths).
- [ ] **Step 3:** Implement:
  - Build `GitHub` from `repo.ts` + `delivery.ts`, and `Sandbox` from `localWorktree()`. Same bodies, with settings read from `rc.config` as listed above.
  - In `run-task.ts`, replace `stage()` / `opts()` with `rc(d) = { runId: d.id, config: d.pinned.config }` and `ci = d.pinned.config.ci ?? {}`.
  - In `core.ts`:
    - delete `ext()`;
    - make the `env` hook call `this.opts.sandbox.env(...)`;
    - make `settingsSchema()` return `coreSchema()`;
    - make `coreRules` call `githubProblems(eff.github)`, `sandboxProblems(eff.sandbox)` and the CI checks (prefix each problem with its section, e.g. `sandbox.extraWrite: …`), and delete the `stages` loop.
  - Rewire `main.ts` and `doctor` (doctor reads `eff.github.identity`).
  - Update the remaining test config strings: `rg -n "stages" test`.
- [ ] **Step 4:** Run `rg -n "Extension\b|StageCallOptions|stages\.|\.use\b" src test --glob '!src/agents/**'`. Expected: no output, apart from Pi Durable `Extension` imports in `core.ts` and `run-task.ts`. Run `npm run typecheck && npm test`. Expected: green.
- [ ] **Step 5:** Commit: `refactor: concrete GitHub and Sandbox; fixed settings schema; refuse legacy stages/workers config`.

---

### Task 5: `serve` as a daemon; `stop` and `status`

**Files:**
- Create: `src/daemon.ts`, `test/daemon.test.ts`
- Modify: `src/cli.ts`

**Interfaces:**
- Produces in `src/daemon.ts` (all paths derive from an absolute config path):
  - `daemonFiles(configPath: string): { pid: string; log: string; url: string }` → `factory.pid`, `factory.log` and `web-url` in the config file's directory.
  - `livePid(configPath: string): number | undefined`. It reads the pid file and checks liveness with `process.kill(pid, 0)`. A stale file is deleted and the function returns `undefined`.
  - `writePid(configPath: string): void` / `removePid(configPath: string): void`. The pid file holds the bare pid followed by a newline.
  - `startDaemon(configPath: string, serveArgs: string[], timeoutMs = 30_000): Promise<{ pid: number; url: string }>`. It spawns `bin/factory serve --foreground --config <abs> ...serveArgs` detached, with stdout/stderr appended to `factory.log`, then calls `unref()`. It resolves when `livePid` equals the child's pid and `web-url` exists. If the child exits first or the timeout passes, it rejects with the last non-empty line of `factory.log`.
  - `stopDaemon(configPath: string, timeoutMs = 10_000): Promise<"stopped" | "not running">`. It sends SIGTERM and polls until the process is gone. On timeout it throws `Error("factory (pid N) did not stop within 10s")`.
- `cli.ts`:
  - `serve` (default, detached): resolves `--config` to absolute; if `livePid` is set, exits 1 with `already running (pid N)`; otherwise calls `startDaemon` and prints the link. Passes on `--port`, `--fake-github` (made absolute), `--scripted` and `--ci-poll-ms`.
  - `serve --foreground`: calls `startFactoryProcess`, then `writePid` once it returns. On SIGINT/SIGTERM it runs `close()`, `removePid` and exits 0. A start error prints `error: <message>` and exits 1.
  - `stop`: prints `stopped` or `not running`; exits 0 either way.
  - `status`: prints `running (pid N) <link>` and exits 0, or prints `not running` and exits 1.
  - `web`: prints the link, or exits 1 with `not running: start it with \`factory serve\``.
  - `HELP` lists exactly the spec §3 commands.

- [ ] **Step 1: Write the failing tests** in `test/daemon.test.ts`

Each test gets its own temp dir. `cfg` writes `version: 1`, `web: { port: 0 }`, `storage: { path: <dir>/f.sqlite }`, `workdir`, and `sandbox: { enabled: false }`. `factory(args, cwd)` runs `bin/factory` through `execFile`, resolves to `{ code, stdout, stderr }`, and never throws. `afterEach` runs `factory stop`.
```ts
test("serve detaches; status, web and stop work from another cwd", async () => {
	// serve with a RELATIVE config from dir; status/web/stop with the absolute path from os.tmpdir()
	const s = await factory(["serve", "--config", "config.yaml", "--fake-github", "gh", "--scripted"], dir);
	expect(s.code).toBe(0);
	expect(s.stdout).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?token=/m);
	const st = await factory(["status", "--config", join(dir, "config.yaml")], tmpdir());
	expect(st.code).toBe(0);
	expect(st.stdout).toMatch(/^running \(pid \d+\) http:/);
	expect((await fetch(new URL("/", link(st.stdout)))).status).toBe(401); // reachable
	expect((await factory(["stop", "--config", join(dir, "config.yaml")], tmpdir())).stdout.trim()).toBe("stopped");
	expect(existsSync(join(dir, "factory.pid"))).toBe(false);
});
test("a second serve refuses while one runs", …);              // code 1, stderr /already running \(pid \d+\)/
test("a busy port fails serve with exit 1 and no pid file", …);  // net server on a port, config web.port = that port; stderr /is in use/
test("a legacy stages config fails serve with exit 1", …);      // stderr /removed sections \(stages\)/, no factory.pid
test("a stale pid file is cleaned up", …);                      // serve, SIGKILL the pid, serve again → code 0, new pid
test("stop/status/web with nothing running", …);                // stop: 0 + "not running"; status: 1 + "not running"; web: 1 + /not running/
```

- [ ] **Step 2:** Run `npx vitest run test/daemon.test.ts`. Expected: FAIL (`stop` / `status` are unknown commands).
- [ ] **Step 3:** Implement `src/daemon.ts` and the `cli.ts` commands per their Interfaces entries.
- [ ] **Step 4:** Run `npx vitest run test/daemon.test.ts`, then `npm run typecheck && npm test`. Expected: green.
- [ ] **Step 5:** Commit: `feat: factory serve runs as a daemon; add stop and status`.

---

### Task 6: Dry run over the web HTTP API

**Files:**
- Modify: `scripts/dry-run.ts`, `docs/dry-run-report.md` (regenerated)

**Interfaces:**
- Consumes: the `factory serve` / `stop` commands and `daemonFiles` from Task 5; the web API (`POST /api/op/<op>` with `authorization: Bearer <token>` → `{ ok, result } | { ok: false, error, code }`; `GET /api/events?run=<id>` as SSE).

- [ ] **Step 1:** Rewrite the driver plumbing:
  - The config uses the new paths (`workdir`, `sandbox.enabled`, `ci.noChecksTimeout: 4s`, `web.port: 0`; no `stages`/`socket`).
  - `serve()` runs `bin/factory serve --config CONFIG --fake-github GH --scripted --ci-poll-ms 200` and reads the link from its stdout. Re-read the link after every restart, because port 0 changes.
  - `kill9()` sends `SIGKILL` to `livePid(CONFIG)`'s pid, then waits until `process.kill(pid, 0)` throws.
  - `api(op, ...args)` throws `Error(error)` on `ok: false`.
  - `status(run)` = `api("getRun", run)`.
  - `transcript(run, which)` resolves `architect`/`builder` and `reviewer` (the last reviewer) from `getRun(run).conversations`, then calls `getConversation`.
  - Every former `factory <cmd>` call maps to its op: `run --repo` → `createProject` + `startRun`; `settings set|unset` → `setSetting` / `unsetSetting` with a parsed value; `escalation` → `resolveEscalation(run, pendingAsk.id, choice)`.
  - The `finally` block runs `factory stop`.
- [ ] **Step 2:** Update the checks:
  - Setting paths become `ci.*`.
  - Replace "terminal attach view followed the run to DELIVERED" with "the SSE event stream reported run.state → DELIVERED". Open `/api/events?run=<run1>` with the bearer token before `drive(run1, …)`, collect `run.state` events, and assert one has `to === "DELIVERED"`.
  - Re-word the checks that mention the CLI. Add a report line listing the dropped CLI-only checks (none expected beyond the attach view, which is replaced).
  - The report header says "driven through the web HTTP API".
- [ ] **Step 3:** Run `npm run dry-run`. Expected: `N/N checks passed` and exit 0. Copy `<dir>/report.md` to `docs/dry-run-report.md`.
- [ ] **Step 4:** Commit: `test: dry run drives the daemonized factory over the web HTTP API`.

---

### Task 7: Docs

**Files:**
- Delete: `docs/extensions.md`
- Rewrite: `README.md`, `docs/configuration.md`
- Modify: `docs/architecture.md`, `docs/design-spec.md`, `DEVIATIONS.md`

- [ ] **Step 1: `README.md`.**
  - The web UI is the interface.
  - Commands are `serve`/`stop`/`status`/`web`/`doctor`. The quickstart becomes `bin/factory serve` then open the link; no `&`, no CLI command list.
  - Update the test table: add `daemon.test.ts`; the `web.test.ts` row now covers busy port as an error.
  - The layout block matches spec §1.
  - Drop the "both interfaces are extensions" and "worker extension" wording.
- [ ] **Step 2: `docs/configuration.md`.**
  - One settings table with the Global Constraints paths and today's defaults.
  - No "owner" column, no stage or worker sections.
  - Note that `web` is global-only and applies at start.
  - Add the legacy-config error, and replace `factory settings` CLI usage with the web Settings view.
- [ ] **Step 3: `docs/architecture.md`.** Replace "Core vs extensions" with "Core and its backends": a diagram of web → FactoryCore → GitHub / Sandbox / role Conversations (fixed tools), and update the file table.
- [ ] **Step 4: `docs/design-spec.md`.** Add at the top: `> **Superseded in part** by [the fixed architecture cleanup](superpowers/specs/2026-10-09-fixed-architecture-cleanup-design.md): no extension layer, web UI only, fixed tool sets, new setting paths.` Add a one-line `> Superseded: …` note at §1 (the goal and non-goal), §3.2, §3.3, §3.6 (interface parts), §5 and §6.
- [ ] **Step 5: `DEVIATIONS.md`.**
  - Delete entries 1 and 5 (StageCallOptions, `fork`).
  - Re-word 2–4 as `GitHub` methods.
  - Update 16 to the new paths.
  - Delete 19, and re-word 20 for `doctor` alone.
  - Add a new entry: "The pluggable extension layer was removed on purpose (see the cleanup spec)."
  - Re-word "the `browser` worker extension" etc. as tools.
- [ ] **Step 6:** Run `rg -n "extension|stages\.|workers\.|factory (attach|run|answer|approve|settings)|socket" README.md docs/*.md DEVIATIONS.md`. Expected: remaining hits are only Pi Durable `Extension` terms, superseded notes and historical spec text. Run `npm run typecheck && npm test`. Expected: green.
- [ ] **Step 7:** Commit: `docs: fixed architecture (web UI, GitHub, sandbox, daemon); remove extension docs`.
