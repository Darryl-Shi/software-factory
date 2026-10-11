// Setup UI layer (spec §3.2): the wizard talks to SetupUi; ClackUi renders it in the terminal,
// authInteraction adapts it to pi-ai's login protocol.
import * as clack from "@clack/prompts";
import type { AuthEvent, AuthInteraction, AuthPrompt } from "@earendil-works/pi-ai";

export interface SetupUi {
	intro(title: string): void;
	outro(msg: string): void;
	note(body: string, title?: string): void;
	log: { info(m: string): void; warn(m: string): void; error(m: string): void; success(m: string): void };
	text(o: { message: string; placeholder?: string; initial?: string; validate?: (v: string) => string | undefined; signal?: AbortSignal }): Promise<string>;
	password(o: { message: string; validate?: (v: string) => string | undefined; signal?: AbortSignal }): Promise<string>;
	select<T extends string>(o: { message: string; options: { value: T; label: string; hint?: string }[]; initial?: T; signal?: AbortSignal }): Promise<T>;
	multiselect<T extends string>(o: { message: string; options: { value: T; label: string; hint?: string }[]; initial?: T[]; required?: boolean }): Promise<T[]>;
	confirm(o: { message: string; initial?: boolean }): Promise<boolean>;
	spinner(): { start(m: string): void; stop(m: string): void };
}

/** Printed when the user cancels setup (spec §5). */
export const CANCEL_MESSAGE = "setup cancelled; completed sections were saved";

/** The user cancelled a prompt (Ctrl-C). */
export class SetupCancelled extends Error {
	constructor() {
		super("setup cancelled");
		this.name = "SetupCancelled";
	}
}

/** A prompt withdrawn through its signal rejects with the abort reason; anything else is the user cancelling. */
function cancelled(signal: AbortSignal | undefined): unknown {
	if (signal?.aborted) return signal.reason ?? new DOMException("Aborted", "AbortError");
	return new SetupCancelled();
}

function unwrap<T>(result: T, signal?: AbortSignal): Exclude<T, symbol> {
	if (clack.isCancel(result)) throw cancelled(signal);
	return result as Exclude<T, symbol>;
}

function validator(validate: ((v: string) => string | undefined) | undefined): ((v: string | undefined) => string | undefined) | undefined {
	return validate && ((v) => validate(v ?? ""));
}

export class ClackUi implements SetupUi {
	readonly log = {
		info: (m: string) => clack.log.info(m),
		warn: (m: string) => clack.log.warn(m),
		error: (m: string) => clack.log.error(m),
		success: (m: string) => clack.log.success(m),
	};

	intro(title: string): void {
		clack.intro(title);
	}

	outro(msg: string): void {
		clack.outro(msg);
	}

	note(body: string, title?: string): void {
		clack.note(body, title);
	}

	async text(o: Parameters<SetupUi["text"]>[0]): Promise<string> {
		const r = await clack.text({
			message: o.message,
			placeholder: o.placeholder,
			initialValue: o.initial,
			validate: validator(o.validate),
			signal: o.signal,
		});
		return unwrap(r, o.signal);
	}

	async password(o: Parameters<SetupUi["password"]>[0]): Promise<string> {
		const r = await clack.password({ message: o.message, validate: validator(o.validate), signal: o.signal });
		return unwrap(r, o.signal);
	}

	async select<T extends string>(o: { message: string; options: { value: T; label: string; hint?: string }[]; initial?: T; signal?: AbortSignal }): Promise<T> {
		const options = o.options.map((x) => ({ value: x.value, label: x.label, hint: x.hint })) as clack.Option<T>[];
		const r = await clack.select<T>({ message: o.message, options, initialValue: o.initial, signal: o.signal });
		return unwrap(r, o.signal);
	}

