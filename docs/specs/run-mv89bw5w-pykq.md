# Open discussions no longer block project deletion

## Context

`deleteProject(name)` (product spec §5 and §8.1, spec `docs/specs/run-mv86f7vs-jif2.md`) currently refuses with `conflict` when the project has **live work**: any run that is not terminal, any bundle that is not `MERGED` or `CANCELLED`, or any discussion in `PREPARING` or `OPEN`. A project with an open Chat discussion can't be deleted until the human closes each discussion by hand.

This change takes discussions out of "live work". `deleteProject` now ends the project's discussions itself and goes on with the purge. **Runs and bundles still block deletion, with no change to that rule.**

## Behaviour

### Core: `deleteProject`

- **Live work** now means only runs that are not `DELIVERED`, `FAILED` or `CANCELLED`, and bundles that are not `MERGED` or `CANCELLED`. A discussion never counts as live and never shows up in `details.live`. The conflict message no longer suggests "Close discussion". It reads, for example, `project p has live work: run-x is READY, bundle-2 is FAILED; cancel it first (Cancel, Cancel bundle)`.
- **The order inside the project lock:**
  1. Validate the input and check that the project exists. This is unchanged: `invalid` and `not_found` work as before.
  2. Check runs and bundles for live work. If any is live, return `conflict`. **Nothing changes**: discussions are not touched on a refusal, so an `OPEN` discussion stays `OPEN`.
  3. **End the live discussions.** This covers every discussion of the project in `PREPARING` or `OPEN`, including:
     - a discussion whose turn is running (the model is mid-reply or drafting tickets);
     - a discussion still preparing its checkout.

     Each one is ended without asking, by aborting its discussion Task through the Task's existing `abort` path. That path does three things:
     - it stops the Conversation's work;
     - it does the full cleanup of the checkout, local branch, scratch and environment;
     - it commits `FAILED` and ends the Task.

     All of these discussions are aborted first, then the deletion waits for their Tasks to end. The limit is the same 10 s as for finishing owners today. A discussion whose Task has not ended by then makes the deletion fail with `conflict`. Its live item is `{ kind: "discussion", id, state: "<state> (still finishing)" }`. Discussions that were already ended stay `FAILED`, so the human can retry them. Nothing else changes.
  4. Continue as today. The existing wait for finishing owners runs, then the purge commit, the config removal, `project.deleted` and the background disk cleanup.
- **The purge commit** re-checks live work for runs and bundles only. It retires every discussion Document of the project, whatever its state.
- **Serialisation:** `reopenDiscussion` and `retryDiscussion` join the ops that take the per-project lock, alongside `startRun`, `createTicket`, `startDiscussion` and the others. A reopen or retry that arrives during a deletion waits for it, then fails with `not_found`. A discussion that was ended can't come back to life before the purge commit.
- A turn op (`say`, `requestDrafts` or `stopTurn`) that races with the deletion either fails with `conflict` (the discussion is no longer `OPEN`) or `not_found` (it was purged), or it is cut off by the abort. It never leaves anything running after the deletion.
- **The return value and events are unchanged.** `{ project, runs, bundles, discussions }` includes the discussions that were ended. Subscribers may see `discussion.state` move to `FAILED` for them before `project.deleted`.

### Web UI: the Delete project dialog

- The confirmation dialog warns about the project's discussions in `PREPARING` or `OPEN`, read from `listDiscussions({ project })`. It shows a line such as "2 open discussions will be ended". The line is absent when there are none. The rest of the dialog is unchanged: the name must be typed to confirm, and the removes and keeps text stays the same.
- On `conflict`, the dialog lists only runs and bundles, or a discussion that is "still finishing". The hint reads "Cancel these first".
- On success the behaviour is as today: the toast, the scope going back to Global, and live removal in every tab. A tab that had one of the ended discussions open in the full-screen chat closes it with the toast "Project <name> was deleted".

### Docs

The builder updates the following:
- `docs/spec.md`: the §5 `deleteProject` paragraph (the live-work definition and discussions ended automatically), the list of locked ops, and the §9 Delete project bullet;
- the comments and tests that describe discussions as live work.

## Key decisions

- **Ending a discussion reuses its Task's existing `abort` path.** No new discussion state or cleanup code is added. The abort already stops the Conversation and cleans up the checkout and environment, and its result (`FAILED`) is retired by the purge right after.
- **Runs and bundles are checked before any discussion is touched**, so a refused deletion still changes nothing.
- **No new operation and no change to `FactoryCore` signatures.** Only the meaning of `conflict` for `deleteProject` narrows.

## Acceptance behaviours

1. **Open discussion, idle:** a project has one `OPEN` discussion with no turn running and no live runs or bundles. Delete project succeeds without closing it first. The discussion is gone from the Chat rail, `getDiscussion` returns `not_found`, and its checkout under `<workdir>/discussions/<id>` is removed.
2. **Discussion mid-reply:** the human sends a message and, while the model is still replying, deletes the project. The deletion succeeds, the reply stops, and nothing for that discussion keeps running or is left on disk.
3. **Discussion still preparing:** deleting a project right after starting a discussion (still `PREPARING`) succeeds and leaves no checkout behind.
4. **Runs still block:** a project with a `READY` run and an `OPEN` discussion. Delete returns 409. `details.live` lists only the run, and the discussion is still `OPEN` and usable afterwards.
5. **Bundles still block:** a project with a `FAILED` bundle refuses deletion exactly as before. The dialog lists the bundle with the hint "Cancel these first" and no discussion.
6. **Dialog warning:** for a project with two open discussions, the confirmation dialog shows "2 open discussions will be ended". With none open, no such line appears.
7. **No resurrection:** a `reopenDiscussion` or `retryDiscussion` sent while the deletion is in progress fails with `not_found` once it completes, and the project stays deleted.
8. **Other tabs:** a second browser tab showing one of the project's open discussions in full-screen chat closes it with the toast "Project <name> was deleted".
