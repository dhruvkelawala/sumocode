import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component, OverlayOptions } from "@earendil-works/pi-tui";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import { activeThemeColors } from "../themes/index.js";
import {
	lineToAnsi,
	lineWidth,
	span,
	textLine,
	truncateLine,
	type Span,
	type Style,
} from "../sumo-tui/render/primitives.js";

export interface SearchPaletteRow {
	readonly id: string;
	readonly label: string;
	readonly value: string;
}

export interface SearchPaletteOptions {
	readonly title: string;
	readonly placeholder: string;
	readonly rows: readonly SearchPaletteRow[];
}

export interface SearchPaletteState {
	readonly searchQuery: string;
	readonly activeIndex: number;
	readonly rows: readonly SearchPaletteRow[];
}

export interface SearchPaletteInputResult {
	readonly state: SearchPaletteState;
	readonly done?: boolean;
	readonly selection?: string;
}

const HINT_ROW = "↑↓ wander    ⎏ filter    ⏎ attend    ⎋ retreat";
const MAX_VISIBLE_ROWS = 9;

export const ROLES_PALETTE_OVERLAY_OPTIONS: OverlayOptions = {
	anchor: "center",
	width: 80,
	minWidth: 50,
	maxHeight: 20,
};

// Intentionally duplicates the command-palette interaction core for plan 085;
// /roles remains locally adaptable without refactoring src/command-palette.ts.
// Rendering still uses the shared typed primitives so Cathedral colors, resets,
// padding, and terminal-cell truncation retain one owner.
function panelStyle(): Style {
	const colors = activeThemeColors();
	return { fg: colors.foreground, bg: colors.surfaceLifted };
}

function colored(text: string, fg: string): Span {
	return span(text, { fg });
}

function dim(text: string): Span {
	return colored(text, activeThemeColors().foregroundDim);
}

function accent(text: string): Span {
	return colored(text, activeThemeColors().accent);
}

function dividerText(text: string): Span {
	return colored(text, activeThemeColors().divider);
}

function foreground(text: string): Span {
	return colored(text, activeThemeColors().foreground);
}

function cursorCell(): Span {
	const colors = activeThemeColors();
	return span(" ", { fg: colors.background, bg: colors.accent });
}

function panelLine(parts: readonly (Span | string)[], width: number): string {
	const style = panelStyle();
	return lineToAnsi(textLine(parts, style), { width, style });
}

function centered(parts: readonly (Span | string)[], width: number): readonly (Span | string)[] {
	const content = truncateLine(textLine(parts), width);
	const contentWidth = lineWidth(content);
	const left = Math.floor((width - contentWidth) / 2);
	const right = width - contentWidth - left;
	return [" ".repeat(left), ...content.spans, " ".repeat(right)];
}

export function filterRows(rows: readonly SearchPaletteRow[], searchQuery: string): SearchPaletteRow[] {
	const query = searchQuery.trim().toLowerCase();
	if (query.length === 0) return [...rows];
	return rows.filter((row) => `${row.label} ${row.value}`.toLowerCase().includes(query));
}

function normalizedActiveIndex(state: SearchPaletteState, rows: readonly SearchPaletteRow[]): number {
	if (rows.length === 0) return 0;
	return Math.min(Math.max(0, state.activeIndex), rows.length - 1);
}

function visibleRows(rows: readonly SearchPaletteRow[], activeIndex: number): { rows: readonly SearchPaletteRow[]; offset: number } {
	if (rows.length <= MAX_VISIBLE_ROWS) return { rows, offset: 0 };
	const maxOffset = rows.length - MAX_VISIBLE_ROWS;
	const offset = Math.min(maxOffset, Math.max(0, activeIndex - Math.floor(MAX_VISIBLE_ROWS / 2)));
	return { rows: rows.slice(offset, offset + MAX_VISIBLE_ROWS), offset };
}

