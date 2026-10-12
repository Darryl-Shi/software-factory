# Update the factory from the web UI

Change spec for run `run-mv4rp25k-mqna`, in the context of the existing product (`docs/spec.md`). The builder updates
`docs/spec.md` (§9 web UI, §10 CLI, plus a short section on updates), `README.md`, `docs/architecture.md` and `AGENTS.md`'s map.

## 1. What changes

The factory can update itself from the web UI to the latest version of its own code on GitHub, then restart itself.
"Latest version" means the tip of the **upstream branch of the factory's own git checkout** (normally `origin/main` of
`Darryl-Shi/software-factory`). The repo has no tags or releases, and this change adds none.

The UI shows which version is running, tells you when an update is available, and offers **Update**. Update
fast-forwards the checkout, reinstalls dependencies when needed and restarts the factory the way it was started.
Runs, bundles and discussions in flight carry on after the restart through the existing durability (§8 of the product
spec). The interrupted agent step is redone; nothing moves state.

Out of scope: tags, releases or channels; choosing a version or downgrading from the UI; updating the product repos
the factory builds; automatic, unattended updates; updating installs that are not git checkouts.

## 2. Key decisions

### 2.1 The install and its version

- **Install root:** the directory that holds the running code (`src/`'s parent, the same root `bin/factory` and the
  service unit use). The updater takes this root as a parameter, so tests can point it at a temporary clone.
- **Updatable** only when the install root is a git work tree on a branch with an upstream (`@{u}`). Otherwise the UI
  shows the version with "Updates unavailable: <reason>": not a git checkout, detached HEAD, or no upstream branch.
- **Version:** the HEAD commit's short SHA, its commit date and `package.json`'s `version`. Shown in the UI header.

### 2.2 Checking for updates

- A check runs `git fetch` of the upstream remote, then compares HEAD with `@{u}`. It reports:
  - `behind`: the number of commits HEAD is behind
  - `ahead`: local commits not on the upstream
  - the upstream's short SHA
  - up to 50 subject lines of the incoming commits (`git log HEAD..@{u}`), newest first
  - whether tracked files have local modifications (`dirty`)
  - the time of the check
- When checks run: once shortly after startup, then every 6 hours, and on demand ("Check now"). A failed fetch (no
  network, auth) is recorded as the check's error and shown in the dialog. It is never fatal and never logged as more
  than one line.
- `git` runs in the factory process with the user's own git configuration and credential helpers, so a private
  factory repo works if the user can `git fetch` it. Nothing runs in a sandbox, and no factory secret is used.

### 2.3 Applying an update

Only one update runs at a time; a second request gets `conflict`. The steps:

1. **Preconditions** (checked again right before applying):
   - the checkout is updatable
   - it is not dirty
   - it is not ahead or diverged
   - `behind > 0`

   Each failure is refused with a reason the UI shows, and nothing changes. Examples: "local changes in tracked
   files", "local commits not on origin/main", "already up to date". Untracked and ignored files (e.g.
   `.factory-dev/`) don't count as dirty.
2. **Record:** write `<factory home>/update.json` (mode 0600) with:
   - the previous SHA and the target SHA
   - the start time
   - the phase: `pulling` → `installing` → `restarting` → `done` | `failed` | `rolled-back`
   - an error, when there is one
3. **Pull:** `git merge --ff-only <target SHA>` (the SHA from the check just made, so the version shown in the dialog
   is the one installed).
4. **Install:** `npm ci --no-audit --no-fund` if `package-lock.json` (or `package.json`) differs between the two SHAs.
   If it fails, the checkout is reset to the previous SHA, `npm ci` runs again when the lockfile had changed, the
   phase becomes `failed` with the npm error's last lines, and there is **no restart**.
5. **Restart**, by how the factory was started:
   - **systemd user unit** (`software-factory`): `systemctl --user restart software-factory`
   - **launchd agent** (`dev.software-factory`): `launchctl kickstart -k gui/<uid>/dev.software-factory`
   - **`factory serve` daemon:** stop it, then start the daemon again with the same serve arguments it was started
     with
   - **foreground** (`--foreground` run by hand, e.g. `scripts/run.sh`): no automatic restart. The phase becomes `done`
     with "Restart the factory to finish the update", and the UI keeps showing that until the running SHA equals the
     target.

   How the factory was started is detected in the process. systemd: `INVOCATION_ID` plus the unit being active.
   launchd: `XPC_SERVICE_NAME` matching the label. Daemon: a marker that `startDaemon` passes to the child together
   with its serve arguments. Otherwise it is foreground.
6. **The restart is done by a detached helper process** that the factory spawns outside itself (its own process group;
   it is not killed with the factory), logging to `factory.log`. The helper:
   - triggers the restart
   - waits up to 90 s for the new process to serve `GET /api/version` with the target SHA
   - on success, sets the phase to `done`
   - on failure, resets the checkout to the previous SHA, runs `npm ci` again if the lockfile had changed, restarts
     again and sets the phase to `rolled-back`, with the reason and the last lines of `factory.log`

   The restart reuses the existing restart logic of `src/setup/context.ts` (move it into a shared module rather than
   copy it).
7. **After the restart,** the factory reads `update.json` at startup and reports the last update: "Updated from
   `abc1234` to `def5678`", or "Update to `def5678` failed to start; rolled back to `abc1234`: <reason>". The report
   stays until it is dismissed.

