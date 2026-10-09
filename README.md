# software-factory

A software factory built on **Pi Durable** (`@earendil-works/pi-durable@1.1.0`) and Pi's extension system. It implements
`software_factory_design.md`: a request goes through an architecture discussion, a spec, an unattended build by one builder
(plus the helpers it spawns), a whole-product review against the spec with enforced findings and evidence, delivery to
GitHub and CI. It involves a human only for the discussion and for approvals.

- **Core** (`src/core/`): model-free and interface-agnostic. It holds:
  - the state machine, a durable Pi Durable Task;
  - the agent bridge, which enforces the findings and evidence rules;
  - projects and layered settings;
  - durable pending asks.

  It exposes only operations and events (`FactoryCore`, §3.6).
- **Factory extensions** (`src/extensions/`):
  - `github` (repo) and `github-delivery` (push-main / PR, CI modes `off` / `if-present` / `required`);
  - `local-worktree` (per-run worktree, every command run inside `@anthropic-ai/sandbox-runtime`);
  - `cli` (the interface: a socket server plus the `factory` terminal client with attach view and settings menu).
- **Worker extensions** (`src/extensions/workers/`) are plain Pi Durable extensions:
  - `coding`, `coding-readonly`, `subagent` (helpers as owned Conversations), `test-runner`, `browser` (an HTTP client);
  - the role prompt sections.

See `DEVIATIONS.md` for every place this differs from the spec.

## Requirements

- Node.js ≥ 22 (tested on 22.23). `npm install`.
- Linux: `bubblewrap` and `socat` for the sandbox (`sudo apt install bubblewrap socat`). macOS uses `sandbox-exec`.
- `git`. For real GitHub you also need `gh` (the GitHub CLI) and a token (see *Going live* below).
- Model credentials for the roles' providers, read by pi-ai from the environment: `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` for the defaults.

`factory doctor` checks all of these.

## Running

```sh
bin/factory serve                       # the one process that owns storage + core; listens on ~/.factory/factory.sock
bin/factory project create todo --repo me/todo
bin/factory run todo "CLI todo tool: add/list/done/remove, JSON file storage, tests" --attach
# or the shorthand that creates the project and starts its first run:
bin/factory run todo --repo me/todo "CLI todo tool: …"
```

`factory serve` options:
- `--config <path>` (default `~/.factory/config.yaml`, or `$FACTORY_CONFIG`)
- `--socket <path>`
- `--fake-github <dir>`: a local fake GitHub with bare remotes and a local CI runner; no token needed
- `--scripted`: the scripted demo agents, no model credentials needed

Client commands talk to the server over its socket (`$FACTORY_SOCKET` overrides it):

```
factory project create <name> --repo owner/name | project list
factory run <project> [--repo owner/name] [--title t] "<request>" [--attach]
factory runs [--project p] [--json]          factory status <run> [--json]
factory attach <run> [--no-input]            live view: run state, the active role's transcript incl. helpers,
                                             events; answers questions / approvals / escalations at the prompt
factory transcript <run> [architect|builder|reviewer|<conversationId>] [--json]
factory answer <run> "<text>"                factory approve <run> <spec|delivery|merge>
factory reject <run> <gate> "<feedback>"     factory findings <run> <delivery|merge> '<json>' | @file.json
factory escalation <run> accept | more <N> | abort
factory cancel <run> [reason]                factory retry <run>
factory settings [--project p]               interactive menu (Policy · Roles · Stages), generated from settingsSchema()
factory settings get [<path>] [--project p]  every value with its source: default | global | project
factory settings set <path> <value> [--project p]     e.g. policy.approvals '[spec, delivery, merge]'
factory settings unset <path> [--project p]  project scope: back to inheriting
factory doctor
```

## Configuration

`~/.factory/config.yaml` is plain data in the shape of spec §5. Every setting resolves in layers: schema default, then the
global value (top level), then the project value (`projects.<name>`). Objects merge key by key; lists and scalars replace.
`storage` is global only. Changes are validated on save against the schema, the owning extension's `validate`, and the
core rules, applied to the effective config of every affected project. An invalid change is rejected and the file is left
untouched. Runs pin the effective config, its hash and the Pi Durable version when they start.

