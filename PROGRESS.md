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

## Markdown rendering (SWF-3, run run-mv46mros-6c1p; spec docs/specs/run-mv46mros-6c1p.md)

- [x] marked 18.1.0 + dompurify 3.4.16 as exact runtime deps; jsdom + @types/jsdom dev deps for tests
- [x] server: exact STATIC routes /vendor/marked.js (marked's lib/marked.umd.js, found next to its exported entry),
      /vendor/purify.js (dist/purify.min.js), /markdown.js; lookup uses Object.hasOwn (no prototype keys)
- [x] src/web/ui/markdown.js defines globals md()/inline(); app.js's hand-written versions removed
- [x] ask_human question card uses md(); finding descriptions keep inline()
- [x] CSS for markdown elements (tables scroll via display:block + overflow-x)
- [x] tests: test/web-markdown.test.ts (jsdom), vendor route tests in test/web.test.ts
- [x] docs: design-spec §3.6 bullet, README web UI paragraph, AGENTS.md, scripts/setup.sh, scripts/run.sh

Decisions
- Separate markdown.js file (own static route) rather than inlining in app.js: testable in jsdom in isolation.
- Private DOMPurify instance (DOMPurify(window)) so hooks don't leak to the global.
- Foreign images are replaced in a DOMPurify hook inside its inert document (no request): http(s) → link, else alt text.
- No CI workflow: the project has none and the spec doesn't require one.
- No browser available in the build sandbox; layout checked by reasoning (grid minmax(0,1fr), .blk min-width:0).
- Full suite: 8–9 failures in sandbox*.test.ts / durability.test.ts are pre-existing here (bwrap cannot create namespaces in this build host); identical on the base commit.
- Integrated with bundles + chat: bundles.js loads after markdown.js and uses its inline(); the static-UI test checks all six scripts in order.

## Continuous chat (run run-mv4rfo5d-i74d; spec docs/specs/run-mv4rfo5d-i74d.md)

- [x] app.css: explicit grid-row for .rv-center > .conv-head/.tx-wrap/#composer-wrap; chat mode row template
      `0px minmax(0, 1fr) auto`; .rv-body grid-template-rows minmax(0, 1fr) (definite, viewport-bounded row)
- [x] test/web.test.ts "chat layout" test on the served /app.css (fails on the previous stylesheet)
- [x] docs/spec.md Chat bullet
Decisions
- CSS only; no browser in the build host, layout checked by reasoning (all .rv-body siblings of .rv-center are in
  its single row or position:fixed at ≤760/≤1180, so the bounded row holds at every breakpoint).

## UI touch-up: five-column board (run run-mv4rgjw0-ch4q; spec docs/specs/run-mv4rgjw0-ch4q.md)

- [x] app.js: COLUMNS (planning/build/ready/shipping/done) + `boardColumn` (one mapping, null = drawn in its bundle
      card), `phaseOf` (rank + breakdown label), `breakdown`; `stageOf` (fine stage for the run view, was columnOf).
- [x] Decision: "Failed in <stage>" now uses the run's history (the state it failed from) instead of always "Done".
- [x] Cards: footer `.foot-l` (wraps) / `.foot-r` (nowrap); title clamp 3 lines + card tooltip; token tooltips.
- [x] CSS: --col-min 272 / --col-max 440, snap proximity; breakpoints 640/1024/1600 (+1180/760); 960 → 1024.
- [x] Human message: long approval/escalation dock cards now scroll inside (dock is a flex column, card shrinks) with
      sticky actions; modal footers sticky.
- [x] test/web-board.test.ts (jsdom: loads index.html + scripts with a stubbed core).
- No browser available here (playwright download blocked), so layout was checked by reasoning, not screenshots.
- [x] docs/spec.md §9 + acceptance 3, README, architecture, AGENTS.

## Self-update from the web UI (run run-mv4rp25k-mqna; spec docs/specs/run-mv4rp25k-mqna.md)

- [x] src/update/: restart.ts (shared restart, moved from setup/context.ts; detectStartedBy, detectService), record.ts
      (update.json), helper.ts (detached restart helper + rollback), updater.ts (check/apply), cli.ts (factory update)
- [x] wiring: main.ts (Updater, activeWork, startChecks), cli.ts (serve detects startedBy; update; status SHA),
      daemon.ts (FACTORY_DAEMON_ARGS marker), web/server.ts routes
- [x] UI: ui/update.js (chip, dialog, confirm, progress/reload, banner) — helper-built, reviewed
- [x] tests: test/update.test.ts (unit, routes), test/update-daemon.test.ts (real daemon update + rollback)
- [x] docs: spec §9/§10/§12, README, architecture.md, AGENTS.md

Decisions:
- The helper runs from a copy of the running version's helper.ts/restart.ts/record.ts (read at startup, written to
  <home>/update-helper/), run with the install root's tsx: a broken new version can't break its own rollback.
