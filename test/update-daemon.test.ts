// The update's daemon restart path with real processes (spec: updates): an install root cloned from a temporary
// bare upstream holding this working tree, a `factory serve` daemon started from it, then Update through the web API.
// The factory restarts on the new SHA with the same serve arguments; a version that can't start is rolled back.
import { execFile, execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";

const REPO = join(import.meta.dirname, "..");
const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", "-c", "commit.gpgsign=false", ...args], {
		cwd,
		encoding: "utf8",
		env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
	}).trim();

function factory(root: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
	const env = { ...process.env };
	delete env.FACTORY_CONFIG;
	delete env.FACTORY_SCRIPTED;
	delete env.FACTORY_DAEMON_ARGS;
	delete env.INVOCATION_ID;
	return new Promise((resolve) =>
		execFile(join(root, "bin", "factory"), args, { cwd: dirname(root), env, timeout: 120_000 }, (err, stdout, stderr) =>
			resolve({ code: err ? (typeof err.code === "number" ? err.code : -1) : 0, stdout, stderr }),
		),
	);
}

let dir: string;
let root: string;
let work: string;
let config: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "sf-update-daemon-"));
	// The upstream holds this working tree as one commit; the install root is a clone of it, with the dependencies.
	const src = join(dir, "src");
	for (const f of execFileSync("git", ["ls-files", "-co", "--exclude-standard"], { cwd: REPO, encoding: "utf8" }).split("\n").filter(Boolean)) {
		if (!existsSync(join(REPO, f))) continue;
		mkdirSync(dirname(join(src, f)), { recursive: true });
		cpSync(join(REPO, f), join(src, f));
	}
	git(src, "init", "-q");
	git(src, "add", "-A");
	git(src, "commit", "-qm", "factory");
	git(dir, "clone", "-q", "--bare", src, "upstream.git");
	root = join(dir, "root");
	work = join(dir, "work");
	git(dir, "clone", "-q", "upstream.git", root);
	git(dir, "clone", "-q", "upstream.git", work);
	symlinkSync(join(REPO, "node_modules"), join(root, "node_modules"));
	const home = join(dir, "home");
	mkdirSync(home);
	config = join(home, "config.yaml");
	const q = (s: string) => JSON.stringify(s);
	writeFileSync(
		config,
		`version: 1
web: { port: 0 }
storage: { path: ${q(join(home, "f.sqlite"))} }
roles:
  architect: { model: scripted/architect }
  builder: { model: scripted/builder }
  helper: { model: scripted/helper }
  reviewer: { model: scripted/reviewer }
workdir: ${q(join(home, "work"))}
sandbox: { enabled: false }
`,
	);
});
afterEach(async () => {
	await factory(root, ["stop", "--config", config]);
	rmSync(dir, { recursive: true, force: true });
});

function push(edit: (w: string) => void, msg: string): string {
	edit(work);
	git(work, "commit", "-qam", msg);
	git(work, "push", "-q", "origin", "main");
	return git(work, "rev-parse", "HEAD");
}

