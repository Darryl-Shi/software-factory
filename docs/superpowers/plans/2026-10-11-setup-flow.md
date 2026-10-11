# `factory setup` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An interactive `factory setup` wizard that configures and stores every non-development credential (GitHub,
model providers, including pi provider packages and compatible endpoints, boat.dev and Parallel), the role models, the
host prerequisites and an optional user service.

**Architecture:** The factory hosts pi-coding-agent's `ModelRuntime`/`DefaultPackageManager` over a clean
`<factoryHome>/pi` agentDir as its pi-ai `Models`. Factory secrets live in `<factoryHome>/secrets.json` behind `store:`
refs. The wizard is a set of independent step modules over a `SetupUi` interface (clack in production, `ScriptedUi` in
tests) and a `SetupContext` holding every side-effecting dependency.

**Tech Stack:** TypeScript (ESM, run by tsx, no build), vitest, `@earendil-works/pi-coding-agent@1.1.0`,
`@clack/prompts@1.8.1` (both already added in commit `128d3d2`), `yaml`.

**Spec:** `docs/superpowers/specs/2026-10-11-setup-flow-design.md`

## Global Constraints

- Node ≥ 22. Code style follows the repo: tabs, double quotes, ESM `.ts` imports with the `.ts` extension.
- Dependencies are pinned exactly. Add no dependencies beyond the two already added.
- `secrets.json` and its directory: the file is 0600, the directory 0700. Writes go to a temp file, then rename.
  Secret keys match `^[a-z0-9-]+$`.
- Store keys: `github`, `github-app-key`, `boat`, `parallel`. The refs written are `store:github`,
  `store:github-app-key`, `store:boat`, `store:parallel`.
- The model host uses `agentDir = <factoryHome>/pi` and `cwd = agentDir`. Nothing is ever read from or imported from
  `~/.pi/agent`.
- Setup never runs `sudo` and never installs system packages itself.
- Exact user-facing strings (verbatim from the spec):
  - `factory setup is interactive; run it in a terminal`
  - `setup cancelled; completed sections were saved`
  - `secrets.json has mode <0NNN>; run chmod 600 <path>`
  - `no model credentials configured; run factory setup`
  - `Packages are code that runs inside the factory process, outside the sandbox, with access to its credentials. Review the source before installing.`
  - `The reviewer is meant to be a different model family from the builder`
  - `Disable the sandbox (sandbox.enabled: false)? Agents' commands would run unconfined`
- Section names and order: `prereqs, github, models, roles, qa, search, service`.
- Exit codes: 0 on success, 1 for usage errors and when not a TTY, 130 on cancel.
- Tests never touch the real `~`, the network, `systemctl`, `launchctl` or `gh` on the real PATH. Use temp dirs, stubs
  and local HTTP servers.
- `npm run typecheck` and `npx vitest run` must pass at the end of every task.

## Review Focus

1. **The daemon's config goes stale.** `ConfigStore` caches the YAML document. Setup writes `config.yaml` while
   `factory serve` runs; the daemon must see those changes for new runs, and a later web-UI save must not overwrite
   them. → Task 4 adds reload-on-change to `ConfigStore`, with a two-store test.
2. **A hand-broken `models.json` or an extension that throws** must leave the factory running with the built-in
   providers, and the error must appear as a diagnostic. → Task 2 tests.
3. **Pasted secrets with surrounding whitespace or newlines** are trimmed before they are stored; empty input is
   rejected by `validate`. → Tasks 7 and 10 tests.
4. **`gh` missing when the github section runs:** say `gh CLI not found; run factory setup prereqs` and offer
   Retry/Skip, instead of an opaque spawn error. → Task 7 test.
5. **A config with legacy `stages`/`workers` sections:** `factory setup` exits 1 with `assertNoLegacySections`'s
   message before any prompt, and writes nothing. → Task 5 test.

---

## Execution waves

The tasks within a wave touch disjoint files and run in parallel worktrees, merged in task order at the end of the
wave.

| Wave | Tasks |
|---|---|
| 1 | Task 1 (secrets + sandbox), Task 2 (model host), Task 3 (UI layer) |
| 2 | Task 4 (wiring: main, doctor, serve, ConfigStore reload) |
| 3 | Task 5 (context, wizard, step stubs) |
| 4 | Tasks 6–12 (one per section, plus the cli command and docs) |

---

### Task 1: Secret store, `store:` resolution, sandbox denies the factory home

**Files:**
- Create: `src/secrets/store.ts`
- Modify: `src/core/settings.ts:17-26` (`resolveSecret`)
- Modify: `src/sandbox/sandbox.ts` (`policy()`, ~line 226)
- Test: `test/secrets.test.ts`

**Interfaces:**
- Produces:
  - `class SecretStore { constructor(readonly path: string); get(key: string): string | undefined; set(key: string, value: string): void; delete(key: string): void; keys(): string[] }`
  - `secretsPath(factoryHome: string): string`, which returns `join(factoryHome, "secrets.json")`.
  - `SECRET_KEY: RegExp` = `/^[a-z0-9-]+$/`.
  - In `src/core/settings.ts`:
    - `resolveSecret(ref: string | undefined, store?: SecretStore): string | undefined`.
    - `setDefaultSecretStore(store: SecretStore | undefined): void`.

    `resolveSecret` resolves `store:<key>` through `store ?? the default store`, and returns undefined when neither
    exists.
  - Process entry points (main, doctor, setup) call `setDefaultSecretStore`. That way the static `WebSearch`
    extension, `Boat` and `GhApiHost` resolve `store:` refs without being threaded a store (ruling recorded in the
    spec, §2.2).

