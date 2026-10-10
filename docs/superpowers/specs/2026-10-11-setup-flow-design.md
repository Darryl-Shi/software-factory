# `factory setup`: interactive setup of credentials and host

Date: 2026-10-11 · Status: approved design, awaiting spec review

## Intent

Getting the factory from `npm install` to a first real run currently means reading `docs/configuration.md`, exporting
several environment variables (`GH_TOKEN`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `BOAT_API_KEY`,
`PARALLEL_API_KEY`) in the shell that runs `factory serve`, editing YAML by hand, and using `factory doctor` to find
out what is still missing. Only pi-ai's built-in providers are usable, and only with API keys taken from the
environment.

`factory setup` is an interactive terminal wizard that does all the non-development setup:

- **Credentials:** the GitHub identity, model providers (API key or OAuth subscription login), the boat.dev key for AQ
  testing and the Parallel key for web search. They are stored by the factory, so they survive restarts, and no env vars are needed.
- **Bring your own providers:** pi provider packages (`npm:`, `git:` or a local path, as with `pi install`) and
  OpenAI- or Anthropic-compatible endpoints (`models.json`).
- **Role models:** pick each role's model from the models that have credentials.
- **The host:** check prerequisites and optionally install a user service that runs the factory.

Success means:
- On a fresh machine, `factory setup` followed by opening the printed link gives a factory whose `factory doctor`
  shows no `FAIL` lines, without any env var exported.
- A provider that ships only as a pi package (for example one that registers an OAuth provider) can be installed,
  logged in to and selected as a role's model.
- `npm test` and `npm run typecheck` pass.

Out of scope:
- A non-interactive mode (flags, stdin).
- Credential management in the web UI.
- The OS keychain, and encrypting secrets at rest.
- Importing from the user's `~/.pi/agent`.
- Factory basics (workdir, web port, approval gates, CI mode); these stay in the web UI's Settings view.

## 1. Background: pi-durable vs pi-coding-agent

The factory runs its roles as **pi-durable** conversations. pi-durable takes a pi-ai `Models` object and has no
extension or package loader. **Pi extensions** and **pi packages** belong to **pi-coding-agent**, the `pi` app: its
`DefaultPackageManager` installs packages, its resource loader runs their extension factories, and its `ModelRuntime`
gathers these into one pi-ai `Models`:
- the built-in providers;
- `models.json`;
- providers registered by extensions (`pi.registerProvider`);
- credentials in `auth.json`, with file locking and OAuth refresh.

The factory adds `@earendil-works/pi-coding-agent@1.1.0` as a dependency (it depends on `pi-ai ^1.1.0`, the version
already in use, so there is one copy of pi-ai) and uses it **only as a model host**. Extensions are loaded, but only
what they register as **providers and virtual models** is used:
- Tools, commands, flags and event hooks attach to pi-coding-agent sessions, which the factory never creates.
- The roles' tool sets stay fixed.

## 2. Architecture and layout

```
src/
  models/
    host.ts       createModelHost(): pi's ModelRuntime + DefaultPackageManager for <factoryHome>/pi
  secrets/
    store.ts      SecretStore over <factoryHome>/secrets.json; backs `store:` refs
  setup/
    ui.ts         SetupUi interface; ClackUi (@clack/prompts); authInteraction(ui) adapter for pi-ai login
    wizard.ts     runs all sections or one; status summary; final doctor checks
    context.ts    SetupContext: config path, factory home, settings access, model host, secret store, runner
    steps/
      prereqs.ts  github.ts  models.ts  roles.ts  qa.ts  search.ts  service.ts
  cli.ts          + `factory setup [section] [--config p]`
  main.ts         createModels() replaced by createModelHost()
```

New dependencies: `@earendil-works/pi-coding-agent@1.1.0` and `@clack/prompts` (latest 1.x), both pinned exactly
like the existing dependencies.

### 2.1 Model host (`src/models/host.ts`)