**Work in flight (decision A):** Update is allowed at any time. The confirm dialog lists the active work:
- runs and bundles in a state where an agent works or the core acts: `PREPARING`, `DISCUSSING`, `BUILDING`,
  `REVIEWING`, `DELIVERING`, `INTEGRATING`, `FIXING`, `AWAITING_CI`
- discussions with a turn running

It also explains that they resume after the restart and only the step in progress is redone. Nothing is cancelled,
paused or failed by an update. The shutdown is the factory's normal SIGTERM path. The factory may be killed partway
through; durability covers that, as with a `kill -9`.

### 2.4 Interface

The updater (`src/update/`) is a service wired in `src/main.ts`, **not** a `FactoryCore` operation: the core stays
about runs, discussions and bundles. The web server exposes it with the same token/cookie auth and the same Host and
Origin checks as `/api/op`:

- `GET /api/version`: `{ version, sha, date, updatable, reason?, check?: { behind, ahead, dirty, upstream, upstreamSha, commits[], checkedAt, error? }, update?: <update.json contents>, startedBy: "systemd" | "launchd" | "daemon" | "foreground" }`
- `POST /api/update/check`: runs a check now and returns the same body.
- `POST /api/update/apply` `{ sha }`: `sha` must equal the latest check's upstream SHA (`conflict` otherwise, e.g. the
  upstream moved; the UI re-checks). Refusals use the existing error shape and codes: `invalid` for preconditions,
  `conflict` for an update already running or a stale SHA.
- `POST /api/update/dismiss`: clears the last update's report.

Every apply, check failure and rollback is logged to `factory.log` with both SHAs.

### 2.5 Web UI

- **Header:** a version chip showing the short SHA (tooltip: the date and package version). When `behind > 0` it
  becomes **Update available (N)**.
- **Update dialog** (opened from the chip):
  - the running version and the upstream version
  - the incoming commit subjects (rendered with `inline()`)
  - "Check now" and the last check's time or error
  - any precondition that blocks the update, with its reason
  - the list of active work, as in §2.3
  - **Update**, behind a confirmation

  In foreground mode the dialog says the factory will need a manual restart.
- **While updating:** the dialog shows the phase. Once the server goes away it shows "Restarting…" and polls
  `/api/version` every 2 s, then reloads the page when the running SHA changes. The access token is persisted, so the
  cookie stays valid. The board's event stream reconnects as it does today.
- After a restart, the last update's report shows once as a dismissible banner.
- No inline scripts and no CSP change. The UI files stay classic scripts with no build step.

### 2.6 CLI

- `factory update` runs the same check and apply from a terminal. It prints the commits, asks for confirmation (or
  takes `--yes`) and restarts the same way. If no factory is running it only pulls and installs.
- `factory status` also prints the running SHA.

## 3. Tests

Use a temporary bare repo as the upstream and a clone of it as the install root (with `npm ci` stubbed through an
injectable command runner). Cover:
- checks: behind, ahead, dirty, detached HEAD, no upstream, fetch failure
- apply: fast-forward to the checked SHA, refusals, a stale SHA, one update at a time
- rollback when the install fails and when the new version doesn't come up
- the `update.json` phases
- web routes: auth and Origin rejection
- detection of how the factory was started

The daemon restart path gets a real-process test next to `test/daemon.test.ts`. No existing test is weakened.

## Acceptance behaviours

1. The web UI header shows the running factory's short commit SHA. `GET /api/version` returns the same SHA, whether
   the install is updatable, and how the factory was started.
2. When the factory's upstream branch has new commits, after **Check now** (or the startup check) the header shows
   **Update available (N)**, and the dialog lists the N commit subjects.
3. With the factory running as a `factory serve` daemon, clicking **Update** and confirming fast-forwards the checkout
   to the shown upstream SHA and restarts the factory. The page reloads by itself, the header shows the new SHA, and a
   banner reads "Updated from <old> to <new>".
4. A run that was `BUILDING` during the update is still `BUILDING` after the restart, in the same round and with the
   same builder Conversation, and it goes on to `READY` with nothing done by hand. A pending spec approval is still
   pending.
5. The confirm dialog lists the runs, bundles and chats that are active at that moment.
6. With a modified tracked file, or a local commit not on the upstream, in the factory checkout, Update is refused
   with that reason and the checkout is unchanged.
7. If the upstream moves after the check, applying the stale SHA is refused, and the UI re-checks and shows the new
   commits.
8. When `package-lock.json` changes in the update, dependencies are reinstalled before the restart. If the install
   fails, the checkout is back on the old SHA, the factory keeps running, and the dialog shows the error.
9. If the new version does not start within 90 s, the factory comes back on the old SHA, and a banner says the update
   was rolled back, with the reason.
10. Started in the foreground (`scripts/run.sh`), Update pulls the new code and says "Restart the factory to finish
    the update" instead of restarting.
11. In a copy of the factory that is not a git checkout (or is on a detached HEAD), the chip shows the version and
    "Updates unavailable" with the reason, and no Update button.
12. The update routes reject requests without the access token, and requests with a foreign `Origin`, exactly like
    `/api/op`.
13. `factory update --yes` from a terminal applies the same update, and `factory status` prints the running SHA.