- [ ] **Step 1: Write failing tests** in `test/secrets.test.ts`. Each uses a `mkdtempSync` dir.
  - `set creates dir 0700 and file 0600, no temp file left`: after `set("github","t")`, check
    `statSync(dir).mode & 0o777` is `0o700` (for a dir the store created) and the file's mode is `0o600`;
    `readdirSync(dir)` is `["secrets.json"]`; the file's JSON equals `{ version: 1, secrets: { github: "t" } }`.
  - `get sees an external write`: write the file by hand with mode 0600, and `get` returns the value.
  - `refuses a group/world-readable file`: `chmodSync(file, 0o644)`; `get("x")` throws
    `secrets.json has mode 0644; run chmod 600 ${file}`.
  - `unparseable file is an error naming it and is never overwritten`: write `{oops`; `get` and `set` throw a message
    containing the path; the file still contains `{oops`.
  - `rejects bad keys`: `set("Bad_Key","v")` throws.
  - `delete removes a key; keys lists keys`.
  - `resolveSecret store refs`:
    - `resolveSecret("store:github", store)` returns the value;
    - `resolveSecret("store:nope", store)` is undefined;
    - `resolveSecret("store:github")` with no default is undefined;
    - after `setDefaultSecretStore(store)` it returns the value (reset it in `afterEach`);
    - `env:` and `file:` refs are unchanged.
- [ ] **Step 2:** `npx vitest run test/secrets.test.ts`. Expect FAIL (module not found).
- [ ] **Step 3: Implement `src/secrets/store.ts`, then `resolveSecret`/`setDefaultSecretStore`.**
  - Mode check: `(stat.mode & 0o077) !== 0` means refuse. Print the mode as `0` + 3 octal digits.
  - Write path: write `secrets.json.<pid>.tmp` with `{ mode: 0o600 }`, then `renameSync`.
  - Missing file: `get` returns undefined, `keys` returns `[]`.
- [ ] **Step 4: In `Sandbox.policy()`, add `dirname(this.stateDir)` (the factory home) to `deny`** before `real()`.
  Add a test to `test/secrets.test.ts`, `sandbox denies the factory home`, if `policy` can be reached through an
  existing exported path. Otherwise export `denyPathsFor(rec: EnvRecord, factoryHome: string): string[]` from
  `sandbox.ts`, use it in `policy()`, and test it: with a stateDir of `/x/home/environments`, the result contains
  `/x/home`.
- [ ] **Step 5:** run `npx vitest run test/secrets.test.ts`, `npm run typecheck`, then `npx vitest run`. Expect all to
  pass.
- [ ] **Step 6: Commit** `feat: secret store behind store: refs; sandbox denies the factory home`.

### Task 2: Model host over pi's ModelRuntime

**Files:**
- Create: `src/models/host.ts`
- Create: `test/fixtures/provider-package/package.json`, `test/fixtures/provider-package/index.ts`,
  `test/fixtures/broken-package/package.json`, `test/fixtures/broken-package/index.ts`
- Test: `test/model-host.test.ts`

**Interfaces:**
- Produces:
  - `interface ModelHost { models: ModelRuntime; packages: DefaultPackageManager; agentDir: string; diagnostics: { type: "error" | "warning"; message: string }[] }`
  - `agentDirOf(factoryHome: string): string`, which returns `join(factoryHome, "pi")`.
  - `createModelHost(opts: { factoryHome: string; scripted?: boolean }): Promise<ModelHost>`
- Approach (proven in a spike):
  1. `mkdirSync(agentDir, { recursive: true, mode: 0o700 })`.
  2. `createAgentSessionServices({ cwd: agentDir, agentDir })`.
  3. `packages = new DefaultPackageManager({ cwd: agentDir, agentDir, settingsManager: services.settingsManager })`.
  4. Diagnostics are `services.diagnostics`, plus `models.getError()` when it is set (type `error`).
  5. `scripted`: `models.registerNativeProvider(scriptedProvider(DRY_RUN_SCRIPTS).provider)`, as
     `createModels` does in `src/main.ts`.

  Never throw for extension or `models.json` errors.
- The fixture `provider-package`:
  - `package.json`: `{ "name": "sf-fixture-provider", "version": "0.0.1", "type": "module", "pi": { "extensions": ["./index.ts"] } }`.
  - `index.ts` calls `pi.registerProvider("sf-fixture", { baseUrl: "http://127.0.0.1:9/v1", apiKey: "SF_FIXTURE_KEY", api: "openai-completions", models: [{ id: "vision-1", name: "Vision 1", reasoning: false, input: ["text","image"], cost: {input:0,output:0,cacheRead:0,cacheWrite:0}, contextWindow: 1000, maxTokens: 100 }, { id: "text-1", name: "Text 1", reasoning: true, input: ["text"], cost: {input:0,output:0,cacheRead:0,cacheWrite:0}, contextWindow: 1000, maxTokens: 100 }] })`.
- The fixture `broken-package`: its extension factory throws `new Error("fixture boom")`.

- [ ] **Step 1: Write failing tests** in `test/model-host.test.ts`. Each test has its own temp factory home.
  - `empty agentDir has built-ins`: `models.getModel("anthropic","claude-opus-5-5")` is defined; `agentDir` exists
    with mode 0700.
  - `models.json provider resolves`: write `<agentDir>/models.json` with a provider `local-x` (`api:
    "openai-completions"`, `baseUrl: "http://127.0.0.1:9/v1"`, one model `m`), and `getModel("local-x","m")` is
    defined.
  - `installed package provider resolves`:
    `await host.packages.installAndPersist(resolve("test/fixtures/provider-package"))`, then a fresh
    `createModelHost` gives `getModel("sf-fixture","vision-1")?.input` containing `"image"`.
  - `broken extension is a diagnostic`: install `broken-package`; the new host's `diagnostics` contains a message
    including `fixture boom`; built-ins are still present.
  - `invalid models.json is a diagnostic`: write `{nope`; there is at least one `error` diagnostic; built-ins are
    present.
  - `cwd extensions are ignored`: create `<process.cwd()>/.pi/extensions/sf-leak.ts` registering provider `sf-leak`
    (remove it in `finally`); `getModel("sf-leak", …)` is undefined.
  - `auth.json credential applies live`: with a host, write `<agentDir>/auth.json` as
    `{"deepseek":{"type":"api_key","key":"k"}}` mode 0600; `(await host.models.checkAuth("deepseek"))?.source`
    becomes `"stored credential"` without a rebuild. Unset `DEEPSEEK_API_KEY` around this test.
  - `scripted registers the scripted provider`: `createModelHost({ factoryHome, scripted: true })`, then `getModel`
    for a model in `DRY_RUN_SCRIPTS`' provider is defined.
