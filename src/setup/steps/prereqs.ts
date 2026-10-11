// Setup section "prereqs" (spec §3.4): Node, git, gh and the sandbox runtime. For each missing tool it prints the
// install command for the detected package manager; it never runs an install and never uses sudo.
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { FactoryError } from "../../core/types.ts";
import type { SetupContext, Step, StepStatus } from "../context.ts";

type Tool = "git" | "gh" | "bubblewrap" | "socat" | "ripgrep";
type PackageManager = "apt" | "dnf" | "pacman" | "brew";

const DISABLE_SANDBOX = "Disable the sandbox (sandbox.enabled: false)? Agents' commands would run unconfined";
const SANDBOX = "sandbox runtime";

/** Package names that differ from the tool name, per package manager. */
const PACKAGE: Partial<Record<PackageManager, Partial<Record<Tool, string>>>> = {
	pacman: { gh: "github-cli" },
};

/** The install command for one tool; printed for the user, never run. */
export function installHint(tool: Tool, pm: PackageManager | undefined): string {
	const pkg = (pm && PACKAGE[pm]?.[tool]) ?? tool;
	switch (pm) {
		case "apt":
			return `sudo apt install ${pkg}`;
		case "dnf":
			return `sudo dnf install ${pkg}`;
		case "pacman":
			return `sudo pacman -S ${pkg}`;
		case "brew":
			return `brew install ${pkg}`;
		default:
			return `install ${pkg} with your package manager`;
	}
}

/** One missing prerequisite: the name shown in `status`, a line for the note, and the hint (if any). */
interface Missing {
	name: string;
	problem: string;
	tool?: Tool;
	sandbox: boolean;
}

/**
 * The tool an error says is absent, matching checkDependencies()'s exact messages. Other errors (`bubblewrap (bwrap)
 * not executable at <path>`, the uid-0/CAP_SETFCAP refusal) concern an installed tool and get no install hint.
 */
function notInstalled(error: string): Tool | undefined {
	if (error === "bubblewrap (bwrap) not installed") return "bubblewrap";
	if (error === "socat not installed") return "socat";
	if (/^ripgrep \(.+\) not found$/.test(error)) return "ripgrep";
	return undefined;
}

/** The sandbox runtime's errors: `SF_TEST_SANDBOX_DEPS` (a JSON array) in tests, else `checkDependencies()`. */
function sandboxErrors(ctx: SetupContext): string[] {
	const injected = ctx.env.SF_TEST_SANDBOX_DEPS;
	if (injected !== undefined) {
		const v: unknown = JSON.parse(injected);
		if (!Array.isArray(v)) throw new Error("SF_TEST_SANDBOX_DEPS must be a JSON array of strings");
		return v.map(String);
	}
	return SandboxManager.checkDependencies().errors;
}

async function present(ctx: SetupContext, cmd: string, args: string[]): Promise<boolean> {
	return (await ctx.run(cmd, args)).code === 0;
}

async function check(ctx: SetupContext): Promise<Missing[]> {
	const missing: Missing[] = [];
	const nodeMajor = Number(process.versions.node.split(".")[0]);
	if (nodeMajor < 22) missing.push({ name: "node", problem: `Node ${process.versions.node} is too old; install Node 22 or newer`, sandbox: false });
	if (!(await present(ctx, "git", ["--version"]))) missing.push({ name: "git", problem: "git not found", tool: "git", sandbox: false });
	if (!(await present(ctx, "gh", ["--version"]))) missing.push({ name: "gh", problem: "gh not found", tool: "gh", sandbox: false });
	for (const e of sandboxErrors(ctx)) {
		const tool = notInstalled(e);
		missing.push({ name: SANDBOX, problem: e, tool, sandbox: true });
	}
	if (ctx.platform === "darwin" && !(await present(ctx, "which", ["sandbox-exec"]))) {
		missing.push({ name: SANDBOX, problem: "sandbox-exec not found (it ships with macOS)", sandbox: true });
	}
	return missing;
}

/** The first of apt-get, dnf, pacman, brew found on the PATH. */
async function packageManager(ctx: SetupContext): Promise<PackageManager | undefined> {
	const candidates: [string, PackageManager][] = [
		["apt-get", "apt"],
		["dnf", "dnf"],
		["pacman", "pacman"],
		["brew", "brew"],
	];
	for (const [bin, pm] of candidates) if (await present(ctx, "which", [bin])) return pm;
	return undefined;
}

async function sandboxEnabled(ctx: SetupContext): Promise<boolean> {
	return (await ctx.settings()).effective({ global: true }).sandbox?.enabled !== false;
}

function names(missing: Missing[]): string[] {
	return [...new Set(missing.map((m) => m.name))];
}

async function status(ctx: SetupContext): Promise<StepStatus> {
	const missing = await check(ctx);
	if (missing.length === 0) return { state: "ok", detail: "node, git, gh and the sandbox runtime are present" };
	if (missing.every((m) => m.sandbox) && !(await sandboxEnabled(ctx))) {
		return { state: "warn", detail: "sandbox runtime missing; sandbox.enabled is false" };
	}
	return { state: "missing", detail: `missing: ${names(missing).join(", ")}` };
}

async function run(ctx: SetupContext): Promise<void> {
	const { ui } = ctx;
	let missing = await check(ctx);
	while (missing.length > 0) {
		const pm = await packageManager(ctx);
		const lines = missing.map((m) => `${m.name}: ${m.problem}${m.tool ? `\n  ${installHint(m.tool, pm)}` : ""}`);
		ui.note(lines.join("\n"), "Missing prerequisites (install them yourself, then check again)");
		const next = await ui.select({
			message: "Prerequisites",
			options: [
				{ value: "again", label: "Check again" },
				{ value: "continue", label: "Continue" },
			],
			initial: "again",
		});
		if (next === "continue") break;
		missing = await check(ctx);
	}
	if (missing.length === 0) {
		ui.log.success("all prerequisites present");
		return;
	}
	if (!missing.some((m) => m.sandbox) || !(await sandboxEnabled(ctx))) return;
	if (!(await ui.confirm({ message: DISABLE_SANDBOX, initial: false }))) return;
	try {
		(await ctx.settings()).set({ global: true }, "sandbox.enabled", false);
		ui.log.success("sandbox.enabled: false");
	} catch (e) {
		if (!(e instanceof FactoryError)) throw e;
		ui.log.error(e.message);
	}
}

export const step: Step = {
	name: "prereqs",
	title: "Prerequisites",
	status,
	run,
};
