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
	/** Every role's choice; `SAME_AS_BUILDER` for a helper that inherits. Kept across a failed save. */
	const chosen = new Map<Role, { model: string; thinking: string } | typeof SAME_AS_BUILDER>();

	const prompt = async (role: Role): Promise<void> => {
		const prev = chosen.get(role);
		const current =
			prev !== undefined
				? prev === SAME_AS_BUILDER
					? SAME_AS_BUILDER
					: prev.model
				: role === "helper" && raw.roles?.helper?.model === undefined
					? SAME_AS_BUILDER
					: String(eff[role]?.model ?? "");
		const currentThinking = prev !== undefined && prev !== SAME_AS_BUILDER ? prev.thinking : eff[role]?.thinking;
		const pool = role === "qa" ? available.filter((m) => m.input.includes("image")) : available;
		const options: { value: string; label: string; hint?: string }[] = pool.map((m) => ({ value: ref(m), label: m.name }));
		if (role === "helper") options.unshift({ value: SAME_AS_BUILDER, label: "Same as builder" });
		let initial: string | undefined = current;
		if (current !== SAME_AS_BUILDER && current && !options.some((o) => o.value === current)) {
			const known = lookup(models, current);
			const hint = !known ? "(unknown model)" : role === "qa" && !known.input.includes("image") ? "(no image input)" : "(no credentials)";
			// Only a known model that merely lacks credentials stays the default; an invalid one would fail the save.
			if (hint !== "(no credentials)") initial = options[0]?.value;
			options.unshift({ value: current, label: known?.name ?? current, hint });
		}
		const model = await ui.select({ message: `Model for ${role}`, options, initial: initial || undefined });
		if (model === SAME_AS_BUILDER) {
			chosen.set(role, SAME_AS_BUILDER);
			return;
		}
		const thinking = await ui.select({
			message: `Thinking for ${role}`,
			options: THINKING.map((t) => ({ value: t, label: t })),
			initial: (THINKING as readonly string[]).includes(currentThinking) ? currentThinking : undefined,
		});
		chosen.set(role, { model, thinking });
	};

	const modelOf = (role: Role): string | undefined => {
		const c = chosen.get(role);
		return c && c !== SAME_AS_BUILDER ? c.model : undefined;
	};

	let pending: readonly Role[] = ROLES;
	for (;;) {
		for (const role of pending) {
			await prompt(role);
			const builder = modelOf("builder");
			const reviewer = modelOf("reviewer");
			const check = role === "reviewer" || (role === "builder" && !pending.includes("reviewer"));
			if (check && builder && reviewer && providerOf(builder) === providerOf(reviewer)) ui.log.warn(FAMILY_WARNING);
		}
		let problem: string;
		const roles = Object.fromEntries([...chosen].filter(([, c]) => c !== SAME_AS_BUILDER));
		try {
			// One write: every role at once (a helper left out = Same as builder, i.e. unset).
			cfg.set({ global: true }, "roles", roles);
			return;
		} catch (e) {
			if (!(e instanceof FactoryError)) throw e;
			problem = e.message;
			ui.log.error(problem);
		}
		const next = await ui.select({
			message: "Roles were not saved",
			options: [
				{ value: "retry", label: "Retry" },
				{ value: "skip", label: "Skip" },
			],
			initial: "retry",
		});
		if (next === "skip") return;
		// Re-prompt only the roles the error names; all of them (with the choices as defaults) if it names none.
		const named = ROLES.filter((r) => problem.includes(`roles.${r}.`));
		pending = named.length ? named : ROLES;
	}
}

export const step: Step = {
	name: "roles",
	title: "Role models",
	status,
	run,
};
