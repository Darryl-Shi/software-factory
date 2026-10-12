# UI touch-up: a five-column board, comfortable sizing, no overlapping text

An incremental change to the factory's web UI (`src/web/ui/`). The core, the operations, the events and the run, bundle and discussion flows stay as they are. This change only affects how the UI lays out and labels what it already shows. When it's done, the builder updates `docs/spec.md` §9 (the Board bullets) and acceptance behaviour 3, which names the "Deliver" column, so they match.

## 1. Problem

- The board has 8 columns, each `flex: 1 0 184px` and capped at 320px. On a laptop they squeeze to about 170–190px.
- At that width the card footer (key, project chip, bundle chip, round chips, cost and age, avatar) overflows its grid cell. Card text then draws over neighbouring text.
- The mono "raw states" line under each column name (`RECEIVED · PREPARING`, …) is jargon, and it gets cut off.
- The top bar, the board header and some run view headers don't scale cleanly between phone, tablet, laptop and wide screens.

## 2. The board: five wider columns

The 8 columns become 5. Each card keeps showing its exact stage as the state lozenge, which already exists.

| Column (key) | Runs in it | Bundles |
|---|---|---|
| **Planning** (`planning`) | `RECEIVED`, `PREPARING`, `DISCUSSING`, `SPEC_READY`, `AWAITING_APPROVAL` with gate `spec` | — |
| **Build & Review** (`build`) | `BUILDING`, `REVIEWING`, `ESCALATED` from building or reviewing (or with no `from`) | — |
| **Ready** (`ready`) | `READY` and in no active bundle | — |
| **Shipping** (`shipping`) | `AWAITING_APPROVAL` with gate `delivery`, `DELIVERING`, `AWAITING_CI`, `ESCALATED` from `AWAITING_CI` (legacy runs) and any other non-terminal state not listed above. A `READY` run in an active bundle is drawn inside its bundle card, as today | every bundle on the board (not `MERGED` or `CANCELLED`) |
| **Done** (`done`) | `DELIVERED`. With **Show closed** on, also `FAILED` and `CANCELLED` (same filter rule as today) | — |

- **Order inside a column:** cards that need the human ("Your turn") come first. Then cards go in pipeline order of their stage (for example, in Planning: received/preparing, then discussing/spec ready, then spec approval). Within the same stage, the oldest comes first. Done keeps "most recently updated first". Bundle cards in Shipping come before plain run cards, as today.
- **Column header:** the name, the count and any action that exists today. **Ship N tickets** stays in Ready and **Clear all** (two clicks) stays in Done, with the same behaviour and the same scope rules (project filter, search, Show closed).
  - Under the name, the raw state line is replaced by a short plain-language hint. Suggested wording:
    - Planning: "Specifying with the architect"
    - Build & Review: "Being built and reviewed"
    - Ready: "Reviewed. Tick tickets of one project, then Ship"
    - Shipping: "Bundles, PRs and CI"
    - Done: "Merged" ("Merged, failed or cancelled" with Show closed)
  - When the column holds cards from more than one stage, the hint is followed by a per-stage breakdown of what is in it (e.g. "2 discussing · 1 spec approval"). The raw state names stay available as the line's tooltip.
  - Header contents wrap rather than overflow.
- **Empty columns** keep a dashed placeholder with a helpful line. Planning, on a board with no runs at all, says "Press **Create** to submit your first ticket". Ready says "Reviewed tickets wait here to ship".
- **Unchanged behaviour:** the Ready ticks, including the one-project rule and its hint; the ship toast; bundle cards; the bundle chip on Done cards; the card move animation and reduced motion; the quick filters and counts; the `(N) Factory Board` title; cleared runs staying off the board.
- **The run view's progress strip keeps its fine-grained stages:** Intake, Discussion, Spec approval, Build, Review, Ready, Deliver, Done. So does the "Failed in <stage>" label. They are deliberately decoupled from the board columns. The stage a run is in, used by the run view, is a separate mapping from the column it is drawn in.

## 3. Sizing and scaling

- **Columns don't squeeze.**
  - Each column has a comfortable minimum width of about 272px.
  - Columns grow equally to fill the available width, up to a maximum of about 440px each.
  - When the five don't fit at their minimum, the board scrolls sideways inside its area (the page itself never scrolls sideways), with a visible scrollbar and scroll snapping to column starts (proximity, not mandatory).
  - Each column still scrolls vertically on its own.
  - On a typical 1440px-wide laptop all five columns fit without sideways scrolling.
- **Phones (≤ 640px):** each column is about `min(85vw, 360px)` wide, so the next column peeks in and invites a swipe. The board header and top bar fit without any horizontal page scroll.
- **One shared set of breakpoints** for the whole stylesheet: phone ≤ 640px, tablet ≤ 1024px, wide ≥ 1600px. The run view's existing breakpoints at 1180px and 760px may stay where the layout needs them, but no new ad-hoc widths.
  - Spacing (board padding, column gap) may grow a little on wide screens. Base font sizes stay the same.
- **Top bar:** brand, Board/Settings, search, **Create** and **Chat** stay reachable at every width down to 360px.
  - As the width shrinks, the search box narrows first. On phones it moves to a full-width second row.
  - Button labels never wrap mid-word or overlap.
