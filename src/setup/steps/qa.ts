// Setup section "qa" (spec §3.4): a boat.dev key for AQ testing (stored as `store:boat`), env:BOAT_API_KEY, or off.
// A pasted key is verified with `Boat.limits` before anything is written: the check resolves `store:boat` through a
// one-key in-memory store, so secrets.json and config.yaml change only on success or "Save anyway".
import { FactoryError } from "../../core/types.ts";
import { resolveSecret } from "../../core/settings.ts";
import type { SecretStore } from "../../secrets/store.ts";
import type { SetupContext, Step } from "../context.ts";

const STORE_REF = "store:boat";
const ENV_REF = "env:BOAT_API_KEY";

type Choice = "enable" | "env" | "off";

/** The "Retry / Save anyway / Skip" choice after a failed verification (default Retry). */
async function afterFailure(ctx: SetupContext): Promise<"retry" | "save" | "skip"> {
	return ctx.ui.select({
		message: "Verification failed. What now?",
		options: [
			{ value: "retry", label: "Retry" },
			{ value: "save", label: "Save anyway" },
			{ value: "skip", label: "Skip" },
		],
		initial: "retry",
	});
}

/** `Boat.limits(ref)`; for a pasted key, `store:boat` resolves to the candidate key without touching secrets.json. */
async function verify(ctx: SetupContext, ref: string, candidate?: string): Promise<boolean> {
	const store = candidate === undefined ? undefined : ({ get: (k: string) => (k === "boat" ? candidate : undefined) } as unknown as SecretStore);
	const spin = ctx.ui.spinner();
	spin.start("Checking the boat.dev key");
	try {
		await ctx.boat.limits(ref, store);
		spin.stop("boat.dev key works");
		return true;
	} catch (e) {
		spin.stop("boat.dev check failed");
		ctx.ui.log.error(`boat.dev rejected the key: ${(e as Error).message}`);
		return false;
	}
}

async function save(ctx: SetupContext, values: [string, unknown][]): Promise<void> {
	const cfg = await ctx.settings();
	try {
		for (const [path, value] of values) cfg.set({ global: true }, path, value);
	} catch (e) {
		if (e instanceof FactoryError) {
			ctx.ui.log.error(e.message);
			return;
		}
		throw e;
	}
}

export const step: Step = {
	name: "qa",
	title: "AQ testing (boat.dev)",
	async status(ctx) {
		const eff = (await ctx.settings()).effective({ global: true });
		if (eff.qa?.enabled === false) return { state: "ok", detail: "off" };
		const ref: string = eff.boat?.apiKey ?? ENV_REF;
		if (resolveSecret(ref, ctx.secrets)) return { state: "ok", detail: ref };
		return { state: "missing", detail: `boat.apiKey (${ref}) does not resolve` };
	},
	async run(ctx) {
		const options: { value: Choice; label: string; hint?: string }[] = [{ value: "enable", label: "Enable AQ testing with a boat.dev key" }];
		if (ctx.env.BOAT_API_KEY) options.push({ value: "env", label: "Keep env:BOAT_API_KEY", hint: "BOAT_API_KEY is set" });
		options.push({ value: "off", label: "Turn AQ testing off" });
		const choice = await ctx.ui.select<Choice>({ message: "AQ testing (boat.dev)", options, initial: "enable" });

		if (choice === "off") {
			await save(ctx, [["qa.enabled", false]]);
			ctx.ui.note("AQ testing is off globally (qa.enabled: false); project overrides may still turn it on.", "AQ testing");
			return;
		}

		for (;;) {
			let key: string | undefined;
			if (choice === "enable") {
				key = (
					await ctx.ui.password({
						message: "boat.dev API key",
						validate: (v) => (v.trim() ? undefined : "required"),
					})
				).trim();
			}
			const ok = await verify(ctx, choice === "enable" ? STORE_REF : ENV_REF, key);
			const next = ok ? "save" : await afterFailure(ctx);
			if (next === "retry") continue;
			if (next === "skip") return;
			if (key !== undefined) ctx.secrets.set("boat", key);
			await save(ctx, [
				["boat.apiKey", key !== undefined ? STORE_REF : ENV_REF],
				["qa.enabled", true],
			]);
			if (ok) ctx.ui.log.success("AQ testing is on");
			return;
		}
	},
};
