// Dry trial of spec §8 through the real `factory` CLI: a `factory serve` process (SQLite storage, sandbox ON, a
// fake GitHub on the local disk with a local CI runner, scripted agents) driven by CLI commands only. Every step
// names the §8 item it exercises. Writes <dir>/report.md and exits non-zero if a check fails.
//
//   npm run dry-run                  # fresh dir under /tmp
//   DRYRUN_DIR=/tmp/x npm run dry-run
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { LocalGitHubHost } from "../src/extensions/github/host.ts";
import type { RunView } from "../src/core/types.ts";

const pexec = promisify(execFile);
const ROOT = resolve(import.meta.dirname, "..");
const DIR = process.env.DRYRUN_DIR ?? mkdtempSync(join(tmpdir(), "sf-dryrun-"));
mkdirSync(DIR, { recursive: true });
const CONFIG = join(DIR, "config.yaml");
const SOCKET = join(DIR, "factory.sock");
const GH = join(DIR, "github");
const BIN = join(ROOT, "bin/factory");
const ME = "me";

writeFileSync(
	CONFIG,
	`version: 1
storage:
  kind: sqlite
  path: ${join(DIR, "factory.sqlite")}
roles:
  architect: { model: scripted/architect }
  builder: { model: scripted/builder }
  helper: { model: scripted/helper }
  reviewer: { model: scripted/reviewer }
stages:
  interface:
    socket: ${SOCKET}
  repo:
    workdir: ${join(DIR, "work")}
  environment:
    root: ${join(DIR, "work")}
    sandbox:
      enabled: true
  delivery:
    ci:
      noChecksTimeout: 4s
`,
);

// ------------------------------------------------------------------ plumbing
const checks: { step: string; name: string; ok: boolean; detail?: string }[] = [];
let step = "";
const log = createWriteStream(join(DIR, "dry-run.log"));
function say(s: string) {
	console.log(s);
	log.write(`${s}\n`);
}
function check(name: string, ok: boolean, detail?: string) {
	checks.push({ step, name, ok, ...(detail ? { detail } : {}) });
	say(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail && !ok ? `\n        ${detail}` : ""}`);
}
function section(s: string) {
	step = s;
	say(`\n== ${s}`);
}

let server: ChildProcess | undefined;
async function serve() {
	server = spawn(BIN, ["serve", "--config", CONFIG, "--fake-github", GH, "--scripted", "--ci-poll-ms", "200"], {
		env: { ...process.env, DRYRUN_TURN_DELAY_MS: process.env.DRYRUN_TURN_DELAY_MS ?? "250" },
		stdio: ["ignore", "ignore", "pipe"],
	});
	server.stderr!.pipe(createWriteStream(join(DIR, "serve.log"), { flags: "a" }));
	const t0 = Date.now();
	for (;;) {
		try {
			await factory("project", "list");
			return;
		} catch {
			if (Date.now() - t0 > 30_000) throw new Error("factory serve did not come up; see serve.log");
			await sleep(200);
		}
	}
}
async function kill9() {
	const s = server!;
	s.kill("SIGKILL");
	await new Promise((r) => (s.exitCode !== null ? r(null) : s.once("exit", r)));
}

async function factory(...args: string[]): Promise<string> {
	const { stdout } = await pexec(BIN, args, { env: { ...process.env, FACTORY_SOCKET: SOCKET, NO_COLOR: "1" }, maxBuffer: 64 << 20 });
	return stdout.trim();
}
async function factoryFails(...args: string[]): Promise<string | undefined> {
	try {
		await factory(...args);
		return undefined;
	} catch (e: any) {
		return String(e.stderr ?? e.message);
	}
}
const status = async (run: string) => JSON.parse(await factory("status", run, "--json")) as RunView;
const transcript = async (run: string, which: string) => JSON.parse(await factory("transcript", run, which, "--json")) as any;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(run: string, pred: (v: RunView) => boolean, what: string, ms = 120_000): Promise<RunView> {
	const t0 = Date.now();
	for (;;) {
		const v = await status(run);
		if (pred(v)) return v;
		if (["DELIVERED", "FAILED", "CANCELLED"].includes(v.state) && !pred(v)) throw new Error(`${run} ended in ${v.state} while waiting for ${what}: ${v.failure?.reason ?? ""}`);
		if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${what}; run is ${v.state}`);
		await sleep(150);
	}
}
const pendingKind = (v: RunView, kind: string, gate?: string) =>
	v.pendingAsk?.question.kind === kind && (!gate || (v.pendingAsk.question as any).gate === gate);

