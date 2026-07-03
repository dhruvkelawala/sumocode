import type { Component } from "@earendil-works/pi-tui";
import { SelectList, type SelectItem, type SelectListTheme } from "@earendil-works/pi-tui";
import { activeThemeColors } from "../../themes/index.js";

/**
 * In-place selector surface (plan 036).
 *
 * Mirrors Pi's own `showSelector` (see
 * `node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js`,
 * `InteractiveMode.showSelector`): the selector renders THROUGH the editor's
 * Yoga slot (`PiEditorLeaf`/`editorRow` in `shell/retained-shell-renderer.ts`),
 * not as a full-screen backdrop. Pi's own comment on that leaf spells out the
 * contract this file has to honor: "PiEditorLeaf wraps Pi's editorContainer so
 * the live editor AND Pi-internal selectors (/resume, model picker, confirm
 * dialogs) both render through the same Yoga leaf... no editor cursor while a
 * selector is focused." The leaf's height is measured from
 * `component.render(width).length` (`PiComponentLeaf.measure`), so mounting a
 * taller selector here grows only the input band -- transcript, sidebar, top
 * chrome, and footer all stay exactly where they were. This is the in-place
 * substitute for the old `ModalLayer`-backed `modals.select(...)` call sites,
 * which painted a full `rows x cols` backdrop and hid the transcript (see
 * `widgets/modal-layer.ts`'s `centerRows`).
 */

const RESET = "\u001b[0m";

function rgb(hex: string): { r: number; g: number; b: number } {
	const normalized = hex.replace("#", "");
	return {
		r: Number.parseInt(normalized.slice(0, 2), 16),
		g: Number.parseInt(normalized.slice(2, 4), 16),
		b: Number.parseInt(normalized.slice(4, 6), 16),
	};
}

function fg(hex: string): string {
	const { r, g, b } = rgb(hex);
	return `\u001b[38;2;${r};${g};${b}m`;
}

function inlineSelectorTheme(): SelectListTheme {
	const colors = activeThemeColors();
	return {
		selectedPrefix: (text) => `${fg(colors.accent)}${text}${RESET}`,
		selectedText: (text) => `${fg(colors.accent)}${text}${RESET}`,
		description: (text) => `${fg(colors.foregroundDim)}${text}${RESET}`,
		scrollInfo: (text) => `${fg(colors.foregroundDim)}${text}${RESET}`,
		noMatch: (text) => `${fg(colors.foregroundDim)}${text}${RESET}`,
	};
}

/** Maximum rows the inline selector list shows before scrolling (mirrors Pi's own selector components). */
const DEFAULT_MAX_VISIBLE = 8;

/**
 * Wraps pi-tui's `SelectList` with the simple `title + string[] options ->
 * Promise<string | undefined>` shape `ModalManager.select` used to provide,
 * so migrating a call site off `modals.select(...)` is a drop-in swap. `title`
 * renders as a dim heading row above the list so the selector still
 * communicates what it's for without a modal card/border.
 */
export class InlineSelectorComponent implements Component {
	private readonly list: SelectList;
	private readonly labelToValue: Map<string, string>;

	public constructor(
		private readonly title: string,
		options: readonly string[],
		private readonly done: (value: string | undefined) => void,
		maxVisible: number = DEFAULT_MAX_VISIBLE,
	) {
		const items: SelectItem[] = options.map((option) => ({ value: option, label: option }));
		this.labelToValue = new Map(items.map((item) => [item.label, item.value]));
		this.list = new SelectList(items, Math.max(1, maxVisible), inlineSelectorTheme());
		this.list.onSelect = (item) => this.done(this.labelToValue.get(item.label) ?? item.value);
		this.list.onCancel = () => this.done(undefined);
	}

	public invalidate(): void {
		this.list.invalidate();
	}

	public handleInput(data: string): void {
		this.list.handleInput(data);
	}

	public render(width: number): string[] {
		const colors = activeThemeColors();
		const heading = `${fg(colors.foregroundDim)}${this.title}${RESET}`;
		return [heading, ...this.list.render(width)];
	}
}

