// Setup section "roles" (spec §3.4).
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { setDefaultSecretStore } from "../src/core/settings.ts";
import { step } from "../src/setup/steps/roles.ts";
import { SetupCancelled } from "../src/setup/ui.ts";
import { testContext, type TestContextOptions } from "./setup-context.ts";
import { CANCEL } from "./setup-helpers.ts";

afterEach(() => setDefaultSecretStore(undefined));

const FAMILY = "The reviewer is meant to be a different model family from the builder";

/** A test context whose host also has the fixture provider package installed (sf-fixture/vision-1, sf-fixture/text-1). */
async function withFixture(opts: TestContextOptions) {
	const t = testContext(opts);
	await (await t.ctx.host()).packages.installAndPersist(resolve("test/fixtures/provider-package"));
	await t.ctx.reloadHost();
	return t;
}

const selects = (shown: { kind: string; message: string; options?: string[] }[], message: string) => shown.filter((s) => s.kind === "select" && s.message === message);

const ALL_SCRIPTED = `version: 1
roles:
  architect: { model: scripted/architect, thinking: high }
  builder: { model: scripted/builder, thinking: high }
  reviewer: { model: sf-fixture/text-1, thinking: high }
  qa: { model: scripted/qa, thinking: medium }
`;

describe("setup roles", () => {
	test("writes roles globally", async () => {
		const { ctx, ui } = await withFixture({
			answers: ["scripted/architect", "high", "sf-fixture/text-1", "medium", "scripted/helper", "low", "scripted/reviewer", "high", "sf-fixture/vision-1", "off"],
		});
		await step.run(ctx);
		expect((await ctx.settings()).raw().roles).toEqual({
			architect: { model: "scripted/architect", thinking: "high" },
			builder: { model: "sf-fixture/text-1", thinking: "medium" },
			helper: { model: "scripted/helper", thinking: "low" },
			reviewer: { model: "scripted/reviewer", thinking: "high" },
			qa: { model: "sf-fixture/vision-1", thinking: "off" },
		});
		expect(ui.shown.filter((s) => s.kind === "select").map((s) => s.message)).toEqual([
			"Model for architect",
			"Thinking for architect",
			"Model for builder",
			"Thinking for builder",
			"Model for helper",
			"Thinking for helper",
			"Model for reviewer",
			"Thinking for reviewer",
			"Model for qa",
			"Thinking for qa",
		]);
		expect(selects(ui.shown, "Thinking for qa")[0]!.options).toEqual(["off", "low", "medium", "high"]);
		expect(ui.shown.filter((s) => s.kind === "log.warn" || s.kind === "log.error")).toEqual([]);
		expect(ui.remaining()).toBe(0);
	});

	test("the current value is the initial choice; an unavailable one is listed first with (no credentials)", async () => {
		const seen: { message: string; options: { value: string; label: string; hint?: string }[]; initial?: string }[] = [];
		const keep = (o: (typeof seen)[number]) => {
			seen.push(o);
			return o.initial;
		};
		const { ctx, ui } = await withFixture({ answers: Array(9).fill(keep) });
		await step.run(ctx);
		const architect = seen.find((o) => o.message === "Model for architect")!;
		expect(architect.initial).toBe("anthropic/claude-opus-5-5");
		expect(architect.options[0]).toMatchObject({ value: "anthropic/claude-opus-5-5", hint: "(no credentials)" });
		expect(architect.options.find((o) => o.value === "sf-fixture/vision-1")).toEqual({ value: "sf-fixture/vision-1", label: "Vision 1" });
		expect(architect.options.filter((o) => o.hint === "(no credentials)")).toHaveLength(1);
		expect(seen.find((o) => o.message === "Thinking for architect")!.initial).toBe("high");
		expect(seen.find((o) => o.message === "Thinking for qa")!.initial).toBe("medium");
		expect(seen.find((o) => o.message === "Model for helper")!.initial).toBe("__builder__");
		// anthropic (builder) vs openai (reviewer): different families
		expect(ui.shown.filter((s) => s.kind === "log.warn")).toEqual([]);
		expect((await ctx.settings()).raw().roles?.helper).toBeUndefined();
		expect(ui.remaining()).toBe(0);
	});

	test("qa lists only image models", async () => {
		const { ctx, ui } = await withFixture({ config: ALL_SCRIPTED, answers: ["scripted/architect", "high", "scripted/builder", "high", "__builder__", "sf-fixture/text-1", "high", "sf-fixture/vision-1", "medium"] });
		await step.run(ctx);
		const qa = selects(ui.shown, "Model for qa")[0]!.options!;
		expect(qa).toContain("sf-fixture/vision-1");
		expect(qa).not.toContain("sf-fixture/text-1");
		expect(selects(ui.shown, "Model for builder")[0]!.options).toContain("sf-fixture/text-1");
		expect((await ctx.settings()).raw().roles.qa).toEqual({ model: "sf-fixture/vision-1", thinking: "medium" });
		expect(ui.remaining()).toBe(0);
	});

	test("Same as builder unsets helper", async () => {
		const config = ALL_SCRIPTED.replace("  reviewer:", "  helper: { model: scripted/helper, thinking: low }\n  reviewer:");
		const { ctx, ui } = await withFixture({ config, answers: ["scripted/architect", "high", "scripted/builder", "medium", "__builder__", "sf-fixture/text-1", "high", "scripted/qa", "medium"] });
		expect((await ctx.settings()).raw().roles.helper).toEqual({ model: "scripted/helper", thinking: "low" });
		await step.run(ctx);
		const helper = selects(ui.shown, "Model for helper")[0]!.options!;
		expect(helper[0]).toBe("__builder__");
		expect(selects(ui.shown, "Thinking for helper")).toEqual([]);
		const cfg = await ctx.settings();
		expect(cfg.raw().roles.helper).toBeUndefined();
		expect(cfg.effective({ global: true }).roles.helper).toEqual({ model: "scripted/builder", thinking: "medium" });
		expect(ui.remaining()).toBe(0);
	});

	test("same-provider reviewer warns", async () => {
		const { ctx, ui } = await withFixture({ config: ALL_SCRIPTED, answers: ["scripted/architect", "high", "scripted/builder", "high", "__builder__", "scripted/reviewer", "high", "scripted/qa", "medium"] });
		await step.run(ctx);
		expect(ui.shown.filter((s) => s.kind === "log.warn").map((s) => s.message)).toEqual([FAMILY]);
		expect((await ctx.settings()).raw().roles.reviewer).toEqual({ model: "scripted/reviewer", thinking: "high" });
		expect(ui.remaining()).toBe(0);
	});

	test("an unknown current model is shown as (unknown model) and is not the default; a non-image qa model as (no image input)", async () => {
		type Seen = { message: string; options: { value: string; label: string; hint?: string }[]; initial?: string };
		const seen: Seen[] = [];
		const keep = (o: Seen) => {
			seen.push(o);
			return o.initial;
		};
		const config = ALL_SCRIPTED.replace("model: scripted/builder", "model: nope/x").replace("model: scripted/qa", "model: sf-fixture/text-1");
		const { ctx, ui } = await withFixture({ config, answers: Array(9).fill(keep) });
		await step.run(ctx);
		const builder = seen.find((o) => o.message === "Model for builder")!;
		expect(builder.options[0]).toEqual({ value: "nope/x", label: "nope/x", hint: "(unknown model)" });
		expect(builder.initial).toBe(builder.options[1]!.value);
		const qa = seen.find((o) => o.message === "Model for qa")!;
		expect(qa.options[0]).toEqual({ value: "sf-fixture/text-1", label: "Text 1", hint: "(no image input)" });
		expect(qa.initial).toBe(qa.options[1]!.value);
		expect(ui.shown.filter((s) => s.kind === "log.error")).toEqual([]);
		const roles = (await ctx.settings()).raw().roles;
		expect(roles.builder.model).toBe(builder.options[1]!.value);
		expect(roles.qa.model).toBe(qa.options[1]!.value);
		expect(ui.remaining()).toBe(0);
	});

	const BAD_BUILDER = ALL_SCRIPTED.replace("model: scripted/builder", "model: nope/x");
	const PICK_BAD = ["scripted/architect", "low", "nope/x", "medium", "__builder__", "sf-fixture/text-1", "high", "scripted/qa", "off"];

	test("a failed save keeps the choices and retries only the roles the error names", async () => {
		const inits: Record<string, string | undefined> = {};
		const keep = (o: { message: string; initial?: string }) => {
			inits[o.message] = o.initial;
			return o.initial;
		};
		const { ctx, ui, home } = await withFixture({ config: BAD_BUILDER, answers: [...PICK_BAD, "retry", "scripted/builder", keep, keep] });
		const before = readFileSync(join(home, "config.yaml"), "utf8");
		await step.run(ctx);
		const errors = ui.shown.filter((s) => s.kind === "log.error").map((s) => s.message);
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain("roles.builder.model: nope/x");
		const retry = ui.shown.findIndex((s) => s.kind === "select" && s.message === "Roles were not saved");
		expect(ui.shown[retry]!.options).toEqual(["retry", "skip"]);
		expect(ui.shown.slice(retry + 1).filter((s) => s.kind === "select").map((s) => s.message)).toEqual(["Model for builder", "Thinking for builder", "Model for helper"]);
		expect(inits).toEqual({ "Thinking for builder": "medium", "Model for helper": "__builder__" });
		expect(readFileSync(join(home, "config.yaml"), "utf8")).not.toBe(before);
		expect((await ctx.settings()).raw().roles).toEqual({
			architect: { model: "scripted/architect", thinking: "low" },
			builder: { model: "scripted/builder", thinking: "medium" },
			reviewer: { model: "sf-fixture/text-1", thinking: "high" },
			qa: { model: "scripted/qa", thinking: "off" },
		});
		expect(ui.remaining()).toBe(0);
	});

	test("a failed save then Skip saves nothing", async () => {
		const { ctx, ui, home } = await withFixture({ config: BAD_BUILDER, answers: [...PICK_BAD, "skip"] });
		await step.run(ctx);
		expect(readFileSync(join(home, "config.yaml"), "utf8")).toBe(BAD_BUILDER);
		expect(ui.remaining()).toBe(0);
	});

	test("a cancel mid-section leaves the config unchanged", async () => {
		const { ctx, home } = await withFixture({ config: ALL_SCRIPTED, answers: ["scripted/builder", "low", "sf-fixture/text-1", CANCEL] });
		await expect(step.run(ctx)).rejects.toBeInstanceOf(SetupCancelled);
		expect(readFileSync(join(home, "config.yaml"), "utf8")).toBe(ALL_SCRIPTED);
	});

	test("no available model is an error", async () => {
		const { ctx, ui } = testContext({ answers: [] });
		(await ctx.host()).models.getAvailable = async () => [];
		await step.run(ctx);
		expect(ui.shown.filter((s) => s.kind === "log.error").map((s) => s.message)).toEqual(["no models have credentials; run factory setup models first"]);
		expect(ui.shown.filter((s) => s.kind === "select")).toEqual([]);
	});

	test("status: ok, warn without credentials, missing for an unknown model", async () => {
		const ok = await withFixture({ config: ALL_SCRIPTED, answers: [] });
		expect((await step.status(ok.ctx)).state).toBe("ok");

		const warn = testContext({ answers: [] }); // the defaults: anthropic/openai, no credentials
		const w = await step.status(warn.ctx);
		expect(w.state).toBe("warn");
		expect(w.detail).toContain("anthropic/claude-opus-5-5");

		const missing = testContext({ answers: [], config: "version: 1\nroles:\n  builder: { model: nope/x }\n" });
		const m = await step.status(missing.ctx);
		expect(m.state).toBe("missing");
		expect(m.detail).toContain("nope/x");
	});
});
