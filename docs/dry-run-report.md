# Dry run of spec §8 — 2026-10-13T08:14:19.147Z

Directory: .dryrun (DRYRUN_DIR). Scripted agents (no model credentials), sandbox OFF (DRYRUN_SANDBOX=0), fake GitHub with local CI runner, SQLite storage, a daemonized `factory serve` driven through the web HTTP API (`POST /api/op/<op>`, `GET /api/events`).

Dropped CLI-only checks: none. The terminal attach view check is replaced by the SSE event stream check.

Bundles: runs stop at Ready after review (branch `factory/<run-id>` pushed, no PR); every step ships its Ready run(s) as a bundle (`createBundle`) and merges it (`mergeBundle`) where the run used to deliver by itself. The PR description and delivery notes are written by the bundle (`## Ticket: <title>` sections and `## Integration`).

**105/105 checks passed.**

## §8.1 zero-to-MVP: createProject todo → me/todo, a discussion, then a ticket from its draft (repo does not exist)
- ✅ discussion reached OPEN and answered both messages (after an ls, then a web search)
- ✅ drafts submitted with a summary
- ✅ the run's request came from the discussion (source, meta)
- ✅ repo did not exist before the run
- ✅ spec rejection returns the run to the discussion (same architect)
- ✅ the architect's first input carried the discussion summary
- ✅ discussion asked two questions, one at a time
- ✅ spec v2 after the rejection carries the feedback

## §8.3 kill -9 the factory mid-build, restart, resume
- ✅ after restart the run is still BUILDING at the same round
- ✅ same builder Conversation after restart
- ✅ zero-to-MVP stopped in Ready after its review: no repo created, nothing delivered, no PR

## §8.1 Ship this ticket (a bundle of one) on a new repo: create the repo, push to main, CI, done
- ✅ zero-to-MVP delivered by its bundle
- ✅ a new repo's bundle goes INTEGRATING → DELIVERING → AWAITING_CI → MERGED: no PR and no Merge click
- ✅ the builder's first input was admitted once (idempotent across the crash)
- ✅ forced review failure: round 1 failed for a real reason (remove missing)
- ✅ the same builder Conversation received the findings
- ✅ review passed in round 2
- ✅ the reviewer's own test run passed on the delivery
- ✅ delivered as a push to main of a new private repo
- ✅ main has code, tests, README, AGENTS.md, the ticket's spec (docs/specs/<run-id>.md) and delivery notes
- ✅ the bundle wrote the delivery notes: a "## Ticket: <title>" section citing the spec path, and "## Integration"
- ✅ npm test passes on the delivered main
- ✅ if-present on a repo without CI: the bundle finished and noted that there was no CI
- ✅ cost per role per round recorded in the run Document
- ✅ helper Conversation spawned by the builder is visible in the transcript view
- ✅ the builder's helper wrote code: scripts/run.sh is on the delivered main

## AQ testing on (fake) boat.dev VMs, beside each review
- ✅ QA ran in both review rounds
- ✅ round 1 QA failed for a real reason (remove) and cited a screenshot
- ✅ the screenshot is served by the web server as image/png
- ✅ every QA VM of the run was deleted after its round
- ✅ QA cost (agent tokens + VM time) recorded per round
- ✅ no screenshot was committed to the repo
- ✅ the delivery notes record the ticket's QA status
- ✅ the SSE event stream reported run.state → READY → DELIVERED and builder and reviewer activity (conversation.updated)

## §8.4 invalid setting is rejected and the config file is unchanged
- ✅ setSetting ci.fixRounds 5 is rejected
- ✅ setSetting bundle.mergeMethod fast-forward is rejected (merge | squash | rebase)
- ✅ config file unchanged