- [ ] **Step 2:** `npx vitest run test/model-host.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement `src/models/host.ts`.**
- [ ] **Step 4:** run that test file, `npm run typecheck`, then `npx vitest run`. Expect all to pass.
- [ ] **Step 5: Commit** `feat: model host — pi ModelRuntime and package manager over <factoryHome>/pi`.

### Task 3: Setup UI layer

**Files:**
- Create: `src/setup/ui.ts`
- Create: `test/setup-helpers.ts` (`ScriptedUi`)
- Test: `test/setup-ui.test.ts`

**Interfaces:**
- Produces, from `src/setup/ui.ts`:
  - `SetupUi`, exactly as in spec §3.2;
  - `class SetupCancelled extends Error`;
  - `class ClackUi implements SetupUi`;
  - `authInteraction(ui: SetupUi): AuthInteraction` (pi-ai type).
- `ClackUi`:
  - `isCancel(result)` → throw `new SetupCancelled()`, unless the prompt's `signal?.aborted`, in which case throw
    `signal.reason ?? new DOMException("Aborted","AbortError")`.
  - `text` maps `initial` to `initialValue`; `select`/`confirm` map `initial` to `initialValue`; `multiselect` maps
    `initial` to `initialValues`.
- `authInteraction` maps as in spec §3.2:
  - The `manual_code` prompt passes `prompt.signal` through to `ui.text`.
  - `progress` events drive one lazily started spinner, which is stopped when the next prompt starts or on `info`.
  - `info` with `links` lists each link as `label: url` in the note body.
- `test/setup-helpers.ts` exports:
  - `CANCEL` and `WAIT_FOR_ABORT` symbols;
  - `class ScriptedUi implements SetupUi { constructor(answers: unknown[]); shown: { kind: string; message: string; options?: string[]; body?: string }[]; remaining(): number }`.

  How `ScriptedUi` behaves:
  - Each prompt shifts one answer.
  - `CANCEL` → throw `SetupCancelled`.
  - `WAIT_FOR_ABORT` → return a promise that rejects when the prompt's `signal` aborts.
  - An answer of type `function` is called with the prompt options and its return value is used.
  - If the answers are exhausted, throw `ScriptedUi: no answer for <kind> "<message>"`.
  - `note`, `log.*` and spinner calls are recorded in `shown` with kinds `note`, `log.info`, … and `spinner`.

- [ ] **Step 1: Write failing tests** in `test/setup-ui.test.ts`:
  - `authInteraction maps secret→password, text→text, select→select (returns option id)`, using `ScriptedUi`.
  - `manual_code is withdrawn when its signal aborts`: the answer is `WAIT_FOR_ABORT`; abort the controller; the
    prompt promise rejects with an AbortError.
  - `auth_url and device_code become notes containing the URL / code and verificationUri`.
  - `ScriptedUi CANCEL throws SetupCancelled; exhausted answers throw with the message`.
- [ ] **Step 2:** run, and expect FAIL.
- [ ] **Step 3: Implement** `src/setup/ui.ts` and `test/setup-helpers.ts`. `ClackUi` is a thin mapping and is not
  unit-tested.
- [ ] **Step 4:** run the tests and typecheck. Expect PASS.
- [ ] **Step 5: Commit** `feat: setup UI layer (clack adapter, pi-ai auth interaction, scripted UI for tests)`.

### Task 4: Wiring: process, doctor, serve hint, ConfigStore reload

**Files:**
- Modify: `src/main.ts`:
  - delete `createModels`;
  - `startFactoryProcess` calls `setDefaultSecretStore(new SecretStore(secretsPath(home)))` and
    `createModelHost({ factoryHome: home, scripted })`, logs each diagnostic as `extension: <message>`, and passes
    `host.models`.
- Create: `src/doctor.ts`, moved from `cli.ts doctor()`.
- Modify: `src/cli.ts`: `doctor` prints `runDoctorChecks`; help text gains `factory setup [section] [--config p]`.
- Modify: `src/core/settings.ts` (`ConfigStore`: reload on change).
- Modify: `scripts/dry-run.ts` and any test that imports `createModels`
  (`grep -rn createModels src test scripts`), to use `createModelHost`.
- Test: `test/doctor.test.ts`, `test/settings.test.ts` (add cases)

**Interfaces:**
- Consumes: Tasks 1 and 2.
- Produces:
  - `type DoctorLine = { level: "ok" | "warn" | "FAIL"; text: string }`
  - `runDoctorChecks(configPath: string, opts?: { scripted?: boolean; host?: ModelHost }): Promise<DoctorLine[]>`
  - `formatDoctorLine(l: DoctorLine): string`, in the existing `ok  `/`warn`/`FAIL` format.

  All three come from `src/doctor.ts`. The wizard (Task 5) calls `runDoctorChecks`.

- [ ] **Step 1: Write failing tests.**
  - In `test/settings.test.ts`: `ConfigStore sees external writes and does not clobber them`. Create stores A and B on
    the same file. `A.set({global:true},"ci.fixRounds",1)`, then `B.effective({global:true}).ci.fixRounds === 1`. Then
    `B.set({global:true},"ci.mode","off")`, and the file has both `fixRounds: 1` and `mode: off`.
  - In `test/doctor.test.ts`, with a temp config, a temp factory home and `host` created with `scripted: true`:
    - `store ref source is reported`: secrets.json has `github`, config `github.identity.tokenRef: store:github`. A
      line with level `ok` includes `store:github`.
    - `missing GitHub credential points to setup`: a `warn` line ends with `→ factory setup github`.
    - `role without credentials points to setup models`: a role on a provider without credentials gives a line ending
      with `→ factory setup models`.
    - `extension diagnostics are warn lines`: pass a host whose `diagnostics` holds one error; there is a `warn` line
      containing its message.
    - `qa key missing points to setup qa`.
- [ ] **Step 2:** run, and expect FAIL.
- [ ] **Step 3: Implement.**
  - **ConfigStore:** remember the file's `mtimeMs` and `size` at load. `raw()`, `set()`, `unset()` and
    `createProject()` call `reload()` first if they changed.
  - **doctor:**
    - Keep every existing check and its wording.
    - Credential lines name their source: the ref (`env:…`, `file:…`, `store:…`) for GitHub, boat and Parallel; for
      models, `checkAuth(provider).source`.
    - Add `→ factory setup <section>` to `FAIL`/`warn` lines:
      - GitHub identity → `github`;
      - role models → `models`;
      - sandbox runtime and `gh` → `prereqs`;
      - AQ testing/boat → `qa`.
  - **serve:** in `startFactoryProcess`, after the host is built: if no role's provider passes `checkAuth`, log
    `no model credentials configured; run factory setup`.
- [ ] **Step 4:** run `npx vitest run`, `npm run typecheck` and `DRYRUN_SANDBOX=0 npm run dry-run`. Expect all to pass,
  with the dry-run report showing all checks passing.
- [ ] **Step 5: Commit** `feat: factory runs on the model host and secret store; doctor names sources and points to setup`.

### Task 5: Setup context, wizard, step registry

**Files:**
- Create: `src/setup/context.ts`, `src/setup/wizard.ts`, `src/setup/steps/index.ts`, and **stub** files
  `src/setup/steps/{prereqs,github,models,roles,qa,search,service}.ts`. Each stub exports
  `step: Step` with `status` → `{ state: "missing", detail: "not implemented" }` and `run` → `ui.log.warn("not implemented")`.
- Create: `test/setup-context.ts`, which exports `testContext(opts)`.
- Test: `test/setup-wizard.test.ts`

**Interfaces:**
- Consumes: `SecretStore` (Task 1), `createModelHost`/`ModelHost` (Task 2), `SetupUi`/`SetupCancelled` (Task 3), and
  `runDoctorChecks`/`DoctorLine` (Task 4).
- Produces:
  ```ts
  export const SECTIONS = ["prereqs","github","models","roles","qa","search","service"] as const;
  export type SectionName = (typeof SECTIONS)[number];
  export interface StepStatus { state: "ok" | "warn" | "missing"; detail: string }
  export interface Step { name: SectionName; title: string; status(ctx: SetupContext): Promise<StepStatus>; run(ctx: SetupContext): Promise<void> }
  export interface SetupContext {
    configPath: string; factoryHome: string; repoRoot: string;
    ui: SetupUi;
    secrets: SecretStore;
    host(): Promise<ModelHost>;          // cached
    reloadHost(): Promise<ModelHost>;    // rebuild after packages/models.json change; also rebuilds settings()
    settings(): Promise<ConfigStore>;    // Factory(...).config over the current host's models
    boat: Boat;                          // createBoat(configPath[, fakeBoat])
    fetch: typeof fetch;
    run(cmd: string, args: string[], opts?: { input?: string; env?: Record<string, string> }): Promise<{ code: number; stdout: string; stderr: string }>;
    platform: NodeJS.Platform; env: NodeJS.ProcessEnv; homedir: string;
    daemon: { pid(): number | undefined; restart(): Promise<void> };
    doctor(): Promise<DoctorLine[]>;
    /** Set by a step when packages/models.json changed; the wizard offers a restart at section end. */
    needsRestart: boolean;
  }
  export function createSetupContext(opts: { configPath: string; ui: SetupUi; fakeBoat?: string }): SetupContext
  export async function runSetup(ctx: SetupContext, section?: string, steps?: Step[]): Promise<number>  // exit code
  ```
  - `SECTIONS`, `SectionName`, `StepStatus`, `Step` and `SetupContext` are exported from `src/setup/context.ts`.
  - `runSetup` is in `src/setup/wizard.ts`; `steps` defaults to `STEPS` from `steps/index.ts`.
  - `run` uses `execFile` and never throws on a non-zero exit. A missing binary gives `code: 127`.
  - `daemon.restart()`:
    - if `systemctl --user is-active software-factory` returns 0: `systemctl --user restart software-factory`;
    - on darwin, if the plist is loaded: `launchctl kickstart -k gui/<uid>/dev.software-factory`;
    - otherwise: `stopDaemon(configPath)`, then `startDaemon(configPath, [])`.
  - `createSetupContext` calls `setDefaultSecretStore(secrets)`.
  - `repoRoot` = `resolve(dirname(fileURLToPath(import.meta.url)), "../..")`.
  - `testContext(opts: { answers: unknown[]; config?: string; env?: Record<string,string>; platform?: NodeJS.Platform; run?: SetupContext["run"]; fetch?: typeof fetch; fakeBoat?: boolean })`:
    - creates a temp home containing `config.yaml` (default `version: 1\n`);
    - builds a `ScriptedUi`;
    - uses a real `SecretStore` and a real host created with `scripted: true`;
    - stubs `daemon` with a `restarts` counter;
    - returns `{ ctx, ui, home }`.
- `runSetup` behaviour (spec §3.1):
  1. If `section` is not in `SECTIONS`: `ui.log.error("unknown section <s>; sections: prereqs, github, models, roles, qa, search, service")`, return 1.
  2. `assertNoLegacySections(configPath)` when the file exists. On failure: `ui.log.error(message)`, return 1.
  3. With a section: run that step only, then the restart offer, then return 0.
  4. With no section:
     1. `ui.intro("factory setup")`;
     2. a summary `note`: for each step, `✔`/`⚠`/`✖` followed by `title — detail`;
     3. run each step in order. A step whose state is `ok` first asks `confirm("Reconfigure <title>?", initial false)`.
        After each step, if `ctx.needsRestart` and `ctx.daemon.pid()` is set, ask
        `confirm("Restart the factory to load the new providers?", initial true)`; on yes, `daemon.restart()` and
        reset `needsRestart`;
     4. `ctx.doctor()` lines go into one `note`;
     5. `outro`: `factory is running: <url>` when `daemonFiles(configPath).url` exists and the pid is live, else
        `next: factory serve`.
  5. `SetupCancelled` anywhere → `ui.log.warn("setup cancelled; completed sections were saved")`, return 130.

- [ ] **Step 1: Write failing tests** in `test/setup-wizard.test.ts`, using fake `Step`s that record calls:
  - `unknown section returns 1 and lists sections`.
  - `a section name runs only that step, without summary or doctor`.
  - `ok steps ask to reconfigure and default to skip` (answer `false`, so `run` is not called).
  - `cancel in the third step keeps the first two steps' writes and returns 130`: the fake steps write
    `secrets.set("s1"…)` and `secrets.set("s2"…)`; the third step's answer is `CANCEL`.
  - `legacy config refuses before any prompt`: config `stages: {}`; returns 1; `ui.shown` has no prompts; the file is
    unchanged.
  - `restart is offered when needsRestart and the daemon runs`.
  - `context settings() writes validated config`:
    `(await ctx.settings()).set({global:true},"github.visibility","public")` lands in the file.
