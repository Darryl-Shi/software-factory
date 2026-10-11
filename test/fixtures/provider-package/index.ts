import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/** A pi package that registers an OpenAI-compatible provider with one vision and one text-only model. */
export default function (pi: ExtensionAPI) {
	pi.registerProvider("sf-fixture", {
		baseUrl: "http://127.0.0.1:9/v1",
		apiKey: "SF_FIXTURE_KEY",
		api: "openai-completions",
		models: [
			{ id: "vision-1", name: "Vision 1", reasoning: false, input: ["text", "image"], cost, contextWindow: 1000, maxTokens: 100 },
			{ id: "text-1", name: "Text 1", reasoning: true, input: ["text"], cost, contextWindow: 1000, maxTokens: 100 },
		],
	});
}
