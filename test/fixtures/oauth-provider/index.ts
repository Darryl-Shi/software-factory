// pi's extension loader aliases `@earendil-works/pi-ai` and `@earendil-works/pi-ai/compat` to its compat entry (see
// login-provider); `/compat` also typechecks here.
import { createProvider, openAICompletionsApi } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * A pi package that registers a provider with only an OAuth login shaped like pi-ai's built-in flows (anthropic,
 * openai-chatgpt, github-copilot, …): an auth URL, a pasted code, then a `progress` event as the last thing it emits.
 * The code `bad` makes the token exchange fail after that `progress` event.
 */
export default function (pi: ExtensionAPI) {
	pi.registerProvider(
		createProvider({
			id: "sf-oauth",
			name: "SF OAuth",
			auth: {
				oauth: {
					name: "SF OAuth (subscription)",
					login: async (i) => {
						i.notify({ type: "auth_url", url: "https://login.example/authorize" });
						const code = await i.prompt({ type: "manual_code", message: "Paste the code" });
						i.notify({ type: "progress", message: "Exchanging authorization code for tokens..." });
						if (code === "bad") throw new Error("token exchange failed");
						return { type: "oauth", access: `access-${code}`, refresh: "refresh", expires: Date.now() + 86_400_000 };
					},
					refresh: async (credential) => credential,
					toAuth: async (credential) => ({ apiKey: credential.access }),
				},
			},
			models: [
				{
					id: "m",
					name: "M",
					api: "openai-completions",
					provider: "sf-oauth",
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
