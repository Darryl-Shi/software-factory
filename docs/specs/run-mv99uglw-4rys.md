# Spec: bundles whose PR is merged outside the factory, and bulk cancel/clear from every column

## Context

This is an incremental change to the software factory (`swf`, repo `Darryl-Shi/software-factory`). Read `docs/spec.md` §2 (bundles), §5 (core operations), §9 (board, select mode) and the earlier spec `docs/specs/run-mv545v95-rg77.md` (bulk cancel and clear).

There are two problems.

1. **A bundle whose PR is merged by hand gets stuck in Shipping.** The bundle task checks the PR on GitHub (`GitHub.prState`) only in `AWAITING_CI` and `AWAITING_MERGE`. When a bundle is `ESCALATED` (for example, the CI fix cap was hit because GitGuardian flagged a test password), or `FIXING`, `REVIEWING`, `INTEGRATING`, `DELIVERING` or `FAILED`, a PR merged by hand on GitHub is never noticed. The bundle and its tickets stay in Shipping for good.
2. **Select mode cannot act on Shipping.** Bundle cards and the runs inside an active bundle get no checkbox, so a selection cannot cancel or clear them. The human wants any ticket on the board to be cancellable and then clearable from select mode, wherever it sits.

## 1. Detecting a PR that was merged or closed outside the factory

### Which bundles are watched

The core watches every bundle that has a PR (`delivery.kind === "pr"`) and is not `MERGED` or `CANCELLED`. This covers every non-terminal state and `FAILED`.

- A bundle that pushed to `main` (a new repo) has no PR and is not watched.
- `AWAITING_CI` and `AWAITING_MERGE` keep their existing in-task polling, which already handles this. The new watcher covers every other state.

### How often

- The core checks the PR state of each watched bundle on a background interval: once a minute in production, and the `ciPollMs` interval (`--ci-poll-ms`) in tests and the dry run.
- It also checks once at startup, after resume.
- Checks run one bundle at a time.
- A failed `prState` call is logged and retried on the next tick. It never fails the bundle.

### When the PR was merged on GitHub

The bundle becomes `MERGED` exactly as if the factory had merged it. That means the same final transition (`toFinal(…, "MERGED")`):

- every member run goes to `DELIVERED`, with the bundle's PR as its delivery;
- the runs show in Done with the PR link and the bundle chip;
- the usual events are emitted (`bundle.state`, `run.state`);
- the full cleanup of the bundle's own things runs (§8.1).

It also does the following:

- **Notice.** The bundle gets the notice "The PR was merged on GitHub (while <state>)".
- **Open asks.** Any pending ask (an escalation or the merge card) is dropped.
- **A live task** (a non-terminal state): the core first commits a durable marker on the BundleDoc, `externalEnd: { how: "merged" | "closed", at }`. Then it aborts the task, which stops any running integrator, reviewer or QA agent. The task's abort path finishes as `MERGED` when the marker says merged, and **does not close the PR**. If the factory is killed between the commit and the abort, the resumed task sees the marker and finishes the same way.
- **A `FAILED` bundle** (its task has ended): the core makes the transition itself in one commit, as `cancelBundle` does for a failed bundle, then cleans up in the background.

### When the PR was closed without merging

The bundle becomes `CANCELLED` and its members go back to plain `READY`. This is the existing behaviour, now applied in every watched state, with the reason "the PR was closed without merging". The same marker, abort and `FAILED` paths apply.

### Merged is only recorded on GitHub's word

`MERGED` is only ever recorded when GitHub reports the PR as merged. There is no way to mark a bundle merged by hand.

### New core operation: `checkBundlePr`

```ts
/** Ask GitHub now for the bundle's PR state and act on it as the watcher would. */
checkBundlePr(bundle: BundleId): Promise<{ pr: "open" | "merged" | "closed"; state: BundleState }>;
```

- It is added to `CORE_OPS` and served as `POST /api/op/checkBundlePr`.
- `not_found`: the bundle is unknown.
- `conflict`: the bundle has no PR, or is already `MERGED` or `CANCELLED`.
- An `open` PR changes nothing.
- `state` is the bundle's state after the call. For a live task, `state` may still be the old state for a moment while the abort completes.

## 2. Cancelling bundled tickets in bulk (`cancelRuns` extended)

`cancelRuns(runs, reason?)` now also accepts runs that sit in an active bundle, including a `FAILED` bundle. All the other rules of the operation stay as they are: all or nothing, `invalid` / `not_found`, `conflict` for terminal runs, one `cancelReason` commit, the cancellation path of each run, and `{ cancelled }` as the result.

### The whole bundle or nothing

If the call includes any member of an active bundle, it must include **every** member of that bundle. Otherwise the call is refused with `conflict`, naming the bundle and the members that are missing. Nothing changes. (A bundle cannot drop tickets in the middle of a step, so a partial selection is refused rather than guessed at.)

### Effect on each such bundle

- **The bundle is cancelled** as by `cancelBundle`: its PR is closed and its members are released. A live task is aborted. A `FAILED` bundle is handled directly.
- **Then its members are cancelled** like the other runs in the call, and land in Done as `CANCELLED`.
- **Order and durability.** The intent is recorded before anything is aborted: in one commit, `cancelReason` is set on every run and on every affected bundle. A `kill -9` at any point after that commit ends with every bundle cancelled and every listed run `CANCELLED`, finished on resume.
- **Reason.** The reason is the call's `reason`, or `cancelled by <interface>`.

