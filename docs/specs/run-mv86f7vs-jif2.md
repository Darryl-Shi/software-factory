# Delete a project

## Context

A project is one entry, `projects.<name>` (its `repo` plus setting overrides), in the config file (`ConfigStore`). Runs,
bundles and discussions refer to it by name. Their Documents (`factory.run`, `factory.bundle`, `factory.discussion`, listed in
`RunIndex`, `BundleIndex` and `DiscussionIndex`) and their agent Conversations live in Pi Durable storage. QA
screenshots live under `<factory home>/artifacts/<owner id>/`. On disk, each owner leaves the things listed in §8.1.
Today a project can't be removed at all.

This change adds **deleting a project**. Deleting is refused while the project has live work. When it goes ahead, it
**purges** the project's history from the factory through Pi Durable's API (decisions A1 + B2/P1 below). It never touches
GitHub beyond the factory's own `factory/<id>` branches.

## Decisions

- **A1: refuse while live.** A project with live work can't be deleted; nothing is cancelled or closed for you.
  Live work means:
  - any run not in `DELIVERED` / `FAILED` / `CANCELLED` (`READY` counts as live);
  - any bundle not in `MERGED` / `CANCELLED` (`FAILED` counts as live);
  - any discussion in `PREPARING` or `OPEN`.

  The human first uses the existing **Cancel** (or Select → Cancel K), **Cancel bundle** and **Close discussion**.
- **B2 / P1: logical purge through the API.** Every Document of the project's runs, bundles and discussions is
  **retired** (`tx.retireDoc`) and its id is removed from its index, all in one commit. Its screenshots are then deleted
  and its disk is fully cleaned. Afterwards nothing in the factory can read that history: views, transcripts, cost and
  links all return `not_found`.
  - Pi Durable has no delete for Conversations, entries, tasks or document revisions. Those bytes stay in
    `factory.sqlite` / the JSONL files as unreachable rows, so the store does not shrink.
  - There is **no raw SQL** against Pi Durable's tables and no `VACUUM`. The behaviour is the same on SQLite and JSONL.
- **Never touched:** the GitHub repo, its default branch, PRs (open or closed) and their descriptions, merged history,
  and global settings. The only things removed on the host are the project's own `factory/<run-id>` and
  `factory/<bundle-id>` branches, which go as part of each owner's full cleanup (§8.1 rules: skipped when the repo
  doesn't exist on the host).

## Core operation: `deleteProject(name)`

This is a new `FactoryCore` operation, listed in `CORE_OPS` and served as `POST /api/op/deleteProject`. It returns
`{ project, runs, bundles, discussions }`: the ids that were purged.

**Checks.** All are made before anything changes:
- `name` not a non-empty string → `invalid`.
- No such project → `not_found`.
- Live work → `conflict`. The message names every live item with its id and state, e.g. `run-… is READY`,
  `bundle-3 is FAILED`, `disc-7 is OPEN`. The error also carries the list as structured data (`details.live:
  { kind, id, state }[]`), so the UI can link the items.

**Serialisation.** A per-project in-process lock prevents a race between the check and the purge. While a deletion
runs, these ops on the same project wait for it, and once the project is gone they fail with `not_found`:
- `startRun`, `createTicket`, `startDiscussion`, `createBundle`;
- `setSetting` / `unsetSetting` with that project scope;
- `createProject` with that name.

Before committing, the deletion also waits for any in-flight cleanup of the project's owners (`Cleaner.exclusive`).

**Steps.** These happen in this order, and each is durable or idempotent:
1. **One commit.** Re-check liveness inside the transaction (a `conflict` aborts with nothing changed). Then, for each
   of the project's runs, bundles and discussions:
   - capture what its full cleanup needs: kind, id, repo, pinned workdir, and whether its repo exists on the host;
   - retire its Document and remove its id from its index.

   In the same commit, append one entry to a new session Document, **`factory.projectDeletions`**:
   `{ project, repo, at, by, owners: [...captured], configRemoved: false, clone: <path>|null }`.
2. **Config.** Remove the whole `projects.<name>` block from the config file (repo and every override), then set
   `configRemoved: true`.
3. **Event.** Emit `project.deleted { project, runs, bundles, discussions }`. Subscribers get it unfiltered and with a
   `project` filter for that name. Then return.
4. **Disk, in the background** (the call does not wait for it):
   - For each captured owner: a full cleanup (§8.1 order: remote branch, worktree, prune, local branch, manifest,
     scratch dirs, environment records), driven from the captured data rather than from a Document. Then delete
     `<factory home>/artifacts/<owner id>/`.
   - After that, delete the shared clone `<workdir>/repos/<owner>__<repo>` in each workdir the owners pinned, plus the
     global workdir. The clone goes **only if no remaining project binds the same repo**; otherwise it stays and only
     the project's branches go.
   - Each owner and the clone are removed from the deletion entry as they succeed. The entry itself is dropped when
     it's empty.
   - A failed step is logged with its owner and step, and stays in the entry for a retry.

