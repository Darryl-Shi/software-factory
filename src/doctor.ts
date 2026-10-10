// `factory doctor` (spec §4): checks the config, the role models' credentials, the sandbox runtime, the GitHub
// identity, AQ testing (boat), web search (Parallel) and the gh CLI. Credential lines name where the credential comes
// from; every FAIL/warn about a credential or a prerequisite ends with `→ factory setup <section>`. The setup wizard
// runs the same checks at its end.
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { AuthCheck } from "@earendil-works/pi-ai";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { Factory } from "./core/core.ts";
import { assertNoLegacySections, expandHome, resolveSecret } from "./core/settings.ts";
import { run } from "./github/git.ts";
import { GitHub } from "./github/github.ts";
import { GhApiHost } from "./github/host.ts";
import { createBoat, factoryHome } from "./main.ts";
import { createModelHost, type ModelHost } from "./models/host.ts";
import { Sandbox } from "./sandbox/sandbox.ts";
import { SecretStore, secretsPath } from "./secrets/store.ts";

export type DoctorLine = { level: "ok" | "warn" | "FAIL"; text: string };

/** `ok    text`, `warn  text` or `FAIL  text`. */
export function formatDoctorLine(l: DoctorLine): string {
	return `${l.level === "ok" ? "ok  " : l.level}  ${l.text}`;
}

