// The `web-search` agent tool: the request it sends to Parallel's Search API, how results reach the agent,
// failures, and a live run where the architect searches with the run's pinned `webSearch` settings.
import { createServer, type IncomingMessage, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { parallelSearch } from "../src/agents/web-search.ts";
import { coreSchema } from "../src/core/settings.ts";
import { ROLE_TOOLS } from "../src/agents/tools.ts";
import { inState, makeFactory, type TestEnv, until } from "./helpers.ts";

let t: TestEnv | undefined;
let server: Server | undefined;
const seen: { headers: IncomingMessage["headers"]; body: any; path: string }[] = [];
let reply: { status: number; body: unknown } = { status: 200, body: {} };
let endpoint = "";

const RESULTS = {
	search_id: "search_123",
	results: [
		{ url: "https://nodejs.org/en/learn/hello", title: "Hello world in Node.js", publish_date: "2025-03-01", excerpts: ["console.log prints to stdout.", "Use process.argv for arguments."] },
		{ url: "https://example.com/cli", title: null, excerpts: [] },
	],
	warnings: [{ type: "warning", message: "one query was shortened" }],
};

beforeEach(async () => {
	seen.length = 0;
	reply = { status: 200, body: RESULTS };
	process.env.SF_TEST_PARALLEL_KEY = "pk-test-123";
	server = createServer((req, res) => {
		let raw = "";
		req.on("data", (c) => (raw += c));
		req.on("end", () => {
			seen.push({ headers: req.headers, body: JSON.parse(raw || "{}"), path: req.url ?? "" });
			res.writeHead(reply.status, { "content-type": "application/json" });
			res.end(JSON.stringify(reply.body));
		});
	});
	await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
	endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/search`;
});
afterEach(async () => {
	await t?.factory.close().catch(() => {});
	t = undefined;
	await new Promise((r) => server?.close(r));
	delete process.env.SF_TEST_PARALLEL_KEY;
});

const settings = (over: Record<string, unknown> = {}) => ({ apiKey: "env:SF_TEST_PARALLEL_KEY", endpoint, ...over });

describe("parallelSearch", () => {
	test("one POST with the objective, the queries and fast mode; the key goes in x-api-key", async () => {
		const out = await parallelSearch({ objective: "How do CLIs print hello?", queries: ["  print hello cli ", "", "hello world node"] }, settings({ maxResults: 3 }), { sessionId: "run-1" });
		expect(seen).toHaveLength(1);
		expect(seen[0]!.path).toBe("/v1/search");
		expect(seen[0]!.headers["x-api-key"]).toBe("pk-test-123");
		expect(seen[0]!.body).toEqual({
			objective: "How do CLIs print hello?",
			search_queries: ["print hello cli", "hello world node"],
			mode: "fast",
			session_id: "run-1",
			advanced_settings: { max_results: 3 },
		});
		expect(out.details).toEqual({ searchId: "search_123", mode: "fast", count: 2 });
		expect(out.text).toContain("2 results (fast) for: How do CLIs print hello?");
		expect(out.text).toContain("1. Hello world in Node.js\n   https://nodejs.org/en/learn/hello · 2025-03-01\n   console.log prints to stdout.");
		expect(out.text).toContain("2. https://example.com/cli");
		expect(out.text).toContain("Warnings: one query was shortened");
	});

	test("defaults: fast mode and 10 results; an unknown mode falls back to fast; at most 5 queries", async () => {
		expect((coreSchema().webSearch as any).fields.mode).toMatchObject({ default: "fast" });
		expect((coreSchema().webSearch as any).fields.apiKey).toMatchObject({ type: "secretRef", default: "env:PARALLEL_API_KEY" });
		await parallelSearch({ objective: "x", queries: ["a", "b", "c", "d", "e", "f", "g"] }, settings({ mode: "warp", maxCharsTotal: 5000 }));
		expect(seen[0]!.body).toMatchObject({ mode: "fast", search_queries: ["a", "b", "c", "d", "e"], max_chars_total: 5000, advanced_settings: { max_results: 10 } });
		await parallelSearch({ objective: "only an objective", queries: [] }, settings({ mode: "advanced" }));
		expect(seen[1]!.body).toMatchObject({ mode: "advanced", search_queries: ["only an objective"] });
	});

	test("failures say what went wrong: no key, an HTTP error with the API's message, empty input", async () => {
		await expect(parallelSearch({ objective: "x", queries: ["y"] }, settings({ apiKey: "env:SF_TEST_NO_SUCH_KEY" }))).rejects.toThrow(/not configured: no API key at env:SF_TEST_NO_SUCH_KEY/);
		expect(seen).toHaveLength(0);
		reply = { status: 422, body: { error: { message: "search_queries: too long" } } };
		await expect(parallelSearch({ objective: "x", queries: ["y"] }, settings())).rejects.toThrow("Parallel search failed (HTTP 422): search_queries: too long");
		await expect(parallelSearch({ objective: " ", queries: [] }, settings())).rejects.toThrow(/needs an objective/);
	});
});

describe("in a run", () => {
	test("web_search is on for every role and uses the run's pinned webSearch settings", async () => {
		t = await makeFactory();
		const G = { global: true } as const;
		const eff = await t.factory.getSettings(G);
		expect(eff["webSearch.mode"]).toEqual({ value: "fast", source: "default" });
		for (const role of ["architect", "builder", "helper", "reviewer"] as const) expect(ROLE_TOOLS[role].map((e) => e.name)).toContain("web-search");
		await t.factory.setSetting(G, "webSearch", { endpoint, apiKey: "env:SF_TEST_PARALLEL_KEY" });
		await t.factory.setSetting(G, "webSearch.maxResults", 4);
		await expect(t.factory.setSetting(G, "webSearch.mode", "warp")).rejects.toMatchObject({ code: "invalid" });
		await t.factory.createProject("p", "me/p");
		t.control.searchFirst = true;
		const run = await t.factory.startRun("p", { source: "test", title: "hello", body: "make hello" });
		const v = await until(t.factory, run, inState("DELIVERED", "FAILED"));
		expect(v.state).toBe("DELIVERED");
		expect(seen).toHaveLength(1);
		expect(seen[0]!.body).toMatchObject({ mode: "fast", session_id: run, advanced_settings: { max_results: 4 }, search_queries: ["print hello cli", "hello world node"] });
		expect(t.control.searchResults[0]).toContain("1. Hello world in Node.js");
		const tv = await t.factory.getConversation(run, v.conversations.architect!);
		expect(tv.items.find((x) => x.toolResult?.name === "web_search")?.toolResult).toMatchObject({ isError: false, details: { searchId: "search_123", mode: "fast", count: 2 } });
	});
});
