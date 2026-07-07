import { Key, matchesKey, truncateToWidth, visibleWidth, type Component, type KeyId } from "@earendil-works/pi-tui";

export interface ModalDialogOptions {
	readonly signal?: AbortSignal;
	readonly timeout?: number;
}

export interface ModalInputOptions extends ModalDialogOptions {
	/**
	 * Seeds the single-line input modal's editable value (not just its placeholder). Pressing
	 * Enter immediately returns this value verbatim after single-line sanitization; callers
	 * that need multiline text should use `editor()`.
	 */
	readonly initialValue?: string;
}

export type ModalResult = boolean | string | undefined;

type ActiveModal =
	| {
			readonly kind: "confirm";
			readonly title: string;
			readonly message: string;
			selectedIndex: number;
			readonly resolve: (value: boolean) => void;
			cleanup: () => void;
	  }
	| {
			readonly kind: "select";
			readonly title: string;
			readonly options: readonly SelectOption[];
			selectedIndex: number;
			readonly resolve: (value: string | undefined) => void;
			cleanup: () => void;
	  }
	| {
			readonly kind: "input";
			readonly title: string;
			readonly placeholder: string | undefined;
			value: string;
			readonly resolve: (value: string | undefined) => void;
			cleanup: () => void;
	  }
	| {
			readonly kind: "editor";
			readonly title: string;
			value: string;
			readonly resolve: (value: string | undefined) => void;
			cleanup: () => void;
	  };

export interface ModalManagerOptions {
	readonly setTimeout?: typeof setTimeout;
	readonly clearTimeout?: typeof clearTimeout;
	readonly onChange?: () => void;
}

interface SelectOption {
	readonly label: string;
	readonly value: string;
}

function keyEq(data: string, ...ids: readonly string[]): boolean {
	for (const id of ids) {
		if (data === id) return true;
		if (matchesKey(data, id as KeyId)) return true;
	}
	return false;
}

function border(width: number): string {
	return `─`.repeat(Math.max(0, width));
}

function truncate(text: string, width: number): string {
	return visibleWidth(text) <= width ? text : truncateToWidth(text, width);
}

function pad(text: string, width: number): string {
	const visible = visibleWidth(text);
	return visible >= width ? text : `${text}${" ".repeat(width - visible)}`;
}

const ANSI_PATTERN = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\)|_[^\u0007]*(?:\u0007|\u001b\\))/g;
const CONTROL_PATTERN = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g;
const BRACKETED_PASTE_START = "\u001b[200~";
const BRACKETED_PASTE_END = "\u001b[201~";

function sanitizeModalText(text: string): string {
	return text
		.replace(/\r\n?/g, "\n")
		.replace(ANSI_PATTERN, "")
		.replace(/\t/g, " ")
		.replace(CONTROL_PATTERN, "");
}

function sanitizeSingleLineModalText(text: string): string {
	return sanitizeModalText(text).replace(/\n/g, " ");
}

function sanitizeInputChunk(text: string): string {
	return sanitizeModalText(text)
		.replaceAll(BRACKETED_PASTE_START, "")
		.replaceAll(BRACKETED_PASTE_END, "")
		.replace(/\n/g, "");
}


function wrapText(text: string, width: number): string[] {
	if (width <= 0) return [""];
	const rows: string[] = [];
	for (const raw of text.split("\n")) {
		if (raw.length === 0) {
			rows.push("");
			continue;
		}
		let current = "";
		for (const char of [...raw]) {
			const next = `${current}${char}`;
			if (visibleWidth(next) <= width) {
				current = next;
				continue;
			}
			rows.push(current);
			current = char.trim().length === 0 ? "" : char;
		}
		rows.push(current);
	}
	return rows.length > 0 ? rows : [""];
}

/** Basic retained modal layer for Phase 4 confirm/select/input flows. */
export class ModalManager implements Component {
	private readonly setTimer: typeof setTimeout;
	private readonly clearTimer: typeof clearTimeout;
	private readonly onChange: () => void;
	private active: ActiveModal | undefined;
	private readonly queue: ActiveModal[] = [];

