# Bundles: combine several tickets into one PR and merge it

## Intent

Several runs of one project build in parallel. Today each run delivers its own PR (or, for a new repo, pushes to
`main`), waits for CI on that PR and can merge it. Parallel tickets on the same code then compete with each other,
and there is no way to ship several of them together.

This change splits "done building" from "delivered":
- A run that passes review no longer delivers. It stops at **Ready**, with its reviewed branch.
- You pick any set of Ready tickets of one project and **Ship** them. That creates a **bundle**.
- The bundle combines the tickets' branches on the latest default branch. An **integrator** agent resolves any
  conflict. If the integrator changed anything, a fresh reviewer and QA agent review the whole combined result.
- The bundle opens one PR for all its tickets, takes CI's failures back to the integrator, and merges when you click
  **Merge**.
- Shipping a single ticket gives you today's one-ticket PR.

Out of scope:
- Bundles across projects.
- Auto-shipping, i.e. tickets joining a bundle by themselves.
- Stacked PRs, or one PR per ticket inside a bundle.
- Changing a bundle's members except by dropping tickets (§3.5) or cancelling the bundle.

## 1. Run changes

### 1.1 New state `READY`

- **Path to Ready.** `REVIEWING` pass → (delivery gate, if on) → `DELIVERING` → `READY`.
- **What `DELIVERING` does now.** It keeps the "no unreviewed delivery" check: if the workspace diff differs from the
  last reviewed fingerprint, the run goes back to `REVIEWING` and no round is added. Then it commits whatever the
  builder left uncommitted. For an existing repo, it pushes the run's branch `factory/<run-id>` to `origin`. It opens
  no PR, creates no repo and waits for no CI.
- **`READY` is not terminal.** The run waits there for a bundle. `RunView` gains `bundle?: BundleId`, the active or
  merged bundle the run belongs to.
- **Messages to a run in `READY`.**
  - If the run is in no active bundle, the message goes to its builder. If the builder then changes the workspace
    diff, the run goes back to `REVIEWING` (no round added) and then returns to `READY`.
  - If the run is in an active bundle, the message is refused (`conflict`) with a pointer to the bundle.
- **Cancelling a run in `READY`.** It is allowed when the run is in no active bundle and refused (`conflict`) when it
  is in one.
- **Members of a merged bundle.** When a bundle merges, every member run goes `READY` → `DELIVERED`:
  - `artifacts.delivery` is the bundle's PR (or, for a new repo, the push to `main`).
  - `intake.writeBack(done, url)` runs.
  - Its notice reads "Merged in bundle-N: <url>".
  - `environment.dispose` runs, as at today's `DELIVERED`.
- **The `merge` gate is legacy.** `approvals: merge` still validates but no longer affects new runs: merging is
  always the bundle's Merge (or merging the PR on GitHub). The `delivery` gate keeps working and sits before `READY`.
- **CI no longer runs per run.** `ci.*` applies to bundles.
- **Legacy runs.** A run that had already begun delivering under the old flow when the factory upgrades finishes the
  old way: its own PR, CI and merge gate. This covers `DELIVERING`, `AWAITING_CI`, `AWAITING_APPROVAL(merge)`, and
  an escalation from `AWAITING_CI`. Durable resume must not break those runs.

### 1.2 Spec location

- **Where the spec is committed.** From now on, `SPEC_READY` commits the run's spec at `docs/specs/<run-id>.md`
  instead of `docs/spec.md`, so two tickets never collide on it. The builder's, reviewer's and QA's prompts and inputs
  name that path as the run's contract.
- **`docs/spec.md`** stays the product spec. The builder's prompt says to update it to reflect the change only when
  the repo already has one.
- **The architect's prompt line** "(the builder updates docs/spec.md)" stays true.
- **Older runs.** Runs already past `SPEC_READY` keep `docs/spec.md`.
- **Delivery text.** The PR description and delivery notes cite each ticket's spec path.

## 2. Bundles

### 2.1 Model

- **A bundle is a durable Pi Durable Task** (`createBundleTask`, alongside the run and discussion Tasks, sharing
  `CoreServices`). It survives `kill -9` like runs do.
