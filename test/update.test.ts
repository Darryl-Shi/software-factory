// The updater (spec: updates): a temporary bare repo is the upstream and a clone of it the install root; npm runs
// through an injectable command runner, the restart helper is stubbed (or run in-process with stubbed restarts).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { activeWork } from "../src/main.ts";
import { type HelperDeps, type HelperJob, runHelper } from "../src/update/helper.ts";
import { readRecord, type UpdateRecord, writeRecord } from "../src/update/record.ts";
import { DAEMON_ENV, detectStartedBy, type Runner, restartFactory, runCommand } from "../src/update/restart.ts";
import { Updater, type UpdaterOptions } from "../src/update/updater.ts";
import { startWebServer } from "../src/web/server.ts";
import { makeFactory, type TestEnv } from "./helpers.ts";

const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", "-c", "commit.gpgsign=false", ...args], {
		cwd,
		encoding: "utf8",
		env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
	}).trim();

let dir: string;
let upstream: string; // bare
let work: string; // a second clone that pushes new upstream commits
let root: string; // the install root
let home: string;

function commit(repo: string, file: string, content: string, msg: string): string {
	writeFileSync(join(repo, file), content);
	git(repo, "add", file);
	git(repo, "commit", "-qm", msg);
	return git(repo, "rev-parse", "HEAD");
}
/** A new commit on the upstream (pushed from `work`). */
function push(file: string, content: string, msg: string): string {
	const sha = commit(work, file, content, msg);
	git(work, "push", "-q", "origin", "main");
	return sha;
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "sf-update-"));
	upstream = join(dir, "upstream.git");
	work = join(dir, "work");
	root = join(dir, "root");
	home = join(dir, "home");
	mkdirSync(home);
	git(dir, "init", "-q", "--bare", upstream);
	git(dir, "clone", "-q", upstream, work);
	commit(work, "package.json", JSON.stringify({ name: "f", version: "1.2.3" }), "initial");
	writeFileSync(join(work, "package-lock.json"), "{}\n");
	git(work, "add", "package-lock.json");
	git(work, "commit", "-qm", "lockfile");
	git(work, "push", "-q", "origin", "main");
	git(dir, "clone", "-q", upstream, root);
	git(root, "config", "user.name", "t");
	git(root, "config", "user.email", "t@t");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

interface Calls {
	npm: string[][];
	jobs: HelperJob[];
}
/** Real git, stubbed npm (`npmFails` makes `npm ci` fail). */
function makeUpdater(o: Partial<UpdaterOptions> & { npmFails?: () => boolean } = {}): { u: Updater; calls: Calls } {
	const calls: Calls = { npm: [], jobs: [] };
	const run: Runner = async (cmd, args, opts) => {
		if (cmd === "npm") {
			calls.npm.push(args);
			return o.npmFails?.() ? { code: 1, stdout: "", stderr: "npm ERR! code E404\nnpm ERR! 404 Not Found - left-pad" } : { code: 0, stdout: "", stderr: "" };
		}
		return runCommand(cmd, args, opts);
	};
	const u = new Updater({
		root,
		home,
		configPath: join(home, "config.yaml"),
		startedBy: "daemon",
		run,
		spawnHelper: (j) => calls.jobs.push(j),
		...o,
	});
	return { u, calls };
}
const head = () => git(root, "rev-parse", "HEAD");

