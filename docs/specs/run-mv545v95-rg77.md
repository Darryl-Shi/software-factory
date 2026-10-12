# Spec: cancel and clear tickets in bulk

## Context

The software factory (`swf`, repo `Darryl-Shi/software-factory`) already manages single tickets in two ways, and both stay exactly as they are:

- **Cancel run.** In a run view, `cancelRun` stops a live run: the task is aborted, the run goes to `CANCELLED`, and its environments and any QA VM are disposed. It is refused (`conflict`) for a run that is in an active bundle, including a `FAILED` bundle, with the message "drop it from the bundle or cancel the bundle first".
- **Clear from board.** In a run view, or with **Clear all** in the Done column, `clearRuns` soft-archives terminal runs (`DELIVERED`, `FAILED` or `CANCELLED`) off the board, as described in spec `docs/specs/run-mv46ek2u-7omz.md`. It sets `cleared` and deletes nothing. It is all or nothing and idempotent, and emits `run.cleared`.

What is missing is **bulk**. The user wants to cancel many live tickets at once, mostly early ones in Planning and Build & Review, and to clear many finished ones, from anywhere on the board. Tickets that are already in a bundle are still handled by the bundle's own controls (Drop tickets, Cancel bundle). This change adds no new kind of action, no delete or purge, and no change to what cancel or clear do to a single run.

## Core (`src/core/`)

### New operation: `cancelRuns`

`FactoryCore` gains a bulk counterpart to `cancelRun`. It is added to `CORE_OPS` and served as `POST /api/op/cancelRuns`:

```ts
/** Cancel several live runs at once; same effect per run as cancelRun. */
cancelRuns(runs: RunId[], reason?: string): Promise<{ cancelled: RunId[] }>;
```

**All or nothing.** The core checks the whole call before it changes anything:

- **`invalid`:** an empty list, a non-array, or an id that is not a non-empty string. Duplicate ids are collapsed.
- **`not_found`:** an unknown id.
- **`conflict`:** a run that is already terminal, or a run in an active bundle. The message names the run, and also its state or its bundle.

**Applying it:**

- **One commit, then the aborts.** One commit sets `cancelReason` on every run: the given `reason`, or `cancelled by <interface>`. After that commit, the core aborts each run's task. Each run then reaches `CANCELLED` through the run task's existing cancellation path, with its final notice, its environments and QA VM disposed, and its `run.state` event.
- **Who cancelled.** `by` is captured before the first await, as `cancelRun` does.
- **The result.** `cancelled` lists the runs whose tasks were aborted.

### Unchanged operations

- `cancelRun`, `clearRuns`, `retryRun` and every bundle operation are unchanged. `clearRuns` already takes a list, so bulk clear uses it as is.

## Web UI (`src/web/ui/`)

### Select mode on the board

A **Select** toggle in the board header turns select mode on and off.

**Which cards are selectable:**

- Every run card in every column gets a checkbox: Planning, Build & Review, Ready, the legacy run cards in Shipping, and Done.
- Bundle cards get no checkbox, and runs inside an active bundle cannot be selected.

**Selecting a whole column:**

- Each column header gets a "select all in this column" checkbox.
- It acts on exactly the cards that column shows, so the project filter, the search box and "Show closed" all apply.
- A selection may span projects and columns.

**The Ready column:**

- In select mode, the Ready column's ship checkboxes become selection checkboxes, and **Ship N tickets** is hidden.
- Leaving select mode clears the selection and restores shipping exactly as before.

### The action bar

While anything is selected, a sticky action bar shows "N selected", along with:

- **Cancel K:** K is the number of selected runs that are live (not terminal).
  - It is shown only when K ≥ 1, and it acts on those K runs only.
  - It takes two clicks: "Click again to cancel K". This follows the existing confirmation pattern.
  - It calls `cancelRuns` once.
- **Clear M:** M is the number of selected runs that are terminal and not yet cleared.
  - It is shown only when M ≥ 1, and it acts on those M runs only.
  - It takes two clicks: "Click again to clear M".
  - It calls `clearRuns` once.
- **Clear selection.**

**After an action:**

- Runs that were acted on drop out of the selection.
- Cancelled runs move to Done. They are visible there under "Show closed", so they can be selected and cleared next.

**Errors:**

- An error from either operation shows in the existing error toast, and nothing is changed. This covers, for example, a run that joined a bundle or finished in the meantime.

**Live updates:**

- Cards move or leave live in every open tab through the existing `run.state` and `run.cleared` events.
- A selected card that disappears, or becomes unselectable, drops out of the selection, and the counts update.

### What stays the same

- The run view's **Cancel run** and **Clear from board** buttons.
- The Done column's **Clear all**.
- The bundle view's controls.

### HTTP

- There are no new routes. `cancelRuns` goes through `/api/op/<op>`.
- It gets the existing auth, Host/Origin and content-type checks.
- It uses the usual status mapping: `invalid` 400, `not_found` 404, `conflict` 409.

## Documentation

- **`docs/spec.md`:** in §5, the `cancelRuns` operation; in §9, the board's select mode and action bar.
- **`README.md`:** the Web UI section.
- **`docs/architecture.md`:** the new operation.
- **`DEVIATIONS.md`:** an entry only if the build departs from this spec.

## Tests

**Core tests for `cancelRuns`:**

- Validation: `invalid`, `not_found`, and `conflict` for a terminal run, for a member of an active bundle and for a member of a failed bundle.
- All or nothing: no run is cancelled when any id is refused.
- Runs in `DISCUSSING` and `BUILDING` end up `CANCELLED`, with their environments disposed.
- The result and the events.

**Over HTTP:**

- A web test of the operation.

**jsdom board tests (`test/web-board.test.ts`):**

- Select mode puts checkboxes on run cards in every column, but not on bundle cards or bundle members.
- A column's "select all" respects the filters.
- The Cancel K and Clear M counts are correct for a mixed selection.
- Ship is hidden in select mode.

## Acceptance behaviours

1. With **Select** on, ticking two Planning cards and one Build & Review card shows **Cancel 3**. Clicking it twice stops all three agents, and the cards move to Done (visible with "Show closed") as Cancelled.
2. With "Show closed" on, using the Done column's "select all" checkbox and then **Clear N** (two clicks) removes those cards from the board. The remaining cards keep their ticket keys.
3. A mixed selection of two live runs and three finished runs shows both **Cancel 2** and **Clear 3**, and each acts only on its own subset.
4. With a project filter on, a column's "select all" checkbox selects only that project's cards in that column.
5. A run inside a bundle in Shipping cannot be selected. `POST /api/op/cancelRuns` with its id returns 409 naming the bundle, and no other run in that call is cancelled.
6. `POST /api/op/cancelRuns` with an already-finished run's id, or an unknown id, returns 409 or 404 respectively, and changes nothing.
7. With two tabs open, a bulk cancel or clear in one tab updates the board in the other without a reload.
8. In select mode the Ready column shows no **Ship N tickets**. Leaving select mode brings back the ship checkboxes, and shipping works as before.
9. The run view's **Cancel run** and **Clear from board**, and the Done column's **Clear all**, behave exactly as before.
10. After `factory stop` and `factory serve`, bulk-cancelled runs are still Cancelled, and bulk-cleared runs are still off the board.