- **Id:** `bundle-<n>`.
- **Settings.** It pins the project's effective settings at creation: CI, QA, role models, `reviewRoundCap`, and
  `bundle.mergeMethod`.
- **Members** are an ordered list of run ids, all from one project and all `READY`. Order is the order you picked
  them. A run is in at most one active (non-terminal) bundle. A project may have several active bundles.
- **Workspace.** A worktree `<workdir>/bundles/<bundle-id>` on branch `factory/<bundle-id>`, from the project's
  shared clone. The member branches are local branches of that clone, so combining them needs no fetch of the run
  branches.
- **New role `integrator`.**
  - Its model and thinking default to the builder's, as `helper`'s do.
  - It has the builder's write tool set in a write sandbox on the bundle worktree.
  - It finishes each task with `report_done`, which answers every blocking finding given.
  - The bundle has one integrator Conversation that persists across its tasks.
- **New setting `bundle.mergeMethod`:** `merge` | `squash` | `rebase`, default `squash`. It can be set globally or
  per project, and validation is on save.

### 2.2 States

| State | What happens | Exits |
|---|---|---|
| `INTEGRATING` | Fetches the default branch. Creates or resets `factory/<bundle-id>` at `origin/<default>` (for a repo that doesn't exist yet: the clone's local `main`). Merges each member branch in order with `git merge --no-ff`. On a conflict it leaves the conflicted merge in the worktree and gives the integrator the conflict: the ticket, the files, and every member's spec. When the integrator's `report_done` has committed the merge, it continues with the next member. | All merged, integrator changed nothing → `DELIVERING` · the integrator resolved anything → `REVIEWING` · error → `FAILED` |
| `FIXING` | Integrator task with blocking findings (review, QA, CI or human), the same finding shape as runs. | `report_done` → `REVIEWING` |
| `REVIEWING` | A fresh reviewer, and a QA agent in a boat.dev VM at the integration commit when AQ testing applies. Same rules as a run round. They check the **whole combined product** against **every member's spec** (and `docs/spec.md` if present), with the combined diff from the integration base. From round 2 on, each gets its own prior findings and the integrator's responses. | pass → `DELIVERING` · fail & under cap → `FIXING` · fail at cap → `ESCALATED` (the review cap is `reviewRoundCap`; reviews after a CI fix count toward `ci.fixRounds`) |
| `DELIVERING` | Existing repo: pushes `factory/<bundle-id>` and opens or updates one PR. New repo: `repo.create`, then pushes the integration result to `main` and commits `docs/delivery-notes.md`. | ok → `AWAITING_CI` (or straight on when `ci.mode: off`) · error → `FAILED` |
| `AWAITING_CI` | Same rules as today's per-run CI wait (`ci.mode`, `ci.checks`, `ci.noChecksTimeout`) on the delivered SHA. | green or no CI (`if-present`) → PR: `AWAITING_MERGE`; new repo: `MERGED` · red & under `ci.fixRounds` → `FIXING` · red at cap, or no checks under `required` → `ESCALATED` |
| `AWAITING_MERGE` | Pending ask: Merge / Request changes / Drop tickets. Also polls the PR. | see §2.3 |
| `ESCALATED` | Pending ask: more rounds (N) / drop tickets / abort | more rounds → `FIXING` · drop → `INTEGRATING` (§3.5) · abort → `CANCELLED` |
| `MERGED` | Terminal. Member runs → `DELIVERED` (§1.1). VMs and environments disposed. | — |
| `FAILED` | Terminal until **Retry**, which resumes from the failed state, like `retryRun`. Members stay in the bundle. | — |
| `CANCELLED` | Terminal. Closes the PR if one is open. Member runs are released back to plain `READY`, with their branches untouched. | — |

**PR content.**
- **Title:** the ticket's title for one member; otherwise "<N> tickets: <title 1>, <title 2>, …" (truncated).
- **One section per ticket:** title, run id, spec path, the run's final advisory and accepted findings, and its QA
  status.
- **An integration section:** the conflicts resolved, the bundle's review rounds, its advisory findings and QA status,
  and the "no CI" note if that applies.
