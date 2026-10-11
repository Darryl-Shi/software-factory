// Setup section "search" (spec §3.4): a Parallel key for the web_search tool (stored as `store:parallel`),
// env:PARALLEL_API_KEY, or skip. `parallelSearch` resolves `store:` refs only through the process default secret store,
// so during the test search a pasted key is served from memory by a CandidateStore swapped in as the default; nothing
// reaches secrets.json or config.yaml until the user commits (success, "Save anyway", or a declined test search).
import { resolveSecret, setDefaultSecretStore } from "../../core/settings.ts";
import { FactoryError } from "../../core/types.ts";
import { parallelSearch, type SearchSettings } from "../../agents/web-search.ts";
import type { SetupContext, Step } from "../context.ts";
import { CandidateStore } from "./candidate-store.ts";

const STORE_REF = "store:parallel";
const ENV_REF = "env:PARALLEL_API_KEY";

type Choice = "paste" | "env" | "skip";

/** The "Retry / Save anyway / Skip" choice after a failed verification (default Retry). */
async function afterFailure(ctx: SetupContext): Promise<"retry" | "save" | "skip"> {
	return ctx.ui.select({
		message: "The test search failed. What now?",
		options: [
			{ value: "retry", label: "Retry" },
			{ value: "save", label: "Save anyway" },
			{ value: "skip", label: "Skip" },
		],
		initial: "retry",
	});
}

/**
 * One billed query with `maxResults: 1` over the effective webSearch settings and `ref` as the key. A pasted
 * `candidate` answers `store:parallel` from memory for the duration of the call (the default store is restored after).
 */
async function testSearch(ctx: SetupContext, ref: string, candidate?: string): Promise<boolean> {
	const eff = (await ctx.settings()).effective({ global: true });
	const settings: SearchSettings = { ...(eff.webSearch ?? {}), apiKey: ref, maxResults: 1 };
	const spin = ctx.ui.spinner();
	spin.start("Running a test search");
	if (candidate !== undefined) setDefaultSecretStore(new CandidateStore(ctx.secrets.path, "parallel", candidate));
	try {
		const out = await parallelSearch({ objective: "factory setup connectivity check", queries: ["parallel web search"] }, settings, { fetch: ctx.fetch });
		spin.stop(`Test search returned ${out.details.count} result${out.details.count === 1 ? "" : "s"}`);
		return true;
	} catch (e) {
		spin.stop("Test search failed");
		ctx.ui.log.error((e as Error).message);
		return false;
	} finally {
		if (candidate !== undefined) setDefaultSecretStore(ctx.secrets);
	}
}

export const step: Step = {
	name: "search",
	title: "Web search (Parallel)",
	async status(ctx) {
		const eff = (await ctx.settings()).effective({ global: true });
		const ref: string = eff.webSearch?.apiKey ?? ENV_REF;
		if (resolveSecret(ref, ctx.secrets)) return { state: "ok", detail: ref };
		return { state: "warn", detail: `webSearch.apiKey (${ref}) does not resolve; web search is optional` };
	},
	async run(ctx) {
		const options: { value: Choice; label: string; hint?: string }[] = [{ value: "paste", label: "Paste a Parallel key" }];
		if (ctx.env.PARALLEL_API_KEY) options.push({ value: "env", label: "Keep env:PARALLEL_API_KEY", hint: "not seen by a service" });
		options.push({ value: "skip", label: "Skip", hint: "web search stays unconfigured" });
		const choice = await ctx.ui.select<Choice>({ message: "Web search (Parallel)", options, initial: "paste" });
		if (choice === "skip") return;

		const ref = choice === "paste" ? STORE_REF : ENV_REF;
		let key: string | undefined;
		let test: boolean | undefined;
		for (;;) {
			if (choice === "paste") {
				key = (
					await ctx.ui.password({
						message: "Parallel API key",
						validate: (v) => (v.trim() ? undefined : "required"),
					})
				).trim();
			}
			test ??= await ctx.ui.confirm({ message: "Run one test search (billed)?", initial: true });
			if (!test) break;
			if (await testSearch(ctx, ref, key)) break;
			const next = await afterFailure(ctx);
			if (next === "save") break;
			if (next === "skip") return;
		}

		if (key !== undefined) ctx.secrets.set("parallel", key);
		try {
			(await ctx.settings()).set({ global: true }, "webSearch.apiKey", ref);
		} catch (e) {
			if (!(e instanceof FactoryError)) throw e;
			ctx.ui.log.error(e.message);
			return;
		}
		ctx.ui.log.success(`web search uses ${ref}`);
	},
};
