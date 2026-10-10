// pi's extension loader aliases `@earendil-works/pi-ai` and `@earendil-works/pi-ai/compat` (not `…/api/*` subpaths)
// to its compat entry, which re-exports createProvider and the lazy API streams; `/compat` also typechecks here.
import { createProvider, openAICompletionsApi } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** A pi package that registers a native provider whose API-key auth has an interactive `login`. */
export default function (pi: ExtensionAPI) {
	pi.registerProvider(
		createProvider({
			id: "sf-login",
			name: "SF Login",
			auth: {
				apiKey: {
					name: "SF Login key",
					login: async (i) => ({ type: "api_key", key: await i.prompt({ type: "secret", message: "SF Login key" }) }),
					resolve: async ({ credential }) => (credential?.key ? { auth: { apiKey: credential.key }, source: "stored credential" } : undefined),
				},
			},
			models: [
				{
					id: "m",
					name: "M",
					api: "openai-completions",
					provider: "sf-login",
					baseUrl: "http://127.0.0.1:9/v1",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 1000,
					maxTokens: 100,
				},
			],
			api: openAICompletionsApi(),
		}),
	);
}
