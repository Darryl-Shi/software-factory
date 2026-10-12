# Spec: deleting and managing tickets at any stage, one at a time or in bulk

## Context

The software factory (`swf`, repo `Darryl-Shi/software-factory`) already lets the user manage tickets in a few ways:

- **Cancel a live run** from its run view (`cancelRun`). This is refused for a run in an active bundle.
- **Clear a finished run** (`DELIVERED`, `FAILED` or `CANCELLED`) from the board, either from its run view or with **Clear all** in the Done column (`clearRuns`, spec `docs/specs/run-mv46ek2u-7omz.md`). Clearing is a soft archive: it sets `cleared` on the run's Document and deletes nothing.
- **Retry** a failed or cancelled run (`retryRun`).

What is missing:

- There is no way to get rid of a ticket that is still in progress in one step: today you cancel it, then clear it.
- There is no bulk action outside the Done column.

In practice the user kills tickets early, in **Planning** or **Build & Review**, when they realise the ticket doesn't work. After that it is mostly "stop and archive". At the end of the journey, the user drops an unwanted ticket simply by not shipping or merging it, and the existing bundle controls (Drop tickets, Cancel bundle) already cover that.

## Decision: "Delete" = stop + archive, nothing is destroyed

Deleting a ticket works the same way at every stage:

- **A live run** is stopped. Its task is aborted exactly as `cancelRun` does it: the run goes to `CANCELLED` with its final notice, and its environments and QA VM are disposed. It is also archived (`cleared`).
- **A terminal run** is only archived, which is the same as `clearRuns`.
- **Nothing is purged.** The Document, the conversations, the screenshots, the worktree and the local and remote branches all stay. Ticket keys stay stable, and a `#run=` link still opens the run read-only, marked cleared. There is no undelete and no hard purge.
- **Runs in an active bundle are refused**, including a bundle that is `FAILED`. The message is the same one `cancelRun` gives today: "run … is in bundle-N; drop it from the bundle or cancel the bundle first". The bundle's own controls stay the way to drop tickets late. Bundles are not deleted or archived by this change.
- **Legacy runs** that are still delivering the old way behave exactly as `cancelRun` treats them today.

## Core (`src/core/`)

### New operation

`FactoryCore` gains one operation. It is also added to `CORE_OPS`, so the web UI calls it through `POST /api/op/deleteRuns`:

```ts
/** Stop (if live) and archive runs at any stage; nothing is deleted from disk, storage or GitHub. */
deleteRuns(runs: RunId[], reason?: string): Promise<{ deleted: RunId[]; stopped: RunId[] }>;
```

**Validation is all or nothing.** The whole call is checked first:

- An empty list, a non-array, or an id that is not a non-empty string is `invalid`.
- Duplicate ids are collapsed.
- An unknown id is `not_found`.
- A run in an active bundle is `conflict`, and the message names the run and the bundle.

**Application:**

- **One commit.** In a single commit, every selected run that is not already cleared gets `cleared: { at, by }`. Each live run (non-terminal) also gets `cancelReason`: the given `reason`, or `deleted by <interface>`.
- **Aborting after the commit.** After the commit, the core aborts the task of each live run. The run task's existing cancellation path takes the run to `CANCELLED`. The `cleared` flag must survive that path: the final transition must not drop it.
- **Captured interface.** `by` is captured before the first await, as `cancelRun` and `clearRuns` do.

**The result:**

- `deleted` lists the runs newly archived.
- `stopped` lists the subset that were live and are being aborted.
- Runs that were already cleared are skipped silently, so the call is idempotent.

**Events:**

- Each newly archived run emits the existing `run.cleared` event.
- Each stopped run then emits its `run.state` to `CANCELLED` as usual.

**A run whose task is still finishing.** If a run is already terminal but its task is still finishing, it is only archived.

**Deleted runs afterwards:**

- They follow every existing rule for cleared runs: `listRuns` hides them unless `includeCleared`, `getRun` returns them, and `retryRun` refuses them with `conflict`.
- `message` and `answer` on a deleted run that is still being aborted may be refused as they would be for a cancelled run. No new behaviour is needed.
- Discussions keep listing runs created from their drafts.

### Unchanged

`cancelRun`, `clearRuns`, `retryRun`, the bundle operations, startup sweeps and the QA VM cleanup are unchanged.

## Web UI (`src/web/ui/`)

### Individual: run view

- **Delete ticket button.** Every run that is not cleared and not in an active bundle shows **Delete ticket** in its action area. This applies at every stage, including Planning, Build & Review, Ready, Done and legacy delivery.
  - It needs two clicks, following the existing "Click again to …" pattern.
  - For a live run the confirmation says it will stop the agent ("Click again to stop and delete").
  - It calls `deleteRuns([id])`.
- **Replaces "Clear from board".** For terminal runs, Delete ticket replaces the existing **Clear from board** button.
- **Cancel run stays.** It is the way to stop a ticket while keeping it on the board (under "Show closed").
- **After deleting,** the run view stays open and shows the run as cleared (when, and by which interface), read-only, with no Retry. It is the same view as today's cleared run.
- **Runs in an active bundle** show no Delete button. Instead a hint points to the bundle ("In bundle-N: drop it from the bundle or cancel the bundle").

