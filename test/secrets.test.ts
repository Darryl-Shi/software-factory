// Secret store (spec §2.2): ~/.factory/secrets.json behind `store:` refs; the sandbox denies the factory home.
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as c } from "@earendil-works/chord/context";
import { afterEach, describe, expect, test } from "vitest";
import { resolveSecret, setDefaultSecretStore } from "../src/core/settings.ts";
import { Sandbox } from "../src/sandbox/sandbox.ts";
import { SecretStore, secretsPath } from "../src/secrets/store.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "sf-secrets-"));

describe("SecretStore", () => {
	test("set creates dir 0700 and file 0600, no temp file left", () => {
		const dir = join(tmp(), "home");
		const store = new SecretStore(secretsPath(dir));
		store.set("github", "t");
		expect(statSync(dir).mode & 0o777).toBe(0o700);
		const file = join(dir, "secrets.json");
		expect(statSync(file).mode & 0o777).toBe(0o600);
		expect(readdirSync(dir)).toEqual(["secrets.json"]);
		expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ version: 1, secrets: { github: "t" } });
	});

	test("get sees an external write", () => {
		const file = secretsPath(tmp());
		const store = new SecretStore(file);
		expect(store.get("github")).toBeUndefined();
		expect(store.keys()).toEqual([]);
		writeFileSync(file, JSON.stringify({ version: 1, secrets: { github: "ext" } }), { mode: 0o600 });
		expect(store.get("github")).toBe("ext");
	});

	test("refuses a group/world-readable file", () => {
		const file = secretsPath(tmp());
		writeFileSync(file, JSON.stringify({ version: 1, secrets: { x: "v" } }), { mode: 0o600 });
		chmodSync(file, 0o644);
		expect(() => new SecretStore(file).get("x")).toThrow(`secrets.json has mode 0644; run chmod 600 ${file}`);
	});

	test("unparseable file is an error naming it and is never overwritten", () => {
		const file = secretsPath(tmp());
		writeFileSync(file, "{oops", { mode: 0o600 });
		const store = new SecretStore(file);
		expect(() => store.get("x")).toThrow(file);
		expect(() => store.set("x", "v")).toThrow(file);
		expect(readFileSync(file, "utf8")).toBe("{oops");
	});

	test("a stale 0644 temp file does not make secrets.json 0644", () => {
		const file = secretsPath(tmp());
		writeFileSync(`${file}.${process.pid}.tmp`, "stale", { mode: 0o644 });
		chmodSync(`${file}.${process.pid}.tmp`, 0o644);
		const store = new SecretStore(file);
		store.set("github", "t");
		expect(statSync(file).mode & 0o777).toBe(0o600);
		expect(store.get("github")).toBe("t");
	});

	test("rejects bad keys", () => {
		const store = new SecretStore(secretsPath(tmp()));
		expect(() => store.set("Bad_Key", "v")).toThrow();
	});

	test("delete removes a key; keys lists keys", () => {
		const store = new SecretStore(secretsPath(tmp()));
		store.set("github", "a");
		store.set("parallel", "b");
		expect(store.keys().sort()).toEqual(["github", "parallel"]);
		store.delete("github");
		expect(store.keys()).toEqual(["parallel"]);
		expect(store.get("github")).toBeUndefined();
	});
});

describe("resolveSecret store refs", () => {
	afterEach(() => setDefaultSecretStore(undefined));

	test("store:, env: and file: refs", () => {
		const dir = tmp();
		const store = new SecretStore(secretsPath(dir));
		store.set("github", "tok");
		expect(resolveSecret("store:github", store)).toBe("tok");
		expect(resolveSecret("store:nope", store)).toBeUndefined();
		expect(resolveSecret("store:github")).toBeUndefined();
		setDefaultSecretStore(store);
		expect(resolveSecret("store:github")).toBe("tok");
		process.env.SF_SECRETS_TEST_VAR = "envval";
		expect(resolveSecret("env:SF_SECRETS_TEST_VAR", store)).toBe("envval");
		delete process.env.SF_SECRETS_TEST_VAR;
		const f = join(dir, "tokfile");
		writeFileSync(f, "fileval\n");
		expect(resolveSecret(`file:${f}`, store)).toBe("fileval");
	});
});

test("sandbox denies the factory home", async () => {
	const home = join(tmp(), "home");
	const stateDir = join(home, "environments");
	mkdirSync(stateDir, { recursive: true });
	const scratch = join(home, "..", "scratch");
	writeFileSync(join(home, "secrets.json"), "{}", { mode: 0o600 });
	const rec = {
		envId: "r1-reviewer",
		role: "reviewer",
		worktree: scratch,
		cwd: scratch,
		scratch,
		sandbox: { enabled: false, allowedDomains: [], deniedDomains: [], denyRead: [], extraWrite: [], unixSockets: "block" },
	};
	writeFileSync(join(stateDir, "r1-reviewer.json"), JSON.stringify(rec));
	const env = new Sandbox({ stateDir }).env({ conversationId: "c", envId: "r1-reviewer" });
	const r: any = await env.readTextFile(join(home, "secrets.json"), c);
	expect(r.ok).toBe(false);
	expect(String(r.error.message)).toMatch(/denied/);
});
