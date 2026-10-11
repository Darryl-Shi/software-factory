# Progress (run-mv46hn3a-f4fa: Chat button + full-screen chat)

- [x] core: optional title (deriveTitle in discussion-doc.ts), listModels op (+CORE_OPS), tests
- [x] UI: Discussions tab/list/modal removed; Chat button next to Create; full-screen chat view (discussions.js)
- [x] docs: README Web UI, design-doc amendment (§3 superseded), architecture.md ops
- [x] AGENTS.md, scripts/setup.sh, scripts/run.sh (scripted demo on :7317), CI workflow
- [x] dry run passes (66/66, DRYRUN_SANDBOX=0); npm test: all pass except bwrap sandbox tests (no user namespaces
      on this host) and one durability helper test that flaked under full-suite load (passes 3/3 alone)
- [x] UI driven end to end with jsdom against a scripted factory (no browser downloadable here): acceptance 1–11

## Decisions / notes
- Starting two discussions concurrently on a project whose clone does not exist yet can fail one (pre-existing core
  race, not touched: "nothing else changes in the core"); tests start them sequentially.
- `ui.open === "#new"` marks a blank new chat in the shared sheet; `#chat` is its hash.
- **New chat** pressed from the rail keeps the rail's current project; the spec's default order (board filter → most
  recently active discussion's project → first project → New project…) applies when the chat opens blank otherwise.
- The drafts panel auto-opens when a draft turn starts (any width) and when the discussion has drafts (wide screens
  only, ≥1180px, where it is a column rather than an overlay). **Draft tickets** toggles it.
- The rail toggle reuses the run view's threads button: collapses the rail on wide screens, drawer on ≤760px.
- Locked dropdowns are disabled selects with the tooltip on both the select and its wrapper (disabled controls
  don't show tooltips in every browser).
- The chat view closes into the Chat button (the run view's shrink animation).
- Old test assertion `data-view="discussions"` replaced by the spec's opposite (nav is Board, Settings; Chat next to
  Create); the refusal of a blank title replaced by "blank title is derived" + "blank message refused".
