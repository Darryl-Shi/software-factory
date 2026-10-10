// Secret store (spec §2.2): `<factoryHome>/secrets.json`, mode 0600 in a 0700 dir, read fresh on every access
// so external edits are seen; writes go through a temp file + rename. Referenced from settings as `store:<key>`.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const SECRET_KEY = /^[a-z0-9-]+$/;

export function secretsPath(factoryHome: string): string {
	return join(factoryHome, "secrets.json");
}

type SecretsFile = { version: 1; secrets: Record<string, string> };

export class SecretStore {
	constructor(readonly path: string) {}

	private read(): SecretsFile {
		if (!existsSync(this.path)) return { version: 1, secrets: {} };
		const mode = statSync(this.path).mode & 0o777;
		if ((mode & 0o077) !== 0) throw new Error(`secrets.json has mode 0${mode.toString(8).padStart(3, "0")}; run chmod 600 ${this.path}`);
		let data: any;
		try {
			data = JSON.parse(readFileSync(this.path, "utf8"));
		} catch (e) {
			throw new Error(`cannot parse ${this.path}: ${(e as Error).message}`);
		}
		if (typeof data !== "object" || data === null || typeof data.secrets !== "object" || data.secrets === null) throw new Error(`cannot parse ${this.path}: expected { version, secrets }`);
		return { version: 1, secrets: { ...data.secrets } };
	}

	private write(data: SecretsFile): void {
		mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
		const tmp = `${this.path}.${process.pid}.tmp`;
		writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
		// `mode` applies only when the file is created: a stale temp file keeps its old mode.
		chmodSync(tmp, 0o600);
		renameSync(tmp, this.path);
	}

	get(key: string): string | undefined {
		const { secrets } = this.read();
		return Object.hasOwn(secrets, key) ? secrets[key] : undefined;
	}

	set(key: string, value: string): void {
		if (!SECRET_KEY.test(key)) throw new Error(`invalid secret key ${JSON.stringify(key)} (expected ${SECRET_KEY.source})`);
		const data = this.read();
		data.secrets[key] = value;
		this.write(data);
	}

	delete(key: string): void {
		const data = this.read();
		if (!Object.hasOwn(data.secrets, key)) return;
		delete data.secrets[key];
		this.write(data);
	}

	keys(): string[] {
		return Object.keys(this.read().secrets);
	}
}