interface EditorLikeComponent extends Component {
	getText?(): string;
	setText?(text: string): void;
	paste?(text: string): void;
	setSplashProvider?(provider: () => boolean): void;
}

interface QueuedSelector {
	readonly create: (done: (value: unknown) => void) => Component;
	readonly resolve: (value: unknown) => void;
}

/**
 * Renders in place of the editor while a selector is open, restoring the real
 * editor (and its focus) once the selector resolves -- the sumocode analogue
 * of Pi's `showSelector`/`done` pair. Passed as the `editor` prop into
 * `RpcShellAdapter`/`RpcHostRuntime`, so the existing Yoga input slot,
 * `getChatRect`, hardware-cursor suppression (no `CURSOR_MARKER` while a
 * selector has no editor cursor to report), and `handleFocusedModalInput`-style
 * input routing all keep working unmodified: this class is just a different
 * `Component` sitting behind the same `editor` reference host.ts already
 * wires through.
 */
export class InlineSelectorHost implements EditorLikeComponent {
	private active: Component | undefined;
	private finish: ((value: unknown) => void) | undefined;
	private readonly queue: QueuedSelector[] = [];

	public constructor(
		private readonly editor: EditorLikeComponent,
		private readonly onChange: () => void = () => undefined,
	) {}

	/** Opens an inline selector; resolves with the chosen option, or `undefined` on Esc/cancel. */
	public select(title: string, options: readonly string[], maxVisible?: number): Promise<string | undefined> {
		return new Promise<string | undefined>((resolve) => {
			const entry: QueuedSelector = {
				create: (done) => new InlineSelectorComponent(title, options, done as (value: string | undefined) => void, maxVisible),
				resolve: resolve as (value: unknown) => void,
			};
			if (this.active) {
				this.queue.push(entry);
				this.onChange();
				return;
			}
			this.activate(entry);
			this.onChange();
		});
	}

	/** True while an inline selector occupies the editor slot (used to gate input routing/focus like the old modal). */
	public isActive(): boolean {
		return this.active !== undefined;
	}

	public getActiveKind(): "select" | undefined {
		return this.active ? "select" : undefined;
	}

	/** Closes the active selector without a selection (Esc / external dismissal), resolving with `undefined`. */
	public close(): void {
		this.finish?.(undefined);
	}

	public invalidate(): void {
		if (this.active) this.active.invalidate?.();
		else this.editor.invalidate?.();
	}

	public handleInput(data: string): void {
		if (this.active) {
			this.active.handleInput?.(data);
			this.onChange();
			return;
		}
		this.editor.handleInput?.(data);
	}

	public render(width: number): string[] {
		if (this.active) return this.active.render(width);
		return this.editor.render(width);
	}

	// EditorLikeComponent passthroughs -- forwarded to the wrapped editor so
	// `RpcShellAdapter`'s optional casts (`getText`, `setSplashProvider`) keep
	// working transparently regardless of which component currently owns the
	// editor slot. `setText`/`paste` while a selector is active still apply to
	// the underlying editor (matches Pi: text typed/pasted into a
	// backgrounded editor is preserved for when the selector closes).
	public getText(): string {
		return this.editor.getText?.() ?? "";
	}

	public setText(text: string): void {
		this.editor.setText?.(text);
	}

	public paste(text: string): void {
		this.editor.paste?.(text);
	}

	public setSplashProvider(provider: () => boolean): void {
		this.editor.setSplashProvider?.(provider);
	}

	private activate(entry: QueuedSelector): void {
		this.finish = (value: unknown) => {
			this.active = undefined;
			this.finish = undefined;
			entry.resolve(value);
			this.activateNext();
			this.onChange();
		};
		this.active = entry.create((value) => this.finish?.(value));
	}

	private activateNext(): void {
		if (this.active) return;
		const next = this.queue.shift();
		if (!next) return;
		this.activate(next);
	}
}
