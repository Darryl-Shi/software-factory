// Bundles (bundles spec §2, §3): Ready runs shipped as one PR. Every bundle state transition, conflicts resolved by the
// integrator then reviewed, CI red → fix → review, a moved default branch at Merge, external merge and close, drop and
// cancel releasing runs, and a new repo pushed to main.
import { afterEach, describe, expect, test } from "vitest";
import type { BundleView, FactoryEvent, RunView } from "../src/core/types.ts";
import { git } from "../src/github/git.ts";
import { bundleIn, inState, makeFactory, type TestEnv, until, untilBundle } from "./helpers.ts";

let t: TestEnv | undefined;
afterEach(async () => {
	await t?.factory.close().catch(() => {});
	t = undefined;
});

const states = (v: { history: { to: string }[] }) => v.history.map((h) => h.to);
const SEED = { "README.md": "# p\n", "AGENTS.md": "Test: true\n" };
const CI_OK = "name: ci\non: [push]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: test -f README.md\n";

async function setup(settings: [string, unknown][] = [], opts: { seed?: Record<string, string> | false; repo?: string } = {}) {
	t = await makeFactory();
	const repo = opts.repo ?? "me/p";
	if (opts.seed !== false) await t.host.seedRepo(repo, opts.seed ?? SEED);
	await t.factory.createProject("p", repo);
	for (const [path, value] of settings) await t.factory.setSetting({ project: "p" }, path, value);
	return t;
}
const start = (title: string, project = "p") => t!.factory.startRun(project, { source: "test", title, body: `make ${title}` });
const ready = (run: string) => until(t!.factory, run, inState("READY", "FAILED", "CANCELLED"));
async function remoteFile(ref: string, path: string, repo = "me/p") {
	const r = await git(t!.host.bare(repo), ["show", `${ref}:${path}`], { allowFail: true });
	return r.code === 0 ? r.stdout : undefined;
}
const waitMerge = (id: string) => untilBundle(t!.factory, id, (v) => (v.state === "AWAITING_MERGE" && !!v.pendingAsk) || ["MERGED", "FAILED", "CANCELLED", "ESCALATED"].includes(v.state));

async function twoReady(settings: [string, unknown][] = [], opts: { seed?: Record<string, string> | false } = {}) {
	await setup(settings, opts);
	const a = await start("alpha");
	const b = await start("beta");
	const [ra, rb] = await Promise.all([ready(a), ready(b)]);
	expect(ra.state).toBe("READY");
	expect(rb.state).toBe("READY");
	return { a, b, ra, rb };
}

describe("runs stop at Ready", () => {
	test("two tickets in parallel: each stops in READY with its branch pushed, its spec at docs/specs/<run-id>.md, and no PR", async () => {
		const { a, b, ra, rb } = await twoReady();
		expect(states(ra)).toEqual(["RECEIVED", "PREPARING", "DISCUSSING", "SPEC_READY", "BUILDING", "REVIEWING", "DELIVERING", "READY"]);
		expect(ra.specPath).toBe(`docs/specs/${a}.md`);
		expect(rb.specPath).toBe(`docs/specs/${b}.md`);
		expect(await remoteFile(`factory/${a}`, `docs/specs/${a}.md`)).toContain("Acceptance behaviours");
		expect(await remoteFile(`factory/${b}`, `docs/specs/${b}.md`)).toContain("Acceptance behaviours");
		expect(await remoteFile(`factory/${a}`, "docs/spec.md")).toBeUndefined();
		expect(t!.host.state().prs).toEqual([]);
		expect(ra.artifacts.delivery).toBeUndefined();
		expect(t!.control.builderInputs[0]).toContain(`docs/specs/`);
	});
});

describe("bundle of two, clean merge", () => {
	test("INTEGRATING → DELIVERING → AWAITING_CI → AWAITING_MERGE → MERGED: one PR, a section per ticket, no bundle review; both runs DELIVERED with the PR", async () => {
		const { a, b } = await twoReady([["bundle.mergeMethod", "merge"]]);
		const events: FactoryEvent[] = [];
		t!.factory.subscribe({ project: "p" }, (e) => events.push(e));
		const id = await t!.factory.createBundle("p", [a, b]);
		expect(id).toBe("bundle-1");
		expect((await t!.factory.getRun(a)).bundle).toBe(id);
		let v = await waitMerge(id);
		expect(v.state).toBe("AWAITING_MERGE");
		expect(states(v)).toEqual(["INTEGRATING", "DELIVERING", "AWAITING_CI", "AWAITING_MERGE"]);
		expect(v.reviews).toEqual([]);
		expect(v.members.map((m) => m.run)).toEqual([a, b]);
		expect(v.noCi).toBe(true);
		const prs = t!.host.state().prs;
		expect(prs.length).toBe(1);
		expect(prs[0]!.title).toBe("2 tickets: alpha, beta");
		expect(prs[0]!.body).toContain("## Ticket: alpha");
		expect(prs[0]!.body).toContain("## Ticket: beta");
		expect(prs[0]!.body).toContain(`docs/specs/${a}.md`);
		expect(prs[0]!.body).toContain("## Integration");
		await t!.factory.mergeBundle(id);
		v = await untilBundle(t!.factory, id, bundleIn("MERGED", "FAILED"));
		expect(v.state).toBe("MERGED");
		expect(t!.host.state().calls.find((c) => c.op === "mergePr")?.detail).toMatchObject({ how: "merge" });
		const [da, db] = await Promise.all([until(t!.factory, a, inState("DELIVERED")), until(t!.factory, b, inState("DELIVERED"))]);
		expect(da.artifacts.delivery?.url).toBe(v.delivery!.url);
		expect(db.artifacts.delivery?.url).toBe(v.delivery!.url);
		expect(da.bundle).toBe(id);
		expect(da.notices.at(-1)!.text).toBe(`Merged in ${id}: ${v.delivery!.url}`);
		expect(await remoteFile("main", `docs/specs/${a}.md`)).toBeDefined();
		expect(await remoteFile("main", `docs/specs/${b}.md`)).toBeDefined();
		expect(events.some((e) => e.type === "bundle.state" && e.to === "MERGED")).toBe(true);
		expect(events.some((e) => e.type === "bundle.ask")).toBe(true);
		expect(events.some((e) => e.type === "run.state" && e.run === a && e.to === "DELIVERED")).toBe(true);
	});
});