```ts
interface ModelHost {
  models: ModelRuntime;               // implements pi-ai Models; what Factory receives
  packages: DefaultPackageManager;
  agentDir: string;                   // <factoryHome>/pi
  diagnostics: { type: "error" | "warning"; message: string }[];
}
createModelHost(opts: { factoryHome: string; scripted?: boolean }): Promise<ModelHost>
```

- `agentDir` is `<factoryHome>/pi` (default `~/.factory/pi`). It is created empty on first use, and nothing is imported
  from `~/.pi/agent`. It holds:
  - pi's `settings.json`, whose `packages` list is written by the package manager;
  - `models.json`;
  - `auth.json` (0600, pi's format and locking);
  - the installed npm and git packages.
- It calls `createAgentSessionServices({ cwd: agentDir, agentDir })`:
  - **`cwd` is `agentDir` on purpose**, so the factory never discovers `.pi/extensions` or `.pi/settings.json`
    from the directory `serve` was started in;
  - the call loads the packages listed in `settings.json`, registers their providers on the `ModelRuntime`, and
    returns diagnostics;
  - `models.refresh({ allowNetwork: false })` runs as part of it.
- `scripted: true` (the dry run and `--scripted`) registers the scripted provider with
  `models.registerNativeProvider(...)`, as `createModels` does today.
- Extension load errors are diagnostics. They never stop the factory:
  - `serve` logs them;
  - `doctor` prints each one as a `warn` line;
  - a role whose model's provider failed to load still fails validation as it does today ("not a model createModels()
    knows").
- Credentials take effect live: `ModelRuntime` reads `auth.json` when it resolves auth, so a login made while the
  daemon runs applies to the next model request.
- New packages and `models.json` changes are picked up at the next start.

`main.ts` and `cli.ts doctor` call `createModelHost` instead of `createModels`. `Factory` is unchanged: it still
receives a `Models`.

### 2.2 Secret store (`src/secrets/store.ts`)

```ts
class SecretStore {
  constructor(path: string)           // <factoryHome>/secrets.json
  get(key: string): string | undefined
  set(key: string, value: string): void
  delete(key: string): void
}
```

- The file is `{ "version": 1, "secrets": { "<key>": "<value>" } }`, and keys match `[a-z0-9-]+`.
- Permissions: the directory is created 0700, and the file is written 0600 to a temp file, then renamed.
- `get` reads the file on every call, so the daemon sees new values without a restart. If the file is readable by
  group or others, it throws `secrets.json has mode 0644; run chmod 600 <path>`.
- Keys used by setup:
  - `github` (PAT or bot token);
  - `github-app-key` (App private key PEM);
  - `boat`;
  - `parallel`.
- `resolveSecret(ref, store?)` in `src/core/settings.ts` resolves `store:<key>` through the store, and returns
  undefined when there is no store or no such key. `env:` and `file:` behave as before.
- The store reaches the code that resolves secrets without a module-level global:
  - `Factory` gets an optional `secrets: SecretStore` dependency;
  - `GhApiHost`, `Boat` and `web-search` receive it from where they are built (`main.ts`) or from the `Factory`;
  - `doctor` builds one.
- Validation is unchanged: `store:key` already passes as a `secretRef`.

### 2.3 Sandbox

The sandbox already always denies `~/.factory` and `~/.ssh`. It will also always deny the **factory home directory**
(`dirname(configPath)`), so `secrets.json` and `pi/` (including `auth.json`) stay hidden when `--config` points
outside `~/.factory`. `Sandbox` receives the factory home from `main.ts`.

## 3. The wizard

### 3.1 Command

```
factory setup [prereqs|github|models|roles|qa|search|service] [--config p]
```

- If stdin or stdout is not a TTY, it exits 1 with `factory setup is interactive; run it in a terminal`.
- An unknown section name exits 1 and lists the valid sections.
- `factory setup` with no section:
  1. shows `intro`, then a status summary with one line per section (`✔`, `⚠` or `✖`, plus where each credential comes
     from, e.g. `env:GH_TOKEN`, `store:github`, `auth.json (OAuth)`);
  2. runs the sections in the order above. A section whose status is `✔` asks `Reconfigure <section>?`, default No;
  3. runs `doctor`'s checks;
  4. ends with `outro`: the web UI link if the service is running, else `next: factory serve`.
- `factory setup <section>` runs that section unconditionally, without the summary or the final checks.
- Each section saves what it collected when it finishes. Ctrl-C at any prompt (clack's `isCancel`) prints
  `setup cancelled; completed sections were saved` and exits 130.

### 3.2 UI layer (`src/setup/ui.ts`)

```ts
interface SetupUi {
  intro(title: string): void; outro(msg: string): void;
  note(body: string, title?: string): void;
  log: { info(m: string): void; warn(m: string): void; error(m: string): void; success(m: string): void };
  text(o: { message: string; placeholder?: string; initial?: string; validate?: (v: string) => string | undefined; signal?: AbortSignal }): Promise<string>;
  password(o: { message: string; validate?: (v: string) => string | undefined; signal?: AbortSignal }): Promise<string>;
  select<T extends string>(o: { message: string; options: { value: T; label: string; hint?: string }[]; initial?: T; signal?: AbortSignal }): Promise<T>;
  multiselect<T extends string>(o: { message: string; options: { value: T; label: string; hint?: string }[]; initial?: T[]; required?: boolean }): Promise<T[]>;
  confirm(o: { message: string; initial?: boolean }): Promise<boolean>;
  spinner(): { start(m: string): void; stop(m: string): void };
}
class SetupCancelled extends Error {}
```

- `ClackUi` implements it with `@clack/prompts`, and turns a clack cancel into `SetupCancelled`.
- `authInteraction(ui): AuthInteraction` adapts it to pi-ai's login protocol:

  | pi-ai | SetupUi |
  |---|---|
  | `text` prompt | `text` |
  | `secret` prompt | `password` |
  | `select` prompt | `select` |
  | `manual_code` prompt | `text`, with the prompt's `signal`, so the prompt is withdrawn when the browser callback wins |
  | `info` event | `note`, with its links |
  | `auth_url` event | `note`, "Open this URL" |
  | `device_code` event | `note`, with the code and the verification URI |
  | `progress` event | spinner text |

- Steps depend only on `SetupUi`. Tests use `ScriptedUi`, which pops queued answers and records everything shown.

### 3.3 Context

```ts
interface SetupContext {
  configPath: string; factoryHome: string;
  ui: SetupUi;
  settings: ConfigStore;              // the existing validated settings API (effective/raw, set/unset with validate-on-save)
  host: () => Promise<ModelHost>;     // lazy; rebuilt after packages/models.json change
  secrets: SecretStore;
  run: (cmd: string, args: string[], opts?: { input?: string }) => Promise<{ code: number; stdout: string; stderr: string }>;
  platform: NodeJS.Platform; env: NodeJS.ProcessEnv; homedir: string;
  daemon: { pid(): number | undefined; restart(): Promise<void> };
}
```

- Settings are written through the same validated save the web UI uses. If validation fails, the error is shown and
  the prompt is asked again.
- Setup works whether or not the factory is running.

### 3.4 Sections

Each step module exports `status(ctx): Promise<{ state: "ok" | "warn" | "missing"; detail: string }>` and
`run(ctx): Promise<void>`.

A check that fails (an HTTP error, a failed login, a failed test call) always offers **Retry / Save anyway / Skip**.
**Retry** is the default.

**prereqs**
- Checks:
  - Node ≥ 22;
  - `git`;
  - `gh`;
  - the sandbox runtime: `SandboxManager.checkDependencies()`, i.e. bubblewrap and socat on Linux, `sandbox-exec` on
    macOS.
- For each missing tool it prints the install command for the detected package manager (`apt`, `dnf`, `pacman`, `brew`)
  and offers **Check again** or **Continue**. **It never runs the install itself and never uses sudo.**
- If the sandbox runtime is still missing, it asks `Disable the sandbox (sandbox.enabled: false)? Agents' commands
  would run unconfined`, default No.

**github**
1. Pick `github.identity.kind`: `pat` (your account), `bot` (a bot account) or `app` (a GitHub App).
2. Get the credential.
   - **For `pat` or `bot`**, choose where the token comes from:
     - paste it (`password`) and save it as `store:github`;
     - import it from `gh auth token`, offered when gh is logged in, and save it as `store:github`;
     - keep `env:GH_TOKEN`, offered when it is set.

     Then verify with `GET /user` and show the login. For a classic token, read `X-OAuth-Scopes` and warn if `repo`
     is missing, or `workflow`. For a fine-grained token (`github_pat_` prefix), show the required permissions from
     `docs/configuration.md`.
   - **For `app`**, collect:
     - `appId` and `installationId` (numbers);
     - the path to the private key PEM. Its contents are saved as `store:github-app-key`, and
       `privateKeyRef: store:github-app-key` is set.

     Then verify by minting an installation token through `GhApiHost.token()`.
3. Pick `github.visibility` (`private` or `public`), with the current value as the default.
4. Save `github.identity` and `github.visibility` globally.

**models**

A loop over these actions until **Done**:
- **Log in to a provider.**
  1. The list holds every provider in the `ModelRuntime`. Providers used by the current role models come first, and
     each shows its status from `getProviderAuthStatus`/`checkAuth`.
  2. For a provider that supports both methods, choose API key or subscription (OAuth).
  3. Run `models.login(id, type, authInteraction(ui))`, then confirm with `checkAuth`.
- **Log out.** Lists the providers that have stored credentials and calls `models.logout(id)`.
- **Install a provider package.**
  1. Enter the source (`npm:…`, `git:…` or a local path).
  2. Show a note: `Packages are code that runs inside the factory process, outside the sandbox, with access to its
     credentials. Review the source before installing.` Then ask to confirm, default No.
  3. `packages.install(source)` with a progress spinner, then `addSourceToSettings`.
  4. Rebuild the host and diff the provider ids.
     - If the package registered providers, list them and offer to log in to each one now.
     - If it registered none, or failed to load, show the diagnostics and offer to remove it
       (`removeAndPersist`), default Yes.
- **Remove a provider package.** Pick from the `packages` list, then `removeAndPersist`.
  - If a role setting uses a provider the package supplied, refuse and name the role.
- **Add a compatible endpoint (`models.json`).**
  1. Enter:
     - the provider id: `[a-z0-9-]+`, and not the id of a built-in or package provider;
     - the name;
     - the API: `openai-completions`, `openai-responses` or `anthropic-messages`;
     - the base URL;
     - the auth: an API key, saved to `auth.json` with `type: api_key`, or none.
  2. Pick the models. For `openai-*` APIs, setup first tries `GET {baseUrl}/models` and offers a multiselect of the
     ids it finds; otherwise, or as well, ids are entered by hand.
  3. For each model, enter:
     - `contextWindow` (default 128000);
     - `maxTokens` (default 16384);
     - image input (yes/no; `qa` needs yes);
     - `reasoning` (yes/no).

     Cost is written as zero.
  4. Optional test call: one `completeSimple` with "Reply with OK" to the first model.
  5. Write the provider to `models.json`, keeping the other entries.
- **Remove a compatible endpoint.** Refused while a role setting uses it.

Whenever packages or `models.json` changed and the factory is running, setup asks at the end of the section whether to
restart it (the service if installed, else `factory stop` and `factory serve`).

**roles**

For each role, show a `select` of `getAvailable()` models (those whose provider has credentials). The current value is
the default; if the current model is unavailable, it is shown first, marked `(no credentials)`.
- **`helper`:** the first option is `Same as builder`, which unsets `roles.helper.model` and `roles.helper.thinking`
  (and skips the thinking prompt).
- **`qa`:** only models whose `input` includes `image`.
- **thinking:** a `select` of `off`, `low`, `medium` and `high`, with the current value as the default.
- **Family warning:** if the reviewer's provider is the builder's provider, warn `The reviewer is meant to be a
  different model family from the builder`, then continue.
- Save the `roles.*` values globally.

**qa**

Choose one:
- **Enable AQ testing with a boat.dev key.** Paste the key (`password`), save it as `store:boat`, set
  `boat.apiKey: store:boat` and `qa.enabled: true`, then verify with `Boat.limits("store:boat")`.
- **Keep `env:BOAT_API_KEY`.** Offered when it is set; verified the same way.
- **Turn AQ testing off** (`qa.enabled: false` globally). A note says project overrides may still turn it on.

**search**

Choose one:
- **Paste a Parallel key.** It is saved as `store:parallel` and `webSearch.apiKey: store:parallel` is set. Then ask
  `Run one test search (billed)?`, default Yes; if yes, it runs one query with `maxResults: 1`.
- **Keep `env:PARALLEL_API_KEY`.** Offered when it is set.
- **Skip.** Web search stays unconfigured; the `web_search` tool tells agents it is not configured, and nothing else
  breaks.

**service**

- **Status:** installed or not, and active or not.
- **Actions:** Install (or Reinstall) / Remove / Skip.
- **Linux (systemd user unit)**, written to `~/.config/systemd/user/software-factory.service`:

  ```ini
  [Unit]
  Description=software factory
  After=network-online.target
  [Service]
  ExecStart=<process.execPath> --import <repo>/node_modules/tsx/dist/esm/index.mjs --no-warnings <repo>/src/cli.ts serve --foreground --config <abs config>
  Environment=PATH=<PATH at setup time>
  Restart=on-failure
  [Install]
  WantedBy=default.target
  ```

  `ExecStart` uses the same command `bin/factory` runs, with absolute paths. Then setup runs
  `systemctl --user daemon-reload` and `systemctl --user enable --now software-factory`. If
  `loginctl show-user $USER -p Linger` is `no`, it offers `loginctl enable-linger`, explaining that this keeps the
  factory running when you are logged out.
- **macOS (launchd)**, written to `~/Library/LaunchAgents/dev.software-factory.plist`:
  - `ProgramArguments` is the same command;
  - `EnvironmentVariables.PATH` is the PATH at setup time;
  - `KeepAlive` is `{ SuccessfulExit: false }`;
  - logs go to `<factoryHome>/factory.log`.

  Then `launchctl bootstrap gui/<uid> <plist>`.
- **Before installing:** if a factory started by `factory serve` is running for this config, setup offers to stop it
  first (default Yes). Otherwise the service would fail with `already running`.
- **Credentials:** none are written into the unit or plist; they are all in `secrets.json` and `pi/auth.json`.
- **Coexisting with the existing commands:** `factory status`, `factory web` and `factory stop` keep working through the
  pid file that `serve --foreground` writes. `factory stop` sends SIGTERM, and the process exits 0, so `Restart=on-failure` and
  `KeepAlive.SuccessfulExit=false` do not restart it.
- **Remove:** `systemctl --user disable --now`, or `launchctl bootout`, then delete the file.

## 4. Changes to existing commands

- **`doctor`**
  - Builds a `ModelHost` and a `SecretStore`.
  - Prints each extension diagnostic as `warn`.
  - Each credential line says where the credential comes from: `env:…`, `store:…`, `auth.json (api key)` or
    `auth.json (OAuth)`.
  - Every `FAIL` or `warn` about a credential or prerequisite ends with `→ factory setup <section>`.
- **`serve`**: if no role's provider has credentials, it logs
  `no model credentials configured; run factory setup` and still starts.
- **`--help`** lists `factory setup [section] [--config p]`.

## 5. Error handling

| Situation | Behaviour |
|---|---|
| Not a TTY | Exit 1, `factory setup is interactive; run it in a terminal` |
| Ctrl-C | `SetupCancelled`: `setup cancelled; completed sections were saved`, exit 130 |
| Verification fails (401, missing scope, boat/Parallel error, login error, test call error) | Show the error; Retry (default) / Save anyway / Skip |
| Settings validation rejects a value | Show the message; prompt again; file unchanged |
| Package install fails | Show the last 20 lines of npm/git output; nothing is added to `settings.json` |
| Package loads but registers no provider | Show diagnostics; offer removal (default Yes) |
| `secrets.json` is group- or world-readable | Refuse with the `chmod 600` hint (setup, serve, doctor alike) |
| `secrets.json` is unparseable | Error naming the file; setup does not overwrite it |
| `systemctl`/`launchctl` fails | Show the output; leave the unit file in place; print the manual command |

## 6. Testing

All tests use vitest, follow the existing fake-host patterns, and never touch the real `~`, network, `systemctl` or
`launchctl`.

- **`test/secrets.test.ts`**
  - Files are written 0600 and the directory 0700.
  - Writes are atomic: no temp file is left behind.
  - `get` sees an external write.
  - A loosely permissioned file is refused.
  - `resolveSecret("store:x", store)` resolves, and gives undefined without a store or without the key.
- **`test/model-host.test.ts`** (temporary factory home)
  - With an empty `agentDir`, the built-in providers are present.
  - A `models.json` provider resolves via `getModel`.
  - A local package whose extension calls `registerProvider` (fixture under `test/fixtures/provider-package/`)
    resolves via `getModel` once it is installed through `packages.install` with a local path.
  - A throwing extension yields a diagnostic, not an exception.
  - An extension placed in `.pi/extensions` of the process cwd is **not** loaded.
  - An `api_key` credential written to `auth.json` makes `getAvailable` include the provider without a restart.
- **`test/setup-steps.test.ts`** (`ScriptedUi` with a temporary config and factory home)
  - **github:** the paste path saves `store:github` and sets the ref, verified against the existing fake `gh` binary;
    a 401 offers retry; the app path stores the PEM.
  - **models:** api_key login through `authInteraction`, using a fixture provider with a `login`; installing a
    provider package; refusing to remove a provider a role uses; an endpoint added to `models.json` with discovery
    against a local HTTP stub.
  - **roles:** only available models are offered; `qa` lists only image models; "Same as builder" unsets the helper.
  - **qa:** the key is saved and verified against `LocalBoatBackend`; the off path sets `qa.enabled: false`.
  - **search:** the key is saved; the test search hits a local stub endpoint.
  - **service:** under a temporary `HOME` and a stub `run`, the unit/plist content matches; the right commands run;
    linger is offered; remove deletes the file.
  - **prereqs:** a missing `socat` prints the apt command; disabling the sandbox writes `sandbox.enabled: false`.
- **`test/setup-wizard.test.ts`**
  - A section name runs only that section.
  - Sections with an `ok` status default to skipping.
  - `SetupCancelled` in the third section keeps the first two sections' writes and exits 130.
  - Running without a TTY exits 1.
- **Existing tests:** the dry run and the `doctor` tests pass with `createModelHost(…, { scripted: true })`.

## 7. Docs

- **README:** the Quickstart becomes `npm install`, `bin/factory setup`, then `bin/factory serve` (or the installed
  service). The Requirements list says credentials can be set with `factory setup`, and that env vars still work.
- **`docs/configuration.md`:**
  - `store:` is now implemented, backed by `secrets.json`;
  - the `<factoryHome>/pi` directory (packages, `models.json`, `auth.json`);
  - how provider packages and compatible endpoints work, and that only providers from extensions are used;
  - the trust warning for packages;
  - the service files.
- **`docs/architecture.md`:** the model host and the secret store.
- **`DEVIATIONS.md`:** an entry saying the factory now depends on pi-coding-agent as a model host, and why.
