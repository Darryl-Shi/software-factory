import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { Boat } from "../src/boat/boat.ts";
import { LocalBoatBackend } from "../src/boat/backend.ts";
import { Factory } from "../src/core/core.ts";
import type { BundleView, DiscussionView, RunView } from "../src/core/types.ts";
import { GitHub } from "../src/github/github.ts";
import { LocalGitHubHost } from "../src/github/host.ts";
import { Sandbox } from "../src/sandbox/sandbox.ts";
import { call, calls, fail, humanText, type Script, say, scriptedProvider } from "../src/testing/scripted.ts";

export type ReviewPlan = "pass" | "fail" | "invalid-then-pass" | "pass-advisory";

/** Mutable per-test control of the scripted agents. */
export interface Control {
	reviews: ReviewPlan[];
	builderNoProgress: boolean;
	/** The builder makes no change from its N-th input on (deterministic "no progress" fix rounds). */
	noProgressFromInput?: number;
	/** The builder delegates to a helper (subagent) before its first write. */
	builderSubagent?: boolean;
	builderHang: boolean;
	/** Hang the builder at turn 0 of its N-th input (crash tests). */
	hangAtInput?: number;
	askFirst: boolean;
	/** Per report_done attempt that answers findings: omit | wontfix-noreason | wontfix | ok (default ok). */
	responsePlan: string[];
	architectDouble: boolean;
	architectNoAB: boolean;
	reviewerInputs: string[];
	builderInputs: string[];
	architectInputs: string[];
	reviewerModels: string[];
	/** Human messages the agents answered in side turns ("role:text"). */
	messagesSeen: string[];
	/** The architect calls web_search before writing the spec; the tool results land here. */
	searchFirst?: boolean;
	searchResults: string[];
	/** The builder also ships scripts/run.sh (a launchable product, so AQ testing applies). */
	runScript?: boolean;
	/** With runScript: the builder also ships scripts/setup.sh (it runs in the QA VM before the run script). */
	setupScript?: boolean;
	/** Per QA agent: pass | fail | no-screenshot-then-pass (default pass). */
	qa: string[];
	qaInputs: string[];
	/** Hang the QA agent after its screenshot (crash tests). */
	qaHang?: boolean;
	/** Hang the helper after its first write (crash tests). */
	helperHang?: boolean;
	helperRuns: number;
	/** The discussant's factory inputs (the first input, drafting instructions). */
	discussantInputs: string[];
	/** The human texts the discussant heard (`say`). */
	discussantHeard: string[];
	/** The human messages the discussant got, as sent (header and any factory note included). */
	discussantMessages: string[];
	/** The model id of each discussant turn. */
	discussantModels: string[];
	/** Hang the discussant's reply to a human message, and its first step on drafting instructions (Stop, refusals during a turn). */
	discussantHang?: boolean;
	/** The discussant's replies to human messages fail with this provider error. */
	discussantFail?: string;
	/**
	 * Per draft turn, what the discussant does: ok | invalid-then-ok | none | one | ok-then-hang (default ok).
	 * ok-then-hang submits along with a bash call (so the loop goes on), then sets `discussantHang` and hangs on the
	 * next step (crash tests).
	 */
	draftPlan: string[];
	/** Each builder also writes shared.txt with content of its own (two runs then conflict when bundled). */
	sharedFile?: boolean;
	/** The integrator's factory inputs. */
	integratorInputs: string[];
	/** Per integrator conflict task: resolve | abort | leave (default resolve). */
	integratorPlan: string[];
	/** Hang the integrator on its next conflict task (crash tests). */
	integratorHang?: boolean;
	/** Hang the reviewer after its first step (crash tests); `reviewerHanging` is set while it hangs. */
	reviewerHang?: boolean;
	reviewerHanging?: boolean;
	/**
	 * The builder commits its own work in the sandbox (`git add -A && git commit` through bash) before report_done, then
	 * writes leftover.txt ("... (round N)") and leaves it uncommitted (so the factory's "commit uncommitted builder changes" has work).
	 */
	builderCommits?: boolean;
	/** With builderCommits: the bash outputs of the builder's commit commands. */
	builderCommitOutputs?: string[];
	/**
	 * A slow tool (stop / interrupt tests): on its first input the builder first runs this bash command (e.g.
	 * `sleep 30; echo SLOW-DONE`), then writes its file and reports. The slow call's result text lands in `slowResults`.
	 */
	builderSlow?: string;
	slowResults?: string[];
	/**
	 * With builderSlow: the builder's first step is one round of write + the slow bash + report_done (report_done waits,
	 * pending, behind the slow call: stopToolCall refuses bridge tools).
	 */
	builderSlowBatch?: boolean;
	/** With builderSlow: how many times the builder runs the slow command (one after the other) before it writes (default 1). */
	builderSlowTimes?: number;
	/** The reviewer's next first step runs this bash command instead of its usual check (consumed once; interrupt tests). */
	reviewerSlow?: string;
	/** Hang the discussant's reply to a human message after its first step (a model response landed: live cost tests). */
	discussantHangLater?: boolean;
}

