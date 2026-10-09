// Scripted agents for the §8 dry run (no model credentials on this machine). They behave like a small, competent
// team building a Node.js "todo" CLI: the architect asks grounded questions one at a time and writes a spec with
// acceptance behaviours; the builder really writes, tests and commits code in the sandboxed worktree (and spawns a
// helper); the reviewer really runs the test suite and the acceptance behaviours and reports evidence it observed.
// Round 1 of a new todo build deliberately ships without `remove`, so the first review fails for a real reason.
import { call, calls, humanText, type Script, type ScriptContext, say } from "./scripted.ts";

const delay = Number(process.env.DRYRUN_TURN_DELAY_MS ?? 0);
const slow = async <T>(v: T): Promise<T> => {
	if (delay) await new Promise((r) => setTimeout(r, delay));
	return v;
};
const lastResult = (ctx: ScriptContext, name: string) => [...ctx.results].reverse().find((r) => r.name === name);
const first = (ctx: ScriptContext) => ctx.inputs[0] ?? "";

// ------------------------------------------------------------------ architect
const MVP_SPEC = (storage: string, extra = "") => `# todo — command-line todo tool

## Product
A small command-line tool to keep a todo list. Items are stored in a JSON file.

## Architecture
- Language/runtime: Node.js (>= 20), no runtime dependencies; tests with the built-in \`node:test\` runner (\`npm test\`).
- Storage: ${storage}
- Layout: \`src/todo.js\` (pure functions over the list + load/save), \`bin/todo.js\` (argument parsing and output).
- Each item: \`{ id, title, done, createdAt }\`; ids are increasing integers and are never reused.
- Errors (unknown id, missing title, unknown command) print a message to stderr and exit with code 1.
${extra}
## Commands
- \`todo add "<title>"\` → prints \`added <id>: <title>\`
- \`todo list\` → one line per item: \`[ ] <id> <title>\` or \`[x] <id> <title>\`; \`(no items)\` when empty
- \`todo done <id>\` → marks the item done
- \`todo remove <id>\` → deletes the item

## Acceptance behaviours
1. \`todo add "buy milk"\` then \`todo list\` shows \`[ ] 1 buy milk\`.
2. \`todo done 1\` then \`todo list\` shows \`[x] 1 buy milk\`.
3. \`todo remove 1\` then \`todo list\` shows \`(no items)\`.
4. The list survives between invocations (it is read from and written to the JSON file).
5. \`todo done 42\` on a missing id prints an error and exits with code 1.
6. \`npm test\` passes.
`;

const DUE_SPEC = `# todo — command-line todo tool

## Product
A small command-line tool to keep a todo list, stored in a JSON file (see AGENTS.md for the file location).

## Architecture
- Node.js (>= 20), no runtime dependencies; tests with \`node:test\` (\`npm test\`).
- \`src/todo.js\` holds the list logic; \`bin/todo.js\` parses arguments.
- Items: \`{ id, title, done, createdAt, due? }\`. \`due\` is a calendar date \`YYYY-MM-DD\` (no time zone).
- "Overdue" means: not done, and \`due\` is strictly before today's local date.

## Commands (existing)
- \`todo add "<title>"\`, \`todo list\`, \`todo done <id>\`, \`todo remove <id>\` — unchanged.

## Change: due dates and an --overdue filter
- \`todo add "<title>" --due YYYY-MM-DD\` stores a due date; an invalid date is an error (exit 1).
- \`todo list\` shows the due date after the title: \`[ ] 1 pay rent (due 2030-01-31)\`.
- \`todo list --overdue\` lists only overdue items.

## Acceptance behaviours
1. \`todo add "pay rent" --due 2000-01-01\` then \`todo list\` shows \`(due 2000-01-01)\`.
2. \`todo list --overdue\` shows "pay rent" but not an item due in 2999 nor an item without a due date.
3. \`todo add "x" --due 2024-13-45\` exits with code 1.
4. Existing behaviours still work (add/list/done/remove), and \`npm test\` passes.
`;

const GENERIC_SPEC = (title: string) => `# todo — change: ${title}

## Context
The existing todo CLI (see docs/spec.md history and AGENTS.md) is unchanged except for this request.

## Change
${title}. Documented in README.md and covered by a test.

## Acceptance behaviours
1. The change described above is observable from the command line.
2. Existing behaviours (add/list/done/remove) still work.
3. \`npm test\` passes.
`;

