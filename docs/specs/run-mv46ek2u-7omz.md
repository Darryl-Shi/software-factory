# Spec: clearing Done runs from the board

> **Superseded in part:** [`docs/specs/run-mv58bn4q-q2zs.md`](run-mv58bn4q-q2zs.md) reverses the "destroys nothing"
> decision below. Clearing still archives the run (record, conversations, screenshots and delivery stay), but it now
> also starts a full disk cleanup in the background: the worktree, manifest, local and remote branch, scratch dirs and
> environment records are deleted.

## Context

The software factory (`swf`, repo `Darryl-Shi/software-factory`) shows every run on a board in the web UI. Runs that end as `DELIVERED`, `FAILED` or `CANCELLED` (the `TERMINAL_STATES`) go to the **Done** column and stay there forever. `FAILED` and `CANCELLED` runs are shown only when the "closed" filter is on. As runs pile up, the Done column gets cluttered.

This change lets the user **clear** Done runs from the board, one at a time or all at once.

## Decision: clearing archives a run and destroys nothing

Clearing is a **soft archive**:
- The run's durable `RunDoc` gets a flag. Its record, conversations, QA screenshots, worktree and delivery all stay.
- Nothing is removed from `RunIndex`, Pi Durable storage or the disk.
- Clearing is **one-way** in the UI. There is no "unclear" action and no "show cleared" view on the board.
- A cleared run can still be opened through any direct link to it: a `#run=` deep link, or a discussion's link to the run a draft became. It then opens read-only, marked as cleared.

## Core (`src/core/`)

### Data
- `RunDocState` gains an optional `cleared?: { at: number; by: string }`. `by` is the calling interface, captured before the first await, as `cancelRun` and `retryRun` do.
- `RunView` gains the same optional `cleared` field (`toView` copies it).
- The flag is durable: it survives a factory restart.

### Operations
`FactoryCore` gains one operation, which is also added to `CORE_OPS` so the web UI can call it through `POST /api/op/clearRuns`:

```ts
/** Archive terminal runs: they leave the board and default listings; nothing is deleted. */
clearRuns(runs: RunId[]): Promise<{ cleared: RunId[] }>;
```

- The core checks the whole call first, then applies it in **one commit**. It is all or nothing:
  - An empty list or a non-array is refused with `invalid`.
  - An unknown run id is refused with `not_found`.
  - A run that is not in a terminal state is refused with `conflict`, with a message naming the run and its state.
- Runs that are already cleared are skipped. They are not an error and are not listed in `cleared`, so the call is idempotent.
- A run whose task is still finishing after reaching a terminal state may be cleared. Only the flag changes; the task is not touched.
- Each newly cleared run emits a new event, `{ type: "run.cleared"; run: RunId; project: string }`, added to the `FactoryEvent` union. Subscriptions filtered by `project` or `run` receive it, just as they receive `run.state`.

### Changes to existing operations
- **`listRuns(filter)`** leaves cleared runs out by default. A new filter field, `includeCleared?: boolean`, returns them as well.
- **`getRun`** still returns cleared runs, with `cleared` set.
- **`retryRun`** refuses a cleared run with `conflict` ("run … was cleared").
- **`getConversation`, `getScreenshot` and `message`** behave as they did before for cleared runs.
- **Discussions** still list runs created from their drafts, cleared or not (`DiscussionView.runs` and `Draft.runId` are unchanged).
- **Startup sweeps and the QA VM cleanup** are unaffected.

## Web UI (`src/web/ui/`)

### Board
- The board loads runs with `includeCleared: true`, so that **ticket keys (e.g. `SWF-3`) stay the same** after other runs are cleared. It never renders a cleared run as a card.
- Cleared runs are left out of every column, of the column counts, and of the "Your turn", "Active" and "Closed" counters.
- **"Clear all"** is a control in the Done column header.
  - It shows only when the Done column has at least one card.
  - It clears exactly the cards the Done column shows at that moment, so it respects the project filter, the search box and the closed toggle.
  - It needs a second click to confirm ("Click again to clear N"), following the existing "Click again to cancel" pattern. The confirmation resets if the user clicks elsewhere or the board re-renders with a different set.
- Errors from the operation appear in the existing error toast or notice.
- When a `run.cleared` event arrives over SSE, the card disappears live in every open tab, using the existing card animation unless reduced motion is on.

### Run view
- For a terminal run that is not yet cleared, the action area shows a **"Clear from board"** button next to "Retry run" or "Delivered runs are final". It also confirms on a second click.
- Clearing from the run view keeps the run view open. The view then shows that the run was cleared (when, and by which interface), and "Retry run" no longer appears.
- Opening a cleared run through a `#run=` link or a discussion's run link shows the same view: read-only, marked as cleared, with no Retry button.
- Live runs (non-terminal) never show a clear control.

### HTTP
- No new routes are needed. `clearRuns` goes through the generic `/api/op/<op>` endpoint, with the existing auth, origin and content-type checks and the usual status mapping (`invalid`→400, `not_found`→404, `conflict`→409, as `STATUS` defines).

## Documentation
- **`README.md` (Web UI section):** describe clearing, both one run and "Clear all".
- **`docs/architecture.md`:** list the new operation and the new event.
- **`docs/spec.md`:** the builder adds or updates it with this behaviour.
- **`DEVIATIONS.md`:** add an entry only if the build departs from this spec.

## Tests
- **Core tests:**
  - `clearRuns` validation: invalid, not_found, conflict, and all-or-nothing.
  - Idempotency.
  - `listRuns`, with and without `includeCleared`.
  - `retryRun` refused for a cleared run.
  - The `run.cleared` event.
  - The flag survives a restart.
- **Web tests:** the op over HTTP.

## Acceptance behaviours
1. With a DELIVERED run on the board, opening it and clicking "Clear from board" twice removes its card from the Done column. The Done count drops by one, and the run view now says the run was cleared.
2. With several runs in the Done column and the closed filter on (so FAILED and CANCELLED runs show too), clicking "Clear all" twice empties the Done column. Runs in other columns are untouched.
3. With a project filter on, "Clear all" clears only that project's Done runs. Switching to "All projects" shows the other projects' Done runs still there.
4. With the closed filter off, "Clear all" clears only the DELIVERED cards shown. Turning the closed filter on afterwards shows the FAILED and CANCELLED runs still there.
5. A run that is still in progress shows no clear control. Calling `POST /api/op/clearRuns` with its id returns 409, and nothing is cleared, even if other ids in the same call are terminal.
6. After clearing, the remaining cards keep their ticket keys (e.g. `SWF-4` is still `SWF-4`).
7. With two browser tabs open on the board, clearing a run in one tab removes its card from the other without a reload.
8. A cleared run is still on the board's Done column after the factory restarts? No: after `factory stop` and `factory serve`, cleared runs are still absent from the board.
9. Opening a cleared run through its `#run=` link, or from the discussion it came from, shows its transcript and timeline, marked as cleared, with no Retry button. `POST /api/op/retryRun` for it returns 409.
10. `listRuns` over HTTP leaves cleared runs out by default and includes them with `{ includeCleared: true }`. Each cleared run has its `cleared` field set.
