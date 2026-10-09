# Writing extensions

The core has no built-in interface, intake, repo host, delivery target or environment. Each one is supplied by an
extension that implements a contract from `src/core/types.ts`. This page covers how to write one. For worked examples,
read the shipped extensions under `src/extensions/`.

## Kinds of extension

| `kind` | Contract | Called by the core | v1 implementation |
|---|---|---|---|
| `interface` | `InterfaceExtension` | `start(core)` at process start | `cli`, `web` |
| `intake` | `IntakeExtension` | `pull()` every 30 s, `subscribe?()`, `writeBack()` | (none) |
| `repo` | `RepoExtension` | `open`, `create`, `diff`, `merge`, `writeArtifact` (`fork?` is declared but never called) | `github` |
| `delivery` | `DeliveryExtension` | `deliver`, `checks`, `annotate?` | `github-delivery` |
| `environment` | `EnvironmentExtension` | `provision`, `env`, `dispose` | `local-worktree` |

Every extension is a plain object with:
- `kind`;
- a unique `name`;
- the operations of its contract;
- optionally `settings: { schema, validate? }`.

## Registering

Extensions are installed in code; v1 does not load extensions dynamically. There are two ways to install one:
- Add it to the `extensions` list in `startFactoryProcess` (`src/main.ts`).
- Pass it through `ProcessOptions.extraExtensions`.

Installing an extension does not activate it. A stage extension is used only when `stages.<kind>.use` names it.
`stages.interface.use` is a list, so several interfaces can run at once; it defaults to every installed interface.

```ts
// src/main.ts
extensions: [githubRepo(host), githubDelivery(host), localWorktree({...}), cliInterface(), webInterface({...}), myInterface()],
```

## Settings an extension owns

Put the extension's settings schema in `settings.schema`. The core places those fields under `stages.<kind>`.
- They appear in `settingsSchema()`, in `factory settings` and in the source attribution from `getSettings`.
- They get the same layering (default → global → project) as the core settings.

`settings.validate(stageValue)` receives the effective `stages.<kind>` object. It runs only for the extension the
stage selects, and returns a list of problem strings. Any problem rejects the save.

- **Field types:** `string`, `number` (with `min`/`max`), `boolean`, `enum`, `list`, `object` and `secretRef`.
  Store secrets as `secretRef` fields (`env:` or `file:`) and resolve them when they're used. Never store secret values.
- **Name collisions:** when two installed extensions of the same kind declare the same top-level field, the first one
  installed wins.

## Stage extensions: what the core gives you

Every stage call receives a `StageCallOptions` value: `{ runId, settings, stages }`.

- **`settings` is the run's pinned settings** for your stage, fixed when the run started. Read your settings from
  here, not from the live config.
- **`stages`** holds all of the run's pinned stage settings. For example, `github-delivery` reads the GitHub identity
  from `stages.repo`.
- **Calls must be idempotent per `runId`.** After a crash, the core resumes a phase and may call you again with the
  same arguments. The shipped extensions handle this in three ways:
  - they store a per-run record (`open`, `provision`);
  - they check before writing (`writeArtifact`, `annotate`);
  - they look up existing objects (`findPr` before `createPr`).
- **Throwing an error fails the run** (`FAILED`). A human can then resume it with `retryRun`.
- **Credentials stay in the extension.** Agents run in the environment you provide and must never see repo or delivery
  credentials. `local-worktree` enforces this by starting commands from an empty environment inside the sandbox.

Contract notes:
- `RepoExtension.open(ref)` returns a `Workspace` (`{ repo, path, baseRef, branch, newRepo }`). It must work whether
  or not the repo exists yet.
- `DeliveryExtension.deliver` returns a `Delivery`, and `checks` returns a `CiStatus`. Return `state: "none"` while
  no checks exist yet; the core handles `ci.noChecksTimeout` itself.
- `EnvironmentExtension.env()` returns a Pi Durable `ExecutionEnv`. The core runs every agent tool through it.

## Interface extensions

