// Git helpers for the `GitHub` class (./github.ts). These run on the host, outside the sandbox, with
// repository hooks disabled, so nothing an agent planted in the worktree runs with the core's credentials.
import { execFile } from "node:child_process";

export interface GitResult {
	code: number;
	stdout: string;
	stderr: string;
}

const SAFE_ENV_KEYS = ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "USER", "SHELL", "TERM"];

/** Who a commit is authored and committed by: the GitHub account behind `github.identity` (never configured). */
export interface CommitIdentity {
	name: string;
	email: string;
}

/** The four git env vars that make `id` the author and the committer of a commit. */
export function identityEnv(id: CommitIdentity): Record<string, string> {
	return { GIT_AUTHOR_NAME: id.name, GIT_AUTHOR_EMAIL: id.email, GIT_COMMITTER_NAME: id.name, GIT_COMMITTER_EMAIL: id.email };
}

/** A safe environment for host-side commands. It carries no commit identity: commits pass theirs to `git()`. */
export function baseEnv(extra: Record<string, string> = {}): Record<string, string> {
	const env: Record<string, string> = {};
	for (const k of SAFE_ENV_KEYS) if (process.env[k] !== undefined) env[k] = process.env[k]!;
	return {
		...env,
		GIT_TERMINAL_PROMPT: "0",
		...extra,
	};
}

/** Subcommands that may create a commit: they need an explicit identity (never the operator's ~/.gitconfig). */
function createsCommit(args: string[]): boolean {
	const sub = args[0];
	if (sub === "commit" || sub === "commit-tree" || sub === "cherry-pick" || sub === "revert" || sub === "am" || sub === "pull" || sub === "rebase") return true;
	return sub === "merge" && !args.includes("--abort");
}

export function run(cmd: string, args: string[], opts: { cwd?: string; env?: Record<string, string>; input?: string; timeoutMs?: number } = {}): Promise<GitResult> {
	return new Promise((resolve) => {
		const child = execFile(
			cmd,
			args,
			{ cwd: opts.cwd, env: opts.env ?? baseEnv(), maxBuffer: 64 * 1024 * 1024, timeout: opts.timeoutMs ?? 10 * 60_000 },
			(error, stdout, stderr) => {
				const code = error ? (typeof (error as any).code === "number" ? (error as any).code : 1) : 0;
				resolve({ code, stdout: String(stdout), stderr: String(stderr) });
			},
		);
		if (opts.input !== undefined) {
			child.stdin?.write(opts.input);
			child.stdin?.end();
		}
	});
}

/**
 * git with hooks disabled and unsigned commits. `extraArgs` go before the subcommand (e.g. credential config). A
 * subcommand that creates a commit must be given its `identity` (author and committer); without one it throws, so a
 * commit never takes its identity from the operator's git config.
 */
export async function git(
	cwd: string,
	args: string[],
	opts: { env?: Record<string, string>; extraArgs?: string[]; allowFail?: boolean; identity?: CommitIdentity } = {},
): Promise<GitResult> {
	if (createsCommit(args) && !opts.identity) throw new Error(`git ${args.join(" ")}: no commit identity given (a host-side commit is authored by the GitHub identity)`);
	const r = await run("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...(opts.extraArgs ?? []), ...args], {
		cwd,
		env: baseEnv({ ...(opts.env ?? {}), ...(opts.identity ? identityEnv(opts.identity) : {}) }),
	});
	if (r.code !== 0 && !opts.allowFail) throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${r.stderr.trim() || r.stdout.trim()}`);
	return r;
}

export async function gitOut(cwd: string, args: string[]): Promise<string> {
	return (await git(cwd, args)).stdout.trim();
}
