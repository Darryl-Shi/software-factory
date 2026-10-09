# Dry run of spec §8 — 2026-10-09T16:40:16.156Z

Directory: /home/dshi/tmp-sf/dr6. Scripted agents (no model credentials), sandbox OFF (DRYRUN_SANDBOX=0), fake GitHub with local CI runner, SQLite storage, a daemonized `factory serve` driven through the web HTTP API (`POST /api/op/<op>`, `GET /api/events`).

Dropped CLI-only checks: none. The terminal attach view check is replaced by the SSE event stream check.

**54/54 checks passed.**

## §8.1 zero-to-MVP: createProject todo → me/todo and startRun (repo does not exist)
- ✅ repo did not exist before the run
- ✅ spec rejection returns the run to the discussion (same architect)
- ✅ discussion asked two questions, one at a time
- ✅ spec v2 after the rejection carries the feedback

## §8.3 kill -9 the factory mid-build, restart, resume
- ✅ after restart the run is still BUILDING at the same round
- ✅ same builder Conversation after restart
- ✅ zero-to-MVP delivered
- ✅ the builder's first input was admitted once (idempotent across the crash)
- ✅ forced review failure: round 1 failed for a real reason (remove missing)
- ✅ the same builder Conversation received the findings
- ✅ review passed in round 2
- ✅ the reviewer's own test run passed on the delivery
- ✅ delivered as a push to main of a new private repo
- ✅ main has code, tests, README, AGENTS.md, docs/spec.md and delivery notes
- ✅ npm test passes on the delivered main
- ✅ if-present on a repo without CI: finished and noted that there was no CI
- ✅ cost per role per round recorded in the run Document
- ✅ helper Conversation spawned by the builder is visible in the transcript view
- ✅ the SSE event stream reported run.state → DELIVERED

## §8.4 invalid setting is rejected and the config file is unchanged
- ✅ setSetting ci.fixRounds 5 is rejected
- ✅ config file unchanged

## §8.2 incremental: startRun todo "add due dates and an --overdue filter"
- ✅ incremental delivered
- ✅ the architect grounded the discussion in the repo (read docs/spec.md first)
- ✅ delivered as a PR on the same repo
- ✅ human input only for the discussion and the spec approval
- ✅ the reviewer's own test run passed
- ✅ PR branch has the due-date feature
- ✅ in-flight run kept its pinned reviewer (scripted/reviewer, high)

## §8.3 delivery and merge gates on for the project; reject once at each
- ✅ delivery rejection → same builder got a blocking source:human finding
- ✅ delivery rejection added no review or CI round
- ✅ merge rejection → same builder got a blocking source:human finding
- ✅ merge rejection added no review or CI round
- ✅ run with both gate rejections delivered (merged)
- ✅ both gates were rejected once
- ✅ the next reviewer saw the human finding
- ✅ next new run's reviewer uses the changed model/thinking (scripted/reviewer-b, medium)

## §8.3 ci.mode off: finishes at delivery without waiting for CI
- ✅ mode off: DELIVERED without AWAITING_CI

## §8.3 ci.mode required on a repo with no CI checks: escalates after ci.noChecksTimeout
- ✅ mode required, no checks: ESCALATED with 'no CI checks'
- ✅ escalation came after ci.noChecksTimeout (4s)
- ✅ escalation abort → CANCELLED

## §8.3 hit the review round cap: escalates; accept delivers with the findings on record
- ✅ round cap reached → ESCALATED after 2 review rounds
- ✅ accept → delivered with known findings

## §8.3 todo2: new repo, ci.mode required set before the repo exists; builder ships CI
- ✅ todo2 delivered
- ✅ the builder shipped a CI workflow
- ✅ the run waited for and passed CI on the pushed commit on main

## §8.3 ci.fixRounds 0 and a forced CI failure: escalates without a fix round
- ✅ CI failure with fixRounds 0 → ESCALATED
- ✅ no CI fix round was run

## Web UI and its API
- ✅ the link factory serve printed is the one in web-url (mode 0600)
- ✅ factory web prints the link
- ✅ the API refuses requests without the token
- ✅ with the token it lists every run of the trial
- ✅ the link sets an HttpOnly, SameSite=Strict session cookie
- ✅ messages to a finished run are refused with a pointer to a new run (`message` op)

## §8.5 pass criteria
- ✅ all runs recorded with cost and round counts
