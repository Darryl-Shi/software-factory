# Discussions as a full-screen chat behind a button next to Create

## Context

Today discussions (see `docs/superpowers/specs/2026-10-11-discussion-flow-design.md` and README "Web UI") have their own
**Discussions** tab in the top bar. The tab has a list, filters, and a **New discussion** modal that asks for the
project, a title, the model (free text), the thinking level and a first message. The discussion view reuses the run
view's sheet.

This change removes the tab and the modal. Starting or resuming a discussion becomes like opening a full-screen chat
app: one click on a button next to **Create**, then dropdowns at the top to pick the project and the model, and you
type. The discussion model is unchanged: the discussion Task, its states, turns, drafts, `submit_tickets`, the
handoff to runs, durability and pinning. Only a few small core additions are needed (below).

## What changes for the user

### Entry point
- The top bar's **Discussions** tab (`data-view="discussions"`) is removed, along with the Discussions list view
  (`#view-discussions`) and the New discussion modal. The nav keeps **Board** and **Settings**.
- A new **Chat** button with a chat icon sits right next to **Create** in the top bar, styled as a secondary button
  next to the primary Create. Clicking it opens the full-screen chat view:
  - on the discussion you had open last in this browser session, if it still exists;
  - otherwise on a blank **new chat**.

### The full-screen chat view
It is still the run view's full-screen sheet (`#runview`, `data-mode="discussion"`) with the same open/close
animation, and **Esc** or the close button still returns to the board. The layout is:

- **Top bar of the chat:**
  - **Project dropdown:** the existing projects (`name · repo`), plus **New project…**, which shows inline name and
    repo fields like Create does. The project is created with `createProject` when the first message is sent.
  - **Model dropdown:** the models the factory can use (from the new `listModels` op, below).
  - **Thinking dropdown:** a compact selector for the thinking levels.
  - The total cost, a **Draft tickets** button, and a small overflow menu (⋯) holding **Close discussion** (or
    **Reopen** / **Retry**, depending on state).
  - No title field, no pipeline strip, no timeline, no state lozenge as the main element. State is shown only when
    it matters: Preparing, Closed or Failed, inline near the composer.
- **Left rail: history (collapsible).**
  - A **New chat** entry at the top.
  - Under it, the discussions of the project selected in the top project dropdown, newest `updatedAt` first, each
    showing its title, when it was last active, and a live dot while a turn runs. Closed discussions appear muted.
    Failed ones show a small failed marker.
  - Clicking one opens it in place, with no animation back to the board.
  - The rail collapses to a toggle button. On narrow screens it is a drawer, like the run view's threads rail.
- **Centre:** the transcript, with the same renderer, tool rows, streaming, turn-cost margins and notice rows as
  today, and the composer at the bottom (send; **Stop** while a turn runs; Enter sends, Shift+Enter adds a new line).
- **Right: drafts panel.** It uses the existing details slot and is hidden until it is needed. It opens when you
  press **Draft tickets** in the top bar, while a draft turn runs, or when the discussion has drafts. Its content and
  behaviour are unchanged: optional instructions, Draft/Redraft with the "This replaces N drafts" confirmation, the
  summary, editable draft cards, Delete, **Create ticket**, and the links to runs. The "Discussion" metadata section
  (id, workspace path, …) is kept at the bottom of the panel.

### New chat (blank state)
- The transcript area shows a short centred hint: the model reads the repo and searches the web but can't change
  anything, and you can ask it for draft tickets. The composer has focus.
- **Project dropdown default:** the board's current project filter if one is set; otherwise the project of the most
  recently active discussion; otherwise the first project. With no projects at all, **New project…** is preselected.
- **Model and thinking defaults:** the selected project's effective `discussion.model` (which still falls back to the
  architect's model), re-prefilled when the project changes unless you already touched the model or thinking
  dropdowns.
- **Sending the first message** calls `startDiscussion(project, { message, model })` with no title (see core
  changes). The view switches to that discussion, which appears at the top of the history rail.

### Locking (decided: no mid-chat switching)
- Once a discussion exists (after the first message), its project, model and thinking dropdowns show its pinned
  values and are disabled, with the tooltip "Fixed for this chat; start a new chat to change it". This matches the
  core, which pins both at start.
- To use another model or project, you press **New chat**. Changing the dropdowns of the blank new chat changes the
  rail's project filter to match.

### Closed and failed discussions
- **Close discussion** moves into the overflow menu. Reopen and Retry stay where they are today, in the composer
  area's status box, and are also available in the overflow menu.

