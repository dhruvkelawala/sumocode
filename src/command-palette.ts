import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { Component, OverlayOptions } from "@mariozechner/pi-tui";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import type { ThinkingLevel } from "./footer.js";
import { showDivineQuery } from "./divine-query.js";
import { activeThemeColors, getActiveTheme } from "./themes/index.js";

export type PaletteMode = "SESSION" | "MODEL" | "THINKING" | "MEMORY" | "THEME" | "SETTINGS";

export type PaletteRow = {
	label: PaletteMode;
	currentValue: string;
};

export type CommandPaletteSnapshot = {
	searchQuery: string;
	activeIndex: number;
	rows: readonly PaletteRow[];
};

export type PaletteInputResult = {
	snapshot: CommandPaletteSnapshot;
	done?: boolean;
	selection?: PaletteMode;
};

export const COMMAND_PALETTE_HINT_ROW = "↑↓ wander    ⏎ attend    ⎋ retreat";
export const COMMAND_PALETTE_THINKING_LEVELS: readonly ThinkingLevel[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
];

export const COMMAND_PALETTE_SHORTCUT = "ctrl+/";

export const COMMAND_PALETTE_OVERLAY_OPTIONS: OverlayOptions = {
	anchor: "center",
	width: 80,
	minWidth: 50,
	maxHeight: 20,
};

export const COMMAND_PALETTE_MODE_ROWS: readonly PaletteRow[] = [
	{ label: "SESSION", currentValue: "auth-flow-refactor" },
	{ label: "MODEL", currentValue: "claude-opus-4-7" },
	{ label: "THINKING", currentValue: "xhigh" },
	{ label: "MEMORY", currentValue: "55 facts" },
	{ label: "THEME", currentValue: "cathedral" },
	{ label: "SETTINGS", currentValue: "" },
];

const RESET = "\u001b[0m";
const FG_RESET = "\u001b[39m";
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

export function resolveCommandPaletteWidth(termWidth: number): number {
	return Math.min(80, Math.max(1, Math.floor(termWidth)));
}

export function filterPaletteRows(rows: readonly PaletteRow[], searchQuery: string): PaletteRow[] {
	const query = searchQuery.trim().toLowerCase();
	if (query.length === 0) return [...rows];
	return rows.filter((row) => row.label.toLowerCase().includes(query));
}

function normalizedActiveIndex(snapshot: CommandPaletteSnapshot, rows: readonly PaletteRow[]): number {
	if (rows.length === 0) return 0;
	return Math.min(Math.max(0, snapshot.activeIndex), rows.length - 1);
}

export function renderCommandPalette(snapshot: CommandPaletteSnapshot, width: number): string[] {
	const w = Math.max(1, Math.floor(width));
	const rows = filterPaletteRows(snapshot.rows, snapshot.searchQuery);
	const active = normalizedActiveIndex(snapshot, rows);
	const searchText = snapshot.searchQuery.length > 0 ? snapshot.searchQuery : "what shall we attend to…";
	const halfRule = "─".repeat(22);
	const lines: string[] = [];

	lines.push(panelLine("", w));
	lines.push(panelLine(center(`${accent("✾")}  ${accent("COMMAND PALETTE")}  ${accent("✾")}`, w), w));
	lines.push(panelLine("", w));
	lines.push(panelLine(center(`${dividerText(halfRule)}  ${dividerText("·")}  ${dividerText(halfRule)}`, w), w));
	lines.push(panelLine("", w));
	lines.push(panelLine(`     ${accent("❯")}  ${cursorCell()}${snapshot.searchQuery.length > 0 ? foreground(searchText) : dim(searchText)}`, w));
	lines.push(panelLine("", w));

	if (rows.length === 0) {
		lines.push(panelLine(`     ${dividerText("·")}   ${dim("no matching command")}`, w));
	} else {
		for (const [index, row] of rows.entries()) {
			const focused = index === active;
			const marker = focused ? accent("❈") : dividerText("·");
			const label = focused ? foreground(row.label) : dim(row.label);
			const value = displayPaletteValue(row);
			const valueText = value.length > 0 ? (focused ? foreground(value) : dim(value)) : "";
			const left = `     ${marker}   ${label}`;
			const padBetween = Math.max(2, w - visibleWidth(left) - visibleWidth(valueText) - 5);
			lines.push(panelLine(`${left}${" ".repeat(padBetween)}${valueText}`, w));
		}
	}

	lines.push(panelLine("", w));
	lines.push(panelLine(center(`${dividerText(halfRule)}  ${dividerText("·")}  ${dividerText(halfRule)}`, w), w));
	lines.push(panelLine(center(dim(COMMAND_PALETTE_HINT_ROW), w), w));
	lines.push(panelLine("", w));
	return lines;
}

function displayPaletteValue(row: PaletteRow): string {
	return row.currentValue.replace(/^CURRENT:\s*/i, "").trim();
}

/**
 * Returns true if `data` matches a key, accepting either a real byte sequence
 * (Pi runtime input) or a Key.<id> string (test input).
 */
// Type-helper for parametric Key.* IDs.
type AnyKey = Parameters<typeof matchesKey>[1];

function keyEq(data: string, ...ids: readonly AnyKey[]): boolean {
	for (const id of ids) {
		if (data === (id as string)) return true;
		if (matchesKey(data, id)) return true;
	}
	return false;
}