export function newControl(): Control {
	return {
		reviews: [],
		builderNoProgress: false,
		builderHang: false,
		askFirst: false,
		responsePlan: [],
		architectDouble: false,
		architectNoAB: false,
		reviewerInputs: [],
		builderInputs: [],
		architectInputs: [],
		reviewerModels: [],
		messagesSeen: [],
		searchResults: [],
		qa: [],
		qaInputs: [],
		helperRuns: 0,
		discussantInputs: [],
		discussantHeard: [],
		discussantMessages: [],
		discussantModels: [],
		draftPlan: [],
		integratorInputs: [],
		integratorPlan: [],
	};
}

let sharedSeq = 0;

const SPEC = (v: number) => `# Spec v${v}\n\nA tiny product.\n\n## Acceptance behaviours\n\n- running it prints hello\n`;

export function scripts(control: Control): Record<string, Script> {
	const reviewer = (model: string): Script => async (ctx) => {
		if (ctx.turn === 0) {
			control.reviewerInputs.push(ctx.input);
			control.reviewerModels.push(model);
			if (control.reviewerSlow) {
				const command = control.reviewerSlow;
				delete control.reviewerSlow;
				return call("bash", { command });
			}
			return call("bash", { command: "ls -1 && echo TESTS-OK" });
		}
		if (control.reviewerHang) {
			control.reviewerHanging = true;
			while (control.reviewerHang) await new Promise((r) => setTimeout(r, 50));
			control.reviewerHanging = false;
		}
		const plan = control.reviews.shift() ?? "pass";
		const evidence = `$ ls -1 && echo TESTS-OK\n${ctx.results.find((r) => r.name === "bash")?.text ?? ""}`;
		if (plan === "invalid-then-pass" && !ctx.results.some((r) => r.name === "submit_review")) {
			control.reviews.unshift("pass");
			// missing evidence + fail without blocking finding → rejected by the bridge
			return call("submit_review", { verdict: "fail", findings: [{ severity: "minor", blocking: false, specRef: "AB1", description: "nit" }] });
		}
		if (plan === "fail")
			return call("submit_review", {
				verdict: "fail",
				findings: [
					{ severity: "major", blocking: true, specRef: "Acceptance behaviours #1", description: "it does not print hello", evidence },
					{ severity: "minor", blocking: false, specRef: "Acceptance behaviours #1", description: "could be friendlier", evidence },
				],
			});
		if (plan === "pass-advisory")
			return call("submit_review", { verdict: "pass", findings: [{ severity: "minor", blocking: false, specRef: "AB1", description: "consider colours", evidence }] });
		return call("submit_review", { verdict: "pass", findings: [] });
	};
	// Human messages that started a side turn: "REVISE: x" makes the architect resubmit the spec with x;
	// "EDIT: x" makes the builder change a file. Anything else gets a one-line reply.
	const architect: Script = (ctx) => {
		if (control.searchFirst && ctx.inputs.length === 1) {
			if (ctx.turn === 0) return call("web_search", { objective: "How do CLIs print hello?", queries: ["print hello cli", "hello world node"] });
			if (ctx.results.at(-1)?.name === "web_search") {
				control.searchResults.push(ctx.results.at(-1)!.text);
				return call("submit_spec", { markdown: SPEC(1) });
			}
		}
		if (ctx.turn > 0 && ctx.results.at(-1)?.name === "submit_spec" && ctx.results.at(-1)?.isError && !control.architectDouble)
			return call("submit_spec", { markdown: SPEC(ctx.inputs.length) });
		if (ctx.turn > 0) return say("waiting");
		if (control.architectNoAB) return call("submit_spec", { markdown: "# Spec\n\nNo scenarios here, just prose about the product." });
		control.architectInputs.push(ctx.input);
		const nUser = ctx.inputs.length;
		if (control.askFirst && nUser === 1) return call("ask_human", { question: "Which language?" });
		if (control.architectDouble) return calls(["submit_spec", { markdown: SPEC(1) }], ["submit_spec", { markdown: SPEC(99) }]);
		return call("submit_spec", { markdown: SPEC(nUser) });
	};
	architect.onMessage = (ctx) => {
		const text = humanText(ctx.side!.message);
		control.messagesSeen.push(`architect:${text}`);
		if (ctx.side!.turn === 0 && text.startsWith("REVISE:")) return call("submit_spec", { markdown: `${SPEC(ctx.inputs.length)}- ${text.slice(7).trim()}\n` });
		return say(ctx.side!.turn === 0 ? `re: ${text}` : "revised");
	};
	const builder: Script = async (ctx) => {
		if (ctx.turn === 0) {
			control.builderInputs.push(ctx.input);
			if (control.hangAtInput === ctx.inputs.length) control.builderHang = true;
			while (control.builderHang) await new Promise((r) => setTimeout(r, 50));
			if (control.builderSubagent && ctx.inputs.length === 1) return call("subagent", { task: "count the files" });
		}
		if (control.builderSubagent && ctx.turn === 1 && ctx.inputs.length === 1) return call("write", { path: "round-1.txt", content: "round 1\n" });
		if (control.builderSlow && control.builderSlowBatch && ctx.inputs.length === 1 && ctx.turn === 0)
			return calls(["write", { path: "round-1.txt", content: "round 1\n" }], ["bash", { command: control.builderSlow }], ["report_done", { summary: "round 1", responses: [] }]);
		if (control.builderSlow && ctx.inputs.length === 1) {
			const slows = ctx.results.filter((r) => r.name === "bash");
			if (slows.length < (control.builderSlowTimes ?? 1)) return call("bash", { command: control.builderSlow });
			if (!ctx.results.some((r) => r.name === "write")) {
				(control.slowResults ??= []).push(...slows.map((r) => r.text));
				return call("write", { path: "round-1.txt", content: "round 1\n" });
			}
		}
		if (ctx.turn === 0) {
			const noProgress = control.builderNoProgress || (control.noProgressFromInput !== undefined && ctx.inputs.length >= control.noProgressFromInput);
			if (!noProgress && control.runScript && ctx.inputs.length === 1)
				return calls(
					["write", { path: `round-${ctx.inputs.length}.txt`, content: `round ${ctx.inputs.length}\n` }],
					["write", { path: "scripts/run.sh", content: "echo product up\nsleep 60\n" }],
					...(control.setupScript ? [["write", { path: "scripts/setup.sh", content: "echo setup done\n" }] as [string, Record<string, unknown>]] : []),
					...(control.sharedFile ? [["write", { path: "shared.txt", content: `builder ${++sharedSeq}\n` }] as [string, Record<string, unknown>]] : []),
				);
			if (!noProgress && control.sharedFile && ctx.inputs.length === 1)
				return calls(["write", { path: `round-${ctx.inputs.length}.txt`, content: `round ${ctx.inputs.length}\n` }], ["write", { path: "shared.txt", content: `builder ${++sharedSeq}\n` }]);
			if (!noProgress) return call("write", { path: `round-${ctx.inputs.length}.txt`, content: `round ${ctx.inputs.length}\n` });
		}
		if (control.builderCommits && ctx.turn > 0) {
			const committed = ctx.results.find((r) => r.name === "bash");
			if (!committed)
				return call("bash", {
					command: `git add -A && (git commit -q -m 'builder: round ${ctx.inputs.length}' || true) && git log -1 --format='%an <%ae>|%cn <%ce>' && echo BUILDER-COMMIT-DONE`,
				});
			if (!ctx.results.some((r) => r.name === "write" && ctx.results.indexOf(r) > ctx.results.indexOf(committed))) {
				(control.builderCommitOutputs ??= []).push(committed.text);
				return call("write", { path: "leftover.txt", content: `left for the factory to commit (round ${ctx.inputs.length})\n` });
			}
		}
		const ids = [...ctx.inputs.at(-1)!.matchAll(/\[(F\d+)\] \([a-z]+, BLOCKING/g)].map((m) => m[1]!);
		const plan = ids.length ? (control.responsePlan.shift() ?? "ok") : "ok";
		const responses =
			plan === "omit"
				? []
				: ids.map((findingId) =>
						plan === "wontfix-noreason" ? { findingId, status: "wontfix" } : plan === "wontfix" ? { findingId, status: "wontfix", reason: "out of scope for the spec" } : { findingId, status: "fixed" },
					);
		return call("report_done", { summary: `round ${ctx.inputs.length}`, responses });
	};
	builder.onMessage = (ctx) => {
		const text = humanText(ctx.side!.message);
		control.messagesSeen.push(`builder:${text}`);
		if (ctx.side!.turn === 0 && text.startsWith("EDIT:")) return call("write", { path: "CHANGELOG.md", content: `${text.slice(5).trim()}\n` });
		return say(ctx.side!.turn === 0 ? `re: ${text}` : "changed CHANGELOG.md");
	};
	// Factory inputs: the first input ("# Discussion") makes it look at the repo, then reply. Drafting instructions
	// ("# Draft tickets", and the reminders after them) follow the turn's `control.draftPlan` entry.
	const TICKETS = { summary: "S: settled X; open Y", tickets: [{ title: "API", body: "B1" }, { title: "UI", body: "B2" }] };
	let draftMode = "ok";
	const discussant: Script = async (ctx) => {
		if (ctx.turn === 0) {
			control.discussantInputs.push(ctx.input);
			control.discussantModels.push(ctx.model);
		}
		if (ctx.input.startsWith("# Discussion")) return ctx.turn === 0 ? call("bash", { command: "ls -1a" }) : say("first reply");
		const reminder = ctx.input.startsWith("You stopped without calling submit_tickets");
		if (ctx.input.startsWith("# Draft tickets") || reminder) {
			if (ctx.input.startsWith("# Draft tickets") && ctx.turn === 0) {
				while (control.discussantHang) await new Promise((r) => setTimeout(r, 50));
				draftMode = control.draftPlan.shift() ?? "ok";
			}
			const tried = ctx.results.some((r) => r.name === "submit_tickets");
			// the step after a recorded submission that did not end the loop (ok-then-hang, or its resumption after a crash)
			if (ctx.results.some((r) => r.name === "submit_tickets" && !r.isError)) {
				if (draftMode === "ok-then-hang") {
					control.discussantHang = true;
					while (control.discussantHang) await new Promise((r) => setTimeout(r, 50));
				}
				return say("submitted");
			}
			if (draftMode === "ok-then-hang") return calls(["submit_tickets", TICKETS], ["bash", { command: "true" }]);
			if (draftMode === "none") return say("thinking");
			if (draftMode === "one") return call("submit_tickets", { summary: TICKETS.summary, tickets: [{ title: "Only", body: "B" }] });
			if (draftMode === "invalid-then-ok" && !tried) return call("submit_tickets", { ...TICKETS, summary: "" });
			return call("submit_tickets", TICKETS);
		}
		return say("ok");
	};
	// Human turns (say): "WRITE: x" makes it try to write a file; anything else gets "re: <text>".
	discussant.onMessage = async (ctx) => {
		const text = humanText(ctx.side!.message);
		if (ctx.side!.turn === 0) {
			control.discussantHeard.push(text);
			control.discussantMessages.push(ctx.side!.message);
			control.discussantModels.push(ctx.model);
		}
		while (control.discussantHang) await new Promise((r) => setTimeout(r, 50));
		if (ctx.side!.turn > 0) while (control.discussantHangLater) await new Promise((r) => setTimeout(r, 50));
		if (control.discussantFail) return fail(control.discussantFail);
		if (ctx.side!.turn === 0 && text.startsWith("WRITE:")) return call("write", { path: "x.txt", content: "x" });
		// "READ: path" reads a file of the checkout and replies with what it got
		if (text.startsWith("READ:")) {
			if (ctx.side!.turn === 0) return call("read", { path: text.slice(5).trim() });
			const r = ctx.side!.results.find((x) => x.name === "read");
			return say(`read ${r && !r.isError ? "ok" : "error"}: ${r?.text ?? ""}`);
		}
		return say(`re: ${text}`);
	};
	// The integrator: on a conflict it resolves shared.txt and concludes the merge (or aborts it, or leaves it, per
	// `integratorPlan`); on findings it changes integrated.txt and answers every blocking finding "fixed".
	let integratorMode = "resolve";
	const integrator: Script = async (ctx) => {
		if (ctx.turn === 0) {
			control.integratorInputs.push(ctx.input);
			while (control.integratorHang) await new Promise((r) => setTimeout(r, 50));
		}
		if (ctx.input.includes("# Merge conflict")) {
			if (ctx.turn === 0) {
				integratorMode = control.integratorPlan.shift() ?? "resolve";
				if (integratorMode === "abort") return call("bash", { command: "git merge --abort" });
				if (integratorMode === "leave") return call("bash", { command: "true" });
				return call("bash", { command: "printf 'resolved by the integrator\\n' > shared.txt && git add -A && git commit -q --no-edit && echo RESOLVED" });
			}
			return call("report_done", { summary: `conflict ${integratorMode}`, responses: [] });
		}
		if (ctx.turn === 0) return call("write", { path: "integrated.txt", content: `fix ${ctx.inputs.length}\n` });
		const ids = [...ctx.input.matchAll(/\[(F\d+)\] \([a-z]+, BLOCKING/g)].map((m) => m[1]!);
		return call("report_done", { summary: `fixed ${ids.length}`, responses: ids.map((findingId) => ({ findingId, status: "fixed" })) });
	};
	integrator.onMessage = (ctx) => {
		const text = humanText(ctx.side!.message);
		control.messagesSeen.push(`integrator:${text}`);
		if (ctx.side!.turn === 0 && text.startsWith("EDIT:")) return call("write", { path: "INTEGRATOR.md", content: `${text.slice(5).trim()}\n` });
		return say(ctx.side!.turn === 0 ? `re: ${text}` : "changed INTEGRATOR.md");
	};
	return {
		architect,
		builder,
		integrator,
		"builder-textonly": builder,
		helper: async (ctx) => {
			if (!control.builderSubagent) return say("helper");
			if (ctx.turn === 0) {
				control.helperRuns += 1;
				return calls(["bash", { command: "ls | wc -l" }], ["write", { path: "helper.txt", content: "x" }]);
			}
			while (control.helperHang) await new Promise((r) => setTimeout(r, 50));
			return say(`helper saw: ${ctx.results.map((r) => `${r.name}:${r.isError ? "error" : "ok"}`).join(", ")}`);
		},
		qa: async (ctx) => {
			if (ctx.turn === 0) {
				control.qaInputs.push(ctx.input);
				return call("computer", { action: "get_window_state", args: { pid: 1, window_id: 1 } });
			}
			while (control.qaHang) await new Promise((r) => setTimeout(r, 50));
			// the latest screenshot id in the whole transcript (a "[factory]" note after a crash counts as a new input)
			const all = ctx.messages.filter((m: any) => m.role === "toolResult" && m.toolName === "computer").map((m: any) => (m.content ?? []).map((p: any) => p.text ?? "").join(""));
			const shot = [...all.join("\n").matchAll(/Screenshot (r\d+-s\d+)/g)].at(-1)?.[1] ?? "none";
			if (ctx.results.filter((r) => r.name === "submit_qa" && r.isError).length >= 3) return say("giving up");
			const plan = control.qa[0] ?? "pass";
			if (plan === "no-screenshot-then-pass" && !ctx.results.some((r) => r.name === "submit_qa")) {
				return call("submit_qa", { verdict: "fail", findings: [{ severity: "major", blocking: true, description: "the page is blank", evidence: "opened it" }] });
			}
			control.qa.shift();
			if (plan === "fail")
				return call("submit_qa", {
					verdict: "fail",
					findings: [{ severity: "major", blocking: true, specRef: "Acceptance behaviours #1", description: "the hello screen is blank", evidence: "opened the app; the window is empty", screenshots: [shot] }],
				});
			return call("submit_qa", { verdict: "pass", findings: [{ severity: "minor", blocking: false, description: "the font is small", evidence: "looked at the window", screenshots: [shot] }] });
		},
		reviewer: reviewer("reviewer"),
		"reviewer-strict": reviewer("reviewer-strict"),
		discussant,
		"discussant-b": discussant,
	};
}

export interface TestEnv {
	dir: string;
	host: LocalGitHubHost;
	boat: LocalBoatBackend;
	factory: Factory;
	control: Control;
	configPath: string;
	reopen(): Promise<Factory>;
}

export async function makeFactory(opts: { config?: string; storage?: "memory" | "sqlite"; control?: Control; dir?: string; log?: (msg: string) => void } = {}): Promise<TestEnv> {
	const dir = opts.dir ?? mkdtempSync(join(tmpdir(), "sf-test-"));
	mkdirSync(dir, { recursive: true });
	const host = new LocalGitHubHost(join(dir, "github"));
	const control = opts.control ?? newControl();
	const configPath = join(dir, "config.yaml");
	writeFileSync(
		configPath,
		opts.config ??
			`version: 1
workdir: ${dir}/work
roles:
  architect: { model: scripted/architect }
  builder: { model: scripted/builder }
  helper: { model: scripted/helper }
  reviewer: { model: scripted/reviewer }
  qa: { model: scripted/qa }
  integrator: { model: scripted/integrator }
discussion: { model: { model: scripted/discussant } }
qa: { enabled: false }
boat: { apiKey: env:SF_TEST_BOAT_KEY }
sandbox: { enabled: false }
ci: { noChecksTimeout: 300ms }
policy:
  approvals: []
`,
	);
	process.env.SF_TEST_BOAT_KEY ??= "test-boat-key";
	const boatBackend = new LocalBoatBackend(join(dir, "boat"));
	const build = async () => {
		const sp = scriptedProvider(scripts(control));
		const models = createModels();
		models.setProvider(sp.provider);
		const f = new Factory({
			configPath,
			models,
			github: new GitHub(host),
			sandbox: new Sandbox({ stateDir: join(dir, "state", "environments") }),
			boat: new Boat({ stateDir: join(dir, "state", "qa-vms"), backend: () => boatBackend, retryDelayMs: 10, bootWaitMs: 300 }),
			artifactsDir: join(dir, "state", "artifacts"),
			storage: opts.storage === "sqlite" ? { sqlite: join(dir, "factory.sqlite") } : "memory",
			ciPollMs: 50,
			log: (m) => {
				opts.log?.(m);
				if (process.env.SF_DEBUG) console.error(m);
			},
		});
		await f.start();
		return f;
	};
	const env: TestEnv = {
		dir,
		host,
		boat: boatBackend,
		control,
		configPath,
		factory: await build(),
		async reopen() {
			env.factory = await build();
			return env.factory;
		},
	};
	return env;
}

export const until = (f: Factory, run: string, pred: (v: RunView) => boolean, ms = 30_000) => f.waitForState(run, pred, ms);
export const untilBundle = (f: Factory, id: string, pred: (v: BundleView) => boolean, ms = 30_000) => f.waitForBundle(id, pred, ms);
export const bundleIn = (...s: string[]) => (v: BundleView) => s.includes(v.state);

/**
 * Ship a run on its own (a bundle of one) once it is READY and merge it: what "delivered" means since bundles. Returns
 * the run once it is DELIVERED (or the bundle's end state if it never merges).
 */
export async function shipAndMerge(f: Factory, run: string, ms = 30_000): Promise<RunView> {
	const r = await f.waitForState(run, (v) => ["READY", "FAILED", "CANCELLED", "DELIVERED"].includes(v.state), ms);
	if (r.state !== "READY") return r;
	const id = await f.createBundle(r.project, [run]);
	const b = await f.waitForBundle(id, (v) => v.state === "MERGED" || v.state === "FAILED" || v.state === "CANCELLED" || v.state === "ESCALATED" || (v.state === "AWAITING_MERGE" && !!v.pendingAsk), ms);
	if (b.state === "AWAITING_MERGE") await f.mergeBundle(id);
	if (b.state === "AWAITING_MERGE" || b.state === "MERGED") return f.waitForState(run, (v) => v.state === "DELIVERED", ms);
	return f.getRun(run);
}
export const inState = (...s: string[]) => (v: RunView) => s.includes(v.state);
export const untilDiscussion = (f: Factory, id: string, pred: (v: DiscussionView) => boolean, ms = 30_000) => f.waitForDiscussion(id, pred, ms);
