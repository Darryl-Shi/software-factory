// Layered settings over the config file (spec §5, §6): schema default → global → project.
// Settings are a view over the config file, not a second store. Validate on save; invalid → file unchanged.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import YAML from "yaml";
import type { SecretStore } from "../secrets/store.ts";
import { type EffectiveSettings, FactoryError, type Project, type Scope, type SettingField, type SettingSource } from "./types.ts";

export type Obj = Record<string, any>;
export const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

export function expandHome(p: string): string {
	return p === "~" ? homedir() : p.startsWith("~/") ? homedir() + p.slice(1) : p;
}

// Set once by each process entry point (main, doctor, setup) so `store:` refs resolve without threading a store (spec §2.2).
let defaultSecretStore: SecretStore | undefined;
export function setDefaultSecretStore(store: SecretStore | undefined): void {
	defaultSecretStore = store;
}

/** Resolve a `secretRef` setting (`env:NAME`, `file:/path` or `store:key`) where the secret is used; undefined when missing. */
export function resolveSecret(ref: string | undefined, store?: SecretStore): string | undefined {
	if (!ref) return undefined;
	if (ref.startsWith("env:")) return process.env[ref.slice(4)];
	if (ref.startsWith("file:")) {
		const p = expandHome(ref.slice(5));
		return existsSync(p) ? readFileSync(p, "utf8").trim() : undefined;
	}
	if (ref.startsWith("store:")) return (store ?? defaultSecretStore)?.get(ref.slice(6));
	return undefined;
}

// ---------------------------------------------------------------- the schema (web, storage and version are global-only)
export const WEB_SEARCH_MODES = ["turbo", "fast", "basic", "advanced"] as const;
export const DEFAULT_ENDPOINT = "https://api.parallel.ai/v1/search";
export const DEFAULT_DENY_READ = ["~/.factory", "~/.ssh", "~/.config/gh"];

const identity: SettingField = {
	type: "object",
	description: "GitHub identity the core uses (never visible to agents)",
	fields: {
		kind: { type: "enum", values: ["pat", "bot", "app"], default: "pat", description: "own account PAT, bot account PAT, or GitHub App" },
		tokenRef: { type: "secretRef", default: "env:GH_TOKEN", description: "PAT reference (pat/bot)" },
		appId: { type: "number", description: "GitHub App ID (app)" },
		installationId: { type: "number", description: "GitHub App installation ID (app)" },
		privateKeyRef: { type: "secretRef", description: "GitHub App private key reference, e.g. file:~/.factory/app.pem (app)" },
	},
};

const thinking: SettingField = { type: "enum", values: ["off", "low", "medium", "high"], description: "Thinking level" };
function roleField(model: string | undefined, level: string | undefined, description: string): SettingField {
	return {
		type: "object",
		description,
		fields: {
			model: { type: "string", ...(model ? { default: model } : {}), description: model ? "provider/modelId known to createModels()" : "provider/modelId known to createModels() (unset = the builder's)" },
			thinking: { ...thinking, ...(level ? { default: level } : {}), ...(level ? {} : { description: "Thinking level (unset = the builder's)" }) } as SettingField,
		},
	};
}

export const BOAT_SIZES = ["small", "default", "large"] as const;

