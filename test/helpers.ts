import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { Factory } from "../src/core/core.ts";
import type { RunView } from "../src/core/types.ts";
import { githubDelivery } from "../src/extensions/github/delivery.ts";
import { LocalGitHubHost } from "../src/extensions/github/host.ts";
import { githubRepo } from "../src/extensions/github/repo.ts";
import { localWorktree } from "../src/extensions/local-worktree/index.ts";
import { DEFAULT_WORKER_EXTENSIONS } from "../src/extensions/workers/index.ts";
import { call, type Script, say, scriptedProvider } from "../src/testing/scripted.ts";

export type ReviewPlan = "pass" | "fail" | "invalid-then-pass" | "pass-advisory";

/** Mutable per-test control of the scripted agents. */
export interface Control {
	reviews: ReviewPlan[];
	builderNoProgress: boolean;
	builderHang: boolean;
	askFirst: boolean;
	reviewerInputs: string[];
	builderInputs: string[];
	architectInputs: string[];
	reviewerModels: string[];
}

export function newControl(): Control {
	return { reviews: [], builderNoProgress: false, builderHang: false, askFirst: false, reviewerInputs: [], builderInputs: [], architectInputs: [], reviewerModels: [] };
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
	return {
		architect: (ctx) => {
			if (ctx.turn > 0) return say("waiting");
			control.architectInputs.push(ctx.input);
			const nUser = ctx.inputs.length;
			if (control.askFirst && nUser === 1) return call("ask_human", { question: "Which language?" });
			return call("submit_spec", { markdown: SPEC(nUser) });
		},
		builder: async (ctx) => {
			if (ctx.turn === 0) {
				control.builderInputs.push(ctx.input);
				if (control.builderHang) await new Promise((r) => setTimeout(r, 60_000));
				if (!control.builderNoProgress) return call("write", { path: `round-${ctx.inputs.length}.txt`, content: `round ${ctx.inputs.length}\n` });
			}
			const ids = [...ctx.inputs.at(-1)!.matchAll(/\[(F\d+)\] \([a-z]+, BLOCKING/g)].map((m) => m[1]!);
			return call("report_done", { summary: `round ${ctx.inputs.length}`, responses: ids.map((findingId) => ({ findingId, status: "fixed" })) });
		},
		helper: () => say("helper"),
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
