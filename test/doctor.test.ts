// doctor (spec §4): credential lines name their source; FAIL/warn lines point to `factory setup <section>`.
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { type DoctorLine, formatDoctorLine, runDoctorChecks } from "../src/doctor.ts";
import { createModelHost, type ModelHost } from "../src/models/host.ts";
import { SecretStore, secretsPath } from "../src/secrets/store.ts";

const dirs: string[] = [];
let home: string;
let configPath: string;
let host: ModelHost;

// A local stand-in for api.github.com (doctor's commit-identity lookups): `GET /user` answers from `accounts` by the
// bearer token; any other token gets 401 Bad credentials. Every test points doctor at it, so none hits the network.
const accounts: Record<string, { id: number; login: string }> = {};
let apiReqs: { method: string; url: string; auth: string }[] = [];
let api: Server;
let apiBase: string;

beforeEach(async () => {
	for (const k of Object.keys(accounts)) delete accounts[k];
	apiReqs = [];
	api = createServer((req, res) => {
		const auth = String(req.headers.authorization ?? "");
		apiReqs.push({ method: req.method!, url: req.url!, auth });
		const acct = accounts[auth.replace(/^Bearer /, "")];
		const [status, body] = req.method === "GET" && req.url === "/user" ? (acct ? [200, acct] : [401, { message: "Bad credentials" }]) : [404, { message: "Not Found" }];
		res.writeHead(status, { "content-type": "application/json" });
		res.end(JSON.stringify(body));
	});
	await new Promise<void>((r) => api.listen(0, "127.0.0.1", () => r()));
	apiBase = `http://127.0.0.1:${(api.address() as any).port}`;
	vi.stubEnv("SF_TEST_GITHUB_API", apiBase);

	home = mkdtempSync(join(tmpdir(), "sf-doctor-"));
	dirs.push(home);
	configPath = join(home, "config.yaml");
	// A stub `gh` first on PATH: doctor never runs the real one in tests.
	const bin = join(home, "bin");
	mkdirSync(bin);
	writeFileSync(join(bin, "gh"), "#!/bin/sh\necho 'gh version 0.0.0 (stub)'\n");
	chmodSync(join(bin, "gh"), 0o755);
	vi.stubEnv("PATH", `${bin}${delimiter}${process.env.PATH ?? ""}`);
	// No ambient credentials from the developer's shell.
	for (const k of ["GH_TOKEN", "BOAT_API_KEY", "PARALLEL_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN"]) vi.stubEnv(k, undefined);
	host = await createModelHost({ factoryHome: home, scripted: true });
});
afterEach(async () => {
	vi.unstubAllEnvs();
	await new Promise<void>((r) => api.close(() => r()));
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const SCRIPTED_ROLES = `roles:
  architect: { model: scripted/architect }
  builder: { model: scripted/builder }
  reviewer: { model: scripted/reviewer }
  qa: { model: scripted/qa }
`;

function config(body: string) {
	writeFileSync(configPath, `version: 1\n${body}`);
}

const find = (lines: DoctorLine[], level: DoctorLine["level"], re: RegExp) => lines.find((l) => l.level === level && re.test(l.text));

describe("doctor", () => {
	test("store ref source is reported", async () => {
		new SecretStore(secretsPath(home)).set("github", "ghp_test");
		config(`${SCRIPTED_ROLES}github:\n  identity: { kind: pat, tokenRef: "store:github" }\nqa: { enabled: false }\n`);
		const lines = await runDoctorChecks(configPath, { host });
		const gh = find(lines, "ok", /GitHub identity/);
		expect(gh, JSON.stringify(lines, null, 1)).toBeDefined();
		expect(gh!.text).toContain("store:github");
	});

	test("missing GitHub credential points to setup", async () => {
		config(`${SCRIPTED_ROLES}github:\n  identity: { kind: pat, tokenRef: "store:github" }\nqa: { enabled: false }\n`);
		const lines = await runDoctorChecks(configPath, { host });
		const gh = find(lines, "warn", /GitHub identity/);
		expect(gh, JSON.stringify(lines, null, 1)).toBeDefined();
		expect(gh!.text).toMatch(/→ factory setup github$/);
	});

	test("role without credentials points to setup models", async () => {
		config(`${SCRIPTED_ROLES.replace("scripted/reviewer", "anthropic/claude-opus-5-5")}qa: { enabled: false }\n`);
		const lines = await runDoctorChecks(configPath, { host });
		const role = lines.find((l) => l.level !== "ok" && /roles\.reviewer\.model/.test(l.text));
		expect(role, JSON.stringify(lines, null, 1)).toBeDefined();
		expect(role!.text).toMatch(/→ factory setup models$/);
		// a role with credentials names where they come from (no FAIL/warn hint)
		expect(find(lines, "ok", /roles\.builder\.model scripted\/builder: known, credentials configured/)).toBeDefined();
	});

	test("extension diagnostics are warn lines", async () => {
		config(`${SCRIPTED_ROLES}qa: { enabled: false }\n`);
		const broken: ModelHost = { ...host, diagnostics: [{ type: "error", message: "Extension \"/x/ext.ts\" error: fixture boom" }] };
		const lines = await runDoctorChecks(configPath, { host: broken });
		expect(find(lines, "warn", /fixture boom/), JSON.stringify(lines, null, 1)).toBeDefined();
	});

	test("qa key missing points to setup qa", async () => {
		config(`${SCRIPTED_ROLES}qa: { enabled: true }\nboat: { apiKey: "store:boat" }\n`);
		const lines = await runDoctorChecks(configPath, { host });
		const qa = lines.find((l) => l.level !== "ok" && /AQ testing \(global\)/.test(l.text));
		expect(qa, JSON.stringify(lines, null, 1)).toBeDefined();
		expect(qa!.text).toContain("store:boat");
		expect(qa!.text).toMatch(/→ factory setup qa$/);
	});

	test("an unreadable secrets.json is a FAIL line, not a crash", async () => {
		new SecretStore(secretsPath(home)).set("github", "ghp_test");
		chmodSync(secretsPath(home), 0o644);
		config(`${SCRIPTED_ROLES}github:\n  identity: { kind: pat, tokenRef: "store:github" }\nqa: { enabled: false }\n`);
		const lines = await runDoctorChecks(configPath, { host });
		expect(find(lines, "FAIL", /secrets\.json has mode 0644; run chmod 600/), JSON.stringify(lines, null, 1)).toBeDefined();
	});

	test("GitHub check: a working identity prints who the factory commits as", async () => {
		accounts.ghp_good = { id: 583231, login: "octocat" };
		vi.stubEnv("SF_DOCTOR_GH", "ghp_good");
		config(`${SCRIPTED_ROLES}github:\n  identity: { kind: pat, tokenRef: "env:SF_DOCTOR_GH" }\nqa: { enabled: false }\n`);
		const lines = await runDoctorChecks(configPath, { host });
		const who = find(lines, "ok", /commits as:/);
		expect(who, JSON.stringify(lines, null, 1)).toBeDefined();
		expect(who!.text).toContain("commits as: octocat <583231+octocat@users.noreply.github.com>");
		expect(who!.text).toContain("tokenRef env:SF_DOCTOR_GH");
		expect(lines.filter((l) => /commits as:|commit identity/.test(l.text))).toHaveLength(1);
		expect(lines.some((l) => l.level === "FAIL" && /GitHub|commit identity/.test(l.text))).toBe(false);
		// the lookup went to the stub with the token
		expect(apiReqs).toEqual([{ method: "GET", url: "/user", auth: "Bearer ghp_good" }]);
	});

	test("GitHub check: a token /user rejects is a FAIL line naming the identity and GET /user, never the token", async () => {
		vi.stubEnv("SF_DOCTOR_GH", "ghp_rejected_secret");
		config(`${SCRIPTED_ROLES}github:\n  identity: { kind: pat, tokenRef: "env:SF_DOCTOR_GH" }\nqa: { enabled: false }\n`);
		const lines = await runDoctorChecks(configPath, { host });
		const fail = find(lines, "FAIL", /commit identity/);
		expect(fail, JSON.stringify(lines, null, 1)).toBeDefined();
		expect(fail!.text).toContain("cannot resolve the commit identity for github.identity (kind pat, tokenRef env:SF_DOCTOR_GH)");
		expect(fail!.text).toContain("GET /user failed: 401 Bad credentials");
		expect(lines.some((l) => /commits as:/.test(l.text))).toBe(false);
		expect(JSON.stringify(lines)).not.toContain("ghp_rejected_secret");
	});

	test("GitHub check: opts.githubApi wins over SF_TEST_GITHUB_API", async () => {
		accounts.ghp_good = { id: 583231, login: "octocat" };
		vi.stubEnv("SF_DOCTOR_GH", "ghp_good");
		vi.stubEnv("SF_TEST_GITHUB_API", "http://127.0.0.1:1");
		config(`${SCRIPTED_ROLES}github:\n  identity: { kind: pat, tokenRef: "env:SF_DOCTOR_GH" }\nqa: { enabled: false }\n`);
		const lines = await runDoctorChecks(configPath, { host, githubApi: apiBase });
		expect(find(lines, "ok", /commits as: octocat <583231\+octocat@users\.noreply\.github\.com>/), JSON.stringify(lines, null, 1)).toBeDefined();
	});

	test("GitHub check: a project with a different github.identity gets its own line; one with the same identity does not", async () => {
		accounts.ghp_good = { id: 583231, login: "octocat" };
		accounts.ghp_other = { id: 99, login: "hubot" };
		vi.stubEnv("SF_DOCTOR_GH", "ghp_good");
		vi.stubEnv("SF_DOCTOR_GH2", "ghp_other");
		config(
			`${SCRIPTED_ROLES}github:\n  identity: { kind: pat, tokenRef: "env:SF_DOCTOR_GH" }\nqa: { enabled: false }\nprojects:\n  same: { repo: me/same }\n  pay:\n    repo: acme/pay\n    github:\n      identity: { kind: pat, tokenRef: "env:SF_DOCTOR_GH2" }\n`,
		);
		const lines = await runDoctorChecks(configPath, { host });
		const who = lines.filter((l) => /commits as:/.test(l.text));
		expect(who, JSON.stringify(lines, null, 1)).toHaveLength(2);
		expect(who.every((l) => l.level === "ok")).toBe(true);
		expect(who[0]!.text).toContain("commits as: octocat <583231+octocat@users.noreply.github.com>");
		expect(who[0]!.text).not.toContain("project");
		expect(who[1]!.text).toContain("project pay");
		expect(who[1]!.text).toContain("tokenRef env:SF_DOCTOR_GH2");
		expect(who[1]!.text).toContain("commits as: hubot <99+hubot@users.noreply.github.com>");
		expect(lines.some((l) => /project same/.test(l.text) && /commits as:/.test(l.text))).toBe(false);
		expect(apiReqs.map((r) => r.auth).sort()).toEqual(["Bearer ghp_good", "Bearer ghp_other"]);
	});

	test("formatDoctorLine keeps the ok/warn/FAIL column", () => {
		expect(formatDoctorLine({ level: "ok", text: "a" })).toBe("ok    a");
		expect(formatDoctorLine({ level: "warn", text: "b" })).toBe("warn  b");
		expect(formatDoctorLine({ level: "FAIL", text: "c" })).toBe("FAIL  c");
	});
});
