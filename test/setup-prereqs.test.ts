// Setup section "prereqs" (spec §3.4): tool checks, printed install hints, and the sandbox-disable offer.
import { afterEach, describe, expect, it } from "vitest";
import { setDefaultSecretStore } from "../src/core/settings.ts";
import type { RunResult, SetupContext } from "../src/setup/context.ts";
import { installHint, step } from "../src/setup/steps/prereqs.ts";
import { testContext } from "./setup-context.ts";

const DISABLE = "Disable the sandbox (sandbox.enabled: false)? Agents' commands would run unconfined";

afterEach(() => setDefaultSecretStore(undefined));

/** A stub `run`: the listed commands (by `cmd` or `cmd arg0`) succeed, everything else is missing; every call is recorded. */
function stubRun(present: string[]): { run: SetupContext["run"]; calls: { cmd: string; args: string[] }[] } {
	const calls: { cmd: string; args: string[] }[] = [];
	const run = async (cmd: string, args: string[]): Promise<RunResult> => {
		calls.push({ cmd, args });
		const key = cmd === "which" ? `which ${args[0]}` : cmd;
		return present.includes(key) ? { code: 0, stdout: `${key} ok\n`, stderr: "" } : { code: 127, stdout: "", stderr: `${cmd}: not found` };
	};
	return { run, calls };
}