### Unchanged

The single-run `cancelRun` keeps refusing a bundled run ("drop it from the bundle or cancel the bundle first"). `clearRuns` is unchanged and only clears terminal runs. Bundle operations (`cancelBundle`, `dropFromBundle`, …) are unchanged.

## 3. Web UI

### Select mode in Shipping

In select mode, every bundle card in Shipping gets a checkbox. Ticking it selects the bundle, which means all of its member tickets. This applies to bundles in any state on the board, `FAILED` included.

- Member tickets cannot be ticked one by one, so the UI can only produce valid `cancelRuns` calls.
- The Shipping column's "select all" checkbox also covers the bundle cards it shows. The filters apply, as in other columns.
- So every card on the board can now be selected: runs in every column, legacy run cards, and bundles.

### The action bar

- **"N selected"** counts tickets. A selected bundle counts as its members.
- **Cancel K** includes the members of the selected bundles. One click arms it and a second click confirms (as today), calling `cancelRuns` once with all of those ids.
- **Bundle warning.** When the selection includes bundles, the confirming text says so, e.g. "Click again to cancel 5 (closes the PR of bundle-3)".
- **Clear M** is unchanged: it applies to terminal runs that are not cleared.
- **After cancelling.** The cancelled tickets move to Done as Cancelled, where they are visible with "Show closed" and can be selected and cleared. A refused call shows the error toast and changes nothing.

### The Ready column's ship checkboxes

They are unchanged outside select mode. In select mode they become selection checkboxes and **Ship N tickets** stays hidden, as today.

### The bundle view

- A **Check PR now** button shows next to the PR link while the bundle has a PR and is not `MERGED` or `CANCELLED` (`FAILED` and `ESCALATED` included). It calls `checkBundlePr` and shows a toast: "PR #12 is still open", "PR #12 was merged on GitHub — the bundle is Merged", or "PR #12 was closed — the tickets are back in Ready".
- The view updates live through `bundle.state`.
- **Cancel bundle** is unchanged.

## Documentation

- **`docs/spec.md`:**
  - §2 and §8: the PR watcher and the `externalEnd` marker.
  - §5: `checkBundlePr` and the extended `cancelRuns`.
  - §9: the Shipping column's select mode and **Check PR now**.
  - Acceptance behaviours 10 and 21 updated to match.
- **`README.md`:** the Web UI section.
- **`docs/architecture.md`:** the watcher and the new operation.
- **`DEVIATIONS.md`:** an entry only if the build departs from this spec.

## Tests

All tests use the fake GitHub (`LocalGitHubHost`) and scripted agents.

**PR merged on the fake host:**

- Merging the PR while the bundle is `ESCALATED`, `FIXING` (integrator mid-turn) or `FAILED` ends it `MERGED`: members `DELIVERED` with the PR, the PR not closed by the factory, cleanup done.
- Closing the PR in those states ends it `CANCELLED` with members back in `READY`.
- A `kill -9` after the marker commit finishes the bundle correctly on resume.

**`checkBundlePr`:**

- `open` changes nothing.
- `merged` / `closed` act as described.
- `conflict` for a bundle with no PR or one already `MERGED`.

**`cancelRuns` with bundle members:**

- Every member of a bundle (live or `FAILED`), mixed with ordinary runs, gives the bundle `CANCELLED` with its PR closed and every listed run `CANCELLED`.
- A subset of a bundle's members is `conflict` naming the missing ones, and nothing changes.

**jsdom board tests:**

- Bundle cards get checkboxes in select mode.
- Counts include members.
- The confirmation names the bundle.
- The Shipping column's "select all" includes bundles.

## Acceptance behaviours

1. A bundle hits the CI fix cap and is **Escalated**. After its PR is merged directly on GitHub, the bundle becomes **Merged** within about a minute, with no click. Its tickets show in **Done** with the PR link and bundle chip, and the bundle card leaves Shipping.
2. A **Failed** bundle whose PR is then merged on GitHub also becomes Merged, and its tickets move to Done.
3. If the PR is merged on GitHub while the integrator is fixing, the integrator stops, the bundle becomes Merged, and the factory does not close the PR.
4. Closing (not merging) the PR of an Escalated bundle on GitHub cancels the bundle and puts its tickets back in **Ready**.
5. **Check PR now** in the bundle view of a bundle whose PR is still open says "still open" and changes nothing. Right after a manual merge on GitHub, it moves the bundle to Merged at once.
6. With **Select** on, a bundle card in Shipping has a checkbox. Ticking it shows "N selected" counting its tickets. **Cancel N** asks for a second click that mentions closing the bundle's PR, then closes the PR, and the tickets appear as Cancelled in Done (with "Show closed"). There they can be selected and removed with **Clear M**.
7. A selection mixing a Planning ticket, a Done ticket and a Shipping bundle shows **Cancel K** (the live ticket plus the bundle's tickets) and **Clear 1**. Each acts only on its own subset.
8. `POST /api/op/cancelRuns` with only one of a two-ticket bundle's runs returns 409 naming the bundle and the missing ticket, and nothing is cancelled.
9. Killing the factory (`kill -9`) right after a bulk cancel that includes a bundle, then starting it again, ends with the bundle Cancelled and all of its tickets Cancelled.
10. Outside select mode, the Ready column's ship checkboxes and **Ship N tickets**, the bundle view's **Cancel bundle**, and the run view's **Cancel run** (still refused for a bundled ticket) behave as before.