/** Where a provider's credential comes from: `env:NAME`, `auth.json (api key)`, `auth.json (OAuth)` or pi's label. */
function authSource(a: AuthCheck): string | undefined {
	if (a.type === "oauth") return "auth.json (OAuth)";
	if (a.source === "stored credential") return "auth.json (api key)";
	if (a.source && /^[A-Z][A-Z0-9_]*$/.test(a.source)) return `env:${a.source}`;
	return a.source || undefined;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function runDoctorChecks(configPath: string, opts: { scripted?: boolean; host?: ModelHost } = {}): Promise<DoctorLine[]> {
	configPath = expandHome(configPath);
	const home = factoryHome(configPath);
	const lines: DoctorLine[] = [];
	/** A FAIL/warn about a credential or prerequisite names the setup section that fixes it. */
	const line = (level: DoctorLine["level"], text: string, section?: string) =>
		lines.push({ level, text: level !== "ok" && section ? `${text} → factory setup ${section}` : text });
	const store = new SecretStore(secretsPath(home));
	/** resolveSecret through this factory's store; a bad secrets.json (mode, parse) is an error, not a crash. */
	const secret = (ref: string | undefined): { value?: string; error?: string } => {
		try {
			const value = resolveSecret(ref, store);
			return value === undefined ? {} : { value };
		} catch (e) {
			return { error: message(e) };
		}
	};

	const host = opts.host ?? (await createModelHost({ factoryHome: home, ...(opts.scripted ? { scripted: true } : {}) }));
	const models = host.models;
	const f = new Factory({
		configPath,
		models,
		github: new GitHub(new GhApiHost()),
		sandbox: new Sandbox({ stateDir: join(home, "environments") }),
		boat: createBoat(configPath),
	});
	const hasConfig = existsSync(configPath);
	const eff = hasConfig ? f.config.effective({ global: true }) : f.config.effective({ global: true }, { version: 1 });
	line("ok", `config ${configPath}${hasConfig ? "" : " (missing: defaults)"}`);
	if (hasConfig) {
		try {
			assertNoLegacySections(configPath);
		} catch (e) {
			line("FAIL", message(e));
		}
	}
	for (const d of host.diagnostics) line("warn", `extension: ${d.message}`);

	const raw = hasConfig ? f.config.raw() : {};
	const helperSet = raw.roles?.helper?.model !== undefined || Object.values((raw.projects ?? {}) as Record<string, any>).some((p) => p?.roles?.helper?.model !== undefined);
	for (const role of ["architect", "builder", "helper", "reviewer", "qa"]) {
		// roles.helper.model unset = the builder's model, already checked
		if (role === "helper" && !helperSet) continue;
		const ref = String(eff.roles[role].model);
		const [p, ...rest] = ref.split("/");
		const id = rest.join("/");
		if (!models.getModel(p!, id)) {
			line("FAIL", `roles.${role}.model ${ref}: unknown model`, "models");
			continue;
		}
		try {
			const auth = await models.checkAuth(p!);
			const available = auth ? (await models.getAvailable(p!)).some((m) => m.id === id) : false;
			const source = auth && authSource(auth);
			if (available) line("ok", `roles.${role}.model ${ref}: known, credentials configured${source ? ` (${source})` : ""}`);
			else line("warn", `roles.${role}.model ${ref}: known, NO credentials configured`, "models");
		} catch (e) {
			line("FAIL", `roles.${role}.model ${ref}: credential check failed: ${message(e)}`, "models");
		}
	}

	const deps = SandboxManager.checkDependencies();
	line(deps.errors.length === 0 ? "ok" : "FAIL", `sandbox runtime: ${deps.errors.join("; ") || "bubblewrap/socat present"}`, "prereqs");

	const id = eff.github.identity ?? {};
	const kind = id.kind ?? "pat";
	const ghRef: string | undefined = kind === "app" ? id.privateKeyRef : (id.tokenRef ?? "env:GH_TOKEN");
	const gh = secret(ghRef);
	if (gh.error) line("FAIL", `GitHub identity (${kind}): ${ghRef}: ${gh.error}`);
	else if (gh.value) line("ok", `GitHub identity (${kind}): credential found (${ghRef})`);
	else line("warn", `GitHub identity (${kind}): no credential at ${ghRef ?? "github.identity.privateKeyRef (unset)"}`, "github");

	// AQ testing: a FAIL for every scope where QA is on and the boat key does not resolve; a warn if boat's limits call fails
	const scopes: { label: string; eff: any }[] = [{ label: "global", eff }];
	if (hasConfig) for (const p of f.config.projects()) scopes.push({ label: `project ${p.name}`, eff: f.config.effective({ project: p.name }) });
	const checkedRefs = new Set<string>();
	for (const s of scopes) {
		if (s.eff.qa?.enabled !== true) {
			line("ok", `AQ testing (${s.label}): off`);
			continue;
		}
		const ref = String(s.eff.boat?.apiKey ?? "env:BOAT_API_KEY");
		const key = secret(ref);
		if (key.error) {
			line("FAIL", `AQ testing (${s.label}): boat.apiKey (${ref}): ${key.error}`);
			continue;
		}
		if (!key.value) {
			line("FAIL", `AQ testing (${s.label}): qa.enabled is on but boat.apiKey (${ref}) does not resolve; set the key or qa.enabled: false`, "qa");
			continue;
		}
		line("ok", `AQ testing (${s.label}): boat key found (${ref})`);
		if (checkedRefs.has(ref)) continue;
		checkedRefs.add(ref);
		try {
			await createBoat(configPath).limits(ref, store);
			line("ok", `boat.dev API reachable with ${ref}`);
		} catch (e) {
			line("warn", `boat.dev limits call failed with ${ref}: ${message(e)}`, "qa");
		}
	}

	// Web search: optional; without a key the agents' web_search tool reports that it is not configured.
	const searchRefs = new Set(scopes.map((s) => String(s.eff.webSearch?.apiKey ?? "env:PARALLEL_API_KEY")));
	for (const ref of searchRefs) {
		const key = secret(ref);
		if (key.error) line("FAIL", `web search: webSearch.apiKey (${ref}): ${key.error}`);
		else if (key.value) line("ok", `web search: Parallel key found (${ref})`);
		else line("warn", `web search: no Parallel key at ${ref} (web_search is unavailable to agents)`, "search");
	}

	line((await run("gh", ["--version"])).code === 0 ? "ok" : "FAIL", "gh CLI installed", "prereqs");
	return lines;
}
