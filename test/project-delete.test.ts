// Deleting a project (docs/specs/run-mv86f7vs-jif2.md): refused while live (A1); otherwise one commit retires every
// Document of the project's runs, bundles and discussions, the config block goes, `project.deleted` is emitted and the
// disk is cleaned in the background; interrupted deletions are finished by the startup sweep / gc. Acceptance 1-7.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import YAML from "yaml";
import { git } from "../src/github/git.ts";
import { ownerOfEnvName } from "../src/core/cleanup.ts";
import type { FactoryEvent } from "../src/core/types.ts";
import { startWebServer } from "../src/web/server.ts";
import { bundleIn, inState, makeFactory, shipAndMerge, type TestEnv, until, untilBundle, untilDiscussion } from "./helpers.ts";
import { readdirSync } from "node:fs";

let t: TestEnv | undefined;
afterEach(async () => {
	vi.restoreAllMocks();
	await t?.factory.cleanupsSettledForTests().catch(() => {});
	await t?.factory.close().catch(() => {});
	t = undefined;
});

const SEED = { "README.md": "# p\n", "AGENTS.md": "Test: true\n" };
let logs: string[] = [];
const f = () => t!.factory;

async function setup(opts: { storage?: "memory" | "sqlite" } = {}) {
	logs = [];
	t = await makeFactory({ storage: opts.storage, log: (m) => logs.push(m) });
	await t.host.seedRepo("me/p", SEED);
	await t.factory.createProject("p", "me/p");
	return t;
}
const start = (title: string, project = "p") => f().startRun(project, { source: "test", title, body: `make ${title}` });
const settled = (run: string) => until(f(), run, inState("READY", "FAILED", "CANCELLED", "DELIVERED"));
const config = () => YAML.parse(readFileSync(t!.configPath, "utf8"));
const AREA = (id: string) => (id.startsWith("run-") ? "runs" : id.startsWith("bundle-") ? "bundles" : "discussions");
const branchOn = async (dir: string, id: string) => existsSync(dir) && (await git(dir, ["rev-parse", "--verify", "-q", `refs/heads/factory/${id}`], { allowFail: true })).code === 0;

/** What is on disk of an owner. */
async function things(id: string) {
	const work = join(t!.dir, "work");
	const scratchDir = join(work, "scratch");
	const envDir = join(t!.dir, "state", "environments");
	return {
		worktree: existsSync(join(work, AREA(id), id)),
		manifest: existsSync(join(work, AREA(id), `${id}.json`)),
		local: await branchOn(join(work, "repos", "me__p"), id),
		remote: await branchOn(t!.host.bare("me/p"), id),
		scratch: existsSync(scratchDir) ? readdirSync(scratchDir).filter((n) => ownerOfEnvName(n) === id) : [],
		env: existsSync(envDir) ? readdirSync(envDir).filter((n) => ownerOfEnvName(n.replace(/\.json$/, "")) === id) : [],
		artifacts: existsSync(join(t!.dir, "state", "artifacts", id)),
	};
}
const GONE = { worktree: false, manifest: false, local: false, remote: false, scratch: [], env: [], artifacts: false };

/** A fake QA screenshot of an owner (as the QA flow stores them). */
function screenshot(id: string) {
	const dir = join(t!.dir, "state", "artifacts", id, "screenshots");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "r1-s1.png"), "png");
}