describe("version and check", () => {
	test("the running version: short SHA, date, package version; updatable on a branch with an upstream", async () => {
		const { u } = makeUpdater();
		await u.init();
		const v = await u.version();
		expect(v).toMatchObject({ version: "1.2.3", sha: head().slice(0, 7), fullSha: head(), updatable: true, startedBy: "daemon", active: [] });
		expect(v.date).toMatch(/^\d{4}-\d\d-\d\dT/);
		expect(v.check).toBeUndefined();
	});

	test("behind: the count, the upstream SHA and the incoming subjects newest first", async () => {
		const { u } = makeUpdater();
		await u.init();
		push("a.txt", "a", "add a");
		const tip = push("b.txt", "b", "add `b`");
		const c = await u.check();
		expect(c).toMatchObject({ behind: 2, ahead: 0, dirty: false, upstream: "origin/main", upstreamSha: tip.slice(0, 7), upstreamFullSha: tip, commits: ["add `b`", "add a"] });
		expect(c.error).toBeUndefined();
		expect((await u.version()).check).toEqual(c);
	});

	test("at most 50 subjects", async () => {
		const { u } = makeUpdater();
		await u.init();
		for (let i = 0; i < 55; i++) {
			writeFileSync(join(work, "n.txt"), String(i));
			git(work, "commit", "-qam", `c${i}`, "--allow-empty");
		}
		git(work, "add", "n.txt");
		git(work, "commit", "-qm", "last");
		git(work, "push", "-q", "origin", "main");
		const c = await u.check();
		expect(c.behind).toBe(56);
		expect(c.commits).toHaveLength(50);
		expect(c.commits[0]).toBe("last");
	});

	test("ahead and dirty", async () => {
		const { u } = makeUpdater();
		await u.init();
		commit(root, "local.txt", "x", "local");
		push("a.txt", "a", "add a");
		writeFileSync(join(root, "package.json"), "{}");
		writeFileSync(join(root, "untracked.txt"), "u");
		const c = await u.check();
		expect(c).toMatchObject({ behind: 1, ahead: 1, dirty: true });
	});

	test("untracked and ignored files are not dirty", async () => {
		const { u } = makeUpdater();
		await u.init();
		mkdirSync(join(root, ".factory-dev"));
		writeFileSync(join(root, ".factory-dev", "x"), "x");
		writeFileSync(join(root, "untracked.txt"), "u");
		expect((await u.check()).dirty).toBe(false);
	});

	test("detached HEAD, no upstream, not a git checkout: not updatable, with the reason", async () => {
		const { u } = makeUpdater();
		await u.init();
		git(root, "checkout", "-q", "--detach");
		expect(await u.version()).toMatchObject({ updatable: false, reason: "detached HEAD" });
		await expect(u.check()).rejects.toMatchObject({ code: "invalid" });
		git(root, "checkout", "-q", "-b", "local");
		expect(await u.version()).toMatchObject({ updatable: false, reason: "no upstream branch" });
		rmSync(join(root, ".git"), { recursive: true });
		const { u: plain } = makeUpdater();
		await plain.init();
		const v = await plain.version();
		expect(v).toMatchObject({ version: "1.2.3", updatable: false, reason: "not a git checkout" });
		expect(v.sha).toBeUndefined();
	});

	test("a failed fetch is the check's error, not fatal, logged on one line", async () => {
		const logs: string[] = [];
		const { u } = makeUpdater({ log: (m) => logs.push(m) });
		await u.init();
		git(root, "remote", "set-url", "origin", join(dir, "nowhere.git"));
		const c = await u.check();
		expect(c.error).toBeTruthy();
		expect(c.behind).toBe(0);
		expect(logs).toHaveLength(1);
		expect(logs[0]).not.toContain("\n");
		expect((await u.version()).check?.error).toBe(c.error);
	});
});

