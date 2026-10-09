# Configuration

All configuration lives in a single YAML file: `~/.factory/config.yaml` by default, or `--config` / `$FACTORY_CONFIG`.
`factory serve` creates the file with just `version: 1` if it doesn't exist. Settings read and write this file
directly; there is no second store. The factory's other files (`factory.pid`, `factory.log`, `web-token`, `web-url`)
live next to it.

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
  - models must be known to pi-ai;
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
| `roles.helper` | `anthropic/claude-sonnet-5-5`, `medium` | Helpers the builder spawns; read-only |
| `roles.reviewer` | `openai/gpt-6-sol`, `high` | Whole-product review |
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
| `webSearch.apiKey` | `env:PARALLEL_API_KEY` | Reference to the Parallel API key (`env:` or `file:`, never the key) |
| `webSearch.endpoint` | `https://api.parallel.ai/v1/search` | Search endpoint |
| `storage.kind` / `storage.path` | `sqlite` / `~/.factory/factory.sqlite` | Harness storage (`sqlite` or `jsonl`); global only |

Each role has two fields:
- `model`: `provider/modelId`, as known to pi-ai's `createModels()`.
- `thinking`: one of `off`, `low`, `medium`, `high`.

The defaults put the reviewer on a different model family from the builder on purpose.

Each role's tools are fixed, not settings. The role's prompt (`role-<role>`) always comes first:

| Role | Tools |
|---|---|
| architect | `coding-readonly`, `web-search` |
| builder | `coding`, `subagent`, `test-runner`, `web-search` |
| helper | `coding-readonly`, `web-search` |
| reviewer | `coding-readonly`, `test-runner`, `browser`, `web-search` |

Model credentials are not settings. pi-ai reads them from the environment, e.g. `ANTHROPIC_API_KEY` and
`OPENAI_API_KEY`.

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
| `denyRead` | `[~/.factory, ~/.ssh, ~/.config/gh]` | Paths hidden from every role. |
| `extraWrite` | `[]` | Extra writable paths for the builder. Rejected if it would make home or `/` writable, or overlap a denied path. |
| `unixSockets` | `auto` | Linux only: `block`, `allow`, or `auto`, which relaxes the setting if the host forbids nested user namespaces (DEVIATIONS.md §7). |
| `setupScripts` | `[scripts/setup.sh, setup.sh, bin/setup]` | The first one that exists in the worktree runs when the builder's environment is provisioned (sandboxed, with the builder's rights). |

### GitHub identity

`github.identity` sets how the factory authenticates to GitHub, for opening repos, delivery, CI and merges.
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

### Web search

Without a key, `web_search` returns an error that tells the agent to carry on without searching; nothing else
breaks. The tool runs in the factory process, so the key never reaches the sandbox and `api.parallel.ai` needs no
`allowedDomains` entry. Queries leave the machine and are kept in transcripts. Every role has the tool; to turn
searching off, leave the key unset.

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
projects:
  todo:
    repo: me/todo
    policy: { approvals: [spec, delivery, merge] }
    ci: { mode: required }
```
