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
  - `bundle.mergeMethod` must be `merge`, `squash` or `rebase`;
  - no gate may appear twice.

This check runs against the *effective* config of every affected scope: a global change is checked for every project.
If any check fails, the change is rejected and the file is left unchanged.

**Pinning.** Each run pins its effective config when it starts, and each bundle the project's effective config when
it is created, so a settings change applies only to new runs and bundles.

## Settings

| Path | Default | Meaning |
|---|---|---|
| `roles.architect` | `anthropic/claude-opus-5-5`, `high` | Discussion and spec |
| `roles.builder` | `anthropic/claude-opus-5-5`, `high` | The single writer |
| `roles.helper` | unset = the builder's model and thinking | Helpers the builder spawns; they write code in the builder's worktree |
| `roles.integrator` | unset = the builder's model and thinking | A bundle's integrator: combines its tickets' branches, resolves conflicts, fixes the bundle's findings |
| `roles.reviewer` | `openai/gpt-6-sol`, `high` | Product vs spec, runs the tests, reviews the diff and code for quality and security |
| `roles.qa` | `anthropic/claude-sonnet-5-5`, `medium` | AQ testing in a boat.dev VM; the model must accept images |
| `discussion.model` | unset = the architect's model and thinking | The model a new discussion starts with (see below) |
| `qa.enabled` | `true` | Run AQ testing beside each review. Set `false` per project to turn it off |
| `boat.apiKey` | `env:BOAT_API_KEY` | Reference to the boat.dev API key (`env:`, `file:` or `store:`, never the key). Needed when `qa.enabled` |
| `boat.size` | `default` | VM size: `small`, `default` or `large` |
| `boat.ttl` | `1h` (10m–24h) | Idle time after which boat stops the VM (it is resumed on the next command) |
| `boat.runScripts` | `[scripts/run.sh, bin/run]` | Repo-relative; the first that exists starts the product in the VM. None means QA is skipped |
| `policy.approvals` | `[spec]` | Approval gates, any of `spec`, `delivery`, `merge`. `merge` is legacy: it still validates but no new run stops at it (see [Bundles](#bundles)) |
| `policy.reviewRoundCap` | `3` (1–20) | Review rounds before escalation, for a run and, separately, for a bundle's reviews |
| `policy.escalateOnNoProgress` | `true` | Escalate when a fix round leaves the diff unchanged |
| `policy.messages` | `[architect, builder, reviewer]` | Roles a human can message while a run is going (the web UI's chat box). Drop `reviewer` for a review no human can sway (it also covers a bundle's reviewer; a bundle's integrator always takes messages). `discussant` can't be listed: you talk to it in its discussion |
| `workdir` | `~/factory/work` | Clones, per-run worktrees, bundles' worktrees (`bundles/<id>`), discussions' read-only checkouts (`discussions/<id>`) and the roles' scratch dirs; finished work is deleted from it (see [What lives in `workdir`](#what-lives-in-workdir)) |
| `github.identity` | `{ kind: pat, tokenRef: env:GH_TOKEN }` | How the factory authenticates to GitHub (see below) |
| `github.visibility` | `private` | Visibility of the repos the factory creates |
| `bundle.mergeMethod` | `squash` | How **Merge** merges a bundle's PR: `merge`, `squash` or `rebase`. Global or per project |
| `ci.mode` | `if-present` | `off` / `if-present` / `required` (see below); applies to bundles |
| `ci.fixRounds` | `2` (0–3) | CI fix rounds of a bundle before escalation |
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

#### What lives in `workdir`

Each run, bundle and discussion keeps using the `workdir` pinned when it started, and is cleaned there
(`docs/specs/run-mv58bn4q-q2zs.md`, `docs/spec.md` §8.1):

| Path | What | Deleted |
|---|---|---|
| `runs/<id>`, `runs/<id>.json` | a run's worktree on `factory/<id>` and its manifest | when the run is `DELIVERED`, or `FAILED`/`CANCELLED` and cleared (with its local and remote branch) |
| `bundles/<id>`, `bundles/<id>.json` | a bundle's worktree and manifest | when the bundle is `MERGED` or `CANCELLED` (with its local and remote branch) |
| `discussions/<id>`, `discussions/<id>.json` | a discussion's read-only checkout and manifest | when the discussion is `CLOSED` or `FAILED` (with its local branch); reopen or retry re-creates it |
| `repos/<owner>__<repo>` | the project's shared clone, holding the local `factory/*` branches | never; its finished owners' branches are deleted |
| `scratch/<id>-<role>` | a role's HOME, TMPDIR, caches and `setup.log` | with the owner's full cleanup; for an uncleared `FAILED`/`CANCELLED` run or a `FAILED` bundle, as soon as it ends (only the scratch goes) |

Environment records live outside `workdir`, in `<factory home>/environments/<id>-<role>.json`. They are kept while a
`FAILED`/`CANCELLED` owner can still be retried and deleted with the rest by a full cleanup. A `READY` run keeps
everything. At every start (and on `factory gc`) a sweep finishes failed cleanups and removes factory-named
entries (`run-*`, `bundle-*`, `disc-*`, `<id>-<role>`) that no record owns; other names are never touched. QA
screenshots, conversations and the storage are never deleted.

**Never share a `workdir` between two factories** (two configs or storages, e.g. both on the default
`~/factory/work`): each factory's sweep treats the other's runs, bundles and discussions as orphans and deletes their
worktrees, scratch dirs and local branches (bundle and discussion ids are small counters, so they also collide). Give
each factory its own `workdir`.

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
| integrator | `coding`, `test-runner`, `web-search` (no `subagent`; bridge tool: `report_done`) |
| reviewer | `coding-readonly`, `test-runner`, `web-search` |
| qa | `coding-readonly` (bash runs in the VM), `computer`, `web-search` |
| discussant | `coding-readonly`, `web-search` (bridge tool: `submit_tickets`) |

Model credentials are not settings. They are in `pi/auth.json` (`factory setup models`), or in the environment, where
pi-ai reads them, e.g. `ANTHROPIC_API_KEY` and `OPENAI_API_KEY`; a factory run as a service doesn't have those (see
[Running as a service](#running-as-a-service)).

### Discussions

`discussion.model` has the same two fields as a role, `model` and `thinking`, with the same checks: the model must be
known and the thinking level valid. Each field left unset at every layer takes the architect's effective value, so by
default a discussion uses the architect's model. A project can override it like any setting.

The value is only a default. The web UI's **New discussion** dialog prefills it from the chosen project, you can
change it there, and the discussion pins what it started with: changing the setting later doesn't affect discussions
that already exist. A discussion also pins the project's effective settings at start, as a run does; its checkout
lives under `workdir` and gets the architect's sandbox rules (read-only worktree, writable scratch dir, the same
network policy). `sandbox.setupScripts` don't run for discussions.

```yaml
discussion:
  model: { model: anthropic/claude-opus-5-5, thinking: high }
```

### Bundles

A run stops at **Ready** once its review passes (and the `delivery` gate, if on, is approved): its branch
`factory/<run-id>` is pushed for an existing repo, and nothing more. Shipping one or more Ready tickets of a project
makes a bundle, which delivers them as one PR (or, for a new repo, creates the repo and pushes to `main`), waits for
CI and merges when you click **Merge**. A bundle pins the project's settings when it is created:

- `bundle.mergeMethod` is how Merge merges the PR (`squash` by default). Merging the PR on GitHub yourself works too;
  the factory notices.
- `roles.integrator` is the integrator's model and thinking; each field left unset takes the builder's effective
  value, as `roles.helper` does.
- `policy.reviewRoundCap` caps the bundle's own review rounds (a bundle is reviewed only when the integrator changed
  something), and `ci.*` applies to the bundle's PR as it used to apply to a run's.
- `qa.*` and `boat.*` apply to the bundle's reviews; its QA VMs are named `factory-bundle-<n>-<seq>`.

`policy.approvals: [merge]` is **legacy**. It still validates, so old configs keep loading, but no new run stops at
the merge gate: merging is always the bundle's Merge. The `delivery` gate keeps working and sits before Ready. Runs
that had already begun delivering when the factory was upgraded finish the old way, with their own PR, CI and merge
gate.

```yaml
bundle: { mergeMethod: merge }   # keep each ticket's commits on the default branch
roles:
  integrator: { model: anthropic/claude-sonnet-5-5 }   # thinking still follows the builder
```

### Web UI

`web.host` and `web.port` apply when the factory starts; change them, then `factory stop` and `factory serve`.
`factory serve --port` overrides the port for one start. If the port is taken, `serve` exits 1 with the port in the
message; the factory never runs without its web UI.

`factory serve` prints the web UI's link, and `factory web` prints it again. The link carries an access token kept in
`web-token` next to the config file (mode 0600); the first visit swaps it for a session cookie. Delete the file and
restart to issue a new token.

### CI modes

CI runs on a bundle's delivered commit (its PR, or the push to `main` for a new repo); runs no longer wait for CI
themselves.

| Mode | What happens after a bundle's delivery |
|---|---|
| `off` | Don't wait for CI. |
| `if-present` | Wait for the repo's checks. If none appear within `noChecksTimeout`, finish anyway and note in the PR description or `docs/delivery-notes.md` that there was no CI. |
| `required` | Checks must pass. If none appear, escalate to the human. |

When CI is red, the failure goes back to the bundle's integrator. The finding names each failed check once, and its
evidence is the check's output: for a GitHub Actions job, the failed step's command and the end of its log up to the
error (about 3,000 characters; the sandbox cannot reach GitHub to read the log itself). After `fixRounds` failed
rounds, the bundle escalates. (Legacy runs still wait for CI themselves, and a red CI goes to their builder.)

Delivery itself is not a setting: a new repo is always pushed to `main`, and an existing repo always gets a pull
request.

### Sandbox

All of these live under `sandbox`.

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Wrap every command in `@anthropic-ai/sandbox-runtime`. Turn it off only where no sandbox is available. |
| `allowedDomains` | `[registry.npmjs.org, pypi.org, files.pythonhosted.org, proxy.golang.org]` | Only these domains are reachable. |
| `deniedDomains` | `[]` | Always denied; overrides allows. |
| `denyRead` | `[~/.factory, ~/.ssh, ~/.config/gh]` | Paths hidden from every role. The factory home (the config file's directory) is always hidden as well, also when `--config` points elsewhere. Only the environment's own worktree, git directory, scratch dir and `extraWrite` paths are readable inside it, for a `workdir` placed in the home. `secrets.json`, `pi/` (with `auth.json`), `web-token`, `web-url`, `factory.log`, `factory.sqlite*`, `environments/` and `qa-vms/` are hidden regardless, and so is the `storage.path` database (with its `-wal`/`-shm`/`-journal` files) wherever it lives. |
| `extraWrite` | `[]` | Extra writable paths for the builder. Rejected if it would make home or `/` writable, overlap a denied path, or sit at, inside or around the factory home. A path around the `storage.path` database is ignored. |
| `unixSockets` | `auto` | Linux only: `block`, `allow`, or `auto`, which relaxes the setting if the host forbids nested user namespaces (DEVIATIONS.md §7). |
| `setupScripts` | `[scripts/setup.sh, setup.sh, bin/setup]` | The first one that exists in the worktree runs when the builder's environment is provisioned (sandboxed, with the builder's rights). |

### GitHub identity

`github.identity` sets how the factory authenticates to GitHub, for opening repos, pushing run branches, bundle
delivery, CI, merges and closing a cancelled bundle's PR.
- `kind: pat` or `kind: bot` takes a `tokenRef`.
- `kind: app` takes `appId`, `installationId` and `privateKeyRef`.

`factory setup github` sets the identity and `github.visibility`:
- For `pat` or `bot`, the token is pasted or imported from `gh auth token` and stored as `store:github`, or
  `env:GH_TOKEN` is kept when it is set. Setup checks it with `GET /user` and shows the login. When GitHub reports the
  token's scopes (a classic token, or a `gho_` token imported from gh), a missing `repo` or `workflow` scope is warned
  about and setup asks **Retry** / **Save anyway** / **Skip**. A fine-grained token (`github_pat_`) has permissions,
  not scopes: setup lists the ones below and doesn't check them.
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
- A file that is readable by group or others is an error: `secrets.json has mode 0644; run chmod 600 <path>`.
  `factory setup` and `factory serve` refuse to start; `doctor` prints a `FAIL` line where it resolves a `store:` ref.
  A file that doesn't parse is an error naming it (`cannot parse <path>: …`), in the same places, and setup never
  overwrites it. A missing file is fine.
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
`env:PARALLEL_API_KEY` when that is set. It then offers one test search (billed). Skip leaves the existing
`webSearch.apiKey` and stored key unchanged.

Without a key, `web_search` returns an error that tells the agent to carry on without searching; nothing else
breaks. The tool runs in the factory process, so the key never reaches the sandbox and `api.parallel.ai` needs no
`allowedDomains` entry. Queries leave the machine and are kept in transcripts. Every role has the tool; to turn
searching off, leave the key unset.

### AQ testing

Each review round, if `qa.enabled` and a run script exists, the core creates one boat.dev VM named
`factory-<run>-<round>` (`factory-bundle-<n>-<round>` for a bundle's review) with `noEnv` (no environment variables of yours), uploads the reviewed build as a git bundle,
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
`Reconfigure <title>?`, e.g. `Reconfigure GitHub?`, default No, for those already set up), runs `doctor`'s checks and
prints the web UI's link; without one, `the service is starting; factory web prints the link` when the service is
installed and active, else `next: factory serve`. `factory setup <section>` runs one section unconditionally, then
offers the restart below if it changed packages or `models.json`.

| Section | What it does | Writes |
|---|---|---|
| `prereqs` | Checks Node ≥ 22, `git`, `gh` and the sandbox runtime (ripgrep on both; bubblewrap and socat on Linux, `sandbox-exec` on macOS). Prints the install command for the package manager it finds (`apt`, `dnf`, `pacman`, `brew`); it never runs it and never uses sudo. If the sandbox runtime is still missing, offers to disable the sandbox (default No). | `sandbox.enabled: false`, if you accept |
| `github` | The GitHub identity and repo visibility (see [GitHub identity](#github-identity)) | `github.identity`, `github.visibility`; `store:github` or `store:github-app-key` |
| `models` | Logs in to providers and out of them, installs and removes provider packages, adds and removes compatible endpoints (see [Model providers](#model-providers)) | `pi/auth.json`, `pi/settings.json`, `pi/models.json`, `pi/factory-packages.json` (which providers each package added) |
| `roles` | Picks each role's model from the models that have credentials (`qa`: only models that accept images; `helper`: `Same as builder` unsets it), and its thinking level. Warns when the reviewer uses the builder's provider. | `roles.*` |
| `qa` | The boat.dev key, or AQ testing off (see [AQ testing](#aq-testing)) | `boat.apiKey`, `qa.enabled`; `store:boat` |
| `search` | The Parallel key (see [Web search](#web-search)) | `webSearch.apiKey`; `store:parallel` |
| `service` | Installs, reinstalls or removes a user service that runs the factory (see [Running as a service](#running-as-a-service)) | the unit or plist |

Settings are written globally, through the same validate-on-save as the web UI; a rejected value leaves the file
unchanged. When something fails, each section does this (the first option is the default):

| Section | A check fails | The config rejects a value |
|---|---|---|
| `prereqs` | Missing tools: **Check again** / **Continue** | The error is shown; not asked again |
| `github` | `gh` missing: **Retry** / **Skip**. `GET /user` or the App token fails, or the token lacks `repo` or `workflow`: **Retry** / **Save anyway** / **Skip** (Skip writes nothing). | The secrets it just stored are put back, the error is shown with `fix the problem (e.g. factory setup roles), then run factory setup github`, and setup goes on to the next section; not asked again |
| `models` | A login, or storing an endpoint's key: **Retry** / **Skip**. The endpoint test call: **Retry** / **Save anyway** / **Skip** (Skip removes the endpoint). A failed package install shows the last 20 lines of output and adds nothing. A `models.json` setup can't rewrite: the error, then the menu again. | n/a (writes only `pi/` files) |
| `roles` | n/a | **Retry** (asks again for the roles the error names) / **Skip** |
| `qa` | The boat check: **Retry** / **Save anyway** / **Skip** (Skip writes nothing) | The error is shown; not asked again |
| `search` | The test search: **Retry** / **Save anyway** / **Skip** (Skip writes nothing). Declining the test search saves without one. | The error is shown; not asked again |
| `service` | `systemctl`/`launchctl` fails: its output and the command to run by hand; the file stays. A credential comes from the environment: a warning, then `Install the service anyway?` (default Yes) | n/a |

- Each section saves when it finishes. Ctrl-C, at a prompt or while a spinner runs, prints
  `setup cancelled; completed sections were saved` and exits 130.
- Setup works whether or not the factory is running.
- The `Keep env:GH_TOKEN`, `Keep env:BOAT_API_KEY` and `Keep env:PARALLEL_API_KEY` options carry the hint
  `not seen by a service`: a service gets only `PATH` (see [Running as a service](#running-as-a-service)).

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
the credential goes to `auth.json`, and setup names its source as `doctor` does (e.g.
`anthropic: logged in (auth.json (OAuth))`). **Log out** lists the stored credentials and deletes one; when a role
setting uses that provider, it first asks `<id> is used by <role settings>; log out anyway?` (default No).
Credentials take effect live: a login made while the factory runs applies to its next model request. A provider's env
var (e.g. `ANTHROPIC_API_KEY`) still works without a login, for a factory started from a shell that has it.

**Provider packages.** **Install a provider package** asks for the source, then shows:

> Packages are code that runs inside the factory process, outside the sandbox, with access to its credentials. Review
> the source before installing.

and asks to confirm (default No). A relative local path is taken from the directory setup runs in. Setup prints a plain
`Installing <source>…` line (no spinner): npm's and git's output goes straight to the terminal. pi then adds the
package to `settings.json`, and what follows depends on what that did:

| The source | What setup does |
|---|---|
| new | Lists the providers it registered and offers to log in to each. If it registered none, or failed to load, shows its errors and offers to remove it (default Yes); a kept package loads at the next start. |
| the same package at another version or ref (npm: same name; git: same host and path) | pi replaces the entry. Setup says `replaced <old> with <new>`, warns `<new> no longer supplies <ids>` for providers the old one registered and the new one doesn't, and offers logins for providers the new one adds. It never offers removal. |
| identical to an installed one | `<source> was already installed` |

If the install itself fails, setup shows the last 20 lines of npm or git output and nothing is added to
`settings.json`. For each package it installs, setup records the providers it added in `pi/factory-packages.json`.
**Remove a provider package** is refused while a role setting uses a provider a recorded package supplied; the
message names the roles. For a package installed another way, setup asks
`setup can't tell which providers <source> supplies; remove it anyway?` (default No).

Only the **providers and virtual models** that extensions register are used. The tools, commands, flags and event
hooks they register attach to pi-coding-agent sessions, which the factory never creates; each role's tool set stays
fixed (see [Settings](#settings)). An extension that fails to load never stops the factory: `serve` logs
`extension: <message>`, `doctor` prints it as a `warn` line, and a role whose model's provider failed to load fails
validation as any unknown model does.

**Compatible endpoints.** **Add a compatible endpoint** asks for:
- the provider id (`[a-z0-9-]+`, not a built-in or package provider's id nor one already in `models.json`), and a
  name;
- the API: `openai-completions`, `openai-responses` or `anthropic-messages`;
- the base URL;
- the auth: an API key, stored in `auth.json` (`type: api_key`) and never in `models.json`, or none (written as the
  placeholder `apiKey: "none"`, which pi needs to count the provider as configured);
- the models. For the `openai-*` APIs setup first tries `GET <baseUrl>/models` and offers the ids it finds; ids can
  also be entered by hand. Each model gets `contextWindow` (default 128000), `maxTokens` (default 16384), image input
  (`qa` needs it) and `reasoning`; cost is written as zero.

Setup deletes any credential left in `auth.json` under that id (an earlier endpoint's key would win over the new
auth), writes the provider to `models.json`, keeping the other entries, stores the key, then offers one test call
("Reply with OK") to the first model. If the endpoint doesn't load, or you skip after a failed key save or test call,
setup removes it again, with any key stored for it.

**Remove a compatible endpoint** is refused while a role setting uses it. Otherwise setup deletes the entry and the
id's key from `auth.json`, unless a provider with that id still exists afterwards: a built-in or package provider the
entry overrode (e.g. `openrouter: { baseUrl }`) keeps its login.

Setup rewrites `models.json` as plain JSON. pi also accepts comments and trailing commas; setup can't edit such a
file (or one that doesn't parse), says `models.json can't be parsed: …; edit <path> by hand` and returns to the
menu.

**Restarts.** Credentials apply live, but new or removed packages and `models.json` changes are loaded only when the
factory starts. When a section changed them and the factory is running, setup offers to restart it: the service if it
runs as one, else `factory stop` and `factory serve --config <config>`. That restart drops any other options the
factory was started with, such as `--port`.

`factory doctor` names each role's credential source: `env:…`, `auth.json (api key)` or `auth.json (OAuth)`.

## Running as a service

`factory setup service` installs a user service that runs `factory serve --foreground` with absolute paths: the
Node binary setup runs with, `node_modules/tsx` and `src/cli.ts` in this checkout, and the config file. No
credentials are written into the service file; they stay in `secrets.json` and `pi/auth.json`. The service gets the
`PATH` of the shell setup ran in and no other environment variable, so run `factory setup service` again after moving
the checkout or changing `PATH`.

**Credentials from the environment don't reach the service.** Before installing, setup lists each credential the
factory would read from an env var: an `env:` ref in the global `github.identity.tokenRef` (or `privateKeyRef`),
`boat.apiKey` (unless `qa.enabled: false` globally) or `webSearch.apiKey` whose variable is set, and a global role
model's provider whose key pi reads from an env var. Each line names the setup section that stores it instead
(`factory setup github`, `qa`, `search` or `models`). Setup then asks `Install the service anyway?` (default Yes); No
installs nothing. Project-level `env:` overrides are not checked. If the check itself fails, setup warns and installs.

| | Linux (systemd) | macOS (launchd) |
|---|---|---|
| File | `~/.config/systemd/user/software-factory.service` | `~/Library/LaunchAgents/dev.software-factory.plist` |
| Install | `systemctl --user daemon-reload`, then `systemctl --user enable --now software-factory` (and `systemctl --user restart software-factory` when reinstalling an active one) | `launchctl bootstrap gui/<uid> <plist>` (after `launchctl bootout gui/<uid>/dev.software-factory` when reinstalling a loaded one) |
| Restart on failure | `Restart=on-failure` | `KeepAlive: { SuccessfulExit: false }` |
| Log | the journal (`journalctl --user -u software-factory`) | `<factory home>/factory.log` |
| Remove | `systemctl --user disable --now software-factory`, then the file is deleted and `systemctl --user daemon-reload` runs | `launchctl bootout gui/<uid>/dev.software-factory` (if loaded), then the file is deleted |

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
  otherwise the service would fail with `already running`. If it keeps running, setup warns and prints the command
  that restarts the service once you have stopped it.
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
bundle: { mergeMethod: squash }
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
    bundle: { mergeMethod: rebase }
    ci: { mode: required }
  cli-tool:
    repo: me/cli-tool
    qa: { enabled: false }     # nothing visual to test
```
