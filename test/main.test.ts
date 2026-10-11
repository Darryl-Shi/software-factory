// The factory process (src/main.ts): serve refuses a loose or unparseable secrets.json before anything starts (spec §5).
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { setDefaultSecretStore } from "../src/core/settings.ts";
import { startFactoryProcess } from "../src/main.ts";
import { secretsPath } from "../src/secrets/store.ts";

afterEach(() => setDefaultSecretStore(undefined));

const home = () => {
	const dir = mkdtempSync(join(tmpdir(), "sf-main-"));
	writeFileSync(join(dir, "config.yaml"), "version: 1\n");
	return dir;
};
const quiet = () => {};

describe("startFactoryProcess secrets.json check", () => {
	test("refuses a 0644 secrets.json with the chmod hint", async () => {
		const dir = home();
		writeFileSync(secretsPath(dir), JSON.stringify({ version: 1, secrets: {} }), { mode: 0o644 });
		await expect(startFactoryProcess({ configPath: join(dir, "config.yaml"), scripted: true, webPort: 0, log: quiet })).rejects.toThrow(
			`secrets.json has mode 0644; run chmod 600 ${secretsPath(dir)}`,
		);
	});

	test("refuses an unparseable secrets.json", async () => {
		const dir = home();
		writeFileSync(secretsPath(dir), "{nope", { mode: 0o600 });
		await expect(startFactoryProcess({ configPath: join(dir, "config.yaml"), scripted: true, webPort: 0, log: quiet })).rejects.toThrow(
			`cannot parse ${secretsPath(dir)}`,
		);
	});

	test("a missing secrets.json is fine", async () => {
		const dir = home();
		const proc = await startFactoryProcess({ configPath: join(dir, "config.yaml"), scripted: true, webPort: 0, log: quiet });
		await proc.close();
	});
});
