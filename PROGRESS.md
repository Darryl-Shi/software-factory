# Progress (bundles build, run run-mv4ghzj2-allm)

Spec: docs/spec.md (bundles). Notes for myself.

## Decisions
- Legacy runs: on startup, non-terminal runs without `flowVersion` that had begun delivering (DELIVERING, AWAITING_CI,
  AWAITING_APPROVAL(merge), ESCALATED from AWAITING_CI, or a delivery artifact) get `legacy: true`; all get flowVersion 2.
  Legacy runs keep the old DELIVERING/AWAITING_CI/merge-gate path.
- FAILED bundles keep their members (they can't be shipped elsewhere) until retried or cancelled; cancelBundle is
  allowed on FAILED to release them.
- There is no intake in the code (superseded); "writeBack" = the run's final notice. Noted in DEVIATIONS.
- Integrator: Coding + TestRunner + WebSearch (no subagent), write sandbox like the builder; report_done.
- Ticket key (PROJECT-N) is computed by the core for BundleMember the same way the UI does.
- Pre-existing failures: test/sandbox*.test.ts (bubblewrap can't run in this host). Not caused by this change.

## Status
- [x] types.ts
- [x] run changes (READY, spec path, legacy), bundle task/doc, task-kit refactor, core ops/events, GitHub additions
- [x] web UI (helper), tests updated (helpers), bundle/legacy tests, dry run (98/98), docs
- [x] AGENTS.md, scripts/setup.sh, scripts/run.sh (credential-free scripted factory on :7317)
- docs/spec.md was this ticket's spec; moved to docs/specs/run-mv4ghzj2-allm.md, docs/spec.md is now the product spec.
- Drop note to the integrator goes with its next task (prepended); not delivered if the re-integration is clean.
- policy.messages also gates messages to a bundle's reviewer; integrator always takes messages.

## Clearing Done runs (SWF-1, run run-mv46ek2u-7omz; spec docs/specs/run-mv46ek2u-7omz.md)

- [x] Core: `RunDocState.cleared`, `RunView.cleared`, `clearRuns` (+CORE_OPS), `listRuns({ includeCleared })`,
      `retryRun` refuses cleared, `run.cleared` event (emitted from the commit watch, so every subscriber gets it).
- [x] Tests: test/clear.test.ts (core), test/web.test.ts "clearing runs" (HTTP).
- [x] UI: board filters cleared runs (loads includeCleared for stable keys), "Clear all" in Done header with
      confirm, run-view "Clear from board" with confirm, cleared marker (header lozenge, details note, composer,
      timeline), no Retry when cleared, live removal on `run.cleared` with an exit animation.
- [x] Browser-verified with Playwright on a dry-run factory (helper): behaviours 1–10 pass; CSS fix for the header.
- [x] Docs: README, architecture.md, AGENTS.md, scripts/setup.sh, scripts/run.sh.

Decisions:
- Existence is checked before the commit (runs are never deleted); terminal state is re-checked inside the commit.
- Duplicate ids in one call are de-duplicated.
- `listRuns({ includeCleared })` with a non-boolean is `invalid`.
- `clearRuns` does not touch `updatedAt` (only the flag changes).
- No CI workflow: the spec doesn't ask for one.
- Full suite: 375/383 pass; the 8 failures are sandbox tests that need unprivileged user namespaces (bwrap), failing identically on the base.
- Integrated with bundles: Clear all sits in colHead; cleared runs stay in ui.runs (keys), off every column and counter.

## Chat button + full-screen chat (SWF-2, run run-mv46hn3a-f4fa; spec docs/specs/run-mv46hn3a-f4fa.md)

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
- CI round 1 (F7): no logs reachable (gh unauthenticated). Most likely cause is the one seen locally: bwrap present
  but Ubuntu 24.04 AppArmor blocks unprivileged user namespaces. CI now installs bubblewrap/socat/ripgrep and sets
  kernel.apparmor_restrict_unprivileged_userns=0, with a bwrap probe step that fails early and clearly.
- Integrated with bundles + clearing: toast() takes a { label, onClick } button or a function (whole toast clickable); #bundle= boot kept next to #disc=/#chat; .rv-links/.rv-extra hidden in the chat view.
