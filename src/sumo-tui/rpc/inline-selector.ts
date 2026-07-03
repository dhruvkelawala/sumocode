import type { Component } from "@earendil-works/pi-tui";
import { getKeybindings, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { activeThemeColors } from "../../themes/index.js";
import {
	FOCUSED_MARK,
	UNFOCUSED_MARK,
	center,
	fg,
	splitRule,
	visibleLength,
	wrapPanelRow,
} from "../../cathedral/scriptorium-chrome.js";

/**
 * In-place selector surface (plan 036, restyled per plan 037).
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
 *
 * Styling (plan 037): this used to wrap pi-tui's stock `SelectList`, which
 * only exposes a 5-hook `SelectListTheme` (selectedPrefix/selectedText/
 * description/scrollInfo/noMatch) with no bg/border/header/footer hooks, and
 * hard-codes the selected-row prefix as literal `"→ "` vs `"  "`
 * (`SelectList.renderItem`, `node_modules/@earendil-works/pi-tui/dist/components/select-list.js`)
 * with no way to override it short of forking pi-tui. Rows are now hand-rendered
 * here -- the same approach `command-palette.ts`'s `renderCommandPalette` takes
 * -- reusing the shared Cathedral panel helpers from `cathedral/scriptorium-chrome.ts`
 * (`wrapPanelRow`/`splitRule`/`center`/focus glyphs) instead of hand-rolling more
 * ANSI. Only `SelectList`'s input-matching keybindings (`getKeybindings()`'s
 * `tui.select.*`) are reused, via direct calls, to keep exact behavioral parity
 * with every other pi-tui select surface (custom keybinding overrides, wrap-around
 * arrow navigation, etc.).
 */

export const INLINE_SELECTOR_HINT_ROW = "↑↓ choose    ⏎ select    ⎋ cancel";

/** Maximum rows the inline selector list shows before scrolling (mirrors Pi's own selector components). */
const DEFAULT_MAX_VISIBLE = 8;

/**
 * A selectable row. `value` is what resolves the selector; `label` is the
 * primary display text (defaults to `value` when omitted at call sites that
 * only have plain strings); `description`/`currentValue` render right-aligned
 * in a second column (mirrors `command-palette.ts`'s `displayPaletteValue`);
 * `isCurrent` draws a small accent marker independent of cursor position
 * (mirrors `sidebar-rendering.ts`'s colored MCP status dot) for options that
 * match live state (e.g. the active model/theme/thinking level).
 */
export interface InlineSelectorItem {
	readonly value: string;
	readonly label?: string;
	readonly description?: string;
	readonly isCurrent?: boolean;
}

type NormalizedItem = {
	readonly value: string;
	readonly label: string;
	readonly description: string;
	readonly isCurrent: boolean;
};

function normalizeItems(options: readonly (string | InlineSelectorItem)[]): NormalizedItem[] {
	return options.map((option) => {
		if (typeof option === "string") {
			return { value: option, label: option, description: "", isCurrent: false };
		}
		return {
			value: option.value,
			label: option.label ?? option.value,
			description: option.description ?? "",
			isCurrent: option.isCurrent ?? false,
		};
	});
}

const CURRENT_MARK = "●"; // "●" -- mirrors sidebar-rendering.ts's colored status dot

function currentTag(isCurrent: boolean): string {
	if (!isCurrent) return "";
	return `${fg(CURRENT_MARK, activeThemeColors().accent)} `;
}

/**
 * Wraps a `title + (string | InlineSelectorItem)[] options -> Promise<string
 * | undefined>` shape (a drop-in superset of the plain `string[]` shape
 * `ModalManager.select` used to provide, so migrating a call site off
 * `modals.select(...)` stays a drop-in swap) in a Cathedral-styled panel:
 * lifted-bg fill on every row, an ornamental centered title with a rule
 * divider beneath, a focus glyph (`❈` focused / `·` unfocused) on
 * each row instead of pi-tui's stock arrow, a right-aligned description/
 * current-value column, and a footer hint row.
 */
export class InlineSelectorComponent implements Component {
	private readonly items: NormalizedItem[];
	private selectedIndex = 0;

	public constructor(
		private readonly title: string,
		options: readonly (string | InlineSelectorItem)[],
		private readonly done: (value: string | undefined) => void,
		private readonly maxVisible: number = DEFAULT_MAX_VISIBLE,
	) {
		this.items = normalizeItems(options);
	}

	public invalidate(): void {
		// No cached state to invalidate currently.
	}

	public handleInput(data: string): void {
		const kb = getKeybindings();
		if (kb.matches(data, "tui.select.up")) {
			this.selectedIndex = this.selectedIndex === 0 ? this.items.length - 1 : this.selectedIndex - 1;
			return;
		}
		if (kb.matches(data, "tui.select.down")) {
			this.selectedIndex = this.selectedIndex === this.items.length - 1 ? 0 : this.selectedIndex + 1;
			return;
		}
		if (kb.matches(data, "tui.select.confirm")) {
			const item = this.items[this.selectedIndex];
			this.done(item?.value);
			return;
		}
		if (kb.matches(data, "tui.select.cancel")) {
			this.done(undefined);
		}
	}

	public render(width: number): string[] {
		const w = Math.max(1, Math.floor(width));
		const lines: string[] = [];

		lines.push(wrapPanelRow("", w));
		lines.push(wrapPanelRow(center(`${fg("✦", activeThemeColors().accent)}  ${fg(this.title.toUpperCase(), activeThemeColors().accent)}  ${fg("✦", activeThemeColors().accent)}`, w), w));
		lines.push(wrapPanelRow(splitRule(w), w));
		lines.push(wrapPanelRow("", w));

		if (this.items.length === 0) {
			lines.push(wrapPanelRow(`     ${fg(UNFOCUSED_MARK, activeThemeColors().divider)}   ${fg("no matching option", activeThemeColors().foregroundDim)}`, w));
		} else {
			const { startIndex, endIndex } = this.visibleRange();
			for (let index = startIndex; index < endIndex; index++) {
				lines.push(wrapPanelRow(this.renderRow(this.items[index]!, index === this.selectedIndex, w), w));
			}
			if (startIndex > 0 || endIndex < this.items.length) {
				const scrollText = `  (${this.selectedIndex + 1}/${this.items.length})`;
				lines.push(wrapPanelRow(fg(truncateToWidth(scrollText, w - 2, ""), activeThemeColors().foregroundDim), w));
			}
		}

		lines.push(wrapPanelRow("", w));
		lines.push(wrapPanelRow(splitRule(w), w));
		lines.push(wrapPanelRow(center(fg(INLINE_SELECTOR_HINT_ROW, activeThemeColors().foregroundDim), w), w));
		lines.push(wrapPanelRow("", w));
		return lines;
	}

	private visibleRange(): { startIndex: number; endIndex: number } {
		const maxVisible = Math.max(1, this.maxVisible);
		const startIndex = Math.max(0, Math.min(this.selectedIndex - Math.floor(maxVisible / 2), this.items.length - maxVisible));
		const endIndex = Math.min(startIndex + maxVisible, this.items.length);
		return { startIndex, endIndex };
	}

	private renderRow(item: NormalizedItem, focused: boolean, width: number): string {
		const colors = activeThemeColors();
		const marker = focused ? fg(FOCUSED_MARK, colors.accent) : fg(UNFOCUSED_MARK, colors.divider);
		const tag = currentTag(item.isCurrent);
		const label = focused ? fg(item.label, colors.foreground) : fg(item.label, colors.foregroundDim);
		const left = `     ${marker}   ${tag}${label}`;

		if (item.description.length === 0) return left;

		const valueText = focused ? fg(item.description, colors.foreground) : fg(item.description, colors.foregroundDim);
		const leftWidth = visibleLength(left);
		const valueWidth = visibleWidth(item.description);
		const padBetween = Math.max(2, width - leftWidth - valueWidth - 5);
		return `${left}${" ".repeat(padBetween)}${valueText}`;
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
	public select(title: string, options: readonly (string | InlineSelectorItem)[], maxVisible?: number): Promise<string | undefined> {
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
