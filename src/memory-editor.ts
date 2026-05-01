/**
 * Cathedral Memory Scriptorium (Element 7 from CATHEDRAL_UX_SPEC_V2.md).
 *
 * Replaces Pi's default memory listing with a Scriptorium-themed overlay
 * that groups facts into 6 cathedral panels (IDENTITY · PREFERENCES ·
 * WORKFLOW · PROJECTS · SYSTEM · GENERAL — GENERAL hidden when empty).
 *
 * Triggered via `/sumo:memory` or `/sumo:memory edit`.
 *
 * Visual contract (matches `docs/ui/bible/07-memory-editor.html`):
 *
 *                         ✾  MEMORY SCRIPTORIUM  ✾
 *
 *            ──────────────────────────────  ·  ──────────────────────────────
 *
 *   ❯  █search remembered facts…                                      48 facts
 *
 *   ╭───────── IDENTITY ─────────╮  ╭──────── PREFERENCES ────────╮
 *   │ · Dhruv · Senior FE · Argent│  │ ❈ prefers TypeScript strict │
 *   │ · London / BST              │  │ · pnpm not npm              │
 *   ╰─────────────────────────────╯  ╰─────────────────────────────╯
 *   …
 *            ──────────────────────────────  ·  ──────────────────────────────
 *                 ↑↓ wander    /  search    e  revise    d  forget    ⎋ retreat
 */

import type { Component, KeybindingsManager, OverlayHandle, TUI } from "@mariozechner/pi-tui";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { matchesKey } from "@mariozechner/pi-tui";
import {
	createRemnicMemoryClient,
	MemoryClientError,
	type MemoryFact,
	type RemnicMemoryClient,
} from "./memory.js";
import {
	groupFactsByPanel,
	MEMORY_PANELS,
	type PanelGroup,
	type PanelId,
} from "./memory-categorization.js";
import { CATHEDRAL_TOKENS } from "./tokens.js";