export function coreSchema(): Record<string, SettingField> {
	return {
		version: { type: "number", default: 1, description: "Config format version", min: 1, max: 1 },
		workdir: { type: "string", default: "~/factory/work", description: "Where clones, per-run worktrees and the roles' scratch dirs live" },
		roles: {
			type: "object",
			description: "Role → model and thinking level",
			fields: {
				architect: roleField("anthropic/claude-opus-5-5", "high", "Architect: discussion and spec"),
				builder: roleField("anthropic/claude-opus-5-5", "high", "Builder: the one accountable build role"),
				helper: roleField(undefined, undefined, "Helpers the builder spawns; they write code (unset = the builder's)"),
				reviewer: roleField("openai/gpt-6-sol", "high", "Reviewer: whole product vs spec, tests, code quality and security"),
				qa: roleField("anthropic/claude-sonnet-5-5", "medium", "QA agent: uses the product in a boat.dev VM (AQ testing); the model must accept images"),
			},
		},
		policy: {
			type: "object",
			description: "Run policy",
			fields: {
				approvals: {
					type: "list",
					of: { type: "enum", values: ["spec", "delivery", "merge"], description: "gate" },
					default: ["spec"],
					description: "Approval gates",
				},
				reviewRoundCap: { type: "number", default: 3, min: 1, max: 20, description: "Review rounds before escalation" },
				escalateOnNoProgress: { type: "boolean", default: true, description: "Escalate when a fix round leaves an empty diff" },
				messages: {
					type: "list",
					of: { type: "enum", values: ["architect", "builder", "reviewer"], description: "role" },
					default: ["architect", "builder", "reviewer"],
					description: "Roles a human can message while a run is going (drop reviewer for an independent review)",
				},
			},
		},
		github: {
			type: "object",
			description: "GitHub: identity and new-repo visibility",
			fields: {
				identity,
				visibility: { type: "enum", values: ["private", "public"], default: "private", description: "Visibility of repos the factory creates" },
			},
		},
		ci: {
			type: "object",
			description: "CI on the delivered commit",
			fields: {
				mode: { type: "enum", values: ["off", "if-present", "required"], default: "if-present", description: "off | if-present | required" },
				fixRounds: { type: "number", default: 2, min: 0, max: 3, description: "CI fix rounds before escalation (0–3)" },
				checks: { type: "list", of: { type: "string", description: "check name" }, default: [], description: "Names of the checks that count; empty = all" },
				noChecksTimeout: { type: "string", default: "2m", description: "If no checks appear by then, the repo has no CI (e.g. 2m, 90s)" },
			},
		},
		sandbox: {
			type: "object",
			description: "@anthropic-ai/sandbox-runtime policy for every command a role runs",
			fields: {
				enabled: { type: "boolean", default: true, description: "Run commands inside the sandbox runtime (disable only where bubblewrap/sandbox-exec is unavailable, e.g. unit tests)" },
				allowedDomains: {
					type: "list",
					of: { type: "string", description: "domain" },
					default: ["registry.npmjs.org", "pypi.org", "files.pythonhosted.org", "proxy.golang.org"],
					description: "Only these domains are reachable (through the host proxy)",
				},
				deniedDomains: { type: "list", of: { type: "string", description: "domain" }, default: [], description: "Always denied; wins over allows" },
				denyRead: { type: "list", of: { type: "string", description: "path" }, default: DEFAULT_DENY_READ, description: "Hidden from every role" },
				extraWrite: { type: "list", of: { type: "string", description: "path" }, default: [], description: "Added to the builder's worktree + scratch dir" },
				unixSockets: {
					type: "enum",
					values: ["auto", "block", "allow"],
					default: "auto",
					description: "Linux: block Unix-socket creation with seccomp (auto = block when the host allows nested user namespaces)",
				},
				setupScripts: {
					type: "list",
					of: { type: "string", description: "path" },
					default: ["scripts/setup.sh", "setup.sh", "bin/setup"],
					description: "The first of these that exists in the worktree runs at provision (sandboxed, builder rights)",
				},
			},
		},
		qa: {
			type: "object",
			description: "AQ testing: a QA agent uses the product in a boat.dev VM, in parallel with the review",
			fields: {
				enabled: { type: "boolean", default: true, description: "Run AQ testing (needs boat.apiKey); turn off for a product without a UI or code that must stay on this machine" },
			},
		},
		boat: {
			type: "object",
			description: "The boat.dev VM AQ testing runs in",
			fields: {
				apiKey: { type: "secretRef", default: "env:BOAT_API_KEY", description: "boat.dev API key (a reference, never the key)" },
				size: { type: "enum", values: [...BOAT_SIZES], default: "default", description: "VM size: small, default (4 vCPU / 8 GB) or large" },
				ttl: { type: "string", default: "1h", description: "Backstop: boat stops the VM after this long (10m to 24h)" },
				runScripts: {
					type: "list",
					of: { type: "string", description: "path" },
					default: ["scripts/run.sh", "bin/run"],
					description: "The first of these that exists starts the product in the VM; none = nothing to launch (QA skipped)",
				},
			},
		},
		web: {
			type: "object",
			description: "Web UI (global only)",
			fields: {
				host: { type: "string", default: "127.0.0.1", description: "Address the web UI listens on (keep it on localhost)" },
				port: { type: "number", default: 7317, min: 0, max: 65535, description: "Port of the web UI (0 picks a free port)" },
			},
		},
		webSearch: {
			type: "object",
			description: "web_search tool (Parallel Search API)",
			fields: {
				mode: { type: "enum", values: [...WEB_SEARCH_MODES], default: "fast", description: "Parallel search mode: turbo, fast (~1 s), basic or advanced (~3 s, highest quality)" },
				maxResults: { type: "number", default: 10, min: 1, max: 40, description: "Results per search" },
				maxCharsTotal: { type: "number", min: 1000, max: 200_000, description: "Optional cap on the excerpt characters of one search" },
				apiKey: { type: "secretRef", default: "env:PARALLEL_API_KEY", description: "Parallel API key (a reference, never the key)" },
				endpoint: { type: "string", default: DEFAULT_ENDPOINT, description: "Search endpoint" },
			},
		},
		storage: {
			type: "object",
			description: "Harness storage (global only)",
			fields: {
				kind: { type: "enum", values: ["sqlite", "jsonl"], default: "sqlite", description: "Storage backend" },
				path: { type: "string", default: "~/.factory/factory.sqlite", description: "Storage path" },
			},
		},
	};
}

