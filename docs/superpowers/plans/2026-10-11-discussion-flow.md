# Discussions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add discussions: a durable single-model chat per project, with read-only repo access, sandboxed commands and
web search, that ends in draft tickets you edit and turn into runs. Each run's architect receives the discussion
summary.

**Architecture:** A second pi-durable Task, `factory.discussion`, sits beside `factory.run`. It has its own document
(`DiscussionDoc`), a new `discussant` role and a new bridge tool, `submit_tickets`. Operations only write documents;
the task does the work (opening the workspace, running turns, applying drafts), as the run task does. `createTicket`
creates the run in the same `root.commit` that links the draft. The web UI gets a Discussions tab and a discussion
view that reuses the run view's shell.

**Tech Stack:** TypeScript on Node ≥ 22 via `tsx`; `@earendil-works/pi-durable` 1.1.0; vitest; the static web UI in
`src/web/ui/` (plain JS, no build step).

**Spec:** `docs/superpowers/specs/2026-10-11-discussion-flow-design.md`. Read it before any task; section references
(§) below point into it.

## Global Constraints

- No new dependencies.
- Code style: tabs, as in the existing files under `src/`. Errors are `FactoryError` with the codes `invalid`,
  `not_found`, `conflict` and `not_pending`.
- The core never calls a model. Operations write documents; the discussion Task submits input to the Conversation.
- Discussion ids: `disc-<n>`, where `n` is the 1-based position in `DiscussionIndex`.
- Draft ids: `D<draftSeq>`.
- The submission key of turn `n` is `<id>:turn<n>`. Reminders use `<key>:nudge<k>`.
- `MAX_NUDGES = 2` (the run task's value).
- `submit_tickets` limits: the summary must not be empty; 1–20 tickets; each title non-empty and at most 200
  characters; each body non-empty.
- Thinking levels: `off | low | medium | high` (the existing `thinking` enum).
- The workspace lives at `<workdir>/discussions/<id>` on branch `factory/<id>`, with its manifest at
  `<workdir>/discussions/<id>.json`. The sandbox envId is `<id>-discussant`.
- Request meta on runs created from a discussion is `meta.discussion = { id, title, draftId, summary, siblings }`, and
  `source` is `"discussion"`.
- Test commands:
  - `npx vitest run <file>`
  - `npm test` (everything)
  - `npm run typecheck`

## Review Focus

1. **Reopening after the repo was created.** A discussion started before its project's repo existed (empty local
   workspace) is reopened after a run delivered the repo. Expected: the reopen succeeds and the workspace now holds the
   delivered code. It must not go to `FAILED` on unrelated histories. Owner: Task 2.
2. **Double-click on Create ticket.** Two `createTicket` calls on the same draft at the same time. Expected: exactly one
   run; the other call fails with `conflict`. Owner: Task 5.
3. **Restart while idle.** The factory restarts while a discussion is `OPEN` with no turn running (the common case).
   Expected: still `OPEN`, and `say` works right away. Owner: Task 6.
4. **Settings changed after start.** `discussion.model` is changed after a discussion started. Expected: later turns of
   that discussion still use the pinned model; only new discussions use the new one. Owner: Task 3.
5. **Stop that arrives too late, or during drafting.** `stopTurn` after the turn already ended, and Stop during a draft
   turn. Expected: the first is refused with `conflict` and adds no notice; the second leaves drafts and summary
   unchanged. Owner: Task 4.

---

### Task 1: The `discussant` role, `discussion.model` and `submit_tickets`

**Files:**
- Modify: `src/core/types.ts`
  - add `"discussant"` to `Role`;
  - add the discussion types (Interfaces below).
- Modify: `src/core/settings.ts`
  - `roleField` gains a fourth parameter, `inheritsFrom: "builder" | "architect" = "builder"`, used in the unset
    description;
  - schema section `discussion`;
  - `inheritDiscussion` beside `inheritHelper`, applied at both places in `effective()`.
- Modify: `src/core/core.ts` `coreRules`: validate `discussion.model.model` like a role model, with problem prefix
  `discussion.model.model:`.
- Modify: `src/core/findings.ts`: `validateTickets`.
- Modify: `src/core/bridge.ts`:
  - `"submit_tickets"` in `BridgeTool`, `ALL` and `ROLE_TOOLS.discussant = ["submit_tickets"]`;
  - every other role keeps its list, so `bridgeToolsNotFor` removes `submit_tickets` from them.
- Modify: `src/agents/prompts.ts`: `RoleDiscussant`, with the prompt from spec §1.5 written as bullets in the style of
  `RoleArchitect`.
- Modify: `src/agents/tools.ts`: `ROLE_TOOLS.discussant = [RoleDiscussant, CodingReadonly, WebSearch]`.
- Modify: `src/core/messages.ts`: export `humanContent`, and have `messageContent` build its header with it.
- Modify: `src/testing/scripted.ts`:
  - add `"submit_tickets"` to `BRIDGE_TOOLS`;
  - export `fail(message: string)`, which returns `fauxAssistantMessage([], { stopReason: "error", errorMessage: message })`.
- Test: `test/settings.test.ts`, `test/findings.test.ts`

**Interfaces:**
- Produces (in `src/core/types.ts`):
  ```ts
  export type DiscussionId = string;
  export const DISCUSSION_STATES = ["PREPARING", "OPEN", "CLOSED", "FAILED"] as const;
  export type DiscussionState = (typeof DISCUSSION_STATES)[number];
  export interface Draft { id: string; title: string; body: string; edited: boolean; batch: number; runId?: RunId }   // batch: which submit_tickets submission it came from (1-based)
  export interface DiscussionNotice { at: number; kind: "error" | "stopped" | "no_submission"; text: string }
  export interface TurnCost { turn: number; kind: "say" | "draft"; usd: number; totalTokens: number; durationMs: number }
  export interface DiscussionView {
    id: DiscussionId; project: string; repo: RepoRef; title: string; state: DiscussionState; error?: string;
    model: { model: string; thinking: string }; conversationId?: string;
    turn: { kind: "say" | "draft"; startedAt: number } | null;
    summary?: string; drafts: Draft[]; notices: DiscussionNotice[];
    cost: { usd: number; totalTokens: number }; turnCosts: TurnCost[];
    runs: { id: RunId; state: RunState }[]; workspace?: Workspace; createdAt: number; updatedAt: number;
  }
  ```
