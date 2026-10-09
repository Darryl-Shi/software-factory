import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { Factory } from "../src/core/core.ts";
import type { RunView } from "../src/core/types.ts";
import { DEFAULT_WORKER_EXTENSIONS, DEFAULT_WORKER_SETTINGS } from "../src/agents/tools.ts";
import { githubDelivery } from "../src/github/delivery.ts";
import { LocalGitHubHost } from "../src/github/host.ts";
import { githubRepo } from "../src/github/repo.ts";
import { localWorktree } from "../src/sandbox/sandbox.ts";
import { call, calls, humanText, type Script, say, scriptedProvider } from "../src/testing/scripted.ts";

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
}

export function newControl(): Control {
	return { reviews: [], builderNoProgress: false, builderHang: false, askFirst: false, responsePlan: [], architectDouble: false, architectNoAB: false, reviewerInputs: [], builderInputs: [], architectInputs: [], reviewerModels: [], messagesSeen: [], searchResults: [] };
}

const SPEC = (v: number) => `# Spec v${v}\n\nA tiny product.\n\n## Acceptance behaviours\n\n- running it prints hello\n`;

export function scripts(control: Control): Record<string, Script> {
	const reviewer = (model: string): Script => (ctx) => {
		if (ctx.turn === 0) {
			control.reviewerInputs.push(ctx.input);
			control.reviewerModels.push(model);
			return call("bash", { command: "ls -1 && echo TESTS-OK" });
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
		if (ctx.turn === 0) {
			const noProgress = control.builderNoProgress || (control.noProgressFromInput !== undefined && ctx.inputs.length >= control.noProgressFromInput);
			if (!noProgress) return call("write", { path: `round-${ctx.inputs.length}.txt`, content: `round ${ctx.inputs.length}\n` });
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
	return {
		architect,
		builder,
		helper: (ctx) => {
			if (!control.builderSubagent) return say("helper");
			if (ctx.turn === 0) return calls(["bash", { command: "ls | wc -l" }], ["write", { path: "helper.txt", content: "x" }]);
			return say(`helper saw: ${ctx.results.map((r) => `${r.name}:${r.isError ? "error" : "ok"}`).join(", ")}`);
		},
		reviewer: reviewer("reviewer"),
		"reviewer-strict": reviewer("reviewer-strict"),
	};
}

export interface TestEnv {
	dir: string;
	host: LocalGitHubHost;
	factory: Factory;
	control: Control;
	configPath: string;
	reopen(): Promise<Factory>;
}

export async function makeFactory(opts: { config?: string; storage?: "memory" | "sqlite"; control?: Control; dir?: string } = {}): Promise<TestEnv> {
	const dir = opts.dir ?? mkdtempSync(join(tmpdir(), "sf-test-"));
	mkdirSync(dir, { recursive: true });
	const host = new LocalGitHubHost(join(dir, "github"));
	const control = opts.control ?? newControl();
	const configPath = join(dir, "config.yaml");
	writeFileSync(
		configPath,
		opts.config ??
			`version: 1
roles:
  architect: { model: scripted/architect }
  builder: { model: scripted/builder }
  helper: { model: scripted/helper }
  reviewer: { model: scripted/reviewer }
stages:
  repo: { workdir: ${dir}/work }
  environment: { root: ${dir}/work, sandbox: { enabled: false } }
  delivery: { ci: { noChecksTimeout: 300ms } }
policy:
  approvals: []
`,
	);
	const build = async () => {
		const sp = scriptedProvider(scripts(control));
		const models = createModels();
		models.setProvider(sp.provider);
		const f = new Factory({
			configPath,
			models,
			extensions: [githubRepo(host), githubDelivery(host), localWorktree({ stateDir: join(dir, "state", "environments") })],
			workerExtensions: DEFAULT_WORKER_EXTENSIONS,
			workerSettings: DEFAULT_WORKER_SETTINGS,
			storage: opts.storage === "sqlite" ? { sqlite: join(dir, "factory.sqlite") } : "memory",
			ciPollMs: 50,
			log: (m) => process.env.SF_DEBUG && console.error(m),
		});
		await f.start();
		return f;
	};
	const env: TestEnv = {
		dir,
		host,
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
export const inState = (...s: string[]) => (v: RunView) => s.includes(v.state);
