// Whether the bubblewrap sandbox can actually run here. Installed bwrap/socat is not enough: bwrap needs unprivileged user
// namespaces, which AppArmor (kernel.apparmor_restrict_unprivileged_userns=1, the Ubuntu 24.04+ default) or an enclosing
// sandbox can refuse. Then every sandboxed command fails, so the sandbox tests are skipped with the reason instead of
// failing. Set SF_REQUIRE_SANDBOX=1 (CI does) to run them anyway, so a broken sandbox fails the suite rather than skipping.
import { spawnSync } from "node:child_process";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";

function unavailable(): string | undefined {
	if (process.platform !== "linux") return `not Linux (${process.platform})`;
	const deps = SandboxManager.checkDependencies();
	if (deps.errors.length > 0) return deps.errors.join("; ");
	const p = spawnSync("bwrap", ["--unshare-user", "--unshare-net", "--dev-bind", "/", "/", "true"], { timeout: 5000, stdio: ["ignore", "ignore", "pipe"], encoding: "utf8" });
	if (p.error === undefined && p.status === 0) return undefined;
	const first = (p.stderr ?? "").split("\n").map((l) => l.trim()).find(Boolean);
	return `bwrap cannot create a user namespace: ${first ?? p.error?.message ?? `exit ${p.status}`}`;
}

const reason = unavailable();
const required = process.env.SF_REQUIRE_SANDBOX === "1";
if (reason !== undefined) console.warn(`[sandbox tests] ${required ? "SF_REQUIRE_SANDBOX=1, running anyway" : "skipped"}: ${reason}`);

/** True when the sandbox tests should run. */
export const sandboxAvailable = reason === undefined || required;