function renderPalette(options: Pick<SearchPaletteOptions, "title" | "placeholder">, state: SearchPaletteState, width: number): string[] {
	const w = Math.max(1, Math.floor(width));
	const filtered = filterRows(state.rows, state.searchQuery);
	const active = normalizedActiveIndex(state, filtered);
	const window = visibleRows(filtered, active);
	const searchText = state.searchQuery.length > 0 ? state.searchQuery : options.placeholder;
	const halfRule = "─".repeat(22);
	const lines: string[] = [];

	lines.push(panelLine([], w));
	lines.push(panelLine(centered([accent("✾"), "  ", accent(options.title), "  ", accent("✾")], w), w));
	lines.push(panelLine([], w));
	lines.push(panelLine(centered([dividerText(halfRule), "  ", dividerText("·"), "  ", dividerText(halfRule)], w), w));
	lines.push(panelLine([], w));
	// Caret trails the typed query (❯ res█); leads the placeholder when empty.
	lines.push(panelLine(state.searchQuery.length > 0
		? ["     ", accent("❯"), "  ", foreground(searchText), cursorCell()]
		: ["     ", accent("❯"), "  ", cursorCell(), dim(searchText)], w));
	lines.push(panelLine([], w));

	if (filtered.length === 0) {
		lines.push(panelLine(["     ", dividerText("·"), "   ", dim("no matching option")], w));
	} else {
		for (const [visibleIndex, row] of window.rows.entries()) {
			const focused = visibleIndex + window.offset === active;
			const marker = focused ? accent("❈") : dividerText("·");
			const label = focused ? foreground(row.label) : dim(row.label);
			const value = focused ? foreground(row.value) : dim(row.value);
			const left = textLine(["     ", marker, "   ", label]);
			const padBetween = Math.max(2, w - lineWidth(left) - lineWidth(textLine([value])) - 5);
			lines.push(panelLine([...left.spans, " ".repeat(padBetween), value], w));
		}
	}

	lines.push(panelLine([], w));
	lines.push(panelLine(centered([dividerText(halfRule), "  ", dividerText("·"), "  ", dividerText(halfRule)], w), w));
	lines.push(panelLine(centered([dim(HINT_ROW)], w), w));
	lines.push(panelLine([], w));
	return lines;
}

type AnyKey = Parameters<typeof matchesKey>[1];

function keyEq(data: string, ...ids: readonly AnyKey[]): boolean {
	for (const id of ids) {
		if (data === (id as string)) return true;
		if (matchesKey(data, id)) return true;
	}
	return false;
}

export function updatePaletteState(state: SearchPaletteState, data: string): SearchPaletteInputResult {
	const rows = filterRows(state.rows, state.searchQuery);
	const active = normalizedActiveIndex(state, rows);

	if (keyEq(data, Key.escape, Key.esc)) return { state, done: true, selection: undefined };
	if (keyEq(data, Key.enter, Key.return)) {
		return { state: { ...state, activeIndex: active }, done: true, selection: rows[active]?.id };
	}
	if (keyEq(data, Key.down, Key.tab)) {
		return { state: { ...state, activeIndex: rows.length === 0 ? 0 : (active + 1) % rows.length } };
	}
	if (keyEq(data, Key.up, Key.shift(Key.tab))) {
		return { state: { ...state, activeIndex: rows.length === 0 ? 0 : (active - 1 + rows.length) % rows.length } };
	}
	if (keyEq(data, Key.backspace)) {
		return { state: { ...state, searchQuery: state.searchQuery.slice(0, -1), activeIndex: 0 } };
	}
	if (data.length === 1 && !/\p{Cc}/u.test(data)) {
		return { state: { ...state, searchQuery: `${state.searchQuery}${data}`, activeIndex: 0 } };
	}
	return { state: { ...state, activeIndex: active } };
}

class SearchPaletteComponent implements Component {
	constructor(
		private readonly options: Pick<SearchPaletteOptions, "title" | "placeholder">,
		private state: SearchPaletteState,
		private readonly done: (result: string | undefined) => void,
	) {}

	invalidate(): void {}

	handleInput(data: string): void {
		const result = updatePaletteState(this.state, data);
		this.state = result.state;
		if (result.done) this.done(result.selection);
	}

	render(width: number): string[] {
		return renderPalette(this.options, this.state, width);
	}
}

function rowLabel(row: SearchPaletteRow): string {
	return row.value.length > 0 ? `${row.label}  ${row.value}` : row.label;
}

export async function showSearchPalette(
	ctx: Pick<ExtensionContext, "mode" | "ui">,
	options: SearchPaletteOptions,
): Promise<string | undefined> {
	// In RPC mode `ctx.ui.custom()` is a DOCUMENTED no-op returning undefined
	// (pi docs/extensions.md §run modes: “RPC … custom() returns undefined”) —
	// component factories cannot cross the process boundary. Fall back to
	// ctx.ui.select, which the cathedral shell renders as a search-mode Divine
	// Query modal for long lists (type-to-filter; see widgets/modal.ts
	// SELECT_SEARCH_THRESHOLD, plan 085 fix).
	if (ctx.mode === "rpc") {
		const labels = options.rows.map(rowLabel);
		const selected = await ctx.ui.select(options.title, labels);
		const selectedIndex = selected === undefined ? -1 : labels.indexOf(selected);
		return selectedIndex < 0 ? undefined : options.rows[selectedIndex]?.id;
	}

	return ctx.ui.custom<string | undefined>(
		(_tui, _theme, _keybindings, done) => new SearchPaletteComponent(options, {
			searchQuery: "",
			activeIndex: 0,
			rows: options.rows,
		}, done),
		{ overlay: true, overlayOptions: ROLES_PALETTE_OVERLAY_OPTIONS },
	);
}
