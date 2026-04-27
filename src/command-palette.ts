import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { Component, OverlayOptions } from "@mariozechner/pi-tui";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { colorHex, type ThinkingLevel } from "./footer.js";
import { CATHEDRAL_TOKENS } from "./tokens.js";

export type PaletteMode = "SESSION" | "MODEL" | "THINKING" | "MEMORY" | "THEME";

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

export const COMMAND_PALETTE_HINT_ROW = "↑↓ navigate    ⏎  select    esc  close";
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
	width: "60%",
	minWidth: 50,
	maxHeight: 20,
};

export const COMMAND_PALETTE_MODE_ROWS: readonly PaletteRow[] = [
	{ label: "SESSION", currentValue: "CURRENT: refactor-auth-flow" },
	{ label: "MODEL", currentValue: "CURRENT: claude-opus-4-7" },
	{ label: "THINKING", currentValue: "CURRENT: xhigh" },
	{ label: "MEMORY", currentValue: "OPEN MEMORY EDITOR" },
	{ label: "THEME", currentValue: "CURRENT: cathedral" },
];

const RESET = "\u001b[0m";
const ANSI_PATTERN = /\u001b\[[0-9;]*m/g;
const DIM = "\u001b[2m";

function visibleLength(text: string): number {
	return text.replace(ANSI_PATTERN, "").length;
}

function dim(text: string): string {
	return `${DIM}${colorHex(text, CATHEDRAL_TOKENS.colors.foregroundDim)}${RESET}`;
}

function divider(width: number): string {
	return colorHex("─".repeat(Math.max(0, width)), CATHEDRAL_TOKENS.colors.divider);
}

function padToWidth(text: string, width: number): string {
	const len = visibleWidth(text);
	if (len >= width) return truncateToWidth(text, width, "");
	return `${text}${" ".repeat(width - len)}`;
}

function center(text: string, width: number): string {
	const len = visibleLength(text);
	if (len >= width) return truncateToWidth(text, width, "");
	const left = Math.floor((width - len) / 2);
	const right = width - len - left;
	return `${" ".repeat(left)}${text}${" ".repeat(right)}`;
}

export function resolveCommandPaletteWidth(termWidth: number): number {
	return Math.min(80, Math.max(50, Math.floor(termWidth * 0.6)));
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
	const w = resolveCommandPaletteWidth(width);
	if (w <= 0) return [];

	const rows = filterPaletteRows(snapshot.rows, snapshot.searchQuery);
	const active = normalizedActiveIndex(snapshot, rows);
	const searchText = snapshot.searchQuery.length > 0 ? snapshot.searchQuery : "search…";
	const searchPadding = " ".repeat(Math.max(0, w - visibleLength(searchText) - 8));
	const lines: string[] = [];

	lines.push(center(colorHex("COMMAND PALETTE", CATHEDRAL_TOKENS.colors.accent), w));
	lines.push(divider(w));
	lines.push("");
	lines.push(padToWidth(`  ${colorHex("│", CATHEDRAL_TOKENS.colors.divider)} ${dim(searchText)}${searchPadding}${colorHex("│", CATHEDRAL_TOKENS.colors.divider)}`, w));
	lines.push("");

	if (rows.length === 0) {
		lines.push(padToWidth(dim("  no matching command"), w));
	} else {
		for (const [index, row] of rows.entries()) {
			const label = row.label.padEnd(14, " ");
			const content = `${label} ▶ ${row.currentValue}`;
			if (index === active) {
				const rail = colorHex("█", CATHEDRAL_TOKENS.colors.accent);
				lines.push(padToWidth(`  ${rail} ${colorHex(content, CATHEDRAL_TOKENS.colors.foreground)} ${rail}`, w));
			} else {
				lines.push(padToWidth(`    ${colorHex(content, CATHEDRAL_TOKENS.colors.foreground)}`, w));
			}
		}
	}

	lines.push("");
	lines.push(divider(w));
	lines.push(dim(COMMAND_PALETTE_HINT_ROW));
	return lines;
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
	const themeName = (ctx.ui.theme as { name?: string } | undefined)?.name ?? "cathedral";

	return {
		searchQuery: "",
		activeIndex: 0,
		rows: [
			{ label: "SESSION", currentValue: `CURRENT: ${sessionLabel}` },
			{ label: "MODEL", currentValue: `CURRENT: ${modelId}` },
			{ label: "THINKING", currentValue: `CURRENT: ${thinkingLevel}` },
			{ label: "MEMORY", currentValue: "OPEN MEMORY EDITOR" },
			{ label: "THEME", currentValue: `CURRENT: ${themeName}` },
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
		const selected = await ctx.ui.select("MODEL", models.map((model) => model.id));
		const model = models.find((candidate) => candidate.id === selected);
		if (model) await pi.setModel(model);
		return;
	}

	if (mode === "THINKING") {
		const selected = await ctx.ui.select("THINKING", [...COMMAND_PALETTE_THINKING_LEVELS]);
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
		const selected = await ctx.ui.select("THEME", themes);
		if (selected) ctx.ui.setTheme(selected);
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
	pi.registerCommand("sumo:memory", {
		description: "Open SumoCode memory browser (stub until Element 7 is installed)",
		handler: async (_args, ctx) => {
			ctx.ui.notify("memory editor ships in cathedral element 7", "info");
		},
	});

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