	public constructor(options: ModalManagerOptions = {}) {
		this.setTimer = options.setTimeout ?? setTimeout;
		this.clearTimer = options.clearTimeout ?? clearTimeout;
		this.onChange = options.onChange ?? (() => undefined);
	}

	public confirm(title: string, message: string, opts?: ModalDialogOptions): Promise<boolean> {
		return new Promise<boolean>((resolve) => {
			const entry: ActiveModal = {
				kind: "confirm",
				title: sanitizeModalText(title),
				message: sanitizeModalText(message),
				selectedIndex: 0,
				resolve,
				cleanup: () => undefined,
			};
			entry.cleanup = this.installDismissal(opts, () => this.finishEntry(entry, false));
			this.enqueue(entry);
		});
	}

	public select(title: string, options: readonly string[], opts?: ModalDialogOptions): Promise<string | undefined> {
		return new Promise<string | undefined>((resolve) => {
			const entry: ActiveModal = {
				kind: "select",
				title: sanitizeModalText(title),
				options: options.map((option) => ({ label: sanitizeSingleLineModalText(option), value: option })),
				selectedIndex: 0,
				resolve,
				cleanup: () => undefined,
			};
			entry.cleanup = this.installDismissal(opts, () => this.finishEntry(entry, undefined));
			this.enqueue(entry);
		});
	}

	public input(title: string, placeholder?: string, opts?: ModalInputOptions): Promise<string | undefined> {
		return new Promise<string | undefined>((resolve) => {
			const entry: ActiveModal = {
				kind: "input",
				title: sanitizeModalText(title),
				placeholder: placeholder === undefined ? undefined : sanitizeSingleLineModalText(placeholder),
				value: opts?.initialValue === undefined ? "" : sanitizeSingleLineModalText(opts.initialValue),
				resolve,
				cleanup: () => undefined,
			};
			entry.cleanup = this.installDismissal(opts, () => this.finishEntry(entry, undefined));
			this.enqueue(entry);
		});
	}

	public editor(title: string, prefill: string): Promise<string | undefined> {
		return new Promise<string | undefined>((resolve) => {
			const entry: ActiveModal = {
				kind: "editor",
				title: sanitizeModalText(title),
				value: sanitizeModalText(prefill),
				resolve,
				cleanup: () => undefined,
			};
			this.enqueue(entry);
		});
	}

	public close(): void {
		this.finish(undefined);
	}

	public getActiveKind(): ActiveModal["kind"] | undefined {
		return this.active?.kind;
	}

	public invalidate(): void {}

	public handleInput(data: string): void {
		if (!this.active) return;
		if (keyEq(data, Key.escape, "escape", "esc")) {
			this.finish(this.active.kind === "confirm" ? false : undefined);
			return;
		}

		if (this.active.kind === "input") {
			this.handleInputModal(data, this.active);
			return;
		}
		if (this.active.kind === "editor") {
			this.handleEditorModal(data, this.active);
			return;
		}

		if (keyEq(data, Key.up, Key.left, "up", "left")) {
			this.moveSelection(-1);
			return;
		}
		if (keyEq(data, Key.down, Key.right, "down", "right")) {
			this.moveSelection(1);
			return;
		}
		if (keyEq(data, Key.enter, "return", "enter")) {
			if (this.active.kind === "confirm") this.finish(this.active.selectedIndex === 0);
			else this.finish(this.active.options[this.active.selectedIndex]?.value);
		}
	}