**Resuming.** The startup sweep and `gc` first finish any unfinished `projectDeletions` entry: they complete the config
removal if `configRemoved` is false, then retry the remaining owners and the clone. Their items count in the sweep
summary (`runs`, `bundles`, `discussions`, `branches`, …). A factory killed at any point after step 1 ends with the
project fully deleted. A crash before step 1 commits changes nothing.

**Ids are never reused.** `bundle-N` and `disc-N` are currently `index length + 1`. After a purge they must keep
counting from the highest id ever issued: the indexes keep a monotonic counter, seeded from the existing ids on first
use. Without this, a new `bundle-3` would collide with an old PR and branch name. Run ids are already unique.

**After the purge:**
- `getProject` and `getSettings({ project })` return `not_found`.
- `listProjects`, `listRuns` (also with `includeCleared`), `listBundles` and `listDiscussions` leave the purged items
  out.
- `getRun`, `getBundle`, `getDiscussion`, their conversations and screenshots return `not_found`.
- The orphan and clone sweeps treat purged ids as having no record, as they do today.

**Same name later.** `createProject` with the same name, with any repo, makes a fresh project: no overrides, ticket keys
starting again at `<PREFIX>-1`, empty Chat history.

## Web UI

- **Settings → a project's scope** gets a **Delete project** section at the bottom: a short explanation of what is
  removed and what is not (GitHub repo and PRs are kept).
  - The **Delete project** button opens a confirmation that requires typing the project name exactly. The confirm
    button stays disabled until it matches.
  - On `conflict` the dialog shows the live items, each linking to its run, bundle or discussion, with the hint to
    cancel or close them first. Nothing is deleted.
  - On success: a toast "Deleted project <name>", the settings scope goes back to Global, and the project disappears
    from the scope list.
- **Live, in every open tab** (via `project.deleted`): the project's run and bundle cards and its discussions leave the
  board, the counts, the Chat history rail and the project dropdowns (board filter, Create, Chat). A board filter set
  to that project resets to "All projects". An open run, bundle or discussion view of the project closes, with a toast
  "Project <name> was deleted". A link to a purged item shows "Not found (its project was deleted or it never
  existed)".
- No CLI command. `factory gc` finishes interrupted deletions as part of its sweep.

## Spec and docs updates (by the builder)

- `docs/spec.md`:
  - §5: `deleteProject` under Projects; the `project.deleted` event.
  - §8 / §8.1: the purge, the `projectDeletions` record, sweep resumption, the clone rule, and the "Never deleted"
    exceptions (screenshots, Documents and the reachability of conversations for deleted projects).
  - §9: the Settings section and the live removal.
  - Acceptance behaviours.
- `AGENTS.md`: a pointer to this spec. Tests cover `deleteProject` in the core (fake GitHub, scripted agents),
  including `kill -9`-style resumption and the web UI flow (jsdom).

## Acceptance behaviours

1. A project with a `READY` run, a `FAILED` bundle or an `OPEN` discussion can't be deleted.
   `POST /api/op/deleteProject` returns 409 naming each live item and its state, and the project, its runs, bundles,
   discussions, settings and disk are unchanged. The Settings dialog lists those items as links.
2. After cancelling or closing everything, deleting the project (typing its name) succeeds. Its cards, bundles and Chat
   history disappear from the board in every open tab without a reload, and the project leaves the scope list and
   every project dropdown.
3. After the deletion:
   - `getRun`, `getBundle`, `getDiscussion` and the conversation and screenshot routes for the project's former ids
     return 404, and `listRuns({ includeCleared: true })` contains none of them;
   - the `projects.<name>` block is gone from the config file, and other projects' settings are untouched.
4. On disk, the project's worktrees, manifests, scratch dirs, environment records, `artifacts/<id>/` dirs and local
   `factory/<id>` branches are gone. Its remote `factory/<id>` branches are deleted on the (fake) GitHub, while the
   repo, its default branch and its PRs remain. The shared clone is removed unless another project binds the same repo,
   in which case it stays and that project still works.
5. Killing the factory (`kill -9`) right after the deletion's commit and starting it again finishes the deletion (config
   entry and disk) during the startup sweep. A second `factory gc` then removes nothing.
6. Creating a project with the deleted name afterwards starts empty: no overrides, the first ticket's key is
   `<PREFIX>-1`, and there is no Chat history. A new bundle or discussion gets an id never used before, e.g.
   `bundle-4` after `bundle-1..3` were purged.
7. While a deletion is in progress, a `startRun` or `startDiscussion` on that project does not create anything. It
   fails with `not_found` once the deletion completes.
