// The run's pinned settings that agent tools need, written into each role Conversation (and the builder's helpers)
// when the core creates them. A tool reads them for the Conversation it runs in; outside a factory run they are empty.
import type { Context } from "@earendil-works/chord";
import { defineDoc } from "@earendil-works/pi-durable";

/** For the QA agent: which review it works in and where the core keeps its screenshots (outside every sandbox and VM). */
export type QaRunConfig = { seq: number; artifactsDir: string };

export const RunConfigDoc = defineDoc<{ runId?: string; webSearch: Record<string, any>; qa?: QaRunConfig }>({
	kind: "factory.runConfig",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ webSearch: {} }),
});

/** The pinned run settings for the Conversation a tool runs in (empty outside a factory run). */
export async function runConfigOf(
	api: { conversationId: unknown; snapshot: (doc: any, key: any, c: Context) => Promise<any> },
	c: Context,
): Promise<{ runId?: string; webSearch: Record<string, unknown>; qa?: QaRunConfig }> {
	const doc = (await api.snapshot(RunConfigDoc, api.conversationId, c)) as { runId?: string; webSearch?: Record<string, unknown>; qa?: QaRunConfig } | undefined;
	return { ...(doc?.runId ? { runId: doc.runId } : {}), webSearch: doc?.webSearch ?? {}, ...(doc?.qa ? { qa: doc.qa } : {}) };
}
