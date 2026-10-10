// Setup section "models" (spec §3.4): provider logins and logouts, pi provider packages, and compatible endpoints
// (endpoints.ts). Packages and models.json changes take effect at the factory's next start (`needsRestart`).
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AuthType } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ModelHost } from "../../models/host.ts";
import type { SetupContext, Step, StepStatus } from "../context.ts";
import { authInteraction } from "../ui.ts";
import {
	addEndpoint,
	cancelOf,
	errorMessage,
	inUseMessage,
	ModelsJsonError,
	providersInUse,
	removeEndpoint,
	roleProviders,
	writeJsonAtomic,
} from "./endpoints.ts";

export const TRUST_NOTE =
	"Packages are code that runs inside the factory process, outside the sandbox, with access to its credentials. Review the source before installing.";

type Action = "login" | "logout" | "install" | "remove-package" | "add-endpoint" | "remove-endpoint" | "done";

const ACTIONS: { value: Action; label: string }[] = [
	{ value: "login", label: "Log in to a provider" },
	{ value: "logout", label: "Log out of a provider" },
	{ value: "install", label: "Install a provider package" },
	{ value: "remove-package", label: "Remove a provider package" },
	{ value: "add-endpoint", label: "Add a compatible endpoint (models.json)" },
	{ value: "remove-endpoint", label: "Remove a compatible endpoint" },
	{ value: "done", label: "Done" },
];

// ---------------------------------------------------------------- package → providers record

/** `<agentDir>/factory-packages.json`: `{ "<source as in settings.json>": ["<providerId>", …] }`, written at install. */
const recordPath = (agentDir: string) => join(agentDir, "factory-packages.json");

function readPackageProviders(agentDir: string): Record<string, string[]> {
	const path = recordPath(agentDir);
	if (!existsSync(path)) return {};
	const v: unknown = JSON.parse(readFileSync(path, "utf8"));
	return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, string[]>) : {};
}

function writePackageProviders(agentDir: string, record: Record<string, string[]>): void {
	writeJsonAtomic(recordPath(agentDir), record, 0o600);
}

// ---------------------------------------------------------------- logins

function authHint(s: ReturnType<ModelRuntime["getProviderAuthStatus"]>): string {
	if (!s.configured) return "not configured";
	return s.source ? `configured (${s.source})` : "configured";
}

/** Logs in to `id` (choosing API key or OAuth when it has both) and confirms with checkAuth. False when skipped. */
async function login(ctx: SetupContext, id: string): Promise<boolean> {
	const { ui } = ctx;
	const provider = (await ctx.host()).models.getProvider(id);
	if (!provider) {
		ui.log.error(`${id} is not a known provider`);
		return false;
	}
	const methods: AuthType[] = [];
	if (provider.auth.apiKey?.login) methods.push("api_key");
	if (provider.auth.oauth) methods.push("oauth");
	if (!methods.length) {
		ui.log.warn(`${id} has no login; it reads its credentials from the environment`);
		return false;
	}
	const oauth = provider.auth.oauth;
	const type =
		methods.length === 1
			? methods[0]!
			: await ui.select<AuthType>({
					message: `How do you want to log in to ${id}?`,
					options: [
						{ value: "api_key", label: "API key" },
						{ value: "oauth", label: "Subscription (OAuth)", hint: oauth?.loginLabel ?? oauth?.name },
					],
				});
	for (;;) {
		try {
			const models = (await ctx.host()).models;
			await models.login(id, type, authInteraction(ui));
			const check = await models.checkAuth(id);
			if (!check) throw new Error("the login finished, but no credentials resolve");
			ui.log.success(`${id}: logged in (${check.source ?? check.type})`);
			return true;
		} catch (e) {
			const cancel = cancelOf(e);
			if (cancel) throw cancel;
			ui.log.error(`${id}: ${errorMessage(e)}`);
			const choice = await ui.select({
				message: `Logging in to ${id} failed`,
				options: [
					{ value: "retry", label: "Retry" },
					{ value: "skip", label: "Skip" },
				],
				initial: "retry",
			});
			if (choice === "skip") return false;
		}
	}
}

/** Log in: every provider, those the roles use first, each with its auth status. */
async function chooseAndLogin(ctx: SetupContext): Promise<void> {
	const models = (await ctx.host()).models;
	const all = models.getProviders().map((p) => p.id);
	const used = [...providersInUse(await ctx.settings()).keys()].filter((id) => all.includes(id));
	const ids = [...used, ...all.filter((id) => !used.includes(id))];
	const id = await ctx.ui.select({
		message: "Log in to",
		options: ids.map((x) => ({ value: x, label: x, hint: authHint(models.getProviderAuthStatus(x)) })),
	});
	await login(ctx, id);
}