An interface gets a `FactoryCore` handle in `start(core)`. The handle attributes answers to the interface's name, and
`start` returns `{ stop() }`. Transport is up to the interface: the core defines none. An interface:
- calls the operations;
- renders `subscribe` events;
- answers pending asks with `answer`, `approve`, `reject`, `submitHumanFindings` and `resolveEscalation`;
- may send messages to the agent a run is with (`message`). The core picks the recipient and the timing; an interface
  can't address a role directly, and a message never moves the run.

Pending asks are stored in the core. An interface that connects late should read `getRun(run).pendingAsk` instead of
relying on having seen the `run.ask` event. The first valid answer from any interface wins.

```ts
import type { FactoryCore, InterfaceExtension } from "../core/types.ts";

export function logInterface(): InterfaceExtension {
  return {
    kind: "interface",
    name: "log",
    settings: { schema: { verbose: { type: "boolean", default: false, description: "Log transcripts too" } } },
    async start(core: FactoryCore) {
      const off = core.subscribe({}, (e) => console.log(JSON.stringify(e)));
      return { async stop() { off(); } };
    },
  };
}
```

Then add it to `stages.interface.use`, for example `factory settings set stages.interface.use '[cli, web, log]'`. For
complete examples, see:
- `src/extensions/cli/server.ts`, which maps the operations onto JSON lines over a Unix socket;
- `src/extensions/web/server.ts`, which maps them onto HTTP (`POST /api/op/<op>`, events as server-sent events) and
  serves the static UI in `src/extensions/web/ui/` (plain JavaScript, no build step). Both use `CORE_OPS` from
  `src/core/types.ts` as the allowlist of operations a transport may call.

An interface that listens on the network must protect the core itself: the web extension binds to localhost, checks
the `Host` header (DNS rebinding) and `Origin` (cross-site requests), and requires an access token.

## Intake extensions

None ships in v1. The contract and the core's support for it exist:
- With `stages.intake.use` set, the core calls `pull()` every 30 s and `subscribe(onRequest)` if it is defined.
- It starts a run for each request it gets.
- It calls `writeBack(request, update)` when the run starts and when it reaches a terminal state.
  - `RunUpdate` carries the delivery URL, the advisory findings, any accepted blocking findings and `noCi`.
- Requests name their `project`, which must already exist.
- `pull()` gets no de-duplication help from the core; the intake must not return the same request twice.

## Worker extensions (agent tools)

Worker extensions are ordinary Pi Durable extensions (`defineExtension` from `@earendil-works/pi-durable`).
- **Contents:** tools, sections and hooks for role Conversations.
- **Registering one:** add it to `DEFAULT_WORKER_EXTENSIONS` in `src/extensions/workers/index.ts`, or to the
  `workerExtensions` you pass to `Factory`. Then list its name in `roles.<role>.extensions`. The core rejects a role
  setting that names an extension that isn't installed.
- **Environment:** tools run through `api.env`, the role's sandboxed environment, with the role's write rules. A tool
  that writes files belongs only in builder-role lists. Helpers have their write and edit tools removed.
- **Bridge tools:** agents reach the core only through the bridge tools, and the core adds them per role. Worker
  extensions should not try to change run state.
- **Prompts:** each role's prompt lives in the `role-<role>` extension in the same file, and the core adds it
  automatically.
- **Settings:** a worker extension can own settings under `workers.<name>`. Pass `{ [name]: { schema, description?,
  validate? } }` as `workerSettings` to `Factory` (`DEFAULT_WORKER_SETTINGS` in `src/extensions/workers/index.ts`).
  The values layer and pin per run like stage settings. The core writes the run's pinned values into each role
  Conversation as a `factory.workers` Document; a tool reads its own with
  `workerSettings(api, name, c)` from `src/core/worker-settings.ts`, which returns `{ runId?, settings }`.
- **Calling out of the sandbox:** a tool's `execute` runs in the factory process. A tool that needs a secret or the
  network (like `web-search`) can do its work there instead of through `api.env`, so the secret never enters the
  sandbox. It then owns that risk: keep the inputs narrow and say in a section what leaves the machine.

`web-search` (`src/extensions/workers/web-search.ts`) is a small, complete example: one tool, a settings schema with a
secret reference, `replay: "safe"`, and a section that warns agents not to put secrets in queries.