describe("apply", () => {
	test("fast-forwards to the checked SHA, records the phases and hands the restart to the helper", async () => {
		const { u, calls } = makeUpdater({ serveArgs: ["--port", "0"] });
		await u.init();
		const from = head();
		const tip = push("a.txt", "a", "add a");
		const c = await u.check();
		const r = await u.apply(c.upstreamSha);
		expect(r).toMatchObject({ from, to: tip, phase: "pulling" });
		await u.settled();
		expect(head()).toBe(tip);
		expect(calls.npm).toEqual([]); // the lockfile didn't change
		expect(readRecord(home)).toMatchObject({ from, to: tip, phase: "restarting", lockChanged: false, startedBy: "daemon" });
		expect(statSync(join(home, "update.json")).mode & 0o777).toBe(0o600);
		expect(calls.jobs).toHaveLength(1);
		expect(calls.jobs[0]).toMatchObject({ root, home, from, to: tip, lockChanged: false, startedBy: "daemon", serveArgs: ["--port", "0"], timeoutMs: 90_000 });
	});

	test("the SHA from the check is installed even if the upstream moves on after the apply starts", async () => {
		const { u } = makeUpdater();
		await u.init();
		const tip = push("a.txt", "a", "add a");
		await u.check();
		await u.apply(tip);
		push("b.txt", "b", "add b");
		await u.settled();
		expect(head()).toBe(tip);
	});

	test("a changed lockfile runs npm ci before the restart", async () => {
		const { u, calls } = makeUpdater();
		await u.init();
		const tip = push("package-lock.json", '{"v":2}\n', "deps");
		await u.check();
		await u.apply(tip);
		await u.settled();
		expect(calls.npm).toEqual([["ci", "--no-audit", "--no-fund"]]);
		expect(readRecord(home)).toMatchObject({ phase: "restarting", lockChanged: true });
		expect(calls.jobs).toHaveLength(1);
	});

	test("a failed install resets the checkout, reinstalls, fails with npm's last lines and doesn't restart", async () => {
		let n = 0;
		const { u, calls } = makeUpdater({ npmFails: () => ++n === 1 });
		await u.init();
		const from = head();
		const tip = push("package-lock.json", '{"v":2}\n', "deps");
		await u.check();
		await u.apply(tip);
		await u.settled();
		expect(head()).toBe(from);
		expect(calls.npm).toHaveLength(2); // the update's, then the old lockfile's
		const r = readRecord(home)!;
		expect(r.phase).toBe("failed");
		expect(r.error).toContain("npm ERR! 404 Not Found - left-pad");
		expect(calls.jobs).toEqual([]);
		expect(git(root, "status", "--porcelain")).toBe("");
	});

	test("refusals: dirty, ahead, up to date; nothing changes", async () => {
		const { u, calls } = makeUpdater();
		await u.init();
		await u.check();
		const before = head();
		await expect(u.apply(before)).rejects.toMatchObject({ code: "invalid", message: "already up to date" });
		const tip = push("a.txt", "a", "add a");
		writeFileSync(join(root, "package.json"), "{}");
		await u.check();
		await expect(u.apply(tip)).rejects.toMatchObject({ code: "invalid", message: "local changes in tracked files" });
		git(root, "checkout", "-q", "--", "package.json");
		commit(root, "local.txt", "x", "local");
		await u.check();
		await expect(u.apply(tip)).rejects.toMatchObject({ code: "invalid", message: "local commits not on origin/main" });
		expect(head()).not.toBe(tip);
		expect(existsSync(join(home, "update.json"))).toBe(false);
		expect(calls.jobs).toEqual([]);
	});

	test("a stale SHA (the upstream moved since the check) is a conflict; a re-check shows the new commits", async () => {
		const { u } = makeUpdater();
		await u.init();
		const from = head();
		const first = push("a.txt", "a", "add a");
		await u.check();
		push("b.txt", "b", "add b");
		await expect(u.apply(first)).rejects.toMatchObject({ code: "conflict" });
		expect(head()).toBe(from);
		const c = await u.check(); // apply's re-check already saw it
		expect(c.commits).toEqual(["add b", "add a"]);
		await expect(u.apply("0123456")).rejects.toMatchObject({ code: "conflict" });
		await expect(u.apply("not a sha")).rejects.toMatchObject({ code: "invalid" });
	});

	test("without a check, any SHA is a conflict", async () => {
		const { u } = makeUpdater();
		await u.init();
		const tip = push("a.txt", "a", "add a");
		await expect(u.apply(tip)).rejects.toMatchObject({ code: "conflict" });
	});

	test("one update at a time", async () => {
		const { u } = makeUpdater();
		await u.init();
		const tip = push("a.txt", "a", "add a");
		await u.check();
		const first = u.apply(tip);
		await expect(u.apply(tip)).rejects.toMatchObject({ code: "conflict", message: "an update is already running" });
		await first;
		await u.settled();
		// the helper hasn't finished (phase restarting): still one at a time, also for another Updater (a CLI)
		const { u: other } = makeUpdater();
		await other.init();
		await other.check();
		await expect(other.apply(tip)).rejects.toMatchObject({ code: "conflict" });
		expect(() => u.dismiss()).toThrow(/running/);
	});

	test("foreground: pulls, then done with 'Restart the factory to finish the update', no restart", async () => {
		const { u, calls } = makeUpdater({ startedBy: "foreground" });
		await u.init();
		const from = head();
		const tip = push("a.txt", "a", "add a");
		await u.check();
		await u.apply(tip);
		await u.settled();
		expect(head()).toBe(tip);
		expect(calls.jobs).toEqual([]);
		expect(readRecord(home)).toMatchObject({ from, to: tip, phase: "done", restartRequired: true, message: "Restart the factory to finish the update" });
		// the running version is still the old one until the restart; nothing is left to update
		expect((await u.version()).fullSha).toBe(from);
		expect((await u.version()).check).toMatchObject({ behind: 0, commits: [] });
		const { u: next } = makeUpdater({ startedBy: "foreground" });
		await next.init();
		expect(await next.version()).toMatchObject({ fullSha: tip, update: { phase: "done", to: tip } });
		next.dismiss();
		expect((await next.version()).update).toBeUndefined();
	});

	test("startup settles a record its process left mid-update", async () => {
		const sha = head();
		writeRecord(home, { from: "a".repeat(40), to: sha, startedAt: Date.now(), phase: "installing" });
		const { u } = makeUpdater();
		await u.init();
		expect(readRecord(home)).toMatchObject({ phase: "failed" });
		// a restart in progress is left to its helper; an old one is settled
		writeRecord(home, { from: "a".repeat(40), to: sha, startedAt: Date.now(), restartAt: Date.now(), phase: "restarting" });
		await u.init();
		expect(readRecord(home)?.phase).toBe("restarting");
		writeRecord(home, { from: "a".repeat(40), to: sha, startedAt: 0, restartAt: 0, phase: "restarting" });
		await u.init();
		expect(readRecord(home)?.phase).toBe("done");
		// a running factory settles one whose helper went away, too
		writeRecord(home, { from: "a".repeat(40), to: "b".repeat(40), startedAt: 0, restartAt: 0, phase: "restarting" });
		expect((await u.version()).update).toMatchObject({ phase: "failed" });
	});
});

