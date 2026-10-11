// ScriptedUi: a SetupUi that pops queued answers and records everything shown (spec §3.2, §6).
import { SetupCancelled, type SetupUi } from "../src/setup/ui.ts";

/** Answer that makes the prompt throw SetupCancelled, like Ctrl-C. */
export const CANCEL = Symbol("CANCEL");
/** Answer that leaves the prompt pending until its signal aborts, then rejects with the abort reason. */
export const WAIT_FOR_ABORT = Symbol("WAIT_FOR_ABORT");

export interface Shown {
	kind: string;
	message: string;
	options?: string[];
	body?: string;
}

/**
 * A SetupUi for tests: each prompt shifts one queued answer, and everything shown is recorded in `shown`.
 *
 * Answers: a plain value is returned as is; a function is called with the prompt options and its result is used;
 * `CANCEL` throws SetupCancelled; `WAIT_FOR_ABORT` rejects when the prompt's signal aborts. When the answers run out,
 * the prompt throws `ScriptedUi: no answer for <kind> "<message>"`.
 *
 * Like clack, `text` and `password` re-prompt while `validate` rejects the answer: each rejection is recorded as
 * `validate` and the next answer is shifted.
 *
 * `shown` kinds, in order of occurrence (`message` is the prompt message unless noted):
 * - `text`, `password`, `confirm`: one entry per prompt (not per re-prompt);
 * - `select`, `multiselect`: also `options`, the option values;
 * - `validate`: `message` is the validation message;
 * - `note`: `message` is the title ("" when absent), `body` the note body;
 * - `log.info`, `log.warn`, `log.error`, `log.success`, `intro`, `outro`: `message` is the text;
 * - `spinner`: `message` is `start: <m>` or `stop: <m>`.
 */
export class ScriptedUi implements SetupUi {
	readonly shown: Shown[] = [];
	private readonly answers: unknown[];

	readonly log = {
		info: (m: string) => this.record("log.info", m),
		warn: (m: string) => this.record("log.warn", m),
		error: (m: string) => this.record("log.error", m),
		success: (m: string) => this.record("log.success", m),
	};

	constructor(answers: unknown[]) {
		this.answers = [...answers];
	}

	/** How many queued answers have not been used. */
	remaining(): number {
		return this.answers.length;
	}

	intro(title: string): void {
		this.record("intro", title);
	}

	outro(msg: string): void {
		this.record("outro", msg);
	}

	note(body: string, title?: string): void {
		this.shown.push({ kind: "note", message: title ?? "", body });
	}

	text(o: Parameters<SetupUi["text"]>[0]): Promise<string> {
		return this.ask("text", o) as Promise<string>;
	}

	password(o: Parameters<SetupUi["password"]>[0]): Promise<string> {
		return this.ask("password", o) as Promise<string>;
	}

	select<T extends string>(o: { message: string; options: { value: T; label: string; hint?: string }[]; initial?: T; signal?: AbortSignal }): Promise<T> {
		return this.ask("select", o, o.options.map((x) => x.value)) as Promise<T>;
	}

	multiselect<T extends string>(o: { message: string; options: { value: T; label: string; hint?: string }[]; initial?: T[]; required?: boolean }): Promise<T[]> {
		return this.ask("multiselect", o, o.options.map((x) => x.value)) as Promise<T[]>;
	}

	confirm(o: { message: string; initial?: boolean }): Promise<boolean> {
		return this.ask("confirm", o) as Promise<boolean>;
	}

	spinner(): { start(m: string): void; stop(m: string): void } {
		return {
			start: (m: string) => this.record("spinner", `start: ${m}`),
			stop: (m: string) => this.record("spinner", `stop: ${m}`),
		};
	}

	private record(kind: string, message: string): void {
		this.shown.push({ kind, message });
	}

	private async ask(
		kind: string,
		o: { message: string; signal?: AbortSignal; validate?: (v: string) => string | undefined },
		options?: string[],
	): Promise<unknown> {
		this.shown.push(options ? { kind, message: o.message, options } : { kind, message: o.message });
		for (;;) {
			if (this.answers.length === 0) throw new Error(`ScriptedUi: no answer for ${kind} "${o.message}"`);
			const next = this.answers.shift();
			const answer = typeof next === "function" ? await next(o) : next;
			if (answer === CANCEL) throw new SetupCancelled();
			if (answer === WAIT_FOR_ABORT) return waitForAbort(kind, o);
			const invalid = typeof answer === "string" ? o.validate?.(answer) : undefined;
			if (invalid === undefined) return answer;
			this.shown.push({ kind: "validate", message: invalid });
		}
	}
}

function waitForAbort(kind: string, o: { message: string; signal?: AbortSignal }): Promise<never> {
	const signal = o.signal;
	if (!signal) throw new Error(`ScriptedUi: WAIT_FOR_ABORT for ${kind} "${o.message}" has no signal`);
	const reason = () => signal.reason ?? new DOMException("Aborted", "AbortError");
	return new Promise((_, reject) => {
		if (signal.aborted) reject(reason());
		else signal.addEventListener("abort", () => reject(reason()), { once: true });
	});
}