- [ ] **Step 2:** run, and expect FAIL.
- [ ] **Step 3: Implement** the context, wizard, step stubs and the `index.ts` registry.
- [ ] **Step 4:** run the tests and typecheck. Expect PASS.
- [ ] **Step 5: Commit** `feat: setup context and wizard with per-section steps`.

### Task 6: Section `prereqs`

**Files:** Replace `src/setup/steps/prereqs.ts`. Test: `test/setup-prereqs.test.ts`.

**Interfaces:**
- Consumes: `Step`, `SetupContext` (Task 5); `SandboxManager.checkDependencies()`.
- Produces: `export const step: Step`, and `installHint(tool: "git"|"gh"|"bubblewrap"|"socat", pm: "apt"|"dnf"|"pacman"|"brew"|undefined): string`.
- Behaviour:
  - **Checks:** Node major ≥ 22 (`process.versions.node`), and `git --version` / `gh --version` via `ctx.run`.
    - The sandbox check is injectable through `ctx.env.SF_TEST_SANDBOX_DEPS`. If it is set, it is a JSON array of
      error strings that replaces `checkDependencies().errors`. This is the test seam.
    - On darwin, check `sandbox-exec` with `ctx.run("which", ["sandbox-exec"])`.
  - **Package manager:** the first of `apt-get`, `dnf`, `pacman`, `brew` that `which` finds.
  - **Install hints:** apt → `sudo apt install <pkgs>`; dnf → `sudo dnf install <pkgs>`; pacman →
    `sudo pacman -S <pkgs>`; brew → `brew install <pkgs>`. On apt, `gh` is installed as `gh`.
    - The hints are **printed, never run**.
  - **Missing items:** a `note` listing them with hints, then `select` **Check again** / **Continue**.
  - **Sandbox still missing:** confirm the exact sandbox-disable string, default false. On yes,
    `settings.set(global,"sandbox.enabled",false)`.
  - **`status`:** `ok` if all present; `warn` if only the sandbox is missing but `sandbox.enabled` is false;
    otherwise `missing`, with the missing names.