- Produces: `validateTickets(input: unknown): { ok: true; payload: { summary: string; tickets: { title: string; body: string }[] } } | { ok: false; problems: string[] }`. It trims titles.
- Produces: `humanContent(by: string, msgId: string, text: string): { type: "text"; text: string }[]`. It returns the
  same header `parseMessage` reads, followed by the text, with no situation note.
- Produces: the `discussion` settings section, with effective value
  `discussion.model = { model, thinking }`. If either field is unset at every layer, it takes the architect's effective
  value.

- [ ] **Step 1: Write the failing tests**

  In `test/settings.test.ts`, following the file's existing `ConfigStore` and `makeFactory` style:
  ```ts
  test("discussion.model falls back to the architect's model and thinking; a project override wins", async () => {
    // global: roles.architect = { model: scripted/architect, thinking: high }, no discussion section
    expect(eff({ global: true }).discussion.model).toEqual({ model: "scripted/architect", thinking: "high" });
    await f.setSetting({ project: "p" }, "discussion.model.model", "scripted/builder");
    expect(eff({ project: "p" }).discussion.model).toEqual({ model: "scripted/builder", thinking: "high" });
    expect((await f.getSettings({ project: "p" }))["discussion.model.model"]).toEqual({ value: "scripted/builder", source: "project" });
  });
  test("discussion.model.model must be a known model; policy.messages cannot list discussant", async () => {
    await expect(f.setSetting({ global: true }, "discussion.model.model", "scripted/nope")).rejects.toThrow(/discussion\.model\.model: .* is not a model/);
    await expect(f.setSetting({ global: true }, "policy.messages", ["discussant"])).rejects.toThrow(/expected one of/);
  });
  ```
  In `test/findings.test.ts`:
  ```ts
  test("validateTickets", () => {
    expect(validateTickets({ summary: "s", tickets: [{ title: " A ", body: "b" }] })).toEqual({ ok: true, payload: { summary: "s", tickets: [{ title: "A", body: "b" }] } });
    const bad = validateTickets({ summary: " ", tickets: [{ title: "x".repeat(201), body: "" }] });
    expect(bad.ok).toBe(false);
    expect((bad as any).problems).toEqual(expect.arrayContaining([
      "summary is required", "tickets[0]: title is longer than 200 characters", "tickets[0]: body is required"]));
    expect((validateTickets({ summary: "s", tickets: [] }) as any).problems).toContain("give 1 to 20 tickets");
    expect((validateTickets({ summary: "s", tickets: Array(21).fill({ title: "t", body: "b" }) }) as any).problems).toContain("give 1 to 20 tickets");
  });
  ```

- [ ] **Step 2: Run them and confirm they fail**

  Run: `npx vitest run test/settings.test.ts test/findings.test.ts`
  Expected: FAIL. `discussion` is undefined and `validateTickets` is not exported.

- [ ] **Step 3: Implement the files listed above**

  - `submit_tickets` uses `bridgeTool` with a TypeBox schema:
    `{ summary: String, tickets: Array(Object({ title: String, body: String })) }`. The tool description is the
    drafting rule from spec §2.2: one ticket per piece of work that can be specified, built and reviewed on its own;
    each body a self-contained request. The reply is `"Tickets submitted."`.
  - Add `discussant` to `ROLE_TOOLS` in both files, and wherever the compiler reports a `Record<Role, …>` (for example
    `prompts`). Run `npm run typecheck` to find them all.

- [ ] **Step 4: Run the tests and confirm they pass**

  Run: `npx vitest run test/settings.test.ts test/findings.test.ts && npm run typecheck`
  Expected: PASS, and no type errors.

- [ ] **Step 5: Commit**

  ```bash
  git add -A src test
  git commit -m "feat: discussant role, discussion.model setting, submit_tickets bridge tool"
  ```

### Task 2: The discussion workspace in `GitHub`

**Files:**
- Modify: `src/github/github.ts`
- Test: `test/discussion.test.ts` (new; `describe("workspace")`)

**Interfaces:**
- Produces:
  `GitHub.open(ref: RepoRef, rc: RunCtx, area: "runs" | "discussions" = "runs"): Promise<Workspace>`.
  - `area` picks `<workdir>/<area>/<rc.runId>` and its `.json` manifest. Everything else is unchanged.
- Produces: `GitHub.refresh(ws: Workspace, rc: RunCtx): Promise<Workspace>`, which brings a discussion worktree up to
  date with the repo:
  - **Existing repo** (`!ws.newRepo`): fetch `origin`, then `git merge --ff-only origin/<default>` in the worktree.
    Return `ws` with `baseRef` set to the new head, and rewrite the manifest.
  - **`ws.newRepo` and the repo still doesn't exist:** return `ws` unchanged.
  - **`ws.newRepo` and the repo now exists:** remove the worktree (`git worktree remove --force`), its branch and its
    manifest, then return `open(ws.repo, rc, "discussions")`. The local clone, created by `git init`, gets `origin`
    added and fetched as `open` already does. If `open` would branch from a stale local `main`, make it branch from
    `origin/<default>`.
  - A failed fast-forward throws `Error("could not fast-forward the discussion's checkout to origin/<default>: <git output>")`.

