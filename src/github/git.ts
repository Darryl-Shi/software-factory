// Git helpers for the `GitHub` class (./github.ts). These run on the host, outside the sandbox, with
// repository hooks disabled, so nothing an agent planted in the worktree runs with the core's credentials.
import { execFile } from "node:child_process";

export interface GitResult {
	code: number;
	stdout: string;
	stderr: string;
}

const SAFE_ENV_KEYS = ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "USER", "SHELL", "TERM"];

export function baseEnv(extra: Record<string, string> = {}): Record<string, string> {
	const env: Record<string, string> = {};
	for (const k of SAFE_ENV_KEYS) if (process.env[k] !== undefined) env[k] = process.env[k]!;
	return {
		...env,
		GIT_TERMINAL_PROMPT: "0",
		GIT_AUTHOR_NAME: "software-factory",
		GIT_AUTHOR_EMAIL: "factory@localhost",
		GIT_COMMITTER_NAME: "software-factory",
		GIT_COMMITTER_EMAIL: "factory@localhost",
		...extra,
	};
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

/** git with hooks disabled and a fixed identity. `extraArgs` go before the subcommand (e.g. credential config). */
export async function git(cwd: string, args: string[], opts: { env?: Record<string, string>; extraArgs?: string[]; allowFail?: boolean } = {}): Promise<GitResult> {
	const r = await run("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...(opts.extraArgs ?? []), ...args], {
		cwd,
		env: baseEnv(opts.env),
	});
	if (r.code !== 0 && !opts.allowFail) throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${r.stderr.trim() || r.stdout.trim()}`);
	return r;
}

export async function gitOut(cwd: string, args: string[]): Promise<string> {
	return (await git(cwd, args)).stdout.trim();
}