async function logout(ctx: SetupContext): Promise<void> {
	const { ui } = ctx;
	const models = (await ctx.host()).models;
	const stored = await models.listCredentials();
	if (!stored.length) {
		ui.log.info("no stored credentials");
		return;
	}
	const id = await ui.select({
		message: "Log out of",
		options: stored.map((c) => ({ value: c.providerId, label: c.providerId, hint: c.type === "oauth" ? "OAuth" : "API key" })),
	});
	const paths = providersInUse(await ctx.settings()).get(id);
	if (paths?.length && !(await ui.confirm({ message: `${id} is used by ${paths.join(", ")}; log out anyway?`, initial: false }))) return;
	await models.logout(id);
	ui.log.success(`logged out of ${id}`);
}

// ---------------------------------------------------------------- packages

/** pi resolves a relative local source against its agent dir; the user means the directory setup runs in. */
function packageSource(typed: string, homedir: string): string {
	if (typed === "~" || typed.startsWith("~/")) return join(homedir, typed.slice(1));
	if (typed.startsWith("./") || typed.startsWith("../") || (!/^[a-z+]+:/i.test(typed) && existsSync(typed))) return resolve(typed);
	return typed;
}

function lastLines(s: string, n: number): string {
	return s.trimEnd().split("\n").slice(-n).join("\n");
}

/** The user-scope package sources in pi's settings.json, as pi stores them. */
function userSources(host: ModelHost): string[] {
	return host.packages
		.listConfiguredPackages()
		.filter((p) => p.scope === "user")
		.map((p) => p.source);
}

export type PackageChange = { kind: "new"; source: string } | { kind: "replaced"; source: string; old: string } | { kind: "unchanged" };

/**
 * What an install did to settings.json's user packages. pi's `addSourceToSettings` replaces an entry for the same
 * package in place (npm: same name, git: same host and path; `npm:foo@1` → `npm:foo@2`), appends a new one, or leaves
 * an identical one alone. pi exposes no public helper for its match key, so this compares the lists before and after.
 */
export function packageChange(before: readonly string[], after: readonly string[]): PackageChange {
	const added = after.filter((s) => !before.includes(s));
	const removed = before.filter((s) => !after.includes(s));
	if (!added.length) return { kind: "unchanged" };
	if (removed.length === 1) return { kind: "replaced", source: added[0]!, old: removed[0]! };
	return { kind: "new", source: added[0]! };
}

async function offerLogins(ctx: SetupContext, ids: readonly string[]): Promise<void> {
	for (const id of ids) if (await ctx.ui.confirm({ message: `Log in to ${id} now?`, initial: true })) await login(ctx, id);
}

async function installPackage(ctx: SetupContext): Promise<void> {
	const { ui } = ctx;
	const typed = (
		await ui.text({
			message: "Package source",
			placeholder: "npm:@scope/name, git:github.com/org/repo or a local path",
			validate: (v) => (v.trim() ? undefined : "required"),
		})
	).trim();
	const source = packageSource(typed, ctx.homedir);
	ui.note(TRUST_NOTE, "Provider packages");
	if (!(await ui.confirm({ message: `Install ${source}?`, initial: false }))) {
		ui.log.info("nothing installed");
		return;
	}

	const host = await ctx.host();
	// Providers registered by extensions (not the built-ins), so a package that extends an existing id counts too.
	const registeredBefore = new Set(host.models.getRegisteredProviderIds());
	const sourcesBefore = userSources(host);
	const diagnosticsBefore = new Set(host.diagnostics.map((d) => d.message));
	// A plain line, not a spinner: pi runs npm/git with the terminal inherited, which would garble an animation.
	ui.log.info(`Installing ${source}…`);
	try {
		await host.packages.installAndPersist(source); // throws before it records the source
	} catch (e) {
		ui.log.error(lastLines(errorMessage(e), 20));
		return;
	}
	// On disk and in settings.json from here on: a cancel at a later prompt still leaves the restart offer.
	const restartBefore = ctx.needsRestart;
	ctx.needsRestart = true;

	const next = await ctx.reloadHost();
	const change = packageChange(sourcesBefore, userSources(next));
	const registered = next.models.getRegisteredProviderIds();
	const fresh = registered.filter((id) => !registeredBefore.has(id));
	if (change.kind === "unchanged") {
		ui.log.info(`${source} was already installed`);
		return;
	}
	const record = readPackageProviders(next.agentDir);

	if (change.kind === "replaced") {
		// The same package at another version or ref: its record moves to the new source. It keeps the providers the
		// new version still registers, plus any it newly adds. Never offer removal here: the guard below would be skipped.
		const old = record[change.old];
		delete record[change.old];
		if (old) record[change.source] = [...old.filter((id) => registered.includes(id)), ...fresh.filter((id) => !old.includes(id))];
		writePackageProviders(next.agentDir, record);
		ui.log.success(`replaced ${change.old} with ${change.source}`);
		const dropped = old?.filter((id) => !registered.includes(id)) ?? [];
		if (dropped.length) ui.log.warn(`${change.source} no longer supplies ${dropped.join(", ")}`);
		await offerLogins(ctx, fresh);
		return;
	}

	if (fresh.length) {
		record[change.source] = fresh;
		writePackageProviders(next.agentDir, record);
		ui.log.success(`${source} added ${fresh.length === 1 ? "provider" : "providers"} ${fresh.join(", ")}`);
		await offerLogins(ctx, fresh);
		return;
	}

	ui.log.warn(`${source} registered no providers`);
	for (const d of next.diagnostics) if (!diagnosticsBefore.has(d.message)) ui.log.warn(d.message);
	if (await ui.confirm({ message: "Remove the package?", initial: true })) {
		const removed = await removeSource(ctx, change.source);
		if (removed === "removed") ctx.needsRestart = restartBefore; // settings.json is as before
		if (removed !== "failed") return;
	}
	// kept (or the removal failed): it loads at the next start
	record[change.source] = [];
	writePackageProviders(next.agentDir, record);
}