export const GLOBAL_ONLY = ["storage", "version", "web"];
export const PROJECT_ONLY = ["repo"];

/**
 * Refuse a config file that still has the removed `stages` or `workers` sections, at the top level or in a project's
 * overrides (no migrator; left in place they would be ignored, e.g. a project's CI mode or GitHub identity). Also refuse
 * the removed `roles.<role>.extensions` key: ignored, it would silently give a role tools (e.g. web search) the operator
 * had taken away.
 */
export function assertNoLegacySections(configPath: string): void {
	if (!existsSync(configPath)) return;
	const doc = YAML.parseDocument(readFileSync(configPath, "utf8"));
	if (doc.errors.length > 0) return; // the config store reports parse errors
	const raw = doc.toJS();
	if (!isObj(raw)) return;
	const LEGACY = ["stages", "workers"];
	const projects = Object.entries(isObj(raw.projects) ? raw.projects : {}).filter(([, p]) => isObj(p) && LEGACY.some((k) => k in p));
	const found = LEGACY.filter((k) => k in raw || projects.some(([, p]) => k in p));
	const extensions = [
		...roleExtensionPaths(raw.roles, "roles"),
		...Object.entries(isObj(raw.projects) ? raw.projects : {}).flatMap(([name, p]) => (isObj(p) ? roleExtensionPaths(p.roles, `projects.${name}.roles`) : [])),
	];
	const extMessage = extensions.length
		? `config uses removed keys (${extensions.join(", ")}); tool sets are now fixed per role, so delete these keys. Web search can no longer be removed from a role: to turn it off, leave webSearch.apiKey unresolved (web_search calls then fail without sending a query)`
		: "";
	if (found.length === 0) {
		if (extMessage) throw new FactoryError("invalid", extMessage);
		return;
	}
	throw new FactoryError(
		"invalid",
		`config uses removed sections (${found.join(", ")}); move stages.repo.{identity,visibility} → github.*, stages.repo.workdir and stages.environment.root → workdir, stages.delivery.ci.* → ci.*, stages.environment.sandbox.* → sandbox.*, stages.environment.setupScripts → sandbox.setupScripts, stages.interface.{host,port} → web.*, workers.web-search.* → webSearch.*` +
			(projects.length ? `; found in projects: ${projects.map(([name]) => name).join(", ")}` : "") +
			(extMessage ? `. Also: ${extMessage}` : ""),
	);
}