## §8.2 incremental: startRun todo "add due dates and an --overdue filter"; Ready, then Ship and Merge
- ✅ incremental stopped in Ready: branch factory/<run-id> pushed with its spec at docs/specs/<run-id>.md, no PR
- ✅ the architect grounded the discussion in the repo (read the earlier ticket's spec in docs/specs/ first)
- ✅ human input only for the discussion and the spec approval
- ✅ the reviewer's own test run passed
- ✅ one PR for the bundle of one: the ticket's title, a "## Ticket" section citing docs/specs/<run-id>.md, "## Integration" (clean merge, no bundle review: one ticket)
- ✅ the bundle of one went INTEGRATING → DELIVERING → AWAITING_CI → AWAITING_MERGE (the Merge card)
- ✅ incremental delivered after Merge: the PR merged with bundle.mergeMethod (squash)
- ✅ main has the due-date feature after the merge
- ✅ in-flight run kept its pinned reviewer (scripted/reviewer, high)

## §8.3 delivery gate (and the legacy merge gate) on for the project; reject the delivery gate once, then Request changes at the bundle's Merge card
- ✅ delivery rejection → same builder got a blocking source:human finding
- ✅ delivery rejection added no review or CI round
- ✅ the delivery gate was rejected once and sits before Ready
- ✅ approvals: merge is legacy: the run reached Ready without a merge gate
- ✅ the next reviewer saw the human finding
- ✅ next new run's reviewer uses the changed model/thinking (scripted/reviewer-b, medium)
- ✅ Request changes → the bundle's integrator got one blocking source:human finding
- ✅ Request changes added no review or CI round; the change went FIXING → REVIEWING → CI → a fresh Merge card
- ✅ the bundle's reviewer saw the human finding and the integrator's response
- ✅ the bundle's reviewer used the model pinned when it was created (scripted/reviewer-b, medium)
- ✅ run with the delivery rejection and the Request changes delivered (merged)
- ✅ the integrator's change is on main (AGENTS.md mentions --version)

## §8.3 ci.mode off: the bundle goes to the Merge card without waiting for CI
- ✅ mode off: the bundle skipped AWAITING_CI and the run was DELIVERED after Merge

## §8.3 ci.mode required on a repo with no CI checks: the bundle escalates after ci.noChecksTimeout
- ✅ mode required, no checks: the bundle is ESCALATED with 'no CI checks' (More rounds / Drop tickets / Abort)
- ✅ escalation came after ci.noChecksTimeout (4s)
- ✅ escalation abort → bundle CANCELLED, its PR closed, the run back in Ready
- ✅ the released run can be cancelled → CANCELLED

## §8.3 hit the review round cap: escalates; accept goes to Ready; shipped with the findings on record
- ✅ round cap reached → ESCALATED after 2 review rounds
- ✅ accept → Ready with the accepted findings on record
- ✅ shipped and delivered; the PR's ticket section lists the findings accepted as is

## §8.3 todo2: new repo, ci.mode required set before the repo exists; builder ships CI
- ✅ todo2 delivered by its bundle
- ✅ the builder shipped a CI workflow
- ✅ the bundle waited for and passed CI on the commit it pushed to main (no Merge step)

## §8.3 ci.fixRounds 0 and a forced CI failure on the bundle's PR: escalates without a fix round
- ✅ CI failure with fixRounds 0 → the bundle is ESCALATED
- ✅ no CI fix round was run (the integrator got no task)

## Bundles: two todo2 tickets built in parallel, shipped as one bundle (they conflict), one PR, CI, Merge
- ✅ both tickets were built in parallel (each started building before the other reached Ready)
- ✅ the first ticket stopped in Ready: branch factory/<run-id> pushed with its spec at docs/specs/<run-id>.md, no PR
- ✅ the second ticket stopped in Ready: branch factory/<run-id> pushed with its spec at docs/specs/<run-id>.md, no PR
- ✅ a bundle holds tickets of one project: shipping with a todo run is refused
- ✅ the bundle card data (getBundle): both members in order with title, key and branch, an active state; both runs show the bundle
- ✅ listBundles shows it among the project's active bundles
- ✅ a run inside an active bundle cannot be shipped again, cancelled or messaged (clear errors)
- ✅ the tickets conflicted (both appended to README.md): INTEGRATING → REVIEWING → DELIVERING → AWAITING_CI → AWAITING_MERGE
- ✅ the two Ready tickets never conflicted on their spec files
- ✅ the integrator got the conflict (the ticket, the files, every member's spec) and concluded the merge with report_done
- ✅ a fresh reviewer reviewed the whole combined diff against both specs, and its own test run passed
- ✅ a QA agent tested the combined result in a VM beside the bundle review
- ✅ ONE PR for both tickets: "2 tickets: …", a "## Ticket" section per ticket (with its spec path), and "## Integration" with the conflicts and the review round
- ✅ CI ran on the bundle's PR and is green; the Merge card waits for Merge
- ✅ Merge: the bundle MERGED; both runs DELIVERED with the same PR URL and `bundle` set
- ✅ main has both tickets (README lists both changes, no conflict markers, both specs) and npm test passes
- ✅ the project's event stream reported the bundle's states (bundle.state) and both runs' run.state → DELIVERED
- ✅ the bundle's QA VM was deleted

## Bundles: two todo2 tickets that merge cleanly, shipped as one bundle: the combination is reviewed before the PR
- ✅ the tickets merged cleanly (no conflict resolved) and the combination was still reviewed: INTEGRATING → REVIEWING → DELIVERING → AWAITING_CI → AWAITING_MERGE
- ✅ the notice says the combination is being reviewed ("All 2 tickets merged cleanly; reviewing the combination …")
- ✅ a fresh reviewer got both specs and the combined diff, was told the tickets merged without conflicts and each passed its own review, and to look at how they interact
- ✅ a QA agent tested the clean combination in a VM beside the bundle review
- ✅ the PR's "## Integration" says the merge was clean and the combination was reviewed in 1 review round, with its QA status
- ✅ Merge: the clean, reviewed bundle MERGED and both runs are DELIVERED

## Web UI and its API
- ✅ the link factory serve printed is the one in web-url (mode 0600)
- ✅ factory web prints the link
- ✅ the API refuses requests without the token
- ✅ with the token it lists every run of the trial
- ✅ listBundles lists every bundle of the trial
- ✅ the link sets an HttpOnly, SameSite=Strict session cookie
- ✅ messages to a finished run are refused with a pointer to a new run (`message` op)

## §8.5 pass criteria
- ✅ all runs recorded with cost and round counts
- ✅ all bundles recorded with cost and round counts
- ✅ every factory-made commit on the remotes' branches is authored and committed by the GitHub identity's account (factory-dev <1+factory-dev@users.noreply.github.com>); the rest are GitHub-side (GitHub <noreply@github.com>)