export const architect: Script = async (ctx) => {
	const req = first(ctx);
	const isNew = /does not exist yet/.test(req);
	const rejected = /rejected the spec/.test(ctx.input) ? ctx.input : "";
	const answers = ctx.inputs.slice(1).filter((i) => !/rejected the spec/.test(i));
	if (ctx.turn > 0) {
		const r = lastResult(ctx, "submit_spec");
		if (r?.isError) return call("submit_spec", { markdown: MVP_SPEC("JSON file at $TODO_FILE, default ./todo.json") });
		if (ctx.results.at(-1)?.name === "read" || ctx.results.at(-1)?.name === "bash") {
			// grounded in the repo: ask about the change after reading the current spec
			return slow(call("ask_human", { question: "The current spec stores items as { id, title, done, createdAt }. Should due dates be plain calendar dates (YYYY-MM-DD) and should --overdue compare against today's local date?" }));
		}
		return say("Waiting for the human.");
	}
	if (isNew) {
		if (rejected) {
			return slow(call("submit_spec", { markdown: MVP_SPEC("JSON file at $TODO_FILE (default: ~/.todo.json); the file is written atomically (write to a temp file, then rename)", `- Feedback from the spec review: ${rejected.split("\n")[2] ?? ""}\n`) }));
		}
		if (answers.length === 0) return slow(call("ask_human", { question: "The repo is empty. Which language/runtime should the CLI use, and may it have third-party dependencies?" }));
		if (answers.length === 1) return slow(call("ask_human", { question: "Where should the JSON file live: a fixed path (~/.todo.json), the current directory, or configurable via an environment variable?" }));
		return slow(call("submit_spec", { markdown: MVP_SPEC("JSON file at $TODO_FILE (default: ./todo.json)") }));
	}
	// incremental
	const title = /Title: (.*)/.exec(req)?.[1] ?? "change";
	if (/due date/i.test(req)) {
		if (answers.length === 0) return slow(call("read", { path: "docs/spec.md" }));
		return slow(call("submit_spec", { markdown: DUE_SPEC }));
	}
	return slow(call("submit_spec", { markdown: GENERIC_SPEC(title) }));
};

// A message at the spec gate that asks for a change: revise the spec (it replaces the version waiting for approval).
architect.onMessage = (ctx) => {
	const side = ctx.side!;
	const atGate = /waiting for the human's approval/.test(side.message);
	const text = humanText(side.message).trim();
	if (side.turn === 0 && atGate && /\b(change|revise|add|rename|instead|should|must|please)\b/i.test(text)) {
		const last = [...ctx.messages].reverse().flatMap((m: any) => (m.role === "assistant" ? m.content : [])).find((p: any) => p.type === "toolCall" && p.name === "submit_spec") as any;
		const spec = String(last?.arguments?.markdown ?? GENERIC_SPEC("change"));
		return slow(call("submit_spec", { markdown: `${spec.trimEnd()}\n\n## Requested in a message\n- ${text.split("\n")[0]}\n` }));
	}
	if (side.turn > 0) return say(side.results.at(-1)?.isError ? `I couldn't revise the spec: ${side.results.at(-1)?.text}` : "Done: I revised the spec with your change. The new version is waiting for your approval.");
	return say(atGate ? `Thanks. ${/\?\s*$/.test(text) ? "The spec covers that in its acceptance behaviours; ask me to change it and I'll revise it." : "Noted; tell me if the spec should change."}` : `Noted: ${text.split("\n")[0]}`);
};

// ------------------------------------------------------------------ builder: the product's source files
const PKG = `{
  "name": "todo",
  "version": "1.0.0",
  "description": "Command-line todo tool",
  "type": "module",
  "bin": { "todo": "bin/todo.js" },
  "scripts": { "test": "node --test" },
  "engines": { "node": ">=20" }
}
`;

const LIB = (opts: { remove: boolean; due: boolean }) => `import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

export function filePath() {
  return process.env.TODO_FILE || "todo.json";
}

export function load(file = filePath()) {
  if (!existsSync(file)) return { nextId: 1, items: [] };
  return JSON.parse(readFileSync(file, "utf8"));
}

export function save(list, file = filePath()) {
  const tmp = file + ".tmp";
  writeFileSync(tmp, JSON.stringify(list, null, 2));
  renameSync(tmp, file);
}
${opts.due ? `
export function parseDue(s) {
  if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(s)) throw new Error("invalid date: " + s + " (expected YYYY-MM-DD)");
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) throw new Error("invalid date: " + s);
  return s;
}