- [ ] **Step 1: Write the failing tests**

  Use `makeFactory()` from `test/helpers.ts` for `t.host`, `t.dir` and `t.factory.config`. Build `rc` as
  `{ runId: "disc-1", config: t.factory.config.effective({ project: "p" }) }`. Seed remote repos the way
  `test/machine.test.ts` does for existing repos (`t.host` helpers).
  ```ts
  test("open(…, 'discussions') checks out under <workdir>/discussions/<id>", async () => {
    const ws = await gh.open("me/p", rc, "discussions");
    expect(ws.path).toBe(join(t.dir, "work", "discussions", "disc-1"));
    expect(existsSync(join(t.dir, "work", "discussions", "disc-1.json"))).toBe(true);
  });
  test("refresh fast-forwards to the default branch", async () => {
    const ws = await gh.open("me/p", rc, "discussions");
    const head = await pushCommit("me/p", "NEW.md", "new\n");   // a commit on the remote's default branch
    const ws2 = await gh.refresh(ws, rc);
    expect(ws2.baseRef).toBe(head);
    expect(readFileSync(join(ws2.path, "NEW.md"), "utf8")).toBe("new\n");
  });
  test("refresh of a new-repo workspace after the repo was created gives the delivered code", async () => {  // Review Focus 1
    const ws = await gh.open("me/new", rc, "discussions");
    expect(ws.newRepo).toBe(true);
    await createRemoteWith("me/new", "README.md", "delivered\n");   // the repo now exists with a commit on main
    const ws2 = await gh.refresh(ws, rc);
    expect(ws2.newRepo).toBe(false);
    expect(readFileSync(join(ws2.path, "README.md"), "utf8")).toBe("delivered\n");
  });
  ```
  `pushCommit` and `createRemoteWith` are small local helpers in the test file. They clone the bare remote
  (`t.host.bare(repo)`, creating it through `LocalGitHubHost` if needed), commit and push.

- [ ] **Step 2: Run them and confirm they fail**

  Run: `npx vitest run test/discussion.test.ts -t workspace`
  Expected: FAIL. `open` ignores the third argument, and `refresh` is not a function.

- [ ] **Step 3: Implement `open`'s `area` parameter and `refresh` in `src/github/github.ts`**

- [ ] **Step 4: Run the tests and confirm they pass**

  Run: `npx vitest run test/discussion.test.ts -t workspace && npx vitest run test/machine.test.ts`
  Expected: PASS. The run tests are unchanged.

- [ ] **Step 5: Commit**

  ```bash
  git add src/github/github.ts test/discussion.test.ts
  git commit -m "feat: discussion workspaces (open under discussions/, refresh)"
  ```

### Task 3: The discussion Task, life cycle and chat turns

**Files:**
- Create: `src/core/discussion-doc.ts`: `DiscussionDoc` (a doc family keyed by id, like `RunDoc`), `DiscussionIndex`
  (`{ ids: string[] }`, scope session) and `toDiscussionView`.
- Create: `src/core/discussion-task.ts`: `createDiscussionTask(svc: DiscussionServices)`.
- Modify: `src/core/core.ts`:
  - register the task;
  - cache, index and emit discussion events;
  - the operations below;
  - `subscribe` filter `discussion`;
  - map conversations whose `EnvDoc.role === "discussant"` to their discussion.
- Modify: `src/core/types.ts`:
  - the operations in `FactoryCore` and `CORE_OPS`;
  - the events from spec §2.1;
  - `subscribe(filter: { project?: string; run?: RunId; discussion?: DiscussionId }, …)`.
- Modify: `test/helpers.ts`:
  - the `discussant` script;
  - `Control` fields;
  - the config line `discussion: { model: { model: scripted/discussant } }`;
  - `untilDiscussion`.
- Test: `test/discussion.test.ts` (`describe("life cycle")`, `describe("turns")`)

**Interfaces:**
- Consumes:
  - Task 1's types and `humanContent`;
  - Task 2's `open(…, "discussions")` and `refresh`;
  - `Sandbox.provision(ws, "discussant", rc)`.
- Produces: `DiscussionDocState`, exactly as in spec §1.1, plus:
  - `taskId?: string`;
  - `turnCosts: TurnCost[]`;
  - `turn` extended to
    `{ kind: "say" | "draft"; key: string; seq: number; text: string; by: string; msgId?: string; startedAt: number; stopRequested?: boolean } | null`.
    `text` is the content to submit: for `say`, the human's text; for `draft`, the drafting instructions.
  - `firstMessage: { text: string; by: string }` (consumed by the first turn);
  - `counters: { turnSeq: number; draftSeq: number; batch: number }`.

  `reopenDiscussion` and `retryDiscussion` check that the old task is terminal with `harness.getTask`, as
  `retryRun` does.
- Produces: `DiscussionServices = Pick<CoreServices, "github" | "sandbox" | "bridge" | "now" | "log"> & { changed(id: string, ms: number): Promise<void> }`.
  `Factory.changed` is reused; its waiter map is keyed by any document id.
- Produces: these `Factory` operations, with the refusals from spec §2.1:
  ```ts
  startDiscussion(project: string, d: { title: string; message: string; model?: { model: string; thinking: string } }): Promise<DiscussionId>;
  getDiscussion(id): Promise<DiscussionView>;
  listDiscussions(filter?: { project?: string; states?: DiscussionState[] }): Promise<DiscussionView[]>;
  getDiscussionConversation(id): Promise<TranscriptView>;   // same item mapping as getConversation; role "discussant"
  say(id, text): Promise<void>;
  stopTurn(id): Promise<void>;
  closeDiscussion(id): Promise<void>;
  reopenDiscussion(id): Promise<void>;
  retryDiscussion(id): Promise<void>;
  waitForDiscussion(id, pred: (v: DiscussionView) => boolean, timeoutMs = 30_000): Promise<DiscussionView>;   // test helper like waitForState
  ```
  Factor the entry→item mapping out of `getConversation` into a private `transcript(conversationId)` and use it in
  both.
- Produces for Task 4: `runTurn(rt, c, d)` handles `turn.kind === "draft"` through a hook, `draftTurn`, that Task 4
  fills in. In this task a draft turn may throw `"not implemented"`.

**How the Task works** (decisions the spec leaves open):
- **Task definition:** `defineTask` with name `factory.discussion`, version 1, input
  `{ discussionId: string; start: "PREPARING" }` and phases `PREPARING`, `OPEN` and `FINAL`. It is created as
  `ownership: { kind: "conversation" }, background: true`, like runs.