	async multiselect<T extends string>(o: { message: string; options: { value: T; label: string; hint?: string }[]; initial?: T[]; required?: boolean }): Promise<T[]> {
		const options = o.options.map((x) => ({ value: x.value, label: x.label, hint: x.hint })) as clack.Option<T>[];
		const r = await clack.multiselect<T>({ message: o.message, options, initialValues: o.initial, required: o.required });
		return unwrap(r);
	}

	async confirm(o: { message: string; initial?: boolean }): Promise<boolean> {
		const r = await clack.confirm({ message: o.message, initialValue: o.initial });
		return unwrap(r);
	}

	/**
	 * Starting a running spinner again updates its message. Ctrl-C while it runs ends setup with 130 and the cancel
	 * message (spec §5): in raw mode clack's block() calls process.exit(0), caught by the exit listener; otherwise
	 * clack's SIGINT handler only stops the spinner, so onCancel exits.
	 */
	spinner(): { start(m: string): void; stop(m: string): void } {
		const cancel = () => {
			process.removeListener("exit", onExit);
			s.cancel(clack.settings.messages.cancel);
			clack.log.warn(CANCEL_MESSAGE);
			process.exitCode = 130;
		};
		// Only a clean exit is a cancel; a crash keeps its own exit code.
		const onExit = (code: number) => {
			if (code === 0) cancel();
		};
		const s = clack.spinner({
			onCancel: () => {
				cancel();
				process.exit(130);
			},
		});
		let running = false;
		return {
			start(m: string) {
				if (running) return s.message(m);
				// Registered before clack's own exit listener, so the spinner line ends as cancelled.
				process.on("exit", onExit);
				s.start(m);
				running = true;
			},
			stop(m: string) {
				if (!running) return;
				process.removeListener("exit", onExit);
				s.stop(m);
				running = false;
			},
		};
	}
}

/**
 * An AuthInteraction for one login. `close()` stops the spinner a final `progress` event left running; call it in a
 * `finally` around the login, which may end (or fail) right after such an event.
 */
export type SetupAuthInteraction = AuthInteraction & { close(): void };

/** Adapts SetupUi to pi-ai's login protocol (spec §3.2). */
export function authInteraction(ui: SetupUi): SetupAuthInteraction {
	// `progress` events drive one lazily started spinner; it stops before anything else is shown. pi-ai's OAuth flows
	// emit `progress` last, so the caller ends it with close(): a ClackUi spinner left running turns exit 0 into 130.
	let spin: ReturnType<SetupUi["spinner"]> | undefined;
	let spinning: string | undefined;
	const settle = () => {
		if (spin && spinning !== undefined) spin.stop(spinning);
		spinning = undefined;
	};

	return {
		close: settle,

		async prompt(p: AuthPrompt): Promise<string> {
			settle();
			switch (p.type) {
				case "text":
					return ui.text({ message: p.message, placeholder: p.placeholder, signal: p.signal });
				case "secret":
					return ui.password({ message: p.message, signal: p.signal });
				case "select":
					return ui.select({
						message: p.message,
						options: p.options.map((o) => ({ value: o.id, label: o.label, hint: o.description })),
						signal: p.signal,
					});
				case "manual_code":
					// The signal withdraws the prompt when the browser callback wins the race.
					return ui.text({ message: p.message, placeholder: p.placeholder, signal: p.signal });
			}
		},

		notify(e: AuthEvent): void {
			if (e.type === "progress") {
				spin ??= ui.spinner();
				spin.start(e.message);
				spinning = e.message;
				return;
			}
			settle();
			switch (e.type) {
				case "info": {
					const links = (e.links ?? []).map((l) => (l.label ? `${l.label}: ${l.url}` : l.url));
					ui.note([e.message, ...links].join("\n"));
					return;
				}
				case "auth_url":
					ui.note(e.instructions ? `${e.url}\n\n${e.instructions}` : e.url, "Open this URL");
					return;
				case "device_code":
					ui.note(`Code: ${e.userCode}\nEnter it at: ${e.verificationUri}`, "Device login");
					return;
			}
		},
	};
}
