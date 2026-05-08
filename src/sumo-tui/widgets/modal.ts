import { Key, matchesKey, type Component, type KeyId } from "@earendil-works/pi-tui";

export interface ModalDialogOptions {
	readonly signal?: AbortSignal;
	readonly timeout?: number;
}

export type ModalResult = boolean | string | undefined;

type ActiveModal =
	| {
			readonly kind: "confirm";
			readonly title: string;
			readonly message: string;
			selectedIndex: number;
			readonly resolve: (value: boolean) => void;
			readonly cleanup: () => void;
	  }
	| {
			readonly kind: "select";
			readonly title: string;
			readonly options: readonly string[];
			selectedIndex: number;
			readonly resolve: (value: string | undefined) => void;
			readonly cleanup: () => void;
	  }
	| {
			readonly kind: "input";
			readonly title: string;
			readonly placeholder: string | undefined;
			value: string;
			readonly resolve: (value: string | undefined) => void;
			readonly cleanup: () => void;
	  };

export interface ModalManagerOptions {
	readonly setTimeout?: typeof setTimeout;
	readonly clearTimeout?: typeof clearTimeout;
	readonly onChange?: () => void;
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
	if (text.length <= width) return text;
	if (width <= 1) return "…";
	return `${text.slice(0, width - 1)}…`;
}

function pad(text: string, width: number): string {
	return text.length >= width ? text : `${text}${" ".repeat(width - text.length)}`;
}

/** Basic retained modal layer for Phase 4 confirm/select/input flows. */
export class ModalManager implements Component {
	private readonly setTimer: typeof setTimeout;
	private readonly clearTimer: typeof clearTimeout;
	private readonly onChange: () => void;
	private active: ActiveModal | undefined;

	public constructor(options: ModalManagerOptions = {}) {
		this.setTimer = options.setTimeout ?? setTimeout;
		this.clearTimer = options.clearTimeout ?? clearTimeout;
		this.onChange = options.onChange ?? (() => undefined);
	}

	public confirm(title: string, message: string, opts?: ModalDialogOptions): Promise<boolean> {
		return new Promise<boolean>((resolve) => {
			const cleanup = this.installDismissal(opts, () => this.finish(false));
			this.active = { kind: "confirm", title, message, selectedIndex: 0, resolve, cleanup };
			this.onChange();
		});
	}

	public select(title: string, options: readonly string[], opts?: ModalDialogOptions): Promise<string | undefined> {
		return new Promise<string | undefined>((resolve) => {
			const cleanup = this.installDismissal(opts, () => this.finish(undefined));
			this.active = { kind: "select", title, options, selectedIndex: 0, resolve, cleanup };
			this.onChange();
		});
	}

	public input(title: string, placeholder?: string, opts?: ModalDialogOptions): Promise<string | undefined> {
		return new Promise<string | undefined>((resolve) => {
			const cleanup = this.installDismissal(opts, () => this.finish(undefined));
			this.active = { kind: "input", title, placeholder, value: "", resolve, cleanup };
			this.onChange();
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
			else this.finish(this.active.options[this.active.selectedIndex]);
		}
	}

	public render(width: number): string[] {
		if (!this.active || width <= 0) return [];
		const modalWidth = Math.min(width, Math.max(32, Math.floor(width * 0.6)));
		const left = " ".repeat(Math.max(0, Math.floor((width - modalWidth) / 2)));
		const line = (text: string) => `${left}${pad(truncate(text, modalWidth), modalWidth)}`;
		const lines: string[] = [line(border(modalWidth)), line(this.active.title), line(border(modalWidth))];

		if (this.active.kind === "confirm") {
			lines.push(...this.active.message.split("\n").map(line));
			const yes = this.active.selectedIndex === 0 ? "▶ Yes" : "  Yes";
			const no = this.active.selectedIndex === 1 ? "▶ No" : "  No";
			lines.push(line(`${yes}    ${no}`));
		} else if (this.active.kind === "select") {
			for (const [index, option] of this.active.options.entries()) {
				lines.push(line(`${index === this.active.selectedIndex ? "▶" : " "} ${option}`));
			}
		} else {
			const value = this.active.value || this.active.placeholder || "";
			lines.push(line(`> ${value}`));
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
		}
	}

	private moveSelection(delta: -1 | 1): void {
		if (!this.active || this.active.kind === "input") return;
		const count = this.active.kind === "confirm" ? 2 : this.active.options.length;
		if (count === 0) return;
		this.active.selectedIndex = (this.active.selectedIndex + delta + count) % count;
		this.onChange();
	}

	private finish(value: ModalResult): void {
		const modal = this.active;
		if (!modal) return;
		this.active = undefined;
		modal.cleanup();
		if (modal.kind === "confirm") modal.resolve(value === true);
		else modal.resolve(typeof value === "string" ? value : undefined);
		this.onChange();
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