function roleExtensionPaths(roles: unknown, prefix: string): string[] {
	if (!isObj(roles)) return [];
	return Object.entries(roles).flatMap(([role, r]) => (isObj(r) && "extensions" in r ? [`${prefix}.${role}.extensions`] : []));
}

// ---------------------------------------------------------------- schema helpers
export function fieldAt(schema: Record<string, SettingField>, path: string[]): SettingField | undefined {
	let fields: Record<string, SettingField> | undefined = schema;
	let field: SettingField | undefined;
	for (const key of path) {
		if (fields === undefined) return undefined;
		field = fields[key];
		if (field === undefined) return undefined;
		fields = field.type === "object" ? field.fields : undefined;
	}
	return field;
}

export function defaultsOf(fields: Record<string, SettingField>): Obj {
	const out: Obj = {};
	for (const [k, f] of Object.entries(fields)) {
		if (f.type === "object") out[k] = defaultsOf(f.fields);
		else if (f.default !== undefined) out[k] = structuredClone(f.default);
	}
	return out;
}

export function leaves(fields: Record<string, SettingField>, prefix: string[] = []): { path: string[]; field: SettingField }[] {
	const out: { path: string[]; field: SettingField }[] = [];
	for (const [k, f] of Object.entries(fields)) {
		if (f.type === "object") out.push(...leaves(f.fields, [...prefix, k]));
		else out.push({ path: [...prefix, k], field: f });
	}
	return out;
}

export function getAt(obj: unknown, path: string[]): unknown {
	let cur: unknown = obj;
	for (const k of path) {
		if (!isObj(cur)) return undefined;
		cur = cur[k];
	}
	return cur;
}

/** Objects merge key by key; scalars and lists replace as a whole. */
export function deepMerge(base: unknown, over: unknown): unknown {
	if (over === undefined) return structuredClone(base);
	if (isObj(base) && isObj(over)) {
		const out: Obj = structuredClone(base);
		for (const [k, v] of Object.entries(over)) out[k] = deepMerge(base[k], v);
		return out;
	}
	return structuredClone(over);
}

export function validateValue(field: SettingField, value: unknown, path: string): string[] {
	switch (field.type) {
		case "string":
			return typeof value === "string" ? [] : [`${path}: expected a string`];
		case "secretRef":
			return typeof value === "string" && /^(env|file|store):.+/.test(value)
				? []
				: [`${path}: expected a secret reference (env:NAME, file:/path or store:key), never a secret value`];
		case "number": {
			if (typeof value !== "number" || !Number.isFinite(value)) return [`${path}: expected a number`];
			const p: string[] = [];
			if (field.min !== undefined && value < field.min) p.push(`${path}: ${value} is below the minimum ${field.min}`);
			if (field.max !== undefined && value > field.max) p.push(`${path}: ${value} is above the maximum ${field.max}`);
			return p;
		}
		case "boolean":
			return typeof value === "boolean" ? [] : [`${path}: expected true or false`];
		case "enum":
			return typeof value === "string" && field.values.includes(value) ? [] : [`${path}: expected one of ${field.values.join(", ")}`];
		case "list": {
			if (!Array.isArray(value)) return [`${path}: expected a list`];
			return value.flatMap((v, i) => validateValue(field.of, v, `${path}[${i}]`));
		}
		case "object": {
			if (!isObj(value)) return [`${path}: expected an object`];
			const p: string[] = [];
			for (const [k, v] of Object.entries(value)) {
				const sub = field.fields[k];
				if (sub === undefined) p.push(`${path}.${k}: unknown setting`);
				else if (v !== undefined && v !== null) p.push(...validateValue(sub, v, `${path}.${k}`));
			}
			return p;
		}
	}
}

export function hashConfig(config: unknown): string {
	const canonical = (v: unknown): unknown =>
		isObj(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])])) : Array.isArray(v) ? v.map(canonical) : v;
	return createHash("sha256").update(JSON.stringify(canonical(config))).digest("hex").slice(0, 16);
}

