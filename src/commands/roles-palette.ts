import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component, OverlayOptions } from "@earendil-works/pi-tui";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { activeThemeColors } from "../themes/index.js";

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
const RESET = "\u001b[0m";
const FG_RESET = "\u001b[39m";

export const ROLES_PALETTE_OVERLAY_OPTIONS: OverlayOptions = {
	anchor: "center",
	width: 80,
	minWidth: 50,
	maxHeight: 20,
};

// Intentionally duplicates the command-palette interaction core for plan 085;
// /roles remains locally adaptable without refactoring src/command-palette.ts.
function panelBg(): string {
	return activeThemeColors().surfaceLifted;
}

function paletteDivider(): string {
	return activeThemeColors().divider;
}

function ansiColor(hex: string, channel: 38 | 48): string {
	const normalized = hex.replace("#", "");
	const red = parseInt(normalized.slice(0, 2), 16);
	const green = parseInt(normalized.slice(2, 4), 16);
	const blue = parseInt(normalized.slice(4, 6), 16);
	return `\u001b[${channel};2;${red};${green};${blue}m`;
}

function fg(text: string, hex: string): string {
	return `${ansiColor(hex, 38)}${text}${FG_RESET}`;
}

function dim(text: string): string {
	return fg(text, activeThemeColors().foregroundDim);
}

function accent(text: string): string {
	return fg(text, activeThemeColors().accent);
}

function dividerText(text: string): string {
	return fg(text, paletteDivider());
}

function foreground(text: string): string {
	return fg(text, activeThemeColors().foreground);
}

function cursorCell(): string {
	return `${ansiColor(activeThemeColors().accent, 48)}${ansiColor(activeThemeColors().background, 38)} ${FG_RESET}${ansiColor(panelBg(), 48)}`;
}

function padToWidth(text: string, width: number): string {
	const len = visibleWidth(text);
	if (len >= width) return truncateToWidth(text, width, "");
	return `${text}${" ".repeat(width - len)}`;
}

function panelLine(text: string, width: number): string {
	return `${ansiColor(panelBg(), 48)}${ansiColor(activeThemeColors().foreground, 38)}${padToWidth(text, width)}${RESET}`;
}

function center(text: string, width: number): string {
	const len = visibleWidth(text);
	if (len >= width) return truncateToWidth(text, width, "");
	const left = Math.floor((width - len) / 2);
	const right = width - len - left;
	return `${" ".repeat(left)}${text}${" ".repeat(right)}`;
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

	lines.push(panelLine("", w));
	lines.push(panelLine(center(`${accent("✾")}  ${accent(options.title)}  ${accent("✾")}`, w), w));
	lines.push(panelLine("", w));
	lines.push(panelLine(center(`${dividerText(halfRule)}  ${dividerText("·")}  ${dividerText(halfRule)}`, w), w));
	lines.push(panelLine("", w));
	lines.push(panelLine(`     ${accent("❯")}  ${cursorCell()}${state.searchQuery.length > 0 ? foreground(searchText) : dim(searchText)}`, w));
	lines.push(panelLine("", w));

	if (filtered.length === 0) {
		lines.push(panelLine(`     ${dividerText("·")}   ${dim("no matching option")}`, w));
	} else {
		for (const [visibleIndex, row] of window.rows.entries()) {
			const focused = visibleIndex + window.offset === active;
			const marker = focused ? accent("❈") : dividerText("·");
			const label = focused ? foreground(row.label) : dim(row.label);
			const value = focused ? foreground(row.value) : dim(row.value);
			const left = `     ${marker}   ${label}`;
			const padBetween = Math.max(2, w - visibleWidth(left) - visibleWidth(value) - 5);
			lines.push(panelLine(`${left}${" ".repeat(padBetween)}${value}`, w));
		}
	}

	lines.push(panelLine("", w));
	lines.push(panelLine(center(`${dividerText(halfRule)}  ${dividerText("·")}  ${dividerText(halfRule)}`, w), w));
	lines.push(panelLine(center(dim(HINT_ROW), w), w));
	lines.push(panelLine("", w));
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

export async function showSearchPalette(
	ctx: Pick<ExtensionContext, "ui">,
	options: SearchPaletteOptions,
): Promise<string | undefined> {
	// The RPC cathedral shell hosts custom components via the extension-ui adapter (plan 085 fix; operator-verified 2026-08-25).
	return ctx.ui.custom<string | undefined>(
		(_tui, _theme, _keybindings, done) => new SearchPaletteComponent(options, {
			searchQuery: "",
			activeIndex: 0,
			rows: options.rows,
		}, done),
		{ overlay: true, overlayOptions: ROLES_PALETTE_OVERLAY_OPTIONS },
	);
}
