# Commits authored as the GitHub identity's account

## Context

Every commit the factory makes is stamped with a placeholder identity today:
- Host-side commits made by the core use `software-factory <factory@localhost>`, hard-coded in `src/github/git.ts` `baseEnv()`. These are the initial commit, the spec commit, snapshot `commit-tree`, "factory: commit uncommitted builder changes", the two delivery-notes commits, the bundle `merge --no-ff` and `concludeMerge`.
- Commits agents make inside the sandbox use `factory-<role> <role@factory.local>`, set in `src/sandbox/sandbox.ts` `policy()` `shellEnv`. These come from the builder and its helpers, and from the integrator while it resolves conflicts or fixes CI and review findings.

GitHub links a commit to an account by its email. These addresses belong to no account, so the commits show up unlinked.

This change makes the author **and** the committer of every factory-made commit the GitHub account behind the owner's effective (pinned) `github.identity`. That is the same identity that already authenticates the push. Settled and out of scope:
- No `git.author` override.
- No `Co-authored-by` or `Factory-Role` trailers, and no author/committer split.
- Commits stay unsigned (`commit.gpgsign=false`).
- Existing history is not rewritten.
- Commits GitHub itself creates (API squash/merge) are unchanged.

## Commit identity

`CommitIdentity = { name, email }`. It is derived from the account, never configured:

| `github.identity.kind` | Lookup | name | email |
|---|---|---|---|
| `pat`, `bot` | `GET /user` with the token → `id`, `login` | `<login>` | `<id>+<login>@users.noreply.github.com` |
| `app` | `GET /app` with the App **JWT** → `slug`; then `GET /users/<slug>%5Bbot%5D` with the installation token → `id` | `<slug>[bot]` | `<id>+<slug>[bot]@users.noreply.github.com` |

- The lookup fails if the response lacks a numeric `id` or a non-empty `login`/`slug`. There is no partial identity.
- Installation tokens are never used for `/user` or `/app`.
- The ID-based no-reply form is always used. Accounts created before July 2017 that never switched may only link through `login@users.noreply.github.com`; this is documented as a known limitation.

## Key technical decisions

### `GitHubHost.commitIdentity(id: Identity): Promise<CommitIdentity>`
This is a new method on the host seam.

- **`GhApiHost`:**
  - Makes the identity lookups as direct HTTPS requests to its `apiBase`, the same way it already requests installation tokens. It does not go through `gh api`. A test can therefore point `apiBase` at a local HTTP stub.
  - The App JWT minting now in `token()` is factored out so `/app` can use it.
  - `whoami()` can reuse the `/user` request.
- **`LocalGitHubHost`** (the fake used by tests, `scripts/run.sh` and the dry run):
  - Returns a deterministic fake identity by default: `factory-dev <1+factory-dev@users.noreply.github.com>`.
  - Has test controls (in its shared state file, so the dry-run driver can use them too) to set the account (`login`/`id`, or an app `slug`/`id`) and to make the lookup fail.
  - Logs each lookup in its `calls` log, so tests can count them.
  - The fake's own "GitHub-side" commits (the seed, fake PR merges/squashes) are GitHub's, not the factory's. They use a fixed `GitHub <noreply@github.com>` identity, never the old placeholders.

### Resolution and cache (in the `GitHub` class, `src/github/github.ts`)
- `GitHub.commitIdentity(rc)` resolves from `rc.config.github.identity`. This is the owner's pinned config, the same one `identityOf(rc)` uses for pushes.
- The result is cached per process, keyed by the identity settings: `kind`, `tokenRef`, `appId`, `installationId`, `privateKeyRef`.
  - A different `github.identity` means a new lookup. Examples are a project override, or changed settings that a new run pins.
  - Concurrent first requests for the same key share one in-flight lookup.
  - Failures are not cached, so the next operation tries again.
  - Rotating the token behind the same `tokenRef` to a different account takes effect after a restart (documented).
- Every commit-creating method takes the `RunCtx` (or the resolved identity) and passes the identity explicitly to `git()` as `GIT_AUTHOR_*` and `GIT_COMMITTER_*`. This covers:
  - `open` (initial commit), `writeArtifact`, `snapshot`/`bundle`, `commitAll`, `deliver`, the no-CI delivery-notes path, `mergeMember`, `concludeMerge` and `deliverBundle`.
- `baseEnv()` no longer sets any identity. A host-side commit must never get its identity from the operator's `~/.gitconfig`, the system config or a placeholder.
- **Failure message:** a failed lookup throws an error that names:
  - the identity: kind, plus `tokenRef` or `appId`/`installationId`; never the secret;
  - the failing call and its status or network error.

  For example: `cannot resolve the commit identity for github.identity (kind pat, tokenRef env:GH_TOKEN): GET /user failed: 401 Bad credentials`. The step that needed it fails through the existing run, bundle or discussion failure handling, and no commit is made.

