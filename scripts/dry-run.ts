// Dry trial of spec §8 through the web HTTP API: a daemonized `factory serve` (SQLite storage, sandbox ON unless DRYRUN_SANDBOX=0, a fake
// GitHub on the local disk with a local CI runner, scripted agents) driven by `POST /api/op/<op>` calls and the
// `GET /api/events` stream; `factory serve`, `web` and `stop` are the only CLI commands it runs. Every step names the
// §8 item it exercises. Writes <dir>/report.md and exits non-zero if a check fails.
//
//   npm run dry-run                  # fresh dir under /tmp
//   DRYRUN_DIR=/tmp/x npm run dry-run
//   DRYRUN_SANDBOX=0 npm run dry-run   # where the sandbox runtime can't run (e.g. no socat on Linux)
import { execFile } from "node:child_process";
import { appendFileSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import YAML from "yaml";
import { fieldAt } from "../src/core/settings.ts";
import { daemonFiles, livePid } from "../src/daemon.ts";
import { LocalGitHubHost } from "../src/github/host.ts";
import type { FactoryEvent, RunView, Scope, SettingField, TranscriptView } from "../src/core/types.ts";

const pexec = promisify(execFile);
const ROOT = resolve(import.meta.dirname, "..");
const DIR = resolve(process.env.DRYRUN_DIR ?? mkdtempSync(join(tmpdir(), "sf-dryrun-")));
mkdirSync(DIR, { recursive: true });
const CONFIG = join(DIR, "config.yaml");
const GH = join(DIR, "github");
const BIN = join(ROOT, "bin/factory");
const ME = "me";
const SANDBOX = process.env.DRYRUN_SANDBOX !== "0";

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
  qa: { model: scripted/qa }
qa:
  enabled: true
boat:
  apiKey: env:DRYRUN_BOAT_KEY
workdir: ${join(DIR, "work")}
sandbox:
  enabled: ${SANDBOX}
ci:
  noChecksTimeout: 4s
web:
  port: 0
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

/** Runs a `factory` CLI command; its stdout and stderr also go to serve.log. */
async function factory(...args: string[]): Promise<string> {
	try {
		const { stdout, stderr } = await pexec(BIN, args, {
			cwd: DIR,
			env: { ...process.env, NO_COLOR: "1", DRYRUN_BOAT_KEY: "fake-boat-key", DRYRUN_TURN_DELAY_MS: process.env.DRYRUN_TURN_DELAY_MS ?? "250" },
			maxBuffer: 64 << 20,
		});
		appendFileSync(join(DIR, "serve.log"), `$ factory ${args.join(" ")}\n${stdout}${stderr}`);
		return stdout.trim();
	} catch (e: any) {
		appendFileSync(join(DIR, "serve.log"), `$ factory ${args.join(" ")}\n${e.stdout ?? ""}${e.stderr ?? e.message}\n`);
		throw e;
	}
}

/** The web UI link `factory serve` printed; port 0 picks a new port on every start, so it is re-read after each. */
let link = "";
const token = () => new URL(link).searchParams.get("token") ?? "";
const auth = () => ({ authorization: `Bearer ${token()}` });

async function serve() {
	link = await factory("serve", "--config", CONFIG, "--fake-github", GH, "--fake-boat", join(DIR, "boat"), "--scripted", "--ci-poll-ms", "200");
	if (!/^http:\/\/127\.0\.0\.1:\d+\/\?token=/.test(link)) throw new Error(`factory serve printed no link: ${link}`);
}
async function kill9(): Promise<number> {
	const pid = livePid(CONFIG);
	if (pid === undefined) throw new Error("no live factory to kill");
	process.kill(pid, "SIGKILL");
	const deadline = Date.now() + 10_000;
	for (;;) {
		try {
			process.kill(pid, 0);
		} catch {
			return pid;
		}
		if (Date.now() > deadline) throw new Error(`factory (pid ${pid}) still alive 10s after SIGKILL`);
		await sleep(50);
	}
}

// The daemon runs in its own session, so Ctrl-C doesn't reach it and a signal exit skips main's `finally`: stop it here.
let interrupted = false;
for (const sig of ["SIGINT", "SIGTERM"] as const)
	process.once(sig, async () => {
		interrupted = true;
		say(`\n${sig}: stopping the factory`);
		await factory("stop", "--config", CONFIG).catch((e) => {
			say(`factory stop failed (${e.stderr ?? e.message}); sending SIGKILL`);
			const pid = livePid(CONFIG);
			if (pid !== undefined) process.kill(pid, "SIGKILL");
		});
		log.end();
		process.exit(sig === "SIGINT" ? 130 : 143);
	});

/** Calls a core operation over the web API; `ok: false` throws its error. */
async function api<T = any>(op: string, ...args: unknown[]): Promise<T> {
	const res = await fetch(new URL(`/api/op/${op}`, link), { method: "POST", headers: { "content-type": "application/json", ...auth() }, body: JSON.stringify({ args }) });
	const body = (await res.json()) as { ok: true; result: T } | { ok: false; error: string; code?: string };
	if (!body.ok) throw new Error(body.error);
	return body.result;
}
async function apiFails(op: string, ...args: unknown[]): Promise<string | undefined> {
	try {
		await api(op, ...args);
		return undefined;
	} catch (e: any) {
		return String(e.message);
	}
}

/** Opens `/api/events?run=` and collects its events until `close()`. */
function events(run: string): { got: FactoryEvent[]; close(): void } {
	const got: FactoryEvent[] = [];
	const ctl = new AbortController();
	(async () => {
		const res = await fetch(new URL(`/api/events?run=${encodeURIComponent(run)}`, link), { headers: auth(), signal: ctl.signal });
		if (!res.ok || !res.body) throw new Error(`events: HTTP ${res.status}`);
		const dec = new TextDecoder();
		let buf = "";
		for await (const chunk of res.body) {
			buf += dec.decode(chunk as Uint8Array, { stream: true });
			let i: number;
			while ((i = buf.indexOf("\n\n")) >= 0) {
				const frame = buf.slice(0, i);
				buf = buf.slice(i + 2);
				const data = frame.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).join("\n");
				if (data) got.push(JSON.parse(data));
			}
		}
	})().catch((e) => {
		if (!ctl.signal.aborted) say(`  event stream error: ${e.message}`);
	});
	return { got, close: () => ctl.abort() };
}

