// Setup sections "qa" and "search" (spec §3.4, §6).
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolveSecret, setDefaultSecretStore } from "../src/core/settings.ts";
import { FactoryError } from "../src/core/types.ts";
import type { SetupContext } from "../src/setup/context.ts";
import { step as qa } from "../src/setup/steps/qa.ts";
import { step as search } from "../src/setup/steps/search.ts";
import { SetupCancelled } from "../src/setup/ui.ts";
import { testContext } from "./setup-context.ts";
import { CANCEL } from "./setup-helpers.ts";

afterEach(() => setDefaultSecretStore(undefined));

const failingBoat = (calls: string[] = []) =>
	({
		limits: async (ref: string) => {
			calls.push(ref);
			throw new Error("401");
		},
	}) as unknown as SetupContext["boat"];

interface Req {
	url: string;
	headers: Record<string, string>;
	body: any;
}

function stubFetch(status = 200, reqs: Req[] = []): typeof fetch {
	return (async (url: any, init: any) => {
		reqs.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
		const body = status === 200 ? { search_id: "s1", results: [{ url: "https://example.com", title: "Example", excerpts: ["x"] }] } : { error: { message: "bad key" } };
		return new Response(JSON.stringify(body), { status });
	}) as typeof fetch;
}

describe("setup qa", () => {
	it("qa key is trimmed, verified against LocalBoatBackend, stored", async () => {
		const { ctx, ui } = testContext({ answers: ["enable", " bk_1 \n"], fakeBoat: true });
		expect((await qa.status(ctx)).state).toBe("missing");
		await qa.run(ctx);
		expect(ctx.secrets.get("boat")).toBe("bk_1");
		const raw = (await ctx.settings()).raw();
		expect(raw.boat.apiKey).toBe("store:boat");
		expect(raw.qa.enabled).toBe(true);
		expect(ui.shown.filter((s) => s.kind === "log.error")).toEqual([]);
		expect(ui.remaining()).toBe(0);
		expect((await qa.status(ctx)).state).toBe("ok");
	});

	it("qa rejects an empty key with required", async () => {
		const { ctx, ui } = testContext({ answers: ["enable", "  ", "bk_2"], fakeBoat: true });
		await qa.run(ctx);
		expect(ui.shown.filter((s) => s.kind === "validate").map((s) => s.message)).toEqual(["required"]);
		expect(ctx.secrets.get("boat")).toBe("bk_2");
	});

	it("qa off writes qa.enabled false", async () => {
		const { ctx, ui } = testContext({ answers: ["off"], fakeBoat: true });
		await qa.run(ctx);
		const raw = (await ctx.settings()).raw();
		expect(raw.qa.enabled).toBe(false);
		expect(raw.boat).toBeUndefined();
		expect(ctx.secrets.keys()).toEqual([]);
		expect(ui.shown.some((s) => s.kind === "note" && /project overrides may still turn it on/.test(s.body ?? ""))).toBe(true);
		expect((await qa.status(ctx)).state).toBe("ok");
	});

	it("qa off shows no off note when the save fails", async () => {
		const { ctx, ui } = testContext({ answers: ["off"], fakeBoat: true });
		const cfg = await ctx.settings();
		cfg.set = () => {
			throw new FactoryError("invalid", "qa.enabled: rejected");
		};
		await qa.run(ctx);
		expect(ui.shown.filter((s) => s.kind === "log.error").map((s) => s.message)).toEqual(["qa.enabled: rejected"]);
		expect(ui.shown.filter((s) => s.kind === "note")).toEqual([]);
	});

	it("qa verify failure + skip writes nothing", async () => {
		const { ctx, ui } = testContext({ answers: ["enable", "bk_1", "skip"], boat: failingBoat() });
		await qa.run(ctx);
		expect(ctx.secrets.get("boat")).toBeUndefined();
		const raw = (await ctx.settings()).raw();
		expect(raw.boat).toBeUndefined();
		expect(raw.qa).toBeUndefined();
		expect(ui.shown.find((s) => s.kind === "select" && s.options?.join() === "retry,save,skip")).toBeTruthy();
		expect(ui.shown.some((s) => s.kind === "log.error" && /401/.test(s.message))).toBe(true);
		expect(ui.remaining()).toBe(0);
	});

	it("qa verify failure + retry re-prompts the key, + save anyway stores it", async () => {
		const { ctx, ui } = testContext({ answers: ["enable", "bk_1", "retry", "bk_2", "save"], boat: failingBoat() });
		await qa.run(ctx);
		expect(ctx.secrets.get("boat")).toBe("bk_2");
		const raw = (await ctx.settings()).raw();
		expect(raw.boat.apiKey).toBe("store:boat");
		expect(raw.qa.enabled).toBe(true);
		expect(ui.remaining()).toBe(0);
	});

	it("qa offers env:BOAT_API_KEY only when it is set, and verifies it", async () => {
		const calls: string[] = [];
		const a = testContext({ answers: [(o: any) => (expect(o.options.map((x: any) => x.value)).toEqual(["enable", "off"]), "off")], fakeBoat: true });
		await qa.run(a.ctx);
		const b = testContext({ answers: ["env", "skip"], env: { BOAT_API_KEY: "bk_env" }, boat: failingBoat(calls) });
		await qa.run(b.ctx);
		expect(calls).toEqual(["env:BOAT_API_KEY"]);
		expect((await b.ctx.settings()).raw().boat).toBeUndefined();
		const c = testContext({ answers: ["env"], env: { BOAT_API_KEY: "bk_env" }, fakeBoat: true });
		await qa.run(c.ctx);
		const raw = (await c.ctx.settings()).raw();
		expect(raw.boat.apiKey).toBe("env:BOAT_API_KEY");
		expect(raw.qa.enabled).toBe(true);
		expect(c.ctx.secrets.keys()).toEqual([]);
	});
});

