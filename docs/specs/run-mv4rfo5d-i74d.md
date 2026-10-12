# Chat: the composer stays after every reply (continuous discussion)

Run `run-mv4rfo5d-i74d`. This is an incremental change to the software factory. The change spec lives at `docs/specs/run-mv4rfo5d-i74d.md`. The builder also updates the **Chat** bullet in `docs/spec.md` §UI to describe the invariant below.

## Problem

In the full-screen **Chat** (the discussant chat behind the Chat button, `src/web/ui/discussions.js`), the human sends a message and the discussant replies. Once the reply is done, the whole input box (the composer) is gone, so the chat cannot go on. Users get about one exchange.

The core is not the cause. A discussion stays `OPEN` after a `say` turn, `turn` is cleared, and further `say` calls work. I checked this through the HTTP API with scripted agents: turn 1 and turn 2 both completed and the discussion stayed `OPEN`. The UI also re-renders the composer ("Your turn") in the DOM after each turn. I checked this under jsdom against a live scripted factory.

The cause is layout:

- `.rv-center` is a 3-row grid: `auto` (conversation header), `minmax(0, 1fr)` (transcript), `auto` (composer).
- The "Move discussion" change hides `.conv-head` in chat mode with `.runview[data-mode="discussion"] … .conv-head { display: none }`.
- A `display: none` element is not a grid item, so the remaining children shift up one row each:
  - the transcript (`.tx-wrap`) lands in the content-sized `auto` row;
  - the composer (`#composer-wrap`) lands in the `minmax(0, 1fr)` row.
- When the transcript (first message + reply) gets taller than the sheet, it grows instead of scrolling. The composer's row shrinks to zero and the composer is pushed below the viewport.

Short scripted replies hide the bug. Real replies trigger it on the first exchange.

## The change

**Behaviour: the chat is continuous.** In the chat view, the composer is always visible, pinned to the bottom of the sheet, whatever the length of the transcript. The transcript area alone scrolls (its scroll-to-bottom and **New activity** jump behaviour stay as they are). This holds in every composer state:
- blank new chat;
- Preparing;
- replying or drafting (input disabled or Stop button, as today);
- Your turn;
- Closed (the Reopen box);
- Failed (the Retry box).

A discussion ends only when the human closes it (⋯ → **Close discussion**) or it fails. Nothing in the UI or the core ends it after a reply.

**Key technical decisions**

- **UI-only fix, in CSS (`src/web/ui/app.css`).**
  - The chat view's grid must place the transcript in the flexible row and the composer in the last row, even though the conversation header is hidden. Either give the rows explicit placement (`grid-row`) or override `grid-template-rows` for `[data-mode="discussion"]`. Do not rely on implicit auto-placement around a hidden item.
  - The transcript container must keep a definite, viewport-bounded height so that `.transcript` scrolls (`overflow-y: auto`) instead of growing.
- **No core, API, event or Document changes.** `say`, `stopTurn`, turn handling, the Stop button during a running turn and its notices behave exactly as today.
- **The run view and the bundle view are unchanged.** They show the conversation header, and their composer and dock must still sit where they do today. The fix must not regress them.
- **All breakpoints.** The fix holds at the wide, ≤1180px and ≤760px layouts. It also holds with the history rail collapsed or expanded, and with the drafts panel open or closed.
- **Regression test.** Add a test in the existing web test suite (`test/web.test.ts` style, no browser needed) that pins the invariant in the served stylesheet. In chat mode, the transcript wrapper and the composer wrapper have explicit row placement, or an explicit row template, that does not depend on the hidden `.conv-head`. Never weaken existing tests.

Out of scope: changing the discussant's prompt, the scripted agents, the core's turn model, or the run's architecture discussion (DISCUSSING).

## Acceptance behaviours

1. Start the factory with `scripts/run.sh` and open **Chat**. Send a long first message (e.g. 80+ lines). After the discussant's reply, the composer is visible at the bottom of the screen with "Your turn". The transcript above it scrolls.
2. In the same chat, send three more messages one after another. After each reply, the composer is still visible at the bottom and accepts the next message. The transcript shows every turn with its cost line.
3. While a reply is being produced, the composer stays visible at the bottom with the Stop button. When the reply ends, it returns to the send state without reloading the page.
4. Resize the window to ≤1180px and to ≤760px (mobile width) with a long transcript, with the drafts panel open and closed and the history rail collapsed. The composer is always visible at the bottom of the sheet.
5. Close the discussion from the ⋯ menu with a long transcript: the "Closed … Reopen" box is visible at the bottom. Reopen it: the input composer is visible again and messages can be sent.
6. Open a run with a long architect or builder transcript, and a bundle view: the conversation header, the transcript, the floating dock and the composer appear as before.
7. `npm test` passes, including the new test that fails against the previous stylesheet.
