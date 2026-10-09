// Settings of worker extensions (`workers.<name>`), pinned per run like the rest of the config. The core writes the
// run's pinned values into each role Conversation (and the builder's helpers) when it creates them; a worker
// extension's tools read them for the Conversation they run in. This is the core's contract with worker extensions.
import type { Context } from "@earendil-works/chord";
import { defineDoc } from "@earendil-works/pi-durable";

export type WorkerSettingsState = { runId?: string; settings: { [name: string]: { [key: string]: any } } };

export const WorkerSettingsDoc = defineDoc<WorkerSettingsState>({
	kind: "factory.workers",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ settings: {} }),
});

/** The pinned settings of worker extension `name` for the Conversation a tool runs in (empty outside a factory run). */
export async function workerSettings(
	api: { conversationId: unknown; snapshot: (doc: any, key: any, c: Context) => Promise<any> },
	name: string,
	c: Context,
): Promise<{ runId?: string; settings: Record<string, unknown> }> {
	const doc = (await api.snapshot(WorkerSettingsDoc, api.conversationId, c)) as WorkerSettingsState | undefined;
	return { ...(doc?.runId ? { runId: doc.runId } : {}), settings: doc?.settings?.[name] ?? {} };
}
