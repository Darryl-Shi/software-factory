// Setup section "models", compatible endpoints (spec §3.4): editing `<agentDir>/models.json`, model discovery, and
// the add/remove flows. Endpoint keys never go into models.json: pi's generic API-key login stores them in auth.json.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Api, AuthInteraction, Model } from "@earendil-works/pi-ai";
import { CredentialSynchronizationError, type ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ConfigStore } from "../../core/settings.ts";
import type { SetupContext } from "../context.ts";
import { authInteraction, SetupCancelled } from "../ui.ts";

/** models.json; provider entries follow pi's schema and are passed through as is. */
type ModelsDoc = { providers: Record<string, any> };

const modelsPath = (agentDir: string) => join(agentDir, "models.json");

/** models.json is not plain JSON setup can rewrite (pi also accepts `//` comments and trailing commas). */
export class ModelsJsonError extends Error {
	constructor(path: string, why: string) {
		super(`models.json can't be parsed: ${why}; edit ${path} by hand`);
		this.name = "ModelsJsonError";
	}
}

/**
 * `<agentDir>/models.json`, or `{ providers: {} }` when absent. Other top-level keys are kept; a BOM is skipped.
 * pi's own parser (comments, trailing commas) is not exported, and rewriting such a file would drop its comments, so
 * anything `JSON.parse` rejects throws ModelsJsonError and the file is left for the user.
 */
export function readModelsJson(agentDir: string): ModelsDoc {
	const path = modelsPath(agentDir);
	if (!existsSync(path)) return { providers: {} };
	let doc: unknown;
	try {
		doc = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
	} catch (e) {
		throw new ModelsJsonError(path, (e as Error).message);
	}
	if (!isObj(doc)) throw new ModelsJsonError(path, "expected a JSON object");
	return { ...doc, providers: isObj(doc.providers) ? doc.providers : {} };
}

/** Writes `value` as JSON through a temp file and a rename, with `mode`. */
export function writeJsonAtomic(path: string, value: unknown, mode: number): void {
	const tmp = `${path}.tmp-${process.pid}`;
	writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode });
	chmodSync(tmp, mode); // the umask may have narrowed it, and an old tmp file keeps its mode
	renameSync(tmp, path);
}

/** Writes the whole document (other top-level keys included) atomically, mode 0600. */
export function writeModelsJson(agentDir: string, doc: ModelsDoc): void {
	mkdirSync(agentDir, { recursive: true, mode: 0o700 });
	writeJsonAtomic(modelsPath(agentDir), doc, 0o600);
}

/** `GET {baseUrl}/models` (OpenAI style): the `data[].id`s, or `[]` on any failure. */
export async function discoverModels(baseUrl: string, apiKey: string | undefined, fetchFn: typeof fetch): Promise<string[]> {
	try {
		const res = await fetchFn(`${baseUrl.replace(/\/+$/, "")}/models`, {
			headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
			signal: AbortSignal.timeout(15_000),
		});
		if (!res.ok) return [];
		const body: unknown = await res.json();
		if (!isObj(body) || !Array.isArray(body.data)) return [];
		const ids = body.data.map((m: unknown) => (isObj(m) && typeof m.id === "string" ? m.id : undefined));
		return [...new Set(ids.filter((id): id is string => !!id))];
	} catch {
		return [];
	}
}

/**
 * Provider id → the role settings that use it: `roles.<role>` (global; a role left at its default counts) and
 * `projects.<name>.roles.<role>` (set in the project). A helper that inherits the builder's model adds no path:
 * changing the builder changes it too.
 */
export function providersInUse(cfg: ConfigStore): Map<string, string[]> {
	const uses = new Map<string, string[]>();
	const add = (model: unknown, path: string) => {
		const provider = providerOf(model);
		if (provider) uses.set(provider, [...(uses.get(provider) ?? []), path]);
	};
	const raw = cfg.raw();
	const global = cfg.effective({ global: true });
	for (const [role, r] of Object.entries(isObj(global.roles) ? global.roles : {})) {
		const inherited = role === "helper" && !(isObj(raw.roles) && isObj(raw.roles.helper) && raw.roles.helper.model !== undefined);
		if (!inherited && isObj(r)) add(r.model, `roles.${role}`);
	}
	for (const [name, p] of Object.entries(isObj(raw.projects) ? raw.projects : {})) {
		if (!isObj(p) || !isObj(p.roles)) continue;
		for (const [role, r] of Object.entries(p.roles)) if (isObj(r)) add(r.model, `projects.${name}.roles.${role}`);
	}
	return uses;
}

