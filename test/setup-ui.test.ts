// Setup UI layer (spec §3.2): pi-ai's login protocol mapped onto SetupUi; ScriptedUi for tests.
import { describe, expect, test } from "vitest";
import { authInteraction, SetupCancelled } from "../src/setup/ui.ts";
import { CANCEL, ScriptedUi, WAIT_FOR_ABORT } from "./setup-helpers.ts";

describe("authInteraction", () => {
	test("authInteraction maps secret→password, text→text, select→select (returns option id)", async () => {
		const seen: unknown[] = [];
		const ui = new ScriptedUi([
			"sk-123",
			"my-account",
			(o: { options: { value: string; label: string; hint?: string }[] }) => {
				seen.push(o.options);
				return "b";
			},
		]);
		const auth = authInteraction(ui);
		expect(await auth.prompt({ type: "secret", message: "API key" })).toBe("sk-123");
		expect(await auth.prompt({ type: "text", message: "Account", placeholder: "acct" })).toBe("my-account");
		const picked = await auth.prompt({
			type: "select",
			message: "Region",
			options: [
				{ id: "a", label: "Alpha" },
				{ id: "b", label: "Beta", description: "the second" },
			],
		});
		expect(picked).toBe("b");
		expect(seen).toEqual([
			[
				{ value: "a", label: "Alpha", hint: undefined },
				{ value: "b", label: "Beta", hint: "the second" },
			],
		]);
		expect(ui.shown.map((s) => [s.kind, s.message])).toEqual([
			["password", "API key"],
			["text", "Account"],
			["select", "Region"],
		]);
		expect(ui.shown[2].options).toEqual(["a", "b"]);
		expect(ui.remaining()).toBe(0);
	});

	test("manual_code is withdrawn when its signal aborts", async () => {
		const ui = new ScriptedUi([WAIT_FOR_ABORT]);
		const auth = authInteraction(ui);
		const ctrl = new AbortController();
		const pending = auth.prompt({ type: "manual_code", message: "Paste the code", signal: ctrl.signal });
		ctrl.abort();
		const err = await pending.then(
			() => undefined,
			(e: unknown) => e,
		);
		expect(err).toBeInstanceOf(Error);
		expect((err as Error).name).toBe("AbortError");
		expect(err).not.toBeInstanceOf(SetupCancelled);
	});

	test("auth_url and device_code become notes containing the URL / code and verificationUri", () => {
		const ui = new ScriptedUi([]);
		const auth = authInteraction(ui);
		auth.notify({ type: "auth_url", url: "https://login.example/authorize?x=1", instructions: "Sign in" });
		auth.notify({ type: "device_code", userCode: "ABCD-1234", verificationUri: "https://example/device" });
		const notes = ui.shown.filter((s) => s.kind === "note");
		expect(notes).toHaveLength(2);
		expect(notes[0].message).toBe("Open this URL");
		expect(notes[0].body).toContain("https://login.example/authorize?x=1");
		expect(notes[0].body).toContain("Sign in");
		expect(notes[1].body).toContain("ABCD-1234");
		expect(notes[1].body).toContain("https://example/device");
	});

	test("info lists links as label: url; progress drives one spinner, stopped by the next prompt or info", async () => {
		const ui = new ScriptedUi(["code"]);
		const auth = authInteraction(ui);
		auth.notify({ type: "progress", message: "Waiting for browser" });
		auth.notify({ type: "progress", message: "Still waiting" });
		await auth.prompt({ type: "text", message: "Code" });
		auth.notify({ type: "progress", message: "Exchanging token" });
		auth.notify({
			type: "info",
			message: "Logged in",
			links: [{ url: "https://docs.example", label: "Docs" }, { url: "https://plain.example" }],
		});
		expect(ui.shown.map((s) => [s.kind, s.message])).toEqual([
			["spinner", "start: Waiting for browser"],
			["spinner", "start: Still waiting"],
			["spinner", "stop: Still waiting"],
			["text", "Code"],
			["spinner", "start: Exchanging token"],
			["spinner", "stop: Exchanging token"],
			["note", ""],
		]);
		const body = ui.shown[6].body ?? "";
		expect(body).toContain("Logged in");
		expect(body).toContain("Docs: https://docs.example");
		expect(body).toContain("https://plain.example");
	});
});

describe("ScriptedUi", () => {
	test("ScriptedUi CANCEL throws SetupCancelled; exhausted answers throw with the message", async () => {
		const ui = new ScriptedUi([CANCEL]);
		await expect(ui.confirm({ message: "Continue?" })).rejects.toBeInstanceOf(SetupCancelled);
		await expect(ui.text({ message: "Name" })).rejects.toThrow('ScriptedUi: no answer for text "Name"');
	});

	test("validate rejections are shown and the next answer is used; exhaustion still throws", async () => {
		const ui = new ScriptedUi(["", "anthropic", "my-endpoint", ""]);
		const validate = (v: string) => (v === "" ? "required" : v === "anthropic" ? "collides with a built-in" : undefined);
		expect(await ui.text({ message: "Endpoint id", validate })).toBe("my-endpoint");
		await expect(ui.password({ message: "Key", validate })).rejects.toThrow('ScriptedUi: no answer for password "Key"');
		expect(ui.shown.map((s) => [s.kind, s.message])).toEqual([
			["text", "Endpoint id"],
			["validate", "required"],
			["validate", "collides with a built-in"],
			["password", "Key"],
			["validate", "required"],
		]);
		expect(ui.remaining()).toBe(0);
	});

	test("records notes and logs", () => {
		const ui = new ScriptedUi([]);
		ui.intro("factory setup");
		ui.note("body text", "Title");
		ui.log.info("i");
		ui.log.warn("w");
		ui.log.error("e");
		ui.log.success("s");
		ui.outro("done");
		expect(ui.shown).toEqual([
			{ kind: "intro", message: "factory setup" },
			{ kind: "note", message: "Title", body: "body text" },
			{ kind: "log.info", message: "i" },
			{ kind: "log.warn", message: "w" },
			{ kind: "log.error", message: "e" },
			{ kind: "log.success", message: "s" },
			{ kind: "outro", message: "done" },
		]);
	});
});
