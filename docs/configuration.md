# Configuration

All configuration lives in a single YAML file: `~/.factory/config.yaml` by default, or `--config` / `$FACTORY_CONFIG`.
`factory serve` creates the file with just `version: 1` if it doesn't exist. Settings read and write this file
directly; there is no second store.

## Layers

A setting's value comes from three layers, each overriding the one before:

1. **Schema default**, from the core schema or the owning extension's schema.
2. **Global value**, from the top level of the file.
3. **Project value**, from `projects.<name>`, the project's overrides.

How layers combine:
- Objects merge key by key. Lists and scalars replace the value as a whole.
- `storage` and `version` are global only.
- A project's `repo` binding (`owner/name`) is set with `factory project create`, or `factory run --repo`.

To inspect and change settings:
- `factory settings get [<path>] [--project p]` shows each value and its source: `default`, `global` or `project`.
- `factory settings set <path> <value> [--project p]` takes values in YAML syntax, e.g. `'[spec, delivery]'`.
- `factory settings unset <path> --project p` removes the project override, so the project inherits again.
- `factory settings` with no subcommand opens an interactive menu (Policy · Roles · Stages · Workers), built from `settingsSchema()`.
- The web UI's **Settings** view is the same thing as a form: pick Global or a project, and each field shows its source and a Reset/Inherit button.

**Validate on save.** Every change is validated before it is written:
- against the schema (types, enums and min/max);
- by the owning extension's `validate`;
- by the core's rules:
  - models must be known to pi-ai;
  - worker extensions and stage `use` values must be installed;
  - no gate may appear twice.

This check runs against the *effective* config of every affected scope: a global change is checked for every project.
If any check fails, the change is rejected and the file is left unchanged.

**Pinning.** Each run pins its effective config when it starts, so a settings change applies only to new runs.

## Core settings

