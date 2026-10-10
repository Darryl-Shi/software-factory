import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { agentDirOf, createModelHost } from "../src/models/host.ts";
import { DRY_RUN_SCRIPTS } from "../src/testing/dry-run-agents.ts";

const homes: string[] = [];
function tempHome(): string {
	const dir = mkdtempSync(join(tmpdir(), "sf-model-host-"));
	homes.push(dir);
	return dir;
}
afterEach(() => {
	for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function writeModelsJson(factoryHome: string, content: string) {
	const agentDir = agentDirOf(factoryHome);
	mkdirSync(agentDir, { recursive: true, mode: 0o700 });
	writeFileSync(join(agentDir, "models.json"), content);
}

describe("model host", () => {
	it("agentDirOf is <factoryHome>/pi", () => {
		expect(agentDirOf("/x/factory")).toBe(join("/x/factory", "pi"));
	});

	it("empty agentDir has built-ins", async () => {
		const factoryHome = tempHome();
		const host = await createModelHost({ factoryHome });
		expect(host.agentDir).toBe(join(factoryHome, "pi"));
		expect(host.models.getModel("anthropic", "claude-opus-5-5")).toBeDefined();
		expect(existsSync(host.agentDir)).toBe(true);
		expect(statSync(host.agentDir).mode & 0o777).toBe(0o700);
	});

	it("models.json provider resolves", async () => {
		const factoryHome = tempHome();
		writeModelsJson(
			factoryHome,
			JSON.stringify({ providers: { "local-x": { api: "openai-completions", baseUrl: "http://127.0.0.1:9/v1", apiKey: "dummy", models: [{ id: "m" }] } } }),
		);
		const host = await createModelHost({ factoryHome });
		expect(host.models.getModel("local-x", "m")).toBeDefined();
	});

	it("installed package provider resolves", async () => {
		const factoryHome = tempHome();
		const host = await createModelHost({ factoryHome });
		expect(host.models.getModel("sf-fixture", "vision-1")).toBeUndefined();
		await host.packages.installAndPersist(resolve("test/fixtures/provider-package"));
		const fresh = await createModelHost({ factoryHome });
		expect(fresh.models.getModel("sf-fixture", "vision-1")?.input).toContain("image");
		expect(fresh.models.getModel("sf-fixture", "text-1")?.input).toEqual(["text"]);
	});

	it("broken extension is a diagnostic", async () => {
		const factoryHome = tempHome();
		const host = await createModelHost({ factoryHome });
		await host.packages.installAndPersist(resolve("test/fixtures/broken-package"));
		const fresh = await createModelHost({ factoryHome });
		expect(fresh.diagnostics.some((d) => d.type === "error" && d.message.includes("fixture boom"))).toBe(true);
		expect(fresh.models.getModel("anthropic", "claude-opus-5-5")).toBeDefined();
	});

	it("invalid models.json is a diagnostic", async () => {
		const factoryHome = tempHome();
		writeModelsJson(factoryHome, "{nope");
		const host = await createModelHost({ factoryHome });
		expect(host.diagnostics.filter((d) => d.type === "error").length).toBeGreaterThan(0);
		expect(host.models.getModel("anthropic", "claude-opus-5-5")).toBeDefined();
	});

	it("cwd extensions are ignored", async () => {
		const factoryHome = tempHome();
		const piDir = join(process.cwd(), ".pi");
		const extDir = join(piDir, "extensions");
		const file = join(extDir, "sf-leak.ts");
		const createdPi = !existsSync(piDir);
		const createdExt = !existsSync(extDir);
		mkdirSync(extDir, { recursive: true });
		try {
			writeFileSync(
				file,
				`export default function (pi) {
	pi.registerProvider("sf-leak", { baseUrl: "http://127.0.0.1:9/v1", apiKey: "x", api: "openai-completions", models: [{ id: "leak", name: "Leak", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100 }] });
}
`,
			);
			const host = await createModelHost({ factoryHome });
			expect(host.models.getModel("sf-leak", "leak")).toBeUndefined();
			expect(host.models.getProvider("sf-leak")).toBeUndefined();
		} finally {
			rmSync(file, { force: true });
			if (createdExt) rmSync(extDir, { recursive: true, force: true });
			if (createdPi) rmSync(piDir, { recursive: true, force: true });
		}
	});

	it("auth.json credential applies live", async () => {
		const saved = process.env.DEEPSEEK_API_KEY;
		delete process.env.DEEPSEEK_API_KEY;
		try {
			const factoryHome = tempHome();
			const host = await createModelHost({ factoryHome });
			expect((await host.models.checkAuth("deepseek"))?.source).not.toBe("stored credential");
			writeFileSync(join(host.agentDir, "auth.json"), JSON.stringify({ deepseek: { type: "api_key", key: "k" } }), { mode: 0o600 });
			expect((await host.models.checkAuth("deepseek"))?.source).toBe("stored credential");
		} finally {
			if (saved === undefined) delete process.env.DEEPSEEK_API_KEY;
			else process.env.DEEPSEEK_API_KEY = saved;
		}
	});

	it("scripted registers the scripted provider", async () => {
		const factoryHome = tempHome();
		const host = await createModelHost({ factoryHome, scripted: true });
		const id = Object.keys(DRY_RUN_SCRIPTS)[0]!;
		expect(host.models.getModel("scripted", id)).toBeDefined();
		// The host is settled: no background refresh re-creates files once the home is removed.
		rmSync(factoryHome, { recursive: true, force: true });
		await new Promise((r) => setTimeout(r, 300));
		expect(existsSync(factoryHome)).toBe(false);
	});

	it("an existing agentDir is tightened to 0700", async () => {
		const factoryHome = tempHome();
		mkdirSync(agentDirOf(factoryHome), { recursive: true, mode: 0o755 });
		chmodSync(agentDirOf(factoryHome), 0o755);
		const host = await createModelHost({ factoryHome });
		expect(statSync(host.agentDir).mode & 0o777).toBe(0o700);
	});
});