describe("setup search", () => {
	it("search paste + test search hits the stub endpoint with x-api-key", async () => {
		const reqs: Req[] = [];
		const { ctx, ui } = testContext({ answers: ["paste", " pk_1\n", true], fetch: stubFetch(200, reqs) });
		expect((await search.status(ctx)).state).toBe("warn");
		await search.run(ctx);
		expect(reqs).toHaveLength(1);
		expect(reqs[0]!.headers["x-api-key"]).toBe("pk_1");
		expect(reqs[0]!.body.advanced_settings.max_results).toBe(1);
		expect(reqs[0]!.body.objective).toBe("factory setup connectivity check");
		expect(reqs[0]!.body.search_queries).toEqual(["parallel web search"]);
		expect(ui.shown.find((s) => s.kind === "confirm")?.message).toBe("Run one test search (billed)?");
		expect(ctx.secrets.get("parallel")).toBe("pk_1");
		expect((await ctx.settings()).raw().webSearch.apiKey).toBe("store:parallel");
		expect(ui.remaining()).toBe(0);
		expect((await search.status(ctx)).state).toBe("ok");
	});

	it("search paste without a test search saves the key", async () => {
		const { ctx } = testContext({ answers: ["paste", "pk_1", false] });
		await search.run(ctx);
		expect(ctx.secrets.get("parallel")).toBe("pk_1");
		expect((await ctx.settings()).raw().webSearch.apiKey).toBe("store:parallel");
	});

	it("search skip writes nothing", async () => {
		const { ctx, ui } = testContext({ answers: ["skip"] });
		await search.run(ctx);
		expect(ctx.secrets.keys()).toEqual([]);
		expect((await ctx.settings()).raw().webSearch).toBeUndefined();
		expect(ui.remaining()).toBe(0);
	});

	it("search test failure + skip writes nothing and keeps an earlier key", async () => {
		const { ctx, ui } = testContext({ answers: ["paste", "pk_bad", true, "skip"], fetch: stubFetch(401) });
		ctx.secrets.set("parallel", "pk_old");
		await search.run(ctx);
		expect(ctx.secrets.get("parallel")).toBe("pk_old");
		expect((await ctx.settings()).raw().webSearch).toBeUndefined();
		expect(ui.shown.some((s) => s.kind === "log.error" && /HTTP 401/.test(s.message))).toBe(true);
		const fresh = testContext({ answers: ["paste", "pk_bad", true, "skip"], fetch: stubFetch(401) });
		await search.run(fresh.ctx);
		expect(fresh.ctx.secrets.keys()).toEqual([]);
	});

	it("search cancel after a failed test search writes nothing", async () => {
		const { ctx } = testContext({ answers: ["paste", "pk_bad", true, CANCEL], fetch: stubFetch(401) });
		await expect(search.run(ctx)).rejects.toBeInstanceOf(SetupCancelled);
		expect(ctx.secrets.keys()).toEqual([]);
		expect((await ctx.settings()).raw().webSearch).toBeUndefined();
		const prior = testContext({ answers: ["paste", "pk_bad", true, CANCEL], fetch: stubFetch(401) });
		prior.ctx.secrets.set("parallel", "pk_old");
		await expect(search.run(prior.ctx)).rejects.toBeInstanceOf(SetupCancelled);
		expect(prior.ctx.secrets.get("parallel")).toBe("pk_old");
	});

	it("search never writes the candidate key to secrets.json before the user commits", async () => {
		let onDisk: string | undefined = "unread";
		let duringFetch: string | undefined;
		const inner = stubFetch(200);
		const probe = (async (url: any, init: any) => {
			onDisk = existsSync(path) ? readFileSync(path, "utf8") : undefined;
			duringFetch = resolveSecret("store:parallel");
			return inner(url, init);
		}) as typeof fetch;
		const { ctx } = testContext({ answers: ["paste", "pk_new", true], fetch: probe });
		ctx.secrets.set("parallel", "pk_old");
		const path = ctx.secrets.path;
		await search.run(ctx);
		expect(duringFetch).toBe("pk_new");
		expect(onDisk).toContain("pk_old");
		expect(onDisk).not.toContain("pk_new");
		// After the search the process default store is the real one again, and the committed key is on disk.
		expect(resolveSecret("store:parallel")).toBe("pk_new");
		expect(ctx.secrets.get("parallel")).toBe("pk_new");
	});

	it("search test failure + save anyway stores the key", async () => {
		const { ctx } = testContext({ answers: ["paste", "pk_bad", true, "save"], fetch: stubFetch(401) });
		await search.run(ctx);
		expect(ctx.secrets.get("parallel")).toBe("pk_bad");
		expect((await ctx.settings()).raw().webSearch.apiKey).toBe("store:parallel");
	});

	it("search offers env:PARALLEL_API_KEY when it is set", async () => {
		const reqs: Req[] = [];
		const { ctx } = testContext({
			answers: [(o: any) => (expect(o.options.map((x: any) => x.value)).toEqual(["paste", "env", "skip"]), "env"), true],
			env: { PARALLEL_API_KEY: "pk_env" },
			fetch: stubFetch(200, reqs),
		});
		await search.run(ctx);
		expect(reqs[0]!.headers["x-api-key"]).toBe("pk_env");
		expect((await ctx.settings()).raw().webSearch.apiKey).toBe("env:PARALLEL_API_KEY");
		expect(ctx.secrets.keys()).toEqual([]);
	});
});