/** Answer the human side of a run: discussion answers in order, the spec approval, then wait for an end state. */
async function drive(run: string, answers: string[], opts: { gates?: (v: RunView) => Promise<boolean>; until?: (v: RunView) => boolean } = {}) {
	const seen = new Set<string>();
	const end = opts.until ?? ((v: RunView) => ["DELIVERED", "FAILED", "CANCELLED", "ESCALATED"].includes(v.state));
	for (;;) {
		const v = await until(run, (x) => end(x) || (!!x.pendingAsk && !seen.has(x.pendingAsk.id)), "a pending ask or the end");
		if (end(v) && !(v.pendingAsk && !seen.has(v.pendingAsk.id) && v.state !== "ESCALATED")) return v;
		const ask = v.pendingAsk!;
		seen.add(ask.id);
		if (ask.question.kind === "discussion") {
			const a = answers.shift() ?? "Your call; keep it simple.";
			say(`  architect asks: ${ask.question.text}\n  human answers: ${a}`);
			await factory("answer", run, a);
		} else if (ask.question.kind === "approval") {
			if (opts.gates && (await opts.gates(v))) continue;
			say(`  approve ${ask.question.gate}`);
			await factory("approve", run, ask.question.gate);
		} else return v;
	}
}

async function cloneMain(repo: string): Promise<string> {
	const d = mkdtempSync(join(DIR, "clone-"));
	await pexec("git", ["clone", "-q", join(GH, "remotes", `${repo}.git`), d]);
	return d;
}
const reviewerRanTestsGreen = async (run: string) => {
	const tr = await transcript(run, "reviewer");
	return tr.items.some((i: any) => i.toolResult?.name === "run_tests" && /\[exit code 0\]/.test(i.toolResult.text));
};