describe("deleteProject", () => {
	test("checks: invalid name, unknown project", async () => {
		await setup();
		await expect(f().deleteProject("" as never)).rejects.toMatchObject({ code: "invalid" });
		await expect(f().deleteProject(3 as never)).rejects.toMatchObject({ code: "invalid" });
		await expect(f().deleteProject("nope")).rejects.toMatchObject({ code: "not_found" });
	});

	test("1-4, 6: refused while live (409 over HTTP, nothing changes); then purged: views 404, config gone, disk cleaned, GitHub kept; the name starts fresh", async () => {
		await setup();
		await t!.host.seedRepo("me/q", SEED);
		await f().createProject("q", "me/q");
		await f().setSetting({ project: "q" }, "ci.fixRounds", 1);
		await f().setSetting({ project: "p" }, "ci.fixRounds", 2);
		// a delivered ticket (bundle-1 MERGED, its PR merged)
		const c = await start("gamma");
		expect((await shipAndMerge(f(), c)).state).toBe("DELIVERED");
		await f().cleanupsSettledForTests();
		// two READY runs in a FAILED bundle (bundle-2), an OPEN discussion
		t!.control.sharedFile = true;
		const a = await start("alpha");
		const b = await start("beta");
		await Promise.all([settled(a), settled(b)]);
		t!.control.integratorPlan = ["leave", "abort", "leave"];
		const bundle = await f().createBundle("p", [a, b]);
		expect((await untilBundle(f(), bundle, bundleIn("FAILED", "AWAITING_MERGE"))).state).toBe("FAILED");
		const disc = await f().startDiscussion("p", { title: "t", message: "m" });
		await untilDiscussion(f(), disc, (v) => v.state === "OPEN" && !v.turn);
		screenshot(a);
		const prsBefore = t!.host.state().prs.length;
		expect(prsBefore).toBeGreaterThan(0);
		const configBefore = readFileSync(t!.configPath, "utf8");

		// 1. refused, naming every live item
		const err = await f().deleteProject("p").catch((e) => e);
		expect(err).toMatchObject({ code: "conflict" });
		expect(err.message).toContain(`${a} is READY`);
		expect(err.message).toContain(`${bundle} is FAILED`);
		expect(err.message).toContain(`${disc} is OPEN`);
		expect(err.details.live).toEqual(
			expect.arrayContaining([
				{ kind: "run", id: a, state: "READY" },
				{ kind: "run", id: b, state: "READY" },
				{ kind: "bundle", id: bundle, state: "FAILED" },
				{ kind: "discussion", id: disc, state: "OPEN" },
			]),
		);
		expect(err.details.live).toHaveLength(4);
		const { url, stop } = await startWebServer(f().as("web"), { host: "127.0.0.1", port: 0, tokenFile: join(t!.dir, "home", "web-token") });
		try {
			const u = new URL(url);
			const res = await fetch(new URL("/api/op/deleteProject", u.origin), {
				method: "POST",
				headers: { authorization: `Bearer ${u.searchParams.get("token")}`, "content-type": "application/json" },
				body: JSON.stringify({ args: ["p"] }),
			});
			expect(res.status).toBe(409);
			const body = (await res.json()) as any;
			expect(body).toMatchObject({ ok: false, code: "conflict" });
			expect(body.details.live).toHaveLength(4);
		} finally {
			await stop();
		}
		expect(readFileSync(t!.configPath, "utf8")).toBe(configBefore);
		expect((await f().getRun(a)).state).toBe("READY");
		expect((await f().getBundle(bundle)).state).toBe("FAILED");
		expect((await f().getDiscussion(disc)).state).toBe("OPEN");
		expect(await things(a)).toMatchObject({ worktree: true, remote: true, artifacts: true });

		// 2. cancel and close everything, then delete
		await f().cancelBundle(bundle);
		await untilBundle(f(), bundle, bundleIn("CANCELLED"));
		await f().cancelRuns([a, b]);
		await Promise.all([until(f(), a, inState("CANCELLED")), until(f(), b, inState("CANCELLED"))]);
		await f().closeDiscussion(disc);
		await untilDiscussion(f(), disc, (v) => v.state === "CLOSED");
		await f().cleanupsSettledForTests();
		expect((await things(a)).remote).toBe(true); // a cancelled, uncleared run keeps its branch until now
		const runView = await f().getRun(a);
		const conv = runView.conversations.builder!;
		const discConv = (await f().getDiscussion(disc)).conversationId;
		expect(discConv).toBeDefined();
		const all: FactoryEvent[] = [];
		const mine: FactoryEvent[] = [];
		const other: FactoryEvent[] = [];
		f().subscribe({}, (e) => all.push(e));
		f().subscribe({ project: "p" }, (e) => mine.push(e));
		f().subscribe({ project: "q" }, (e) => other.push(e));
		const r = await f().deleteProject("p");
		expect(r.project).toBe("p");
		expect(r.runs.sort()).toEqual([a, b, c].sort());
		expect(r.bundles.sort()).toEqual(["bundle-1", bundle].sort());
		expect(r.discussions).toEqual([disc]);
		const ev = { type: "project.deleted", ...r };
		expect(all).toContainEqual(ev);
		expect(mine).toContainEqual(ev);
		expect(other.filter((e) => e.type === "project.deleted")).toEqual([]);
		await f().cleanupsSettledForTests();

		// 3. not found everywhere
		await expect(f().getProject("p")).rejects.toMatchObject({ code: "not_found" });
		await expect(f().getSettings({ project: "p" })).rejects.toMatchObject({ code: "not_found" });
		expect((await f().listProjects()).map((p) => p.name)).toEqual(["q"]);
		for (const id of r.runs) {
			await expect(f().getRun(id)).rejects.toMatchObject({ code: "not_found" });
		}
		await expect(f().getConversation(a, conv)).rejects.toMatchObject({ code: "not_found" });
		await expect(f().getScreenshot(a, "r1-s1")).rejects.toMatchObject({ code: "not_found" });
		for (const id of r.bundles) await expect(f().getBundle(id)).rejects.toMatchObject({ code: "not_found" });
		await expect(f().getDiscussion(disc)).rejects.toMatchObject({ code: "not_found" });
		await expect(f().getDiscussionConversation(disc)).rejects.toMatchObject({ code: "not_found" });
		expect(await f().listRuns({ includeCleared: true })).toEqual([]);
		expect(await f().listBundles()).toEqual([]);
		expect(await f().listDiscussions()).toEqual([]);
		const cfg = config();
		expect(cfg.projects.p).toBeUndefined();
		expect(cfg.projects.q).toEqual({ repo: "me/q", ci: { fixRounds: 1 } });
		expect((await f().getSettings({ project: "q" }))["ci.fixRounds"]).toEqual({ value: 1, source: "project" });

		// 4. disk and GitHub
		for (const id of [...r.runs, ...r.bundles, ...r.discussions]) expect(await things(id), id).toEqual(GONE);
		expect(existsSync(join(t!.dir, "work", "repos", "me__p"))).toBe(false);
		expect(t!.host.state().prs.length).toBe(prsBefore);
		expect((await git(t!.host.bare("me/p"), ["rev-parse", "--verify", "-q", "refs/heads/main"], { allowFail: true })).code).toBe(0);
		expect(await f().projectDeletionsForTests()).toEqual([]);

		// 6. the same name starts fresh; ids are never reused
		await f().createProject("p", "me/p");
		const settings = await f().getSettings({ project: "p" });
		expect(Object.values(settings).some((s) => s.source === "project")).toBe(false);
		expect(await f().listDiscussions({ project: "p" })).toEqual([]);
		const fresh = await start("fresh");
		expect((f() as any).ticketKey(await f().runDocument(fresh))).toBe("P-1");
		const d2 = await f().startDiscussion("p", { title: "t2", message: "m" });
		expect(d2).toBe("disc-2");
		t!.control.sharedFile = false;
		expect((await settled(fresh)).state).toBe("READY");
		const b3 = await f().createBundle("p", [fresh]);
		expect(b3).toBe("bundle-3");
		await untilDiscussion(f(), d2, (v) => v.state === "OPEN" && !v.turn);
		await untilBundle(f(), b3, (v) => (v.state === "AWAITING_MERGE" && !!v.pendingAsk) || ["MERGED", "FAILED", "CANCELLED", "ESCALATED"].includes(v.state));
	});

	test("4: the shared clone stays when another project binds the same repo; that project still works", async () => {
		await setup();
		await f().createProject("r", "me/p");
		const a = await start("alpha");
		await settled(a);
		await f().cancelRun(a);
		await until(f(), a, inState("CANCELLED"));
		const other = await start("beta", "r");
		await settled(other);
		await f().cancelRun(other);
		await until(f(), other, inState("CANCELLED"));
		await f().cleanupsSettledForTests();
		await f().deleteProject("p");
		await f().cleanupsSettledForTests();
		expect(await things(a)).toEqual(GONE);
		const clone = join(t!.dir, "work", "repos", "me__p");
		expect(existsSync(join(clone, ".git"))).toBe(true);
		expect(await branchOn(clone, other)).toBe(true); // r's branches stay
		expect(logs.some((l) => l.includes("the shared clone of me/p stays"))).toBe(true);
		const again = await start("gamma", "r");
		expect((await settled(again)).state).toBe("READY");
	});

	test("5: killed right after the purge commit, the startup sweep finishes the deletion; a second gc removes nothing", async () => {
		await setup({ storage: "sqlite" });
		const a = await start("alpha");
		await settled(a);
		await f().cancelRun(a);
		await until(f(), a, inState("CANCELLED"));
		const disc = await f().startDiscussion("p", { title: "t", message: "m" });
		await untilDiscussion(f(), disc, (v) => v.state === "OPEN" && !v.turn);
		await f().closeDiscussion(disc);
		await f().cleanupsSettledForTests();
		screenshot(a);
		expect((await things(a)).worktree).toBe(true);
		f().haltDeletionAfterCommitForTests = true;
		const r = await f().deleteProject("p");
		expect(r.runs).toEqual([a]);
		// "kill -9": nothing after the commit happened
		expect(config().projects.p).toBeDefined();
		expect((await things(a)).worktree).toBe(true);
		expect(await f().projectDeletionsForTests()).toMatchObject([{ project: "p", configRemoved: false, owners: [{ id: a }, { id: disc }] }]);
		await f().close();
		logs = [];
		await t!.reopen();
		// the config removal is finished before the factory serves
		expect(config().projects?.p).toBeUndefined();
		await expect(f().getProject("p")).rejects.toMatchObject({ code: "not_found" });
		await f().cleanupsSettledForTests();
		expect(await things(a)).toEqual(GONE);
		expect(await things(disc)).toEqual(GONE);
		expect(existsSync(join(t!.dir, "work", "repos", "me__p"))).toBe(false);
		expect(await f().projectDeletionsForTests()).toEqual([]);
		await expect(f().getRun(a)).rejects.toMatchObject({ code: "not_found" });
		expect(await f().listRuns({ includeCleared: true })).toEqual([]);
		const summary = logs.find((l) => l.startsWith("disk sweep: removed"))!;
		expect(summary).not.toMatch(/^disk sweep: removed 0 items/);
		const gc = await f().gc();
		expect(gc.removed).toEqual([]);
		expect(gc.failures).toEqual([]);
	});

	test("7: startRun / startDiscussion / setSetting during a deletion wait for it and then fail with not_found", async () => {
		await setup();
		const a = await start("alpha");
		await settled(a);
		await f().cancelRun(a);
		await until(f(), a, inState("CANCELLED"));
		const deleting = f().deleteProject("p");
		const run = start("late");
		const disc = f().startDiscussion("p", { title: "t", message: "m" });
		const set = f().setSetting({ project: "p" }, "ci.fixRounds", 3);
		await deleting;
		await expect(run).rejects.toMatchObject({ code: "not_found" });
		await expect(disc).rejects.toMatchObject({ code: "not_found" });
		await expect(set).rejects.toMatchObject({ code: "not_found" });
		expect(await f().listRuns({ includeCleared: true })).toEqual([]);
		expect(await f().listDiscussions()).toEqual([]);
		expect(config().projects?.p).toBeUndefined();
	});

	test("a conflict found inside the commit (work started meanwhile) aborts with nothing changed", async () => {
		await setup();
		const a = await start("alpha");
		await settled(a);
		await f().cancelRun(a);
		await until(f(), a, inState("CANCELLED"));
		// a run created behind the lock's back (as if by another path) between the check and the commit
		const orig = (f() as any).purgeCommit.bind(f());
		let late: string | undefined;
		vi.spyOn(f() as any, "purgeCommit").mockImplementation(async (...args: unknown[]) => {
			late = await (f() as any).root.commit(async (tx: any) => (f() as any).createRunIn(tx, "p", { source: "test", title: "late", body: "x" }, "test"), (f() as any).ctx).then(() => "made");
			return orig(...args);
		});
		await expect(f().deleteProject("p")).rejects.toMatchObject({ code: "conflict" });
		expect(late).toBe("made");
		expect((await f().listRuns()).length).toBe(2);
		expect(config().projects.p).toBeDefined();
		expect(await f().projectDeletionsForTests()).toEqual([]);
	});
});