export function today(now = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return now.getFullYear() + "-" + p(now.getMonth() + 1) + "-" + p(now.getDate());
}

export function isOverdue(item, now = new Date()) {
  return !item.done && !!item.due && item.due < today(now);
}
` : ""}
export function add(list, title${opts.due ? ", due" : ""}) {
  if (!title || !title.trim()) throw new Error("a title is required");
  const item = { id: list.nextId++, title: title.trim(), done: false, createdAt: new Date().toISOString()${opts.due ? ", ...(due ? { due: parseDue(due) } : {})" : ""} };
  list.items.push(item);
  return item;
}

function find(list, id) {
  const item = list.items.find((i) => i.id === Number(id));
  if (!item) throw new Error("no item with id " + id);
  return item;
}

export function done(list, id) {
  const item = find(list, id);
  item.done = true;
  return item;
}
${opts.remove ? `
export function remove(list, id) {
  const item = find(list, id);
  list.items = list.items.filter((i) => i !== item);
  return item;
}
` : ""}
export function format(item) {
  return (item.done ? "[x] " : "[ ] ") + item.id + " " + item.title${opts.due ? ' + (item.due ? " (due " + item.due + ")" : "")' : ""};
}
`;

const BIN = (opts: { remove: boolean; due: boolean }) => `#!/usr/bin/env node
import * as todo from "../src/todo.js";

function main(argv) {
  const [cmd, ...rest] = argv;
  const list = todo.load();
  switch (cmd) {
    case "add": {
${opts.due ? `      const i = rest.indexOf("--due");
      const due = i >= 0 ? rest[i + 1] : undefined;
      const words = i >= 0 ? rest.filter((_, k) => k !== i && k !== i + 1) : rest;
      const item = todo.add(list, words.join(" "), due);` : `      const item = todo.add(list, rest.join(" "));`}
      todo.save(list);
      console.log("added " + item.id + ": " + item.title);
      return;
    }
    case "list": {
${opts.due ? `      const items = rest.includes("--overdue") ? list.items.filter((i) => todo.isOverdue(i)) : list.items;` : `      const items = list.items;`}
      console.log(items.length ? items.map(todo.format).join("\\n") : "(no items)");
      return;
    }
    case "done":
      todo.done(list, rest[0]);
      todo.save(list);
      console.log("done " + rest[0]);
      return;
${opts.remove ? `    case "remove":
      todo.remove(list, rest[0]);
      todo.save(list);
      console.log("removed " + rest[0]);
      return;
` : ""}    default:
      throw new Error("unknown command: " + (cmd ?? "(none)") + "\\nusage: todo add <title>${opts.due ? " [--due YYYY-MM-DD]" : ""} | list${opts.due ? " [--overdue]" : ""} | done <id>${opts.remove ? " | remove <id>" : ""}");
  }
}

try {
  main(process.argv.slice(2));
} catch (e) {
  console.error("error: " + e.message);
  process.exit(1);
}
`;

const TESTS = (opts: { remove: boolean; due: boolean }) => `import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import * as todo from "../src/todo.js";

const cli = (file, ...args) => spawnSync(process.execPath, ["bin/todo.js", ...args], { env: { ...process.env, TODO_FILE: file }, encoding: "utf8" });
const fresh = () => join(mkdtempSync(join(tmpdir(), "todo-")), "todo.json");

test("add assigns increasing ids", () => {
  const list = { nextId: 1, items: [] };
  assert.equal(todo.add(list, "a").id, 1);
  assert.equal(todo.add(list, "b").id, 2);
});

test("add requires a title", () => {
  assert.throws(() => todo.add({ nextId: 1, items: [] }, "  "));
});

test("done marks an item", () => {
  const list = { nextId: 1, items: [] };
  todo.add(list, "a");
  todo.done(list, 1);
  assert.equal(list.items[0].done, true);
});

test("cli: add, list, done persist through the JSON file", () => {
  const f = fresh();
  assert.equal(cli(f, "add", "buy", "milk").stdout.trim(), "added 1: buy milk");
  assert.equal(cli(f, "list").stdout.trim(), "[ ] 1 buy milk");
  cli(f, "done", "1");
  assert.equal(cli(f, "list").stdout.trim(), "[x] 1 buy milk");
});

test("cli: a missing id is an error with exit code 1", () => {
  const r = cli(fresh(), "done", "42");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no item with id 42/);
});
${opts.remove ? `
test("cli: remove deletes an item", () => {
  const f = fresh();
  cli(f, "add", "x");
  assert.equal(cli(f, "remove", "1").status, 0);
  assert.equal(cli(f, "list").stdout.trim(), "(no items)");
});
` : ""}${opts.due ? `
test("due dates are validated and shown", () => {
  const f = fresh();
  assert.equal(cli(f, "add", "pay rent", "--due", "2000-01-01").status, 0);
  assert.match(cli(f, "list").stdout, /\\(due 2000-01-01\\)/);
  assert.equal(cli(f, "add", "x", "--due", "2024-13-45").status, 1);
});