/** Every provider a role's effective model uses, at global and every project scope. */
export function roleProviders(cfg: ConfigStore): string[] {
	const out = new Set<string>();
	const scopes = [{ global: true } as const, ...cfg.projects().map((p) => ({ project: p.name }))];
	for (const scope of scopes) {
		const eff = cfg.effective(scope);
		for (const r of Object.values(isObj(eff.roles) ? eff.roles : {})) {
			const provider = isObj(r) ? providerOf(r.model) : undefined;
			if (provider) out.add(provider);
		}
	}
	return [...out];
}

/** The refusal shown when removing a provider a role uses. */
export function inUseMessage(provider: string, paths: string[]): string {
	return `${provider} is used by ${paths.join(", ")}; change those roles first`;
}

/** The user's cancel, also when a login flow wrapped it as the cause; undefined for any other error. */
export function cancelOf(e: unknown): SetupCancelled | undefined {
	if (e instanceof SetupCancelled) return e;
	if (e instanceof Error && e.cause instanceof SetupCancelled) return e.cause;
	return undefined;
}

/**
 * Deletes the stored credential for `id`, if any. A stored credential wins over models.json's `apiKey`, so a key left
 * behind by a removed endpoint would be sent to whatever server a later provider with that id points at. Works for
 * ids no provider has. True when one was deleted.
 */
export async function clearCredential(models: ModelRuntime, id: string): Promise<boolean> {
	if (!(await models.listCredentials()).some((c) => c.providerId === id)) return false;
	try {
		await models.logout(id);
	} catch (e) {
		// deleted; only pi's snapshot refresh afterwards failed
		if (!(e instanceof CredentialSynchronizationError)) throw e;
	}
	return true;
}