```yaml
version: 1
roles:
  architect: { model: anthropic/claude-opus-5-5, thinking: high }     # extensions: [coding-readonly]
  builder:   { model: anthropic/claude-opus-5-5, thinking: high }     # extensions: [coding, subagent, test-runner]
  helper:    { model: anthropic/claude-sonnet-5-5, thinking: medium } # extensions: [coding-readonly]
  reviewer:  { model: openai/gpt-6-sol, thinking: high }              # extensions: [coding-readonly, test-runner, browser]
policy: { approvals: [spec], reviewRoundCap: 3, escalateOnNoProgress: true }
storage: { kind: sqlite, path: ~/.factory/factory.sqlite }
stages:
  interface: { use: [cli], socket: ~/.factory/factory.sock }
  repo:
    use: github
    visibility: private
    workdir: ~/factory/work
    identity: { kind: pat, tokenRef: env:GH_TOKEN }  # or kind: bot (tokenRef), or kind: app (appId, installationId, privateKeyRef: file:/path.pem)
  delivery:
    use: github-delivery
    newRepo: push-main
    existingRepo: pull-request
    ci: { mode: if-present, fixRounds: 2, checks: [], noChecksTimeout: 2m }
  environment:
    use: local-worktree
    root: ~/factory/work
    setupScripts: [scripts/setup.sh, setup.sh, bin/setup]
    sandbox:
      enabled: true
      allowedDomains: [registry.npmjs.org, pypi.org, files.pythonhosted.org, proxy.golang.org]
      deniedDomains: []
      denyRead: [~/.factory, ~/.ssh, ~/.config/gh]
      extraWrite: []
      unixSockets: auto     # see DEVIATIONS.md (Ubuntu ≥ 24.04 AppArmor userns restriction)
projects:
  todo:
    repo: me/todo
    stages: { delivery: { ci: { mode: required } } }
```

Secrets are references: `env:NAME` or `file:/path`. Values are never stored in the config.

## Tests

```sh
npm test            # vitest: 66 tests, about 30 s
npm run typecheck   # tsc, no emit
```

| File | Covers |
|---|---|
| `test/machine.test.ts` | Every §4 transition, gates (spec / delivery / merge), rejections, escalations (round cap, no progress, CI cap, no CI checks), fix-round caps, CI modes, cancel / retry, events, pinning, idempotent asks |
| `test/settings.test.ts` | Layering and source attribution, inherit / unset, validate-on-save (file unchanged), the schema includes the extensions, projects |
| `test/findings.test.ts` | Review validation (fail ⇔ blocking, evidence and specRef required), human findings, builder responses (wontfix needs a reason), live bridge enforcement, helper role tools |
| `test/durability.test.ts` | `kill -9` mid-build and at a pending approval (SQLite): resumes at the same round with the same builder Conversation; pending asks survive |
| `test/sandbox.test.ts` | The real bubblewrap sandbox: role write rules (bash and file tools), git hooks not writable, denyRead, no credential env vars, network allowlist |
| `test/github-api.test.ts` | `GhApiHost` request shapes, token handling, App JWT exchange (fake `gh` plus a local token server) |

Tests use scripted agents (`src/testing/scripted.ts`, built on the pi-ai faux provider) and a fake GitHub
(`LocalGitHubHost`), so they need no credentials or network. The network-allowlist test tolerates a host without internet.

## Dry run of the §8 trial

```sh
npm run dry-run     # DRYRUN_DIR=/tmp/x to choose the directory; about 2 minutes
```

`scripts/dry-run.ts` runs `factory serve` with:
- SQLite storage;
- the sandbox on;
- the fake GitHub with a local CI runner that executes workflow `run:` steps;
- scripted agents (`src/testing/dry-run-agents.ts`) that write, test and commit a real Node.js todo CLI.

It drives the whole §8 plan through the `factory` CLI:
- zero-to-MVP with a spec rejection and a `kill -9` mid-build;
- the incremental PR;
- delivery and merge gate rejections;
- CI modes `off` / `required` / `if-present`;
- the round cap;
- `todo2` with CI required, then CI failure with `fixRounds 0`;
- the settings checks.

It writes `report.md`; the last report is in `docs/dry-run-report.md` (50/50 checks).

## Going live on GitHub

1. Create a token for the account or org that will own the throwaway repos. A classic PAT needs `repo` (plus `workflow` if the
   builder ships `.github/workflows`, and `delete_repo` to clean up). A fine-grained PAT needs:
   - Administration (create repos): read & write
   - Contents: read & write
   - Pull requests: read & write
   - Workflows: read & write
   - Checks and Commit statuses: read

   Or use a GitHub App: set `identity.kind: app`, `appId`, `installationId` and `privateKeyRef`.
2. `export GH_TOKEN=…` (or point `stages.repo.identity.tokenRef` at another `env:`/`file:` ref) and set the model keys.
3. `bin/factory doctor`, then `bin/factory serve` without `--fake-github` and `--scripted`.
4. Run §8 by hand, or adapt `scripts/dry-run.ts`. Delete the throwaway repos afterwards.

## Layout

```
src/core/            types, settings (ConfigStore), findings, bridge, run-doc, run-task (the state machine), core (Factory)
src/extensions/      git helpers, github/{host,repo,delivery}, local-worktree, workers, cli/{server,client}
src/main.ts          process wiring (models, storage, extensions, interfaces)
src/cli.ts           `factory` command        bin/factory   launcher (tsx)
src/testing/         scripted provider, dry-run agents
scripts/dry-run.ts   §8 dry run               test/          vitest suites
```