/**
 * `removeAndPersist`, then drops the package's record and reloads the host. `unmatched`: pi found no settings.json
 * entry for the source, so nothing was removed from the configuration.
 */
async function removeSource(ctx: SetupContext, source: string): Promise<"removed" | "unmatched" | "failed"> {
	const { ui } = ctx;
	const host = await ctx.host();
	ui.log.info(`Removing ${source}…`);
	let matched: boolean;
	try {
		matched = await host.packages.removeAndPersist(source);
	} catch (e) {
		ui.log.error(lastLines(errorMessage(e), 20));
		return "failed";
	}
	const record = readPackageProviders(host.agentDir);
	delete record[source];
	writePackageProviders(host.agentDir, record);
	await ctx.reloadHost();
	if (!matched) {
		ui.log.warn(`nothing in settings.json matched ${source}; nothing was removed`);
		return "unmatched";
	}
	ui.log.success(`removed ${source}`);
	return "removed";
}

/** Remove a provider package: refused while a role uses a provider it added. */
async function removePackage(ctx: SetupContext): Promise<void> {
	const { ui } = ctx;
	const host = await ctx.host();
	const pkgs = userSources(host);
	if (!pkgs.length) {
		ui.log.info("no provider packages installed");
		return;
	}
	const record = readPackageProviders(host.agentDir);
	const source = await ui.select({
		message: "Remove which package?",
		options: pkgs.map((s) => ({ value: s, label: s, hint: record[s] ? record[s].join(", ") || "no providers" : "providers unknown" })),
	});
	const supplied = record[source];
	if (!supplied) {
		// installed outside setup: which providers it supplies is unknown, so the in-use guard can't run
		if (!(await ui.confirm({ message: `setup can't tell which providers ${source} supplies; remove it anyway?`, initial: false }))) return;
	} else {
		const inUse = providersInUse(await ctx.settings());
		const blocked = supplied.flatMap((id) => {
			const paths = inUse.get(id);
			return paths?.length ? [inUseMessage(id, paths)] : [];
		});
		if (blocked.length) {
			for (const m of blocked) ui.log.error(m);
			return;
		}
	}
	if ((await removeSource(ctx, source)) === "removed") ctx.needsRestart = true;
}

// ---------------------------------------------------------------- the step

async function status(ctx: SetupContext): Promise<StepStatus> {
	const models = (await ctx.host()).models;
	const ok: string[] = [];
	const missing: string[] = [];
	for (const id of roleProviders(await ctx.settings())) {
		const check = await models.checkAuth(id).catch(() => undefined);
		if (check) ok.push(`${id} (${check.source ?? check.type})`);
		else missing.push(id);
	}
	if (missing.length) return { state: "missing", detail: `no credentials for ${missing.join(", ")}` };
	return { state: "ok", detail: ok.join(", ") };
}

/** Runs an endpoint action; a models.json setup can't rewrite is reported and the menu comes back. */
async function editingModelsJson(ctx: SetupContext, action: (ctx: SetupContext) => Promise<void>): Promise<void> {
	try {
		await action(ctx);
	} catch (e) {
		if (!(e instanceof ModelsJsonError)) throw e;
		ctx.ui.log.error(e.message);
	}
}

async function run(ctx: SetupContext): Promise<void> {
	for (;;) {
		const action = await ctx.ui.select({ message: "Model providers", options: ACTIONS });
		switch (action) {
			case "login":
				await chooseAndLogin(ctx);
				break;
			case "logout":
				await logout(ctx);
				break;
			case "install":
				await installPackage(ctx);
				break;
			case "remove-package":
				await removePackage(ctx);
				break;
			case "add-endpoint":
				await editingModelsJson(ctx, addEndpoint);
				break;
			case "remove-endpoint":
				await editingModelsJson(ctx, removeEndpoint);
				break;
			case "done":
				return;
		}
	}
}

export const step: Step = {
	name: "models",
	title: "Model providers",
	status,
	run,
};