describe("the restart helper", () => {
	function deps(o: { serves: () => string | undefined; restart?: (n: number) => Promise<void>; npm?: string[][] }): HelperDeps & { restarts: number } {
		let now = 0;
		const d = {
			restarts: 0,
			run: (async (cmd, args, opts) => {
				if (cmd === "npm") {
					o.npm?.push(args);
					return { code: 0, stdout: "", stderr: "" };
				}
				return runCommand(cmd, args, opts);
			}) as Runner,
			fetch: (async () => {
				const sha = o.serves();
				if (!sha) throw new Error("ECONNREFUSED");
				return new Response(JSON.stringify({ fullSha: sha }), { status: 200 });
			}) as typeof fetch,
			restart: async () => {
				d.restarts++;
				await o.restart?.(d.restarts);
			},
			sleep: async (ms: number) => {
				now += ms;
			},
			now: () => now,
		};
		return d;
	}
	async function pulled(lock = false) {
		const from = head();
		const to = lock ? push("package-lock.json", '{"v":3}\n', "deps") : push("a.txt", "a", "add a");
		git(root, "fetch", "-q");
		git(root, "merge", "-q", "--ff-only", to);
		writeFileSync(join(home, "web-url"), "http://127.0.0.1:1/?token=t\n");
		writeFileSync(join(home, "factory.log"), "line 1\nerror: boom at startup\n");
		const rec: UpdateRecord = { from, to, startedAt: 0, phase: "restarting", lockChanged: lock };
		writeRecord(home, rec);
		const job: HelperJob = { root, home, configPath: join(home, "config.yaml"), from, to, lockChanged: lock, startedBy: "daemon", serveArgs: [], logFile: join(home, "factory.log"), timeoutMs: 90_000 };
		return { from, to, job };
	}

	test("the new version comes up: done", async () => {
		const { to, job } = await pulled();
		let up: string | undefined;
		const d = deps({ serves: () => up, restart: async () => void (up = to) });
		expect(await runHelper(job, d)).toBe("done");
		expect(readRecord(home)).toMatchObject({ phase: "done", to });
		expect(head()).toBe(to);
		expect(readFileSync(join(home, "factory.log"), "utf8")).toMatch(/updated from \w{7} to \w{7}/);
	});

	test("the new version doesn't come up within 90 s: reset, reinstall, restart again, rolled-back with the reason", async () => {
		const { from, to, job } = await pulled(true);
		let up: string | undefined;
		const npm: string[][] = [];
		const d = deps({ serves: () => up, npm, restart: async (n) => void (up = n === 2 ? from : undefined) });
		expect(await runHelper(job, d)).toBe("rolled-back");
		expect(head()).toBe(from);
		expect(npm).toEqual([["ci", "--no-audit", "--no-fund"]]);
		expect(d.restarts).toBe(2);
		const r = readRecord(home)!;
		expect(r.phase).toBe("rolled-back");
		expect(r.error).toContain("did not start within 90s");
		expect(r.error).toContain("error: boom at startup");
		expect(readFileSync(join(home, "factory.log"), "utf8")).toContain(`rolling back to ${from.slice(0, 7)}`);
		expect(to).not.toBe(from);
	});

	test("the restart itself fails (e.g. factory serve exits): rolled back at once", async () => {
		const { from, job } = await pulled();
		let up: string | undefined;
		const d = deps({
			serves: () => up,
			restart: async (n) => {
				if (n === 1) throw new Error("factory serve failed: config broke");
				up = from;
			},
		});
		expect(await runHelper(job, d)).toBe("rolled-back");
		expect(head()).toBe(from);
		expect(readRecord(home)?.error).toContain("factory serve failed: config broke");
	});
});