test("--overdue lists only overdue, not-done items", () => {
  const f = fresh();
  cli(f, "add", "old", "--due", "2000-01-01");
  cli(f, "add", "future", "--due", "2999-01-01");
  cli(f, "add", "nodate");
  const out = cli(f, "list", "--overdue").stdout;
  assert.match(out, /old/);
  assert.doesNotMatch(out, /future|nodate/);
});

test("isOverdue compares calendar dates", () => {
  const now = new Date(2024, 4, 10);
  assert.equal(todo.isOverdue({ due: "2024-05-09", done: false }, now), true);
  assert.equal(todo.isOverdue({ due: "2024-05-10", done: false }, now), false);
  assert.equal(todo.isOverdue({ due: "2024-05-09", done: true }, now), false);
});
` : ""}`;

const README = (opts: { remove: boolean; due: boolean }, extra: string[] = []) => `# todo

A command-line todo tool. Items live in a JSON file (\`$TODO_FILE\`, default \`./todo.json\`).

## Usage

\`\`\`sh
node bin/todo.js add "buy milk"${opts.due ? `
node bin/todo.js add "pay rent" --due 2030-01-31` : ""}
node bin/todo.js list${opts.due ? `
node bin/todo.js list --overdue` : ""}
node bin/todo.js done 1${opts.remove ? `
node bin/todo.js remove 1` : ""}
\`\`\`

## Development

\`\`\`sh
scripts/setup.sh   # checks the toolchain
npm test           # node:test suite
\`\`\`
${extra.map((e) => `\n${e}\n`).join("")}`;

const AGENTS = (ci: boolean) => `# AGENTS.md — repo map

- Spec (the contract): docs/spec.md
- Setup: scripts/setup.sh
- Test: npm test
- Run: node bin/todo.js <add|list|done|remove> ...

## Map
- bin/todo.js — CLI entry point (argument parsing, output, exit codes)
- src/todo.js — list logic, JSON load/save (atomic write)
- test/ — node:test suites (unit + CLI)
- docs/ — spec and delivery notes
- PROGRESS.md — builder's notes
${ci ? "- .github/workflows/ci.yml — CI: runs npm test on push and PRs\n" : ""}`;

const SETUP = `#!/usr/bin/env bash
set -euo pipefail
node --version
echo "toolchain ok"
`;

const CI = `name: ci
on: [push, pull_request]
jobs:
  test:
    name: test
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm test
`;

function files(opts: { remove: boolean; due: boolean; ci: boolean }, readmeExtra: string[] = []) {
	return {
		"package.json": PKG,
		"src/todo.js": LIB(opts),
		"bin/todo.js": BIN(opts),
		"test/todo.test.js": TESTS(opts),
		"README.md": README(opts, readmeExtra),
		"AGENTS.md": AGENTS(opts.ci),
		"scripts/setup.sh": SETUP,
		".gitignore": "node_modules/\ntodo.json\n",
		...(opts.ci ? { ".github/workflows/ci.yml": CI } : {}),
	};
}

const writes = (fs: Record<string, string>) => calls(...Object.entries(fs).map(([path, content]) => ["write", { path, content }] as [string, Record<string, unknown>]));
const commit = (msg: string, progress: string) =>
	call("bash", { command: `printf '%s\\n' ${JSON.stringify(progress)} >> PROGRESS.md && chmod +x scripts/setup.sh bin/todo.js 2>/dev/null; git add -A && git commit -qm ${JSON.stringify(msg)} && git log --oneline -1` });

const PUSH_ATTEMPT = 'git remote -v; out=$(git push origin HEAD:refs/heads/agent-push 2>&1); echo PUSH-EXIT=$?; echo "$out" | tail -2; out=$(curl -sS -m 10 https://api.github.com/ -o /dev/null 2>&1); echo GITHUB-API-EXIT=$?; echo "$out" | tail -1';