### Elsewhere
- **"From discussion: <title>" link** in a run's ticket details: it opens the chat view on that discussion.
- **Board cards' discussion marker:** unchanged.
- **URL:** a discussion keeps its `#disc=<id>` hash route, so it can be linked and survives a reload. A blank new
  chat uses `#chat`, so a reload reopens the chat view on a blank new chat. The old `#view=discussions`-style boot,
  if any exists, falls back to the board.
- **Toasts:** "Draft tickets are ready in …" and "The discussion … failed" behave as before when the chat view isn't
  showing that discussion. A toast for another discussion's drafts can be clicked to open that discussion.

## Core changes (small, additive)

1. **`startDiscussion`'s `title` becomes optional.**
   - When it is missing or blank, the core derives it from the first message: the first non-empty line, with
     whitespace collapsed and markdown heading/bullet markers stripped, cut to 60 characters on a word boundary,
     with `…` appended when cut.
   - An explicit title is still accepted and used as is.
   - An empty first message is still refused with `invalid`.
2. **New read-only op `listModels()`** is added to `FactoryCore` and `CORE_OPS`, so the web server exposes it with no
   change of its own.
   - It returns `{ id: "provider/modelId", name?: string, provider: string }[]`: the models the model host reports as
     available, meaning the ones with credentials (the same source `factory setup roles` uses, `models.getAvailable()`).
   - It needs no project and has no side effects.
   - The UI always also shows the project's effective `discussion.model` in the dropdown, marked "(default)". If
     that model isn't in the list, it is still shown, so the default is selectable and the core's existing
     validation at `startDiscussion` decides.
   - If the list is empty, or the call fails, the model control falls back to today's free-text field.
3. **Nothing else changes in the core:** pinning, states, operations, refusals, events, durability and the
   `discussion.model` setting.

## Removed
- `#view-discussions`, its project filter, its "Show closed" chip and its list rendering, the New discussion modal, and
  the 60-second list re-render timer.
- The Discussions tab button and its keyboard and boot handling.

## Docs and tests
- **Docs:**
  - README "Web UI": replace the Discussions bullet with the Chat button and the full-screen chat (history rail,
    project/model/thinking dropdowns locked after the first message, drafts panel).
  - Add an amendment note at the top of the discussion design doc describing this change (§3 Web UI superseded).
  - Document `listModels` and the optional title wherever the ops are listed (`docs/architecture.md` if it lists
    them).
- **Tests:**
  - `test/discussion.test.ts`: the derived title (a long first line is cut with `…`, markdown markers are stripped,
    an explicit title is kept, a blank title is derived).
  - `test/web.test.ts`: `listModels` over HTTP, and `startDiscussion` without a title.
  - The existing suites keep passing.
  - `npm test` and `npm run typecheck` pass.
- **Dry run:** `scripts/dry-run.ts` keeps its discussion step. It may pass a title or not, but it must still pass.

## Acceptance behaviours
1. The top bar shows **Board** and **Settings** only, with no Discussions tab, and a **Chat** button directly next to
   **Create**.
2. Clicking **Chat** with no prior discussion in the session opens a full-screen view with a project dropdown, a
   model dropdown and a thinking dropdown at the top, an empty transcript with a short hint, a focused composer, and a
   history rail with **New chat**. No modal and no title field appear.
3. The model dropdown lists the models the factory has credentials for, and preselects the selected project's
   effective `discussion.model`. Changing the project re-prefills the model unless it was changed by hand.
4. Typing a first message and pressing Enter starts a discussion on the selected project and model. The model's reply
   streams into the transcript, the discussion appears at the top of the history rail with a title taken from the
   first line of the message, and the URL becomes `#disc=<id>`.
5. After the first message, the project, model and thinking dropdowns show the pinned values and can't be changed.
   **New chat** gives a blank chat where they can be changed again.
6. Clicking an earlier discussion in the history rail opens its transcript in place. Picking another project in a
   new chat's dropdown changes which discussions the rail lists.
7. Choosing **New project…** in the dropdown, filling in a name and repo, and sending a message creates the project
   and starts the discussion on it.
8. While the model replies, the send button is **Stop**, and pressing it ends the turn with a "Turn stopped" notice.
9. **Draft tickets** opens the drafts panel. After the model submits, the summary and editable drafts appear, and
   **Create ticket** puts a run on the board whose ticket details show "From discussion: <title>". Clicking that link
   opens the chat view on the discussion.
10. **Close discussion** from the overflow menu makes the composer show the Closed status with **Reopen**. The
    discussion stays in the rail, muted.
11. Reloading the page on `#disc=<id>` reopens that chat, and reloading on `#chat` reopens a blank new chat. **Esc**
    returns to the board.
12. `startDiscussion` called over HTTP without a title succeeds and returns a discussion whose title is derived from
    the message. `listModels` over HTTP returns the available models.
