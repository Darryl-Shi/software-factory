#!/usr/bin/env node
// `factory` command. `factory serve` runs the process that owns the storage and the core; every other command is the
// cli interface extension's client, talking to that process over its socket.
import { readFileSync } from "node:fs";
import { attach, Client, fieldAt, parseValue, renderItem, renderRun, respond, settingsMenu } from "./extensions/cli/client.ts";
import type { RunView, SettingField } from "./core/types.ts";

const argv = process.argv.slice(2);
const flags: Record<string, string | true> = {};
const pos: string[] = [];
for (let i = 0; i < argv.length; i++) {
	const a = argv[i]!;
	if (a.startsWith("--")) {
		const [k, v] = a.slice(2).split("=", 2) as [string, string | undefined];
		const bool = ["json", "no-input", "attach", "scripted", "help", "follow"].includes(k);
		flags[k] = v ?? (bool ? true : argv[++i] ?? "");
	} else pos.push(a);
}
const json = !!flags.json;
const project = typeof flags.project === "string" ? flags.project : undefined;
const scope = project ? { project } : { global: true };
const print = (v: unknown) => console.log(typeof v === "string" ? v : JSON.stringify(v, null, 2));

const HELP = `factory — software factory on Pi Durable

  factory serve [--config ~/.factory/config.yaml] [--socket path] [--fake-github dir] [--scripted]
  factory doctor [--config path]

  factory project create <name> --repo owner/name
  factory project list
  factory run <project> [--repo owner/name] [--title t] "<request>" [--attach]
  factory runs [--project p] [--json]
  factory status <run> [--json]
  factory attach <run> [--no-input]
  factory transcript <run> [architect|builder|reviewer|<conversationId>]
  factory answer <run> "<text>"                 answer the pending discussion question
  factory approve <run> <spec|delivery|merge>
  factory reject <run> <gate> "<feedback>"
  factory findings <run> <delivery|merge> '<json list of {severity, description, specRef?, evidence?}>'
  factory escalation <run> accept | more <N> | abort
  factory cancel <run> [reason]
  factory retry <run>
  factory settings [--project p]                 interactive menu (Policy · Roles · Stages)
  factory settings get <path> [--project p]
  factory settings set <path> <value> [--project p]
  factory settings unset <path> [--project p]
`;