export function errorMessage(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

function providerOf(model: unknown): string | undefined {
	if (typeof model !== "string") return undefined;
	const i = model.indexOf("/");
	return i > 0 ? model.slice(0, i) : undefined;
}

function isObj(v: unknown): v is Record<string, any> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

// ---------------------------------------------------------------- add / remove

const APIS = [
	{ value: "openai-completions", label: "OpenAI Chat Completions (openai-completions)" },
	{ value: "openai-responses", label: "OpenAI Responses (openai-responses)" },
	{ value: "anthropic-messages", label: "Anthropic Messages (anthropic-messages)" },
] as const;

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/** Base URL placeholders: OpenAI-style APIs include `/v1`, Anthropic's SDK adds it itself. */
const BASE_URL_PLACEHOLDER: Record<string, string> = {
	"openai-completions": "http://localhost:11434/v1",
	"openai-responses": "https://api.example.com/v1",
	"anthropic-messages": "https://api.example.com",
};

/**
 * pi gives a models.json provider without `apiKey` a generic login that prompts once for a secret. The key was
 * already collected (for discovery), so the first secret prompt is answered with it and the user types it once.
 */
function prefilledKey(inner: AuthInteraction, key: string): AuthInteraction {
	let used = false;
	return {
		signal: inner.signal,
		notify: (e) => inner.notify(e),
		prompt: async (p) => {
			if (p.type === "secret" && !used) {
				used = true;
				return key;
			}
			return inner.prompt(p);
		},
	};
}

const positiveInt = (v: string) => (/^[1-9][0-9]*$/.test(v.trim()) ? undefined : "enter a positive whole number");

function splitIds(v: string): string[] {
	return v
		.split(/[\s,]+/)
		.map((s) => s.trim())
		.filter(Boolean);
}

/** Asks for the model ids: discovered ones through a multiselect (openai-* APIs), plus any typed by hand. */
async function pickModels(ctx: SetupContext, api: string, baseUrl: string, key: string | undefined): Promise<string[]> {
	const { ui } = ctx;
	let picked: string[] = [];
	if (api.startsWith("openai-")) {
		const spin = ui.spinner();
		spin.start(`Looking for models at ${baseUrl.replace(/\/+$/, "")}/models`);
		const found = await discoverModels(baseUrl, key, ctx.fetch);
		spin.stop(found.length ? `found ${found.length} model${found.length === 1 ? "" : "s"}` : "no models found; enter the ids by hand");
		if (found.length) picked = await ui.multiselect({ message: "Models", options: found.map((id) => ({ value: id, label: id })), required: false });
	}
	const more = await ui.text({
		message: picked.length ? "More model ids, comma-separated (blank for none)" : "Model ids, comma-separated",
		validate: (v) => (picked.length || splitIds(v).length ? undefined : "enter at least one model id"),
	});
	return [...new Set([...picked, ...splitIds(more)])];
}

/** Retry / Save anyway / Skip after a failed test request; Retry is the default. */
async function retrySaveSkip(ctx: SetupContext, id: string): Promise<"retry" | "save" | "skip"> {
	return ctx.ui.select({
		message: `The test request to ${id} failed`,
		options: [
			{ value: "retry", label: "Retry" },
			{ value: "save", label: "Save anyway" },
			{ value: "skip", label: "Skip" },
		],
		initial: "retry",
	});
}

/** One `completeSimple` "Reply with OK"; resolves with the reply text, rejects with the failure. */
async function testCall(ctx: SetupContext, model: Model<Api>): Promise<string> {
	const models = (await ctx.host()).models;
	const msg = await models.completeSimple(
		model,
		{ messages: [{ role: "user", content: "Reply with OK", timestamp: Date.now() }] },
		{ maxRetries: 0, timeoutMs: 60_000 },
	);
	if (msg.stopReason === "error" || msg.stopReason === "aborted") throw new Error(msg.errorMessage || `request ${msg.stopReason}`);
	return msg.content
		.map((c) => (c.type === "text" ? c.text : ""))
		.join("")
		.trim();
}

/**
 * Undoes an added endpoint: any credential stored for it (a failed login may have stored one anyway) and its
 * models.json entry. The files are as before, so `needsRestart` goes back to its value before the add.
 */
async function revertEndpoint(ctx: SetupContext, id: string, restartBefore: boolean): Promise<void> {
	const host = await ctx.host();
	await clearCredential(host.models, id);
	const doc = readModelsJson(host.agentDir);
	delete doc.providers[id];
	writeModelsJson(host.agentDir, doc);
	await ctx.reloadHost();
	ctx.needsRestart = restartBefore;
}

/** Add a compatible endpoint (spec §3.4): write models.json → reload → login (key auth) → optional test call. */
export async function addEndpoint(ctx: SetupContext): Promise<void> {
	const { ui } = ctx;
	const host = await ctx.host();
	const taken = new Set([...host.models.getProviders().map((p) => p.id), ...Object.keys(readModelsJson(host.agentDir).providers)]);
	const id = (
		await ui.text({
			message: "Provider id",
			placeholder: "my-endpoint",
			validate: (v) => {
				const s = v.trim();
				if (!/^[a-z0-9-]+$/.test(s)) return "use lowercase letters, digits and -";
				if (taken.has(s)) return `${s} is already a provider`;
				return undefined;
			},
		})
	).trim();
	const name = (await ui.text({ message: "Name", initial: id })).trim() || id;
	const api = await ui.select({ message: "API", options: APIS.map((a) => ({ ...a })) });
	const baseUrl = (
		await ui.text({
			message: "Base URL",
			placeholder: BASE_URL_PLACEHOLDER[api],
			validate: (v) => (/^https?:\/\/[^\s/]+/.test(v.trim()) ? undefined : "enter an http:// or https:// URL"),
		})
	)
		.trim()
		.replace(/\/+$/, "");
	const auth = await ui.select({
		message: "Auth",
		options: [
			{ value: "key", label: "API key", hint: "saved to auth.json" },
			{ value: "none", label: "None" },
		],
	});
	const key =
		auth === "key" ? (await ui.password({ message: "API key", validate: (v) => (v.trim() ? undefined : "required") })).trim() : undefined;

	const ids = await pickModels(ctx, api, baseUrl, key);
	const models = [];
	for (const m of ids) {
		const contextWindow = Number(await ui.text({ message: `${m}: context window (tokens)`, initial: "128000", validate: positiveInt }));
		const maxTokens = Number(await ui.text({ message: `${m}: max output tokens`, initial: "16384", validate: positiveInt }));
		const image = await ui.confirm({ message: `${m}: accepts images?`, initial: false });
		const reasoning = await ui.confirm({ message: `${m}: reasoning model?`, initial: false });
		models.push({ id: m, name: m, reasoning, input: image ? ["text", "image"] : ["text"], cost: { ...ZERO_COST }, contextWindow, maxTokens });
	}

	// Key auth: no apiKey here, the login below stores it in auth.json. No auth: pi counts a provider as configured
	// only with some key, so a keyless endpoint gets a placeholder (as pi's docs do for Ollama).
	const entry = { name, baseUrl, api, ...(auth === "none" ? { apiKey: "none" } : {}), models };
	const doc = readModelsJson(host.agentDir);
	doc.providers[id] = entry;
	// A credential left under this id (an endpoint removed before this fix, a hand edit) would win over the new auth.
	if (await clearCredential(host.models, id)) ui.log.info(`cleared a stored credential for ${id} left from an earlier endpoint`);
	writeModelsJson(host.agentDir, doc);
	// Set now, so a cancel at any later prompt still leaves the restart offer for the saved endpoint.
	const restartBefore = ctx.needsRestart;
	ctx.needsRestart = true;
	let next = await ctx.reloadHost();
	if (!next.models.getProvider(id)) {
		const why = next.diagnostics.map((d) => d.message).join("\n");
		ui.log.error(`${id} did not load${why ? `:\n${why}` : ""}`);
		await revertEndpoint(ctx, id, restartBefore);
		return;
	}

	if (key !== undefined) {
		for (;;) {
			try {
				const auth = authInteraction(ui);
				try {
					await next.models.login(id, "api_key", prefilledKey(auth, key));
				} finally {
					auth.close();
				}
				break;
			} catch (e) {
				const cancel = cancelOf(e);
				if (cancel) throw cancel;
				ui.log.error(`${id}: ${errorMessage(e)}`);
				const choice = await ui.select({
					message: "Saving the key failed",
					options: [
						{ value: "retry", label: "Retry" },
						{ value: "skip", label: "Skip" },
					],
					initial: "retry",
				});
				if (choice === "skip") {
					await revertEndpoint(ctx, id, restartBefore);
					return;
				}
				next = await ctx.host();
			}
		}
	}

	const model = next.models.getModel(id, ids[0]!);
	if (model && (await ui.confirm({ message: `Send a test request to ${id}/${model.id}?`, initial: true }))) {
		for (;;) {
			const spin = ui.spinner();
			spin.start(`Sending "Reply with OK" to ${id}/${model.id}`);
			try {
				const reply = await testCall(ctx, model);
				spin.stop("test request done");
				ui.log.success(`${id}/${model.id} replied: ${reply.slice(0, 200) || "(empty)"}`);
				break;
			} catch (e) {
				spin.stop("test request failed");
				ui.log.error(`${id}/${model.id}: ${errorMessage(e)}`);
				const choice = await retrySaveSkip(ctx, id);
				if (choice === "save") break;
				if (choice === "skip") {
					await revertEndpoint(ctx, id, restartBefore);
					return;
				}
			}
		}
	}
	ui.log.success(`added ${id} with ${ids.length} model${ids.length === 1 ? "" : "s"}`);
}

/**
 * Remove a compatible endpoint: refused while a role uses it. models.json may also hold a hand-written override of a
 * built-in id (`openrouter: { baseUrl }`); the credential then belongs to the built-in, which remains, so it stays.
 */
export async function removeEndpoint(ctx: SetupContext): Promise<void> {
	const { ui } = ctx;
	const host = await ctx.host();
	const doc = readModelsJson(host.agentDir);
	const ids = Object.keys(doc.providers);
	if (!ids.length) {
		ui.log.info("no compatible endpoints in models.json");
		return;
	}
	const id = await ui.select({
		message: "Remove which endpoint?",
		options: ids.map((x) => ({ value: x, label: x, hint: typeof doc.providers[x]?.baseUrl === "string" ? doc.providers[x].baseUrl : undefined })),
	});
	const paths = providersInUse(await ctx.settings()).get(id);
	if (paths?.length) {
		ui.log.error(inUseMessage(id, paths));
		return;
	}
	delete doc.providers[id];
	writeModelsJson(host.agentDir, doc);
	ctx.needsRestart = true;
	const next = await ctx.reloadHost();
	// Its stored key goes too: left behind, it would be sent to the next provider that takes this id.
	const keyRemoved = !next.models.getProvider(id) && (await clearCredential(next.models, id));
	ui.log.success(`removed ${id} from models.json${keyRemoved ? " and its key from auth.json" : ""}`);
}