const urlFile = () => join(dirname(config), "web-url");
async function api(path: string, body?: unknown): Promise<any> {
	const u = new URL(readFileSync(urlFile(), "utf8").trim());
	const res = await fetch(new URL(path, u.origin), {
		method: body === undefined ? "GET" : "POST",
		headers: { authorization: `Bearer ${u.searchParams.get("token")}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
	return res.json();
}
/** Polls /api/version (through restarts) until `done(v)`. */
async function until(done: (v: any) => boolean, ms = 150_000): Promise<any> {
	const deadline = Date.now() + ms;
	let last: any;
	while (Date.now() < deadline) {
		try {
			last = await api("/api/version");
			if (done(last)) return last;
		} catch {}
		await new Promise((r) => setTimeout(r, 500));
	}
	throw new Error(`timed out; last: ${JSON.stringify(last)}`);
}
const pidOf = () => Number(readFileSync(join(dirname(config), "factory.pid"), "utf8").trim());

test("a daemon updates: fast-forward, restart with the same serve arguments, the new SHA served, 'done'", async () => {
	const s = await factory(root, ["serve", "--config", config, "--fake-github", join(dir, "gh"), "--scripted"]);
	expect(s.stderr).toBe("");
	expect(s.code).toBe(0);
	const from = git(root, "rev-parse", "HEAD");
	const before = await api("/api/version");
	expect(before).toMatchObject({ fullSha: from, sha: from.slice(0, 7), updatable: true, startedBy: "daemon" });
	const pid = pidOf();
	const to = push((w) => writeFileSync(join(w, "README.md"), `${readFileSync(join(w, "README.md"), "utf8")}\nupdated\n`), "docs: a new line");
	const c = await api("/api/update/check", {});
	expect(c.check).toMatchObject({ behind: 1, upstreamFullSha: to, commits: ["docs: a new line"] });
	const a = await api("/api/update/apply", { sha: c.check.upstreamSha });
	expect(a.update).toMatchObject({ from, to });
	expect(["pulling", "installing", "restarting"]).toContain(a.update.phase);
	const after = await until((v) => v.fullSha === to && v.update?.phase === "done");
	expect(after).toMatchObject({ startedBy: "daemon", update: { from, to, phase: "done" } });
	expect(git(root, "rev-parse", "HEAD")).toBe(to);
	const next = pidOf();
	expect(next).not.toBe(pid);
	if (existsSync(`/proc/${next}/cmdline`)) {
		const args = readFileSync(`/proc/${next}/cmdline`, "utf8").split("\0");
		expect(args).toContain("--scripted");
		expect(args).toContain("--fake-github");
	}
	const log = readFileSync(join(dirname(config), "factory.log"), "utf8");
	expect(log).toContain(`update: applying ${from.slice(0, 7)} → ${to.slice(0, 7)}`);
	expect(log).toContain(`updated from ${from.slice(0, 7)} to ${to.slice(0, 7)}`);
	// `factory status` prints the running SHA
	const st = await factory(root, ["status", "--config", config]);
	expect(st.stdout).toContain(`version ${to.slice(0, 7)}`);
	// `factory update --yes` from a terminal: the same check and apply, through the running factory
	const third = push((w) => writeFileSync(join(w, "README.md"), `${readFileSync(join(w, "README.md"), "utf8")}\nagain\n`), "docs: another line");
	const cli = await factory(root, ["update", "--yes", "--config", config]);
	expect(cli.stdout).toContain("docs: another line");
	expect(cli.stdout).toContain(`updated from ${to.slice(0, 7)} to ${third.slice(0, 7)}`);
	expect(cli.code).toBe(0);
	expect((await api("/api/version")).fullSha).toBe(third);
}, 300_000);

test("a version that can't start is rolled back: the old SHA runs again and the record says why", async () => {
	expect((await factory(root, ["serve", "--config", config, "--fake-github", join(dir, "gh"), "--scripted"])).code).toBe(0);
	const from = git(root, "rev-parse", "HEAD");
	const to = push((w) => {
		const main = join(w, "src", "main.ts");
		const s = readFileSync(main, "utf8");
		writeFileSync(main, s.replace("export async function startFactoryProcess(opts: ProcessOptions = {}): Promise<FactoryProcess> {", '$&\n\tthrow new Error("this version is broken");'));
	}, "break the start");
	const c = await api("/api/update/check", {});
	await api("/api/update/apply", { sha: c.check.upstreamFullSha });
	const after = await until((v) => v.update?.phase === "rolled-back" && v.fullSha === from);
	expect(after.update).toMatchObject({ from, to });
	expect(after.update.error).toContain("this version is broken");
	expect(git(root, "rev-parse", "HEAD")).toBe(from);
	expect(git(root, "status", "--porcelain", "--untracked-files=no")).toBe("");
}, 240_000);