- [ ] **Step 1: Write failing tests:**
  - `missing socat prints the apt command and never runs it`: the stubbed run answers `which apt-get`. A note contains
    `sudo apt install socat`. No recorded `run` call starts with `sudo`.
  - `declining keeps the sandbox enabled; accepting writes sandbox.enabled: false`.
  - `all present → status ok`.
- [ ] **Step 2:** run, and expect FAIL. **Step 3:** implement. **Step 4:** tests and typecheck pass.
- [ ] **Step 5: Commit** `feat(setup): prereqs section`.

### Task 7: Section `github`

**Files:** Replace `src/setup/steps/github.ts`. Modify `src/github/host.ts`: add `GhApiHost.whoami`. Test:
`test/setup-github.test.ts`.

**Interfaces:**
- Consumes: Task 5's context; `GhApiHost.token()`.
- Produces: `GhApiHost.whoami(id: Identity): Promise<{ login: string; scopes: string[] | undefined }>`.
  - It runs `gh api -i /user` with the token in `GH_TOKEN`.
  - `scopes` comes from the `x-oauth-scopes` header (case-insensitive, comma-separated, trimmed), or is undefined when
    the header is absent.
  - A non-2xx response throws `GitHub GET /user: <status>`.
- Behaviour (spec §3.4 github):
  1. **Precheck:** `ctx.run("gh",["--version"])`. If the code is non-zero (127 when missing), show
     `gh CLI not found; run factory setup prereqs` and offer Retry/Skip.
  2. **Kind:** a `select` of `pat`/`bot`/`app`, with the current kind as the default.
  3. **Token source (pat/bot):** a `select` of `paste`; `gh` (offered when `ctx.run("gh",["auth","token"])` exits 0
     with output); `env` (offered when `ctx.env.GH_TOKEN` is set).
     - Pasted and imported tokens are `.trim()`ed and stored under `github`; the ref becomes `store:github`. The env
       choice keeps `env:GH_TOKEN`.
     - The `validate` callback rejects empty input with `required`.
  4. **Verify:** `whoami`, then show `Authenticated as <login>`.
     - Classic tokens (`ghp_` prefix): warn when `repo` is missing from `scopes`, and separately when `workflow` is
       missing.
     - `github_pat_` tokens: a note listing the fine-grained permissions from `docs/configuration.md`.
     - On failure: Retry / Save anyway / Skip.
  5. **App:** `text` for `appId` and `installationId` (validated as positive integers), and the PEM path. The file is
     read, must contain `PRIVATE KEY`, and is stored under `github-app-key`. Set `privateKeyRef: store:github-app-key`.
     Verify with `new GhApiHost().token(identity)`. Tests construct GhApiHost with a local server base URL, so
     `ctx` needs no change; the step accepts an optional `apiBase` from `ctx.env.SF_TEST_GITHUB_API`.
  6. **Visibility:** a `select` of `private`/`public`.
  7. **Save:** `github.identity` and `github.visibility` are saved globally through `settings()`.
  - **`status`:** `ok` when the identity's credential resolves (`resolveSecret`); otherwise `missing`. The detail
    names the ref.