const scopeOf = (project?: string): Scope => (project ? { project } : { global: true });
let schema: Record<string, SettingField> | undefined;
/** Parses a setting value as YAML according to the schema (as the settings form does), then `setSetting`. */
async function setSetting(path: string, raw: string, project?: string) {
	schema ??= await api<Record<string, SettingField>>("settingsSchema");
	const field = fieldAt(schema, path.split("."));
	let v: unknown = YAML.parse(raw);
	if (field && (field.type === "string" || field.type === "secretRef" || field.type === "enum") && typeof v !== "string") v = raw;
	if (field?.type === "list" && typeof v === "string") v = v.split(",").map((s) => s.trim()).filter(Boolean);
	await api("setSetting", scopeOf(project), path, v);
}
const unsetSetting = (path: string, project?: string) => api("unsetSetting", scopeOf(project), path);
const startRun = (project: string, title: string, body: string) => api<string>("startRun", project, { source: "web", title, body });
async function resolveEscalation(run: string, choice: { accept: true } | { abort: true }) {
	const v = await status(run);
	if (v.pendingAsk?.question.kind !== "escalation") throw new Error(`${run}: no escalation is pending`);
	await api("resolveEscalation", run, v.pendingAsk.id, choice);
}

const status = (run: string) => api<RunView>("getRun", run);
async function transcript(run: string, which: "architect" | "builder" | "reviewer"): Promise<TranscriptView> {
	const c = (await status(run)).conversations;
	const id = which === "reviewer" ? c.reviewers.at(-1)?.id : c[which];
	if (!id) throw new Error(`${run}: no ${which} conversation yet`);
	return api<TranscriptView>("getConversation", run, id);
}
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
			await api("answer", run, ask.id, a);
		} else if (ask.question.kind === "approval") {
			if (opts.gates && (await opts.gates(v))) continue;
			say(`  approve ${ask.question.gate}`);
			await api("approve", run, ask.question.gate);
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
	section("§8.1 zero-to-MVP: createProject todo → me/todo and startRun (repo does not exist)");
	await api("createProject", "todo", `${ME}/todo`);
	const run1 = await startRun("todo", "CLI todo tool", "CLI todo tool: add/list/done/remove, JSON file storage, tests");
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
				await api("reject", run1, "spec", "Default the file to ~/.todo.json and write it atomically.");
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
	const killed = await kill9();
	say(`  killed the factory (pid ${killed}) in ${before.state}, round ${before.reviewRound}, builder transcript ${trBefore.items.length} items`);
	await serve();
	const after = await status(run1);
	check("after restart the run is still BUILDING at the same round", after.state === "BUILDING" && after.reviewRound === mid.reviewRound, `${after.state} round ${after.reviewRound}`);
	check("same builder Conversation after restart", after.conversations.builder === before.conversations.builder);
	const stream1 = events(run1);
	v1 = await drive(run1, []);
	const deliveredEvent = () => stream1.got.some((e) => e.type === "run.state" && e.to === "DELIVERED");
	for (let i = 0; i < 60 && !deliveredEvent(); i++) await sleep(50);
	stream1.close();
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
	check("the builder's helper wrote code: scripts/run.sh is on the delivered main", existsSync(join(c1, "scripts/run.sh")) && /demo-todo\.json/.test(readFileSync(join(c1, "scripts/run.sh"), "utf8")));
	section("AQ testing on (fake) boat.dev VMs, beside each review");
	check("QA ran in both review rounds", v1.reviews.length === 2 && v1.reviews.every((r) => r.qaStatus === "ran") && v1.qaStatus === "ran", JSON.stringify(v1.reviews.map((r) => r.qaStatus)));
	const qa1 = v1.findingsLog.find((e) => e.kind === "qa" && e.reviewSeq === 1);
	check("round 1 QA failed for a real reason (remove) and cited a screenshot", !!qa1 && qa1.findings.some((f) => f.blocking && /remove/i.test(f.description) && (f.screenshots?.length ?? 0) > 0), JSON.stringify(qa1));
	const shotId = qa1?.findings[0]?.screenshots?.[0] ?? "r1-s1";
	const shot = await fetch(new URL(`/api/runs/${run1}/screenshots/${shotId}`, link), { headers: auth() });
	check("the screenshot is served by the web server as image/png", shot.status === 200 && shot.headers.get("content-type") === "image/png" && (await shot.arrayBuffer()).byteLength > 0);
	const { LocalBoatBackend } = await import("../src/boat/backend.ts");
	const vms = await new LocalBoatBackend(join(DIR, "boat")).list();
	check("every QA VM of the run was deleted after its round", vms.filter((x) => x.name?.includes(run1)).length === 0, JSON.stringify(vms));
	check("QA cost (agent tokens + VM time) recorded per round", v1.cost.filter((c) => c.role === "qa").some((c) => (c.vmSeconds ?? 0) > 0) && v1.cost.filter((c) => c.role === "qa" && c.usd !== undefined).length >= 2);
	check("no screenshot was committed to the repo", !/\.png/.test((await pexec("git", ["ls-files"], { cwd: c1 })).stdout));
	check("the delivery notes record the QA status", /QA status/.test(readFileSync(join(c1, "docs/delivery-notes.md"), "utf8")));
	const states1 = stream1.got.flatMap((e) => (e.type === "run.state" ? [e.to] : []));
	const active1 = new Set(stream1.got.flatMap((e) => (e.type === "conversation.updated" && e.run === run1 ? [e.role] : [])));
	check(
		"the SSE event stream reported run.state → DELIVERED and builder and reviewer activity (conversation.updated)",
		deliveredEvent() && active1.has("builder") && active1.has("reviewer"),
		`run.state events: ${states1.join(" > ") || "(none)"}; conversation.updated roles: ${[...active1].join(", ") || "(none)"}`,
	);

	// ---------------------------------------------------------------- §8.4 settings checks (invalid value)
	section("§8.4 invalid setting is rejected and the config file is unchanged");
	const cfgBefore = readFileSync(CONFIG, "utf8");
	const err = await apiFails("setSetting", { global: true }, "ci.fixRounds", 5);
	check("setSetting ci.fixRounds 5 is rejected", !!err && /maximum 3/.test(err), err);
	check("config file unchanged", readFileSync(CONFIG, "utf8") === cfgBefore);

	// ---------------------------------------------------------------- §8.2 incremental
	section("§8.2 incremental: startRun todo \"add due dates and an --overdue filter\"");
	const run2 = await startRun("todo", "add due dates and an --overdue filter", "add due dates and an --overdue filter");
	say(`  run ${run2}`);
	await until(run2, (x) => x.state !== "RECEIVED", "run started");
	// §8.4: change the reviewer's model and thinking while run2 is in flight
	await setSetting("roles.reviewer.model", "scripted/reviewer-b");
	await setSetting("roles.reviewer.thinking", "medium");
	const v2 = await drive(run2, ["Yes: plain YYYY-MM-DD calendar dates, compared with today's local date."]);
	check("incremental delivered", v2.state === "DELIVERED", v2.failure?.reason);
	check("the architect grounded the discussion in the repo (read docs/spec.md first)", (await transcript(run2, "architect")).items.some((i: any) => i.toolCalls?.some((t: any) => t.name === "read")));
	check("delivered as a PR on the same repo", v2.artifacts.delivery?.kind === "pr" && host.state().prs.some((p) => p.repo === `${ME}/todo` && p.head === v2.artifacts.delivery!.ref));
	check("human input only for the discussion and the spec approval", v2.history.filter((h) => h.to === "AWAITING_APPROVAL").length === 1);
	check("the reviewer's own test run passed", await reviewerRanTestsGreen(run2));
	const prSrc = (await pexec("git", ["--git-dir", join(GH, "remotes", ME, "todo.git"), "show", `${v2.artifacts.delivery!.ref}:src/todo.js`])).stdout;
	check("PR branch has the due-date feature", /parseDue/.test(prSrc) && /isOverdue/.test(prSrc));
	const pushTry = (await transcript(run2, "builder")).items.find((i: any) => i.toolResult?.name === "bash" && /PUSH-EXIT/.test(i.toolResult.text))?.toolResult?.text ?? "";
	if (!SANDBOX) say("  (sandbox OFF: the check that agents can't reach GitHub is skipped)");
	else check("agent cannot reach GitHub directly: git push to origin and api.github.com fail inside the sandbox", /origin\s+\S+todo\.git \(push\)/.test(pushTry) && /PUSH-EXIT=[1-9]/.test(pushTry) && /GITHUB-API-EXIT=[1-9]/.test(pushTry), pushTry.slice(0, 600));
	say(`  builder's push attempt inside the sandbox:\n${pushTry.trim().split("\n").map((l: string) => `      ${l}`).join("\n")}`);
	check("in-flight run kept its pinned reviewer (scripted/reviewer, high)", v2.cost.filter((c) => c.role === "reviewer").every((c) => c.model === "scripted/reviewer" && c.thinking === "high"), JSON.stringify(v2.cost.filter((c) => c.role === "reviewer").map((c) => [c.model, c.thinking])));

	// ---------------------------------------------------------------- §8.3 gate rejections
	section("§8.3 delivery and merge gates on for the project; reject once at each");
	await setSetting("policy.approvals", "[spec, delivery, merge]", "todo");
	const run3 = await startRun("todo", "add a --version flag", "add a --version flag that prints the package version");
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
			await api("reject", run3, gate, fb);
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
	const revIns = await Promise.all(v3.conversations.reviewers.map((r) => api<TranscriptView>("getConversation", run3, r.id)));
	check("the next reviewer saw the human finding", revIns.some((tr) => tr.items.some((i: any) => i.role === "user" && /Human findings from a gate rejection/.test(i.text) && /--version output/.test(i.text))));
	check("next new run's reviewer uses the changed model/thinking (scripted/reviewer-b, medium)", v3.cost.filter((c) => c.role === "reviewer").every((c) => c.model === "scripted/reviewer-b" && c.thinking === "medium"));
	await unsetSetting("policy.approvals", "todo");

	// ---------------------------------------------------------------- §8.3 CI modes on a repo without CI
	section("§8.3 ci.mode off: finishes at delivery without waiting for CI");
	await setSetting("ci.mode", "off", "todo");
	const run4 = await startRun("todo", "add a --quiet flag", "add a --quiet flag that suppresses output");
	const v4 = await drive(run4, []);
	check("mode off: DELIVERED without AWAITING_CI", v4.state === "DELIVERED" && !v4.history.some((h) => h.to === "AWAITING_CI"), v4.history.map((h) => h.to).join(">"));

	section("§8.3 ci.mode required on a repo with no CI checks: escalates after ci.noChecksTimeout");
	await setSetting("ci.mode", "required", "todo");
	const run5 = await startRun("todo", "add a --json flag", "add a --json flag to list");
	const t5 = Date.now();
	const v5 = await drive(run5, []);
	const waited = v5.history.find((h) => h.to === "ESCALATED")!;
	check("mode required, no checks: ESCALATED with 'no CI checks'", v5.state === "ESCALATED" && /no CI checks/.test(v5.pendingAsk?.question.kind === "escalation" ? v5.pendingAsk.question.reason : ""), JSON.stringify(v5.pendingAsk));
	check("escalation came after ci.noChecksTimeout (4s)", !!waited && Date.now() - t5 >= 4000);
	await resolveEscalation(run5, { abort: true });
	check("escalation abort → CANCELLED", (await until(run5, (x) => x.state === "CANCELLED", "cancel")).state === "CANCELLED");
	await unsetSetting("ci.mode", "todo");

	// ---------------------------------------------------------------- §8.3 round cap
	section("§8.3 hit the review round cap: escalates; accept delivers with the findings on record");
	await setSetting("roles.reviewer.model", "scripted/reviewer-strict", "todo");
	await setSetting("policy.reviewRoundCap", "2", "todo");
	const run6 = await startRun("todo", "add a --color flag", "add a --color flag");
	const v6 = await drive(run6, []);
	check("round cap reached → ESCALATED after 2 review rounds", v6.state === "ESCALATED" && v6.reviewRound === 2 && /round cap/.test((v6.pendingAsk?.question as any)?.reason ?? ""));
	await resolveEscalation(run6, { accept: true });
	const v6b = await until(run6, (x) => ["DELIVERED", "FAILED", "CANCELLED"].includes(x.state), "delivery after accept");
	check("accept → delivered with known findings", v6b.state === "DELIVERED");
	await unsetSetting("roles.reviewer.model", "todo");
	await unsetSetting("policy.reviewRoundCap", "todo");

	// ---------------------------------------------------------------- §8.3 todo2: CI required on a new repo
	section("§8.3 todo2: new repo, ci.mode required set before the repo exists; builder ships CI");
	await api("createProject", "todo2", `${ME}/todo2`);
	await setSetting("ci.mode", "required", "todo2");
	const run7 = await startRun("todo2", "CLI todo tool", "CLI todo tool: add/list/done/remove, JSON file storage, tests");
	const v7 = await drive(run7, ["Node.js, no dependencies, node:test.", "TODO_FILE env var, default ./todo.json."]);
	check("todo2 delivered", v7.state === "DELIVERED", v7.failure?.reason);
	const c7 = await cloneMain(`${ME}/todo2`);
	check("the builder shipped a CI workflow", existsSync(join(c7, ".github/workflows/ci.yml")));
	const sha7 = v7.artifacts.delivery!.sha;
	const ck7 = host.state().checks[`${ME}/todo2@${sha7}`] ?? [];
	check("the run waited for and passed CI on the pushed commit on main", v7.history.some((h) => h.to === "AWAITING_CI") && ck7.length > 0 && ck7.every((c) => c.conclusion === "success") && !v7.noCi, JSON.stringify(ck7));

	section("§8.3 ci.fixRounds 0 and a forced CI failure: escalates without a fix round");
	await setSetting("ci.fixRounds", "0", "todo2");
	host.forceChecks(`${ME}/todo2`, [{ name: "test", status: "completed", conclusion: "failure", output: "1 failing: forced failure" } as any]);
	const run8 = await startRun("todo2", "add a --version flag", "add a --version flag");
	const v8 = await drive(run8, []);
	const b8 = await transcript(run8, "builder");
	check("CI failure with fixRounds 0 → ESCALATED", v8.state === "ESCALATED" && /CI failed/.test((v8.pendingAsk?.question as any)?.reason ?? ""), JSON.stringify(v8.pendingAsk));
	check("no CI fix round was run", v8.ciFixes === 0 && !b8.items.some((i: any) => i.role === "user" && /CI fix/.test(i.text)));
	await resolveEscalation(run8, { abort: true });
	await until(run8, (x) => x.state === "CANCELLED", "cancel");

	// ---------------------------------------------------------------- the web UI and its API
	section("Web UI and its API");
	const urlFile = daemonFiles(CONFIG).url;
	const written = existsSync(urlFile) ? readFileSync(urlFile, "utf8").trim() : "";
	check("the link factory serve printed is the one in web-url (mode 0600)", written === link && (statSync(urlFile).mode & 0o777) === 0o600, written ? `${written} vs ${link}` : "no web-url file");
	check("factory web prints the link", (await factory("web", "--config", CONFIG)) === link);
	const noToken = await fetch(new URL("/api/op/listRuns", link), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ args: [] }) });
	check("the API refuses requests without the token", noToken.status === 401);
	const runs = await api<RunView[]>("listRuns");
	const started = [run1, run2, run3, run4, run5, run6, run7, run8];
	check("with the token it lists every run of the trial", runs.map((r) => r.id).sort().join() === [...started].sort().join(), runs.map((r) => r.id).join());
	const page = await fetch(new URL(`/?token=${token()}`, link), { redirect: "manual" });
	check("the link sets an HttpOnly, SameSite=Strict session cookie", page.status === 303 && /HttpOnly; SameSite=Strict/.test(page.headers.get("set-cookie") ?? ""));
	const msgErr = await apiFails("message", run1, "thanks!");
	check("messages to a finished run are refused with a pointer to a new run (`message` op)", !!msgErr && /start a new run/.test(msgErr), msgErr);

	// ---------------------------------------------------------------- pass criteria summary
	section("§8.5 pass criteria");
	check("all runs recorded with cost and round counts", runs.every((r) => Array.isArray(r.cost) && typeof r.reviewRound === "number"));
	const refs = (await Promise.all([`${ME}/todo`, `${ME}/todo2`].map((r) => pexec("git", ["--git-dir", join(GH, "remotes", `${r}.git`), "for-each-ref", "--format=%(refname)"]).then((x) => x.stdout)))).join("");
	if (!SANDBOX) say("  (sandbox OFF: the builder's deliberate push attempt reaches the fake remote, so the remote-refs check is skipped)");
	else check("no agent-made ref reached the remotes (only main and factory/<run> branches)", refs.split("\n").filter(Boolean).every((r) => r === "refs/heads/main" || r.startsWith("refs/heads/factory/")), refs);
}

main()
	.catch((e) => {
		if (!interrupted) check(`trial aborted: ${e.message}`, false, e.stack);
	})
	.finally(async () => {
		if (interrupted) return; // the signal handler stops the factory and exits
		await factory("stop", "--config", CONFIG).catch((e) => say(`factory stop failed: ${e.stderr ?? e.message}`));
		const failed = checks.filter((c) => !c.ok);
		const md = [
			`# Dry run of spec §8 — ${new Date().toISOString()}`,
			"",
			`Directory: ${DIR}. Scripted agents (no model credentials), sandbox ${SANDBOX ? "ON" : "OFF (DRYRUN_SANDBOX=0)"}, fake GitHub with local CI runner, SQLite storage, a daemonized \`factory serve\` driven through the web HTTP API (\`POST /api/op/<op>\`, \`GET /api/events\`).`,
			"",
			"Dropped CLI-only checks: none. The terminal attach view check is replaced by the SSE event stream check.",
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