### Sandbox environments
- `EnvRecord` gains `commitIdentity?: { name, email }`.
- **Provisioning:**
  - `Sandbox.provision(ws, role, rc, …)` receives the resolved identity and stores it on the record, for every role.
  - The callers resolve it before provisioning: run `PREPARING`, bundle `INTEGRATING`, discussion open. A failed lookup therefore fails that step before any agent works.
  - When `provision` finds an existing record without one (a reopened discussion), it fills it in and rewrites the record.
- **Opening an environment** (core's async `env` factory in `src/core/core.ts`, which already reads the conversation's `EnvDoc`):
  - If the record lacks `commitIdentity` (written before this change), the core resolves it from the owning run, bundle or discussion Document's pinned config, through the cache.
  - The sandbox stores it on the record before building the environment. No environment is recreated.
  - If the identity can't be resolved, opening the environment fails with the error above. It never builds a `shellEnv` without an identity.
- **`policy()`:**
  - Sets `GIT_AUTHOR_NAME/EMAIL` and `GIT_COMMITTER_NAME/EMAIL` from `rec.commitIdentity`. The role no longer appears.
  - `GIT_CONFIG_NOSYSTEM=1`, the scratch `HOME` and all secret handling (credential env-var denial, denied key files) are unchanged.
  - The name and email are not secrets. No token enters the sandbox.

### `factory doctor`
- The GitHub check resolves the commit identity for each distinct effective `github.identity`: global, and per project where it differs. It does this through `GhApiHost.commitIdentity`.
- On success it prints `commits as: <name> <<email>>`, for example `commits as: octocat <583231+octocat@users.noreply.github.com>`.
- If the lookup fails, it prints a `FAIL` line with the same message.

### Docs
- `docs/configuration.md` (GitHub identity): explain how the commit identity is derived for each kind, the no-reply format, the pre-July-2017 caveat, that the App needs no extra permission beyond `/app` via its JWT, and the restart note about rotating tokens.
- `docs/spec.md` and `docs/architecture.md`: describe the `GitHubHost.commitIdentity` seam, the `EnvRecord.commitIdentity` field and that `doctor` shows the identity.
- `DEVIATIONS.md`, if relevant.
- `AGENTS.md`'s map, if the host description changes.

## Acceptance behaviours

1. **Delivered commits, `pat` identity.** The fake host's account is set to `{ id: 583231, login: "octocat" }`. A run is taken to Ready, then a bundle of two conflicting tickets is delivered, with the builder and the integrator committing inside the sandbox. `git log --format='%an <%ae>|%cn <%ce>'` on the delivered branch shows only `octocat <583231+octocat@users.noreply.github.com>` as author and committer. That includes:
   - the spec commit;
   - the builder's own commits;
   - "factory: commit uncommitted builder changes";
   - the integration merges;
   - the integrator's conflict commit;
   - the new-repo delivery notes.
2. **`app` identity.** A `GhApiHost` pointed at a local stub serving `/app` → `{ slug: "my-app" }` and `/users/my-app%5Bbot%5D` → `{ id: 42 }` resolves `my-app[bot] <42+my-app[bot]@users.noreply.github.com>`. The stub sees the JWT on `/app` and never receives a `/user` request.
3. **No placeholders.** Grepping `src/` for `factory@localhost`, `@factory.local` or `software-factory` used as a commit identity finds nothing. The sandbox test asserts that the environment's `GIT_AUTHOR_*` and `GIT_COMMITTER_*` equal the resolved identity.
4. **Lookup failure.** With the fake host's lookup set to fail:
   - a new run fails in PREPARING, and a bundle step fails, each with a message naming the identity (kind and ref) and the failing call;
   - no commit is created;
   - no secret appears in the message.
5. **Cached lookups.** Over a run and a bundle with the same identity, the fake host logs exactly one identity lookup. A project with a different `github.identity` causes one more.
6. **Old environment records.** An environment record without `commitIdentity` (as written before this change) is reopened after a restart, for example a run mid-build. The record gains the identity, and the commits made in it are authored by the resolved identity, with no `factory-<role>` commits.
7. **Doctor.**
   - With a working identity, `factory doctor` prints `commits as: <name> <<email>>` in its GitHub check.
   - With a token that `/user` rejects, it prints a FAIL line naming the identity and `GET /user`.
8. **Credential-free runs.**
   - `scripts/run.sh` and `DRYRUN_SANDBOX=0 npm run dry-run` pass with commits authored `factory-dev <1+factory-dev@users.noreply.github.com>`.
   - `npm test` and `npm run typecheck` pass.
