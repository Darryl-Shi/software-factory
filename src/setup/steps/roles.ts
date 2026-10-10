// Setup section "roles" (spec §3.4): a model and a thinking level per role, from the models that have credentials.
import { FactoryError } from "../../core/types.ts";
import type { SetupContext, Step, StepStatus } from "../context.ts";

export const ROLES = ["architect", "builder", "helper", "reviewer", "qa"] as const;
type Role = (typeof ROLES)[number];
const THINKING = ["off", "low", "medium", "high"] as const;
/** The helper's `Same as builder` choice: roles.helper.{model, thinking} unset. */
const SAME_AS_BUILDER = "__builder__";
const FAMILY_WARNING = "The reviewer is meant to be a different model family from the builder";

interface ModelInfo {
	provider: string;
	id: string;
	name: string;
	input: readonly string[];
}

const ref = (m: ModelInfo): string => `${m.provider}/${m.id}`;
const providerOf = (r: string): string => r.split("/")[0]!;

function lookup(models: { getModel(p: string, id: string): ModelInfo | undefined }, r: string): ModelInfo | undefined {
	const [provider, ...rest] = r.split("/");
	return provider && rest.length ? models.getModel(provider, rest.join("/")) : undefined;
}

async function status(ctx: SetupContext): Promise<StepStatus> {
	const { models } = await ctx.host();
	const roles = (await ctx.settings()).effective({ global: true }).roles ?? {};
	const available = new Set((await models.getAvailable()).map(ref));
	const unknown: string[] = [];
	const noCreds: string[] = [];
	for (const role of ROLES) {
		const r = String(roles[role]?.model ?? "");
		if (!lookup(models, r)) unknown.push(`${role} (${r})`);
		else if (!available.has(r)) noCreds.push(`${role} (${r})`);
	}
	if (unknown.length) return { state: "missing", detail: `unknown model: ${unknown.join(", ")}` };
	if (noCreds.length) return { state: "warn", detail: `no credentials: ${noCreds.join(", ")}` };
	return { state: "ok", detail: `builder ${roles.builder.model}, reviewer ${roles.reviewer.model}` };
}

async function run(ctx: SetupContext): Promise<void> {
	const { ui } = ctx;
	const { models } = await ctx.host();
	const available = (await models.getAvailable()) as readonly ModelInfo[];
	if (available.length === 0) {
		ui.log.error("no models have credentials; run factory setup models first");
		return;
	}
	const cfg = await ctx.settings();
	const raw = cfg.raw();
	const eff = cfg.effective({ global: true }).roles ?? {};
	const chosen: Partial<Record<Role, { model: string; thinking: string }>> = {};

	for (const role of ROLES) {
		const inheriting = role === "helper" && raw.roles?.helper?.model === undefined;
		const current = inheriting ? SAME_AS_BUILDER : String(eff[role]?.model ?? "");
		const pool = role === "qa" ? available.filter((m) => m.input.includes("image")) : available;
		const options: { value: string; label: string; hint?: string }[] = pool.map((m) => ({ value: ref(m), label: m.name }));
		if (current !== SAME_AS_BUILDER && current && !options.some((o) => o.value === current)) {
			options.unshift({ value: current, label: lookup(models, current)?.name ?? current, hint: "(no credentials)" });
		}
		if (role === "helper") options.unshift({ value: SAME_AS_BUILDER, label: "Same as builder" });
		const model = await ui.select({ message: `Model for ${role}`, options, initial: current || undefined });
		if (model === SAME_AS_BUILDER) continue;
		if (role === "reviewer" && chosen.builder && providerOf(model) === providerOf(chosen.builder.model)) ui.log.warn(FAMILY_WARNING);
		const thinking = await ui.select({
			message: `Thinking for ${role}`,
			options: THINKING.map((t) => ({ value: t, label: t })),
			initial: (THINKING as readonly string[]).includes(eff[role]?.thinking) ? eff[role].thinking : undefined,
		});
		chosen[role] = { model, thinking };
	}

	try {
		// One write: every role at once (a helper left out = Same as builder, i.e. unset).
		cfg.set({ global: true }, "roles", chosen);
	} catch (e) {
		if (!(e instanceof FactoryError)) throw e;
		ui.log.error(e.message);
	}
}

export const step: Step = {
	name: "roles",
	title: "Role models",
	status,
	run,
};