- **`PREPARING`:**
  - If `doc.workspace` is unset, call `github.open(repo, rc, "discussions")`; otherwise call `github.refresh`.
  - Then call `sandbox.provision(ws, "discussant", rc)`.
  - If there is no `conversationId`, create the Conversation:
    - copy `createRoleConversation` in `run-task.ts`: `EnvDoc` with `runId: <discussion id>`, `role: "discussant"`
      and the envId; `RunConfigDoc.webSearch` from the pinned config;
    - remove the write tools and `bridgeToolsNotFor("discussant")`;
    - use `cwd` = the env's cwd and the pinned model and thinking level.
  - Commit `state: "OPEN"`. On the first prepare only, also set `turn` to a `say` turn whose `text` is the first input
    (spec §1.5 format, which includes the human's first message).
  - On any error, commit `state: "FAILED"` and `error`, and the task ends terminal.
- **`OPEN`**, a loop:
  - **Exit:** if `state !== "OPEN"` (closed by the operation), commit terminal.
  - **A turn is set:** run it.
    1. Snapshot `UsageDoc` before; this is memoised by key.
    2. Submit. The first turn sends the first input as plain factory text. Every later `say` turn sends
       `humanContent(by, msgId, text)`. The request id is `turn.key`.
    3. `await sub.wait(c)`.
    4. Re-read the doc. If `stopRequested`, add a `stopped` notice ("Stopped by <by>").
    5. Otherwise, if the last assistant entry of this turn has `stopReason === "error"`, add an `error` notice with its
       `errorMessage`.
    6. Push a `TurnCost`, clear `turn`, and set `updatedAt`.
  - **No turn:** wait with `Promise.race([svc.changed(id, 1000), rt.sleep(svc.now() + 1000, c).catch(() => undefined)])`.
- **Operations** commit through `this.root.commit`. They check state inside the commit and throw `FactoryError`.
  - `say`: increments `counters.turnSeq` and sets `turn`.
  - `stopTurn`: sets `turn.stopRequested`, then calls `(await harness.conversation(convId)).abort(ctx)`.
  - `closeDiscussion`: sets `state: "CLOSED"`.
  - `reopenDiscussion` and `retryDiscussion`: like `retryRun`. They require the old task to be terminal, set
    `state: "PREPARING"`, delete `error`, and create a new task in the same commit.
- **Events:** `onDiscussionChange(prev, next)` emits:
  - `discussion.state` when the state changed;
  - `discussion.updated`: `turn.started` when the turn goes null→set, `turn.ended` when it goes set→null, `drafts`
    when the summary or the draft ids/texts changed, `ticket` when any `runId` appeared, and `notice` when notices
    grew.
  
  `emit(e, scope)` gets `scope: { project: string; run?: string; discussion?: string }`. A listener with a `run` filter
  only gets events whose scope has that run, and likewise for `discussion`.

**The test script** (`test/helpers.ts`)
- `Control` gains:
  - `discussantInputs: string[]` (factory inputs);
  - `discussantHeard: string[]` (human texts);
  - `discussantModels: string[]`;
  - `discussantHang?: boolean`;
  - `discussantFail?: string`;
  - `draftPlan: string[]` (used by Task 4).
- **`discussant(ctx)`**, for factory inputs:
  - record `ctx.input` and `ctx.model`;
  - for `# Discussion` inputs: at turn 0, call `bash {command: "ls -1a"}`; then `say("first reply")`.
- **`discussant.onMessage(ctx)`**, for human turns:
  - record the human text and model;
  - while `control.discussantHang`, wait in 50 ms steps;
  - if `discussantFail` is set, return `fail(discussantFail)`;
  - if the text starts with `WRITE:`, call `write {path: "x.txt", content: "x"}` at turn 0;
  - otherwise `say("re: <text>")`.
- **Registration:** register it as both `discussant` and `discussant-b` (for Review Focus 4).

- [ ] **Step 1: Write the failing tests** (`test/discussion.test.ts`)

  ```ts
  const open = (v: DiscussionView) => v.state === "OPEN" && v.turn === null;
  test("start → OPEN; the first input carries the project context and the first message; the model read the repo", async () => {
    const id = await t.factory.startDiscussion("p", { title: "auth?", message: "how should login work?" });
    expect(id).toBe("disc-1");
    const v = await t.factory.waitForDiscussion(id, open);
    expect(v.model).toEqual({ model: "scripted/discussant", thinking: "high" });   // thinking falls back to the architect's default
    expect(t.control.discussantInputs[0]).toMatch(/^# Discussion\nTitle: auth\?[\s\S]*# Project\nProject: p; repo binding: me\/p[\s\S]*# The human's first message\nhow should login work\?/);
    const tv = await t.factory.getDiscussionConversation(id);
    expect(tv.role).toBe("discussant");
    expect(tv.items.some((i) => i.toolResult?.name === "bash" && !i.toolResult.isError)).toBe(true);
    expect(v.turnCosts).toHaveLength(1);
  });
  test("say gets a reply shown as a human message; say during a turn and on a closed discussion is refused", async () => {
    await t.factory.as("web").say(id, "what about SSO?");
    await t.factory.waitForDiscussion(id, open);
    const items = (await t.factory.getDiscussionConversation(id)).items;
    expect(items.find((i) => i.author === "human")).toMatchObject({ by: "web", text: "what about SSO?" });
    expect(items.at(-1)).toMatchObject({ role: "assistant", text: "re: what about SSO?" });
    t.control.discussantHang = true;
    await t.factory.say(id, "slow");
    await expect(t.factory.say(id, "again")).rejects.toMatchObject({ code: "conflict" });
    t.control.discussantHang = false;
    await t.factory.waitForDiscussion(id, open);
    await t.factory.closeDiscussion(id);
    await t.factory.waitForDiscussion(id, (v) => v.state === "CLOSED");
    await expect(t.factory.say(id, "x")).rejects.toMatchObject({ code: "conflict" });
  });
  test("reopen fast-forwards the checkout and keeps the Conversation", async () => { /* close, push a commit, reopen → OPEN, workspace.baseRef = new head, same conversationId */ });
  test("a failed start goes to FAILED; retry recovers", async () => { /* make github.open throw once (spy on t.factory's GitHub via vi.spyOn(GitHub.prototype, "open")) → FAILED with the message in error; retryDiscussion → OPEN */ });
  test("Stop aborts a running turn and adds a stopped notice", async () => { /* hang, say, stopTurn → turn null, notices.at(-1).kind === "stopped", state OPEN */ });
  test("a provider error ends the turn with an error notice; the discussion stays OPEN", async () => {
    t.control.discussantFail = "rate limited";
    await t.factory.say(id, "hi");
    const v = await t.factory.waitForDiscussion(id, open);
    expect(v.notices.at(-1)).toMatchObject({ kind: "error", text: expect.stringContaining("rate limited") });
  });
  test("the discussant has no write tools", async () => {
    await t.factory.say(id, "WRITE: try");
    await t.factory.waitForDiscussion(id, open);
    const res = (await t.factory.getDiscussionConversation(id)).items.find((i) => i.toolResult?.name === "write");
    expect(res?.toolResult?.isError).toBe(true);
    expect(existsSync(join((await t.factory.getDiscussion(id)).workspace!.path, "x.txt"))).toBe(false);
  });
  test("the pinned model is kept when discussion.model changes later", async () => {   // Review Focus 4
    await t.factory.setSetting({ project: "p" }, "discussion.model.model", "scripted/discussant-b");
    await t.factory.say(id, "still you?");
    await t.factory.waitForDiscussion(id, open);
    expect(t.control.discussantModels.at(-1)).toBe("discussant");
    const id2 = await t.factory.startDiscussion("p", { title: "t2", message: "m" });
    expect((await t.factory.waitForDiscussion(id2, open)).model.model).toBe("scripted/discussant-b");
  });
  test("refusals: unknown id, unknown project, empty text, unknown model", async () => {
    await expect(t.factory.getDiscussion("disc-99")).rejects.toMatchObject({ code: "not_found" });
    await expect(t.factory.startDiscussion("nope", { title: "t", message: "m" })).rejects.toMatchObject({ code: "not_found" });
    await expect(t.factory.startDiscussion("p", { title: " ", message: "m" })).rejects.toMatchObject({ code: "invalid" });
    await expect(t.factory.startDiscussion("p", { title: "t", message: "m", model: { model: "scripted/nope", thinking: "low" } })).rejects.toMatchObject({ code: "invalid" });
  });
  test("events: discussion.state and discussion.updated reach project and discussion subscribers, not run subscribers", async () => { /* subscribe three ways, start, assert */ });
  ```
  In `test/sandbox.test.ts` (it is skipped without bubblewrap), add, next to the reviewer case:
  `"the discussant cannot write the worktree with bash but can write its scratch dir"`. Copy the reviewer case's
  provisioning, with role `"discussant"`.

- [ ] **Step 2: Run them and confirm they fail**

  Run: `npx vitest run test/discussion.test.ts -t "life cycle|turns"`
  Expected: FAIL. `startDiscussion` is not a function.

- [ ] **Step 3: Implement `discussion-doc.ts`, `discussion-task.ts`, the core operations and events, and the test script**

- [ ] **Step 4: Run the tests and confirm they pass**

  Run: `npx vitest run test/discussion.test.ts && npm test && npm run typecheck`
  Expected: all PASS. Existing suites are unchanged; `getConversation` still passes `test/messages.test.ts`.

- [ ] **Step 5: Commit**

  ```bash
  git add -A src test
  git commit -m "feat: discussion task: workspace, single-model chat turns, stop, close/reopen/retry, events"
  ```

### Task 4: Drafting tickets

**Files:**
- Modify: `src/core/discussion-task.ts` (the `draftTurn` hook)
- Modify: `src/core/core.ts`: `requestDrafts`, `updateDraft` and `deleteDraft`, in `FactoryCore` and `CORE_OPS`
- Modify: `test/helpers.ts`: drafting in the discussant script
- Test: `test/discussion.test.ts` (`describe("drafting")`)

**Interfaces:**
- Consumes:
  - Task 1's `submit_tickets` and `validateTickets`;
  - Task 3's turn machinery and `BridgeDoc` (`src/core/bridge.ts`).
- Produces:
  ```ts
  requestDrafts(id: DiscussionId, instructions?: string): Promise<void>;
  updateDraft(id: DiscussionId, draft: string, change: { title?: string; body?: string }): Promise<void>;   // sets edited: true
  deleteDraft(id: DiscussionId, draft: string): Promise<void>;
  ```
- Produces: `draftInstructions(instructions?: string): string`, exported from `discussion-task.ts`. It returns the
  spec §2.2 text and starts with the line `# Draft tickets`.

**How a draft turn works:**
- Set `BridgeDoc.expect = { key: turn.key, tools: ["submit_tickets"] }` in the commit that starts the turn. Clear it
  when the turn ends.
- Submit `draftInstructions(...)` as factory text.
- After each `sub.wait`, read `BridgeDoc.results[turn.key]`.
- If there is no result and the turn wasn't stopped, send up to `MAX_NUDGES` reminders with request ids
  `<key>:nudge<k>`. Use the run task's reminder wording, with the tool name `submit_tickets`.
- **With a result:** in one commit:
  - set `summary`;
  - increment `counters.batch`;
  - drop the drafts without a `runId`;
  - append the new drafts (`D<++draftSeq>`, `edited: false`, `batch: counters.batch`).
- **Without a result:** add a `no_submission` notice, "The model did not submit draft tickets; the drafts are
  unchanged".
- **Stopped:** add a `stopped` notice and make no draft changes, even if a result arrived after the stop was
  requested.

**The test script:** `discussant(ctx)` for an input starting with `# Draft tickets` first waits while
`control.discussantHang` (at turn 0), then follows `control.draftPlan.shift() ?? "ok"`:
- `"ok"`: call `submit_tickets` with summary `"S: settled X; open Y"` and tickets `[{title: "API", body: "B1"}, {title: "UI", body: "B2"}]`;
- `"invalid-then-ok"`: first send an empty summary, then, after the error result, the ok payload;
- `"none"`: say `"thinking"` on every turn, never submitting;
- `"one"`: a single ticket `{title: "Only", body: "B"}`.

- [ ] **Step 1: Write the failing tests**

  ```ts
  test("requestDrafts stores the summary and drafts; instructions reach the model", async () => {
    await t.factory.requestDrafts(id, "split API and UI");
    const v = await t.factory.waitForDiscussion(id, open);
    expect(v.summary).toBe("S: settled X; open Y");
    expect(v.drafts).toEqual([{ id: "D1", title: "API", body: "B1", edited: false, batch: 1 }, { id: "D2", title: "UI", body: "B2", edited: false, batch: 1 }]);
    expect(t.control.discussantInputs.at(-1)).toMatch(/^# Draft tickets[\s\S]*split API and UI/);
  });
  test("an invalid submission gets the problems back and the next one counts", async () => { /* draftPlan ["invalid-then-ok"] → drafts length 2; transcript has a submit_tickets error result containing "summary is required" */ });
  test("no submission after 2 reminders: notice, drafts unchanged", async () => { /* drafts D1,D2 exist; draftPlan ["none"] → notices.at(-1).kind === "no_submission"; drafts unchanged; transcript has 2 user items matching /You stopped without calling submit_tickets/ */ });
  test("a redraft replaces every unconverted draft, edited or not", async () => { /* updateDraft D1; draftPlan ["one"]; requestDrafts → drafts = [{ id: "D3", title: "Only", batch: 2, … }] (converted drafts surviving a redraft are tested in Task 5) */ });
  test("updateDraft and deleteDraft; refused during a draft turn and for unknown drafts", async () => {
    await t.factory.updateDraft(id, "D1", { body: "edited" });
    expect((await t.factory.getDiscussion(id)).drafts[0]).toMatchObject({ body: "edited", edited: true });
    await expect(t.factory.updateDraft(id, "D1", { title: " " })).rejects.toMatchObject({ code: "invalid" });
    await expect(t.factory.deleteDraft(id, "D9")).rejects.toMatchObject({ code: "not_found" });
    t.control.discussantHang = true; /* the drafting script also waits on discussantHang at turn 0 */
    await t.factory.requestDrafts(id);
    await expect(t.factory.updateDraft(id, "D1", { body: "x" })).rejects.toMatchObject({ code: "conflict" });
    t.control.discussantHang = false;
  });
  test("Stop during drafting leaves drafts unchanged; Stop with no turn is refused without a notice", async () => {   // Review Focus 5
    const before = await t.factory.waitForDiscussion(id, open);
    await expect(t.factory.stopTurn(id)).rejects.toMatchObject({ code: "conflict" });
    expect((await t.factory.getDiscussion(id)).notices).toHaveLength(before.notices.length);
    t.control.discussantHang = true;
    await t.factory.requestDrafts(id);
    await t.factory.stopTurn(id);
    t.control.discussantHang = false;
    const v = await t.factory.waitForDiscussion(id, open);
    expect(v.drafts).toEqual(before.drafts);
    expect(v.summary).toBe(before.summary);
    expect(v.notices.at(-1)!.kind).toBe("stopped");
  });
  ```

- [ ] **Step 2: Run them and confirm they fail**

  Run: `npx vitest run test/discussion.test.ts -t drafting`
  Expected: FAIL. `requestDrafts` is not a function.

- [ ] **Step 3: Implement the draft turn and the three operations**

- [ ] **Step 4: Run the tests and confirm they pass**

  Run: `npx vitest run test/discussion.test.ts && npm run typecheck`
  Expected: PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add -A src test
  git commit -m "feat: draft tickets in discussions (submit_tickets turn, reminders, edit/delete)"
  ```

### Task 5: Handing drafts to runs

**Files:**
- Modify: `src/core/core.ts`:
  - move `startRun`'s seed and commit body into
    `private async createRunIn(tx: Tx, project: string, request: Omit<Request, "id" | "project">): Promise<RunId>`,
    and have `startRun` call it;
  - add `createTicket`.
- Modify: `src/core/run-task.ts`: `architectFirstInput` adds the `# Prior discussion` section (spec §2.3, verbatim)
  before its last line when `d.request.meta?.discussion` is set.
- Modify: `src/core/discussion-doc.ts`: `toDiscussionView` fills `runs` from the drafts' `runId`s. Pass it a lookup:
  `toDiscussionView(d, cost, runState: (id) => RunState | undefined)`, which `core.ts` serves from its run cache.
- Modify: `src/core/types.ts`: `createTicket` in `FactoryCore` and `CORE_OPS`.
- Test: `test/discussion.test.ts` (`describe("handoff")`)

**Interfaces:**
- Consumes: Task 4's drafts and summary; `startRun`'s seed (`src/core/core.ts:375-403`).
- Produces: `createTicket(id: DiscussionId, draft: string): Promise<RunId>`.
  - Allowed on `OPEN` or `CLOSED`, when the draft has no `runId` and no `draft` turn is running.
  - The run's request is spec §2.3's, with `siblings` = the titles of the other drafts with the same `batch`.
  - The `RunIndex` push, `RunDoc` seed, `createTask` and `draft.runId = runId` all happen in one
    `this.root.commit`. The draft check happens inside that commit, so the second of two concurrent calls throws
    `conflict`.

- [ ] **Step 1: Write the failing tests**

  ```ts
  test("createTicket starts a run whose architect gets the summary and the sibling titles", async () => {
    const run = await t.factory.createTicket(id, "D1");
    const r = await t.factory.getRun(run);
    expect(r.request).toMatchObject({ source: "discussion", title: "API", body: "B1",
      meta: { discussion: { id, title: "auth?", draftId: "D1", summary: "S: settled X; open Y", siblings: ["UI"] } } });
    await until(t.factory, run, (v) => v.conversations.architect !== undefined && t.control.architectInputs.length > 0);
    expect(t.control.architectInputs.at(-1)).toMatch(/# Prior discussion\n[\s\S]*S: settled X; open Y[\s\S]*- UI[\s\S]*Treat points the summary marks as settled as settled/);
    expect((await t.factory.getDiscussion(id)).drafts[0]!.runId).toBe(run);
    expect((await t.factory.getDiscussion(id)).runs).toEqual([{ id: run, state: expect.any(String) }]);
  });
  test("a second createTicket on the same draft is refused; two at once give one run", async () => {   // Review Focus 2
    const results = await Promise.allSettled([t.factory.createTicket(id, "D2"), t.factory.createTicket(id, "D2")]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason).toMatchObject({ code: "conflict" });
    expect((await t.factory.listRuns()).filter((r) => (r.request.meta as any)?.discussion?.draftId === "D2")).toHaveLength(1);
  });
  test("createTicket works on a CLOSED discussion; converted drafts are read-only and survive a redraft", async () => { /* close, createTicket D?, updateDraft on it → conflict; reopen, redraft "one" → converted draft kept */ });
  test("runs without a discussion keep the old architect input", async () => { /* plain startRun → architectInputs.at(-1) has no "# Prior discussion" */ });
  ```

- [ ] **Step 2: Run them and confirm they fail**

  Run: `npx vitest run test/discussion.test.ts -t handoff`
  Expected: FAIL. `createTicket` is not a function.

- [ ] **Step 3: Implement `createRunIn`, `createTicket`, the architect section and `runs` in the view**

- [ ] **Step 4: Run the tests and confirm they pass**

  Run: `npx vitest run test/discussion.test.ts test/machine.test.ts test/messages.test.ts && npm run typecheck`
  Expected: PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add -A src test
  git commit -m "feat: create runs from discussion drafts; the architect gets the discussion summary"
  ```

### Task 6: Durability

**Files:**
- Modify: `test/durability.test.ts` (new `describe("discussions")`); follow its existing sqlite + `reopen()` pattern.
- Modify: `src/core/core.ts` and `src/core/discussion-task.ts`, only if the tests expose a gap. The likely ones:
  - `loadCache` must also load `DiscussionIndex`;
  - the conversation map must be rebuilt for discussions.

**Interfaces:**
- Consumes: Tasks 3–5.

- [ ] **Step 1: Write the failing tests**

  The file's existing pattern: `makeFactory({ storage: "sqlite" })`, then `await t.factory.close()` or a simulated
  kill as the file does it, then `await t.reopen()`.
  ```ts
  test("restart while idle: still OPEN and say works at once", async () => {   // Review Focus 3
    const id = await t.factory.startDiscussion("p", { title: "t", message: "m" });
    await t.factory.waitForDiscussion(id, open);
    await restart();
    expect((await t.factory.getDiscussion(id)).state).toBe("OPEN");
    await t.factory.say(id, "after restart");
    expect((await t.factory.waitForDiscussion(id, open)).turnCosts).toHaveLength(2);
    expect(t.control.discussantHeard).toContain("after restart");
  });
  test("crash mid-turn: the turn resumes and finishes once", async () => { /* hang in say → restart (hang cleared) → OPEN; transcript has exactly one human item "slow" */ });
  test("crash after submit_tickets is recorded: drafts are applied once", async () => { /* hang the scripted provider right after submit_tickets (a draftPlan "ok-then-hang" that hangs on the turn after the tool result) → restart → drafts D1,D2 exactly */ });
  test("crash right after createTicket commits: one run, linked, and it proceeds", async () => { /* createTicket → restart immediately → listRuns has one run with that draftId, draft.runId equals it, run reaches DISCUSSING or later */ });
  ```

- [ ] **Step 2: Run them**

  Run: `npx vitest run test/durability.test.ts -t discussions`
  Expected: either PASS straight away (Tasks 3–5 were built for this) or a FAIL that points at a cache or index gap.

- [ ] **Step 3: Fix any gap the failures show, in the files named above**

- [ ] **Step 4: Run the tests and confirm they pass**

  Run: `npx vitest run test/durability.test.ts && npm run typecheck`
  Expected: PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add -A src test
  git commit -m "test: discussions survive restarts and crashes mid-turn, mid-draft and at ticket creation"
  ```

### Task 7: Web server: discussion events over HTTP

**Files:**
- Modify: `src/web/server.ts`:
  - `/api/events` reads `discussion=` as well as `run=` and `project=`, and passes it into the filter;
  - update the header comment.
- Test: `test/web.test.ts`

**Interfaces:**
- Consumes: Task 3's `subscribe` filter and the operations in `CORE_OPS`.

- [ ] **Step 1: Write the failing test**

  Follow the existing "operations go through the allowlist" and "event stream" tests:
  ```ts
  test("discussion operations over HTTP, their error codes, and the discussion event filter", async () => {
    const id = (await op("startDiscussion", "p", { title: "t", message: "m" })).result;
    expect(id).toBe("disc-1");
    const es = await events(`discussion=${id}`);        // collects SSE frames
    await waitFor(() => es.got.some((e) => e.type === "discussion.state" && e.to === "OPEN"));
    expect(es.got.every((e) => e.discussion === id)).toBe(true);
    expect((await op("say", "disc-9", "x")).code).toBe("not_found");   // 404
    expect((await op("say", id, "")).code).toBe("invalid");            // 400
  });
  ```

- [ ] **Step 2: Run it and confirm it fails**

  Run: `npx vitest run test/web.test.ts -t discussion`
  Expected: FAIL. Events from other subscriptions leak in, because `discussion=` is ignored.

- [ ] **Step 3: Implement the filter in `src/web/server.ts`**

- [ ] **Step 4: Run the tests and confirm they pass**

  Run: `npx vitest run test/web.test.ts`
  Expected: PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add src/web/server.ts test/web.test.ts
  git commit -m "feat: web server: discussion event filter"
  ```

### Task 8: Web UI

**Files:**
- Modify: `src/web/ui/index.html`:
  - the `Discussions` nav button between Board and Settings;
  - `<main class="view" id="view-discussions" hidden>` with a header (project filter, a Show closed chip,
    New discussion) and `<div id="disc-list">`.
- Create: `src/web/ui/discussions.js`: the list, the New discussion modal, the discussion view and the drafts panel.
  - Load it with `<script src="/discussions.js" defer>` after `app.js`. Both are classic scripts, so the helpers in
    `app.js` (`core`, `$`, `esc`, `md`, `act`, `toast`, `openModal`, `money`, transcript rendering) are shared
    globals.
  - Keep `app.js` to the hooks below.
- Modify: `src/web/server.ts` `STATIC`: add `"/discussions.js"`.
- Modify: `src/web/ui/app.js`:
  - `showView` knows `"discussions"`;
  - `onEvent` forwards `discussion.*` events to `onDiscussionEvent`;
  - `boot` loads `listDiscussions()` and opens `#disc=<id>`;
  - the run view's ticket details show "From discussion: <title>" (a button that calls `openDiscussion(id)`) when
    `r.request.meta?.discussion`;
  - board cards show a small marker for such runs.
- Modify: `src/web/ui/app.css`: styles for the list rows, draft cards and the marker, reusing existing classes and
  variables.
- Test: `test/web.test.ts`, extending the existing `"app.js parses; index.html loads only same-origin files and has no inline script"` test.

**Interfaces:**
- Consumes: the operations from Tasks 3–5; `discussion.*` events.
- Produces (globals in `discussions.js`):
  - `renderDiscussions()`
  - `openDiscussion(id)`
  - `onDiscussionEvent(e)`

**Behaviour**, from spec §3. These are the decisions the spec leaves to the implementer:
- **The discussion view reuses the `#runview` shell.** `ui.mode = "discussion"`:
  - hides `#rv-progress`, the threads rail and the timeline;
  - fills the transcript from `getDiscussionConversation`, refreshed on `discussion.conversation.updated` (the same
    throttled refresh as `refreshConv`);
  - puts the drafts panel in the details slot.
  
  `closeRun()` resets `ui.mode`. If reusing the run view's transcript renderer needs a run object, pass a minimal
  `{ id, cost: [], conversations: {} }` adapter. Don't fork the renderer.
- **Composer:**
  - send calls `say`;
  - while `turn !== null`, the button reads **Stop** and calls `stopTurn`;
  - it is disabled unless `state === "OPEN"`.
- **Drafts panel:**
  - summary and all draft text go through `md()`, which escapes;
  - titles go through `esc()`;
  - edits save with `updateDraft` on `blur`, only when the text changed;
  - **Redraft** confirms with `"This replaces N drafts"` when unconverted drafts exist;
  - a converted draft shows a link (`openRun(runId)`) and a state chip from `ui.runs`.
- **New discussion modal:**
  - the project select offers the existing projects, or "new" with name and repo fields, created first with
    `createProject` (copy `openCreate`);
  - title;
  - model and thinking, prefilled from `getSettings({project})["discussion.model.model"|"discussion.model.thinking"].value`;
  - first message.
- **Hash routes:** `#disc=<id>`, set and cleared like `#run=`.

- [ ] **Step 1: Write the failing test**

  ```ts
  test("discussions.js is served, parses, and is loaded by index.html", async () => {
    const js = await get("/discussions.js");
    expect(js.status).toBe(200);
    expect(() => new Function(js.body)).not.toThrow();
    expect(await (await get("/")).body).toMatch(/<script src="\/discussions\.js" defer><\/script>/);
  });
  ```

- [ ] **Step 2: Run it and confirm it fails**

  Run: `npx vitest run test/web.test.ts -t discussions.js`
  Expected: FAIL with 404.

- [ ] **Step 3: Implement the UI**

- [ ] **Step 4: Run the tests and check in a browser**

  Run: `npx vitest run test/web.test.ts && npm run typecheck`
  Expected: PASS.

  Then run `DRYRUN_SANDBOX=0 DRYRUN_DIR=$PWD/.dryrun npm run dry-run` (after Task 9), serve that factory as in the
  README's "look around" recipe, and walk through this flow in a browser:
  1. Open the Discussions tab.
  2. Open the dry run's discussion.
  3. Confirm the transcript, the drafts panel and the "From discussion" link on the run render.
  4. Send a message, press Stop, edit a draft and create a ticket.
  
  If no browser is available to the implementer, say so in the task report.

- [ ] **Step 5: Commit**

  ```bash
  git add src/web test/web.test.ts
  git commit -m "feat: web UI: Discussions tab, discussion view, drafts panel"
  ```

### Task 9: Dry run and docs

**Files:**
- Modify: `src/testing/dry-run-agents.ts`: export a `discussant: Script` about the todo CLI. It:
  - answers two human messages, the first after an `ls` and the second after a `web_search`;
  - on `# Draft tickets`, submits one ticket whose body is the same request text `scripts/dry-run.ts` uses for run 1
    today, with a summary that marks "storage: one JSON file" as settled.
  
  Keep the existing architect script working when its input carries `# Prior discussion`.
- Modify: `scripts/dry-run.ts`:
  - config `discussion: { model: { model: scripted/discussant } }`;
  - in §8.1, replace `startRun("todo", …)` with:
    `startDiscussion` → two `say`s → `requestDrafts` → `updateDraft` (append a line) → `createTicket`;
  - new `check()`s:
    - "discussion reached OPEN and answered both messages";
    - "drafts submitted with a summary";
    - "the run's request came from the discussion (source, meta)";
    - "the architect's first input carried the discussion summary".
  
  Everything after run 1 starts is unchanged.
- Modify: `README.md`, `docs/architecture.md`, `docs/configuration.md` and `DEVIATIONS.md`, as spec §7 lists. Update
  the README test count to what `npm test` reports.

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Run the dry run before the change**

  Run: `DRYRUN_SANDBOX=0 npm run dry-run`
  Expected: the current report, all checks ok. This is the baseline.

- [ ] **Step 2: Implement the dry-run changes**

- [ ] **Step 3: Run the dry run again**

  Run: `DRYRUN_SANDBOX=0 npm run dry-run`
  Expected: every check ok, including the four new ones; `report.md` lists them.

- [ ] **Step 4: Update the docs, then run the full suite**

  Run: `npm test && npm run typecheck`
  Expected: PASS. The README's test count matches.

- [ ] **Step 5: Commit**

  ```bash
  git add -A scripts src/testing README.md docs DEVIATIONS.md
  git commit -m "dry run: discussion before the first ticket; docs for discussions"
  ```
