// Dry trial of spec §8 through the web HTTP API: a daemonized `factory serve` (SQLite storage, sandbox ON unless DRYRUN_SANDBOX=0, a fake
// GitHub on the local disk with a local CI runner, scripted agents) driven by `POST /api/op/<op>` calls and the
// `GET /api/events` stream; `factory serve`, `web` and `stop` are the only CLI commands it runs. Every step names the
// §8 item it exercises. The first ticket comes from a discussion (startDiscussion, two `say`s, requestDrafts,
// updateDraft, createTicket); the discussant's web_search goes to a fake Parallel endpoint served here.
// Runs stop at READY after review; the driver ships them as bundles (createBundle) and merges them (mergeBundle), as the
// board's Ship and Merge buttons do. One step builds two tickets in parallel and ships them as one bundle.
// Writes <dir>/report.md and exits non-zero if a check fails.
//
//   npm run dry-run                  # fresh dir under /tmp
//   DRYRUN_DIR=/tmp/x npm run dry-run
//   DRYRUN_SANDBOX=0 npm run dry-run   # where the sandbox runtime can't run (e.g. no socat on Linux)
import { execFile } from "node:child_process";
import { appendFileSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import YAML from "yaml";
import { fieldAt } from "../src/core/settings.ts";
import { daemonFiles, livePid } from "../src/daemon.ts";
import { LocalGitHubHost } from "../src/github/host.ts";
import { SLOW_COMMAND, SLOW_MARK, TODO_REQUEST } from "../src/testing/dry-run-agents.ts";
import type { BundleView, DiscussionLink, DiscussionView, FactoryEvent, RunView, Scope, SettingField, TranscriptView } from "../src/core/types.ts";

const pexec = promisify(execFile);
const ROOT = resolve(import.meta.dirname, "..");
const DIR = resolve(process.env.DRYRUN_DIR ?? mkdtempSync(join(tmpdir(), "sf-dryrun-")));
mkdirSync(DIR, { recursive: true });
const CONFIG = join(DIR, "config.yaml");
const GH = join(DIR, "github");
const BIN = join(ROOT, "bin/factory");
const ME = "me";
const SANDBOX = process.env.DRYRUN_SANDBOX !== "0";

// A stand-in for Parallel's Search API, so the discussant's web_search gets a result without leaving the machine.
const searches: unknown[] = [];
const searchServer = createServer((req, res) => {
	let body = "";
	req.on("data", (c) => (body += c));
	req.on("end", () => {
		searches.push(JSON.parse(body || "{}"));
		res.writeHead(200, { "content-type": "application/json" });
		res.end(
			JSON.stringify({
				search_id: `dry-${searches.length}`,
				results: [{ url: "https://nodejs.org/api/test.html", title: "Test runner | Node.js documentation", excerpts: ["The node:test module facilitates the creation of JavaScript tests. Stability: 2 - Stable."] }],
			}),
		);
	});
});
await new Promise<void>((r) => searchServer.listen(0, "127.0.0.1", r));
searchServer.unref();
const SEARCH_ENDPOINT = `http://127.0.0.1:${(searchServer.address() as AddressInfo).port}/v1beta/search`;

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
  integrator: { model: scripted/integrator }
discussion:
  model: { model: scripted/discussant }
webSearch:
  apiKey: env:DRYRUN_SEARCH_KEY
  endpoint: ${SEARCH_ENDPOINT}
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
			env: { ...process.env, NO_COLOR: "1", DRYRUN_BOAT_KEY: "fake-boat-key", DRYRUN_SEARCH_KEY: "fake-search-key", DRYRUN_TURN_DELAY_MS: process.env.DRYRUN_TURN_DELAY_MS ?? "250" },
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
/** Calls an operation that should fail: its HTTP status, error code and message (undefined if it succeeded). */
async function apiError(op: string, ...args: unknown[]): Promise<{ status: number; code?: string; error: string } | undefined> {
	const res = await fetch(new URL(`/api/op/${op}`, link), { method: "POST", headers: { "content-type": "application/json", ...auth() }, body: JSON.stringify({ args }) });
	const body = (await res.json()) as { ok: true } | { ok: false; error: string; code?: string };
	return body.ok ? undefined : { status: res.status, ...(body.code ? { code: body.code } : {}), error: body.error };
}
async function apiFails(op: string, ...args: unknown[]): Promise<string | undefined> {
	try {
		await api(op, ...args);
		return undefined;
	} catch (e: any) {
		return String(e.message);
	}
}

/** Opens `/api/events?<filter>=<id>` (run, bundle or project) and collects its events until `close()`. */
function events(id: string, filter: "run" | "bundle" | "project" = "run"): { got: FactoryEvent[]; close(): void } {
	const got: FactoryEvent[] = [];
	const ctl = new AbortController();
	(async () => {
		const res = await fetch(new URL(`/api/events?${filter}=${encodeURIComponent(id)}`, link), { headers: auth(), signal: ctl.signal });
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
async function untilDiscussion(id: string, pred: (d: DiscussionView) => boolean, what: string, ms = 60_000): Promise<DiscussionView> {
	const t0 = Date.now();
	for (;;) {
		const d = await api<DiscussionView>("getDiscussion", id);
		if (pred(d)) return d;
		if (d.state === "FAILED") throw new Error(`discussion ${id} FAILED while waiting for ${what}: ${d.error ?? ""}`);
		if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${what}; discussion is ${d.state}${d.turn ? `, ${d.turn.kind} turn running` : ""}`);
		await sleep(150);
	}
}
/** Sends a human message to a discussion and waits for the turn it starts to end. */
async function discuss(id: string, text: string): Promise<DiscussionView> {
	say(`  human says: ${text}`);
	await api("say", id, text);
	const d = await untilDiscussion(id, (x) => !x.turn, "the reply");
	const reply = (await api<TranscriptView>("getDiscussionConversation", id)).items.filter((i: any) => i.role === "assistant" && i.text).at(-1)?.text ?? "";
	say(`  discussant replies: ${reply}`);
	return d;
}

const pendingKind = (v: RunView, kind: string, gate?: string) =>
	v.pendingAsk?.question.kind === kind && (!gate || (v.pendingAsk.question as any).gate === gate);

/** Answer the human side of a run: discussion answers in order, the spec approval, then wait for READY (or an end state). */
async function drive(run: string, answers: string[], opts: { gates?: (v: RunView) => Promise<boolean>; until?: (v: RunView) => boolean } = {}) {
	const seen = new Set<string>();
	const end = opts.until ?? ((v: RunView) => ["READY", "DELIVERED", "FAILED", "CANCELLED", "ESCALATED"].includes(v.state));
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
const ranTestsGreen = (tr: TranscriptView) => tr.items.some((i: any) => i.toolResult?.name === "run_tests" && /\[exit code 0\]/.test(i.toolResult.text));
const reviewerRanTestsGreen = async (run: string) => ranTestsGreen(await transcript(run, "reviewer"));
/** Waits until the builder's n-th slow command (SLOW_COMMAND(n)) is running: its callId, its `running` slot and the transcript. */
async function untilSlowCall(run: string, n: number, ms = 60_000) {
	const t0 = Date.now();
	for (;;) {
		const cid = (await status(run)).conversations.builder;
		if (cid !== undefined) {
			const tr = await api<TranscriptView>("getConversation", run, cid);
			const callId = (tr.items as any[]).flatMap((i) => i.toolCalls ?? []).find((c: any) => c.name === "bash" && String(c.args?.command ?? "").includes(`SLOW-START-${n};`))?.id as string | undefined;
			const slot = tr.running.find((s) => s.callId === callId);
			if (callId && slot?.status === "running" && slot.startedAt !== undefined) return { callId, slot, tr };
		}
		if (Date.now() - t0 > ms) throw new Error(`timeout waiting for the builder's slow command ${n} to run`);
		await sleep(100);
	}
}
/** Waits for the result of a tool call in a run's Conversation. */
async function untilToolResult(run: string, cid: string, callId: string, ms = 30_000): Promise<NonNullable<TranscriptView["items"][number]["toolResult"]>> {
	const t0 = Date.now();
	for (;;) {
		const tr = await api<TranscriptView>("getConversation", run, cid);
		const r = (tr.items as any[]).find((i) => i.toolResult?.callId === callId)?.toolResult;
		if (r) return r;
		if (Date.now() - t0 > ms) throw new Error(`timeout waiting for the result of ${callId}`);
		await sleep(100);
	}
}
const userInputs = (tr: TranscriptView) => tr.items.filter((i: any) => i.role === "user" && i.text).map((i: any) => String(i.text));

// ------------------------------------------------------------------ bundles: Ship and Merge
const bundleStatus = (id: string) => api<BundleView>("getBundle", id);
const bundlePath = (b: BundleView) => b.history.map((h) => h.to).join(" → ");
/** The merge card, an escalation, or an end. */
const atCard = (b: BundleView) => (b.state === "AWAITING_MERGE" && !!b.pendingAsk) || ["MERGED", "FAILED", "CANCELLED", "ESCALATED"].includes(b.state);
async function untilBundle(id: string, pred: (b: BundleView) => boolean, what: string, ms = 180_000): Promise<BundleView> {
	const t0 = Date.now();
	for (;;) {
		const b = await bundleStatus(id);
		if (pred(b)) return b;
		if (["MERGED", "FAILED", "CANCELLED"].includes(b.state)) throw new Error(`${id} ended in ${b.state} while waiting for ${what}: ${b.failure?.reason ?? ""}`);
		if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${what}; ${id} is ${b.state}`);
		await sleep(150);
	}
}
async function bundleTranscript(id: string, which: "integrator" | "reviewer" | "qa"): Promise<TranscriptView> {
	const c = (await bundleStatus(id)).conversations;
	const cid = which === "integrator" ? c.integrator : c[which === "reviewer" ? "reviewers" : "qa"].at(-1)?.id;
	if (cid === undefined) throw new Error(`${id}: no ${which} conversation yet`);
	return api<TranscriptView>("getBundleConversation", id, cid);
}
/** Ship: waits for the runs to be READY, creates one bundle of them, and waits for its merge card (or an escalation, or an end). */
async function ship(project: string, runs: string[]): Promise<{ id: string; b: BundleView }> {
	for (const r of runs) await until(r, (x) => x.state === "READY", `${r} to be Ready`);
	const id = await api<string>("createBundle", project, runs);
	say(`  ship ${runs.join(" + ")} → ${id}`);
	const b = await untilBundle(id, atCard, "the merge card");
	say(`  ${id}: ${bundlePath(b)}${b.pendingAsk ? ` (asks: ${b.pendingAsk.question.kind})` : ""}`);
	return { id, b };
}
/** Merge: clicks Merge at the merge card (a PR; a new repo's bundle merges by itself) and waits until its runs are DELIVERED. */
async function merge(id: string): Promise<BundleView> {
	const before = await bundleStatus(id);
	if (before.state === "AWAITING_MERGE") {
		say(`  merge ${id}`);
		await api("mergeBundle", id);
	}
	const b = await untilBundle(id, (x) => x.state === "MERGED", "the merge");
	for (const m of b.members) await until(m.run, (x) => x.state === "DELIVERED", `${m.run} to be delivered`);
	return b;
}
/** Ship one run as a bundle of one (the run view's "Ship this ticket") and merge it. */
async function shipOne(project: string, run: string): Promise<{ v: RunView; b: BundleView; id: string }> {
	const { id } = await ship(project, [run]);
	const b = await merge(id);
	return { v: await status(run), b, id };
}
const prOf = (b: BundleView) => gh().state().prs.find((p) => b.delivery?.pr && p.repo === b.delivery.pr.repo && p.number === b.delivery.pr.number);
const remoteRef = (repo: string, ref: string) =>
	pexec("git", ["--git-dir", join(GH, "remotes", `${repo}.git`), "rev-parse", "--verify", "-q", ref]).then((x) => x.stdout.trim(), () => "");
const remoteFile = (repo: string, ref: string, path: string) =>
	pexec("git", ["--git-dir", join(GH, "remotes", `${repo}.git`), "show", `${ref}:${path}`]).then((x) => x.stdout, () => undefined);
let hostRef: LocalGitHubHost | undefined;
const gh = () => (hostRef ??= new LocalGitHubHost(GH));
/** Ready: the reviewed branch factory/<run-id> is pushed, no PR is open for it and nothing was delivered. */
async function readyChecks(repo: string, v: RunView) {
	const branch = `factory/${v.id}`;
	return v.state === "READY" && !v.artifacts.delivery && !v.bundle && !!(await remoteRef(repo, `refs/heads/${branch}`)) && !gh().state().prs.some((p) => p.head === branch) && v.specPath === `docs/specs/${v.id}.md` && /Acceptance behaviours/.test((await remoteFile(repo, branch, `docs/specs/${v.id}.md`)) ?? "");
}

// ------------------------------------------------------------------ the trial
async function main() {
	say(`dry run in ${DIR}`);
	await serve();
	const host = new LocalGitHubHost(GH); // the driver's view of the fake GitHub (state file + bare remotes)
	hostRef = host;

	// ---------------------------------------------------------------- §8.1 zero-to-MVP
	section("§8.1 zero-to-MVP: createProject todo → me/todo, a discussion, then a ticket from its draft (repo does not exist)");
	await api("createProject", "todo", `${ME}/todo`);
	const first = "I'd like a small command-line todo tool, but I'm not sure how much it should do.";
	say(`  human starts a discussion: ${first}`);
	const disc = await api<string>("startDiscussion", "todo", { title: "A todo CLI", message: first });
	say(`  discussion ${disc}`);
	await untilDiscussion(disc, (d) => d.state === "OPEN" && !d.turn, "the discussion to open and reply");
	await discuss(disc, "add, list, done and remove. Keep storage as simple as possible.");
	const open = await discuss(disc, "One JSON file is fine. Are Node's built-in tests good enough, or do we need a framework?");
	const items = (await api<TranscriptView>("getDiscussionConversation", disc)).items as any[];
	const humans = items.flatMap((i, k) => (i.author === "human" ? [k] : []));
	const answered = humans.filter((h, k) => items.slice(h + 1, humans[k + 1] ?? items.length).some((i) => i.role === "assistant" && i.text));
	const ranOk = (name: string) => items.some((i) => i.toolResult?.name === name && !i.toolResult.isError);
	check(
		"discussion reached OPEN and answered both messages (after an ls, then a web search)",
		open.state === "OPEN" && open.notices.length === 0 && humans.length === 2 && answered.length === 2 && ranOk("bash") && ranOk("web_search") && searches.length === 1,
		`state ${open.state}; human messages ${humans.length}, answered ${answered.length}; bash ${ranOk("bash")}, web_search ${ranOk("web_search")} (${searches.length} searches); notices ${JSON.stringify(open.notices)}`,
	);
	say("  human asks for draft tickets");
	await api("requestDrafts", disc);
	const drafted = await untilDiscussion(disc, (d) => !d.turn && (d.drafts.length > 0 || d.notices.length > 0), "the drafts");
	const draft = drafted.drafts[0];
	check(
		"drafts submitted with a summary",
		drafted.drafts.length === 1 && draft?.body === TODO_REQUEST && !draft.edited && /## Settled[\s\S]*storage: one JSON file/.test(drafted.summary ?? ""),
		JSON.stringify({ summary: drafted.summary, drafts: drafted.drafts, notices: drafted.notices }),
	);
	if (!draft) throw new Error("no draft to create the ticket from");
	const added = "The list must survive between invocations.";
	say(`  human edits draft ${draft.id}: appends "${added}"`);
	await api("updateDraft", disc, draft.id, { body: `${draft.body}\n\n${added}` });
	const run1 = await api<string>("createTicket", disc, draft.id);
	say(`  createTicket → run ${run1}`);
	const req1 = (await status(run1)).request;
	const link1 = req1.meta?.discussion as DiscussionLink | undefined;
	const linked = (await api<DiscussionView>("getDiscussion", disc)).drafts.find((x) => x.id === draft.id);
	check(
		"the run's request came from the discussion (source, meta)",
		req1.source === "discussion" && req1.title === draft.title && req1.body === `${TODO_REQUEST}\n\n${added}` && link1?.id === disc && link1.draftId === draft.id && link1.title === "A todo CLI" && link1.summary === drafted.summary && linked?.runId === run1 && linked.edited,
		JSON.stringify({ request: req1, draft: linked }),
	);
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
	const trA = await transcript(run1, "architect");
	const archIn = (trA.items.find((i: any) => i.role === "user") as any)?.text ?? "";
	check("the architect's first input carried the discussion summary", /# Prior discussion/.test(archIn) && archIn.includes(drafted.summary!.trim()) && archIn.includes("A todo CLI"), archIn.slice(0, 1500));
	check("discussion asked two questions, one at a time", trA.items.filter((i: any) => i.toolCalls?.some((t: any) => t.name === "ask_human")).length === 2);
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
	check(
		"zero-to-MVP stopped in Ready after its review: no repo created, nothing delivered, no PR",
		v1.state === "READY" && !v1.artifacts.delivery && !host.state().created.includes(`${ME}/todo`) && host.state().prs.length === 0 && v1.specPath === `docs/specs/${run1}.md`,
		`${v1.state}; delivery ${JSON.stringify(v1.artifacts.delivery)}; created ${host.state().created.join(", ")}`,
	);
	section("§8.1 Ship this ticket (a bundle of one) on a new repo: create the repo, push to main, CI, done");
	const ship1 = await ship("todo", [run1]);
	const b1 = await merge(ship1.id);
	v1 = await status(run1);
	const deliveredEvent = () => stream1.got.some((e) => e.type === "run.state" && e.to === "DELIVERED");
	for (let i = 0; i < 60 && !deliveredEvent(); i++) await sleep(50);
	stream1.close();
	check("zero-to-MVP delivered by its bundle", v1.state === "DELIVERED" && v1.bundle === ship1.id && v1.notices.some((n) => n.text === `Merged in ${ship1.id}: ${b1.delivery?.url}`), `${v1.state}, bundle ${v1.bundle}: ${v1.failure?.reason ?? JSON.stringify(v1.notices.at(-1))}`);
	check(
		"a new repo's bundle goes INTEGRATING → DELIVERING → AWAITING_CI → MERGED: no PR and no Merge click",
		bundlePath(b1) === "INTEGRATING → DELIVERING → AWAITING_CI → MERGED" && b1.members.map((m) => m.run).join() === run1 && b1.reviews.length === 0 && !host.state().prs.some((p) => p.repo === `${ME}/todo`),
		bundlePath(b1),
	);
	const trB = await transcript(run1, "builder");
	check("the builder's first input was admitted once (idempotent across the crash)", trB.items.filter((i: any) => i.role === "user" && /^# Build/.test(i.text)).length === 1);
	check("forced review failure: round 1 failed for a real reason (remove missing)", v1.findingsLog[0]?.kind === "review" && v1.findingsLog[0]!.findings.some((f) => f.blocking) && /remove/.test(v1.findingsLog[0]!.findings[0]!.description) && !!v1.findingsLog[0]!.findings[0]!.evidence);
	check("the same builder Conversation received the findings", trB.items.some((i: any) => i.role === "user" && /^# Findings to address/.test(i.text)) && v1.cost.filter((c) => c.role === "builder").every((c) => c.conversationId === v1.conversations.builder));
	check("review passed in round 2", v1.reviewRound === 2 && !v1.findingsLog.at(-1)!.findings.some((f) => f.blocking));
	check("the reviewer's own test run passed on the delivery", await reviewerRanTestsGreen(run1));
	check("delivered as a push to main of a new private repo", v1.artifacts.delivery?.kind === "repo" && b1.delivery?.kind === "repo" && v1.artifacts.delivery.url === b1.delivery.url && host.state().calls.some((c) => c.op === "createRepo" && c.repo === `${ME}/todo` && (c.detail as any)?.private === true));
	const c1 = await cloneMain(`${ME}/todo`);
	const need = ["package.json", "src/todo.js", "bin/todo.js", "test/todo.test.js", "README.md", "AGENTS.md", `docs/specs/${run1}.md`, "docs/delivery-notes.md", "scripts/setup.sh"];
	check("main has code, tests, README, AGENTS.md, the ticket's spec (docs/specs/<run-id>.md) and delivery notes", need.every((f) => existsSync(join(c1, f))), need.filter((f) => !existsSync(join(c1, f))).join(", "));
	const notes1 = existsSync(join(c1, "docs/delivery-notes.md")) ? readFileSync(join(c1, "docs/delivery-notes.md"), "utf8") : "";
	check(
		'the bundle wrote the delivery notes: a "## Ticket: <title>" section citing the spec path, and "## Integration"',
		notes1.includes(`## Ticket: ${v1.request.title}`) && notes1.includes(`docs/specs/${run1}.md`) && notes1.includes("## Integration") && notes1.includes(ship1.id),
		notes1.slice(0, 1500),
	);
	const npmTest = await pexec("npm", ["test"], { cwd: c1 }).then(() => true, () => false);
	check("npm test passes on the delivered main", npmTest);
	check("if-present on a repo without CI: the bundle finished and noted that there was no CI", b1.noCi === true && b1.history.some((h) => h.to === "AWAITING_CI") && /CI did not run/.test(notes1), JSON.stringify({ noCi: b1.noCi, path: bundlePath(b1) }));
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
	const boatBackend = new LocalBoatBackend(join(DIR, "boat"));
	const vms = await boatBackend.list();
	check("every QA VM of the run was deleted after its round", vms.filter((x) => x.name?.includes(run1)).length === 0, JSON.stringify(vms));
	check("QA cost (agent tokens + VM time) recorded per round", v1.cost.filter((c) => c.role === "qa").some((c) => (c.vmSeconds ?? 0) > 0) && v1.cost.filter((c) => c.role === "qa" && c.usd !== undefined).length >= 2);
	check("no screenshot was committed to the repo", !/\.png/.test((await pexec("git", ["ls-files"], { cwd: c1 })).stdout));
	check("the delivery notes record the ticket's QA status", /AQ testing \(QA status\)/.test(notes1));
	const states1 = stream1.got.flatMap((e) => (e.type === "run.state" ? [e.to] : []));
	const active1 = new Set(stream1.got.flatMap((e) => (e.type === "conversation.updated" && e.run === run1 ? [e.role] : [])));
	check(
		"the SSE event stream reported run.state → READY → DELIVERED and builder and reviewer activity (conversation.updated)",
		deliveredEvent() && states1.includes("READY") && states1.indexOf("READY") < states1.lastIndexOf("DELIVERED") && active1.has("builder") && active1.has("reviewer"),
		`run.state events: ${states1.join(" > ") || "(none)"}; conversation.updated roles: ${[...active1].join(", ") || "(none)"}`,
	);

	// ---------------------------------------------------------------- §8.4 settings checks (invalid value)
	section("§8.4 invalid setting is rejected and the config file is unchanged");
	const cfgBefore = readFileSync(CONFIG, "utf8");
	const err = await apiFails("setSetting", { global: true }, "ci.fixRounds", 5);
	check("setSetting ci.fixRounds 5 is rejected", !!err && /maximum 3/.test(err), err);
	const errMm = await apiFails("setSetting", { project: "todo" }, "bundle.mergeMethod", "fast-forward");
	check("setSetting bundle.mergeMethod fast-forward is rejected (merge | squash | rebase)", !!errMm, errMm);
	check("config file unchanged", readFileSync(CONFIG, "utf8") === cfgBefore);

	// ---------------------------------------------------------------- §8.2 incremental
	section('§8.2 incremental: startRun todo "add due dates and an --overdue filter"; Ready, then Ship and Merge');
	const run2 = await startRun("todo", "add due dates and an --overdue filter", "add due dates and an --overdue filter");
	say(`  run ${run2}`);
	await until(run2, (x) => x.state !== "RECEIVED", "run started");
	// §8.4: change the reviewer's model and thinking while run2 is in flight
	await setSetting("roles.reviewer.model", "scripted/reviewer-b");
	await setSetting("roles.reviewer.thinking", "medium");
	let v2 = await drive(run2, ["Yes: plain YYYY-MM-DD calendar dates, compared with today's local date."]);
	check("incremental stopped in Ready: branch factory/<run-id> pushed with its spec at docs/specs/<run-id>.md, no PR", await readyChecks(`${ME}/todo`, v2), `${v2.state}; spec ${v2.specPath}; PRs ${JSON.stringify(host.state().prs.map((p) => p.head))}`);
	const archRead = (await transcript(run2, "architect")).items.find((i: any) => i.toolResult?.name === "bash")?.toolResult?.text ?? "";
	check("the architect grounded the discussion in the repo (read the earlier ticket's spec in docs/specs/ first)", archRead.includes(`${run1}.md`) && /command-line todo tool/.test(archRead), archRead.slice(0, 400));
	check("human input only for the discussion and the spec approval", v2.history.filter((h) => h.to === "AWAITING_APPROVAL").length === 1);
	check("the reviewer's own test run passed", await reviewerRanTestsGreen(run2));
	const ship2 = await ship("todo", [run2]);
	const pr2 = prOf(ship2.b);
	check(
		'one PR for the bundle of one: the ticket\'s title, a "## Ticket" section citing docs/specs/<run-id>.md, "## Integration" (clean merge, no bundle review: one ticket)',
		ship2.b.state === "AWAITING_MERGE" && !!pr2 && pr2.head === `factory/${ship2.id}` && pr2.title === v2.request.title && pr2.body.includes(`## Ticket: ${v2.request.title}`) && pr2.body.includes(`docs/specs/${run2}.md`) && /## Integration[\s\S]*merged cleanly/.test(pr2.body) && ship2.b.reviews.length === 0,
		JSON.stringify({ path: bundlePath(ship2.b), pr: pr2 && { head: pr2.head, title: pr2.title, body: pr2.body.slice(0, 900) } }),
	);
	check("the bundle of one went INTEGRATING → DELIVERING → AWAITING_CI → AWAITING_MERGE (the Merge card)", bundlePath(ship2.b) === "INTEGRATING → DELIVERING → AWAITING_CI → AWAITING_MERGE" && ship2.b.pendingAsk?.question.kind === "merge", bundlePath(ship2.b));
	const b2 = await merge(ship2.id);
	v2 = await status(run2);
	const merge2 = host.state().calls.filter((c) => c.op === "mergePr").at(-1);
	check(
		"incremental delivered after Merge: the PR merged with bundle.mergeMethod (squash)",
		v2.state === "DELIVERED" && v2.artifacts.delivery?.kind === "pr" && v2.artifacts.delivery.url === b2.delivery?.url && prOf(b2)?.state === "merged" && JSON.stringify(merge2?.detail ?? "").includes("squash"),
		JSON.stringify({ state: v2.state, delivery: v2.artifacts.delivery, merge: merge2 }),
	);
	const prSrc = (await remoteFile(`${ME}/todo`, "main", "src/todo.js")) ?? "";
	check("main has the due-date feature after the merge", /parseDue/.test(prSrc) && /isOverdue/.test(prSrc));
	const pushTry = (await transcript(run2, "builder")).items.find((i: any) => i.toolResult?.name === "bash" && /PUSH-EXIT/.test(i.toolResult.text))?.toolResult?.text ?? "";
	if (!SANDBOX) say("  (sandbox OFF: the check that agents can't reach GitHub is skipped)");
	else check("agent cannot reach GitHub directly: git push to origin and api.github.com fail inside the sandbox", /origin\s+\S+todo\.git \(push\)/.test(pushTry) && /PUSH-EXIT=[1-9]/.test(pushTry) && /GITHUB-API-EXIT=[1-9]/.test(pushTry), pushTry.slice(0, 600));
	say(`  builder's push attempt inside the sandbox:\n${pushTry.trim().split("\n").map((l: string) => `      ${l}`).join("\n")}`);
	check("in-flight run kept its pinned reviewer (scripted/reviewer, high)", v2.cost.filter((c) => c.role === "reviewer").every((c) => c.model === "scripted/reviewer" && c.thinking === "high"), JSON.stringify(v2.cost.filter((c) => c.role === "reviewer").map((c) => [c.model, c.thinking])));

	// ---------------------------------------------------------------- §8.3 gate rejections
	section("§8.3 delivery gate (and the legacy merge gate) on for the project; reject the delivery gate once, then Request changes at the bundle's Merge card");
	await setSetting("policy.approvals", "[spec, delivery, merge]", "todo");
	const run3 = await startRun("todo", "add a --version flag", "add a --version flag that prints the package version");
	const rejectedGates = new Set<string>();
	const gatesAsked = new Set<string>();
	const roundsAt: Record<string, number> = {};
	let v3 = await drive(run3, [], {
		gates: async (v) => {
			const gate = (v.pendingAsk!.question as any).gate as string;
			gatesAsked.add(gate);
			if (gate === "spec" || rejectedGates.has(gate)) return false;
			rejectedGates.add(gate);
			roundsAt[gate] = v.reviewRound;
			const fb = "README must show an example of the --version output.";
			say(`  reject ${gate}: ${fb}`);
			await api("reject", run3, gate, fb);
			const w = await until(run3, (x) => x.state === "REVIEWING" || (x.state === "AWAITING_APPROVAL" && x.pendingAsk?.id !== v.pendingAsk!.id), "after rejection");
			const tr = await transcript(run3, "builder");
			const lastIn = tr.items.filter((i: any) => i.role === "user").at(-1)?.text ?? "";
			check(`${gate} rejection → same builder got a blocking source:human finding`, w.conversations.builder === v.conversations.builder && /\(human, BLOCKING/.test(lastIn) && lastIn.includes(fb), lastIn.slice(0, 300));
			check(`${gate} rejection added no review or CI round`, w.reviewRound === roundsAt[gate] && w.ciFixes === v.ciFixes);
			return true;
		},
	});
	const path3 = v3.history.map((h) => h.to);
	check("the delivery gate was rejected once and sits before Ready", rejectedGates.has("delivery") && v3.state === "READY" && path3.lastIndexOf("READY") > path3.lastIndexOf("AWAITING_APPROVAL"), path3.join(">"));
	check("approvals: merge is legacy: the run reached Ready without a merge gate", !gatesAsked.has("merge") && v3.state === "READY", [...gatesAsked].join(", "));
	const revIns = await Promise.all(v3.conversations.reviewers.map((r) => api<TranscriptView>("getConversation", run3, r.id)));
	check("the next reviewer saw the human finding", revIns.some((tr) => tr.items.some((i: any) => i.role === "user" && /Human findings from a gate rejection/.test(i.text) && /--version output/.test(i.text))));
	check("next new run's reviewer uses the changed model/thinking (scripted/reviewer-b, medium)", v3.cost.filter((c) => c.role === "reviewer").every((c) => c.model === "scripted/reviewer-b" && c.thinking === "medium"));
	const ship3 = await ship("todo", [run3]);
	const card3 = ship3.b;
	const fb3 = "Mention the --version flag in AGENTS.md.";
	say(`  request changes on ${ship3.id}: ${fb3}`);
	await api("requestBundleChanges", ship3.id, fb3);
	const back3 = await untilBundle(ship3.id, (x) => atCard(x) && x.pendingAsk?.id !== card3.pendingAsk?.id, "a fresh Merge card after the changes");
	say(`  ${ship3.id}: ${bundlePath(back3)}`);
	const it3 = userInputs(await bundleTranscript(ship3.id, "integrator")).at(-1) ?? "";
	check("Request changes → the bundle's integrator got one blocking source:human finding", /^# Findings to address/m.test(it3) && /\(human, BLOCKING/.test(it3) && it3.includes(fb3), it3.slice(0, 500));
	check(
		"Request changes added no review or CI round; the change went FIXING → REVIEWING → CI → a fresh Merge card",
		back3.state === "AWAITING_MERGE" && back3.reviewRound === card3.reviewRound && back3.ciFixes === card3.ciFixes && back3.reviews.length === card3.reviews.length + 1 && /AWAITING_MERGE → FIXING → REVIEWING → DELIVERING → AWAITING_CI → AWAITING_MERGE$/.test(bundlePath(back3)),
		`${bundlePath(back3)}; reviewRound ${card3.reviewRound}→${back3.reviewRound}, ciFixes ${card3.ciFixes}→${back3.ciFixes}, reviews ${card3.reviews.length}→${back3.reviews.length}`,
	);
	const brev3 = userInputs(await bundleTranscript(ship3.id, "reviewer")).join("\n");
	check("the bundle's reviewer saw the human finding and the integrator's response", /Human findings from a gate rejection/.test(brev3) && brev3.includes(fb3) && /integrator: fixed/.test(brev3), brev3.slice(-800));
	check(
		"the bundle's reviewer used the model pinned when it was created (scripted/reviewer-b, medium)",
		back3.cost.some((c) => c.role === "reviewer") && back3.cost.filter((c) => c.role === "reviewer").every((c) => c.model === "scripted/reviewer-b" && c.thinking === "medium"),
		JSON.stringify(back3.cost.map((c) => [c.role, c.model, c.thinking])),
	);
	const b3 = await merge(ship3.id);
	v3 = await status(run3);
	check("run with the delivery rejection and the Request changes delivered (merged)", v3.state === "DELIVERED" && prOf(b3)?.state === "merged" && v3.artifacts.delivery?.url === b3.delivery?.url, v3.failure?.reason);
	check("the integrator's change is on main (AGENTS.md mentions --version)", /--version/.test((await remoteFile(`${ME}/todo`, "main", "AGENTS.md")) ?? ""));
	await unsetSetting("policy.approvals", "todo");

	// ---------------------------------------------------------------- §8.3 CI modes on a repo without CI
	section("§8.3 ci.mode off: the bundle goes to the Merge card without waiting for CI");
	await setSetting("ci.mode", "off", "todo");
	const run4 = await startRun("todo", "add a --quiet flag", "add a --quiet flag that suppresses output");
	await drive(run4, []);
	const ship4 = await shipOne("todo", run4);
	await unsetSetting("ci.mode", "todo");
	check("mode off: the bundle skipped AWAITING_CI and the run was DELIVERED after Merge", ship4.v.state === "DELIVERED" && !ship4.b.history.some((h) => h.to === "AWAITING_CI") && ship4.b.history.some((h) => h.to === "AWAITING_MERGE"), bundlePath(ship4.b));

	section("§8.3 ci.mode required on a repo with no CI checks: the bundle escalates after ci.noChecksTimeout");
	await setSetting("ci.mode", "required", "todo");
	const run5 = await startRun("todo", "add a --json flag", "add a --json flag to list");
	await drive(run5, []);
	const t5 = Date.now();
	const ship5 = await ship("todo", [run5]);
	const v5 = ship5.b;
	const waited = v5.history.find((h) => h.to === "ESCALATED");
	check(
		"mode required, no checks: the bundle is ESCALATED with 'no CI checks' (More rounds / Drop tickets / Abort)",
		v5.state === "ESCALATED" && v5.pendingAsk?.question.kind === "escalation" && /no CI checks/.test(v5.pendingAsk.question.reason) && v5.pendingAsk.question.options.join() === "more-rounds,drop,abort",
		JSON.stringify(v5.pendingAsk),
	);
	check("escalation came after ci.noChecksTimeout (4s)", !!waited && Date.now() - t5 >= 4000);
	await api("resolveBundleEscalation", ship5.id, v5.pendingAsk!.id, { abort: true });
	const c5 = await untilBundle(ship5.id, (x) => x.state === "CANCELLED", "cancel");
	const r5 = await until(run5, (x) => x.state === "READY" && !x.bundle, "released to Ready");
	check("escalation abort → bundle CANCELLED, its PR closed, the run back in Ready", c5.state === "CANCELLED" && prOf(c5)?.state === "closed" && r5.state === "READY" && !r5.bundle, JSON.stringify({ bundle: c5.state, pr: prOf(c5)?.state, run: r5.state, in: r5.bundle }));
	await api("cancelRun", run5, "dry run: CI is required but the repo has none");
	check("the released run can be cancelled → CANCELLED", (await until(run5, (x) => x.state === "CANCELLED", "cancel")).state === "CANCELLED");
	await unsetSetting("ci.mode", "todo");

	// ---------------------------------------------------------------- §8.3 round cap
	section("§8.3 hit the review round cap: escalates; accept goes to Ready; shipped with the findings on record");
	await setSetting("roles.reviewer.model", "scripted/reviewer-strict", "todo");
	await setSetting("policy.reviewRoundCap", "2", "todo");
	const run6 = await startRun("todo", "add a --color flag", "add a --color flag");
	const v6 = await drive(run6, []);
	check("round cap reached → ESCALATED after 2 review rounds", v6.state === "ESCALATED" && v6.reviewRound === 2 && /round cap/.test((v6.pendingAsk?.question as any)?.reason ?? ""));
	await resolveEscalation(run6, { accept: true });
	const v6r = await until(run6, (x) => x.state === "READY", "Ready after accept");
	check("accept → Ready with the accepted findings on record", v6r.state === "READY" && v6r.acceptedBlocking.length > 0);
	await unsetSetting("roles.reviewer.model", "todo");
	await unsetSetting("policy.reviewRoundCap", "todo");
	const ship6 = await shipOne("todo", run6);
	const body6 = prOf(ship6.b)?.body ?? "";
	check("shipped and delivered; the PR's ticket section lists the findings accepted as is", ship6.v.state === "DELIVERED" && /## Ticket: add a --color flag[\s\S]*Open blocking findings accepted as is by a human[\s\S]*## Integration/.test(body6), body6.slice(0, 1200));

	// ---------------------------------------------------------------- §8.3 todo2: CI required on a new repo
	section("§8.3 todo2: new repo, ci.mode required set before the repo exists; builder ships CI");
	await api("createProject", "todo2", `${ME}/todo2`);
	await setSetting("ci.mode", "required", "todo2");
	const run7 = await startRun("todo2", "CLI todo tool", "CLI todo tool: add/list/done/remove, JSON file storage, tests");
	await drive(run7, ["Node.js, no dependencies, node:test.", "TODO_FILE env var, default ./todo.json."]);
	const ship7 = await shipOne("todo2", run7);
	const v7 = ship7.v;
	check("todo2 delivered by its bundle", v7.state === "DELIVERED" && v7.bundle === ship7.id, v7.failure?.reason);
	const c7 = await cloneMain(`${ME}/todo2`);
	check("the builder shipped a CI workflow", existsSync(join(c7, ".github/workflows/ci.yml")));
	const sha7 = ship7.b.delivery!.sha;
	const ck7 = host.state().checks[`${ME}/todo2@${sha7}`] ?? [];
	check(
		"the bundle waited for and passed CI on the commit it pushed to main (no Merge step)",
		ship7.b.history.some((h) => h.to === "AWAITING_CI") && !ship7.b.history.some((h) => h.to === "AWAITING_MERGE") && ck7.length > 0 && ck7.every((c) => c.conclusion === "success") && !ship7.b.noCi,
		JSON.stringify({ path: bundlePath(ship7.b), checks: ck7 }),
	);

	section("§8.3 ci.fixRounds 0 and a forced CI failure on the bundle's PR: escalates without a fix round");
	await setSetting("ci.fixRounds", "0", "todo2");
	const run8 = await startRun("todo2", "add a --version flag", "add a --version flag");
	await drive(run8, []);
	host.forceChecks(`${ME}/todo2`, [{ name: "test", status: "completed", conclusion: "failure", output: "1 failing: forced failure" } as any]);
	const ship8 = await ship("todo2", [run8]);
	const v8 = ship8.b;
	const int8 = userInputs(await bundleTranscript(ship8.id, "integrator"));
	check("CI failure with fixRounds 0 → the bundle is ESCALATED", v8.state === "ESCALATED" && /CI failed/.test((v8.pendingAsk?.question as any)?.reason ?? ""), JSON.stringify(v8.pendingAsk));
	check("no CI fix round was run (the integrator got no task)", v8.ciFixes === 0 && !int8.some((i) => /# Findings to address/.test(i)), JSON.stringify({ ciFixes: v8.ciFixes, inputs: int8.map((i) => i.slice(0, 60)) }));
	await api("resolveBundleEscalation", ship8.id, v8.pendingAsk!.id, { abort: true });
	await untilBundle(ship8.id, (x) => x.state === "CANCELLED", "cancel");
	await until(run8, (x) => x.state === "READY" && !x.bundle, "released to Ready");
	await api("cancelRun", run8, "dry run: done with the CI failure check");
	await until(run8, (x) => x.state === "CANCELLED", "cancel");
	await unsetSetting("ci.fixRounds", "todo2");

	// ---------------------------------------------------------------- bundles: two tickets in parallel, one PR
	section("Bundles: two todo2 tickets built in parallel, shipped as one bundle (they conflict), one PR, CI, Merge");
	const titleA = "add a --limit option to list";
	const titleB = "add a --sort option to list";
	const runA = await startRun("todo2", titleA, `${titleA}: show at most N items`);
	const runB = await startRun("todo2", titleB, `${titleB}: order by title or id`);
	say(`  runs ${runA} and ${runB}, both started at once`);
	const [vA, vB] = await Promise.all([drive(runA, []), drive(runB, [])]);
	const at = (v: RunView, s: string) => v.history.find((h) => h.to === s)?.at ?? Number.POSITIVE_INFINITY;
	check("both tickets were built in parallel (each started building before the other reached Ready)", at(vA, "BUILDING") < at(vB, "READY") && at(vB, "BUILDING") < at(vA, "READY"), JSON.stringify({ A: vA.history.map((h) => h.to), B: vB.history.map((h) => h.to) }));
	check("the first ticket stopped in Ready: branch factory/<run-id> pushed with its spec at docs/specs/<run-id>.md, no PR", await readyChecks(`${ME}/todo2`, vA), `${vA.state} ${vA.specPath}`);
	check("the second ticket stopped in Ready: branch factory/<run-id> pushed with its spec at docs/specs/<run-id>.md, no PR", await readyChecks(`${ME}/todo2`, vB), `${vB.state} ${vB.specPath}`);
	const mixErr = await apiFails("createBundle", "todo2", [runA, run1]);
	check("a bundle holds tickets of one project: shipping with a todo run is refused", !!mixErr && /project/.test(mixErr), mixErr);
	const projStream = events("todo2", "project");
	const idAB = await api<string>("createBundle", "todo2", [runA, runB]);
	say(`  ship ${runA} + ${runB} → ${idAB}`);
	const card0 = await bundleStatus(idAB);
	const [inA, inB] = await Promise.all([status(runA), status(runB)]);
	check(
		"the bundle card data (getBundle): both members in order with title, key and branch, an active state; both runs show the bundle",
		card0.project === "todo2" &&
			card0.members.map((m) => `${m.run}:${m.title}`).join() === `${runA}:${titleA},${runB}:${titleB}` &&
			card0.members.every((m) => /^[A-Za-z0-9]+-\d+$/.test(m.key) && m.branch === `factory/${m.run}`) &&
			!["MERGED", "FAILED", "CANCELLED"].includes(card0.state) &&
			inA.bundle === idAB &&
			inB.bundle === idAB,
		JSON.stringify({ state: card0.state, members: card0.members, bundles: [inA.bundle, inB.bundle] }),
	);
	const listed = await api<BundleView[]>("listBundles", { project: "todo2", states: ["INTEGRATING", "FIXING", "REVIEWING", "DELIVERING", "AWAITING_CI", "AWAITING_MERGE", "ESCALATED"] });
	check("listBundles shows it among the project's active bundles", listed.some((b) => b.id === idAB), listed.map((b) => `${b.id}:${b.state}`).join(", "));
	const again = await apiFails("createBundle", "todo2", [runA]);
	const cancelIn = await apiFails("cancelRun", runA);
	const msgIn = await apiFails("message", runB, "one more thing");
	check(
		"a run inside an active bundle cannot be shipped again, cancelled or messaged (clear errors)",
		/already in/.test(again ?? "") && (cancelIn ?? "").includes(idAB) && /message the bundle/.test(msgIn ?? ""),
		JSON.stringify({ again, cancelIn, msgIn }),
	);
	const bAB = await untilBundle(idAB, atCard, "the Merge card");
	say(`  ${idAB}: ${bundlePath(bAB)}`);
	const resolved = bAB.integration?.resolved ?? [];
	const conflicted = resolved.flatMap((r) => r.files);
	say(`  conflicts the integrator resolved: ${resolved.map((r) => `${r.run} (${r.files.join(", ")})`).join("; ") || "none"}`);
	check(
		"the tickets conflicted (both appended to README.md): INTEGRATING → REVIEWING → DELIVERING → AWAITING_CI → AWAITING_MERGE",
		bundlePath(bAB) === "INTEGRATING → REVIEWING → DELIVERING → AWAITING_CI → AWAITING_MERGE" && resolved.length === 1 && resolved[0]!.run === runB && conflicted.includes("README.md"),
		JSON.stringify({ path: bundlePath(bAB), resolved }),
	);
	check("the two Ready tickets never conflicted on their spec files", !conflicted.some((f) => f.startsWith("docs/specs/")), conflicted.join(", "));
	const trI = await bundleTranscript(idAB, "integrator");
	const conflictIn = userInputs(trI)[0] ?? "";
	check(
		"the integrator got the conflict (the ticket, the files, every member's spec) and concluded the merge with report_done",
		/^# Merge conflict/m.test(conflictIn) &&
			conflictIn.includes("README.md") &&
			conflictIn.includes(`docs/specs/${runA}.md`) &&
			conflictIn.includes(`docs/specs/${runB}.md`) &&
			trI.items.some((i: any) => i.toolCalls?.some((c: any) => c.name === "report_done")) &&
			bAB.cost.some((c) => c.role === "integrator" && c.model === "scripted/integrator"),
		conflictIn.slice(0, 600),
	);
	const trR = await bundleTranscript(idAB, "reviewer");
	const revIn = userInputs(trR)[0] ?? "";
	check(
		"a fresh reviewer reviewed the whole combined diff against both specs, and its own test run passed",
		bAB.reviews.length === 1 && revIn.startsWith(`# Review of ${idAB}`) && revIn.includes(`docs/specs/${runA}.md`) && revIn.includes(`docs/specs/${runB}.md`) && /Combined diff against the integration base/.test(revIn) && ranTestsGreen(trR),
		revIn.slice(0, 600),
	);
	check("a QA agent tested the combined result in a VM beside the bundle review", bAB.reviews[0]?.qaStatus === "ran" && bAB.conversations.qa.length === 1, JSON.stringify(bAB.reviews.map((r) => r.qaStatus)));
	const prAB = prOf(bAB);
	const prsAB = host.state().prs.filter((p) => p.repo === `${ME}/todo2`);
	check(
		'ONE PR for both tickets: "2 tickets: …", a "## Ticket" section per ticket (with its spec path), and "## Integration" with the conflicts and the review round',
		!!prAB &&
			prsAB.filter((p) => p.state === "open").length === 1 &&
			prAB.head === `factory/${idAB}` &&
			prAB.title === `2 tickets: ${titleA}, ${titleB}` &&
			prAB.body.includes(`## Ticket: ${titleA}`) &&
			prAB.body.includes(`## Ticket: ${titleB}`) &&
			prAB.body.includes(`docs/specs/${runA}.md`) &&
			prAB.body.includes(`docs/specs/${runB}.md`) &&
			/## Integration[\s\S]*The integrator resolved merge conflicts[\s\S]*1 review round/.test(prAB.body),
		JSON.stringify(prAB ? { title: prAB.title, head: prAB.head, body: prAB.body.slice(0, 1500) } : prsAB),
	);
	const ckAB = host.state().checks[`${ME}/todo2@${bAB.delivery?.sha}`] ?? [];
	check("CI ran on the bundle's PR and is green; the Merge card waits for Merge", ckAB.length > 0 && ckAB.every((c) => c.conclusion === "success") && !bAB.noCi && bAB.pendingAsk?.question.kind === "merge", JSON.stringify({ checks: ckAB, ask: bAB.pendingAsk }));
	const mAB = await merge(idAB);
	const [dA, dB] = await Promise.all([status(runA), status(runB)]);
	check(
		"Merge: the bundle MERGED; both runs DELIVERED with the same PR URL and `bundle` set",
		mAB.state === "MERGED" &&
			prOf(mAB)?.state === "merged" &&
			dA.state === "DELIVERED" &&
			dB.state === "DELIVERED" &&
			dA.artifacts.delivery?.url === mAB.delivery?.url &&
			dB.artifacts.delivery?.url === mAB.delivery?.url &&
			dA.bundle === idAB &&
			dB.bundle === idAB &&
			dA.notices.at(-1)?.text === `Merged in ${idAB}: ${mAB.delivery?.url}`,
		JSON.stringify({ bundle: mAB.state, A: [dA.state, dA.artifacts.delivery?.url, dA.bundle], B: [dB.state, dB.artifacts.delivery?.url, dB.bundle] }),
	);
	const cAB = await cloneMain(`${ME}/todo2`);
	const readmeAB = readFileSync(join(cAB, "README.md"), "utf8");
	const testAB = await pexec("npm", ["test"], { cwd: cAB }).then(() => true, () => false);
	check(
		"main has both tickets (README lists both changes, no conflict markers, both specs) and npm test passes",
		readmeAB.includes(titleA) && readmeAB.includes(titleB) && !/^(<<<<<<<|=======|>>>>>>>)/m.test(readmeAB) && existsSync(join(cAB, `docs/specs/${runA}.md`)) && existsSync(join(cAB, `docs/specs/${runB}.md`)) && testAB,
		readmeAB.slice(-400),
	);
	for (let i = 0; i < 60 && ![runA, runB].every((r) => projStream.got.some((e) => e.type === "run.state" && e.run === r && e.to === "DELIVERED")); i++) await sleep(50);
	projStream.close();
	const bStates = projStream.got.flatMap((e) => (e.type === "bundle.state" && e.bundle === idAB ? [e.to] : []));
	check(
		"the project's event stream reported the bundle's states (bundle.state) and both runs' run.state → DELIVERED",
		bStates.includes("MERGED") && [runA, runB].every((r) => projStream.got.some((e) => e.type === "run.state" && e.run === r && e.to === "DELIVERED")),
		`bundle.state: ${bStates.join(" > ")}`,
	);
	const vmsAB = await boatBackend.list();
	check("the bundle's QA VM was deleted", vmsAB.filter((x) => x.name?.includes(idAB)).length === 0, JSON.stringify(vmsAB));

	// ---------------------------------------------------------------- bundles: two tickets that merge cleanly, reviewed together
	section("Bundles: two todo2 tickets that merge cleanly, shipped as one bundle: the combination is reviewed before the PR");
	const titleC = "document the list command";
	const titleD = "document the done command";
	const runC = await startRun("todo2", titleC, `${titleC}: a page of its own under docs/`);
	const runD = await startRun("todo2", titleD, `${titleD}: a page of its own under docs/`);
	say(`  runs ${runC} and ${runD}, both started at once`);
	await Promise.all([drive(runC, []), drive(runD, [])]);
	const { id: idCD, b: bCD } = await ship("todo2", [runC, runD]);
	check(
		"the tickets merged cleanly (no conflict resolved) and the combination was still reviewed: INTEGRATING → REVIEWING → DELIVERING → AWAITING_CI → AWAITING_MERGE",
		bundlePath(bCD) === "INTEGRATING → REVIEWING → DELIVERING → AWAITING_CI → AWAITING_MERGE" && bCD.integration?.changed === false && (bCD.integration?.resolved ?? []).length === 0 && bCD.reviews.length === 1,
		JSON.stringify({ path: bundlePath(bCD), integration: bCD.integration, reviews: bCD.reviews.length }),
	);
	check(
		'the notice says the combination is being reviewed ("All 2 tickets merged cleanly; reviewing the combination …")',
		bCD.notices.some((n) => n.text === "All 2 tickets merged cleanly; reviewing the combination (each ticket was reviewed on its own branch)") && !bCD.notices.some((n) => /no review of the combination needed/.test(n.text)),
		JSON.stringify(bCD.notices.map((n) => n.text)),
	);
	const trRCD = await bundleTranscript(idCD, "reviewer");
	const revCD = userInputs(trRCD)[0] ?? "";
	check(
		"a fresh reviewer got both specs and the combined diff, was told the tickets merged without conflicts and each passed its own review, and to look at how they interact",
		bCD.conversations.reviewers.length === 1 &&
			revCD.startsWith(`# Review of ${idCD}`) &&
			revCD.includes(`docs/specs/${runC}.md`) &&
			revCD.includes(`docs/specs/${runD}.md`) &&
			/Combined diff against the integration base/.test(revCD) &&
			/The tickets merged without conflicts/.test(revCD) &&
			/each ticket already passed its own review/.test(revCD) &&
			/especially how the tickets interact/.test(revCD) &&
			!/conflict resolutions/.test(revCD) &&
			ranTestsGreen(trRCD),
		revCD.slice(0, 900),
	);
	check("a QA agent tested the clean combination in a VM beside the bundle review", bCD.reviews[0]?.qaStatus === "ran" && bCD.conversations.qa.length === 1, JSON.stringify(bCD.reviews.map((r) => r.qaStatus)));
	const prCD = prOf(bCD);
	check(
		'the PR\'s "## Integration" says the merge was clean and the combination was reviewed in 1 review round, with its QA status',
		!!prCD && /## Integration[\s\S]*merged cleanly[\s\S]*reviewed in 1 review round[\s\S]*AQ testing of the combined result/.test(prCD.body) && !/had no review of its own/.test(prCD.body),
		prCD ? prCD.body.slice(prCD.body.indexOf("## Integration"), prCD.body.indexOf("## Integration") + 700) : "no PR",
	);
	const mCD = await merge(idCD);
	check("Merge: the clean, reviewed bundle MERGED and both runs are DELIVERED", mCD.state === "MERGED" && (await Promise.all([status(runC), status(runD)])).every((x) => x.state === "DELIVERED" && x.bundle === idCD), mCD.state);

	// ---------------------------------------------------------------- stop a running tool call; interrupt the builder
	section("Stop a running tool call (stopToolCall) and interrupt the builder (interruptAgent; a message resumes it)");
	const runS = await startRun("todo", `add a --verbose flag ${SLOW_MARK}`, `add a --verbose flag; ${SLOW_MARK}: the builder runs two slow commands first`);
	say(`  run ${runS}: its builder runs \`${SLOW_COMMAND(1)}\` twice before its normal work`);
	await drive(runS, [], { until: (v) => v.state === "BUILDING" });
	const slowRun = await untilSlowCall(runS, 1);
	const sv1 = await status(runS);
	const bcid = sv1.conversations.builder!;
	check(
		"while the slow bash runs, getConversation's `running` lists it with status running and a startedAt (and `now`)",
		slowRun.slot.name === "bash" && slowRun.slot.status === "running" && typeof slowRun.slot.startedAt === "number" && typeof slowRun.tr.now === "number" && slowRun.slot.startedAt <= slowRun.tr.now + 1000,
		JSON.stringify({ running: slowRun.tr.running, now: slowRun.tr.now }),
	);
	const archId = sv1.conversations.architect!;
	const submitCall = ((await api<TranscriptView>("getConversation", runS, archId)).items as any[]).flatMap((i) => i.toolCalls ?? []).find((c: any) => c.name === "submit_spec");
	const eFinished = await apiError("stopToolCall", { run: runS, conversationId: archId, callId: submitCall?.id ?? "none" });
	const eUnknown = await apiError("stopToolCall", { run: runS, conversationId: bcid, callId: "call_not_running" });
	check(
		"stopToolCall on a finished call (the architect's submit_spec) and on a call that is not running → 409",
		!!submitCall && eFinished?.status === 409 && eUnknown?.status === 409,
		JSON.stringify({ submitCall: submitCall?.id, eFinished, eUnknown }),
	);
	const otherConv = (await status(run1)).conversations.builder!;
	const eOther = await apiError("stopToolCall", { run: runS, conversationId: otherConv, callId: slowRun.callId });
	check("stopToolCall with a Conversation of another run → 404", eOther?.status === 404, JSON.stringify(eOther));
	say(`  stop ${slowRun.callId} (bash) in the builder's Conversation ${bcid}`);
	const tStop = Date.now();
	await api("stopToolCall", { run: runS, conversationId: bcid, callId: slowRun.callId });
	const stopped = await untilToolResult(runS, bcid, slowRun.callId);
	const svStopped = await status(runS);
	check(
		'the stopped bash ends at once: its result isError, says "was aborted" and carries durationMs',
		stopped.isError && /was aborted/.test(stopped.text) && typeof stopped.durationMs === "number" && stopped.durationMs < 60_000 && Date.now() - tStop < 30_000,
		JSON.stringify(stopped),
	);
	check("after the stop the run stays BUILDING with the same builder, nothing failed", svStopped.state === "BUILDING" && !svStopped.failure && svStopped.conversations.builder === bcid, `${svStopped.state} ${svStopped.failure?.reason ?? ""}`);
	const slow2 = await untilSlowCall(runS, 2);
	check("the builder kept working: it ran its next (slow) command after the stop", slow2.slot.status === "running" && slow2.callId !== slowRun.callId, JSON.stringify(slow2.tr.running));
	const live = (await status(runS)).liveCost;
	check("getRun carries liveCost { usd, totalTokens, byRole } while the builder works", !!live && typeof live.usd === "number" && typeof live.totalTokens === "number" && Array.isArray(live.byRole), JSON.stringify(live));
	say("  interrupt the builder");
	await api("interruptAgent", runS);
	const paused = await status(runS);
	check(
		'interruptAgent: getRun shows `interrupted` (builder), the run stays BUILDING, a notice says "interrupted", nothing failed',
		paused.interrupted?.role === "builder" && String(paused.interrupted.conversationId) === String(bcid) && paused.state === "BUILDING" && !paused.failure && paused.notices.some((n) => /interrupted/.test(n.text)),
		JSON.stringify({ state: paused.state, interrupted: paused.interrupted, notices: paused.notices.slice(-3), failure: paused.failure }),
	);
	const aborted2 = await untilToolResult(runS, bcid, slow2.callId);
	check("the interrupt aborted the running bash (its result isError)", aborted2.isError, JSON.stringify(aborted2));
	const eAgain = await apiError("interruptAgent", runS);
	check("interruptAgent again while paused → 409", eAgain?.status === 409, JSON.stringify(eAgain));
	await sleep(1500);
	const stillPaused = await status(runS);
	check("the paused builder waits: still BUILDING and interrupted after a pause", stillPaused.state === "BUILDING" && stillPaused.interrupted?.role === "builder", stillPaused.state);
	say("  human says: Continue.");
	const tMsg = Date.now();
	const sent = await api<{ message: string; to: string; conversationId?: string }>("message", runS, "Continue.");
	const resumed = await status(runS);
	check(
		"a message to the paused builder resumes it: it returns quickly, goes to the same builder Conversation, and `interrupted` clears",
		sent.to === "builder" && String(sent.conversationId) === String(bcid) && !resumed.interrupted && Date.now() - tMsg < 10_000,
		JSON.stringify({ sent, interrupted: resumed.interrupted, ms: Date.now() - tMsg }),
	);
	const vS = await drive(runS, []);
	const trS = await api<TranscriptView>("getConversation", runS, bcid);
	const results = (trS.items as any[]).flatMap((i) => (i.toolResult ? [i.toolResult] : []));
	check(
		"the resumed builder called report_done: the run went BUILDING → REVIEWING → READY with the same builder Conversation",
		vS.state === "READY" && vS.history.some((h) => h.from === "BUILDING" && h.to === "REVIEWING") && vS.conversations.builder === bcid && results.some((r) => r.name === "report_done" && !r.isError) && (trS.items as any[]).some((i) => i.author === "human" && /Continue\./.test(i.text ?? "")),
		JSON.stringify({ state: vS.state, path: vS.history.map((h) => h.to), failure: vS.failure }),
	);
	check(
		"every finished tool row in the builder's transcript carries durationMs",
		results.length >= 4 && results.every((r) => typeof r.durationMs === "number" && r.durationMs >= 0) && trS.running.length === 0,
		JSON.stringify(results.map((r) => [r.name, r.durationMs])),
	);

	// ---------------------------------------------------------------- the web UI and its API
	section("Web UI and its API");
	const urlFile = daemonFiles(CONFIG).url;
	const written = existsSync(urlFile) ? readFileSync(urlFile, "utf8").trim() : "";
	check("the link factory serve printed is the one in web-url (mode 0600)", written === link && (statSync(urlFile).mode & 0o777) === 0o600, written ? `${written} vs ${link}` : "no web-url file");
	check("factory web prints the link", (await factory("web", "--config", CONFIG)) === link);
	const noToken = await fetch(new URL("/api/op/listRuns", link), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ args: [] }) });
	check("the API refuses requests without the token", noToken.status === 401);
	const runs = await api<RunView[]>("listRuns");
	const started = [run1, run2, run3, run4, run5, run6, run7, run8, runA, runB, runC, runD, runS];
	check("with the token it lists every run of the trial", runs.map((r) => r.id).sort().join() === [...started].sort().join(), runs.map((r) => r.id).join());
	const bundles = await api<BundleView[]>("listBundles");
	const shipped = [ship1.id, ship2.id, ship3.id, ship4.id, ship5.id, ship6.id, ship7.id, ship8.id, idAB, idCD];
	check("listBundles lists every bundle of the trial", bundles.map((b) => b.id).sort().join() === [...shipped].sort().join(), bundles.map((b) => `${b.id}:${b.state}`).join(", "));
	const page = await fetch(new URL(`/?token=${token()}`, link), { redirect: "manual" });
	check("the link sets an HttpOnly, SameSite=Strict session cookie", page.status === 303 && /HttpOnly; SameSite=Strict/.test(page.headers.get("set-cookie") ?? ""));
	const msgErr = await apiFails("message", run1, "thanks!");
	check("messages to a finished run are refused with a pointer to a new run (`message` op)", !!msgErr && /start a new run/.test(msgErr), msgErr);

	// ---------------------------------------------------------------- pass criteria summary
	section("§8.5 pass criteria");
	check("all runs recorded with cost and round counts", runs.every((r) => Array.isArray(r.cost) && typeof r.reviewRound === "number"));
	check("all bundles recorded with cost and round counts", bundles.every((b) => Array.isArray(b.cost) && typeof b.reviewRound === "number") && bundles.filter((b) => b.reviews.length).every((b) => b.cost.some((c) => c.role === "reviewer")));
	const refs = (await Promise.all([`${ME}/todo`, `${ME}/todo2`].map((r) => pexec("git", ["--git-dir", join(GH, "remotes", `${r}.git`), "for-each-ref", "--format=%(refname)"]).then((x) => x.stdout)))).join("");
	// Commit identity (docs/specs/run-mv6dwfsi-7xli.md): every factory-made commit on the remotes' branches (main and
	// factory/<id>) is authored and committed by the fake GitHub's account; the only others are GitHub-side commits
	// (the seed, fake PR merges/squashes) by `GitHub <noreply@github.com>`.
	const FACTORY_DEV = "factory-dev <1+factory-dev@users.noreply.github.com>";
	const GITHUB_SIDE = "GitHub <noreply@github.com>";
	const who = new Map<string, number>();
	let factoryMade = 0;
	for (const r of [`${ME}/todo`, `${ME}/todo2`]) {
		const out = (await pexec("git", ["--git-dir", join(GH, "remotes", `${r}.git`), "log", "--branches", "--format=%an <%ae>|%cn <%ce>"], { maxBuffer: 64 << 20 })).stdout;
		for (const line of out.split("\n").filter(Boolean)) {
			const [a, c] = line.split("|");
			if (a === GITHUB_SIDE && c === GITHUB_SIDE) continue;
			if (a === FACTORY_DEV && c === FACTORY_DEV) factoryMade++;
			else who.set(line, (who.get(line) ?? 0) + 1);
		}
	}
	check(
		`every factory-made commit on the remotes' branches is authored and committed by the GitHub identity's account (${FACTORY_DEV}); the rest are GitHub-side (${GITHUB_SIDE})`,
		factoryMade > 0 && who.size === 0,
		JSON.stringify({ factoryMade, others: Object.fromEntries(who) }),
	);
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
			"Bundles: runs stop at Ready after review (branch `factory/<run-id>` pushed, no PR); every step ships its Ready run(s) as a bundle (`createBundle`) and merges it (`mergeBundle`) where the run used to deliver by itself. The PR description and delivery notes are written by the bundle (`## Ticket: <title>` sections and `## Integration`).",
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