export const builder: Script = async (ctx) => {
	const spec = first(ctx);
	const isDue = /due dates/i.test(spec) && /--overdue/.test(spec);
	const isMvp = /# todo — command-line todo tool/.test(spec) && !isDue;
	const ci = /CI: required/.test(spec);
	const findings = ctx.input.startsWith("# Findings to address");
	const ids = [...ctx.input.matchAll(/\[(F\d+)\] \([a-z]+, BLOCKING/g)].map((m) => m[1]!);
	const respond = () =>
		slow(
			call("report_done", {
				summary: findings ? `Addressed ${ids.length} finding(s).` : "Built to the spec; tests pass locally.",
				responses: ids.map((findingId) => ({ findingId, status: "fixed" })),
			}),
		);
	const t = ctx.turn;

	if (!findings) {
		// initial build of this run
		if (isMvp || /new repo/i.test(spec)) {
			const opts = { remove: false, due: false, ci };
			if (t === 0) return slow(call("subagent", { task: "List the files in the workspace and tell me whether AGENTS.md or a setup script exists. Reply in one short paragraph." }));
			if (t === 1) return slow(writes(files(opts)));
			if (t === 2) return slow(call("bash", { command: "npm test 2>&1 | tail -15" }));
			if (t === 3) return slow(commit("feat: todo CLI with add/list/done, JSON storage, tests", "- round 1: built add/list/done with JSON storage and tests"));
			return respond();
		}
		if (isDue) {
			// An existing repo: origin points at the real remote. Prove the sandbox keeps the agent away from it.
			if (t === 4) return slow(call("bash", { command: PUSH_ATTEMPT }));
			if (t === 5) return respond();
			const opts = { remove: true, due: true, ci };
			if (t === 0) return slow(call("read", { path: "AGENTS.md" }));
			if (t === 1) return slow(writes(files(opts)));
			if (t === 2) return slow(call("run_tests", {}));
			if (t === 3) return slow(commit("feat: due dates and --overdue filter", "- due dates: --due on add, --overdue on list, tests"));
			return respond();
		}
		// generic incremental change: document it and add a test
		const title = /^# todo — change: (.*)$/m.exec(spec)?.[1] ?? "change";
		if (t === 0) return slow(call("read", { path: "AGENTS.md" }));
		if (t === 1)
			return slow(
				calls(
					["bash", { command: `printf '\\n## Change log\\n\\n- ${title.replace(/'/g, "")}\\n' >> README.md && echo ok` }],
					["write", { path: `test/change-${ctx.inputs.length}-${Date.now() % 100000}.test.js`, content: `import { test } from "node:test";\nimport assert from "node:assert/strict";\ntest(${JSON.stringify(title)}, () => assert.ok(true));\n` }],
				),
			);
		if (t === 2) return slow(commit(`feat: ${title}`, `- ${title}`));
		return respond();
	}

	// a fix round: address each finding
	const text = ctx.input;
	if (t === 0) {
		if (/remove/i.test(text) && /todo remove|remove <id>|remove 1/i.test(text)) {
			return slow(writes(files({ remove: true, due: /--overdue/.test(text) || isDue, ci })));
		}
		const notes = [...text.matchAll(/^\s{2}(.+)$/gm)].map((m) => m[1]!).filter((l) => !/^evidence:/.test(l)).slice(0, 3);
		return slow(call("bash", { command: `mkdir -p docs && printf '%s\\n' ${notes.map((n) => JSON.stringify(`- ${n}`)).join(" ")} >> CHANGELOG.md && echo ok` }));
	}
	if (t === 1) return slow(call("bash", { command: "npm test 2>&1 | tail -5" }));
	if (t === 2) return slow(commit(`fix: address review findings (${ids.join(", ")})`, `- fixed: ${ids.join(", ")}`));
	return respond();
};

export const helper: Script = async (ctx) => {
	if (ctx.turn === 0) return slow(call("bash", { command: "ls -la; test -f AGENTS.md && echo HAS-AGENTS || echo NO-AGENTS; ls scripts 2>/dev/null || echo NO-SETUP-SCRIPT" }));
	const r = lastResult(ctx, "bash")?.text ?? "";
	return say(`Workspace summary: ${/NO-AGENTS/.test(r) ? "no AGENTS.md yet" : "AGENTS.md present"}; ${/NO-SETUP-SCRIPT/.test(r) ? "no setup script yet" : "a scripts/ dir exists"}. Files: ${r.split("\n").filter((l) => /^[-d]/.test(l)).length}.`);
};

// ------------------------------------------------------------------ reviewer
function reviewer(strict: boolean): Script {
	return async (ctx) => {
		const spec = first(ctx);
		const base = /Diff against base ([0-9a-f]{7,40})/.exec(spec)?.[1] ?? "HEAD~1";
		const due = /--overdue/.test(spec) && /due/.test(spec);
		const t = ctx.turn;
		const acceptance = due
			? `export TODO_FILE=$HOME/rv-$RANDOM.json; node bin/todo.js add "pay rent" --due 2000-01-01; node bin/todo.js add "later" --due 2999-01-01; node bin/todo.js add "nodate"; node bin/todo.js list; echo "--- overdue:"; node bin/todo.js list --overdue; node bin/todo.js add x --due 2024-13-45; echo "invalid-date-exit=$?"`
			: `export TODO_FILE=$HOME/rv-$RANDOM.json; node bin/todo.js add "buy milk" && node bin/todo.js list && node bin/todo.js done 1 && node bin/todo.js list; node bin/todo.js remove 1; echo "remove-exit=$?"; node bin/todo.js list; node bin/todo.js done 42; echo "missing-id-exit=$?"`;
		if (t === 0) return slow(call("run_tests", {}));
		if (t === 1) return slow(call("bash", { command: acceptance }));
		if (t === 2) return slow(call("bash", { command: `git diff --stat ${base} -- test/ ; echo "deleted tests: $(git diff --diff-filter=D --name-only ${base} -- test/ | wc -l)"` }));
		const tests = ctx.results[0]?.text ?? "";
		const acc = ctx.results[1]?.text ?? "";
		const del = ctx.results[2]?.text ?? "";
		const findings: any[] = [];
		const testsOk = /\[exit code 0\]/.test(tests);
		if (!testsOk) findings.push({ severity: "critical", blocking: true, specRef: "Acceptance behaviours: npm test passes", description: "The test suite fails.", evidence: `$ npm test\n${tests.slice(-1500)}` });
		if (!due && !/remove-exit=0/.test(acc))
			findings.push({ severity: "major", blocking: true, specRef: "Commands: todo remove <id>; Acceptance behaviour 3", description: "`todo remove <id>` is not implemented: the command is rejected as unknown.", evidence: `$ ${acceptance}\n${acc.slice(-1500)}` });
		if (!due && !/missing-id-exit=1/.test(acc))
			findings.push({ severity: "major", blocking: true, specRef: "Acceptance behaviour 5", description: "A missing id does not exit with code 1.", evidence: `$ ${acceptance}\n${acc.slice(-1500)}` });
		if (due && !/--- overdue:\n.*pay rent/.test(acc))
			findings.push({ severity: "major", blocking: true, specRef: "Acceptance behaviour 2", description: "--overdue does not list the overdue item.", evidence: `$ ${acceptance}\n${acc.slice(-1500)}` });
		if (due && /--- overdue:[\s\S]*(later|nodate)/.test(acc))
			findings.push({ severity: "major", blocking: true, specRef: "Acceptance behaviour 2", description: "--overdue lists items that are not overdue.", evidence: `$ ${acceptance}\n${acc.slice(-1500)}` });
		if (!/deleted tests: 0/.test(del))
			findings.push({ severity: "major", blocking: true, specRef: "Review rule: tests must not be deleted or weakened", description: "Tests were deleted in the diff.", evidence: `$ git diff --diff-filter=D --name-only ${base} -- test/\n${del}` });
		if (strict && findings.length === 0)
			findings.push({ severity: "minor", blocking: true, specRef: "Acceptance behaviours (strict reviewer)", description: "Strict reviewer: error messages should list the valid commands; treated as blocking.", evidence: `$ node bin/todo.js nope\n(see acceptance run)\n${acc.slice(-500)}` });
		if (findings.length === 0) {
			const advisory = [{ severity: "minor", blocking: false, specRef: "Commands", description: "Consider a --help flag that prints the usage line.", evidence: `$ ${acceptance}\n${acc.slice(-800)}` }];
			return slow(call("submit_review", { verdict: "pass", findings: advisory }));
		}
		return slow(call("submit_review", { verdict: "fail", findings }));
	};
}

export const DRY_RUN_SCRIPTS: Record<string, Script> = {
	architect,
	builder,
	helper,
	reviewer: reviewer(false),
	"reviewer-strict": reviewer(true),
	"reviewer-b": reviewer(false),
};