- [ ] **Step 1: Write failing tests,** with a fake `gh` on a temp PATH, following the pattern in
  `test/github-api.test.ts`, plus the header line `x-oauth-scopes: repo, read:org`.
  - `pasted token is trimmed, stored as store:github, verified, workflow warning shown`: the answer is
    `"  ghp_abc\n"`; the stored value is `ghp_abc`; the config `tokenRef` is `store:github`; the shown messages include
    `Authenticated as octo`, and a warning about `workflow`.
  - `401 offers retry/save/skip; skip leaves config unchanged`.
  - `gh missing shows the prereqs hint` (PATH without gh, run returns 127).
  - `env choice keeps env:GH_TOKEN`.
  - `app path stores the PEM and sets privateKeyRef`: generate a key with `generateKeyPairSync`; a local HTTP server
    answers `POST /app/installations/7/access_tokens`.
  - `whoami parses scopes` (unit-test `GhApiHost.whoami`).
- [ ] **Step 2:** run, and expect FAIL. **Step 3:** implement. **Step 4:** tests and typecheck pass.
- [ ] **Step 5: Commit** `feat(setup): github section; GhApiHost.whoami`.

### Task 8: Section `models` (logins, packages, compatible endpoints)

**Files:** Replace `src/setup/steps/models.ts`. Create `src/setup/steps/endpoints.ts` (the `models.json` editing
helpers). Create the fixture `test/fixtures/login-provider/{package.json,index.ts}`. Test: `test/setup-models.test.ts`.

**Interfaces:**
- Consumes: `ctx.host()`/`ctx.reloadHost()`, `authInteraction(ctx.ui)` (Task 3), `ctx.settings()`.
- Produces, in `endpoints.ts`:
  - `readModelsJson(agentDir: string): { providers: Record<string, any> }`
  - `writeModelsJson(agentDir: string, doc: { providers: Record<string, any> }): void`, which is atomic, mode 0600,
    and keeps the other keys.
  - `discoverModels(baseUrl: string, apiKey: string | undefined, fetchFn: typeof fetch): Promise<string[]>`, which
    does `GET {baseUrl}/models` and returns `data[].id`, or `[]` on any failure.
  - `providersInUse(cfg: ConfigStore): Map<string, string[]>`, mapping each provider id to the role paths that use it
    (`roles.<role>` at global and every project scope).
- The `login-provider` fixture: a package whose extension registers a **native** provider `sf-login` via
  `pi.registerProvider(createProvider({ id: "sf-login", name: "SF Login", auth: { apiKey: { name: "SF Login key", login: async (i) => ({ type: "api_key", key: await i.prompt({ type: "secret", message: "SF Login key" }) }), resolve: async ({ credential }) => credential?.key ? { auth: { apiKey: credential.key }, source: "stored credential" } : undefined } }, models: [{ id: "m", name: "M", api: "openai-completions", provider: "sf-login", baseUrl: "http://127.0.0.1:9/v1", reasoning: false, input: ["text"], cost: {input:0,output:0,cacheRead:0,cacheWrite:0}, contextWindow: 1000, maxTokens: 100 }], api: openAICompletionsApi() }))`.
  - If the native form proves awkward to import from a package, use the legacy `ProviderConfig` form with an
    `oauth`-less API key. Either way the test must exercise `models.login(id, "api_key", authInteraction(ui))`.
- Behaviour: a loop over a `select` until **Done**.
  - **Log in:**
    - List the provider ids from `models.getProviders()`. Providers used by the current roles come first. Each hint
      is `getProviderAuthStatus(id)`: `configured (<source>)` or `not configured`.
    - Method: offer `api_key` when `provider.auth.apiKey?.login` exists, and `oauth` when `provider.auth.oauth`
      exists. Ask only when both exist.
    - Then `models.login(id, type, authInteraction(ui))` and confirm with `checkAuth`.
    - Errors → Retry / Skip ("Save anyway" does not apply; nothing was saved).
  - **Log out:** pick from `models.listCredentials()`, then `models.logout(id)`.
  - **Install a provider package:**
    1. `text` for the source.
    2. A `note` with the exact trust string, then `confirm` (default false).
    3. `host.packages.installAndPersist(source)` inside a spinner.
    4. `reloadHost()`. The new provider ids are the difference between `getProviders()` before and after.
    5. If there are new providers: list them, and offer `confirm("Log in to <id> now?")` for each.
    6. If there are none: show the diagnostics, then `confirm("Remove the package?", initial true)` →
       `removeAndPersist`.
    7. Install errors: show the last 20 lines of the message, and persist nothing. (`installAndPersist` throwing
       before it persists is enough; verify with a test.)
    8. Set `ctx.needsRestart = true`.
  - **Remove a provider package:** pick from the user-scope packages that `host.packages` lists.
    - At install time, the provider ids a package added are recorded in `<agentDir>/factory-packages.json` as
      `{ "<source>": ["<providerId>", …] }`.
    - If any of the package's recorded providers is in `providersInUse`, refuse with
      `<provider> is used by <role paths>; change those roles first`.
    - Otherwise `removeAndPersist`, delete the package's entry, and set `needsRestart`.
  - **Add a compatible endpoint:** the prompts are in spec §3.4.
    - The id is validated against `[a-z0-9-]+` and must not be any id in `getProviders()`.
    - The provider entry is written **without** an `apiKey` field.
    - Auth `key`: after writing `models.json` and running `reloadHost()`, call
      `models.login(id, "api_key", authInteraction(ui))`. pi gives every `models.json` provider a generic API-key
      login ("Enter API key") that stores `{ type: "api_key", key }` in `auth.json` (verified in a spike). For
      discovery before the provider exists, the key is collected first with `password` and passed to
      `discoverModels`; the login prompt then receives that same key through `authInteraction` via a one-shot
      prefilled answer, so the user types it once.
    - Discovery for `openai-*` APIs uses `discoverModels`. Per-model prompts use the defaults 128000 / 16384 /
      image no / reasoning no.
    - Test call: `models.completeSimple(model, { messages: [{ role: "user", content: "Reply with OK", timestamp: Date.now() }] })`,
      offered through `confirm` (default true). A failure offers Retry / Save anyway / Skip.
    - Order: write `models.json` → `reloadHost()` → the login (when the auth is `key`) → the test call. Set
      `needsRestart`.
  - **Remove a compatible endpoint:** refuse if it is in `providersInUse` (same message); otherwise delete the entry
    and write.
  - **`status`:** `ok` if every role's provider passes `checkAuth`; otherwise `missing`, listing the providers without
    credentials.