export function parseDuration(v: unknown): number {
	if (typeof v === "number") return v;
	if (typeof v !== "string") return NaN;
	const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/.exec(v.trim());
	if (!m) return NaN;
	const n = Number(m[1]);
	const unit = m[2] ?? "ms";
	return n * (unit === "ms" ? 1 : unit === "s" ? 1000 : unit === "m" ? 60_000 : 3_600_000);
}

/** `roles.helper.{model, thinking}` unset (at every layer) = the builder's effective value. */
function inheritHelper(eff: Obj): Obj {
	if (!isObj(eff.roles)) return eff;
	const helper = isObj(eff.roles.helper) ? eff.roles.helper : {};
	const builder = isObj(eff.roles.builder) ? eff.roles.builder : {};
	eff.roles.helper = { ...helper, ...(helper.model === undefined && builder.model !== undefined ? { model: builder.model } : {}), ...(helper.thinking === undefined && builder.thinking !== undefined ? { thinking: builder.thinking } : {}) };
	return eff;
}

// ---------------------------------------------------------------- the config store
export type RuleCheck = (effective: Obj, scope: Scope) => string[];

export class ConfigStore {
	private doc: YAML.Document;

	constructor(
		readonly path: string,
		private schemaFn: () => Record<string, SettingField>,
		private extraRules: RuleCheck = () => [],
	) {
		this.doc = this.load();
	}

	private load(): YAML.Document {
		if (!existsSync(this.path)) return new YAML.Document({ version: 1 });
		const doc = YAML.parseDocument(readFileSync(this.path, "utf8"));
		if (doc.errors.length > 0) throw new FactoryError("invalid", `config ${this.path}: ${doc.errors[0]!.message}`);
		return doc;
	}

	reload(): void {
		this.doc = this.load();
	}

	raw(): Obj {
		const v = this.doc.toJS() ?? {};
		return isObj(v) ? v : {};
	}

	schema(): Record<string, SettingField> {
		return this.schemaFn();
	}

	// ---- effective config
	effective(scope: Scope, raw: Obj = this.raw()): Obj {
		const defaults = defaultsOf(this.schema());
		const { projects: _p, ...top } = raw;
		const global = deepMerge(defaults, top) as Obj;
		if ("global" in scope) return inheritHelper(global);
		const proj = raw.projects?.[scope.project];
		if (!isObj(proj)) throw new FactoryError("not_found", `project ${scope.project} does not exist`);
		const { repo: _r, ...over } = proj;
		return inheritHelper(deepMerge(global, over) as Obj);
	}

	getSettings(scope: Scope): EffectiveSettings {
		const raw = this.raw();
		const eff = this.effective(scope, raw);
		const out: EffectiveSettings = {};
		const projectRaw = "project" in scope ? raw.projects?.[scope.project] : undefined;
		for (const { path } of leaves(this.schema())) {
			let source: SettingSource = "default";
			if (projectRaw !== undefined && getAt(projectRaw, path) !== undefined) source = "project";
			else if (getAt(raw, path) !== undefined) source = "global";
			out[path.join(".")] = { value: getAt(eff, path), source };
		}
		return out;
	}

	// ---- projects
	projects(): Project[] {
		const raw = this.raw();
		return Object.entries(isObj(raw.projects) ? raw.projects : {}).map(([name, p]) => {
			const { repo, ...overrides } = (p ?? {}) as Obj;
			return { name, repo: String(repo), overrides };
		});
	}

	project(name: string): Project {
		const p = this.projects().find((x) => x.name === name);
		if (!p) throw new FactoryError("not_found", `project ${name} does not exist`);
		return p;
	}

