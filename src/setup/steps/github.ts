// Setup section "github" (spec §3.4): the identity the factory uses on GitHub (a PAT, a bot PAT or a GitHub App),
// verified before it is saved, and the visibility of the repos it creates. Secrets go to the secret store; the config
// only ever holds references (`store:github`, `store:github-app-key`, `env:GH_TOKEN`).
import { readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { resolveSecret } from "../../core/settings.ts";
import { FactoryError } from "../../core/types.ts";
import { GhApiHost, type Identity } from "../../github/host.ts";
import type { SetupContext, Step } from "../context.ts";
import { SetupCancelled } from "../ui.ts";

type Kind = "pat" | "bot" | "app";
type Visibility = "private" | "public";

/** What a credential flow collected: the identity to save and the secrets it references. */
interface Collected {
	identity: Identity;
	secrets: Record<string, string>;
}

const FINE_GRAINED_PERMISSIONS = [
	"Administration: read & write",
	"Contents: read & write",
	"Pull requests: read & write",
	"Workflows: read & write",
	"Checks and Commit statuses: read",
];

const required = (v: string) => (v.trim() ? undefined : "required");
const positiveInt = (v: string) => (/^[1-9]\d*$/.test(v.trim()) ? undefined : "must be a positive integer");
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** GhApiHost with a fixed token, so a credential is verified before anything is written. */
class TokenHost extends GhApiHost {
	constructor(private readonly fixed: string) {
		super();
	}
	override async token(): Promise<string> {
		return this.fixed;
	}
}

/** The ref that carries the identity's credential. */
function credentialRef(id: Identity): string | undefined {
	return id.kind === "app" ? id.privateKeyRef : (id.tokenRef ?? "env:GH_TOKEN");
}

function currentGithub(raw: Record<string, any>): { identity: Identity; visibility: Visibility } {
	return { identity: (raw.github?.identity ?? {}) as Identity, visibility: raw.github?.visibility === "public" ? "public" : "private" };
}

/** Retry / Save anyway / Skip after a failed check (spec §3.4, §5); Retry is the default. */
async function afterFailure(ctx: SetupContext, message = "Verification failed"): Promise<"retry" | "save" | "skip"> {
	return ctx.ui.select({
		message,
		options: [
			{ value: "retry", label: "Retry" },
			{ value: "save", label: "Save anyway" },
			{ value: "skip", label: "Skip" },
		],
		initial: "retry",
	});
}

/** Prechecks `gh`: false when the user skips while it is missing. */
async function ghPresent(ctx: SetupContext): Promise<boolean> {
	for (;;) {
		if ((await ctx.run("gh", ["--version"])).code === 0) return true;
		ctx.ui.log.error("gh CLI not found; run factory setup prereqs");
		const next = await ctx.ui.select({
			message: "Continue?",
			options: [
				{ value: "retry", label: "Retry" },
				{ value: "skip", label: "Skip" },
			],
			initial: "retry",
		});
		if (next === "skip") return false;
	}
}

/** Where the PAT comes from; the token is trimmed and stored as `store:github`, except the env choice. */
async function tokenCredential(ctx: SetupContext, kind: "pat" | "bot", current: Identity): Promise<{ collected: Collected; token: string }> {
	const options: { value: "paste" | "gh" | "env"; label: string; hint?: string }[] = [{ value: "paste", label: "Paste a token" }];
	const gh = await ctx.run("gh", ["auth", "token"]);
	const ghToken = gh.code === 0 ? gh.stdout.trim() : "";
	if (ghToken) options.push({ value: "gh", label: "Import from gh auth token", hint: "the token gh is logged in with" });
	const envToken = ctx.env.GH_TOKEN?.trim();
	if (envToken) options.push({ value: "env", label: "Keep env:GH_TOKEN", hint: "not seen by a service" });
	const source = await ctx.ui.select({
		message: "Where does the token come from?",
		options,
		initial: envToken && current.tokenRef === "env:GH_TOKEN" ? "env" : "paste",
	});
	if (source === "env") return { collected: { identity: { kind, tokenRef: "env:GH_TOKEN" }, secrets: {} }, token: envToken! };
	const token = source === "gh" ? ghToken : (await ctx.ui.password({ message: "GitHub token", validate: required })).trim();
	return { collected: { identity: { kind, tokenRef: "store:github" }, secrets: { github: token } }, token };
}

/**
 * Verifies a token with `GET /user` and lists a fine-grained token's permissions. When GitHub reports the token's
 * scopes (a classic `ghp_` token, a `gho_` token from gh), a missing `repo` or `workflow` scope is warned about and
 * the result is false.
 */
async function verifyToken(ctx: SetupContext, token: string): Promise<boolean> {
	const spin = ctx.ui.spinner();
	spin.start("Checking the token");
	let me: { login: string; scopes: string[] | undefined };
	try {
		me = await new TokenHost(token).whoami({});
	} finally {
		spin.stop("Checked the token");
	}
	ctx.ui.log.success(`Authenticated as ${me.login}`);
	if (token.startsWith("github_pat_"))
		ctx.ui.note(["A fine-grained token needs these repository permissions:", ...FINE_GRAINED_PERMISSIONS.map((p) => `- ${p}`)].join("\n"), "Fine-grained token");
	// A fine-grained token has permissions, not scopes (listed above), whatever the header says.
	if (!me.scopes || token.startsWith("github_pat_")) return true;
	let ok = true;
	if (!me.scopes.includes("repo")) {
		ctx.ui.log.warn("the token lacks the repo scope; the factory cannot create private repos or push");
		ok = false;
	}
	if (!me.scopes.includes("workflow")) {
		ctx.ui.log.warn("the token lacks the workflow scope; pushing changes to .github/workflows will fail");
		ok = false;
	}
	return ok;
}

/** Resolves a user-entered path: `~` against the user's home, relative paths against the working directory. */
function userPath(ctx: SetupContext, p: string): string {
	const t = p.trim();
	if (t === "~") return ctx.homedir;
	if (t.startsWith("~/")) return join(ctx.homedir, t.slice(2));
	return isAbsolute(t) ? t : resolve(t);
}

/** App id, installation id and the private key; the key's contents are stored as `store:github-app-key`. */
async function appCredential(ctx: SetupContext, current: Identity): Promise<{ collected: Collected; keyFile: string }> {
	const appId = Number((await ctx.ui.text({ message: "GitHub App ID", initial: current.appId?.toString(), validate: positiveInt })).trim());
	const installationId = Number(
		(await ctx.ui.text({ message: "Installation ID", initial: current.installationId?.toString(), validate: positiveInt })).trim(),
	);
	const pemPath = await ctx.ui.text({
		message: "Path to the App's private key (.pem)",
		validate: (v) => {
			if (!v.trim()) return "required";
			try {
				return readFileSync(userPath(ctx, v), "utf8").includes("PRIVATE KEY") ? undefined : "no PRIVATE KEY in this file";
			} catch {
				return `cannot read ${v.trim()}`;
			}
		},
	});
	const keyFile = userPath(ctx, pemPath);
	const key = readFileSync(keyFile, "utf8").trim();
	return {
		collected: { identity: { kind: "app", appId, installationId, privateKeyRef: "store:github-app-key" }, secrets: { "github-app-key": key } },
		keyFile,
	};
}

/** Verifies an App by minting an installation token; the key is read from the file, so nothing is stored yet. */
async function verifyApp(ctx: SetupContext, id: Identity, keyFile: string): Promise<boolean> {
	const spin = ctx.ui.spinner();
	spin.start("Minting an installation token");
	try {
		await new GhApiHost(ctx.env.SF_TEST_GITHUB_API || undefined).token({ ...id, privateKeyRef: `file:${keyFile}` });
	} finally {
		spin.stop("Minted an installation token");
	}
	ctx.ui.log.success(`GitHub App ${id.appId} can act on installation ${id.installationId}`);
	return true;
}

/** Collects and verifies a credential; undefined when the user skips. */
async function credential(ctx: SetupContext, kind: Kind, current: Identity): Promise<Collected | undefined> {
	for (;;) {
		let collected: Collected;
		/** True when verified; false (after warning) when the credential works but lacks a scope; throws on failure. */
		let verify: () => Promise<boolean>;
		if (kind === "app") {
			const app = await appCredential(ctx, current);
			collected = app.collected;
			verify = () => verifyApp(ctx, app.collected.identity, app.keyFile);
		} else {
			const pat = await tokenCredential(ctx, kind, current);
			collected = pat.collected;
			verify = () => verifyToken(ctx, pat.token);
		}
		// Only the check is guarded: a prompt's SetupCancelled (Ctrl-C) must propagate.
		let verified: boolean | Error;
		try {
			verified = await verify();
		} catch (e) {
			if (e instanceof SetupCancelled) throw e;
			verified = e instanceof Error ? e : new Error(message(e));
		}
		if (verified === true) return collected;
		if (verified instanceof Error) ctx.ui.log.error(verified.message);
		const next = verified === false ? await afterFailure(ctx, "The token is missing scopes") : await afterFailure(ctx);
		if (next === "save") return collected;
		if (next === "skip") return undefined;
		current = collected.identity;
	}
}

export const step: Step = {
	name: "github",
	title: "GitHub",
	async status(ctx) {
		const { identity } = (await ctx.settings()).effective({ global: true }).github as { identity: Identity };
		const ref = credentialRef(identity);
		if (!ref) return { state: "missing", detail: `${identity.kind}: privateKeyRef is not set` };
		return resolveSecret(ref, ctx.secrets) ? { state: "ok", detail: `${identity.kind} via ${ref}` } : { state: "missing", detail: `${ref} is not set` };
	},
	async run(ctx) {
		if (!(await ghPresent(ctx))) return;
		const current = currentGithub((await ctx.settings()).raw());
		const kind = await ctx.ui.select<Kind>({
			message: "GitHub identity",
			options: [
				{ value: "pat", label: "Personal access token", hint: "your account" },
				{ value: "bot", label: "Bot account token", hint: "a separate bot account" },
				{ value: "app", label: "GitHub App", hint: "an App installation" },
			],
			initial: current.identity.kind ?? "pat",
		});
		const collected = await credential(ctx, kind, current.identity.kind === kind ? current.identity : {});
		if (!collected) return;
		const visibility = await ctx.ui.select<Visibility>({
			message: "Visibility of repos the factory creates",
			options: [
				{ value: "private", label: "private" },
				{ value: "public", label: "public" },
			],
			initial: current.visibility,
		});
		// The config validates as a whole, so an unrelated problem (e.g. an unknown role model) can reject the save:
		// the secrets written for it are put back, and the remaining sections still run.
		const previous = Object.keys(collected.secrets).map((key) => [key, ctx.secrets.get(key)] as const);
		for (const [key, value] of Object.entries(collected.secrets)) ctx.secrets.set(key, value);
		const cfg = await ctx.settings();
		try {
			cfg.set({ global: true }, "github.identity", collected.identity);
			cfg.set({ global: true }, "github.visibility", visibility);
		} catch (e) {
			if (!(e instanceof FactoryError)) throw e;
			for (const [key, value] of previous) value === undefined ? ctx.secrets.delete(key) : ctx.secrets.set(key, value);
			ctx.ui.log.error(`${e.message}; fix the problem (e.g. factory setup roles), then run factory setup github`);
			return;
		}
		ctx.ui.log.success(`Saved github.identity (${kind}) and github.visibility (${visibility})`);
	},
};