- [ ] **Step 1: Write failing tests:**
  - `api_key login through the scripted UI stores the credential`: install `login-provider` from its fixture path in
    the test home's agentDir, then `reloadHost`. Script: select Log in → `sf-login` → `"key-1"` → Done. `checkAuth("sf-login")`
    is defined; `auth.json` has mode 0600.
  - `install package shows the trust note, lists new providers, sets needsRestart`: uses `test/fixtures/provider-package`
    from Task 2.
  - `declining the trust confirm installs nothing`.
  - `package with no providers offers removal (default yes) and removes it`: uses `test/fixtures/broken-package`.
  - `remove refuses when a role uses the package's provider`: config `roles.builder.model: sf-fixture/text-1`.
  - `endpoint with discovery writes models.json`: a local HTTP server answers `/v1/models` with `{data:[{id:"a"},{id:"b"}]}`;
    select both; `models.json` has provider `my-ep` with models `a` and `b`, and `contextWindow` 128000.
  - `endpoint with key auth stores the key in auth.json via login, typed once`: one `password` answer `"k1"`, and no
    second key prompt; `auth.json`'s `my-ep` is `{ type: "api_key", key: "k1" }`.
  - `endpoint id colliding with a built-in is rejected` (the `validate` message is shown, then a valid id is
    accepted).
  - `remove endpoint in use is refused`.
- [ ] **Step 2:** run, and expect FAIL. **Step 3:** implement. **Step 4:** tests and typecheck pass.
- [ ] **Step 5: Commit** `feat(setup): models section — logins, provider packages, compatible endpoints`.

### Task 9: Section `roles`

**Files:** Replace `src/setup/steps/roles.ts`. Test: `test/setup-roles.test.ts`.

**Interfaces:** Consumes `ctx.host()` and `ctx.settings()`.

- Behaviour (spec §3.4 roles):
  - Roles are visited in the order `architect, builder, helper, reviewer, qa`.
  - Options are `models.getAvailable()` as `provider/id`, labelled with the model name.
    - The current value is the initial choice. If it is unavailable, it is listed first with the hint
      `(no credentials)`.
    - `qa` keeps only models whose `input` includes `"image"`.
    - `helper` puts `Same as builder` (value `__builder__`) first; choosing it unsets `roles.helper.model` and
      `roles.helper.thinking`, and skips the thinking prompt.
  - Thinking is a `select` of `off`/`low`/`medium`/`high`, with the current value as the default.
  - After the builder and reviewer are chosen: if they have the same provider prefix, `log.warn` the exact
    family-warning string.
  - If no model is available at all: `log.error("no models have credentials; run factory setup models first")` and
    return.
  - **`status`:** `ok` if every role's model is available; `warn` if all are known but some lack credentials;
    `missing` if any is unknown.