- Under systemd the helper is started with `systemd-run --user` (a unit restart kills its whole cgroup).
- Daemon restart = SIGTERM the pid file's process, then `bin/factory serve --config <c> <same args>` (setup's restart
  uses the same path with no extra args, as before).
- apply returns after the record is written (phase pulling); pull/install/restart continue in the background.
- apply accepts a short or full SHA; it re-fetches, and an upstream that moved since the check is `conflict`.
- A failed fetch keeps the comparison against the last fetched upstream (check.error set); it does not block apply.
- Dismiss deletes update.json; refused (conflict) while an update runs.
- update.json left `pulling`/`installing` at startup → failed; `restarting` older than 5 min → settled.
- `factory status` prints a second line `version <sha> (...)`; first line unchanged.
- `factory update` with a running factory goes through its HTTP API (same restart path); without one, pull+install.
- Acceptance 4 (runs survive) rests on the existing durability (SIGTERM path, covered by test/durability.test.ts).

## Combined review of clean 2+ bundles (run run-mv4vd9xu-g2si; spec docs/specs/run-mv4vd9xu-g2si.md)

- [x] core: `integration.reviewCombination` mark set on every new integration record; INTEGRATING exit: changed →
      REVIEWING (mergeRequested cleared); clean + mark + 2+ members → REVIEWING (mergeRequested kept, enterReview in
      the same transition); else → DELIVERING. Reviewer input for a clean 2+ combination says merged without
      conflicts / each reviewed on its own / look at how the tickets interact.