async function main() {
	const cmd = pos[0];
	if (!cmd || flags.help) return print(HELP);
	if (cmd === "serve") {
		const { startFactoryProcess } = await import("./main.ts");
		const { factory } = await startFactoryProcess({
			...(typeof flags.config === "string" ? { configPath: flags.config } : {}),
			...(typeof flags.socket === "string" ? { socket: flags.socket } : {}),
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

	const client = await Client.connect(typeof flags.socket === "string" ? flags.socket : undefined);
	try {
		switch (cmd) {
			case "project": {
				if (pos[1] === "create") {
					const repo = flags.repo;
					if (!pos[2] || typeof repo !== "string") throw new Error("usage: factory project create <name> --repo owner/name");
					return print(json ? await client.call("createProject", pos[2], repo) : `project ${(await client.call("createProject", pos[2], repo)).name} → ${repo}`);
				}
				const ps = await client.call<any[]>("listProjects");
				return print(json ? ps : ps.map((p) => `${p.name}\t${p.repo}\t${Object.keys(p.overrides).length ? JSON.stringify(p.overrides) : ""}`).join("\n") || "(no projects)");
			}
			case "run": {
				const [_, name, ...rest] = pos;
				const body = rest.join(" ");
				if (!name || !body) throw new Error('usage: factory run <project> [--repo owner/name] "<request>"');
				if (typeof flags.repo === "string") await client.call("createProject", name, flags.repo); // shorthand: create + run
				const title = typeof flags.title === "string" ? flags.title : body.split("\n")[0]!.slice(0, 80);
				const run = await client.call<string>("startRun", name, { source: "cli", title, body });
				if (!flags.attach) return print(json ? { run } : run);
				print(`started ${run}`);
				await attach(client, run, { interactive: process.stdin.isTTY ?? false });
				return;
			}
			case "runs": {
				const rs = await client.call<RunView[]>("listRuns", project ? { project } : undefined);
				return print(json ? rs : rs.map((r) => `${r.id}\t${r.project}\t${r.state}${r.gate ? `(${r.gate})` : ""}\tround ${r.reviewRound}\t${r.request.title}`).join("\n") || "(no runs)");
			}
			case "status": {
				const v = await client.call<RunView>("getRun", need(pos[1], "run"));
				return print(json ? v : renderRun(v));
			}
			case "attach": {
				const v = await attach(client, need(pos[1], "run"), { interactive: !flags["no-input"] && (process.stdin.isTTY ?? false) });
				process.exitCode = v.state === "DELIVERED" ? 0 : v.state === "FAILED" ? 2 : 0;
				return;
			}
			case "transcript": {
				const v = await client.call<RunView>("getRun", need(pos[1], "run"));
				const which = pos[2] ?? "builder";
				const id = which === "architect" ? v.conversations.architect : which === "builder" ? v.conversations.builder : which === "reviewer" ? v.conversations.reviewers.at(-1)?.id : which;
				if (!id) throw new Error(`no ${which} conversation yet`);
				const show = async (cid: string, indent: string) => {
					const tr = await client.call<any>("getConversation", v.id, cid);
					if (json) return print(tr);
					console.log(`── ${tr.role ?? "conversation"} ${cid}${tr.busy ? " (busy)" : ""}`);
					for (const it of tr.items) {
						const s = renderItem(it, indent);
						if (s) console.log(s);
					}
					for (const h of tr.helpers) await show(h, indent + "    ");
				};
				await show(id, "");
				return;
			}
			case "answer": {
				const v = await client.call<RunView>("getRun", need(pos[1], "run"));
				if (v.pendingAsk?.question.kind !== "discussion") throw new Error("no discussion question is pending");
				await client.call("answer", v.id, v.pendingAsk.id, need(pos.slice(2).join(" "), "text"));
				return print("answered");
			}
			case "approve":
				await client.call("approve", need(pos[1], "run"), need(pos[2], "gate"));
				return print("approved");
			case "reject":
				await client.call("reject", need(pos[1], "run"), need(pos[2], "gate"), need(pos.slice(3).join(" "), "feedback"));
				return print("rejected");
			case "findings": {
				const raw = need(pos[3], "findings JSON");
				const list = JSON.parse(raw.startsWith("@") ? readFileSync(raw.slice(1), "utf8") : raw);
				await client.call("submitHumanFindings", need(pos[1], "run"), need(pos[2], "gate"), list);
				return print("findings submitted");
			}
			case "escalation": {
				const v = await client.call<RunView>("getRun", need(pos[1], "run"));
				await respond(client, v, pos.slice(2).join(" "));
				return print("resolved");
			}
			case "cancel":
				await client.call("cancelRun", need(pos[1], "run"), pos.slice(2).join(" ") || undefined);
				return print("cancelling");
			case "retry":
				await client.call("retryRun", need(pos[1], "run"));
				return print("retrying");
			case "settings": {
				const sub = pos[1];
				if (!sub) return settingsMenu(client, project);
				if (sub === "get") {
					const eff = await client.call<Record<string, { value: unknown; source: string }>>("getSettings", scope);
					if (!pos[2]) return print(json ? eff : Object.entries(eff).map(([k, e]) => `${k} = ${JSON.stringify(e.value)}  (${e.source})`).join("\n"));
					const hits = Object.entries(eff).filter(([k]) => k === pos[2] || k.startsWith(`${pos[2]}.`));
					if (!hits.length) throw new Error(`unknown setting: ${pos[2]}`);
					return print(json ? Object.fromEntries(hits) : hits.map(([k, e]) => `${hits.length > 1 ? `${k} = ` : ""}${typeof e.value === "string" ? e.value : JSON.stringify(e.value)}   (${e.source})`).join("\n"));
				}
				if (sub === "set") {
					const schema = await client.call<Record<string, SettingField>>("settingsSchema");
					const path = need(pos[2], "path");
					await client.call("setSetting", scope, path, parseValue(fieldAt(schema, path), need(pos.slice(3).join(" "), "value")));
					return print(`set ${path}${project ? ` for project ${project}` : ""}`);
				}
				if (sub === "unset") {
					await client.call("unsetSetting", scope, need(pos[2], "path"));
					return print(`unset ${pos[2]}${project ? ` for project ${project} (inherits again)` : ""}`);
				}
				throw new Error(`unknown settings command ${sub}`);
			}
			default:
				throw new Error(`unknown command ${cmd}\n\n${HELP}`);
		}
	} finally {
		client.close();
	}
}

function need(v: string | undefined, what: string): string {
	if (!v) throw new Error(`missing ${what}`);
	return v;
}

async function doctor() {
	const { Factory } = await import("./core/core.ts");
	const { createModels, DEFAULT_CONFIG } = await import("./main.ts");
	const { SandboxManager } = await import("@anthropic-ai/sandbox-runtime");
	const { expandHome } = await import("./core/settings.ts");
	const { githubRepo } = await import("./extensions/github/repo.ts");
	const { githubDelivery } = await import("./extensions/github/delivery.ts");
	const { GhApiHost, resolveSecret } = await import("./extensions/github/host.ts");
	const { localWorktree } = await import("./extensions/local-worktree/index.ts");
	const { cliInterface } = await import("./extensions/cli/server.ts");
	const { DEFAULT_WORKER_EXTENSIONS } = await import("./extensions/workers/index.ts");
	const { existsSync } = await import("node:fs");
	const configPath = expandHome(typeof flags.config === "string" ? flags.config : (process.env.FACTORY_CONFIG ?? DEFAULT_CONFIG));
	const models = await createModels(!!flags.scripted);
	const host = new GhApiHost();
	const f = new Factory({ configPath, models, extensions: [githubRepo(host), githubDelivery(host), localWorktree(), cliInterface()], workerExtensions: DEFAULT_WORKER_EXTENSIONS });
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
	const { run } = await import("./extensions/git.ts");
	line((await run("gh", ["--version"])).code === 0 ? true : false, "gh CLI installed");
}

main().catch((e) => {
	console.error(`error: ${e instanceof Error ? e.message : e}`);
	process.exit(1);
});
