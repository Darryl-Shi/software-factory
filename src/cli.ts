#!/usr/bin/env node
// `factory` command. `factory serve` starts the process that owns the storage and the core (detached, unless
// --foreground); the web UI is the interface. `stop` and `status` manage it, `web` prints the web UI link and
// `doctor` checks the setup.

const argv = process.argv.slice(2);
const flags: Record<string, string | true> = {};
const pos: string[] = [];
for (let i = 0; i < argv.length; i++) {
	const a = argv[i]!;
	if (a.startsWith("--")) {
		const [k, v] = a.slice(2).split("=", 2) as [string, string | undefined];
		const bool = ["scripted", "help", "foreground"].includes(k);
		flags[k] = v ?? (bool ? true : argv[++i] ?? "");
	} else pos.push(a);
}
const print = (v: unknown) => console.log(typeof v === "string" ? v : JSON.stringify(v, null, 2));

const HELP = `factory — software factory on Pi Durable

  factory serve [--config p] [--port n] [--fake-github dir] [--scripted] [--ci-poll-ms n] [--foreground]
  factory stop [--config p]
  factory status [--config p]
  factory web [--config p]          print the web UI's link
  factory doctor [--config p]
`;
const SERVE_FLAGS = ["config", "port", "fake-github", "scripted", "ci-poll-ms", "foreground", "help"];

/** The config file's absolute path: --config, else $FACTORY_CONFIG, else ~/.factory/config.yaml. */
async function configPath(): Promise<string> {
	const { resolve } = await import("node:path");
	const { expandHome } = await import("./core/settings.ts");
	const { DEFAULT_CONFIG } = await import("./main.ts");
	return resolve(expandHome(typeof flags.config === "string" ? flags.config : (process.env.FACTORY_CONFIG ?? DEFAULT_CONFIG)));
}

async function main() {
	const cmd = pos[0];
	if (!cmd || flags.help) return print(HELP);
	if (cmd === "serve") return serve();
	if (cmd === "stop") {
		const { stopDaemon } = await import("./daemon.ts");
		return print(await stopDaemon(await configPath()));
	}
	if (cmd === "status" || cmd === "web") {
		const { readFileSync, existsSync } = await import("node:fs");
		const { daemonFiles, livePid } = await import("./daemon.ts");
		const config = await configPath();
		const pid = livePid(config);
		const url = existsSync(daemonFiles(config).url) ? readFileSync(daemonFiles(config).url, "utf8").trim() : undefined;
		if (cmd === "status") {
			if (pid === undefined) {
				print("not running");
				process.exit(1);
			}
			return print(`running (pid ${pid}) ${url ?? "(web UI not listening)"}`);
		}
		if (pid === undefined || url === undefined) {
			console.error("not running: start it with `factory serve`");
			process.exit(1);
		}
		return print(url);
	}
	if (cmd === "doctor") return doctor();
	throw new Error(`unknown command ${cmd}\n\n${HELP}`);
}

async function serve() {
	const unknown = Object.keys(flags).find((k) => !SERVE_FLAGS.includes(k));
	if (unknown) throw new Error(`unknown option --${unknown}`);
	const webPort = typeof flags.port === "string" ? (/^\d+$/.test(flags.port) ? Number(flags.port) : NaN) : undefined;
	if (webPort !== undefined && !(webPort >= 0 && webPort <= 65535))
		throw new Error(`--port: expected a port number from 0 to 65535, got ${flags.port}`);
	const { livePid, removePid, startDaemon, writePid } = await import("./daemon.ts");
	const config = await configPath();
	const running = livePid(config);
	if (running !== undefined) throw new Error(`already running (pid ${running})`);
	if (!flags.foreground) {
		const { resolve } = await import("node:path");
		const { expandHome } = await import("./core/settings.ts");
		const args = [
			...(webPort !== undefined ? ["--port", String(webPort)] : []),
			...(typeof flags["fake-github"] === "string" ? ["--fake-github", resolve(expandHome(flags["fake-github"]))] : []),
			...(flags.scripted ? ["--scripted"] : []),
			...(typeof flags["ci-poll-ms"] === "string" ? ["--ci-poll-ms", flags["ci-poll-ms"]] : []),
		];
		const { url } = await startDaemon(config, args);
		return print(url);
	}
	const { startFactoryProcess } = await import("./main.ts");
	let proc: Awaited<ReturnType<typeof startFactoryProcess>>;
	try {
		proc = await startFactoryProcess({
			configPath: config,
			...(webPort !== undefined ? { webPort } : {}),
			...(typeof flags["fake-github"] === "string" ? { fakeGithub: flags["fake-github"] } : {}),
			...(typeof flags["ci-poll-ms"] === "string" ? { ciPollMs: Number(flags["ci-poll-ms"]) } : {}),
			scripted: !!flags.scripted || process.env.FACTORY_SCRIPTED === "1",
		});
	} catch (e) {
		// One line: factory.log's last line is the reason `serve` reports.
		throw new Error(String(e instanceof Error ? e.message : e).split("\n")[0]);
	}
	writePid(config);
	console.error(`[factory] serving (pid ${process.pid}); config ${proc.factory.config.path}`);
	const stop = async () => {
		await proc.close().catch(() => {});
		removePid(config);
		process.exit(0);
	};
	process.on("SIGINT", stop);
	process.on("SIGTERM", stop);
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
	const { existsSync } = await import("node:fs");
	const configPath = expandHome(typeof flags.config === "string" ? flags.config : (process.env.FACTORY_CONFIG ?? DEFAULT_CONFIG));
	const models = await createModels(!!flags.scripted);
	const host = new GhApiHost();
	const f = new Factory({ configPath, models, extensions: [githubRepo(host), githubDelivery(host), localWorktree()] });
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
