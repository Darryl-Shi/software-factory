# Bundles: review and QA the combined product when 2+ tickets merge cleanly

## Context

Today a bundle goes straight from `INTEGRATING` to `DELIVERING` when every member branch merges cleanly (`src/core/bundle-task.ts`, the notice "All N ticket(s) merged cleanly; no review of the combination needed"). Each ticket was reviewed and QA-tested only on its own branch. Their combination is checked only by CI, and under `ci.mode: if-present` with no checks, by nothing at all. Two tickets can merge without conflicts and still break each other.

This change closes that gap: **every integration of a bundle with 2 or more members gets a full bundle review.** It is the same review round as §3.3/§3.4 `REVIEWING` today: a fresh reviewer, plus a fresh QA agent when QA applies.

## Where review happens: existing vs proposed

Per ticket, before shipping, nothing changes:

```
Request → (optional discussion) → architect questions → [HUMAN] approve spec
  → builder → REVIEW (reviewer + QA, up to reviewRoundCap rounds; fail → builder fixes → review again) → Ready
```

Shipping (bundle), **existing**:

```
[HUMAN] Ship
 → INTEGRATING on latest default branch
     integrator changed anything (conflict) → REVIEW → PR
     clean (any number of tickets)          → PR                    (no review)
 → CI   (red → integrator fixes → REVIEW → CI)
 → [HUMAN] Merge
     default unchanged → merged
     default moved / GitHub refused → INTEGRATING again
        integrator changed anything → REVIEW → CI → back to Merge card (fresh click)
        clean                       → CI → merges by itself
 Drop tickets → INTEGRATING again with the rest (same branches as above)
```

Shipping (bundle), **proposed** (★ = new):

```
[HUMAN] Ship
 → INTEGRATING on latest default branch
     integrator changed anything (conflict) → REVIEW → PR
     clean, 1 member                        → PR                    (no review, unchanged)
     clean, 2+ members                      → REVIEW ★ → PR
 → CI   (red → integrator fixes → REVIEW → CI)
 → [HUMAN] Merge
     default unchanged → merged
     default moved / GitHub refused → INTEGRATING again
        integrator changed anything → REVIEW → CI → back to Merge card (fresh click)
        clean, 1 member             → CI → merges by itself
        clean, 2+ members           → REVIEW ★ → CI → merges by itself if no fix was needed,
                                                      else back to Merge card (fresh click)
 Drop tickets → INTEGRATING again with the rest (same branches as above)
```

The run review rounds, QA rules, CI fix rounds and the spec gate are unchanged.

## Behaviour

### The rule (every integration)

At the end of `INTEGRATING`, once every member is merged:

| Integration outcome | Next state |
|---|---|
| The integrator changed anything (`integration.changed`) | `REVIEWING`, as today, and `mergeRequested` is cleared as today |
| Clean, **2 or more members**, and the integration started under the new rule | `REVIEWING` ★. `mergeRequested` is **kept** |
| Clean, 1 member (or an integration started before the upgrade) | `DELIVERING`, as today |

- **What counts as an integration.** "Every integration" means the first integration, a re-integration after **Drop tickets** (from `AWAITING_MERGE` or `ESCALATED`), and a re-integration after **Merge** finds the default branch moved or GitHub refused the merge.
- **Member count.** The count is the members remaining at the end of that integration.
- **The review itself.** It is exactly the existing bundle `REVIEWING`:
  - A fresh reviewer Conversation, created by `enterReview`.
  - A fresh QA agent in a fresh VM when `qa.enabled` and a run script exists. The rules are the same as for any bundle review.
  - It covers the whole combined product against every member's spec and `docs/spec.md` when present, with the combined diff from the integration base.
- **After the review.** Pass → `DELIVERING`. Fail under cap → `FIXING` by the integrator → `REVIEWING`. Fail at cap → `ESCALATED` with More rounds / Drop tickets / Abort. `reviewRoundCap`, the bundle's round counter, the CI loop and messages (to the reviewer while `REVIEWING`) all behave exactly as for a bundle review today. No new counters and no reset of rounds on re-integration.
- **Durability.** The `INTEGRATING → REVIEWING` transition is one commit of the `factory.bundle` Document, together with its checkpoint and the new review record (`enterReview` inside the same `transition`). After `kill -9`, the bundle resumes in `REVIEWING` with the same review seq and round. Submissions already committed are kept, as `runReview` does today.

### Merge after a moved default branch (decided: auto-merge if no fix)

When Merge triggers a re-integration (`mergeRequested = true`), a clean 2+ member re-integration goes to `REVIEWING` **without clearing `mergeRequested`**.
- **No fix needed.** If the review passes and no `FIXING` happens before CI is green (no review fix, no CI fix, no Request changes), the bundle pushes, waits for CI and merges by itself. This is today's behaviour for a clean update. Acceptance behaviour 9 of `docs/spec.md` still holds.
- **Any fix needed.** Any `FIXING` clears `mergeRequested` (existing `toFixing`). The bundle then comes back to `AWAITING_MERGE` with a fresh Merge ask, the same rule as when the integrator changed anything.

### The reviewer's input for a clean multi-ticket review

When the integration was clean (no conflicts resolved, integrator changed nothing) and has 2+ members, the reviewer's input states three things:
- The tickets merged without conflicts.
- Each ticket already passed its own review (and QA where it applied) on its own branch.
- The reviewer should look especially at how the tickets interact: shared code, files, data, config, APIs, UI and tests, and behaviour one ticket changes that another relies on.

The rest of the input is today's bundle reviewer input: the members, every spec, the combined diff, and prior findings.

The conflict wording ("especially where the tickets meet (conflict resolutions)") stays for reviews where the integrator resolved conflicts. QA input is unchanged: it already checks every member's acceptance behaviours on the combined build.