describe("how the factory was started", () => {
	const active: Runner = async () => ({ code: 0, stdout: "active", stderr: "" });
	const inactive: Runner = async () => ({ code: 3, stdout: "inactive", stderr: "" });
	test("systemd, launchd, daemon, foreground", async () => {
		expect(await detectStartedBy({ INVOCATION_ID: "x" }, active)).toEqual({ startedBy: "systemd", serveArgs: [] });
		expect((await detectStartedBy({ INVOCATION_ID: "x" }, inactive)).startedBy).toBe("foreground");
		expect((await detectStartedBy({}, active)).startedBy).toBe("foreground");
		expect((await detectStartedBy({ XPC_SERVICE_NAME: "dev.software-factory" }, inactive)).startedBy).toBe("launchd");
		expect((await detectStartedBy({ XPC_SERVICE_NAME: "com.apple.Terminal" }, inactive)).startedBy).toBe("foreground");
		expect(await detectStartedBy({ [DAEMON_ENV]: JSON.stringify(["--port", "7400"]) }, inactive)).toEqual({ startedBy: "daemon", serveArgs: ["--port", "7400"] });
		expect((await detectStartedBy({ [DAEMON_ENV]: "garbage" }, inactive)).startedBy).toBe("foreground");
	});

	test("the restart commands", async () => {
		const calls: string[] = [];
		const run: Runner = async (cmd, args) => {
			calls.push([cmd, ...args].join(" "));
			return { code: 0, stdout: "", stderr: "" };
		};
		const o = { configPath: join(home, "config.yaml"), root, serveArgs: ["--port", "7400"], run, uid: 501 };
		await restartFactory("systemd", o);
		await restartFactory("launchd", o);
		await restartFactory("daemon", o); // no pid file: nothing to stop
		expect(calls).toEqual([
			"systemctl --user restart software-factory",
			"launchctl kickstart -k gui/501/dev.software-factory",
			`${join(root, "bin", "factory")} serve --config ${join(home, "config.yaml")} --port 7400`,
		]);
		await expect(restartFactory("foreground", o)).rejects.toThrow(/by hand/);
	});
});

