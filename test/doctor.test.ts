// doctor (spec §4): credential lines name their source; FAIL/warn lines point to `factory setup <section>`.
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

beforeEach(async () => {
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
afterEach(() => {
	vi.unstubAllEnvs();
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

	test("formatDoctorLine keeps the ok/warn/FAIL column", () => {
		expect(formatDoctorLine({ level: "ok", text: "a" })).toBe("ok    a");
		expect(formatDoctorLine({ level: "warn", text: "b" })).toBe("warn  b");
		expect(formatDoctorLine({ level: "FAIL", text: "c" })).toBe("FAIL  c");
	});
});