	createProject(name: string, repo: string): Project {
		if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) throw new FactoryError("invalid", `invalid project name: ${name}`);
		if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(repo)) throw new FactoryError("invalid", `invalid repo binding (expected owner/name): ${repo}`);
		const existing = this.projects().find((x) => x.name === name);
		if (existing) {
			if (existing.repo !== repo) throw new FactoryError("conflict", `project ${name} is already bound to ${existing.repo}`);
			return existing;
		}
		const doc = this.doc.clone();
		doc.setIn(["projects", name, "repo"], repo);
		this.commit(doc);
		return this.project(name);
	}

	// ---- set/unset with validate-on-save
	private resolvePath(scope: Scope, path: string): string[] {
		const parts = path.split(".").filter(Boolean);
		if (parts.length === 0) throw new FactoryError("invalid", "empty setting path");
		if ("project" in scope && GLOBAL_ONLY.includes(parts[0]!))
			throw new FactoryError("invalid", `${path} is global only and cannot be overridden per project`);
		if (fieldAt(this.schema(), parts) === undefined) throw new FactoryError("invalid", `unknown setting: ${path}`);
		if ("project" in scope) this.project(scope.project);
		return "project" in scope ? ["projects", scope.project, ...parts] : parts;
	}

	set(scope: Scope, path: string, value: unknown): void {
		const docPath = this.resolvePath(scope, path);
		const field = fieldAt(this.schema(), path.split("."))!;
		const problems = validateValue(field, value, path);
		if (problems.length) throw new FactoryError("invalid", problems.join("; "));
		const doc = this.doc.clone();
		doc.setIn(docPath, doc.createNode(value));
		this.validateAndCommit(doc, scope);
	}

	unset(scope: Scope, path: string): void {
		const docPath = this.resolvePath(scope, path);
		const doc = this.doc.clone();
		if (!doc.hasIn(docPath)) return; // nothing set at this scope: already inheriting
		doc.deleteIn(docPath);
		// prune now-empty parent maps (never the project record itself)
		const stop = "project" in scope ? 2 : 0;
		for (let i = docPath.length - 1; i > stop; i--) {
			const parent = docPath.slice(0, i);
			const node = doc.getIn(parent) as YAML.YAMLMap | undefined;
			if (node && YAML.isMap(node) && node.items.length === 0) doc.deleteIn(parent);
		}
		this.validateAndCommit(doc, scope);
	}

	/** Validate the resulting effective config of every affected scope; reject without touching the file. */
	validate(raw: Obj, scope: Scope): string[] {
		const schema = this.schema();
		const problems: string[] = [];
		const { projects, ...top } = raw;
		problems.push(...validateValue({ type: "object", fields: schema, description: "" }, top, "config").map((p) => p.replace(/^config\./, "")));
		const scopes: Scope[] = "global" in scope ? [{ global: true }, ...Object.keys(isObj(projects) ? projects : {}).map((project) => ({ project }))] : [scope];
		for (const s of scopes) {
			let eff: Obj;
			try {
				eff = this.effective(s, raw);
			} catch (e) {
				problems.push(String((e as Error).message));
				continue;
			}
			const label = "global" in s ? "" : `[project ${s.project}] `;
			if ("project" in s) {
				const { repo: _r, ...over } = (projects as Obj)[s.project] ?? {};
				problems.push(...validateValue({ type: "object", fields: schema, description: "" }, over, "config").map((p) => label + p.replace(/^config\./, "")));
			}
			problems.push(...validateValue({ type: "object", fields: schema, description: "" }, eff, "config").map((p) => label + p.replace(/^config\./, "")));
			problems.push(...this.extraRules(eff, s).map((p) => label + p));
		}
		return [...new Set(problems)];
	}

	private validateAndCommit(doc: YAML.Document, scope: Scope): void {
		const raw = (doc.toJS() ?? {}) as Obj;
		const problems = this.validate(raw, scope);
		if (problems.length) throw new FactoryError("invalid", problems.join("; "));
		this.commit(doc);
	}

	private commit(doc: YAML.Document): void {
		mkdirSync(dirname(this.path), { recursive: true });
		const tmp = `${this.path}.tmp-${process.pid}`;
		writeFileSync(tmp, String(doc));
		renameSync(tmp, this.path);
		this.doc = doc;
	}
}
