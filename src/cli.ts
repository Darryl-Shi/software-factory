#!/usr/bin/env node
// `factory` command. `factory serve` runs the process that owns the storage and the core; the web UI is the interface.
// `factory doctor` checks the setup and `factory web` prints the web UI link.

const argv = process.argv.slice(2);
const flags: Record<string, string | true> = {};
const pos: string[] = [];
for (let i = 0; i < argv.length; i++) {
	const a = argv[i]!;
	if (a.startsWith("--")) {
		const [k, v] = a.slice(2).split("=", 2) as [string, string | undefined];
		const bool = ["scripted", "help"].includes(k);
		flags[k] = v ?? (bool ? true : argv[++i] ?? "");
	} else pos.push(a);
}
const print = (v: unknown) => console.log(typeof v === "string" ? v : JSON.stringify(v, null, 2));

const HELP = `factory — software factory on Pi Durable

  factory serve [--config ~/.factory/config.yaml] [--fake-github dir] [--scripted]
  factory doctor [--config path]
  factory web [--config path]                    print the web UI link (with its access token)
`;

async function main() {
	const cmd = pos[0];
	if (!cmd || flags.help) return print(HELP);
	if (cmd === "serve") {
		const { startFactoryProcess } = await import("./main.ts");
		const { factory } = await startFactoryProcess({
			...(typeof flags.config === "string" ? { configPath: flags.config } : {}),
			...(typeof flags["fake-github"] === "string" ? { fakeGithub: flags["fake-github"] } : {}),
			...(typeof flags["ci-poll-ms"] === "string" ? { ciPollMs: Number(flags["ci-poll-ms"]) } : {}),
			scripted: !!flags.scripted || process.env.FACTORY_SCRIPTED === "1",
		});
		console.error(`[factory] serving (pid ${process.pid}); config ${factory.config.path}`);
		const stop = async () => {
			await factory.close().catch(() => {});
			process.exit(0);
		};
		process.on("SIGINT", stop);
		process.on("SIGTERM", stop);
		return;
	}
	if (cmd === "doctor") return doctor();
	if (cmd === "web") {
		const { existsSync, readFileSync: read } = await import("node:fs");
		const { dirname, join } = await import("node:path");
		const { expandHome } = await import("./core/settings.ts");
		const { DEFAULT_CONFIG } = await import("./main.ts");
		const file = join(dirname(expandHome(typeof flags.config === "string" ? flags.config : (process.env.FACTORY_CONFIG ?? DEFAULT_CONFIG))), "web-url");
		if (!existsSync(file)) throw new Error("the web UI isn't running: start `factory serve` (stages.interface.use must include web)");
		return print(read(file, "utf8").trim());
	}
	throw new Error(`unknown command ${cmd}\n\n${HELP}`);
}

async function doctor() {
	const { Factory } = await import("./core/core.ts");
	const { createModels, DEFAULT_CONFIG } = await import("./main.ts");
	const { SandboxManager } = await import("@anthropic-ai/sandbox-runtime");
	const { expandHome } = await import("./core/settings.ts");
	const { githubRepo } = await import("./github/repo.ts");
	const { githubDelivery } = await import("./github/delivery.ts");
	const { GhApiHost, resolveSecret } = await import("./github/host.ts");
	const { localWorktree } = await import("./sandbox/sandbox.ts");
	const { DEFAULT_WORKER_EXTENSIONS, DEFAULT_WORKER_SETTINGS } = await import("./agents/tools.ts");
	const { existsSync } = await import("node:fs");
	const configPath = expandHome(typeof flags.config === "string" ? flags.config : (process.env.FACTORY_CONFIG ?? DEFAULT_CONFIG));
	const models = await createModels(!!flags.scripted);
	const host = new GhApiHost();
	const f = new Factory({ configPath, models, extensions: [githubRepo(host), githubDelivery(host), localWorktree()], workerExtensions: DEFAULT_WORKER_EXTENSIONS, workerSettings: DEFAULT_WORKER_SETTINGS });
	const eff = existsSync(configPath) ? f.config.effective({ global: true }) : f.config.effective({ global: true }, { version: 1 });
	const line = (ok: boolean | "warn", s: string) => console.log(`${ok === true ? "ok  " : ok === "warn" ? "warn" : "FAIL"}  ${s}`);
	line(true, `config ${configPath}${existsSync(configPath) ? "" : " (missing: defaults)"}`);
	for (const role of ["architect", "builder", "helper", "reviewer"]) {
		const ref = String(eff.roles[role].model);
		const [p, ...rest] = ref.split("/");
		const known = !!models.getModel(p!, rest.join("/"));
		const available = known ? (await models.getAvailable(p!)).some((m) => m.id === rest.join("/")) : false;
		line(known && available ? true : known ? "warn" : false, `roles.${role}.model ${ref}: ${known ? (available ? "known, credentials configured" : "known, NO credentials configured") : "unknown model"}`);
	}
	const deps = SandboxManager.checkDependencies();
	line(deps.errors.length === 0, `sandbox runtime: ${deps.errors.join("; ") || "bubblewrap/socat present"}`);
	const id = eff.stages.repo.identity ?? {};
	const tokenOk = id.kind === "app" ? !!resolveSecret(id.privateKeyRef) : !!resolveSecret(id.tokenRef ?? "env:GH_TOKEN");
	line(tokenOk ? true : "warn", `GitHub identity (${id.kind ?? "pat"}): ${tokenOk ? "credential found" : `no credential at ${id.kind === "app" ? id.privateKeyRef : (id.tokenRef ?? "env:GH_TOKEN")}`}`);
	const { run } = await import("./github/git.ts");
	line((await run("gh", ["--version"])).code === 0 ? true : false, "gh CLI installed");
}

main().catch((e) => {
	console.error(`error: ${e instanceof Error ? e.message : e}`);
	process.exit(1);
});
