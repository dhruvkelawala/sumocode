import type { Component } from "@earendil-works/pi-tui";
import { decodeKittyPrintable, fuzzyFilter as piFuzzyFilter, getKeybindings, Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
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
 *
 * Search-as-you-type (plan 038): with long option lists (e.g. 500+ models)
 * scrolling one row at a time is unusable, so a `query` string narrows `items`
 * before any scroll-window/selection math runs -- mirrors `command-palette.ts`'s
 * `searchQuery`/`filterPaletteRows` shape (a visible search row above the list,
 * backspace/printable-character handling that resets the cursor to index 0).
/**
 * Injectable dependency seam (tests wrap the real pi-tui filter to observe
 * queries); production always uses pi-tui's own implementation.
 */
type FuzzyFilterFn = typeof piFuzzyFilter;
let fuzzyFilterImpl: FuzzyFilterFn = piFuzzyFilter;

export function setFuzzyFilterForTests(fn: FuzzyFilterFn | undefined): void {
	fuzzyFilterImpl = fn ?? piFuzzyFilter;
}

/*
 * Filtering uses pi-tui's own `fuzzyFilter` (already used by this codebase for
 * the model-argument autocomplete in `editor.ts`) rather than a plain substring
 * match: a synthetic 540-item model-list check (`fuzzy-check` script, see report)
 * showed substring matching returns zero results for out-of-order queries like
 * "seed16" or "gpt5mini" (no literal hyphen/no digit-before-letter), while
 * `fuzzyFilter`'s token-based scoring (with its built-in alpha/digit swap
 * heuristic) finds them -- worth the tradeoff since model IDs are exactly the
 * kind of hyphenated/slashed identifiers users mistype the separators of.
 * `SelectList.setFilter` (`select-list.js:25-30`) is the reference for
 * resetting `selectedIndex` to 0 on every filter change, reproduced here as
 * `setQuery`.
 *
 * Tabbed selectors reuse the same surface: Tab / Shift+Tab changes the active
 * option group, while the search query filters only the active group.
 */

export const INLINE_SELECTOR_HINT_ROW = "↑↓ choose    ⏎ select    ⎋ cancel";
const INLINE_SELECTOR_TABBED_HINT_ROW = "↑↓ choose    ⇥ tab    ⏎ select    ⎋ cancel";

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

export interface InlineSelectorTab {
	readonly id: string;
	readonly label: string;
	readonly options: readonly (string | InlineSelectorItem)[];
}

type NormalizedItem = {
	readonly value: string;
	readonly label: string;
	readonly description: string;
	readonly isCurrent: boolean;
};

type NormalizedTab = {
	readonly id: string;
	readonly label: string;
	readonly items: NormalizedItem[];
};

export interface InlineSelectorComponentOptions {
	maxVisible?: number;
	initialValue?: string;
	tabs?: readonly InlineSelectorTab[];
	initialTabId?: string;
}

function isStringOption(option: string | InlineSelectorItem): option is string {
	return typeof option === "string";
}

function normalizeItems(options: readonly (string | InlineSelectorItem)[]): NormalizedItem[] {
	return options.map((option) => {
		if (isStringOption(option)) {
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

function normalizeTabs(options: readonly (string | InlineSelectorItem)[], tabs?: readonly InlineSelectorTab[]): NormalizedTab[] {
	if (!tabs || tabs.length === 0) return [{ id: "default", label: "", items: normalizeItems(options) }];
	return tabs.map((tab) => ({
		id: tab.id,
		label: tab.label,
		items: normalizeItems(tab.options),
	}));
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
	private readonly tabs: NormalizedTab[];
	private readonly maxVisible: number;
	private activeTabIndex = 0;
	private selectedIndex = 0;
	/** Search-as-you-type query (plan 038); reset to "" per selector open (see constructor). */
	private query = "";
	private filteredCache: { readonly query: string; readonly tabIndex: number; readonly result: NormalizedItem[] } | undefined;

	public constructor(
		private readonly title: string,
		options: readonly (string | InlineSelectorItem)[],
		private readonly done: (value: string | undefined) => void,
		maxVisibleOrOptions: number | InlineSelectorComponentOptions = DEFAULT_MAX_VISIBLE,
		initialValue?: string,
	) {
		const componentOptions = isNumberOption(maxVisibleOrOptions)
			? { maxVisible: maxVisibleOrOptions }
			: maxVisibleOrOptions;
		if (isNumberOption(maxVisibleOrOptions) && initialValue !== undefined) componentOptions.initialValue = initialValue;
		this.maxVisible = componentOptions.maxVisible ?? DEFAULT_MAX_VISIBLE;
		this.tabs = normalizeTabs(options, componentOptions.tabs);

		const initialTabIndex = componentOptions.initialTabId === undefined
			? -1
			: this.tabs.findIndex((tab) => tab.id === componentOptions.initialTabId);
		if (initialTabIndex >= 0) this.activeTabIndex = initialTabIndex;

		if (componentOptions.initialValue !== undefined) {
			const tabWithInitial = this.tabs.findIndex((tab) => tab.items.some((item) => item.value === componentOptions.initialValue));
			if (tabWithInitial >= 0 && initialTabIndex < 0) this.activeTabIndex = tabWithInitial;
			const activeItems = this.tabs[this.activeTabIndex]?.items ?? [];
			const initialIndex = activeItems.findIndex((item) => item.value === componentOptions.initialValue);
			if (initialIndex >= 0) this.selectedIndex = initialIndex;
		}
		this.invalidate();
	}

	public invalidate(): void {
		this.filteredCache = undefined;
	}

	/** Items narrowed by `query`, in `fuzzyFilter`'s best-match-first order (identity order when `query` is empty). */
	private filteredItems(): NormalizedItem[] {
		const cached = this.filteredCache;
		if (cached?.query === this.query && cached.tabIndex === this.activeTabIndex) return cached.result;
		const activeItems = this.tabs[this.activeTabIndex]?.items ?? [];
		const result = fuzzyFilterImpl(activeItems, this.query, (item) => item.label);
		this.filteredCache = { query: this.query, tabIndex: this.activeTabIndex, result };
		return result;
	}

	/** Sets `query` and resets `selectedIndex` to 0, mirroring `SelectList.setFilter`. */
	private setQuery(query: string): void {
		this.query = query;
		this.selectedIndex = 0;
		this.invalidate();
	}

	private switchTab(direction: 1 | -1): void {
		if (this.tabs.length <= 1) return;
		this.activeTabIndex = (this.activeTabIndex + direction + this.tabs.length) % this.tabs.length;
		this.selectedIndex = 0;
		this.invalidate();
	}

	public handleInput(data: string): void {
		const kb = getKeybindings();
		if (this.tabs.length > 1 && matchesKey(data, Key.shift(Key.tab))) {
			this.switchTab(-1);
			return;
		}
		if (this.tabs.length > 1 && matchesKey(data, Key.tab)) {
			this.switchTab(1);
			return;
		}
		const items = this.filteredItems();
		if (kb.matches(data, "tui.select.up")) {
			this.selectedIndex = items.length === 0 ? 0 : this.selectedIndex === 0 ? items.length - 1 : this.selectedIndex - 1;
			return;
		}
		if (kb.matches(data, "tui.select.down")) {
			this.selectedIndex = items.length === 0 ? 0 : this.selectedIndex === items.length - 1 ? 0 : this.selectedIndex + 1;
			return;
		}
		if (kb.matches(data, "tui.select.confirm")) {
			const item = items[this.selectedIndex];
			this.done(item?.value);
			return;
		}
		if (kb.matches(data, "tui.select.cancel")) {
			this.done(undefined);
			return;
		}
		if (matchesKey(data, "backspace")) {
			this.setQuery(this.query.slice(0, -1));
			return;
		}
		// Printable text: raw single-byte input (legacy terminals) or a Kitty
		// CSI-u sequence decoded back to its character (mirrors
		// `command-palette.ts`'s `data.length === 1 && !/\p{Cc}/u.test(data)`
		// check, extended to also accept Kitty-protocol printable sequences so
		// search still works under terminals that report keys via CSI-u).
		const printable = data.length === 1 && !/\p{Cc}/u.test(data) ? data : decodeKittyPrintable(data);
		if (printable !== undefined) {
			this.setQuery(`${this.query}${printable}`);
		}
	}

	public render(width: number): string[] {
		const w = Math.max(1, Math.floor(width));
		const lines: string[] = [];
		const items = this.filteredItems();

		lines.push(wrapPanelRow("", w));
		lines.push(wrapPanelRow(center(`${fg("✦", activeThemeColors().accent)}  ${fg(this.title.toUpperCase(), activeThemeColors().accent)}  ${fg("✦", activeThemeColors().accent)}`, w), w));
		lines.push(wrapPanelRow(splitRule(w), w));
		lines.push(wrapPanelRow("", w));
		if (this.tabs.length > 1) {
			lines.push(wrapPanelRow(center(this.renderTabs(), w), w));
			lines.push(wrapPanelRow("", w));
		}
		lines.push(wrapPanelRow(this.renderSearchRow(), w));
		lines.push(wrapPanelRow("", w));

		if (items.length === 0) {
			const message = this.query.length > 0 ? "no matches" : "no matching option";
			lines.push(wrapPanelRow(`     ${fg(UNFOCUSED_MARK, activeThemeColors().divider)}   ${fg(message, activeThemeColors().foregroundDim)}`, w));
		} else {
			const { startIndex, endIndex } = this.visibleRange(items.length);
			for (let index = startIndex; index < endIndex; index++) {
				lines.push(wrapPanelRow(this.renderRow(items[index]!, index === this.selectedIndex, w), w));
			}
			if (startIndex > 0 || endIndex < items.length) {
				// Aligned under the option labels (same 5-space + marker gutter the
				// rows use) instead of hugging the panel's left edge.
				const scrollText = `     ·   ${this.selectedIndex + 1} of ${items.length}`;
				lines.push(wrapPanelRow(fg(truncateToWidth(scrollText, w - 2, ""), activeThemeColors().foregroundDim), w));
			}
		}

		lines.push(wrapPanelRow("", w));
		lines.push(wrapPanelRow(splitRule(w), w));
		const hint = this.tabs.length > 1 ? INLINE_SELECTOR_TABBED_HINT_ROW : INLINE_SELECTOR_HINT_ROW;
		lines.push(wrapPanelRow(center(fg(hint, activeThemeColors().foregroundDim), w), w));
		lines.push(wrapPanelRow("", w));
		return lines;
	}

	private renderTabs(): string {
		const colors = activeThemeColors();
		return this.tabs.map((tab, index) => {
			const label = `${tab.label.toUpperCase()} ${tab.items.length}`;
			return index === this.activeTabIndex
				? fg(`◆ ${label}`, colors.accent)
				: fg(`◇ ${label}`, colors.foregroundDim);
		}).join(fg("  │  ", colors.divider));
	}

	/** Search row: typed query in normal text, or a dim placeholder when empty (mirrors `command-palette.ts`'s search row). */
	private renderSearchRow(): string {
		const colors = activeThemeColors();
		const marker = fg("❯", colors.accent);
		const hasQuery = this.query.length > 0;
		const text = hasQuery ? this.query : "type to search…";
		const styled = hasQuery ? fg(text, colors.foreground) : fg(text, colors.foregroundDim);
		return `     ${marker}  ${styled}`;
	}

	private visibleRange(itemCount: number): VisibleRange {
		const maxVisible = Math.max(1, this.maxVisible);
		const startIndex = Math.max(0, Math.min(this.selectedIndex - Math.floor(maxVisible / 2), itemCount - maxVisible));
		const endIndex = Math.min(startIndex + maxVisible, itemCount);
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

type SelectorResolution = string | undefined;

interface QueuedSelector {
	readonly create: (done: (value: SelectorResolution) => void) => Component;
	readonly resolve: (value: SelectorResolution) => void;
}

function isNumberOption(value: number | InlineSelectorComponentOptions): value is number {
	return typeof value === "number";
}

type VisibleRange = { startIndex: number; endIndex: number };

function isSelectOptsNumber(opts: number | { maxVisible?: number; initialValue?: string } | undefined): opts is number {
	return typeof opts === "number";
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
	private finish: ((value: SelectorResolution) => void) | undefined;
	private readonly queue: QueuedSelector[] = [];

	public constructor(
		private readonly editor: EditorLikeComponent,
		private readonly onChange: () => void = () => undefined,
	) {}

	/**
	 * Opens an inline selector; resolves with the chosen option, or
	 * `undefined` on Esc/cancel. `opts.initialValue` preselects the item with
	 * that value (e.g. /fork starts on the LATEST user message, matching pi).
	 */
	public select(
		title: string,
		options: readonly (string | InlineSelectorItem)[],
		opts?: number | { maxVisible?: number; initialValue?: string },
	): Promise<string | undefined> {
		const normalized = isSelectOptsNumber(opts) ? { maxVisible: opts } : opts ?? {};
		return this.enqueue((done) => new InlineSelectorComponent(title, options, done, normalized.maxVisible, normalized.initialValue));
	}

	/** Opens one selector split into tabs; Tab / Shift+Tab switches the active tab. */
	public selectTabs(
		title: string,
		tabs: readonly InlineSelectorTab[],
		opts: { maxVisible?: number; initialValue?: string; initialTabId?: string } = {},
	): Promise<string | undefined> {
		const componentOptions: InlineSelectorComponentOptions = { tabs };
		if (opts.maxVisible !== undefined) componentOptions.maxVisible = opts.maxVisible;
		if (opts.initialValue !== undefined) componentOptions.initialValue = opts.initialValue;
		if (opts.initialTabId !== undefined) componentOptions.initialTabId = opts.initialTabId;
		return this.enqueue((done) => new InlineSelectorComponent(title, [], done, componentOptions));
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

	private enqueue(create: (done: (value: string | undefined) => void) => Component): Promise<string | undefined> {
		return new Promise<string | undefined>((resolve) => {
			const entry: QueuedSelector = {
				create: (done) => create(done),
				resolve,
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

	private activate(entry: QueuedSelector): void {
		this.finish = (value: SelectorResolution) => {
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
