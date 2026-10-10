# Configuration

All configuration lives in a single YAML file: `~/.factory/config.yaml` by default, or `--config` / `$FACTORY_CONFIG`.
`factory serve` creates the file with just `version: 1` if it doesn't exist. Settings read and write this file
directly; there is no second settings store. The directory that holds it is the **factory home** (`~/.factory` by
default). The factory's other files live there too:
- `factory.pid`, `factory.log`, `web-token` and `web-url` (see the README);
- `secrets.json`, the secret store (see [Secret references](#secret-references));
- `pi/`, the model host's directory (see [Model providers](#model-providers)).

`factory setup` writes the credentials and most of the settings below for you; see [Setup](#setup).

## Layers

A setting's value comes from three layers, each overriding the one before:

1. **Schema default**, from the core schema (`coreSchema()` in `src/core/settings.ts`).
2. **Global value**, from the top level of the file.
3. **Project value**, from `projects.<name>`, the project's overrides.

How layers combine:
- Objects merge key by key. Lists and scalars replace the value as a whole.
- `storage`, `version` and `web` are global only.
- A project's `repo` binding (`owner/name`) is set when the project is created: **Create** in the web UI, with a new
  project.

To inspect and change settings, open the web UI's **Settings** view (`factory web` prints the link):
- Pick Global or a project on the left.
- Each field shows its value and its source: `default`, `global` or `project`.
- **Reset** removes a global value, so the default applies again. **Inherit** removes a project override, so the
  project inherits again.

**Validate on save.** Every change is validated before it is written:
- against the schema (types, enums, min/max, and no unknown keys);
- by the core's rules:
  - models must be known to the model host (see [Model providers](#model-providers));
  - a GitHub `app` identity needs `appId`, `installationId` and `privateKeyRef`;
  - `sandbox.extraWrite` must not make home or `/` writable, or overlap a denied path;
  - `ci.noChecksTimeout` must be a duration and `ci.fixRounds` a whole number;
  - no gate may appear twice.

This check runs against the *effective* config of every affected scope: a global change is checked for every project.
If any check fails, the change is rejected and the file is left unchanged.

**Pinning.** Each run pins its effective config when it starts, so a settings change applies only to new runs.

## Settings

| Path | Default | Meaning |
|---|---|---|
| `roles.architect` | `anthropic/claude-opus-5-5`, `high` | Discussion and spec |
| `roles.builder` | `anthropic/claude-opus-5-5`, `high` | The single writer |
| `roles.helper` | unset = the builder's model and thinking | Helpers the builder spawns; they write code in the builder's worktree |
| `roles.reviewer` | `openai/gpt-6-sol`, `high` | Product vs spec, runs the tests, reviews the diff and code for quality and security |
| `roles.qa` | `anthropic/claude-sonnet-5-5`, `medium` | AQ testing in a boat.dev VM; the model must accept images |
| `qa.enabled` | `true` | Run AQ testing beside each review. Set `false` per project to turn it off |
| `boat.apiKey` | `env:BOAT_API_KEY` | Reference to the boat.dev API key (`env:`, `file:` or `store:`, never the key). Needed when `qa.enabled` |
| `boat.size` | `default` | VM size: `small`, `default` or `large` |
| `boat.ttl` | `1h` (10m–24h) | Idle time after which boat stops the VM (it is resumed on the next command) |
| `boat.runScripts` | `[scripts/run.sh, bin/run]` | Repo-relative; the first that exists starts the product in the VM. None means QA is skipped |
| `policy.approvals` | `[spec]` | Approval gates, any of `spec`, `delivery`, `merge` |
| `policy.reviewRoundCap` | `3` (1–20) | Review rounds before escalation |
| `policy.escalateOnNoProgress` | `true` | Escalate when a fix round leaves the diff unchanged |
| `policy.messages` | `[architect, builder, reviewer]` | Roles a human can message while a run is going (the web UI's chat box). Drop `reviewer` for a review no human can sway |
| `workdir` | `~/factory/work` | Clones, per-run worktrees and the roles' scratch dirs |
| `github.identity` | `{ kind: pat, tokenRef: env:GH_TOKEN }` | How the factory authenticates to GitHub (see below) |
| `github.visibility` | `private` | Visibility of the repos the factory creates |
| `ci.mode` | `if-present` | `off` / `if-present` / `required` (see below) |
| `ci.fixRounds` | `2` (0–3) | CI fix rounds before escalation |
| `ci.checks` | `[]` | Names of the checks that count; empty means all |
| `ci.noChecksTimeout` | `2m` | No checks by then means the repo has no CI |
| `sandbox.*` | see below | The sandbox every role's commands run in |
| `web.host` | `127.0.0.1` | Address of the web UI; global only. Keep it on localhost; reach it from elsewhere through an SSH tunnel |
| `web.port` | `7317` (0–65535) | Port of the web UI; global only. `0` picks a free one. If the port is taken, `serve` fails |
| `webSearch.mode` | `fast` | Parallel search mode: `turbo`, `fast` (about 1 s), `basic` or `advanced` (about 3 s, highest quality) |
| `webSearch.maxResults` | `10` (1–40) | Results per search |
| `webSearch.maxCharsTotal` | unset (1000–200000) | Optional cap on the excerpt characters of one search |
| `webSearch.apiKey` | `env:PARALLEL_API_KEY` | Reference to the Parallel API key (`env:`, `file:` or `store:`, never the key) |
| `webSearch.endpoint` | `https://api.parallel.ai/v1/search` | Search endpoint |
| `storage.kind` / `storage.path` | `sqlite` / `~/.factory/factory.sqlite` | Harness storage (`sqlite` or `jsonl`); global only |

Each role has two fields:
- `model`: `provider/modelId`, as known to the model host: a pi-ai built-in provider, a compatible endpoint in
  `models.json` or a provider package (see [Model providers](#model-providers)). `factory setup roles` offers the
  models that have credentials.
- `thinking`: one of `off`, `low`, `medium`, `high`.

The defaults put the reviewer on a different model family from the builder on purpose.

Each role's tools are fixed, not settings. The role's prompt (`role-<role>`) always comes first:

| Role | Tools |
|---|---|
| architect | `coding-readonly`, `web-search` |
| builder | `coding`, `subagent`, `test-runner`, `web-search` |
| helper | `coding`, `test-runner`, `web-search` (no `subagent`, no bridge tools) |
| reviewer | `coding-readonly`, `test-runner`, `web-search` |
| qa | `coding-readonly` (bash runs in the VM), `computer`, `web-search` |

Model credentials are not settings. They are in `pi/auth.json` (`factory setup models`), or in the environment, where
pi-ai reads them, e.g. `ANTHROPIC_API_KEY` and `OPENAI_API_KEY`.

### Web UI

`web.host` and `web.port` apply when the factory starts; change them, then `factory stop` and `factory serve`.
`factory serve --port` overrides the port for one start. If the port is taken, `serve` exits 1 with the port in the
message; the factory never runs without its web UI.

`factory serve` prints the web UI's link, and `factory web` prints it again. The link carries an access token kept in
`web-token` next to the config file (mode 0600); the first visit swaps it for a session cookie. Delete the file and
restart to issue a new token.

### CI modes

| Mode | What happens after delivery |
|---|---|
| `off` | Don't wait for CI. |
| `if-present` | Wait for the repo's checks. If none appear within `noChecksTimeout`, finish anyway and note in the PR description or `docs/delivery-notes.md` that there was no CI. |
| `required` | Checks must pass. If none appear, escalate to the human. |

When CI is red, the failure goes back to the builder. After `fixRounds` failed rounds, the run escalates.

Delivery itself is not a setting: a new repo is always pushed to `main`, and an existing repo always gets a pull
request.

### Sandbox

All of these live under `sandbox`.

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Wrap every command in `@anthropic-ai/sandbox-runtime`. Turn it off only where no sandbox is available. |
| `allowedDomains` | `[registry.npmjs.org, pypi.org, files.pythonhosted.org, proxy.golang.org]` | Only these domains are reachable. |
| `deniedDomains` | `[]` | Always denied; overrides allows. |
| `denyRead` | `[~/.factory, ~/.ssh, ~/.config/gh]` | Paths hidden from every role. The factory home is always hidden as well, so `secrets.json` and `pi/` (with `auth.json`) stay hidden when `--config` points elsewhere. |
| `extraWrite` | `[]` | Extra writable paths for the builder. Rejected if it would make home or `/` writable, or overlap a denied path. |
| `unixSockets` | `auto` | Linux only: `block`, `allow`, or `auto`, which relaxes the setting if the host forbids nested user namespaces (DEVIATIONS.md §7). |
| `setupScripts` | `[scripts/setup.sh, setup.sh, bin/setup]` | The first one that exists in the worktree runs when the builder's environment is provisioned (sandboxed, with the builder's rights). |

### GitHub identity

`github.identity` sets how the factory authenticates to GitHub, for opening repos, delivery, CI and merges.
- `kind: pat` or `kind: bot` takes a `tokenRef`.
- `kind: app` takes `appId`, `installationId` and `privateKeyRef`.

`factory setup github` sets the identity and `github.visibility`:
- For `pat` or `bot`, the token is pasted or imported from `gh auth token` and stored as `store:github`, or
  `env:GH_TOKEN` is kept when it is set. Setup checks it with `GET /user` and shows the login. For a classic token it
  warns when the `repo` or `workflow` scope is missing; for a fine-grained token it lists the permissions below.
- For `app`, it asks for the App id, the installation id and the private key's PEM file. The PEM's contents are stored
  as `store:github-app-key`, and setup checks them by minting an installation token.

A token needs enough access to create private repos and push. With a fine-grained PAT, grant:
- Administration: read & write
- Contents: read & write
- Pull requests: read & write
- Workflows: read & write
- Checks and Commit statuses: read

With a classic PAT, grant `repo`, plus `workflow` if workflows will be pushed.

### Secret references

Secret settings (`github.identity.tokenRef`, `github.identity.privateKeyRef`, `boat.apiKey`, `webSearch.apiKey`) are
always references, never values:
- `env:NAME` reads an environment variable.
- `file:/path` reads a file.
- `store:key` reads a key from the secret store, `<factory home>/secrets.json`.

Any other value, such as a literal token, is rejected.

The secret store is a JSON file, `{ "version": 1, "secrets": { "<key>": "<value>" } }`. Keys match `[a-z0-9-]+`.
- The file is mode 0600 and its directory 0700. Each write goes to a temp file that is then renamed over it.
- It is read on every use, so a key that `factory setup` stores applies to a running factory without a restart.
- A file that is readable by group or others is refused, by `serve`, `doctor` and `setup` alike:
  `secrets.json has mode 0644; run chmod 600 <path>`. A file that doesn't parse is an error naming it, and setup
  never overwrites it.
- An unknown key resolves to nothing, as an unset env var does.

| Key | Holds | Written by | Ref |
|---|---|---|---|
| `github` | the PAT or bot token | `factory setup github` | `store:github` |
| `github-app-key` | the GitHub App's private key (PEM) | `factory setup github` | `store:github-app-key` |
| `boat` | the boat.dev API key | `factory setup qa` | `store:boat` |
| `parallel` | the Parallel API key | `factory setup search` | `store:parallel` |

Model credentials are not in the secret store; they are in `pi/auth.json` (see [Model providers](#model-providers)).

### Web search

`factory setup search` stores a pasted Parallel key as `store:parallel` and sets `webSearch.apiKey` to it, or keeps
`env:PARALLEL_API_KEY` when that is set. It then offers one test search (billed). Skipping leaves web search
unconfigured.

Without a key, `web_search` returns an error that tells the agent to carry on without searching; nothing else
breaks. The tool runs in the factory process, so the key never reaches the sandbox and `api.parallel.ai` needs no
`allowedDomains` entry. Queries leave the machine and are kept in transcripts. Every role has the tool; to turn
searching off, leave the key unset.

### AQ testing

Each review round, if `qa.enabled` and a run script exists, the core creates one boat.dev VM named
`factory-<run>-<round>` with `noEnv` (no environment variables of yours), uploads the reviewed build as a git bundle,
runs the setup script and starts the run script. The QA agent drives the VM's desktop and Chrome through the Cua
Driver and must cite screenshots for its findings. The VM is deleted when the round ends, when the run is cancelled,
and at startup if it is left over from a crash.

- **What leaves the machine:** the reviewed source (as a bundle) goes to boat.dev, and the screenshots come back.
  GitHub credentials and your environment never go to the VM. Screenshots stay under `<config dir>/artifacts` and
  are never committed; delivery notes only point to the run view.
- **The key** is read in the factory process; it is denied to every sandboxed command like the GitHub token. Use a
  key scoped to sandboxes if boat offers one. With QA on and the key unresolved, a run fails at `PREPARING` and says
  to set the key or set `qa.enabled: false`. `factory doctor` checks it per scope.
- **If boat is down,** the round's QA status is `unavailable`, the run goes on with the review alone, and a notice
  says so.
- **Validation:** `boat.ttl` must be 10m–24h; `boat.runScripts` must be non-empty repo-relative paths; `roles.qa.model`
  must accept image input.
- **`factory setup qa`** either stores a pasted boat.dev key as `store:boat` and sets `boat.apiKey: store:boat` and
  `qa.enabled: true`, or keeps `env:BOAT_API_KEY` when that is set, and checks the key by asking boat for the
  account's limits. It can also turn AQ testing off globally (`qa.enabled: false`); project overrides may still turn
  it on.

## Setup

`factory setup [section] [--config p]` is an interactive terminal wizard; it needs a TTY and has no non-interactive
mode. With no section it shows each section's status, runs the sections in the order below (asking
`Reconfigure <section>?`, default No, for those already set up), runs `doctor`'s checks and prints the web UI's link
or `next: factory serve`. `factory setup <section>` runs one section unconditionally.

| Section | What it does | Writes |
|---|---|---|
| `prereqs` | Checks Node ≥ 22, `git`, `gh` and the sandbox runtime (bubblewrap and socat on Linux, `sandbox-exec` on macOS). Prints the install command for the package manager it finds (`apt`, `dnf`, `pacman`, `brew`); it never runs it and never uses sudo. If the sandbox runtime is still missing, offers to disable the sandbox (default No). | `sandbox.enabled: false`, if you accept |
| `github` | The GitHub identity and repo visibility (see [GitHub identity](#github-identity)) | `github.identity`, `github.visibility`; `store:github` or `store:github-app-key` |
| `models` | Logs in to providers and out of them, installs and removes provider packages, adds and removes compatible endpoints (see [Model providers](#model-providers)) | `pi/auth.json`, `pi/settings.json`, `pi/models.json` |
| `roles` | Picks each role's model from the models that have credentials (`qa`: only models that accept images; `helper`: `Same as builder` unsets it), and its thinking level. Warns when the reviewer uses the builder's provider. | `roles.*` |
| `qa` | The boat.dev key, or AQ testing off (see [AQ testing](#aq-testing)) | `boat.apiKey`, `qa.enabled`; `store:boat` |
| `search` | The Parallel key (see [Web search](#web-search)) | `webSearch.apiKey`; `store:parallel` |
| `service` | Installs, reinstalls or removes a user service that runs the factory (see [Running as a service](#running-as-a-service)) | the unit or plist |

- Settings are written globally, through the same validate-on-save as the web UI. A rejected value is shown and asked
  again; the file is left unchanged.
- When a check fails (an HTTP error, a missing scope, a failed login or test call), setup offers **Retry** (the
  default), **Save anyway** or **Skip**. Skip leaves the config and secrets unchanged.
- Each section saves when it finishes. Ctrl-C prints `setup cancelled; completed sections were saved` and exits 130.
- Setup works whether or not the factory is running.

## Model providers

The factory gets its models from the **model host**, which uses pi-coding-agent's model runtime and package manager
over its own directory, `<factory home>/pi` (`~/.factory/pi` by default). The directory is created empty (mode 0700)
on first use; nothing is read from or imported from `~/.pi/agent`. It holds:

| File | Holds |
|---|---|
| `settings.json` | pi's settings; its `packages` list is the installed provider packages |
| `models.json` | compatible endpoints |
| `auth.json` | model credentials (API keys and OAuth logins), mode 0600, in pi's format and with pi's file locking |
| package directories | the installed npm and git packages (a local-path package is loaded from where it is) |

The directory the factory runs in has no effect: `.pi/extensions` and `.pi/settings.json` in it are never loaded.

A role's model can come from:
- **pi-ai's built-in providers**, such as `anthropic` and `openai`.
- **A compatible endpoint** in `models.json`: an OpenAI- or Anthropic-compatible server.
- **A provider package:** a pi package (`npm:…`, `git:…` or a local path, as with `pi install`) whose extensions
  register providers.

**Credentials.** In `factory setup models`, **Log in** lists every provider, with those the roles use first and each
provider's credential status. A provider that supports both an API key and a subscription login (OAuth) asks which;
the credential goes to `auth.json`. **Log out** removes one. Credentials take effect live: a login made while the
factory runs applies to its next model request. A provider's env var (e.g. `ANTHROPIC_API_KEY`) still works without a
login.

**Provider packages.** **Install a provider package** asks for the source, then shows:

> Packages are code that runs inside the factory process, outside the sandbox, with access to its credentials. Review
> the source before installing.

and asks to confirm (default No). It installs the package, adds it to `settings.json`, and lists the providers it
registered, offering to log in to each. A package that registers no provider, or fails to load, is shown with its
errors and offered for removal (default Yes). If the install itself fails, setup shows the last 20 lines of npm or git
output and nothing is added to `settings.json`. **Remove a provider package** is refused while a role setting uses a
provider the package supplied; the message names the roles.

Only the **providers and virtual models** that extensions register are used. The tools, commands, flags and event
hooks they register attach to pi-coding-agent sessions, which the factory never creates; each role's tool set stays
fixed (see [Settings](#settings)). An extension that fails to load never stops the factory: `serve` logs
`extension: <message>`, `doctor` prints it as a `warn` line, and a role whose model's provider failed to load fails
validation as any unknown model does.

**Compatible endpoints.** **Add a compatible endpoint** asks for:
- the provider id (`[a-z0-9-]+`, not a built-in or package provider's id), and a name;
- the API: `openai-completions`, `openai-responses` or `anthropic-messages`;
- the base URL;
- the auth: an API key, stored in `auth.json` (`type: api_key`), or none;
- the models. For the `openai-*` APIs setup first tries `GET <baseUrl>/models` and offers the ids it finds; ids can
  also be entered by hand. Each model gets `contextWindow` (default 128000), `maxTokens` (default 16384), image input
  (`qa` needs it) and `reasoning`; cost is written as zero.

Setup can then make one test call ("Reply with OK") to the first model. It writes the provider to `models.json` and
keeps the other entries. **Remove a compatible endpoint** is refused while a role setting uses it.

**Restarts.** Credentials apply live, but new or removed packages and `models.json` changes are loaded only when the
factory starts. When a section changed them and the factory is running, setup offers to restart it: the service if it
is installed, else `factory stop` and `factory serve`.

`factory doctor` names each role's credential source: `env:…`, `auth.json (api key)` or `auth.json (OAuth)`.

## Running as a service

`factory setup service` installs a user service that runs `factory serve --foreground` with absolute paths: the
Node binary setup runs with, `node_modules/tsx` and `src/cli.ts` in this checkout, and the config file. No
credentials are written into the service file; they stay in `secrets.json` and `pi/auth.json`. The service gets the
`PATH` of the shell setup ran in, so run `factory setup service` again after moving the checkout or changing `PATH`.

| | Linux (systemd) | macOS (launchd) |
|---|---|---|
| File | `~/.config/systemd/user/software-factory.service` | `~/Library/LaunchAgents/dev.software-factory.plist` |
| Install | `systemctl --user daemon-reload`, then `systemctl --user enable --now software-factory` | `launchctl bootstrap gui/<uid> <plist>` |
| Restart on failure | `Restart=on-failure` | `KeepAlive: { SuccessfulExit: false }` |
| Log | the journal (`journalctl --user -u software-factory`) | `<factory home>/factory.log` |
| Remove | `systemctl --user disable --now software-factory`, then the file is deleted | `launchctl bootout gui/<uid>/dev.software-factory`, then the file is deleted |

The systemd unit:

```ini
[Unit]
Description=software factory
After=network-online.target
[Service]
ExecStart=<node> --import <repo>/node_modules/tsx/dist/esm/index.mjs --no-warnings <repo>/src/cli.ts serve --foreground --config <config>
Environment=PATH=<PATH at setup time>
Restart=on-failure
[Install]
WantedBy=default.target
```

- On Linux, if lingering is off for your user, setup offers `loginctl enable-linger`, which keeps the factory running
  when you are logged out.
- If a factory started with `factory serve` is running for this config, setup offers to stop it first (default Yes);
  otherwise the service would fail with `already running`.
- `factory status`, `factory web` and `factory stop` keep working, through the pid file `serve --foreground` writes.
  `factory stop` makes the process exit 0, so neither `Restart=on-failure` nor `KeepAlive` restarts it; start it
  again with `systemctl --user start software-factory` or `launchctl kickstart gui/<uid>/dev.software-factory`.
- If `systemctl` or `launchctl` fails, setup shows its output and the command to run by hand, and leaves the file in
  place.

## Old config files

The `stages` and `workers` sections are gone, and so are `roles.<role>.extensions`, every `stages.*.use`,
`stages.interface.socket` and `stages.delivery.newRepo`/`existingRepo`. There is no migrator. If the config file still
has a `stages` or `workers` section, at the top level or under `projects.<name>`, `factory serve` exits 1 with:

```
error: config uses removed sections (stages, workers); move stages.repo.{identity,visibility} → github.*, stages.repo.workdir and stages.environment.root → workdir, stages.delivery.ci.* → ci.*, stages.environment.sandbox.* → sandbox.*, stages.environment.setupScripts → sandbox.setupScripts, stages.interface.{host,port} → web.*, workers.web-search.* → webSearch.*; found in projects: todo
```

The list names the sections it found, and the last part appears only when a project has them.

A `roles.<role>.extensions` key, at the top level or under `projects.<name>.roles.<role>`, is refused the same way.
Left in place it would be ignored, and the role would get its full fixed tool set back, including `web_search` if you
had removed `web-search` from its list:

```
error: config uses removed keys (roles.reviewer.extensions, projects.todo.roles.builder.extensions); tool sets are now fixed per role, so delete these keys. Web search can no longer be removed from a role: to turn it off, leave webSearch.apiKey unresolved (web_search calls then fail without sending a query)
```

Delete the key. Tool sets are fixed per role now (see [Settings](#settings)). The only way to keep search queries on this
machine is to leave `webSearch.apiKey` unresolved (for the default `env:PARALLEL_API_KEY`, don't set
`PARALLEL_API_KEY`): the tool stays listed, but every call fails without sending a query. If the config also has
`stages` or `workers`, this text follows the sections message after `. Also: `.

`factory doctor` prints the same message as a `FAIL` line. Any other unknown key fails validation on save as before.

A config without `qa` or `boat` keys takes their defaults, so **AQ testing is on and needs a boat.dev key**
(`factory setup qa`, or `BOAT_API_KEY`) after upgrading. Set `qa: { enabled: false }` (globally or per project) to
keep the old behaviour. Runs already in flight
keep their pinned config and stay QA-off. An unset `roles.helper` now means the builder's model.

**Finish or cancel in-flight runs before upgrading.** Runs started before this change are not migrated: their pinned
config still has the old paths. If such a run resumes, it doesn't see its old values and falls back to the default CI
mode, GitHub identity and workdir. If its sandbox environment hasn't been provisioned yet, the environment gets the
sandbox defaults, so no `sandbox.allowedDomains` and no setup script, and `web_search` uses its own defaults
(`env:PARALLEL_API_KEY`, `fast`, 10 results).

## Example

```yaml
version: 1
roles:
  reviewer: { model: openai/gpt-6-sol, thinking: high }
policy: { approvals: [spec, delivery], reviewRoundCap: 3 }
github:
  identity: { kind: pat, tokenRef: env:GH_TOKEN }
ci: { mode: if-present, fixRounds: 2 }
sandbox: { allowedDomains: [registry.npmjs.org] }
webSearch: { mode: fast, apiKey: env:PARALLEL_API_KEY }
qa: { enabled: true }
boat: { apiKey: env:BOAT_API_KEY, size: default, ttl: 1h }
projects:
  todo:
    repo: me/todo
    policy: { approvals: [spec, delivery, merge] }
    ci: { mode: required }
  cli-tool:
    repo: me/cli-tool
    qa: { enabled: false }     # nothing visual to test
```