describe("web routes", () => {
	let t: TestEnv | undefined;
	afterEach(async () => {
		await t?.factory.close().catch(() => {});
		t = undefined;
	});
	function http(port: number, method: string, path: string, headers: Record<string, string> = {}, body?: string) {
		return new Promise<{ status: number; body: any }>((resolve, reject) => {
			const req = request({ host: "127.0.0.1", port, method, path, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
				let b = "";
				res.on("data", (c) => (b += c));
				res.on("end", () => {
					let body: any = b;
					try {
						body = b ? JSON.parse(b) : undefined;
					} catch {}
					resolve({ status: res.statusCode ?? 0, body });
				});
			});
			req.on("error", reject);
			req.end(body);
		});
	}

	test("version, check, apply and dismiss; auth, Origin and content-type checks as for /api/op", async () => {
		t = await makeFactory();
		const { u, calls } = makeUpdater({ activeWork: () => activeWork(t!.factory) });
		await u.init();
		const web = await startWebServer(t.factory.as("web"), { host: "127.0.0.1", port: 0, updater: u });
		try {
			const link = new URL(web.url);
			const port = Number(link.port);
			const token = link.searchParams.get("token")!;
			const auth = { authorization: `Bearer ${token}` };
			const json = { ...auth, "content-type": "application/json" };
			// no token
			expect((await http(port, "GET", "/api/version")).status).toBe(401);
			expect((await http(port, "POST", "/api/update/check", { "content-type": "application/json" }, "{}")).status).toBe(401);
			expect((await http(port, "POST", "/api/update/apply", { "content-type": "application/json" }, "{}")).status).toBe(401);
			expect((await http(port, "POST", "/api/update/dismiss", { "content-type": "application/json" }, "{}")).status).toBe(401);
			// a foreign Origin, a foreign Host
			expect((await http(port, "GET", "/api/version", { ...auth, origin: "http://evil.example" })).status).toBe(403);
			expect((await http(port, "POST", "/api/update/check", { ...json, origin: "http://evil.example" }, "{}")).status).toBe(403);
			expect((await http(port, "POST", "/api/update/apply", { ...json, origin: "http://evil.example" }, "{}")).status).toBe(403);
			expect((await http(port, "GET", "/api/version", { ...auth, host: "evil.example" })).status).toBe(421);
			// POST needs application/json; GET for the actions is refused
			expect((await http(port, "POST", "/api/update/check", auth, "{}")).status).toBe(415);
			expect((await http(port, "GET", "/api/update/check", auth)).status).toBe(405);

			const v = await http(port, "GET", "/api/version", { ...auth, origin: `http://127.0.0.1:${port}` });
			expect(v.status).toBe(200);
			expect(v.body).toMatchObject({ version: "1.2.3", sha: head().slice(0, 7), updatable: true, startedBy: "daemon", active: [] });
			const tip = push("a.txt", "a", "add a");
			const c = await http(port, "POST", "/api/update/check", json, "{}");
			expect(c.body.check).toMatchObject({ behind: 1, upstreamSha: tip.slice(0, 7), commits: ["add a"] });
			const stale = await http(port, "POST", "/api/update/apply", json, JSON.stringify({ sha: "abcdef0" }));
			expect(stale).toMatchObject({ status: 409, body: { ok: false, code: "conflict" } });
			writeFileSync(join(root, "package.json"), "{}");
			const dirty = await http(port, "POST", "/api/update/apply", json, JSON.stringify({ sha: tip }));
			expect(dirty).toMatchObject({ status: 400, body: { ok: false, code: "invalid", error: "local changes in tracked files" } });
			git(root, "checkout", "-q", "--", "package.json");
			const ok = await http(port, "POST", "/api/update/apply", json, JSON.stringify({ sha: tip }));
			expect(ok.status).toBe(200);
			expect(ok.body.update).toMatchObject({ to: tip });
			expect(["pulling", "installing", "restarting"]).toContain(ok.body.update.phase);
			await u.settled();
			expect(calls.jobs).toHaveLength(1);
			const again = await http(port, "POST", "/api/update/apply", json, JSON.stringify({ sha: tip }));
			expect(again).toMatchObject({ status: 409, body: { code: "conflict" } });
			writeRecord(home, { ...readRecord(home)!, phase: "done" });
			const d = await http(port, "POST", "/api/update/dismiss", json, "{}");
			expect(d.status).toBe(200);
			expect(d.body.update).toBeUndefined();
		} finally {
			await web.stop();
		}
	});

	test("the active work: runs, bundles and discussions an agent works on", async () => {
		t = await makeFactory();
		const { u } = makeUpdater({ activeWork: () => activeWork(t!.factory) });
		await u.init();
		expect((await u.version()).active).toEqual([]);
		const fake = {
			listRuns: async () => [
				{ id: "r1", project: "p", state: "BUILDING", request: { title: "Build me" } },
				{ id: "r2", project: "p", state: "AWAITING_APPROVAL", request: { title: "Waiting" } },
			],
			listBundles: async () => [{ id: "b1", project: "p", state: "AWAITING_CI", members: [{ title: "x" }, { title: "y" }] }],
			listDiscussions: async () => [
				{ id: "d1", project: "p", state: "OPEN", title: "Talking", turn: { kind: "say", startedAt: 1 } },
				{ id: "d2", project: "p", state: "OPEN", title: "Idle", turn: null },
			],
		};
		expect(await activeWork(fake as never)).toEqual([
			{ kind: "run", id: "r1", project: "p", title: "Build me", state: "BUILDING" },
			{ kind: "bundle", id: "b1", project: "p", title: "x, y", state: "AWAITING_CI" },
			{ kind: "discussion", id: "d1", project: "p", title: "Talking", state: "OPEN" },
		]);
	});
});