	public render(width: number): string[] {
		if (!this.active || width <= 0) return [];
		const modalWidth = Math.min(width, Math.max(32, Math.floor(width * 0.6)));
		const left = " ".repeat(Math.max(0, Math.floor((width - modalWidth) / 2)));
		const line = (text: string) => `${left}${pad(truncate(text, modalWidth), modalWidth)}`;
		const lines: string[] = [
			line(border(modalWidth)),
			...wrapText(this.active.title, modalWidth).map(line),
			line(border(modalWidth)),
		];

		if (this.active.kind === "confirm") {
			lines.push(...wrapText(this.active.message, modalWidth).map(line));
			const yes = this.active.selectedIndex === 0 ? "▶ Yes" : "  Yes";
			const no = this.active.selectedIndex === 1 ? "▶ No" : "  No";
			lines.push(line(`${yes}    ${no}`));
		} else if (this.active.kind === "select") {
			for (const [index, option] of this.active.options.entries()) {
				lines.push(line(`${index === this.active.selectedIndex ? "▶" : " "} ${option.label}`));
			}
		} else if (this.active.kind === "input") {
			const value = this.active.value || this.active.placeholder || "";
			lines.push(line(`> ${value}`));
		} else {
			for (const valueLine of this.active.value.split("\n")) {
				lines.push(line(`> ${valueLine}`));
			}
		}

		lines.push(line(border(modalWidth)));
		return lines;
	}

	private handleInputModal(data: string, modal: Extract<ActiveModal, { kind: "input" }>): void {
		if (keyEq(data, Key.enter, "return", "enter")) {
			this.finish(modal.value);
			return;
		}
		if (keyEq(data, Key.backspace, "backspace")) {
			modal.value = modal.value.slice(0, -1);
			this.onChange();
			return;
		}
		if (data.length === 1 && !/\p{Cc}/u.test(data)) {
			modal.value += data;
			this.onChange();
			return;
		}
		const printable = sanitizeInputChunk(data);
		if (printable.length > 0) {
			modal.value += printable;
			this.onChange();
		}
	}

	private handleEditorModal(data: string, modal: Extract<ActiveModal, { kind: "editor" }>): void {
		if (keyEq(data, Key.shift("enter"), "shift+enter")) {
			modal.value += "\n";
			this.onChange();
			return;
		}
		if (keyEq(data, Key.enter, "return", "enter")) {
			this.finish(modal.value);
			return;
		}
		if (keyEq(data, Key.backspace, "backspace")) {
			modal.value = modal.value.slice(0, -1);
			this.onChange();
			return;
		}
		if (data.length === 1 && !/\p{Cc}/u.test(data)) {
			modal.value += data;
			this.onChange();
			return;
		}
		const printable = sanitizeModalText(data.replaceAll(BRACKETED_PASTE_START, "").replaceAll(BRACKETED_PASTE_END, ""));
		if (printable.length > 0) {
			modal.value += printable;
			this.onChange();
		}
	}

	private moveSelection(delta: -1 | 1): void {
		if (!this.active || this.active.kind === "input" || this.active.kind === "editor") return;
		const count = this.active.kind === "confirm" ? 2 : this.active.options.length;
		if (count === 0) return;
		this.active.selectedIndex = (this.active.selectedIndex + delta + count) % count;
		this.onChange();
	}

	private finish(value: ModalResult): void {
		const modal = this.active;
		if (!modal) return;
		this.finishEntry(modal, value);
	}

	private enqueue(modal: ActiveModal): void {
		if (this.active) this.queue.push(modal);
		else this.active = modal;
		this.onChange();
	}

	private finishEntry(modal: ActiveModal, value: ModalResult): void {
		if (this.active === modal) {
			this.active = undefined;
		} else {
			const index = this.queue.indexOf(modal);
			if (index === -1) return;
			this.queue.splice(index, 1);
		}
		modal.cleanup();
		if (modal.kind === "confirm") modal.resolve(value === true);
		else modal.resolve(typeof value === "string" ? value : undefined);
		this.activateNext();
		this.onChange();
	}

	private activateNext(): void {
		if (this.active) return;
		this.active = this.queue.shift();
	}

	private installDismissal(opts: ModalDialogOptions | undefined, dismiss: () => void): () => void {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const onAbort = (): void => dismiss();
		if (opts?.signal?.aborted) {
			queueMicrotask(dismiss);
		} else {
			opts?.signal?.addEventListener("abort", onAbort, { once: true });
		}
		if (opts?.timeout !== undefined && opts.timeout > 0) {
			timer = this.setTimer(dismiss, opts.timeout);
			timer.unref?.();
		}
		return () => {
			if (timer) this.clearTimer(timer);
			opts?.signal?.removeEventListener("abort", onAbort);
		};
	}
}