// ------------------------------------------------------------------ the trial
async function main() {
	say(`dry run in ${DIR}`);
	await serve();
	const host = new LocalGitHubHost(GH); // the driver's view of the fake GitHub (state file + bare remotes)

	// ---------------------------------------------------------------- §8.1 zero-to-MVP
	section("§8.1 zero-to-MVP: factory run todo --repo me/todo (repo does not exist)");
	const run1 = JSON.parse(await factory("run", "todo", "--repo", `${ME}/todo`, "--title", "CLI todo tool", "--json", "CLI todo tool: add/list/done/remove, JSON file storage, tests")).run as string;
	say(`  run ${run1}`);
	check("repo did not exist before the run", !existsSync(join(GH, "remotes", ME, "todo.git")) || !host.state().created.includes(`${ME}/todo`));
	const answers1 = ["Node.js 22, no third-party dependencies; use the built-in node:test runner.", "Configurable with the TODO_FILE environment variable, default ./todo.json."];
	let rejected = false;
	let v1 = await drive(run1, answers1, {
		until: (v) => v.state === "BUILDING",
		gates: async (v) => {
			if (pendingKind(v, "approval", "spec") && !rejected) {
				rejected = true;
				say("  §8.3 reject the spec once");
				await factory("reject", run1, "spec", "Default the file to ~/.todo.json and write it atomically.");
				const back = await until(run1, (x) => x.state === "DISCUSSING" || x.state === "SPEC_READY" || (pendingKind(x, "approval", "spec") && (x.artifacts.spec?.version ?? 0) > 1), "back to discussion");
				check("spec rejection returns the run to the discussion (same architect)", back.history.some((h) => h.from === "AWAITING_APPROVAL" && h.to === "DISCUSSING") && back.conversations.architect === v.conversations.architect);
				return true;
			}
			return false;
		},
	});
	check("discussion asked two questions, one at a time", (await transcript(run1, "architect")).items.filter((i: any) => i.toolCalls?.some((t: any) => t.name === "ask_human")).length === 2);
	check("spec v2 after the rejection carries the feedback", (await status(run1)).artifacts.spec!.version === 2 && /todo\.json/.test((await status(run1)).artifacts.spec!.text));

	// §8.3 kill the process mid-build
	section("§8.3 kill -9 the factory mid-build, restart, resume");
	const mid = await until(run1, (x) => x.state === "BUILDING" && x.reviewRound === 1 && x.cost.every((c) => c.role !== "builder"), "builder mid-build");
	for (let i = 0; i < 100 && (await transcript(run1, "builder")).items.length < 4; i++) await sleep(50);
	const before = await status(run1);
	const trBefore = await transcript(run1, "builder");
	await kill9();
	say(`  killed the factory (pid ${server!.pid}) in ${before.state}, round ${before.reviewRound}, builder transcript ${trBefore.items.length} items`);
	await serve();
	const after = await status(run1);
	check("after restart the run is still BUILDING at the same round", after.state === "BUILDING" && after.reviewRound === mid.reviewRound, `${after.state} round ${after.reviewRound}`);
	check("same builder Conversation after restart", after.conversations.builder === before.conversations.builder);
	const attachLog = join(DIR, "attach-run1.log");
	const attachProc = spawn(BIN, ["attach", run1, "--no-input"], { env: { ...process.env, FACTORY_SOCKET: SOCKET, NO_COLOR: "1" }, stdio: ["ignore", "pipe", "pipe"] });
	attachProc.stdout!.pipe(createWriteStream(attachLog));
	v1 = await drive(run1, []);
	await Promise.race([new Promise((r) => (attachProc.exitCode !== null ? r(null) : attachProc.once("exit", r))), sleep(3000)]);
	attachProc.kill();
	check("zero-to-MVP delivered", v1.state === "DELIVERED", v1.failure?.reason);
	const trB = await transcript(run1, "builder");
	check("the builder's first input was admitted once (idempotent across the crash)", trB.items.filter((i: any) => i.role === "user" && /^# Build/.test(i.text)).length === 1);
	check("forced review failure: round 1 failed for a real reason (remove missing)", v1.findingsLog[0]?.kind === "review" && v1.findingsLog[0]!.findings.some((f) => f.blocking) && /remove/.test(v1.findingsLog[0]!.findings[0]!.description) && !!v1.findingsLog[0]!.findings[0]!.evidence);
	check("the same builder Conversation received the findings", trB.items.some((i: any) => i.role === "user" && /^# Findings to address/.test(i.text)) && v1.cost.filter((c) => c.role === "builder").every((c) => c.conversationId === v1.conversations.builder));
	check("review passed in round 2", v1.reviewRound === 2 && !v1.findingsLog.at(-1)!.findings.some((f) => f.blocking));
	check("the reviewer's own test run passed on the delivery", await reviewerRanTestsGreen(run1));
	check("delivered as a push to main of a new private repo", v1.artifacts.delivery?.kind === "repo" && host.state().calls.some((c) => c.op === "createRepo" && c.repo === `${ME}/todo` && (c.detail as any)?.private === true));
	const c1 = await cloneMain(`${ME}/todo`);
	const need = ["package.json", "src/todo.js", "bin/todo.js", "test/todo.test.js", "README.md", "AGENTS.md", "docs/spec.md", "docs/delivery-notes.md", "scripts/setup.sh"];
	check("main has code, tests, README, AGENTS.md, docs/spec.md and delivery notes", need.every((f) => existsSync(join(c1, f))), need.filter((f) => !existsSync(join(c1, f))).join(", "));
	const npmTest = await pexec("npm", ["test"], { cwd: c1 }).then(() => true, () => false);
	check("npm test passes on the delivered main", npmTest);
	check("if-present on a repo without CI: finished and noted that there was no CI", v1.noCi === true && v1.history.some((h) => h.to === "AWAITING_CI"));
	check("cost per role per round recorded in the run Document", ["architect", "builder", "reviewer"].every((r) => v1.cost.some((c) => c.role === r)) && v1.cost.filter((c) => c.role === "reviewer").map((c) => c.round).join() === "1,2", JSON.stringify(v1.cost.map((c) => [c.role, c.round])));
	check("helper Conversation spawned by the builder is visible in the transcript view", trB.helpers.length === 1);
	const attachOut = readFileSync(attachLog, "utf8");
	check("terminal attach view followed the run to DELIVERED", /→ DELIVERED/.test(attachOut) && /report_done|submit_review/.test(attachOut));

	// ---------------------------------------------------------------- §8.4 settings checks (invalid value)
	section("§8.4 invalid setting is rejected and the config file is unchanged");
	const cfgBefore = readFileSync(CONFIG, "utf8");
	const err = await factoryFails("settings", "set", "stages.delivery.ci.fixRounds", "5");
	check("factory settings set stages.delivery.ci.fixRounds 5 is rejected", !!err && /maximum 3/.test(err), err);
	check("config file unchanged", readFileSync(CONFIG, "utf8") === cfgBefore);

	// ---------------------------------------------------------------- §8.2 incremental
	section("§8.2 incremental: factory run todo \"add due dates and an --overdue filter\"");
	const run2 = await factory("run", "todo", "add due dates and an --overdue filter");
	say(`  run ${run2}`);
	await until(run2, (x) => x.state !== "RECEIVED", "run started");
	// §8.4: change the reviewer's model and thinking while run2 is in flight
	await factory("settings", "set", "roles.reviewer.model", "scripted/reviewer-b");
	await factory("settings", "set", "roles.reviewer.thinking", "medium");
	const v2 = await drive(run2, ["Yes: plain YYYY-MM-DD calendar dates, compared with today's local date."]);
	check("incremental delivered", v2.state === "DELIVERED", v2.failure?.reason);
	check("the architect grounded the discussion in the repo (read docs/spec.md first)", (await transcript(run2, "architect")).items.some((i: any) => i.toolCalls?.some((t: any) => t.name === "read")));
	check("delivered as a PR on the same repo", v2.artifacts.delivery?.kind === "pr" && host.state().prs.some((p) => p.repo === `${ME}/todo` && p.head === v2.artifacts.delivery!.ref));
	check("human input only for the discussion and the spec approval", v2.history.filter((h) => h.to === "AWAITING_APPROVAL").length === 1);
	check("the reviewer's own test run passed", await reviewerRanTestsGreen(run2));
	const prSrc = (await pexec("git", ["--git-dir", join(GH, "remotes", ME, "todo.git"), "show", `${v2.artifacts.delivery!.ref}:src/todo.js`])).stdout;
	check("PR branch has the due-date feature", /parseDue/.test(prSrc) && /isOverdue/.test(prSrc));
	const pushTry = (await transcript(run2, "builder")).items.find((i: any) => i.toolResult?.name === "bash" && /PUSH-EXIT/.test(i.toolResult.text))?.toolResult.text ?? "";
	check("agent cannot reach GitHub directly: git push to origin and api.github.com fail inside the sandbox", /origin\s+\S+todo\.git \(push\)/.test(pushTry) && /PUSH-EXIT=[1-9]/.test(pushTry) && /GITHUB-API-EXIT=[1-9]/.test(pushTry), pushTry.slice(0, 600));
	say(`  builder's push attempt inside the sandbox:\n${pushTry.trim().split("\n").map((l: string) => `      ${l}`).join("\n")}`);
	check("in-flight run kept its pinned reviewer (scripted/reviewer, high)", v2.cost.filter((c) => c.role === "reviewer").every((c) => c.model === "scripted/reviewer" && c.thinking === "high"), JSON.stringify(v2.cost.filter((c) => c.role === "reviewer").map((c) => [c.model, c.thinking])));

	// ---------------------------------------------------------------- §8.3 gate rejections
	section("§8.3 delivery and merge gates on for the project; reject once at each");
	await factory("settings", "set", "policy.approvals", "[spec, delivery, merge]", "--project", "todo");
	const run3 = await factory("run", "todo", "--title", "add a --version flag", "add a --version flag that prints the package version");
	const rejectedGates = new Set<string>();
	const roundsAt: Record<string, number> = {};
	const v3 = await drive(run3, [], {
		gates: async (v) => {
			const gate = (v.pendingAsk!.question as any).gate as string;
			if (gate === "spec" || rejectedGates.has(gate)) return false;
			rejectedGates.add(gate);
			roundsAt[gate] = v.reviewRound;
			const fb = gate === "delivery" ? "README must show an example of the --version output." : "Mention the --version flag in AGENTS.md.";
			say(`  reject ${gate}: ${fb}`);
			await factory("reject", run3, gate, fb);
			const w = await until(run3, (x) => x.state === "REVIEWING" || x.state === "AWAITING_APPROVAL" && x.pendingAsk?.id !== v.pendingAsk!.id, "after rejection");
			const tr = await transcript(run3, "builder");
			const lastIn = tr.items.filter((i: any) => i.role === "user").at(-1)?.text ?? "";
			check(`${gate} rejection → same builder got a blocking source:human finding`, w.conversations.builder === v.conversations.builder && /\(human, BLOCKING/.test(lastIn) && lastIn.includes(fb), lastIn.slice(0, 300));
			check(`${gate} rejection added no review or CI round`, w.reviewRound === roundsAt[gate] && w.ciFixes === v.ciFixes);
			return true;
		},
	});
	check("run with both gate rejections delivered (merged)", v3.state === "DELIVERED" && host.state().prs.some((p) => p.head === v3.artifacts.delivery?.ref && p.state === "merged"), v3.failure?.reason);
	check("both gates were rejected once", rejectedGates.has("delivery") && rejectedGates.has("merge"));
	const revIns = await Promise.all(v3.conversations.reviewers.map((r) => factory("transcript", run3, r.id, "--json").then((s) => JSON.parse(s))));
	check("the next reviewer saw the human finding", revIns.some((tr) => tr.items.some((i: any) => i.role === "user" && /Human findings from a gate rejection/.test(i.text) && /--version output/.test(i.text))));
	check("next new run's reviewer uses the changed model/thinking (scripted/reviewer-b, medium)", v3.cost.filter((c) => c.role === "reviewer").every((c) => c.model === "scripted/reviewer-b" && c.thinking === "medium"));
	await factory("settings", "unset", "policy.approvals", "--project", "todo");

	// ---------------------------------------------------------------- §8.3 CI modes on a repo without CI
	section("§8.3 ci.mode off: finishes at delivery without waiting for CI");
	await factory("settings", "set", "stages.delivery.ci.mode", "off", "--project", "todo");
	const run4 = await factory("run", "todo", "--title", "add a --quiet flag", "add a --quiet flag that suppresses output");
	const v4 = await drive(run4, []);
	check("mode off: DELIVERED without AWAITING_CI", v4.state === "DELIVERED" && !v4.history.some((h) => h.to === "AWAITING_CI"), v4.history.map((h) => h.to).join(">"));

	section("§8.3 ci.mode required on a repo with no CI checks: escalates after ci.noChecksTimeout");
	await factory("settings", "set", "stages.delivery.ci.mode", "required", "--project", "todo");
	const run5 = await factory("run", "todo", "--title", "add a --json flag", "add a --json flag to list");
	const t5 = Date.now();
	const v5 = await drive(run5, []);
	const waited = v5.history.find((h) => h.to === "ESCALATED")!;
	check("mode required, no checks: ESCALATED with 'no CI checks'", v5.state === "ESCALATED" && /no CI checks/.test(v5.pendingAsk?.question.kind === "escalation" ? v5.pendingAsk.question.reason : ""), JSON.stringify(v5.pendingAsk));
	check("escalation came after ci.noChecksTimeout (4s)", !!waited && Date.now() - t5 >= 4000);
	await factory("escalation", run5, "abort");
	check("escalation abort → CANCELLED", (await until(run5, (x) => x.state === "CANCELLED", "cancel")).state === "CANCELLED");
	await factory("settings", "unset", "stages.delivery.ci.mode", "--project", "todo");

	// ---------------------------------------------------------------- §8.3 round cap
	section("§8.3 hit the review round cap: escalates; accept delivers with the findings on record");
	await factory("settings", "set", "roles.reviewer.model", "scripted/reviewer-strict", "--project", "todo");
	await factory("settings", "set", "policy.reviewRoundCap", "2", "--project", "todo");
	const run6 = await factory("run", "todo", "--title", "add a --color flag", "add a --color flag");
	const v6 = await drive(run6, []);
	check("round cap reached → ESCALATED after 2 review rounds", v6.state === "ESCALATED" && v6.reviewRound === 2 && /round cap/.test((v6.pendingAsk?.question as any)?.reason ?? ""));
	await factory("escalation", run6, "accept");
	const v6b = await until(run6, (x) => ["DELIVERED", "FAILED", "CANCELLED"].includes(x.state), "delivery after accept");
	check("accept → delivered with known findings", v6b.state === "DELIVERED");
	await factory("settings", "unset", "roles.reviewer.model", "--project", "todo");
	await factory("settings", "unset", "policy.reviewRoundCap", "--project", "todo");

	// ---------------------------------------------------------------- §8.3 todo2: CI required on a new repo
	section("§8.3 todo2: new repo, ci.mode required set before the repo exists; builder ships CI");
	await factory("project", "create", "todo2", "--repo", `${ME}/todo2`);
	await factory("settings", "set", "stages.delivery.ci.mode", "required", "--project", "todo2");
	const run7 = await factory("run", "todo2", "--title", "CLI todo tool", "CLI todo tool: add/list/done/remove, JSON file storage, tests");
	const v7 = await drive(run7, ["Node.js, no dependencies, node:test.", "TODO_FILE env var, default ./todo.json."]);
	check("todo2 delivered", v7.state === "DELIVERED", v7.failure?.reason);
	const c7 = await cloneMain(`${ME}/todo2`);
	check("the builder shipped a CI workflow", existsSync(join(c7, ".github/workflows/ci.yml")));
	const sha7 = v7.artifacts.delivery!.sha;
	const ck7 = host.state().checks[`${ME}/todo2@${sha7}`] ?? [];
	check("the run waited for and passed CI on the pushed commit on main", v7.history.some((h) => h.to === "AWAITING_CI") && ck7.length > 0 && ck7.every((c) => c.conclusion === "success") && !v7.noCi, JSON.stringify(ck7));

	section("§8.3 ci.fixRounds 0 and a forced CI failure: escalates without a fix round");
	await factory("settings", "set", "stages.delivery.ci.fixRounds", "0", "--project", "todo2");
	host.forceChecks(`${ME}/todo2`, [{ name: "test", status: "completed", conclusion: "failure", output: "1 failing: forced failure" } as any]);
	const run8 = await factory("run", "todo2", "--title", "add a --version flag", "add a --version flag");
	const v8 = await drive(run8, []);
	const b8 = await transcript(run8, "builder");
	check("CI failure with fixRounds 0 → ESCALATED", v8.state === "ESCALATED" && /CI failed/.test((v8.pendingAsk?.question as any)?.reason ?? ""), JSON.stringify(v8.pendingAsk));
	check("no CI fix round was run", v8.ciFixes === 0 && !b8.items.some((i: any) => i.role === "user" && /CI fix/.test(i.text)));
	await factory("escalation", run8, "abort");
	await until(run8, (x) => x.state === "CANCELLED", "cancel");

	// ---------------------------------------------------------------- pass criteria summary
	section("§8.5 pass criteria");
	const runs = JSON.parse(await factory("runs", "--json")) as RunView[];
	check("all runs recorded with cost and round counts", runs.every((r) => Array.isArray(r.cost) && typeof r.reviewRound === "number"));
	const refs = (await Promise.all([`${ME}/todo`, `${ME}/todo2`].map((r) => pexec("git", ["--git-dir", join(GH, "remotes", `${r}.git`), "for-each-ref", "--format=%(refname)"]).then((x) => x.stdout)))).join("");
	check("no agent-made ref reached the remotes (only main and factory/<run> branches)", refs.split("\n").filter(Boolean).every((r) => r === "refs/heads/main" || r.startsWith("refs/heads/factory/")), refs);
}

main()
	.catch((e) => {
		check(`trial aborted: ${e.message}`, false, e.stack);
	})
	.finally(async () => {
		if (server && server.exitCode === null) server.kill("SIGTERM");
		const failed = checks.filter((c) => !c.ok);
		const md = [
			`# Dry run of spec §8 — ${new Date().toISOString()}`,
			"",
			`Directory: ${DIR}. Scripted agents (no model credentials), sandbox ON, fake GitHub with local CI runner, SQLite storage, driven through the \`factory\` CLI.`,
			"",
			`**${checks.length - failed.length}/${checks.length} checks passed.**`,
			"",
			...[...new Set(checks.map((c) => c.step))].flatMap((s) => [`## ${s}`, ...checks.filter((c) => c.step === s).map((c) => `- ${c.ok ? "✅" : "❌"} ${c.name}${!c.ok && c.detail ? `\n  \`\`\`\n  ${c.detail.slice(0, 800)}\n  \`\`\`` : ""}`), ""]),
		].join("\n");
		writeFileSync(join(DIR, "report.md"), md);
		say(`\n${checks.length - failed.length}/${checks.length} checks passed — report: ${join(DIR, "report.md")}`);
		log.end();
		setTimeout(() => process.exit(failed.length ? 1 : 0), 300);
	});