- **Board header:** the title, project select and quick-filter chips wrap onto new lines instead of overflowing.
- **Browser zoom up to 200%** (or a larger default font) keeps everything readable. Columns keep their minimum and the board scrolls, rather than content overlapping.

## 4. Cards: no overlapping text

The same rules apply to run cards, Ready cards (with the tick) and bundle cards.

- **No child element ever paints outside its card or over a sibling,** at any column width at or above the minimum and at any zoom.
  - The footer's left side (key, discussion mark, project chip, bundle chip, round, QA and CI chips) wraps onto as many lines as it needs.
  - The right side (cost · age, avatar) stays on one line and keeps its own space. If both can't share one row, the footer stacks into two rows.
- **Long single tokens are truncated with an ellipsis, with the full value as a tooltip.** This covers project names, bundle ids and keys. Card titles wrap normally (including long words, `overflow-wrap: anywhere`) and are clamped at 3 lines with an ellipsis. The full title is the card's tooltip, and the run view shows it whole.
- **Bundle member rows:** key plus a truncated title, one line each, as today, aligned so keys never collide with titles.
- **The state row** (lozenge, "Your turn · …" badge, escalation flag) wraps rather than overflows.
- **The Ready tick** keeps its own reserved space, so it never covers the title or chips.

## 5. Other views (fix, don't redesign)

The run view, bundle view, full-screen chat and Settings keep their structure. The touch-up only fixes scaling and overflow in them:

- Header titles truncate with an ellipsis and a tooltip, never pushing the actions off-screen.
- Links and chips in headers truncate or hide at the existing narrow breakpoint.
- At 360px wide there is no horizontal page scroll in any of these views. Tables and code blocks keep scrolling inside their own block.
- Modals (Create, spec preview, edit draft) fit the viewport on phones (full width minus a margin, internal scroll) and keep a readable maximum width on wide screens.

## 6. Technical decisions

- **Plain CSS and JS only.** All changes stay in `app.css`, `app.js` and, where card or header markup lives, `bundles.js` and `discussions.js`, plus `index.html`. No build step, no new dependency, no web fonts. The CSP and the script load order are unchanged, there are no inline styles or handlers, and the existing `test/web.test.ts` checks keep passing.
- **Board column mapping lives in one function** (run to board column). It is separate from the run's pipeline stage (run to one of the 8 run view stages). Any code that used the old column keys (`intake`, `discussion`, `spec`, `review`, `deliver`) for the board moves to the new keys. Code that needs the fine stage (progress strip, "Failed in …", the default chat target) uses the stage mapping.
- **Layout technique:** columns use `flex: 1 0 <min>` with a `max-width`, and the board uses `overflow-x: auto` with `scroll-snap-type: x proximity`. Card footers use wrapping flex or grid with `min-width: 0` on shrinking children. Truncation uses `text-overflow: ellipsis` with a `title` attribute. Nothing is positioned absolutely except the existing Ready tick, whose space is reserved by card padding.
- **Docs:** update `docs/spec.md` §9 (Board, Ready column and Deliver column bullets → the five columns and the sizing rules) and acceptance behaviour 3. Update the AGENTS.md map line for `src/web/ui/` only if a file's role changes.

## Acceptance behaviours

1. Opening the board shows exactly five columns, in this order: **Planning**, **Build & Review**, **Ready**, **Shipping**, **Done**. Each has a plain-language hint instead of the raw `RECEIVED · PREPARING`-style line.
2. A new ticket appears in Planning while it is received, preparing and discussing, and stays there at the spec gate with a "spec approval" lozenge and a "Your turn" badge. After approval it moves to Build & Review, then to Ready after the review passes.
3. With a run in each of several Planning stages, the Planning header shows a per-stage breakdown (e.g. "1 discussing · 1 spec approval"), and "Your turn" cards come first.
4. Ticking two Ready cards of one project and clicking **Ship 2 tickets** creates one bundle card in **Shipping** that holds both. Cards of another project cannot be ticked meanwhile.
5. Merged runs show in Done with a bundle chip. **Clear all** in Done still clears exactly the Done cards shown, after two clicks.
6. In a 1440×900 window all five columns fit without sideways scrolling, and each column is at least about 272px wide.
7. In a 1024px-wide window the columns keep their minimum width and the board scrolls sideways (snapping to columns); the page itself does not scroll sideways.
8. In a 390px-wide (phone) window, one column fills most of the screen with the next one peeking in. Swiping or scrolling sideways moves between columns. **Create**, **Chat** and the search box are all reachable.
9. A ticket with a very long title, a long project name, a bundle chip, R/QA/CI chips, a cost and an avatar renders with no overlapping text at any window width and at 200% browser zoom. The title wraps to at most 3 lines with the full title on hover, and the long project name is truncated with an ellipsis.
10. A bundle card with several members with long titles shows one line per member (key plus truncated title), with no overlap.
11. Opening a run shows the run view's progress strip with its fine-grained stages (Intake … Done), unchanged. A failed run still reads "Failed in <stage>".
12. At 360px wide, the run view, the bundle view, the full-screen chat and Settings have no horizontal page scroll, and their header titles truncate instead of pushing the close button off-screen.
13. `npm test` and `npm run typecheck` pass, and the page loads with the same CSP and no console errors.
