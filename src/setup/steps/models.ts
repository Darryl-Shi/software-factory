// Setup section "models" (spec §3.4): provider logins and logouts, pi provider packages, and compatible endpoints
// (endpoints.ts). Packages and models.json changes take effect at the factory's next start (`needsRestart`).
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AuthType } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { SetupContext, Step, StepStatus } from "../context.ts";
import { authInteraction } from "../ui.ts";
import { addEndpoint, errorMessage, inUseMessage, isCancel, providersInUse, removeEndpoint, roleProviders, writeJsonAtomic } from "./endpoints.ts";

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
			if (isCancel(e)) throw e;
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
	const providersBefore = new Set(host.models.getProviders().map((p) => p.id));
	const sourcesBefore = new Set(host.packages.listConfiguredPackages().map((p) => p.source));
	const diagnosticsBefore = new Set(host.diagnostics.map((d) => d.message));
	const spin = ui.spinner();
	spin.start(`Installing ${source}`);
	try {
		await host.packages.installAndPersist(source); // throws before it records the source
	} catch (e) {
		spin.stop("install failed");
		ui.log.error(lastLines(errorMessage(e), 20));
		return;
	}
	spin.stop(`installed ${source}`);

	const next = await ctx.reloadHost();
	const pkg = next.packages.listConfiguredPackages().find((p) => p.scope === "user" && !sourcesBefore.has(p.source));
	if (!pkg) {
		ui.log.info(`${source} was already installed`);
		return;
	}
	const added = next.models.getProviders().map((p) => p.id).filter((id) => !providersBefore.has(id));
	if (added.length) {
		const record = readPackageProviders(next.agentDir);
		record[pkg.source] = added;
		writePackageProviders(next.agentDir, record);
		ctx.needsRestart = true;
		ui.log.success(`${source} added ${added.length === 1 ? "provider" : "providers"} ${added.join(", ")}`);
		for (const id of added) if (await ui.confirm({ message: `Log in to ${id} now?`, initial: true })) await login(ctx, id);
		return;
	}

	ui.log.warn(`${source} registered no providers`);
	for (const d of next.diagnostics) if (!diagnosticsBefore.has(d.message)) ui.log.warn(d.message);
	if ((await ui.confirm({ message: "Remove the package?", initial: true })) && (await removeSource(ctx, pkg.source))) return;
	// kept (or the removal failed): it loads at the next start
	const record = readPackageProviders(next.agentDir);
	record[pkg.source] = [];
	writePackageProviders(next.agentDir, record);
	ctx.needsRestart = true;
}

/** `removeAndPersist`, then drops the package's record and reloads the host. False when the removal failed. */
async function removeSource(ctx: SetupContext, source: string): Promise<boolean> {
	const { ui } = ctx;
	const host = await ctx.host();
	const spin = ui.spinner();
	spin.start(`Removing ${source}`);
	try {
		await host.packages.removeAndPersist(source);
	} catch (e) {
		spin.stop("remove failed");
		ui.log.error(lastLines(errorMessage(e), 20));
		return false;
	}
	spin.stop("removed");
	const record = readPackageProviders(host.agentDir);
	delete record[source];
	writePackageProviders(host.agentDir, record);
	await ctx.reloadHost();
	ui.log.success(`removed ${source}`);
	return true;
}

/** Remove a provider package: refused while a role uses a provider it added. */
async function removePackage(ctx: SetupContext): Promise<void> {
	const { ui } = ctx;
	const host = await ctx.host();
	const pkgs = host.packages.listConfiguredPackages().filter((p) => p.scope === "user");
	if (!pkgs.length) {
		ui.log.info("no provider packages installed");
		return;
	}
	const record = readPackageProviders(host.agentDir);
	const source = await ui.select({
		message: "Remove which package?",
		options: pkgs.map((p) => ({ value: p.source, label: p.source, hint: record[p.source]?.join(", ") || undefined })),
	});
	const inUse = providersInUse(await ctx.settings());
	for (const id of record[source] ?? []) {
		const paths = inUse.get(id);
		if (paths?.length) {
			ui.log.error(inUseMessage(id, paths));
			return;
		}
	}
	if (await removeSource(ctx, source)) ctx.needsRestart = true;
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
				await addEndpoint(ctx);
				break;
			case "remove-endpoint":
				await removeEndpoint(ctx);
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
