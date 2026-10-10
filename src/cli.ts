#!/usr/bin/env node
// `factory` command. `factory serve` starts the process that owns the storage and the core (detached, unless
// --foreground); the web UI is the interface. `stop` and `status` manage it, `web` prints the web UI link and
// `doctor` checks the setup (src/doctor.ts) and `setup` runs the interactive setup wizard (src/setup/).

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

  factory serve [--config p] [--port n] [--fake-github dir] [--fake-boat dir] [--scripted] [--ci-poll-ms n] [--foreground]
  factory stop [--config p]
  factory status [--config p]
  factory web [--config p]          print the web UI's link
  factory doctor [--config p]
  factory setup [section] [--config p]
`;
const SERVE_FLAGS = ["config", "port", "fake-github", "fake-boat", "scripted", "ci-poll-ms", "foreground", "help"];
const SETUP_FLAGS = ["config", "help"];

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
	if (cmd === "setup") return setup();
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
			...(typeof flags["fake-boat"] === "string" ? ["--fake-boat", resolve(expandHome(flags["fake-boat"]))] : []),
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
			...(typeof flags["fake-boat"] === "string" ? { fakeBoat: flags["fake-boat"] } : {}),
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

/** `factory setup [section]`: refusals (option, section, not a TTY) come before anything is read or prompted. */
async function setup() {
	const unknown = Object.keys(flags).find((k) => !SETUP_FLAGS.includes(k));
	if (unknown) throw new Error(`unknown option --${unknown}`);
	if (pos.length > 2) throw new Error(`unexpected argument ${pos[2]}`);
	const section = pos[1];
	const { SECTIONS, createSetupContext } = await import("./setup/context.ts");
	if (section !== undefined && !(SECTIONS as readonly string[]).includes(section))
		throw new Error(`unknown section ${section}; sections: ${SECTIONS.join(", ")}`);
	if (!process.stdin.isTTY || !process.stdout.isTTY) {
		console.error("factory setup is interactive; run it in a terminal");
		process.exit(1);
	}
	const { runSetup } = await import("./setup/wizard.ts");
	const { ClackUi } = await import("./setup/ui.ts");
	process.exit(await runSetup(createSetupContext({ configPath: await configPath(), ui: new ClackUi() }), section));
}

async function doctor() {
	const { formatDoctorLine, runDoctorChecks } = await import("./doctor.ts");
	for (const l of await runDoctorChecks(await configPath(), { scripted: !!flags.scripted })) console.log(formatDoctorLine(l));
}

main().catch((e) => {
	console.error(`error: ${e instanceof Error ? e.message : e}`);
	process.exit(1);
});