### Bulk: select mode on the board

- **Select toggle.** A **Select** toggle in the board header turns select mode on and off. In select mode:
  - **Which cards get a checkbox.** Every run card in every column gets a checkbox: Planning, Build & Review, Ready, legacy run cards in Shipping, and Done.
  - **Bundle cards** get no checkbox. Runs inside an active bundle cannot be selected.
  - **Select all in a column.** Each column header gets a "select all in this column" checkbox. It acts on exactly the cards shown, so the project filter, the search box and "Show closed" apply.
  - **Across projects.** Selection may span projects and columns.
  - **The Ready column.** In select mode, the Ready column's ship checkboxes become selection checkboxes and **Ship N tickets** is hidden. Leaving select mode clears the selection and restores shipping.
- **Action bar.** While anything is selected, a sticky action bar shows "N selected" with these actions:
  - **Delete N**: two clicks. The confirmation says how many will be stopped, e.g. "Click again to delete 5 (3 will be stopped)". It calls `deleteRuns` once with the whole selection, so the action is all or nothing.
  - **Retry N**: shown only when every selected run is `FAILED` or `CANCELLED` and not cleared. It calls `retryRun` for each run and shows one summary toast ("3 retried" or "2 retried, 1 failed: <reason>").
  - **Clear selection.**
- **Errors.** An error from `deleteRuns` (for example a run that joined a bundle meanwhile) shows in the existing error toast, and nothing is deleted.
- **Live updates.**
  - Cards leave the board live in every open tab through `run.cleared`, with the existing card animation unless reduced motion is on.
  - A selected card that disappears, or that becomes unselectable (for example it joins a bundle), drops out of the selection, and the counts update.
- **Unchanged.** The Done column's **Clear all** stays as it is.

### HTTP

No new routes. `deleteRuns` goes through `/api/op/<op>`, with the existing auth, Host/Origin and content-type checks, and the usual status mapping (`invalid` 400, `not_found` 404, `conflict` 409).

## Documentation

- **`docs/spec.md`.** The builder updates the product spec: §5 (the operation), §3.2 (deleting a run at any stage), §9 (the run view's Delete ticket, the board's select mode and action bar).
- **`README.md`** (Web UI section) and **`docs/architecture.md`** (the new operation).
- **`DEVIATIONS.md`.** Add an entry only if the build departs from this spec.

## Tests

- **Core tests** for `deleteRuns`:
  - Validation: `invalid`, `not_found`, and `conflict` for an active-bundle member and for a member of a failed bundle.
  - All or nothing: nothing is cleared or stopped when any id is refused.
  - Idempotency.
  - A live run in `DISCUSSING` or `BUILDING` ends up `CANCELLED` with `cleared` set, its environments are disposed, and both survive a restart.
  - A terminal run is only cleared.
  - The `deleted`/`stopped` result.
  - The `run.cleared` event.
  - `retryRun` is refused afterwards.
- **A web test** of the op over HTTP.
- **jsdom board tests** in `test/web-board.test.ts`:
  - Select mode puts checkboxes on run cards in every column but not on bundle cards.
  - Column "select all" respects the filters.
  - The action bar counts are correct.
  - Ship is hidden in select mode.

## Acceptance behaviours

1. A ticket in **Planning** (the architect is asking a question) shows **Delete ticket** in its run view. Two clicks stop the architect, the card leaves the board, and the run view shows it as cancelled and cleared with no Retry.
2. A ticket in **Build & Review** with the builder working is deleted the same way. Its run ends `CANCELLED`, its sandbox environments (and any QA VM) are disposed, and its worktree and branch are still on disk.
3. Turning on **Select**, ticking two Planning cards, one Build & Review card and one Done card, and clicking **Delete 4** twice (the confirmation says 3 will be stopped) removes all four cards. The other cards keep their ticket keys.
4. With a project filter on, the column's "select all" checkbox selects only that project's cards in the column.
5. A run inside a bundle in Shipping cannot be selected and shows no Delete button. `POST /api/op/deleteRuns` with its id returns 409 naming the bundle, and no other id in that call is deleted or stopped.
6. `POST /api/op/deleteRuns` with an unknown id returns 404 and changes nothing. Calling it twice with the same ids succeeds both times, and the second call reports nothing newly deleted.
7. After `factory stop` and `factory serve`, deleted runs are still off the board and still `CANCELLED` (or their earlier terminal state). Their `#run=` links open them read-only, marked cleared.
8. With two tabs open, a bulk delete in one tab removes the cards from the other without a reload.
9. Selecting only failed or cancelled runs shows **Retry N**, and clicking it resumes them. When a live run is in the selection, Retry is not offered.
10. In select mode the Ready column shows no **Ship N tickets**. Leaving select mode brings back the ship checkboxes, and shipping works as before.
11. **Cancel run** in a run view still stops a ticket without archiving it, and the cancelled card stays visible under "Show closed".