| Path | Default | Meaning |
|---|---|---|
| `roles.architect` | `anthropic/claude-opus-5-5`, `high`, `[coding-readonly, web-search]` | Discussion and spec |
| `roles.builder` | `anthropic/claude-opus-5-5`, `high`, `[coding, subagent, test-runner, web-search]` | The single writer |
| `roles.helper` | `anthropic/claude-sonnet-5-5`, `medium`, `[coding-readonly, web-search]` | Helpers the builder spawns; read-only |
| `roles.reviewer` | `openai/gpt-6-sol`, `high`, `[coding-readonly, test-runner, browser, web-search]` | Whole-product review |
| `policy.approvals` | `[spec]` | Approval gates, any of `spec`, `delivery`, `merge` |
| `policy.reviewRoundCap` | `3` (1–20) | Review rounds before escalation |
| `policy.escalateOnNoProgress` | `true` | Escalate when a fix round leaves the diff unchanged |
| `policy.messages` | `[architect, builder, reviewer]` | Roles a human can message while a run is going (`factory message`, the web UI's chat box). Drop `reviewer` for a review no human can sway |
| `storage.kind` / `storage.path` | `sqlite` / `~/.factory/factory.sqlite` | Harness storage (`sqlite` or `jsonl`); global only |

Each role has three fields:
- `model`: `provider/modelId`, as known to pi-ai's `createModels()`.
- `thinking`: one of `off`, `low`, `medium`, `high`.
- `extensions`: the role's worker extensions.

The role's prompt section (`role-<role>`) is always added. The defaults put the reviewer on a different model family
from the builder on purpose.

Model credentials are not settings. pi-ai reads them from the environment, e.g. `ANTHROPIC_API_KEY` and
`OPENAI_API_KEY`.

## Stage settings (extension-owned)

`stages.<kind>.use` selects the extension for that stage. Every other key under `stages.<kind>` belongs to that
extension's schema. The table shows the values for the extensions that ship with v1.

| Path | Default | Owner |
|---|---|---|
| `stages.intake.use` | `none` | core (v1 ships no intake extension) |
| `stages.interface.use` | every installed interface (`[cli, web]`) | core |
| `stages.interface.socket` | `~/.factory/factory.sock` | `cli` |
| `stages.interface.host` | `127.0.0.1` | `web`: address of the web UI. Keep it on localhost; reach it from elsewhere through an SSH tunnel |
| `stages.interface.port` | `7317` (0–65535) | `web`: port of the web UI; `0` picks a free one. If the port is taken, the factory runs without the web UI and says so |
| `stages.repo.use` | `github` | core |
| `stages.repo.identity` | `{ kind: pat, tokenRef: env:GH_TOKEN }` | `github` (see below) |
| `stages.repo.visibility` | `private` | `github`: visibility of the repos it creates |
| `stages.repo.workdir` | `~/factory/work` | `github`: clones and per-run worktrees |
| `stages.delivery.use` | `github-delivery` | core |
| `stages.delivery.newRepo` / `existingRepo` | `push-main` / `pull-request` | `github-delivery` (the only values) |
| `stages.delivery.ci.mode` | `if-present` | `github-delivery`: `off` / `if-present` / `required` |
| `stages.delivery.ci.fixRounds` | `2` (0–3) | `github-delivery`: CI fix rounds before escalation |
| `stages.delivery.ci.checks` | `[]` | `github-delivery`: names of the checks that count; empty means all |
| `stages.delivery.ci.noChecksTimeout` | `2m` | `github-delivery`: no checks by then means the repo has no CI |
| `stages.environment.use` | `local-worktree` | core |
| `stages.environment.root` | `~/factory/work` | `local-worktree`: scratch dirs and environment records |
| `stages.environment.setupScripts` | `[scripts/setup.sh, setup.sh, bin/setup]` | `local-worktree`: the first one that exists runs at provision |
| `stages.environment.sandbox.*` | see below | `local-worktree` |

Interface settings apply when the factory starts; `factory serve` prints the web UI's link, and `factory web` prints
it again. The link carries an access token kept in `~/.factory/web-token` (mode 0600, next to the config file); the
first visit swaps it for a session cookie. Delete the file and restart to issue a new token.

### CI modes

| Mode | What happens after delivery |
|---|---|
| `off` | Don't wait for CI. |
| `if-present` | Wait for the repo's checks. If none appear within `noChecksTimeout`, finish anyway and note in the PR description or `docs/delivery-notes.md` that there was no CI. |
| `required` | Checks must pass. If none appear, escalate to the human. |

When CI is red, the failure goes back to the builder. After `fixRounds` failed rounds, the run escalates.

### Sandbox

All of these live under `stages.environment.sandbox`.

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Wrap every command in `@anthropic-ai/sandbox-runtime`. Turn it off only where no sandbox is available. |
| `allowedDomains` | `[registry.npmjs.org, pypi.org, files.pythonhosted.org, proxy.golang.org]` | Only these domains are reachable. |
| `deniedDomains` | `[]` | Always denied; overrides allows. |
| `denyRead` | `[~/.factory, ~/.ssh, ~/.config/gh]` | Paths hidden from every role. |
| `extraWrite` | `[]` | Extra writable paths for the builder. Rejected if it would make home or `/` writable, or overlap a denied path. |
| `unixSockets` | `auto` | Linux only: `block`, `allow`, or `auto`, which relaxes the setting if the host forbids nested user namespaces (DEVIATIONS.md §9). |

### GitHub identity

`stages.repo.identity` sets how the factory authenticates to GitHub. The delivery extension uses the same identity.
- `kind: pat` or `kind: bot` takes a `tokenRef`.
- `kind: app` takes `appId`, `installationId` and `privateKeyRef`.

Secrets are always references, never values:
- `env:NAME` reads an environment variable.
- `file:/path` reads a file.
- `store:key` passes validation, but nothing resolves it yet (not implemented in v1).

Any other value, such as a literal token, is rejected.

A token needs enough access to create private repos and push. With a fine-grained PAT, grant:
- Administration: read & write
- Contents: read & write
- Pull requests: read & write
- Workflows: read & write
- Checks and Commit statuses: read

With a classic PAT, grant `repo`, plus `workflow` if workflows will be pushed.

## Worker settings (extension-owned)

`workers.<name>` holds the settings of worker extension `<name>`. They layer, validate and pin per run like every
other setting; the core hands a run's pinned values to the extension's tools.

| Path | Default | Meaning |
|---|---|---|
| `workers.web-search.mode` | `fast` | Parallel search mode: `turbo`, `fast` (about 1 s), `basic` or `advanced` (about 3 s, highest quality) |
| `workers.web-search.maxResults` | `10` (1–40) | Results per search |
| `workers.web-search.maxCharsTotal` | unset (1000–200000) | Optional cap on the excerpt characters of one search |
| `workers.web-search.apiKey` | `env:PARALLEL_API_KEY` | Reference to the Parallel API key (`env:` or `file:`, never the key) |
| `workers.web-search.endpoint` | `https://api.parallel.ai/v1/search` | Search endpoint |

Without a key, `web_search` returns an error that tells the agent to carry on without searching; nothing else
breaks. The tool runs in the factory process, so the key never reaches the sandbox and `api.parallel.ai` needs no
`allowedDomains` entry. Queries leave the machine and are kept in transcripts; to turn searching off for a role,
remove `web-search` from `roles.<role>.extensions`.

## Example

```yaml
version: 1
roles:
  reviewer: { model: openai/gpt-6-sol, thinking: high }
policy: { approvals: [spec, delivery], reviewRoundCap: 3 }
workers:
  web-search: { mode: fast, apiKey: env:PARALLEL_API_KEY }
stages:
  repo:
    identity: { kind: pat, tokenRef: env:GH_TOKEN }
  delivery:
    ci: { mode: if-present, fixRounds: 2 }
  environment:
    sandbox: { allowedDomains: [registry.npmjs.org] }
projects:
  todo:
    repo: me/todo
    policy: { approvals: [spec, delivery, merge] }
    stages: { delivery: { ci: { mode: required } } }
```