- [x] UI: qaText (clean merge only for one ticket or a pre-rule record; "Not reviewed yet: the combination is reviewed
      before the PR" for 2+), conversations hint, "merges by itself when green and no fix" notes.
- [x] tests: bundle.test.ts (updated clean-two path, new describe for fail/cap, drop to 2, moved default with/without
      fix, pre-upgrade record), durability (kill -9 in the clean-combination review), web-board (qaText).
      Test hooks: `patchBundleForTests`, `control.reviewerHang`.
- [x] dry run: "document …" tickets write their own page (no README/PROGRESS append) so they merge cleanly; new step
      ships two of them (104/104). docs/dry-run-report.md refreshed.
- [x] docs: spec.md, architecture.md, DEVIATIONS 66, README, AGENTS.md (helper wrote; reviewed).

Decisions:
- A 2+ bundle whose integration record predates the rule (no mark) and was clean shows "Not reviewed: clean merge"
  (it really wasn't reviewed); the spec's "never clean merge" applies to bundles under the new rule.
- The clean-combination reviewer wording is chosen from the facts (no conflict resolved, 2+ members), so it also
  appears in later rounds of that review (after FIXING) — the merge itself is still conflict-free.
- Full suite: only the 8 bubblewrap sandbox tests fail (no user namespaces on this host), as on the base.

## Bulk cancel and clear (run run-mv545v95-rg77; spec docs/specs/run-mv545v95-rg77.md)

- [x] Core `cancelRuns` (+CORE_OPS): checks all, one commit of cancelReasons (re-checked in the tx), then abortTask each.
- [x] UI: Select toggle (#f-select), per-card `input[data-sel]` (reuses the .ship-wrap layout), per-column
      `input[data-sel-col]` (indeterminate when partial), action bar #sel-bar in the board head (Cancel K / Clear M /
      Clear selection, two-click confirm with 4 s timeout and reset on click elsewhere / set change).
- Decision: the selection holds only cards the board currently shows; filtering a selected card out drops it (so a
  bulk action never acts on tickets the user can't see). Spanning projects works with "All projects".
- Decision: ship ticks (ui.ship) are kept untouched during select mode, so leaving it restores them as they were.
- Decision: the UI passes reason "cancelled from the web UI" (same as the run view's Cancel run).
- [x] Tests: test/cancel-runs.test.ts, web.test.ts "bulk cancel", web-board.test.ts select mode. Docs updated.

## Disk cleanup (run run-mv58bn4q-q2zs; spec docs/specs/run-mv58bn4q-q2zs.md)

- [x] host: `GitHubHost.deleteBranch` (gh: DELETE refs, 404/422 = gone; fake: update-ref -d; `failDeleteBranch` test control)
- [x] github: public `discard(area,id,repo,workdir)` (withClone, per-step results), `deleteRemoteBranch`, `sweepClone`,
      `removeOrphanWorktree`, `clones`
- [x] sandbox: `removeScratch`, `destroy`, `recordIds`
- [x] core/cleanup.ts: `cleanupScope`, `Cleaner` (per-owner lock, background + settled, cleanup steps, sweep)
- [x] Tasks: run/bundle finalize+abort, discussion CLOSED/FAILED/abort; marker in the terminal commit
- [x] core: clearRuns + cancelBundle(FAILED) background cleanup; retries under `cleaner.exclusive` delete the marker;
      startup sweep; `gc` op (CORE_OPS); test hook `cleanupsSettledForTests`
- [x] CLI `factory gc` (src/gc.ts: web-url → POST /api/op/gc; exit 1 when not running or on failures)
- [x] tests: test/cleanup.test.ts (acceptance 1-15 + rules, deleteRemoteBranch, removeScratch), github-api
      (GhApiHost.deleteBranch), discussion.test (CLOSED now deletes the env record); helpers: makeFactory `log`,
      discussant "READ: path"
- [x] docs: spec.md §8.1 + rows, architecture, configuration, README, AGENTS, DEVIATIONS 9/49, old clear spec note
- [x] dry run 104/104; full suite: only the 8 bubblewrap sandbox tests fail (no user namespaces here), as on the base

Decisions:
- The scope a core-started cleanup uses is recomputed inside the per-owner lock from the record as committed then.
- Retries run their commit inside the owner's cleanup lock (not just "wait, then commit") so no cleanup can start in between.
- Sweep counts: runs/bundles/discussions = worktrees + manifests removed in that area; scratch dirs; env records;
  local/remote branches.
- `factory gc` exits 1 when the sweep reported failures too (scriptable); "no factory is running" when web-url is
  missing or the connection is refused.
- Round 2: F1 fixed — `LocalGitHubHost.save` is atomic (temp + rename) and `deleteBranch` no longer logs to the state
  file (the dry-run driver read a half-written github-state.json); dry run 104/104 three times in a row. F4: docs warn
  not to share a workdir between factories. F5 left as is (indexing the cache outside onChange would skew event diffs).

## Commit identity (run run-mv6dwfsi-7xli; spec docs/specs/run-mv6dwfsi-7xli.md)

- [x] git.ts: baseEnv has no identity; `git()` throws for commit-creating subcommands without `{ identity }`.
- [x] host.ts: `GitHubHost.commitIdentity`; GhApiHost direct HTTPS lookups (`appJwt` factored out; installation tokens
      cached per app/installation); LocalGitHubHost `setAccount`/`failIdentity`, logs `commitIdentity`, GitHub-side
      commits as `GitHub <noreply@github.com>`.
- [x] github.ts: `GitHub.commitIdentity(rc)` cache (key: kind/tokenRef/appId/installationId/privateKeyRef, shared
      in-flight, failures dropped); every commit-creating method takes rc.
- [x] sandbox: `EnvRecord.commitIdentity`, provision(…, identity), policy() refuses a record without one; core env
      factory fills old records from the owner's pinned config (owner kind from the id prefix bundle-/disc-/run).
- [x] doctor: `commits as:` per distinct identity (GhApiHost takes the doctor's secret store; `SF_TEST_GITHUB_API`).
- [x] tests: commit-identity.test.ts (acceptance 1,4,5,6), sandbox-home, github-api, doctor; dry run 105/105.
- Decisions: whoami stays on `gh api` (setup only). Missing credential in doctor → the existing warn, no lookup.
- Full suite: only the 8 bubblewrap tests fail (no user namespaces on this host), as before.

## Delete a project (run run-mv86f7vs-jif2; spec docs/specs/run-mv86f7vs-jif2.md)

- [x] types: `deleteProject` (CORE_OPS), `project.deleted` event, `FactoryError.details` (server sends it in error bodies)
- [x] settings: `ConfigStore.removeProject`; github: `repoExists`, `removeClone`, `clonePath`
- [x] cleanup: `Owner.repoExists` (false skips the remote step), `Cleaner.purgeOwner` (full steps + artifacts dir),
      `SweepSource.deletions` (sweep step 0)
- [x] project-deletion.ts: `factory.projectDeletions` doc, `nextIndexId` (monotonic `seq` on Bundle/DiscussionIndex)
- [x] core: per-project lock (`withProject`) around startRun/createTicket/startDiscussion/createBundle/set/unset
      (project scope)/createProject; deleteProject (checks, wait for finishing Tasks, repoExists per repo, Cleaner.exclusive
      over all owners, purge commit with in-tx recheck, forget caches + `purged` set, config, event, background finish);
      `finishConfigRemovals` at start(); `finishDeletions` from deleteProject and the sweep
- [x] web UI (helper): Settings → Delete project section + type-to-confirm dialog, conflict links, live removal,
      not-found message, hashchange links
- [x] tests: test/project-delete.test.ts (acceptance 1-7, incl. kill-after-commit on sqlite), test/web-delete-project.test.ts
- [x] docs: spec.md §5, §8.1 (purge subsection, never-deleted exceptions), §9, acceptance 22; AGENTS.md

Decisions:
- Entry fields beyond the spec: `id` (a name can be deleted twice), `otherClones` (pinned workdirs ≠ global),
  owners' `github` settings (identity refs, for the remote branch).
- A finished owner whose Task has not ended is waited for 10 s, then reported as live (`<STATE> (still finishing)`).
- Sweep counts: artifacts dirs count under the owner's area (runs/bundles/discussions); a removed clone under local
  branches (the summary line's format is unchanged).
- Clones are removed only after every owner of the entry succeeded and the config block is gone.
- Config removal is finished in `start()` before the web server can call in, so a same-name createProject after a
  crash never races the resumption.

## Open discussions no longer block project deletion (run run-mv89bw5w-pykq; spec docs/specs/run-mv89bw5w-pykq.md)

- [x] core: liveItems = runs + bundles only; message "cancel it first (Cancel, Cancel bundle)"; endDiscussions
      (abortTask every PREPARING/OPEN discussion's Task, then wait 10 s together; "<state> (still finishing)" conflict);
      purge re-checks runs/bundles only; reopen/retryDiscussion under withProject.
- [x] discussion Task abort: also aborts a running turn's Conversation (best effort) and disposes the environment.
- [x] tests: project-delete.test.ts (acceptance 1-4, 7, still finishing), web-delete-project.test.ts (5, 6, 8).
- [x] UI: dialog line "N open discussions will be ended"; conflict hint "Cancel these first"; a FAILED toast is
      delayed and skipped when the discussion/project is gone; an open chat purged before project.deleted arrives
      closes with "Project <name> was deleted".
- [x] docs/spec.md §5 / §9, types.ts comment, AGENTS.md pointer.

Decisions:
- A running turn holds the Task's invocation until the Conversation's work ends (abortTask signals and joins; the
  invocation's context is dead, so the Task can't abort the Conversation itself). deleteProject therefore aborts the
  Conversation (as Stop does) right after aborting each Task, so the abort path gets to run. The scripted test provider
  ignores aborts (like the Stop test), so test 2 releases its hang shortly after.
- Round 2: the Conversation aborts are fired, not awaited, inside the single 10 s deadline (an abort resolves only
  when the work is idle); test for a hang > 10 s → conflict (still finishing) at ~10 s. A discussions-only conflict
  says "try again in a moment". The delayed FAILED toast reads the title at toast time.

## Interrupting agents, live cost and tool-call timing (run run-mv8t6vsz-pmy8; spec docs/specs/run-mv8t6vsz-pmy8.md)

- [x] types: stopToolCall / interruptAgent / interruptBundleAgent (CORE_OPS), RunView/BundleView.liveCost + interrupted,
      DiscussionView.liveCost, TranscriptView.running/now, toolResult.durationMs, HumanMessage.resume, `cost.updated`.
- [x] task-kit runAgent: an input settled unanswered/aborted while `interrupted` names this Conversation and key waits
      durably for the n-th resume message (`<key>:resume<n>`) and submits it as the turn's next input; no nudge used;
      a bridge result that wins the race clears the pause; transitions/cancel/retry clear it.
- [x] core: interrupt (commit pause + notice, then Conversation.abort, waited ≤ 10 s), resumeWith in message /
      messageBundle, stopToolCall (abortTask; pending without task → in-memory, applied on the pi.live change),
      liveCostOf (usage − max(recorded, usageBase), running helpers in full), discussionCost (turn.usage0), costTick
      (2 s throttle per owner, emitted only when the total changed), transcript running/now/durationMs.
- [x] prompts: STOPPED_CALL line in every role.
- [x] UI (app.js, bundles.js, discussions.js, app.css), tests (interrupt.test.ts, web-live.test.ts), dry run
      ([slow-tool] tickets), docs/spec.md §4/§5/§8/§9, AGENTS.md.

Decisions:
- Bundles: interruptBundleAgent refuses on policy.messages only for the reviewer (the integrator always takes messages,
  as messageBundle does).
- The run Task (not the message op) submits the resume input: a submission racing the abort could be withdrawn by it,
  and the Task's submit is idempotent across kill -9. The op returns at once with the Conversation id.
- The live cost baseline is `usageBase` (what runAgent's turn started from, committed with `driving`) together with
  `usage`, matching addCost's base exactly, so recorded + live never drops or double counts. Conversations never
  accounted (no record, no turn since this change) are left out.
- DiscussionView.cost is now the recorded part only (usage minus the running turn's, from `turn.usage0`).
- A stopped tool result has no durationMs of its own: the view gives result timestamp − calling response timestamp.
- Scripted models are priced (3/15 $ per M tokens): pi-ai's faux provider reports $0, so live cost could not be seen
  in the dev factory or tested in usd.
- Dev factory / dry run: a ticket titled with `[slow-tool]` makes the scripted builder run two 60 s sleeps first.