- **Screenshots** are never uploaded. The text says they are in the factory's view, as today.

### 2.3 Merging

- **Merge** (`mergeBundle`) when the default branch has not moved since the CI-checked integration: the core merges
  the PR with `bundle.mergeMethod` → `MERGED`.
- **Merge when the default branch has moved** (another bundle or a human merged meanwhile): Merge means "merge when
  green on the latest default".
  1. The bundle goes back to `INTEGRATING` on the new default.
  2. It pushes and waits for CI again.
  3. If that update merged cleanly and CI is green, it merges without asking again.
  4. If the integrator had to change anything, the update takes the normal review path and comes back to
     `AWAITING_MERGE` for a fresh click.
- **GitHub refuses the merge** (not mergeable): the same update path.
- **Request changes** (with feedback): one blocking `source: human` finding → `FIXING` → `REVIEWING`. No review or
  CI round is added.
- **The PR merged on GitHub by a human** is detected while polling → `MERGED`.
- **The PR closed without merging** → `CANCELLED`, and members are released.

### 2.4 Dropping tickets

At `AWAITING_MERGE` or `ESCALATED` you can drop one or more members, as long as at least one remains:
- Dropped runs return to plain `READY`.
- The bundle restarts at `INTEGRATING` from the latest default with a fresh integration branch. The earlier
  integration commits are discarded.
- The integrator Conversation carries on and gets a note listing the remaining tickets.
- An open PR is reused and its description rewritten.

Dropping all members is the same as cancelling.

### 2.5 Messages

A message to a bundle goes to the agent the bundle is with: the current reviewer while `REVIEWING`, otherwise the
integrator. It is a steer with a header, as for runs. QA takes no messages. A change the integrator makes after a
passing review sends the bundle back through `REVIEWING` before `DELIVERING` (no unreviewed delivery). Messages are
refused on a terminal bundle.

## 3. Core surface

**New `FactoryCore` operations**, added to `CORE_OPS` so they are served over `POST /api/op/<op>`:
- `createBundle(project, runs: RunId[]) → BundleId`
  - `invalid` if the list is empty, or a run is not of that project or not `READY`;
  - `conflict` if a run is already in an active bundle.
- `getBundle(id) → BundleView`
- `listBundles(filter?: { project?; states? })`
- `getBundleConversation(id, conversationId)`
- `mergeBundle(id)`
- `requestBundleChanges(id, feedback)`
- `dropFromBundle(id, runs: RunId[])`
- `resolveBundleEscalation(id, ask, { moreRounds: n } | { drop: RunId[] } | { abort: true })`
- `cancelBundle(id, reason?)`
- `retryBundle(id)`
- `messageBundle(id, text)`
- `getBundleScreenshot(id, screenshotId)`, also over `GET /api/bundles/<id>/screenshots/<sid>`

`BundleView` holds:
- id, project, repo, state, members (each with its run id, title and key);
- PR / delivery, CI status, pending ask and escalation;
- conversations (integrator, reviewers, QA);
- the bundle's own review rounds, findings log, advisory findings and QA status;
- notices, messages, history, cost, and timestamps.

**Events:** `bundle.state`, `bundle.ask`, `bundle.askResolved`, `bundle.notice`, `bundle.conversation.updated`.
- `subscribe` accepts a `bundle` filter.
- A `project` filter also matches bundle events.
- Member runs emit their own `run.state` events as they change state.

## 4. Web UI

- **Board columns:** Intake, Discussion, Spec approval, Build, Review, **Ready**, Deliver, Done.
- **Ready column.**
  - Each card there has a checkbox. Ticking a card of one project disables the checkboxes of other projects' cards,
    with a hint explaining why.
  - The column header shows **Ship N tickets** while any are ticked. Clicking it creates the bundle and shows a toast
    linking to it.
  - A run's view in `READY` has **Ship this ticket**, which makes a bundle of one.
- **Deliver column.** It shows **bundle cards**: the bundle id, its state, the member ticket keys, and "Your turn"
  when it waits for you. Member runs show inside their bundle card rather than as separate cards. Legacy runs still
  delivering the old way show as ordinary cards there.
