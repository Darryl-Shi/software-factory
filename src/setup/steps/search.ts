// Setup section "search" (spec §3.4): a Parallel key for the web_search tool (stored as `store:parallel`),
// env:PARALLEL_API_KEY, or skip. `parallelSearch` resolves the key only through the default secret store, so a pasted
// key is written to secrets.json before the optional test search and rolled back (to the earlier value, or removed)
// if the user then picks Skip; config.yaml changes only on success or "Save anyway".
import { resolveSecret } from "../../core/settings.ts";
import { FactoryError } from "../../core/types.ts";
import { parallelSearch, type SearchSettings } from "../../agents/web-search.ts";
import type { SetupContext, Step } from "../context.ts";

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

/** One billed query with `maxResults: 1` over the effective webSearch settings and `ref` as the key. */
async function testSearch(ctx: SetupContext, ref: string): Promise<boolean> {
	const eff = (await ctx.settings()).effective({ global: true });
	const settings: SearchSettings = { ...(eff.webSearch ?? {}), apiKey: ref, maxResults: 1 };
	const spin = ctx.ui.spinner();
	spin.start("Running a test search");
	try {
		const out = await parallelSearch({ objective: "factory setup connectivity check", queries: ["parallel web search"] }, settings, { fetch: ctx.fetch });
		spin.stop(`Test search returned ${out.details.count} result${out.details.count === 1 ? "" : "s"}`);
		return true;
	} catch (e) {
		spin.stop("Test search failed");
		ctx.ui.log.error((e as Error).message);
		return false;
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
		if (ctx.env.PARALLEL_API_KEY) options.push({ value: "env", label: "Keep env:PARALLEL_API_KEY", hint: "PARALLEL_API_KEY is set" });
		options.push({ value: "skip", label: "Skip", hint: "web search stays unconfigured" });
		const choice = await ctx.ui.select<Choice>({ message: "Web search (Parallel)", options, initial: "paste" });
		if (choice === "skip") return;

		const ref = choice === "paste" ? STORE_REF : ENV_REF;
		const previous = choice === "paste" ? ctx.secrets.get("parallel") : undefined;
		const rollback = () => {
			if (choice !== "paste") return;
			if (previous === undefined) ctx.secrets.delete("parallel");
			else ctx.secrets.set("parallel", previous);
		};

		let test: boolean | undefined;
		try {
			for (;;) {
				if (choice === "paste") {
					const key = (
						await ctx.ui.password({
							message: "Parallel API key",
							validate: (v) => (v.trim() ? undefined : "required"),
						})
					).trim();
					ctx.secrets.set("parallel", key);
				}
				test ??= await ctx.ui.confirm({ message: "Run one test search (billed)?", initial: true });
				if (!test) break;
				if (await testSearch(ctx, ref)) break;
				const next = await afterFailure(ctx);
				if (next === "save") break;
				if (next === "skip") {
					rollback();
					return;
				}
			}
		} catch (e) {
			// A cancel (or anything else) mid-way leaves secrets.json as it was.
			rollback();
			throw e;
		}

		try {
			(await ctx.settings()).set({ global: true }, "webSearch.apiKey", ref);
		} catch (e) {
			if (!(e instanceof FactoryError)) throw e;
			rollback();
			ctx.ui.log.error(e.message);
			return;
		}
		ctx.ui.log.success(`web search uses ${ref}`);
	},
};