export function updateCommandPaletteSnapshot(snapshot: CommandPaletteSnapshot, data: string): PaletteInputResult {
	const rows = filterPaletteRows(snapshot.rows, snapshot.searchQuery);
	const active = normalizedActiveIndex(snapshot, rows);

	if (keyEq(data, Key.escape, Key.esc)) {
		return { snapshot, done: true, selection: undefined };
	}
	if (keyEq(data, Key.enter, Key.return)) {
		return { snapshot: { ...snapshot, activeIndex: active }, done: true, selection: rows[active]?.label };
	}
	if (keyEq(data, Key.down)) {
		return { snapshot: { ...snapshot, activeIndex: Math.min(Math.max(0, rows.length - 1), active + 1) } };
	}
	if (keyEq(data, Key.up)) {
		return { snapshot: { ...snapshot, activeIndex: Math.max(0, active - 1) } };
	}
	if (keyEq(data, Key.backspace)) {
		return { snapshot: { ...snapshot, searchQuery: snapshot.searchQuery.slice(0, -1), activeIndex: 0 } };
	}
	if (data.length === 1 && !/\p{Cc}/u.test(data)) {
		return { snapshot: { ...snapshot, searchQuery: `${snapshot.searchQuery}${data}`, activeIndex: 0 } };
	}

	return { snapshot: { ...snapshot, activeIndex: active } };
}

export class CommandPaletteComponent implements Component {
	constructor(
		private snapshot: CommandPaletteSnapshot,
		private readonly done: (result: PaletteMode | undefined) => void,
	) {}

	invalidate(): void {}

	handleInput(data: string): void {
		const result = updateCommandPaletteSnapshot(this.snapshot, data);
		this.snapshot = result.snapshot;
		if (result.done) this.done(result.selection);
	}

	render(width: number): string[] {
		return renderCommandPalette(this.snapshot, width);
	}
}

type PaletteSnapshotContext = Pick<ExtensionContext, "sessionManager" | "model" | "ui"> & {
	getThinkingLevel?: () => ThinkingLevel;
};

export function buildPaletteSnapshot(ctx: PaletteSnapshotContext): CommandPaletteSnapshot {
	const sessionLabel = ctx.sessionManager.getSessionName() ?? ctx.sessionManager.getSessionId().split("-")[0] ?? "current-session";
	const modelId = ctx.model?.id ?? "no-model";
	const thinkingLevel = ctx.getThinkingLevel?.() ?? "medium";
	// Read from the SumoCode theme registry, not `ctx.ui.theme`. Pi's theme API
	// only knows its own built-ins (catppuccin/dracula), so for SumoCode-only
	// themes (e.g. `obsidian`) Pi rejects `setTheme` and `ctx.ui.theme.name`
	// stays on the previous Pi theme. The SumoCode registry is the authoritative
	// source of truth for which theme is currently rendering.
	const themeName = getActiveTheme().name;

	return {
		searchQuery: "",
		activeIndex: 1,
		rows: [
			{ label: "SESSION", currentValue: sessionLabel },
			{ label: "MODEL", currentValue: modelId },
			{ label: "THINKING", currentValue: thinkingLevel },
			{ label: "MEMORY", currentValue: "55 facts" },
			{ label: "THEME", currentValue: themeName },
			{ label: "SETTINGS", currentValue: "" },
		],
	};
}

export async function handlePaletteSelection(mode: PaletteMode | undefined, ctx: ExtensionContext, pi: ExtensionAPI): Promise<void> {
	if (mode === undefined) return;

	if (mode === "SESSION") {
		ctx.ui.setEditorText("/sessions");
		return;
	}

	if (mode === "MODEL") {
		const models = ctx.modelRegistry.getAvailable();
		const selected = await showDivineQuery(ctx, "Choose a model", models.map((model) => model.id));
		const model = models.find((candidate) => candidate.id === selected);
		if (model) await pi.setModel(model);
		return;
	}

	if (mode === "THINKING") {
		const selected = await showDivineQuery(ctx, "Set thinking level", [...COMMAND_PALETTE_THINKING_LEVELS]);
		if (selected && COMMAND_PALETTE_THINKING_LEVELS.includes(selected as ThinkingLevel)) {
			pi.setThinkingLevel(selected as ThinkingLevel);
		}
		return;
	}

	if (mode === "MEMORY") {
		ctx.ui.setEditorText("/sumo:memory");
		return;
	}

	if (mode === "THEME") {
		const themes = ctx.ui.getAllThemes().map((theme) => theme.name);
		const selected = await showDivineQuery(ctx, "Choose a theme", themes);
		if (selected) ctx.ui.setTheme(selected);
		return;
	}

	if (mode === "SETTINGS") {
		ctx.ui.setEditorText("/settings");
		return;
	}
}

export async function cycleModel(ctx: ExtensionContext, pi: ExtensionAPI, direction: 1 | -1): Promise<void> {
	const models = ctx.modelRegistry.getAvailable();
	if (models.length === 0) return;
	const currentIndex = Math.max(0, models.findIndex((model) => model.id === ctx.model?.id));
	const nextIndex = (currentIndex + direction + models.length) % models.length;
	await pi.setModel(models[nextIndex]!);
}

export function installCommandPalette(pi: ExtensionAPI): void {
	pi.registerShortcut(COMMAND_PALETTE_SHORTCUT, {
		description: "Open SumoCode command palette",
		handler: async (ctx) => {
			if (!ctx.hasUI) return;
			const selection = await ctx.ui.custom<PaletteMode | undefined>(
				(_tui, _theme, _keybindings, done) =>
					new CommandPaletteComponent(
						buildPaletteSnapshot({ ...ctx, getThinkingLevel: () => pi.getThinkingLevel() } as never),
						done,
					),
				{ overlay: true, overlayOptions: COMMAND_PALETTE_OVERLAY_OPTIONS },
			);
			await handlePaletteSelection(selection, ctx, pi);
		},
	});

}