const RESET = "[0m";
const ANSI_PATTERN = /\[[0-9;]*m/g;

const TITLE_MARK = "✾";
const FOCUSED_MARK = "❈";
const UNFOCUSED_MARK = "·";
const SEARCH_PROMPT = "❯";

const TOP_LEFT = "╭";
const TOP_RIGHT = "╮";
const BOTTOM_LEFT = "╰";
const BOTTOM_RIGHT = "╯";
const HORIZONTAL = "─";
const VERTICAL = "│";

// ── Style helpers ─────────────────────────────────────────────

function visibleLength(text: string): number {
	return text.replace(ANSI_PATTERN, "").length;
}

function fg(text: string, hex: string): string {
	const h = hex.replace("#", "");
	const r = parseInt(h.slice(0, 2), 16);
	const g = parseInt(h.slice(2, 4), 16);
	const b = parseInt(h.slice(4, 6), 16);
	return `[38;2;${r};${g};${b}m${text}${RESET}`;
}

/**
 * Wrap a line in surfaceLifted bg + Cathedral foreground, restoring both
 * after every internal RESET so nested ANSI doesn't fall through to terminal
 * default colors. Mirrors the helper in `divine-query.ts`.
 */
function persistentBg(text: string, fgHex: string, bgHex: string): string {
	const fh = fgHex.replace("#", "");
	const bh = bgHex.replace("#", "");
	const fr = parseInt(fh.slice(0, 2), 16);
	const fgCode = parseInt(fh.slice(2, 4), 16);
	const fb = parseInt(fh.slice(4, 6), 16);
	const br = parseInt(bh.slice(0, 2), 16);
	const bg = parseInt(bh.slice(2, 4), 16);
	const bb = parseInt(bh.slice(4, 6), 16);
	const styleCode = `[38;2;${fr};${fgCode};${fb}m[48;2;${br};${bg};${bb}m`;
	return `${styleCode}${text.replace(/\[0m/g, `${RESET}${styleCode}`)}${RESET}`;
}

function center(line: string, width: number): string {
	const len = visibleLength(line);
	if (len >= width) return line;
	const pad = Math.floor((width - len) / 2);
	return `${" ".repeat(pad)}${line}${" ".repeat(width - len - pad)}`;
}

function padRight(line: string, width: number): string {
	const len = visibleLength(line);
	if (len >= width) return line;
	return `${line}${" ".repeat(width - len)}`;
}

function splitRule(width: number): string {
	const ruleLen = Math.max(1, Math.floor((width - 6) / 2 - 12));
	const left = fg(HORIZONTAL.repeat(ruleLen), CATHEDRAL_TOKENS.colors.divider);
	const dot = fg("·", CATHEDRAL_TOKENS.colors.divider);
	const right = fg(HORIZONTAL.repeat(ruleLen), CATHEDRAL_TOKENS.colors.divider);
	return center(`${left}  ${dot}  ${right}`, width);
}

// ── Snapshot ──────────────────────────────────────────────────

export interface MemoryEditorSnapshot {
	readonly searchQuery: string;
	readonly groups: readonly PanelGroup[];
	readonly factsTotal: number;
	/** ID of the fact currently highlighted with `❈`. `null` = no focus. */
	readonly focusedFactId: string | null;
}

/**
 * V2 footer hint copy from the Bible. Includes the `e` (revise) and `d`
 * (forget) keybinds used by `MemoryEditorComponent.handleInput`.
 */
export const MEMORY_EDITOR_HINTS = "↑↓ wander    /  search    e  revise    d  forget    ⎋ retreat";

// ── Search filter ─────────────────────────────────────────────

function filterGroups(groups: readonly PanelGroup[], query: string): PanelGroup[] {
	const trimmed = query.trim().toLowerCase();
	if (trimmed.length === 0) return groups.map((g) => ({ ...g, facts: [...g.facts] }));
	return groups.map((group) => ({
		panel: group.panel,
		facts: group.facts.filter((fact) => fact.text.toLowerCase().includes(trimmed)),
	}));
}

/** Flatten visible facts into a single ordered list — used for navigation. */
function visibleFactOrder(groups: readonly PanelGroup[]): MemoryFact[] {
	const order: MemoryFact[] = [];
	for (const group of groups) for (const fact of group.facts) order.push(fact);
	return order;
}

function nextFocusId(groups: readonly PanelGroup[], current: string | null, direction: 1 | -1): string | null {
	const order = visibleFactOrder(groups);
	if (order.length === 0) return null;
	const currentIndex = current !== null ? order.findIndex((fact) => fact.id === current) : -1;
	const nextIndex = currentIndex < 0
		? (direction === 1 ? 0 : order.length - 1)
		: (currentIndex + direction + order.length) % order.length;
	return order[nextIndex]?.id ?? null;
}

// ── Pure render ──────────────────────────────────────────────

/**
 * Render one panel's `╭─ NAME ─╮ │ … │ ╰─╯` sub-card at `panelWidth` cells.
 * Returns lines whose visible width is exactly `panelWidth`.
 */
function renderPanel(group: PanelGroup, panelWidth: number, focusedFactId: string | null): string[] {
	const innerWidth = Math.max(20, panelWidth);
	const labelInner = ` ${group.panel} `;
	const labelLen = labelInner.length;
	const dashesTotal = Math.max(2, innerWidth - 2 - labelLen);
	const leftDashes = Math.max(1, Math.floor(dashesTotal / 2));
	const rightDashes = Math.max(1, dashesTotal - leftDashes);

	const top = `${fg(`${TOP_LEFT}${HORIZONTAL.repeat(leftDashes)}`, CATHEDRAL_TOKENS.colors.divider)}${fg(labelInner, CATHEDRAL_TOKENS.colors.accent)}${fg(`${HORIZONTAL.repeat(rightDashes)}${TOP_RIGHT}`, CATHEDRAL_TOKENS.colors.divider)}`;
	const bottom = fg(`${BOTTOM_LEFT}${HORIZONTAL.repeat(innerWidth - 2)}${BOTTOM_RIGHT}`, CATHEDRAL_TOKENS.colors.divider);

	const lines: string[] = [top];

	if (group.facts.length === 0) {
		const empty = ` ${fg("(empty)", CATHEDRAL_TOKENS.colors.foregroundDim)}`;
		const bordered = `${fg(VERTICAL, CATHEDRAL_TOKENS.colors.divider)}${padRight(empty, innerWidth - 2)}${fg(VERTICAL, CATHEDRAL_TOKENS.colors.divider)}`;
		lines.push(bordered);
	} else {
		for (const fact of group.facts) {
			const focused = fact.id === focusedFactId;
			const mark = focused
				? fg(FOCUSED_MARK, CATHEDRAL_TOKENS.colors.accent)
				: fg(UNFOCUSED_MARK, CATHEDRAL_TOKENS.colors.divider);
			// 4 cols of chrome inside the frame: ` <mark> <space> ` + trailing ` `.
			const textWidth = Math.max(1, innerWidth - 6);
			const truncated = fact.text.length > textWidth
				? `${fact.text.slice(0, Math.max(0, textWidth - 1))}…`
				: fact.text;
			const text = fg(truncated, CATHEDRAL_TOKENS.colors.foreground);
			const content = ` ${mark} ${text}`;
			const bordered = `${fg(VERTICAL, CATHEDRAL_TOKENS.colors.divider)}${padRight(content, innerWidth - 2)}${fg(VERTICAL, CATHEDRAL_TOKENS.colors.divider)}`;
			lines.push(bordered);
		}
	}

	lines.push(bottom);
	return lines;
}

export function renderMemoryEditor(snapshot: MemoryEditorSnapshot, width: number): string[] {
	if (width < 20) return [];
	const lines: string[] = [];

	// Blank
	lines.push("");

	// Title: ✾  MEMORY SCRIPTORIUM  ✾
	const titleText = `${fg(TITLE_MARK, CATHEDRAL_TOKENS.colors.accent)}  ${fg("MEMORY SCRIPTORIUM", CATHEDRAL_TOKENS.colors.accent)}  ${fg(TITLE_MARK, CATHEDRAL_TOKENS.colors.accent)}`;
	lines.push(center(titleText, width));

	// Blank
	lines.push("");

	// Top split rule
	lines.push(splitRule(width));

	// Blank
	lines.push("");

	// Search row: `   ❯  <query|placeholder>      <N facts>   `
	const indent = "   ";
	const placeholder = snapshot.searchQuery.length === 0
		? fg("search remembered facts…", CATHEDRAL_TOKENS.colors.foregroundDim)
		: fg(snapshot.searchQuery, CATHEDRAL_TOKENS.colors.foreground);
	const factCount = fg(`${snapshot.factsTotal} facts`, CATHEDRAL_TOKENS.colors.foregroundDim);
	const searchLeft = `${indent}${fg(SEARCH_PROMPT, CATHEDRAL_TOKENS.colors.accent)}  ${placeholder}`;
	const searchRight = `${factCount}${indent}`;
	const gap = Math.max(2, width - visibleLength(searchLeft) - visibleLength(searchRight));
	lines.push(`${searchLeft}${" ".repeat(gap)}${searchRight}`);

	// Blank
	lines.push("");

	// 2-up panel grid. Left + right panels separated by 2-col gap, each panel
	// gets `(width - 2*indentCols - gap) / 2` cells. `indentCols = 3` to match
	// the Bible mockup margin.
	const sideIndent = 3;
	const gridGap = 2;
	const panelWidth = Math.max(20, Math.floor((width - 2 * sideIndent - gridGap) / 2));
	const groups = filterGroups(snapshot.groups, snapshot.searchQuery).filter((g) => !(g.panel === "GENERAL" && g.facts.length === 0));

	for (let i = 0; i < groups.length; i += 2) {
		const left = renderPanel(groups[i]!, panelWidth, snapshot.focusedFactId);
		const right = i + 1 < groups.length ? renderPanel(groups[i + 1]!, panelWidth, snapshot.focusedFactId) : null;
		const rowCount = right ? Math.max(left.length, right.length) : left.length;
		for (let r = 0; r < rowCount; r += 1) {
			const leftLine = padRight(left[r] ?? "", panelWidth);
			const rightLine = right ? padRight(right[r] ?? "", panelWidth) : " ".repeat(panelWidth);
			lines.push(`${" ".repeat(sideIndent)}${leftLine}${" ".repeat(gridGap)}${rightLine}${" ".repeat(sideIndent)}`);
		}
		lines.push("");
	}

	// Bottom split rule
	lines.push(splitRule(width));

	// Footer hints
	const footer = fg(MEMORY_EDITOR_HINTS, CATHEDRAL_TOKENS.colors.foregroundDim);
	lines.push(center(footer, width));

	// Blank
	lines.push("");

	// Wrap every row in surfaceLifted bg + Cathedral foreground.
	return lines.map((line) => persistentBg(
		padRight(line, width),
		CATHEDRAL_TOKENS.colors.foreground,
		CATHEDRAL_TOKENS.colors.surfaceLifted,
	));
}

// ── Pi component + overlay ───────────────────────────────────

export type MemoryNotifyLevel = "info" | "warning" | "error";

export interface MemoryEditorComponentDeps {
	readonly client?: RemnicMemoryClient;
	readonly notify?: (text: string, level?: MemoryNotifyLevel) => void;
}

class MemoryEditorComponent implements Component {
	private snapshot: MemoryEditorSnapshot;
	private readonly client: RemnicMemoryClient | undefined;
	private readonly notify: MemoryEditorComponentDeps["notify"];
	private readonly done: () => void;

	constructor(initial: MemoryEditorSnapshot, done: () => void, deps: MemoryEditorComponentDeps = {}) {
		this.snapshot = initial;
		this.client = deps.client;
		this.notify = deps.notify;
		this.done = done;
	}

	invalidate(): void {}

	handleInput(data: string): void {
		if (data === "escape" || matchesKey(data, "escape")) {
			this.done();
			return;
		}

		// Up/down navigate focused fact across the visible (filtered) list.
		if (data === "up" || matchesKey(data, "up")) {
			this.snapshot = { ...this.snapshot, focusedFactId: nextFocusId(filterGroups(this.snapshot.groups, this.snapshot.searchQuery), this.snapshot.focusedFactId, -1) };
			return;
		}
		if (data === "down" || matchesKey(data, "down")) {
			this.snapshot = { ...this.snapshot, focusedFactId: nextFocusId(filterGroups(this.snapshot.groups, this.snapshot.searchQuery), this.snapshot.focusedFactId, 1) };
			return;
		}

		// `d` forgets the focused fact via Remnic.
		if (data === "d" && this.snapshot.focusedFactId) {
			const id = this.snapshot.focusedFactId;
			void this.forgetFocused(id);
			return;
		}

		// `e` is reserved for inline revise. Tracked as a follow-up; emit a
		// hint so users know how to revise via slash commands today.
		if (data === "e" && this.snapshot.focusedFactId) {
			this.notify?.("revise inline coming soon — use /sumo:memory forget <id> + /sumo:memory add <text>", "info");
			return;
		}

		// Search input: append printable chars, backspace removes last.
		if (data === "backspace" || matchesKey(data, "backspace")) {
			this.snapshot = { ...this.snapshot, searchQuery: this.snapshot.searchQuery.slice(0, -1) };
			return;
		}
		if (data.length === 1 && !/\p{Cc}/u.test(data)) {
			this.snapshot = { ...this.snapshot, searchQuery: `${this.snapshot.searchQuery}${data}` };
		}
	}

	private async forgetFocused(id: string): Promise<void> {
		// Optimistic remove: drop the fact from the snapshot before awaiting
		// Remnic. If the call fails, restore via notification (we don't
		// re-insert because the on-disk state may have already changed).
		const before = this.snapshot;
		const nextGroups: PanelGroup[] = before.groups.map((group) => ({
			panel: group.panel,
			facts: group.facts.filter((fact) => fact.id !== id),
		}));
		const nextOrder = visibleFactOrder(filterGroups(nextGroups, before.searchQuery));
		this.snapshot = {
			...before,
			groups: nextGroups,
			factsTotal: Math.max(0, before.factsTotal - 1),
			focusedFactId: nextOrder.length === 0 ? null : nextOrder[0]!.id,
		};
		if (!this.client) {
			this.notify?.("memory client unavailable — fact not actually forgotten", "warning");
			return;
		}
		try {
			await this.client.forget(id);
			this.notify?.("memory forgotten", "info");
		} catch (err) {
			this.notify?.(`forget failed: ${err instanceof Error ? err.message : String(err)}`, "warning");
		}
	}

	render(width: number): string[] {
		return renderMemoryEditor(this.snapshot, width);
	}
}

/**
 * Open the Memory Scriptorium overlay. Reads all active memories and
 * groups them by cathedral panel, then renders the modal until the user
 * dismisses with `Esc`.
 */
export async function showMemoryEditor(
	ctx: ExtensionCommandContext,
	client: RemnicMemoryClient = createRemnicMemoryClient(),
): Promise<void> {
	let facts: MemoryFact[] = [];
	let unavailable: string | null = null;
	try {
		facts = await client.browse({ status: "active", limit: 500 });
	} catch (err) {
		unavailable = err instanceof MemoryClientError ? err.message : String(err);
	}

	if (unavailable) {
		ctx.ui.notify(`memory unavailable: ${unavailable}`, "warning");
		return;
	}

	const groups = groupFactsByPanel(facts);
	const flat = visibleFactOrder(groups);
	const snapshot: MemoryEditorSnapshot = {
		searchQuery: "",
		groups,
		factsTotal: facts.length,
		focusedFactId: flat[0]?.id ?? null,
	};

	await ctx.ui.custom<void>(
		(_tui: TUI, _theme: unknown, _kb: KeybindingsManager, done: () => void) =>
			new MemoryEditorComponent(snapshot, done, {
				client,
				notify: (text, level = "info") => ctx.ui.notify(text, level),
			}),
		{
			overlay: true,
			overlayOptions: {
				anchor: "center",
				width: "80%",
				minWidth: 70,
				maxHeight: "75%",
			},
			onHandle: (_handle: OverlayHandle) => {
				/* opportunity to programmatically close in the future */
			},
		},
	);
}

/**
 * Register the `/sumo:memory` slash command. Subcommands: `edit` (default),
 * `add <text>`, `forget <id>`.
 */
export function registerMemoryCommand(pi: ExtensionAPI): void {
	pi.registerCommand("sumo:memory", {
		description: "open the memory scriptorium (or `add` / `forget` for direct ops)",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const arg = args.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
			if (arg === "" || arg === "edit") {
				await showMemoryEditor(ctx);
				return;
			}
			if (arg === "add") {
				const text = args.replace(/^\s*add\s+/, "").trim();
				if (!text) {
					ctx.ui.notify("usage: /sumo:memory add <text>", "info");
					return;
				}
				try {
					const client = createRemnicMemoryClient();
					await client.add(text);
					ctx.ui.notify(`memory added: ${text.slice(0, 40)}${text.length > 40 ? "…" : ""}`, "info");
				} catch (err) {
					ctx.ui.notify(
						`memory add failed: ${err instanceof Error ? err.message : String(err)}`,
						"warning",
					);
				}
				return;
			}
			if (arg === "forget") {
				const id = args.replace(/^\s*forget\s+/, "").trim();
				if (!id) {
					ctx.ui.notify("usage: /sumo:memory forget <fact-id>", "info");
					return;
				}
				try {
					const client = createRemnicMemoryClient();
					await client.forget(id);
					ctx.ui.notify(`memory forgotten: ${id}`, "info");
				} catch (err) {
					ctx.ui.notify(
						`memory forget failed: ${err instanceof Error ? err.message : String(err)}`,
						"warning",
					);
				}
				return;
			}
			ctx.ui.notify("usage: /sumo:memory [edit|add <text>|forget <id>]", "info");
		},
	});
}

export { MEMORY_PANELS, type PanelGroup, type PanelId };
