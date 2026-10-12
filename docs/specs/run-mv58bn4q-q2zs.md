# Disk cleanup: delete finished runs', bundles' and discussions' worktrees, branches and scratch; sweep leftovers at startup

This is an incremental change to the software factory (Darryl-Shi/software-factory). The builder records it in `docs/specs/<run-id>.md` and updates `docs/spec.md` and the other docs listed under "Docs".

## Why

Today the factory never deletes anything it puts under `workdir` (default `~/factory/work`): run worktrees and manifests, bundle worktrees, discussion checkouts, local and remote `factory/*` branches, per-role scratch dirs, and sandbox environment records (which are only marked `disposed: true`). This filled the host's disk. The human's decision: **delete right away and as much as possible**. Anything that can be recreated, or is already merged, goes as soon as nothing uses it. This reverses the "destroys nothing" decision in `docs/specs/run-mv46ek2u-7omz.md` and the spec's "Worktrees are kept on disk in every terminal state".

## Vocabulary

Every run, bundle and discussion is an **owner**. Its on-disk things are found through its **pinned** workdir (`expandHome(pinned.config.workdir ?? "~/factory/work")`), never only the current global one:

| Thing | Where |
|---|---|
| worktree / checkout | `<workdir>/runs/<id>`, `<workdir>/bundles/<id>`, `<workdir>/discussions/<id>` |
| manifest | `<workdir>/<area>/<id>.json` (where one exists) |
| local branch | `factory/<id>` in the shared clone `<workdir>/repos/<owner>__<repo>` |
| remote branch | `factory/<id>` on the host (runs and bundles only: discussion branches are never pushed) |
| scratch | `<workdir>/scratch/<id>-<role>` for every role (HOME, TMPDIR, caches, setup.log) |
| environment records | `<factory home>/environments/<id>-<role>.json` |

There are two cleanup scopes:

- **full**: remove all six things, each only where it exists.
- **scratch**: remove **only the scratch dirs**. **Environment records are kept.** This is the human's decision (option A). A retried run or bundle resumes at its failed state without provisioning again, and `Sandbox.env()` needs the record. `policy()` recreates `home/tmp/cache/npm-cache` the next time the environment is used. Records are deleted only by a full cleanup, or by the sweep when they have no owner.

## Rules (what each state gets)

