// Layered settings (spec §5, §6): default → global → project, validate on save, file unchanged on rejection.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { ROLE_TOOLS } from "../src/agents/tools.ts";
import { bridgeToolsNotFor } from "../src/core/bridge.ts";
import { ConfigStore } from "../src/core/settings.ts";
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
		expect(s["ci.mode"]).toEqual({ value: "if-present", source: "default" });
		expect(s["ci.fixRounds"]).toEqual({ value: 2, source: "default" });
		expect(s["ci.noChecksTimeout"]).toEqual({ value: "300ms", source: "global" });
		expect(s["sandbox.allowedDomains"].value).toContain("registry.npmjs.org");

		await f.setSetting({ project: "pay" }, "policy.approvals", ["spec", "delivery", "merge"]);
		await f.setSetting({ project: "pay" }, "roles.reviewer.thinking", "medium");
		await f.setSetting({ project: "pay" }, "ci.mode", "required");
		s = await f.getSettings({ project: "pay" });
		expect(s["policy.approvals"]).toEqual({ value: ["spec", "delivery", "merge"], source: "project" });
		expect(s["roles.reviewer.thinking"]).toEqual({ value: "medium", source: "project" });
		// objects merge key by key: the model is still inherited
		expect(s["roles.reviewer.model"]).toEqual({ value: "scripted/reviewer", source: "global" });
		expect(s["ci.mode"]).toEqual({ value: "required", source: "project" });
		expect(s["ci.fixRounds"]).toEqual({ value: 2, source: "default" });
		// global scope is unaffected by project overrides
		const g = await f.getSettings(G);
		expect(g["ci.mode"].value).toBe("if-present");
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
		await f.setSetting(G, "sandbox.allowedDomains", ["pypi.org"]);
		await f.setSetting({ project: "a" }, "sandbox.allowedDomains", ["registry.npmjs.org"]);
		expect((await f.getSettings({ project: "a" }))["sandbox.allowedDomains"].value).toEqual(["registry.npmjs.org"]);
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
		await f.unsetSetting({ project: "pay" }, "ci.mode");
		expect(readFileSync(t.configPath, "utf8")).toBe(raw);
	});

	test("overrides can be set as soon as the project exists, before its repo does, and apply from the first run", async () => {
		t = await makeFactory();
		const f = t.factory;
		await f.createProject("todo2", "me/todo2");
		expect(await t.host.repoExists("me/todo2")).toBe(false);
		await f.setSetting({ project: "todo2" }, "ci.mode", "off");
		const run = await f.startRun("todo2", { source: "t", title: "x", body: "x" });
		const v = await f.waitForState(run, (x) => x.state === "READY");
		const bundle = await f.createBundle("todo2", [run]);
		const b = await f.waitForBundle(bundle, (x) => ["MERGED", "FAILED"].includes(x.state));
		expect(b.state).toBe("MERGED");
		expect(b.history.map((h) => h.to)).not.toContain("AWAITING_CI");
		expect((await f.getRun(v.id)).state).not.toBe("FAILED");
	});

	test("bundle.mergeMethod: merge | squash | rebase, globally or per project, validated on save; a bundle pins it", async () => {
		t = await makeFactory();
		const f = t.factory;
		await f.createProject("p", "me/p");
		const before = readFileSync(t.configPath, "utf8");
		await expect(f.setSetting(G, "bundle.mergeMethod", "fast-forward")).rejects.toThrow(/expected one of merge, squash, rebase/);
		await expect(f.setSetting({ project: "p" }, "bundle.mergeMethod", "octopus")).rejects.toMatchObject({ code: "invalid" });
		expect(readFileSync(t.configPath, "utf8")).toBe(before);
		expect((await f.getSettings({ project: "p" }))["bundle.mergeMethod"]).toEqual({ value: "squash", source: "default" });
		await f.setSetting(G, "bundle.mergeMethod", "merge");
		await f.setSetting({ project: "p" }, "bundle.mergeMethod", "rebase");
		expect((await f.getSettings({ project: "p" }))["bundle.mergeMethod"]).toEqual({ value: "rebase", source: "project" });
		expect((await f.getSettings(G))["bundle.mergeMethod"]).toEqual({ value: "merge", source: "global" });
		// the legacy merge gate still validates
		await f.setSetting({ project: "p" }, "policy.approvals", ["spec", "merge"]);
	});

	test("validate on save: invalid values are rejected and the config file is unchanged", async () => {
		t = await makeFactory();
		const f = t.factory;
		await f.createProject("p", "me/p");
		const before = readFileSync(t.configPath, "utf8");
		const bad: [any, string, unknown, RegExp][] = [
			[G, "ci.fixRounds", 5, /above the maximum 3/],
			[{ project: "p" }, "ci.fixRounds", -1, /below the minimum 0/],
			[G, "ci.mode", "sometimes", /expected one of off, if-present, required/],
			[G, "ci.noChecksTimeout", "soon", /not a duration/],
			[G, "policy.approvals", ["spec", "deploy"], /expected one of spec, delivery, merge/],
			[G, "policy.approvals", ["spec", "spec"], /duplicate gate/],
			[G, "roles.reviewer.model", "openai/no-such-model", /openai\/no-such-model is not a model the model host knows \(log in or add it with factory setup models\)/],
			[G, "roles.reviewer.thinking", "extreme", /expected one of off, low, medium, high/],
			[G, "roles.builder.extensions", ["coding"], /unknown setting/],
			[G, "github.identity.tokenRef", "ghp_abc123", /secret reference/],
			[G, "sandbox.extraWrite", ["~"], /home directory/],
			[G, "sandbox.extraWrite", ["~/.ssh/keys"], /denied secret path/],
			// the factory home is the config's directory: an extraWrite at, inside or around it is refused
			[G, "sandbox.extraWrite", [dirname(t.configPath)], /factory home/],
			[G, "sandbox.extraWrite", [join(dirname(t.configPath), "cache")], /factory home/],
			[G, "sandbox.extraWrite", [dirname(dirname(t.configPath))], /factory home/],
			[{ project: "p" }, "storage.path", "/tmp/x.sqlite", /global only/],
			[{ project: "p" }, "web.port", 8000, /global only/],
			[G, "web.port", 70000, /above the maximum 65535/],
			[G, "policy.nonsense", 1, /unknown setting/],
			[{ project: "nope" }, "policy.reviewRoundCap", 2, /does not exist/],
			[G, "github.identity.kind", "app", /needs identity.appId/],
			[G, "boat.ttl", "30s", /out of range \(10m to 24h\)/],
			[{ project: "p" }, "boat.ttl", "25h", /out of range/],
			[G, "boat.ttl", "later", /not a duration/],
			[G, "boat.runScripts", [], /at least one path/],
			[G, "boat.runScripts", ["/usr/bin/run"], /repo-relative path/],
			[G, "boat.runScripts", ["../run.sh"], /repo-relative path/],
			[G, "boat.apiKey", "bk_live_123", /secret reference/],
			[G, "boat.size", "huge", /expected one of small, default, large/],
			[G, "roles.qa.model", "scripted/builder-textonly", /does not accept image input/],
			[G, "policy.messages", ["qa"], /expected one of architect, builder, reviewer/],
			[G, "policy.messages", ["helper"], /expected one of architect, builder, reviewer/],
		];
		for (const [scope, path, value, re] of bad) {
			await expect(f.setSetting(scope, path, value), `${path}=${JSON.stringify(value)}`).rejects.toThrow(re);
			expect(readFileSync(t.configPath, "utf8")).toBe(before);
		}
		// a valid change still works afterwards
		await f.setSetting(G, "ci.fixRounds", 3);
		expect(readFileSync(t.configPath, "utf8")).not.toBe(before);
	});

	test("a global change that makes a project's effective config invalid is rejected", async () => {
		t = await makeFactory();
		const f = t.factory;
		await f.createProject("p", "me/p");
		// hand-edit an override the validator would reject only in combination
		await f.setSetting({ project: "p" }, "github.identity.appId", 1);
		const before = readFileSync(t.configPath, "utf8");
		await expect(f.setSetting(G, "github.identity.kind", "app")).rejects.toThrow(/project p/);
		expect(readFileSync(t.configPath, "utf8")).toBe(before);
	});

	test("settingsSchema is the fixed core schema", async () => {
		t = await makeFactory();
		const schema = t.factory.settingsSchema();
		expect(Object.keys(schema)).toEqual(["version", "workdir", "roles", "bundle", "discussion", "policy", "github", "ci", "sandbox", "qa", "boat", "web", "webSearch", "storage"]);
		expect(Object.keys((schema.roles as any).fields)).toEqual(["architect", "builder", "helper", "reviewer", "qa", "integrator"]);
		expect((schema.bundle as any).fields.mergeMethod).toMatchObject({ type: "enum", values: ["merge", "squash", "rebase"], default: "squash" });
		expect(Object.keys((schema.boat as any).fields)).toEqual(["apiKey", "size", "ttl", "runScripts"]);
		expect(Object.keys((schema.ci as any).fields)).toEqual(["mode", "fixRounds", "checks", "noChecksTimeout"]);
		expect(Object.keys((schema.sandbox as any).fields)).toEqual(["enabled", "allowedDomains", "deniedDomains", "denyRead", "extraWrite", "unixSockets", "setupScripts"]);
	});

	test("a config with the removed stages/workers sections refuses to start", async () => {
		await expect(makeFactory({ config: "version: 1\nstages:\n  delivery: { ci: { mode: off } }\n" })).rejects.toThrow(/removed sections \(stages\).*ci\.\*/);
		await expect(makeFactory({ config: "version: 1\nworkers:\n  web-search: { mode: fast }\n" })).rejects.toThrow(/removed sections \(workers\); move .*webSearch\.\*/);
		await expect(makeFactory({ config: "version: 1\nstages:\n  repo: { visibility: public }\nworkers:\n  web-search: { mode: fast }\n" })).rejects.toThrow(
			/removed sections \(stages, workers\); move /,
		);
	});

	test("removed stages/workers sections inside a project's overrides also refuse to start", async () => {
		const project = "version: 1\nprojects:\n  pay:\n    repo: acme/payments\n    stages:\n      delivery: { ci: { mode: required } }\n";
		await expect(makeFactory({ config: project })).rejects.toThrow(/removed sections \(stages\); move .*ci\.\*.*projects: pay/);
		const both = "version: 1\nworkers:\n  web-search: { mode: fast }\nprojects:\n  a: { repo: me/a }\n  b:\n    repo: me/b\n    stages:\n      repo: { identity: { kind: bot } }\n";
		await expect(makeFactory({ config: both })).rejects.toThrow(/removed sections \(stages, workers\); move .*projects: b$/);
	});

	test("a removed roles.<role>.extensions key refuses to start (it would silently re-enable web search)", async () => {
		const top = "version: 1\nroles:\n  reviewer: { model: openai/gpt-6-sol, extensions: [coding-readonly, test-runner, browser] }\n";
		await expect(makeFactory({ config: top })).rejects.toThrow(
			/^config uses removed keys \(roles\.reviewer\.extensions\); tool sets are now fixed per role, so delete these keys\. .*webSearch\.apiKey unresolved/,
		);
		const project =
			"version: 1\nroles:\n  helper: { extensions: [] }\nprojects:\n  todo:\n    repo: me/todo\n    roles:\n      builder: { extensions: [coding] }\n      reviewer: { thinking: high }\n";
		await expect(makeFactory({ config: project })).rejects.toThrow(/removed keys \(roles\.helper\.extensions, projects\.todo\.roles\.builder\.extensions\); /);
		const onlyProject = "version: 1\nprojects:\n  todo:\n    repo: me/todo\n    roles: { builder: { extensions: [coding] } }\n";
		await expect(makeFactory({ config: onlyProject })).rejects.toThrow(/^config uses removed keys \(projects\.todo\.roles\.builder\.extensions\)/);
		// together with removed sections: the sections message comes first, unchanged, then the extensions part
		const mixed = "version: 1\nworkers:\n  web-search: { mode: fast }\nroles:\n  reviewer: { extensions: [browser] }\n";
		await expect(makeFactory({ config: mixed })).rejects.toThrow(/^config uses removed sections \(workers\); move .*webSearch\.\*\. Also: config uses removed keys \(roles\.reviewer\.extensions\)/);
	});

	test("AQ testing and boat defaults: QA on, sonnet at medium, boat key by reference; a config without qa/boat keys gets them", async () => {
		t = await makeFactory({ config: "version: 1\n" });
		const s = await t.factory.getSettings(G);
		expect(s["qa.enabled"]).toEqual({ value: true, source: "default" });
		expect(s["boat.apiKey"]).toEqual({ value: "env:BOAT_API_KEY", source: "default" });
		expect(s["boat.size"].value).toBe("default");
		expect(s["boat.ttl"].value).toBe("1h");
		expect(s["boat.runScripts"].value).toEqual(["scripts/run.sh", "bin/run"]);
		expect(s["roles.qa.model"]).toEqual({ value: "anthropic/claude-sonnet-5-5", source: "default" });
		expect(s["roles.qa.thinking"].value).toBe("medium");
	});

	test("roles.helper unset takes the builder's effective model and thinking (globally and per project); set, it is its own", async () => {
		t = await makeFactory();
		const f = t.factory;
		await f.createProject("p", "me/p");
		await f.unsetSetting(G, "roles.helper.model");
		let s = await f.getSettings({ project: "p" });
		expect(s["roles.helper.model"]).toEqual({ value: "scripted/builder", source: "default" });
		expect(s["roles.helper.thinking"]).toEqual({ value: "high", source: "default" });
		await f.setSetting({ project: "p" }, "roles.builder.model", "scripted/builder-textonly");
		await f.setSetting({ project: "p" }, "roles.builder.thinking", "low");
		s = await f.getSettings({ project: "p" });
		expect(s["roles.helper.model"].value).toBe("scripted/builder-textonly");
		expect(s["roles.helper.thinking"].value).toBe("low");
		await f.setSetting(G, "roles.helper.model", "scripted/helper");
		s = await f.getSettings({ project: "p" });
		expect(s["roles.helper.model"]).toEqual({ value: "scripted/helper", source: "global" });
		expect(s["roles.helper.thinking"]).toEqual({ value: "low", source: "default" });
	});

	test("discussion.model falls back to the architect's model and thinking; a project override wins", async () => {
		t = await makeFactory();
		const f = t.factory;
		const eff = (s: { global: true } | { project: string }) => f.config.effective(s);
		await f.createProject("p", "me/p");
		// global: roles.architect = { model: scripted/architect, thinking: high }; the test config's discussion model removed
		await f.unsetSetting({ global: true }, "discussion.model.model");
		expect(eff({ global: true }).discussion.model).toEqual({ model: "scripted/architect", thinking: "high" });
		await f.setSetting({ project: "p" }, "discussion.model.model", "scripted/builder");
		expect(eff({ project: "p" }).discussion.model).toEqual({ model: "scripted/builder", thinking: "high" });
		expect((await f.getSettings({ project: "p" }))["discussion.model.model"]).toEqual({ value: "scripted/builder", source: "project" });
	});

	test("discussion.model.model must be a known model; policy.messages cannot list discussant", async () => {
		t = await makeFactory();
		const f = t.factory;
		await expect(f.setSetting({ global: true }, "discussion.model.model", "scripted/nope")).rejects.toThrow(/discussion\.model\.model: .* is not a model/);
		await expect(f.setSetting({ global: true }, "policy.messages", ["discussant"])).rejects.toThrow(/expected one of/);
	});

	test("roles have fixed tool sets", async () => {
		t = await makeFactory();
		expect(Object.keys((t.factory.settingsSchema().roles as any).fields.builder.fields)).toEqual(["model", "thinking"]);
		expect(ROLE_TOOLS.reviewer.map((e) => e.name)).toEqual(["role-reviewer", "coding-readonly", "test-runner", "web-search"]);
		expect(ROLE_TOOLS.helper.map((e) => e.name)).toEqual(["role-helper", "coding", "test-runner", "web-search"]);
		expect(ROLE_TOOLS.qa.map((e) => e.name)).toEqual(["role-qa", "coding-readonly", "computer", "web-search"]);
		expect(ROLE_TOOLS.builder.map((e) => e.name)).toEqual(["role-builder", "coding", "subagent", "test-runner", "web-search"]);
		expect(ROLE_TOOLS.discussant.map((e) => e.name)).toEqual(["role-discussant", "coding-readonly", "web-search"]);
		expect(bridgeToolsNotFor("architect").map((t) => t.name)).toContain("submit_tickets");
		expect(bridgeToolsNotFor("discussant").map((t) => t.name)).not.toContain("submit_tickets");
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

	test("ConfigStore sees external writes and does not clobber them", async () => {
		t = await makeFactory();
		const schema = () => t!.factory.settingsSchema();
		const a = new ConfigStore(t.configPath, schema);
		const b = new ConfigStore(t.configPath, schema);
		a.set(G, "ci.fixRounds", 1);
		expect(b.effective(G).ci.fixRounds).toBe(1);
		b.set(G, "ci.mode", "off");
		const raw = readFileSync(t.configPath, "utf8");
		expect(raw).toMatch(/fixRounds: 1/);
		expect(raw).toMatch(/mode: off/);
		expect(a.effective(G).ci).toMatchObject({ fixRounds: 1, mode: "off" });
	});
});