- **Done column.** It shows merged member runs with a bundle chip.
- **Bundle view.** It reuses the run view:
  - the left rail: integrator, reviewers and QA Conversations, plus a timeline;
  - the transcript and a chat box, which goes to `messageBundle`;
  - a header listing the member tickets (each links to its run) and the PR link.
- **Bundle cards.**
  - *Merge card* (`AWAITING_MERGE`): the CI status, the final round's findings with screenshots, the QA status (or
    "not reviewed: clean merge"), and **Merge**, **Request changes** and **Drop tickets…**.
  - *Escalation card:* the reason, findings, and **More rounds**, **Drop tickets…** and **Abort**.
  - *Failed bundle:* **Retry**.
  - **Cancel bundle** is always available on a non-terminal bundle.
- **A member run's view** shows "In bundle-N" (a link) and, once merged, the PR.

## 5. Docs and tests

- Update `docs/spec.md` (create it if it is missing) to describe the product's spec including bundles, and update
  `README.md`, `docs/architecture.md`, `docs/configuration.md` (`bundle.mergeMethod`, the legacy `merge` gate) and
  `DEVIATIONS.md` where the design spec's single-run delivery no longer holds.
- Tests use the fake GitHub (`LocalGitHubHost`) and scripted agents. They cover:
  - every bundle state transition;
  - a conflict resolved by the integrator, then a review;
  - CI red → fix → review;
  - a moved default branch at Merge;
  - an external merge and an external close;
  - drop and cancel releasing runs;
  - legacy runs finishing the old way;
  - `kill -9` while the integrator is resolving, and resuming.
- The dry run builds two tickets of one project in parallel, ships them as one bundle and merges it, and the report
  records this.
- `npm test` and `npm run typecheck` pass.

## Acceptance behaviours

1. Two tickets of an existing-repo project run in parallel. Each stops in **Ready** after its review passes, with
   branch `factory/<run-id>` pushed and no PR open.
2. Each new run commits its spec at `docs/specs/<run-id>.md`. Two Ready tickets never conflict on their spec files.
3. Ticking both Ready cards and clicking **Ship 2 tickets** creates a bundle card in Deliver that contains both
   tickets. Ticking a card of another project is not possible while those are ticked.
4. When the two branches merge cleanly, one PR opens with a section per ticket and no bundle review round. CI runs on
   it, and **Merge** appears. Clicking Merge merges it with `bundle.mergeMethod`, and both runs show Done with the
   same PR URL and a bundle chip.
5. When the two tickets edit the same lines, the bundle view shows the integrator resolving the conflict, then a fresh
   reviewer (and QA agent, if QA is on) reviewing the whole combined diff against both specs, before the PR opens.
6. Red CI on the bundle PR goes to the integrator as a CI finding, followed by a review round and a new CI run. At
   `ci.fixRounds`, the bundle escalates with More rounds / Drop tickets / Abort.
7. **Drop tickets** at the merge card returns the dropped run to Ready (shippable again). The bundle re-integrates the
   rest, and the PR description then lists only the remaining tickets.
8. **Cancel bundle** closes its PR, and its runs return to Ready. A run inside an active bundle cannot be cancelled,
   messaged, or shipped in a second bundle; each attempt shows a clear error.
9. If another bundle merges first, clicking Merge on the second updates it onto the new default branch, re-runs CI and
   merges it without a second click when the update was clean.
10. Merging the bundle PR directly on GitHub (or closing it) is picked up by the factory: the bundle becomes Merged
    (or Cancelled, with its runs back in Ready).
11. **Ship this ticket** on a single Ready run gives one PR for that ticket, the same result as before this change.
12. For a project whose repo does not exist yet, shipping a bundle creates the private repo and pushes the combined
    result to `main` with `docs/delivery-notes.md`. No PR and no Merge step are involved; the runs show Done once CI
    passes or is skipped.
13. Killing the factory (`kill -9`) while the integrator is resolving a conflict, then starting it again, resumes the
    same bundle and the same integrator Conversation, and the bundle goes on to the PR.
14. A run that was already waiting for CI or the merge gate before the upgrade finishes with its own PR, as before.