### Visible state

- **Notice.** A clean 2+ integration says, e.g., "All 2 tickets merged cleanly; reviewing the combination (each ticket was reviewed on its own branch)". A clean one-member integration keeps today's "no review of the combination needed" notice.
- **Merge card, escalation card and details panel** (`src/web/ui/bundles.js` `qaText`):
  - "Not reviewed: clean merge" is shown only for a bundle with no reviews whose integration was clean with one member.
  - A bundle that was reviewed shows its QA status (or "QA not run") and its review count and round, as a conflicted bundle does today.
  - Before any review, a 2+ member bundle shows that the review is still to come, never "clean merge".
- **Conversations hint.** "A clean merge needs neither." becomes accurate: a clean one-ticket merge needs neither; a bundle of two or more always gets a reviewer.
- **PR integration section.** It says the merge was clean and reports the review rounds and QA status of the bundle review. This is the existing reviewed-bundle text plus "merged cleanly". For a one-ticket clean bundle it keeps "had no review of its own".

### Bundles in flight at upgrade

- The rule is decided **per integration**. When `INTEGRATING` creates the integration record, it marks the record as following the new rule (a field on `integration`).
- An integration record created before the upgrade has no mark. It ends with today's rule: clean → `DELIVERING`.
- Bundles already past `INTEGRATING` continue unchanged and are not reviewed for the integration they already did. A re-integration that starts after the upgrade (a drop or a moved default branch) creates a new record and follows the new rule.
- No Document migration is needed.

## Key technical decisions

- **No new states, no new settings.** The review always happens for 2+ members; there is no opt-out. Only the `INTEGRATING` exit, the reviewer input wording, notices, UI text and PR text change.
- **The core stays model-free.** The decision is a deterministic function of `integration.changed`, the member count and the integration's rule mark.
- **`mergeRequested`** is cleared on entry to review only when the integrator changed something. For a clean 2+ review it survives until a `FIXING` clears it.
- **Cost.** One more reviewer, one more QA VM and some wall-clock time per multi-ticket bundle integration. This is accepted.

## Docs and tests

- **`docs/spec.md`:**
  - §3.4 `INTEGRATING` exits.
  - The Merge bullet: a clean 2+ update is reviewed and merges by itself only if no fix was needed.
  - The `REVIEWING` row, if needed.
  - PR content.
  - §9 merge card text ("Not reviewed: clean merge" only for one ticket).
  - The conversations hint.
  - Acceptance behaviour 4: a clean two-ticket bundle now has a bundle review round before the PR.
  - Acceptance behaviour 9: holds when the review needs no fix.
- **`docs/architecture.md`:** the bundle diagram (`INTEGRATING ──clean──► DELIVERING`, the moved-default line) and the `INTEGRATING`/`AWAITING_MERGE` rows.
- **`DEVIATIONS.md`:** update if any entry disagrees (e.g. entry 66's "if the remaining tickets merge cleanly" stays true, but check it).
- **`AGENTS.md` map comment and `bundle-task.ts` header comment:** "reviews the combined result when the integrator changed anything" becomes the new rule.
- **Tests (never weaken):**
  - `test/bundle.test.ts` "bundle of two, clean merge" is deliberately updated to `INTEGRATING → REVIEWING → DELIVERING → …` with one bundle review.
  - New tests cover:
    - A failing clean-combination review → `FIXING` → re-review → escalation at cap.
    - A drop to 2+ remaining (reviewed) and to 1 remaining (not reviewed).
    - A moved default branch on a 2+ bundle: no fix → merges itself after green CI; with a fix → back at `AWAITING_MERGE`.
    - `kill -9` resume in this review.
    - A pre-upgrade integration record without the mark finishing without review.
  - One-ticket no-review assertions stay, including in `scripts/dry-run.ts`.
- **Dry run.** Its two-ticket bundle step now shows the review. Update its checks deliberately and refresh `docs/dry-run-report.md`.

## Acceptance behaviours

1. Shipping two Ready tickets whose branches merge cleanly shows `INTEGRATING → REVIEWING → DELIVERING → …`. A fresh reviewer, plus a QA agent when QA is on and a run script exists, reviews the combined diff against both specs before the PR opens. The notice says the combination is being reviewed.
2. The reviewer's input for that review says the tickets merged without conflicts, that each passed review on its own, and that it should look especially at how they interact.
3. If that review fails, the integrator gets the findings (`FIXING`) and the combination is reviewed again. At `reviewRoundCap` the bundle escalates with More rounds / Drop tickets / Abort.
4. **Ship this ticket** on one Ready run whose branch merges cleanly still goes `INTEGRATING → DELIVERING`, with no bundle review round. The merge card says "Not reviewed: clean merge".
5. Dropping tickets so that two or more remain, with a clean re-integration, reviews the remaining combination again before the PR is updated. Dropping down to one remaining member, with a clean re-integration, does not.
6. If another bundle merged first, **Merge** on a two-ticket bundle re-integrates cleanly and reviews the combination. If no fix is needed, the bundle merges after green CI without a second click. If a fix was needed, it returns to the merge card for a fresh click.
7. The merge card and PR of a reviewed clean bundle show its review rounds and QA status, not "Not reviewed: clean merge". The PR's integration section says the merge was clean and the combination was reviewed.
8. Killing the factory (`kill -9`) during this review and starting it again resumes the same bundle in `REVIEWING` with the same review number and round.
9. A bundle that was already past `INTEGRATING` before the upgrade finishes without the new review (unless it later re-integrates after a drop or a moved default branch).
10. `npm test`, `npm run typecheck` and the dry run pass. The two-ticket clean-merge test asserts the new review, and the one-ticket checks still assert no bundle review.
