// Repo extension `github` (spec §3.2, §7): open (clone, or a local workspace before the repo exists), create (private,
// at first delivery), diff, merge. One git worktree per run. The GitHub identity (PAT, bot or App) is a setting HERE.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expandHome } from "../core/settings.ts";
import type { Diff, PrRef, RepoExtension, SettingField, StageCallOptions, Workspace } from "../core/types.ts";
import { git, gitOut } from "./git.ts";
import { GhApiHost, type GitHubHost, type Identity } from "./host.ts";

export const identitySchema: SettingField = {
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

export function identityOf(settings: Record<string, any>): Identity {
	return (settings.identity ?? {}) as Identity;
}

export function githubRepo(host: GitHubHost = new GhApiHost()): RepoExtension & { host: GitHubHost } {
	const meta = (workdir: string, runId: string) => join(workdir, "runs", `${runId}.json`);
	return {
		kind: "repo",
		name: "github",
		host,
		settings: {
			schema: {
				identity: identitySchema,
				visibility: { type: "enum", values: ["private", "public"], default: "private", description: "Visibility of repos the factory creates" },
				workdir: { type: "string", default: "~/factory/work", description: "Where clones and per-run worktrees live" },
			},
			validate(value) {
				const v = value as Record<string, any>;
				const id = v?.identity ?? {};
				const problems: string[] = [];
				if (id.kind === "app" && (!id.appId || !id.installationId || !id.privateKeyRef))
					problems.push("identity.kind app needs identity.appId, identity.installationId and identity.privateKeyRef");
				return problems;
			},
		},

		async open(ref: string, opts: StageCallOptions): Promise<Workspace> {
			const workdir = expandHome(opts.settings.workdir ?? "~/factory/work");
			const m = meta(workdir, opts.runId);
			if (existsSync(m)) {
				const ws = JSON.parse(readFileSync(m, "utf8")) as Workspace;
				if (existsSync(ws.path)) return ws;
			}
			const id = identityOf(opts.settings);
			const clone = join(workdir, "repos", ref.replace("/", "__"));
			const worktree = join(workdir, "runs", opts.runId);
			const branch = `factory/${opts.runId}`;
			const exists = await host.repoExists(ref, id);
			const auth = await host.gitAuth(id);
			let base: string;
			if (exists) {
				const def = await host.defaultBranch(ref, id);
				if (!existsSync(join(clone, ".git"))) {
					rmSync(clone, { recursive: true, force: true });
					mkdirSync(dirname(clone), { recursive: true });
					await git(dirname(clone), ["clone", "-q", host.remoteUrl(ref), clone], auth);
				} else {
					const remotes = await gitOut(clone, ["remote"]);
					if (!remotes.split("\n").includes("origin")) await git(clone, ["remote", "add", "origin", host.remoteUrl(ref)]);
					await git(clone, ["fetch", "-q", "origin", "--prune"], auth);
				}
				base = await gitOut(clone, ["rev-parse", `origin/${def}`]);
			} else {
				if (!existsSync(join(clone, ".git"))) {
					mkdirSync(clone, { recursive: true });
					await git(clone, ["init", "-q", "-b", "main"]);
					await git(clone, ["commit", "-q", "--allow-empty", "-m", "factory: initial commit"]);
				}
				base = await gitOut(clone, ["rev-parse", "main"]);
			}
			if (!existsSync(worktree)) {
				mkdirSync(dirname(worktree), { recursive: true });
				await git(clone, ["worktree", "prune"]);
				const has = await git(clone, ["rev-parse", "--verify", "-q", `refs/heads/${branch}`], { allowFail: true });
				await git(clone, has.code === 0 ? ["worktree", "add", "-q", worktree, branch] : ["worktree", "add", "-q", "-b", branch, worktree, base]);
			}
			const ws: Workspace = { repo: ref, path: worktree, baseRef: base, branch, newRepo: !exists };
			writeFileSync(m, JSON.stringify(ws, null, 2));
			return ws;
		},

		async create(ref: string, opts: StageCallOptions): Promise<void> {
			await host.createRepo(ref, { private: (opts.settings.visibility ?? "private") === "private" }, identityOf(opts.settings));
		},

		async diff(ws: Workspace, base: string, head?: string): Promise<Diff> {
			let patch: string;
			let stat: string;
			let names: string;
			if (head) {
				patch = await gitOut(ws.path, ["diff", base, head]);
				stat = await gitOut(ws.path, ["diff", "--stat", base, head]);
				names = await gitOut(ws.path, ["diff", "--name-status", base, head]);
			} else {
				// The working tree incl. uncommitted and untracked files, through a throwaway index (the real index is untouched).
				const index = join(ws.path, "..", `.${ws.branch.replace(/\//g, "_")}.diff-index`);
				rmSync(index, { force: true });
				const env = { GIT_INDEX_FILE: index };
				await git(ws.path, ["add", "-A"], { env });
				patch = (await git(ws.path, ["diff", "--cached", base], { env })).stdout;
				stat = (await git(ws.path, ["diff", "--cached", "--stat", base], { env })).stdout.trim();
				names = (await git(ws.path, ["diff", "--cached", "--name-status", base], { env })).stdout.trim();
				rmSync(index, { force: true });
			}
			const files = names
				.split("\n")
				.filter(Boolean)
				.map((l) => {
					const [status, ...p] = l.split("\t");
					return { status: status!, path: p.join("\t") };
				});
			return {
				base,
				head: head ?? (await gitOut(ws.path, ["rev-parse", "HEAD"])),
				files,
				stat,
				patch,
				fingerprint: createHash("sha256").update(patch).digest("hex"),
				empty: patch.length === 0,
			};
		},

		async merge(pr: PrRef, how, opts: StageCallOptions): Promise<void> {
			await host.mergePr(pr.repo, pr.number, how, identityOf(opts.settings));
		},

		async writeArtifact(ws: Workspace, path: string, content: string, message: string): Promise<void> {
			const file = join(ws.path, path);
			mkdirSync(dirname(file), { recursive: true });
			writeFileSync(file, content);
			await git(ws.path, ["add", "--", path]);
			const staged = await git(ws.path, ["diff", "--cached", "--quiet", "--", path], { allowFail: true });
			if (staged.code !== 0) await git(ws.path, ["commit", "-q", "-m", message, "--", path]);
		},
	};
}
