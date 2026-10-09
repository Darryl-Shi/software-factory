// Layered settings (spec §5, §6): default → global → project, validate on save, file unchanged on rejection.
import { readFileSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, test } from "vitest";
import { makeFactory, type TestEnv } from "./helpers.ts";

let t: TestEnv | undefined;
afterEach(async () => {
	await t?.factory.close().catch(() => {});
	t = undefined;
});
const G = { global: true } as const;

describe("settings layering", () => {
	test("every value reports its source: default, global or project", async () => {
		t = await makeFactory();
		const f = t.factory;
		await f.createProject("pay", "acme/payments");
		let s = await f.getSettings({ project: "pay" });
		expect(s["policy.reviewRoundCap"]).toEqual({ value: 3, source: "default" });
		expect(s["policy.approvals"]).toEqual({ value: [], source: "global" }); // the test config sets approvals: []
		expect(s["roles.reviewer.model"]).toEqual({ value: "scripted/reviewer", source: "global" });
		expect(s["roles.reviewer.thinking"]).toEqual({ value: "high", source: "default" });
		expect(s["stages.delivery.ci.mode"]).toEqual({ value: "if-present", source: "default" });
		expect(s["stages.delivery.ci.fixRounds"]).toEqual({ value: 2, source: "default" });
		expect(s["stages.delivery.ci.noChecksTimeout"]).toEqual({ value: "300ms", source: "global" });
		expect(s["stages.environment.sandbox.allowedDomains"].value).toContain("registry.npmjs.org");

		await f.setSetting({ project: "pay" }, "policy.approvals", ["spec", "delivery", "merge"]);
		await f.setSetting({ project: "pay" }, "roles.reviewer.thinking", "medium");
		await f.setSetting({ project: "pay" }, "stages.delivery.ci.mode", "required");
		s = await f.getSettings({ project: "pay" });
		expect(s["policy.approvals"]).toEqual({ value: ["spec", "delivery", "merge"], source: "project" });
		expect(s["roles.reviewer.thinking"]).toEqual({ value: "medium", source: "project" });
		// objects merge key by key: the model is still inherited
		expect(s["roles.reviewer.model"]).toEqual({ value: "scripted/reviewer", source: "global" });
		expect(s["stages.delivery.ci.mode"]).toEqual({ value: "required", source: "project" });
		expect(s["stages.delivery.ci.fixRounds"]).toEqual({ value: 2, source: "default" });
		// global scope is unaffected by project overrides
		const g = await f.getSettings(G);
		expect(g["stages.delivery.ci.mode"].value).toBe("if-present");
		expect(g["roles.reviewer.thinking"].value).toBe("high");
	});

	test("a global change is inherited by projects that leave the value unset; lists replace as a whole", async () => {
		t = await makeFactory();
		const f = t.factory;
		await f.createProject("a", "me/a");
		await f.createProject("b", "me/b");
		await f.setSetting({ project: "b" }, "policy.approvals", ["merge"]);
		await f.setSetting(G, "policy.approvals", ["spec", "delivery"]);
		expect((await f.getSettings({ project: "a" }))["policy.approvals"]).toEqual({ value: ["spec", "delivery"], source: "global" });
		expect((await f.getSettings({ project: "b" }))["policy.approvals"]).toEqual({ value: ["merge"], source: "project" });
		await f.setSetting(G, "stages.environment.sandbox.allowedDomains", ["pypi.org"]);
		await f.setSetting({ project: "a" }, "stages.environment.sandbox.allowedDomains", ["registry.npmjs.org"]);
		expect((await f.getSettings({ project: "a" }))["stages.environment.sandbox.allowedDomains"].value).toEqual(["registry.npmjs.org"]);
	});

	test("unset at project scope goes back to inheriting; empty override maps are pruned", async () => {
		t = await makeFactory();
		const f = t.factory;
		await f.createProject("pay", "acme/payments");
		await f.setSetting({ project: "pay" }, "roles.reviewer.thinking", "low");
		expect((await f.getSettings({ project: "pay" }))["roles.reviewer.thinking"].source).toBe("project");
		await f.unsetSetting({ project: "pay" }, "roles.reviewer.thinking");
		expect((await f.getSettings({ project: "pay" }))["roles.reviewer.thinking"]).toEqual({ value: "high", source: "default" });
		const raw = readFileSync(t.configPath, "utf8");
		expect(raw).toMatch(/pay:\n\s+repo: acme\/payments/);
		expect(raw).not.toMatch(/reviewer:\s*\{\}/);
		expect((await f.getProject("pay")).overrides).toEqual({});
		// unsetting something the project never overrode is a no-op
		await f.unsetSetting({ project: "pay" }, "policy.approvals");
		await f.unsetSetting({ project: "pay" }, "stages.delivery.ci.mode");
		expect(readFileSync(t.configPath, "utf8")).toBe(raw);
	});

	test("overrides can be set as soon as the project exists, before its repo does, and apply from the first run", async () => {
		t = await makeFactory();
		const f = t.factory;
		await f.createProject("todo2", "me/todo2");
		expect(await t.host.repoExists("me/todo2")).toBe(false);
		await f.setSetting({ project: "todo2" }, "stages.delivery.ci.mode", "off");
		const run = await f.startRun("todo2", { source: "t", title: "x", body: "x" });
		const v = await f.waitForState(run, (x) => x.state === "DELIVERED");
		expect(v.history.map((h) => h.to)).not.toContain("AWAITING_CI");
	});

	test("validate on save: invalid values are rejected and the config file is unchanged", async () => {
		t = await makeFactory();
		const f = t.factory;
		await f.createProject("p", "me/p");
		const before = readFileSync(t.configPath, "utf8");
		const bad: [any, string, unknown, RegExp][] = [
			[G, "stages.delivery.ci.fixRounds", 5, /above the maximum 3/],
			[{ project: "p" }, "stages.delivery.ci.fixRounds", -1, /below the minimum 0/],
			[G, "stages.delivery.ci.mode", "sometimes", /expected one of off, if-present, required/],
			[G, "stages.delivery.ci.noChecksTimeout", "soon", /not a duration/],
			[G, "policy.approvals", ["spec", "deploy"], /expected one of spec, delivery, merge/],
			[G, "policy.approvals", ["spec", "spec"], /duplicate gate/],
			[G, "roles.reviewer.model", "openai/no-such-model", /not a model createModels\(\) knows/],
			[G, "roles.reviewer.thinking", "extreme", /expected one of off, low, medium, high/],
			[G, "roles.builder.extensions", ["coding", "teleport"], /teleport is not an installed worker extension/],
			[G, "stages.repo.identity.tokenRef", "ghp_abc123", /secret reference/],
			[G, "stages.environment.sandbox.extraWrite", ["~"], /home directory/],
			[G, "stages.environment.sandbox.extraWrite", ["~/.ssh/keys"], /denied secret path/],
			[{ project: "p" }, "storage.path", "/tmp/x.sqlite", /global only/],
			[G, "policy.nonsense", 1, /unknown setting/],
			[{ project: "nope" }, "policy.reviewRoundCap", 2, /does not exist/],
			[G, "stages.repo.identity.kind", "app", /needs identity.appId/],
		];
		for (const [scope, path, value, re] of bad) {
			await expect(f.setSetting(scope, path, value), `${path}=${JSON.stringify(value)}`).rejects.toThrow(re);
			expect(readFileSync(t.configPath, "utf8")).toBe(before);
		}
		// a valid change still works afterwards
		await f.setSetting(G, "stages.delivery.ci.fixRounds", 3);
		expect(readFileSync(t.configPath, "utf8")).not.toBe(before);
	});

	test("a global change that makes a project's effective config invalid is rejected", async () => {
		t = await makeFactory();
		const f = t.factory;
		await f.createProject("p", "me/p");
		// hand-edit an override the validator would reject only in combination
		await f.setSetting({ project: "p" }, "stages.repo.identity.appId", 1);
		const before = readFileSync(t.configPath, "utf8");
		await expect(f.setSetting(G, "stages.repo.identity.kind", "app")).rejects.toThrow(/project p/);
		expect(readFileSync(t.configPath, "utf8")).toBe(before);
	});

	test("settingsSchema includes the core's and every installed extension's schemas", async () => {
		t = await makeFactory();
		const schema = t.factory.settingsSchema();
		expect(Object.keys(schema)).toEqual(["version", "roles", "policy", "storage", "stages"]);
		const stages = (schema.stages as any).fields;
		expect(Object.keys(stages)).toEqual(["intake", "interface", "repo", "delivery", "environment"]);
		expect(Object.keys(stages.delivery.fields)).toEqual(["use", "newRepo", "existingRepo", "ci"]);
		expect(Object.keys(stages.delivery.fields.ci.fields)).toEqual(["mode", "fixRounds", "checks", "noChecksTimeout"]);
		expect(Object.keys(stages.repo.fields)).toContain("identity");
		expect(Object.keys(stages.environment.fields.sandbox.fields)).toEqual(["enabled", "allowedDomains", "deniedDomains", "denyRead", "extraWrite", "unixSockets"]);
	});

	test("projects: createProject is idempotent, validates names and repo bindings, and rejects rebinding", async () => {
		t = await makeFactory();
		const f = t.factory;
		await f.createProject("todo", "me/todo");
		await f.createProject("todo", "me/todo");
		expect((await f.listProjects()).map((p) => p.name)).toEqual(["todo"]);
		await expect(f.createProject("todo", "me/other")).rejects.toThrow(/already bound/);
		await expect(f.createProject("bad name", "me/x")).rejects.toThrow(/invalid project name/);
		await expect(f.createProject("x", "not-a-repo")).rejects.toThrow(/owner\/name/);
		await expect(f.getProject("nope")).rejects.toThrow(/does not exist/);
	});

	test("comments and unrelated content in the config file survive edits", async () => {
		t = await makeFactory();
		writeFileSync(t.configPath, readFileSync(t.configPath, "utf8").replace("version: 1", "# my factory\nversion: 1 # pinned"));
		t.factory.config.reload();
		await t.factory.setSetting(G, "policy.reviewRoundCap", 4);
		const raw = readFileSync(t.configPath, "utf8");
		expect(raw).toContain("# my factory");
		expect(raw).toContain("reviewRoundCap: 4");
	});
});
