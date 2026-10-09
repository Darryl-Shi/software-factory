// Worker extension `web-search`: one `web_search` tool backed by Parallel's Search API (https://docs.parallel.ai).
// The tool runs in the factory process, not in the sandboxed environment, so the API key never reaches an agent's
// commands and api.parallel.ai needs no sandbox allowlist entry. Its settings live under `workers.web-search` and are
// pinned per run. Queries leave this machine and are kept in the transcript; drop the extension from
// `roles.<role>.extensions` for roles that must not search.
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import { resolveSecret } from "../core/settings.ts";
import type { SettingField } from "../core/types.ts";
import { workerSettings } from "../core/worker-settings.ts";

export const WEB_SEARCH_MODES = ["turbo", "fast", "basic", "advanced"] as const;
export const DEFAULT_ENDPOINT = "https://api.parallel.ai/v1/search";

export const webSearchSettings: { schema: Record<string, SettingField>; description: string } = {
	description: "web_search tool (Parallel Search API)",
	schema: {
		mode: { type: "enum", values: [...WEB_SEARCH_MODES], default: "fast", description: "Parallel search mode: turbo, fast (~1 s), basic or advanced (~3 s, highest quality)" },
		maxResults: { type: "number", default: 10, min: 1, max: 40, description: "Results per search" },
		maxCharsTotal: { type: "number", min: 1000, max: 200_000, description: "Optional cap on the excerpt characters of one search" },
		apiKey: { type: "secretRef", default: "env:PARALLEL_API_KEY", description: "Parallel API key (a reference, never the key)" },
		endpoint: { type: "string", default: DEFAULT_ENDPOINT, description: "Search endpoint" },
	},
};

export interface SearchInput {
	objective: string;
	queries: string[];
}

export interface SearchSettings {
	mode?: string;
	maxResults?: number;
	maxCharsTotal?: number;
	apiKey?: string;
	endpoint?: string;
}

export interface SearchOutput {
	text: string;
	details: { searchId: string; mode: string; count: number };
}

/** One call to Parallel's Search API, formatted for an agent. Throws with an actionable message on failure. */
export async function parallelSearch(input: SearchInput, s: SearchSettings, opts: { sessionId?: string; fetch?: typeof fetch; timeoutMs?: number } = {}): Promise<SearchOutput> {
	const objective = String(input.objective ?? "").trim();
	const queries = (input.queries ?? []).map((q) => String(q).trim()).filter(Boolean).slice(0, 5);
	if (!objective && queries.length === 0) throw new Error("web_search needs an objective and at least one query");
	if (queries.length === 0) queries.push(objective.slice(0, 200));
	const ref = s.apiKey ?? "env:PARALLEL_API_KEY";
	const key = resolveSecret(ref);
	if (!key) throw new Error(`web_search is not configured: no API key at ${ref} (workers.web-search.apiKey). Ask the operator to set it, or continue without searching.`);
	const mode = s.mode && (WEB_SEARCH_MODES as readonly string[]).includes(s.mode) ? s.mode : "fast";
	const body = {
		...(objective ? { objective } : {}),
		search_queries: queries,
		mode,
		...(s.maxCharsTotal ? { max_chars_total: s.maxCharsTotal } : {}),
		...(opts.sessionId ? { session_id: opts.sessionId.slice(0, 1000) } : {}),
		advanced_settings: { max_results: s.maxResults ?? 10 },
	};
	const res = await (opts.fetch ?? fetch)(s.endpoint || DEFAULT_ENDPOINT, {
		method: "POST",
		headers: { "content-type": "application/json", "x-api-key": key },
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
	});
	const raw = await res.text();
	let json: any;
	try {
		json = JSON.parse(raw);
	} catch {
		json = undefined;
	}
	if (!res.ok) {
		const why = json?.error?.message ?? json?.detail ?? raw.slice(0, 300);
		throw new Error(`Parallel search failed (HTTP ${res.status}): ${typeof why === "string" ? why : JSON.stringify(why)}`);
	}
	const results = (Array.isArray(json?.results) ? json.results : []) as { url: string; title?: string | null; publish_date?: string | null; excerpts?: string[] }[];
	const lines = [`${results.length} result${results.length === 1 ? "" : "s"} (${mode}) for: ${objective || queries.join("; ")}`];
	results.forEach((r, i) => {
		lines.push("", `${i + 1}. ${r.title?.trim() || r.url}`, `   ${r.url}${r.publish_date ? ` · ${r.publish_date}` : ""}`);
		for (const ex of r.excerpts ?? []) lines.push(...ex.trim().split("\n").map((l) => `   ${l}`));
	});
	const warnings = (Array.isArray(json?.warnings) ? json.warnings : []).map((w: any) => w?.message).filter(Boolean);
	if (warnings.length) lines.push("", `Warnings: ${warnings.join("; ")}`);
	return { text: lines.join("\n"), details: { searchId: String(json?.search_id ?? ""), mode, count: results.length } };
}

export function createWebSearch(opts: { fetch?: typeof fetch } = {}) {
	return defineExtension({
		name: "web-search",
		tools: [
			defineTool({
				name: "web_search",
				description:
					"Search the web for current documentation, APIs, versions and error messages. Give a self-contained objective and 1-5 short keyword queries (3-6 words each); the queries run in parallel and come back as ranked results with excerpts.",
				parameters: Type.Object({
					objective: Type.String({ description: "What you want to find out, in one or two sentences" }),
					queries: Type.Array(Type.String(), { minItems: 1, maxItems: 5, description: "Keyword queries, 3-6 words each" }),
				}),
				replay: "safe",
				execute: async (args, api, c) => {
					const { runId, settings } = await workerSettings(api as any, "web-search", c);
					const out = await parallelSearch(args, settings as SearchSettings, { ...(runId ? { sessionId: runId } : {}), ...(opts.fetch ? { fetch: opts.fetch } : {}) });
					return { content: [{ type: "text", text: out.text }], details: out.details };
				},
			}),
		],
		sections: [
			section(
				"web-search",
				() => "web_search searches the web. Use it for facts you can't read from the repo (library docs, API changes, error messages). Queries leave this machine; never put secrets or private code in them.",
			),
		],
	});
}

export const WebSearch = createWebSearch();