| Owner | State | Scope |
|---|---|---|
| Run | DELIVERED (bundle merged, or legacy delivery) | full |
| Run | FAILED / CANCELLED and `cleared` | full |
| Run | FAILED / CANCELLED, not cleared | scratch (it can be retried and may hold uncommitted work) |
| Run | READY (in a bundle or not) and every non-terminal state | none (bundles merge members' local branches) |
| Bundle | MERGED | full, of the bundle's own things only |
| Bundle | CANCELLED | full, of the bundle's own things only. **Member runs' local and remote branches are never touched** (members are READY again, so the run rule keeps them). |
| Bundle | FAILED | scratch (it can be retried; a merge may be in progress) |
| Discussion | CLOSED / FAILED | full (it has no remote branch) |
| Discussion | OPEN / PREPARING | none |

The rules live in one pure function, `cleanupScope(owner) → "none" | "scratch" | "full"`. Every caller uses it.

## Key technical decisions

### One cleanup service
A new module (e.g. `src/core/cleanup.ts`) holds the scope function and `cleanup(owner, scope)`. Task finalize/abort paths, the core operations and the startup sweep all call it. It never throws. It returns `{ removed: string[], failures: string[] }`, and every failure is logged with the owner id and the step.

The order of a full cleanup:
1. the remote branch;
2. the worktree, with `git worktree remove --force` and then deleting the directory;
3. `git worktree prune`;
4. the local branch, with `git branch -D`;
5. the manifest;
6. the scratch dirs;
7. the environment records.

Each step is attempted even if an earlier one failed. Each step is idempotent: a missing thing counts as success. This makes a `kill -9` at any point safe, and a rerun finishes the job.

### Cleaned marker
RunDoc, BundleDoc and DiscussionDoc gain an optional `cleanedUp?: { at: number; scope: "scratch" | "full" }`.
- **Set:** only when every step of that scope succeeded, in a normal commit of the owner's Document. A Task commits it with `rt.commit`; core operations and the sweep commit it with `root.commit`.
- **Partial failure:** the marker stays absent, or stays at the lower scope, so the sweep retries later.
- **Upgrades:** `scratch` can become `full` (an uncleared FAILED run that is later cleared). `full` is final.
- **Reset:** `retryRun`, `retryBundle`, and discussion reopen/retry delete the marker in the commit that restarts the owner, because the owner will create scratch, records or a checkout again.
- A failure to commit the marker is logged and is harmless: the next call or sweep redoes the steps, and they are idempotent.
- The marker never changes or blocks the owner's state transition.

### Git and GitHub
- **Removing a checkout:** `discard()` in `src/github/github.ts` becomes a public `GitHub` method that takes the area, the id and the pinned workdir. It runs under the per-clone lock (`withClone`), so cleanup never races `open`/`push`/`integrate` on the same clone. It must work when the manifest is already gone: it derives the paths from area, id and repo. The existing stale-manifest and `refresh().again()` uses keep their behaviour.
- **Remote branches:** a new `GitHubHost.deleteBranch(repo, branch, identity)` method.
  - `GhApiHost` sends `DELETE /repos/{owner}/{repo}/git/refs/heads/{branch}`. A 404 or 422 counts as already gone.
  - `LocalGitHubHost` deletes the ref in its bare remote, and is a no-op when the ref is absent.
  - `GitHub.deleteRemoteBranch` wraps it:
    - it only deletes `factory/<owner-id>` of a known record;
    - it refuses the repo's default branch;
    - it is skipped when the repo does not exist on the host (a new-repo project's local-only clone).
- **Clone sweep:** a `GitHub` method for the startup sweep, also under `withClone`. It runs `git worktree prune` and lists local `refs/heads/factory/*`. It deletes a branch when it is not checked out in any worktree and its owner either has no record or the owner's scope is `full` and the owner is fully cleaned. It never deletes a branch whose owner's rule keeps it (READY, uncleared FAILED/CANCELLED runs, FAILED bundles, open discussions).

### Sandbox
- `Sandbox.removeScratch(ownerId, workdir)` deletes `<workdir>/scratch/<ownerId>-<role>` for every known role name. It matches exact `<id>-<role>` names, so `bundle-1` never matches `bundle-10-…`. It also deletes the `scratch` path stored in any surviving record of that owner, in case it points elsewhere.
- `Sandbox.destroy(envId)` deletes the record file and drops the in-memory record and network entry.
- `dispose()` stays as it is: it still marks `disposed: true`, and it still runs first in `sideEffectsAtEnd`.
- `provision()` already creates a fresh record when none exists. A reopened discussion relies on this.

### Where cleanup runs
- **Run Task:** in `finalize` (the DELIVERED/FAILED/CANCELLED phases) and in `abort`.
  - When: after `sideEffectsAtEnd`/`markVmsDisposed` and before the terminal commit.
  - Scope: from `cleanupScope`.
  - A member run becomes DELIVERED in its own Task (READY sees `bundleMerged`), so member cleanup happens there.
- **`clearRuns`:** after its commit, it starts a full cleanup of each cleared run that isn't fully cleaned yet, in the background. The operation returns as soon as the commit is done; it does not wait for deletion.
- **Bundle Task:** in `finalize` and `abort`, with the scope from `cleanupScope`. It only touches the bundle's own id.
- **`Factory.cancelBundle` on a FAILED bundle** (no Task involved): after its commit, it starts a full background cleanup of the bundle.
- **Discussion Task:** wherever it leaves OPEN, next to `disposeEnv`: the CLOSED path, the FAILED catch path, and the abort path when the state is no longer OPEN.
  - Reopen and retry need no new code. PREPARING calls `refresh`. A missing checkout or manifest goes through `again()` (discard + open), which gives a fresh read-only checkout of the latest default branch. `provision` then makes a new environment record.
- **Per-owner serialisation (in process):** two cleanups of the same owner never run at once (Task, operation and sweep alike). `retryRun`, `retryBundle` and discussion reopen/retry first wait for any in-flight cleanup of that owner, then commit. A retry therefore never races a scratch deletion.
- **Test hook:** the core exposes a way to await all pending background cleanups (like the existing sweep test hook).

### Startup sweep
Started from `Factory.start()` after `harness.resume()`, with `void` like `sweepQaVms`. It never delays the web server. It runs one owner at a time, sequentially.

1. **Records.** For every run, bundle and discussion in storage:
   - compute `cleanupScope`;
   - skip the owner if the scope is `none`, or the marker already covers the scope, or its Task exists and isn't terminal (the Task's own finalize handles it);
   - re-read the state just before acting;
   - otherwise run the cleanup.

   This backfills records created before this change and retries failed cleanups.
2. **Orphans.** The workdirs are the global workdir plus every distinct pinned workdir of a record.
   - In each workdir, remove factory-named entries whose id matches no record in storage:
     - `runs/run-*` and `runs/run-*.json`;
     - `bundles/bundle-*` and their `.json`;
     - `discussions/disc-*` and their `.json`;
     - `scratch/<id>-<role>`, where `<id>` matches one of those patterns and `<role>` is a known role.

     A worktree under a clone is removed with `git worktree remove --force` when its clone is known, then deleted.
   - Remove environment records under `<factory home>/environments/` whose owner id has no record.
   - Run the clone sweep on every `repos/*` clone.
   - Entries whose id matches a record are never treated as orphans: the record's rule decides.
   - No other names are touched.
3. **Summary.** Log one line: `disk sweep: removed N items (runs a, bundles b, discussions c, scratch d, env records e, branches f local / g remote), K failures`. Each failure is also logged on its own line. Bytes freed are not measured: walking `node_modules` costs about as much as deleting it.

A second sweep over the same data removes nothing.

### On-demand `gc`
- A new core operation `gc` (added to `CORE_OPS`) runs the same sweep and returns the summary (`removed` list, `failures`). If a sweep is already running, it waits for that sweep and returns its result.
- `bin/factory gc` calls `POST /api/op/gc` on the running factory through its `web-url`, the same way the CLI reads `/api/version`. It prints what was removed and any failures. If no factory is running, it says so and exits non-zero.
- There is no web UI button.

### Views and what stays
- These are never deleted: QA screenshots in `<factory home>/artifacts`, conversations, and the SQLite records.
- Run, bundle and discussion views keep loading in every state. They don't read worktrees in terminal states today, and that stays true. Anything that would read a missing worktree degrades gracefully rather than erroring.
- Closed PRs whose head branch was deleted can't be reopened. The human accepted this.

## Out of scope
- Deleting scratch `tmp/` while a run is going.
- A shared npm cache.
- A disk warning in `factory doctor`.
- Pruning SQLite.
- Deleting remote `factory/*` branches that no record knows about.
- QA VM records (`qa-vms`), which keep their existing sweep.

## Docs
- **`docs/spec.md`:**
  - §3 terminal row: "Environments disposed, worktrees kept" becomes the new rule;
  - the run delivered-in-bundle paragraph;
  - the storage paragraph ("Worktrees are kept on disk in every terminal state");
  - `clearRuns` ("deletes nothing" becomes "starts a full cleanup");
  - the bundle MERGED/CANCELLED/FAILED rows;
  - discussions ("reopen resyncs the checkout" becomes "reopen re-creates it");
  - a new startup-sweep / `gc` subsection;
  - `gc` in the operations list.
- **`docs/architecture.md`:** the cleanup service, the sweep and `GitHubHost.deleteBranch`. Also fix "helpers … in its own worktree": helpers share the builder's worktree.
- **`docs/configuration.md`:** under `workdir`, what lives there and when it is deleted.
- **README:** in the web UI section on clearing, note that Clear deletes a finished run's files and branches. Add `bin/factory gc` to the commands in the README and AGENTS.md.
- **`docs/specs/run-mv46ek2u-7omz.md`:** a note that this change reverses its "destroys nothing" decision.

## Acceptance behaviours
All of these are checked with `LocalGitHubHost` and scripted agents (`test/helpers.ts`). `npm test` and `npm run typecheck` pass.

1. **Merged run.** After a bundle merges, for each member run all of these are gone: `runs/<run-id>`, `runs/<run-id>.json`, the local `factory/<run-id>` in the shared clone, the remote `factory/<run-id>` in the fake's bare remote, every `scratch/<run-id>-*`, and every `environments/<run-id>-*.json`. Its run view, its conversations and its QA screenshots still load.
2. **Merged bundle.** After MERGED, all of these are gone: `bundles/<bundle-id>`, its manifest, the local and remote `factory/<bundle-id>`, `scratch/<bundle-id>-*`, and its environment records. The bundle view still loads.
3. **Cleared run.** `clearRuns` on a FAILED run and on a CANCELLED run removes everything listed in 1, once background cleanups have been awaited. `retryRun` on them is still refused.
4. **Uncleared FAILED run.** It keeps its worktree, manifest, local and remote branch, and environment records, but its `scratch/<run-id>-*` dirs are gone. `retryRun` resumes it and its agents run normally: the scratch dirs are recreated and no "unknown environment" error appears. Its `cleanedUp` marker is cleared by the retry.
5. **READY run.** A READY run in an open bundle, and a READY run in no bundle, keep their worktree, branches, scratch and records through every cleanup and sweep.
6. **Cancelled bundle, from a live Task.** When a bundle is cancelled while its Task is live, the bundle's own worktree, manifest, branches, scratch and records are removed. Every member run is READY again, and its local and remote `factory/<run-id>` and worktree still exist. A new bundle with the same members integrates and merges.
7. **Cancelled bundle, from FAILED.** When a FAILED bundle is cancelled (the `Factory.cancelBundle` path), the same holds as in 6.
8. **FAILED bundle.** It keeps its worktree and branch and loses only its scratch. `retryBundle` resumes it and it can merge.
9. **Closed discussion.** CLOSED removes `discussions/<id>`, its manifest, the local `factory/<id>`, its scratch and its environment record. Reopen gives a read-only checkout at the latest default branch, and a turn can read a file from it.
10. **Failed discussion.** A discussion that reaches FAILED is cleaned in the same way. Retry recreates the checkout, and a turn can read files.
11. **Failures.** A forced failure in any deletion step (e.g. the host's `deleteBranch` throws, or a directory can't be removed) is logged with the owner and step. The owner still reaches its terminal state, and its `cleanedUp` marker is absent or at the lower scope. A later cleanup call or startup sweep completes the removal and sets the marker.
12. **Startup sweep.** A workdir is seeded with all of these:
    - a DELIVERED run without a marker;
    - a cleared FAILED run;
    - an uncleared FAILED run;
    - a READY run in an open bundle;
    - a MERGED bundle and a FAILED bundle;
    - a CLOSED discussion and an OPEN discussion;
    - an orphan `runs/run-x`, an orphan `scratch/run-x-builder` and an orphan environment record;
    - a stale local `factory/run-x` branch;
    - a non-factory directory under `runs/`.

    After a factory start (and the sweep finishing), exactly what the rules allow is removed: everything of the DELIVERED run, the cleared run (including both remote branches), the MERGED bundle and the CLOSED discussion; only the scratch of the uncleared FAILED run and of the FAILED bundle; and all the orphans and the stale branch. The READY run, the OPEN discussion and the non-factory directory are untouched. One summary line is logged.
13. **Second start.** Starting again removes nothing more, and the summary reports 0 items.
14. **Pinned workdir.** A record whose pinned workdir differs from the current global workdir is cleaned in its pinned workdir.
15. **`gc`.** With the factory running, `bin/factory gc` (or `POST /api/op/gc`) runs the sweep and prints what it removed. With nothing left, it prints that nothing was removed.