describe("prereqs", () => {
	it("missing socat prints the apt command and never runs it", async () => {
		const { run, calls } = stubRun(["git", "gh", "which apt-get"]);
		const { ctx, ui } = testContext({ answers: ["continue", false], run, env: { SF_TEST_SANDBOX_DEPS: JSON.stringify(["socat not installed"]) } });
		await step.run(ctx);
		const notes = ui.shown.filter((s) => s.kind === "note");
		expect(notes.length).toBe(1);
		expect(notes[0]!.body).toContain("sudo apt install socat");
		expect(calls.some((c) => c.cmd === "sudo" || c.cmd === "apt" || c.cmd === "apt-get")).toBe(false);
		expect(ui.remaining()).toBe(0);
		expect(await step.status(ctx)).toEqual({ state: "missing", detail: "missing: sandbox runtime" });
	});

	it("check again re-runs the checks and stops once everything is present", async () => {
		const { run } = stubRun(["git", "gh", "which dnf"]);
		const { ctx, ui } = testContext({
			answers: [
				() => {
					ctx.env.SF_TEST_SANDBOX_DEPS = "[]"; // the user installed bubblewrap
					return "again";
				},
			],
			run,
			env: { SF_TEST_SANDBOX_DEPS: JSON.stringify(["bubblewrap (bwrap) not installed"]) },
		});
		await step.run(ctx);
		const note = ui.shown.find((s) => s.kind === "note");
		expect(note?.body).toContain("sudo dnf install bubblewrap");
		expect(ui.shown.filter((s) => s.kind === "confirm")).toEqual([]);
		expect(ui.remaining()).toBe(0);
	});

	it("declining keeps the sandbox enabled; accepting writes sandbox.enabled: false", async () => {
		const sandboxMissing = { SF_TEST_SANDBOX_DEPS: JSON.stringify(["bubblewrap (bwrap) not installed", "socat not installed"]) };

		const declined = testContext({ answers: ["continue", false], run: stubRun(["git", "gh", "which apt-get"]).run, env: sandboxMissing });
		await step.run(declined.ctx);
		const confirm = declined.ui.shown.find((s) => s.kind === "confirm");
		expect(confirm?.message).toBe(DISABLE);
		expect((await declined.ctx.settings()).raw().sandbox).toBeUndefined();
		expect(await step.status(declined.ctx)).toEqual({ state: "missing", detail: "missing: sandbox runtime" });

		const accepted = testContext({ answers: ["continue", true], run: stubRun(["git", "gh", "which apt-get"]).run, env: sandboxMissing });
		await step.run(accepted.ctx);
		expect((await accepted.ctx.settings()).raw().sandbox).toEqual({ enabled: false });
		expect(accepted.ui.remaining()).toBe(0);
		expect((await step.status(accepted.ctx)).state).toBe("warn");
	});

	it("the confirm defaults to No", async () => {
		const asked: { message: string; initial?: boolean }[] = [];
		const { ctx } = testContext({
			answers: [
				"continue",
				(o: { message: string; initial?: boolean }) => {
					asked.push(o);
					return false;
				},
			],
			run: stubRun(["git", "gh"]).run,
			env: { SF_TEST_SANDBOX_DEPS: JSON.stringify(["socat not installed"]) },
		});
		await step.run(ctx);
		expect(asked).toHaveLength(1);
		expect(asked[0]!.message).toBe(DISABLE);
		expect(asked[0]!.initial).toBe(false);
		expect((await ctx.settings()).raw().sandbox).toBeUndefined();
	});

	it("a missing ripgrep gets its install hint", async () => {
		const { ctx, ui } = testContext({
			answers: ["continue", false],
			run: stubRun(["git", "gh", "which apt-get"]).run,
			env: { SF_TEST_SANDBOX_DEPS: JSON.stringify(["ripgrep (rg) not found"]) },
		});
		await step.run(ctx);
		const body = ui.shown.find((s) => s.kind === "note")!.body!;
		expect(body).toContain("sandbox runtime: ripgrep (rg) not found\n  sudo apt install ripgrep");
	});

	it("bwrap errors other than not installed are listed without an install hint", async () => {
		const errors = [
			"bubblewrap (bwrap) not executable at /opt/bwrap",
			"socat not executable at /opt/socat",
			"sandbox cannot run as root without CAP_SETFCAP (bubblewrap: setting up uid map: Permission denied)",
		];
		const { ctx, ui } = testContext({
			answers: ["continue", false],
			run: stubRun(["git", "gh", "which apt-get"]).run,
			env: { SF_TEST_SANDBOX_DEPS: JSON.stringify(errors) },
		});
		await step.run(ctx);
		const body = ui.shown.find((s) => s.kind === "note")!.body!;
		for (const e of errors) expect(body).toContain(`sandbox runtime: ${e}`);
		expect(body).not.toContain("sudo apt install");
		expect(ui.shown.some((s) => s.kind === "confirm" && s.message === DISABLE)).toBe(true);
	});

	it("all present → status ok", async () => {
		const { run } = stubRun(["git", "gh"]);
		const { ctx, ui } = testContext({ answers: [], run, env: { SF_TEST_SANDBOX_DEPS: "[]" } });
		expect(await step.status(ctx)).toEqual({ state: "ok", detail: "node, git, gh and the sandbox runtime are present" });
		await step.run(ctx);
		expect(ui.shown.filter((s) => s.kind === "note" || s.kind === "select" || s.kind === "confirm")).toEqual([]);
	});

	it("missing git and gh are listed with their hints; status names them", async () => {
		const { run, calls } = stubRun(["which pacman"]);
		const { ctx, ui } = testContext({ answers: ["continue"], run, env: { SF_TEST_SANDBOX_DEPS: "[]" } });
		expect(await step.status(ctx)).toEqual({ state: "missing", detail: "missing: git, gh" });
		await step.run(ctx);
		const body = ui.shown.find((s) => s.kind === "note")!.body!;
		expect(body).toContain("sudo pacman -S git");
		expect(body).toContain("sudo pacman -S github-cli");
		expect(ui.shown.filter((s) => s.kind === "confirm")).toEqual([]);
		expect(calls.some((c) => c.cmd === "sudo" || c.cmd === "pacman")).toBe(false);
	});

	it("on darwin a missing sandbox-exec counts as the sandbox runtime missing", async () => {
		const { run, calls } = stubRun(["git", "gh", "which brew"]);
		const { ctx } = testContext({ answers: [], run, platform: "darwin", env: { SF_TEST_SANDBOX_DEPS: "[]" } });
		expect(await step.status(ctx)).toEqual({ state: "missing", detail: "missing: sandbox runtime" });
		expect(calls).toContainEqual({ cmd: "which", args: ["sandbox-exec"] });

		const present = testContext({ answers: [], run: stubRun(["git", "gh", "which sandbox-exec"]).run, platform: "darwin", env: { SF_TEST_SANDBOX_DEPS: "[]" } });
		expect((await step.status(present.ctx)).state).toBe("ok");
	});

	it("a sandbox already disabled gives warn and is not asked again", async () => {
		const { ctx, ui } = testContext({
			answers: ["continue"],
			config: "version: 1\nsandbox:\n  enabled: false\n",
			run: stubRun(["git", "gh", "which apt-get"]).run,
			env: { SF_TEST_SANDBOX_DEPS: JSON.stringify(["socat not installed"]) },
		});
		expect(await step.status(ctx)).toEqual({ state: "warn", detail: "sandbox runtime missing; sandbox.enabled is false" });
		await step.run(ctx);
		expect(ui.shown.filter((s) => s.kind === "confirm")).toEqual([]);
		expect(ui.remaining()).toBe(0);
	});

	it("installHint covers each package manager", () => {
		expect(installHint("socat", "apt")).toBe("sudo apt install socat");
		expect(installHint("gh", "apt")).toBe("sudo apt install gh");
		expect(installHint("bubblewrap", "dnf")).toBe("sudo dnf install bubblewrap");
		expect(installHint("gh", "pacman")).toBe("sudo pacman -S github-cli");
		expect(installHint("git", "brew")).toBe("brew install git");
		for (const pm of ["dnf", "pacman", "brew"] as const) expect(installHint("ripgrep", pm)).toContain(" ripgrep");
		expect(installHint("ripgrep", "apt")).toBe("sudo apt install ripgrep");
		expect(installHint("gh", undefined)).toBe("install gh with your package manager");
	});
});