- [ ] **Step 1: Write failing tests,** using the scripted host plus `test/fixtures/provider-package` installed and
  `SF_FIXTURE_KEY` resolving (the fixture's `apiKey` literal makes it available):
  - `writes roles globally`.
  - `qa lists only image models` (`ui.shown` options for qa include `sf-fixture/vision-1` and not `sf-fixture/text-1`).
  - `Same as builder unsets helper`.
  - `same-provider reviewer warns`.
- [ ] **Step 2–4:** fail → implement → pass (tests and typecheck).
- [ ] **Step 5: Commit** `feat(setup): roles section`.

### Task 10: Sections `qa` and `search`

**Files:** Replace `src/setup/steps/qa.ts` and `src/setup/steps/search.ts`. Test: `test/setup-qa-search.test.ts`.

**Interfaces:** Consumes `ctx.boat` (`Boat.limits(ref)`), `ctx.fetch`, and `parallelSearch(input, settings, { fetch })`
from `src/agents/web-search.ts`.

- **qa:**
  - Choices: `enable` (paste → trimmed → `secrets.set("boat")`, then set `boat.apiKey: store:boat` and
    `qa.enabled: true`); `env` (offered when `BOAT_API_KEY` is set); `off` (set `qa.enabled: false`, then a note that
    project overrides may still turn it on).
  - Verify with `ctx.boat.limits(ref)`. Failure → Retry / Save anyway / Skip. With Skip, nothing is written. The secret
    is written only on success or Save anyway.
  - **`status`:** `ok` if `qa.enabled` is false globally, or the ref resolves; otherwise `missing`.
- **search:**
  - Choices: `paste` (→ `store:parallel`, then set `webSearch.apiKey: store:parallel`); `env` (offered when
    `PARALLEL_API_KEY` is set); `skip`.
  - Then `confirm("Run one test search (billed)?", initial true)`. On yes, call `parallelSearch` with
    `{ objective: "factory setup connectivity check", queries: ["parallel web search"] }`, the effective `webSearch`
    settings with `maxResults: 1`, and `{ fetch: ctx.fetch }`. Failure → Retry / Save anyway / Skip.
  - **`status`:** `ok` if the ref resolves; otherwise `warn` (web search is optional).
- [ ] **Step 1: Write failing tests:**
  - `qa key is trimmed, verified against LocalBoatBackend, stored`: `testContext({ fakeBoat: true })`; the answer is
    `" bk_1 \n"`; the secret is `bk_1`; the config is set.
  - `qa off writes qa.enabled false`.
  - `qa verify failure + skip writes nothing` (a boat stub whose `limits` rejects).
  - `search paste + test search hits the stub endpoint with x-api-key`: a fake `fetch` records the request; the header
    is `x-api-key: pk_1`; the body's `advanced_settings.max_results` is 1.
  - `search skip writes nothing`.
- [ ] **Step 2–4:** fail → implement → pass.
- [ ] **Step 5: Commit** `feat(setup): qa and search sections`.

### Task 11: Section `service`

**Files:** Replace `src/setup/steps/service.ts`. Test: `test/setup-service.test.ts`.

**Interfaces:**
- Produces (exported for tests):
  - `systemdUnit(o: { node: string; repoRoot: string; configPath: string; path: string }): string`
  - `launchdPlist(o: { node: string; repoRoot: string; configPath: string; path: string; log: string }): string`
  - `servicePaths(homedir: string): { unit: string; plist: string }`

  The content is exactly as in spec §3.4, using `ExecStart=<node> --import <repoRoot>/node_modules/tsx/dist/esm/index.mjs --no-warnings <repoRoot>/src/cli.ts serve --foreground --config <configPath>`.
  The plist's `Label` is `dev.software-factory`.
- Behaviour (spec §3.4 service):
  - **Platform:** `linux` → systemd; `darwin` → launchd; anything else → `log.warn("no service support on <platform>")`.
  - **Status:** the unit/plist exists, plus `systemctl --user is-active software-factory` (or
    `launchctl print gui/<uid>/dev.software-factory`).
  - **Actions:** Install/Reinstall / Remove / Skip.
  - **Install:**
    1. If `ctx.daemon.pid()` is set and the service is not active: `confirm("Stop the running factory first?", true)`;
       on yes, `stopDaemon(configPath)`.
    2. Write the file with `node` = `process.execPath` and `path` = `ctx.env.PATH`.
    3. Linux: `systemctl --user daemon-reload`, then `systemctl --user enable --now software-factory`. Then, if
       `loginctl show-user <USER> -p Linger` prints `Linger=no`, offer
       `confirm("Keep the factory running when you are logged out (loginctl enable-linger)?", true)`.
    4. darwin: `launchctl bootstrap gui/<uid> <plist>`.
    5. A command failure shows its output and the manual command, and leaves the file in place.
  - **Remove:** Linux: `systemctl --user disable --now software-factory`, then delete the unit and run
    `daemon-reload`. darwin: `launchctl bootout gui/<uid>/dev.software-factory`, then delete the plist.
  - Uses `ctx.homedir`, `ctx.run` and `ctx.platform` only, with no real `~` or system calls.
  - **`status`:** `ok` if installed and active; `warn` if installed but inactive; `missing` if not installed.
- [ ] **Step 1: Write failing tests,** with a temp `homedir`, a stub `run` recording calls, and platform `linux`
  (one test on `darwin`):
  - `unit content matches` (exact `ExecStart` and `Environment=PATH=` lines, `Restart=on-failure`,
    `WantedBy=default.target`).
  - `install runs daemon-reload and enable --now, offers linger when Linger=no`.
  - `systemctl failure keeps the unit and shows the manual command`.
  - `remove disables and deletes`.
  - `darwin writes the plist and bootstraps`.
- [ ] **Step 2–4:** fail → implement → pass.
- [ ] **Step 5: Commit** `feat(setup): service section (systemd user unit, launchd agent)`.

### Task 12: `factory setup` command and docs

**Files:** Modify `src/cli.ts` (the `setup` branch, and `"setup"` flags parsing). Modify `README.md`,
`docs/configuration.md`, `docs/architecture.md` and `DEVIATIONS.md`. Test: `test/setup-cli.test.ts`.

**Interfaces:** Consumes `createSetupContext`, `runSetup`, `SECTIONS` (Task 5) and `ClackUi` (Task 3).

- `factory setup [section] [--config p]`:
  1. Unknown options are refused, as in `serve`.
  2. If a section is given and it is not in `SECTIONS`: `error: unknown section <s>; sections: …`, exit 1.
  3. If `!process.stdin.isTTY || !process.stdout.isTTY`: stderr `factory setup is interactive; run it in a terminal`,
     exit 1.
  4. Otherwise `process.exit(await runSetup(createSetupContext({ configPath, ui: new ClackUi() }), section))`.
- Docs (spec §7):
  - **README:** Quickstart becomes `npm install` → `bin/factory setup` → `bin/factory serve` (or the installed
    service). The Commands list adds `factory setup`. The Requirements list notes that setup stores credentials and
    that env vars still work.
  - **`docs/configuration.md`:**
    - `store:` is implemented (`secrets.json`, 0600, keys);
    - a new section "Model providers" covering `<factoryHome>/pi` (packages, `models.json`, `auth.json`), the
      providers-only use of extensions, the trust warning, and that restarts are needed for package and endpoint
      changes;
    - the GitHub, boat and web search sections mention `factory setup <section>`;
    - a new section "Running as a service".
  - **`docs/architecture.md`:** the model host and the secret store, and how the wizard is laid out.
  - **`DEVIATIONS.md`:** a new entry, "pi-coding-agent as the model host": why, what is used (providers and virtual
    models only), and that extensions run in-process.
- [ ] **Step 1: Write failing tests** (spawn `bin/factory` with piped stdio and a temp `--config`):
  - `non-TTY exits 1 with the interactive message`.
  - `unknown section exits 1 listing sections`.
  - `--help lists factory setup`.
- [ ] **Step 2–4:** fail → implement → pass. Then run the full `npx vitest run` and `npm run typecheck`.
- [ ] **Step 5: Commit** `feat: factory setup command; docs`.
