/**
 * Cathedral Memory Scriptorium (V2 Bible Element 7).
 *
 * Shares its painting vocabulary with the Divine Query and Approval modals
 * via `src/cathedral/scriptorium-chrome.ts`: floral title, lifted background
 * painted through every row, focused / unfocused marker glyphs, and a
 * centered footer hint. Pi's overlay host provides the surrounding box, so
 * we render flat lifted-bg rows rather than re-framing inside the overlay.
 *
 * Sources of truth:
 *   - `docs/ui/CATHEDRAL_UX_SPEC_V2.md` Element 7
 *   - `docs/ui/bible/07-memory-editor.html`, `07-memory-editor-search.html`
 *   - `docs/ui/bible/scene-memory-scriptorium-overlay.html`
 *
 * Triggered via `/sumo:memory` (or `/sumo:memory edit`).
 */

import type { Component, KeybindingsManager, OverlayHandle, OverlayOptions, TUI } from "@mariozechner/pi-tui";
import { matchesKey, wrapTextWithAnsi } from "@mariozechner/pi-tui";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
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
import { activeThemeColors } from "./themes/index.js";
import {
	center,
	fg,
	focusMarker,
	splitRule,
	titleRow,
	visibleLength,
	wrapPanelRow,
} from "./cathedral/scriptorium-chrome.js";

const SEARCH_PROMPT_GLYPH = "\u276F";
const PANEL_INDENT = "   ";
const PANEL_GAP = "   ";

export type MemoryEditorMode = "command" | "search";

export type MemoryEditorSnapshot = {
	searchQuery: string;
	groups: readonly PanelGroup[];
	factsTotal: number;
	focusedFactId: string | null;
	/**
	 * `"command"` (default) routes letter keys to hotkeys (`d` forget, `e`
	 * revise, `/` enters search). `"search"` routes letter keys into the
	 * search query so `pre`, `node`, `android`, etc. filter cleanly. Esc in
	 * `"search"` returns to `"command"` (preserving the query); Esc in
	 * `"command"` closes the overlay.
	 */
	mode?: MemoryEditorMode;
};

export const MEMORY_EDITOR_HINTS = "\u2191\u2193 wander    /  search    e  revise    d  forget    \u238B retreat";

export const MEMORY_EDITOR_OVERLAY_OPTIONS: OverlayOptions = {
	anchor: "center",
	width: "85%",
	minWidth: 80,
	maxHeight: "90%",
};

function filterGroups(groups: readonly PanelGroup[], query: string): PanelGroup[] {
	const trimmed = query.trim().toLowerCase();
	if (trimmed.length === 0) return groups.map((group) => ({ panel: group.panel, facts: [...group.facts] }));
	return groups.map((group) => ({
		panel: group.panel,
		facts: group.facts.filter((fact) => fact.text.toLowerCase().includes(trimmed)),
	}));
}

function flatVisibleFacts(filtered: readonly PanelGroup[]): MemoryFact[] {
	const out: MemoryFact[] = [];
	for (const group of filtered) for (const fact of group.facts) out.push(fact);
	return out;
}

function ensureFocusedFact(snapshot: MemoryEditorSnapshot): MemoryEditorSnapshot {
	if (snapshot.focusedFactId !== null) return snapshot;
	const visible = flatVisibleFacts(filterGroups(snapshot.groups, snapshot.searchQuery));
	if (visible.length === 0) return snapshot;
	return { ...snapshot, focusedFactId: visible[0]!.id };
}

/**
 * Build the rendered rows of one panel at a given inner width. Returned rows
 * are NOT padded to width \u2014 the caller composites two panels side-by-side
 * with a gap, then `wrapPanelRow` paints the surrounding lifted bg.
 */
function renderPanelRows(group: PanelGroup, width: number, focusedFactId: string | null): string[] {
	const colors = activeThemeColors();
	const inner = Math.max(20, width);
	const labelInner = ` ${group.panel} `;
	const dashes = Math.max(2, inner - labelInner.length - 3);
	const top = `\u256D\u2500${fg(labelInner, colors.accent)}${fg("\u2500".repeat(dashes), colors.divider)}\u256E`;
	const bottom = `\u2570${"\u2500".repeat(inner - 2)}\u256F`;

	const rows: string[] = [];
	rows.push(`${fg("\u256D\u2500", colors.divider)}${fg(labelInner, colors.accent)}${fg(`${"\u2500".repeat(dashes)}\u256E`, colors.divider)}`);

	if (group.facts.length === 0) {
		const left = fg("\u2502", colors.divider);
		const right = fg("\u2502", colors.divider);
		const body = ` ${fg("(empty)", colors.foregroundDim)} `;
		const padCount = Math.max(0, inner - 2 - visibleLength(body));
		rows.push(`${left}${body}${" ".repeat(padCount)}${right}`);
	} else {
		for (const fact of group.facts) {
			const focused = fact.id === focusedFactId;
			const marker = focusMarker(focused);
			const maxBody = inner - 6;
			const body = fact.text.length > maxBody ? `${fact.text.slice(0, maxBody - 1)}\u2026` : fact.text;
			const text = fg(body, colors.foreground);
			const left = fg("\u2502", colors.divider);
			const right = fg("\u2502", colors.divider);
			const content = ` ${marker} ${text}`;
			const padCount = Math.max(0, inner - 2 - visibleLength(content));
			rows.push(`${left}${content}${" ".repeat(padCount)}${right}`);
		}
	}

	rows.push(fg(bottom, colors.divider));
	void top;
	return rows;
}

function buildInnerRows(snapshot: MemoryEditorSnapshot, contentWidth: number): string[] {
	const filtered = filterGroups(snapshot.groups, snapshot.searchQuery);
	const colors = activeThemeColors();
	const inner: string[] = [];

	inner.push("");
	inner.push(titleRow("MEMORY SCRIPTORIUM", contentWidth));
	inner.push("");
	inner.push(splitRule(contentWidth));
	inner.push("");

	const chevron = fg(SEARCH_PROMPT_GLYPH, colors.accent);
	const searchDisplay = snapshot.searchQuery === ""
		? fg("search remembered facts\u2026", colors.foregroundDim)
		: fg(snapshot.searchQuery, colors.foreground);
	const factsLabel = fg(`${snapshot.factsTotal} facts`, colors.foregroundDim);
	const left = `${PANEL_INDENT}${chevron}  ${searchDisplay}`;
	const right = `${factsLabel}${PANEL_INDENT}`;
	const gap = Math.max(2, contentWidth - visibleLength(left) - visibleLength(right));
	inner.push(`${left}${" ".repeat(gap)}${right}`);
	inner.push("");

	const visibleGroups = filtered.filter((group) => group.panel !== "GENERAL" || group.facts.length > 0);
	const indentWidth = visibleLength(PANEL_INDENT) * 2 + visibleLength(PANEL_GAP);
	const panelInner = Math.max(20, Math.floor((contentWidth - indentWidth) / 2));
	for (let i = 0; i < visibleGroups.length; i += 2) {
		const leftPanel = renderPanelRows(visibleGroups[i]!, panelInner, snapshot.focusedFactId);
		const rightPanel = i + 1 < visibleGroups.length
			? renderPanelRows(visibleGroups[i + 1]!, panelInner, snapshot.focusedFactId)
			: null;
		const rowCount = rightPanel ? Math.max(leftPanel.length, rightPanel.length) : leftPanel.length;
		for (let r = 0; r < rowCount; r++) {
			const leftRow = leftPanel[r] ?? "";
			const leftPad = Math.max(0, panelInner - visibleLength(leftRow));
			const rightRow = rightPanel ? (rightPanel[r] ?? "") : "";
			const rightPad = rightPanel ? Math.max(0, panelInner - visibleLength(rightRow)) : 0;
			const composed = rightPanel
				? `${PANEL_INDENT}${leftRow}${" ".repeat(leftPad)}${PANEL_GAP}${rightRow}${" ".repeat(rightPad)}`
				: `${PANEL_INDENT}${leftRow}${" ".repeat(leftPad)}`;
			inner.push(composed);
		}
		inner.push("");
	}

	inner.push(splitRule(contentWidth));
	inner.push(center(fg(MEMORY_EDITOR_HINTS, colors.foregroundDim), contentWidth));
	inner.push("");
	return inner;
}

export function renderMemoryEditor(snapshot: MemoryEditorSnapshot, width: number): string[] {
	if (width < 1) return [];
	const wrapped = wrapTextWithAnsi("", width); // touch import to silence treeshake hot reload
	void wrapped;
	const rows = buildInnerRows(snapshot, width);
	return rows.map((row) => wrapPanelRow(row, width));
}

export interface MemoryEditorComponentDeps {
	readonly client: RemnicMemoryClient;
	readonly notify: (message: string, level?: "info" | "warning") => void;
	readonly invalidate: () => void;
	readonly close: () => void;
}

function nextFocusAfterRemoval(
	previousVisible: readonly MemoryFact[],
	currentVisible: readonly MemoryFact[],
	previousFocusId: string | null,
): string | null {
	if (currentVisible.length === 0) return null;
	if (previousFocusId === null) return currentVisible[0]?.id ?? null;
	const prevIndex = previousVisible.findIndex((fact) => fact.id === previousFocusId);
	if (prevIndex === -1) return currentVisible[0]?.id ?? null;
	const stillVisible = currentVisible.find((fact) => fact.id === previousFocusId);
	if (stillVisible) return stillVisible.id;
	const fallbackIndex = Math.min(prevIndex, currentVisible.length - 1);
	return currentVisible[fallbackIndex]?.id ?? currentVisible[0]?.id ?? null;
}

export class MemoryEditorComponent implements Component {
	private snapshot: MemoryEditorSnapshot;
	private readonly deps: MemoryEditorComponentDeps;
	private busy = false;

	public constructor(initial: MemoryEditorSnapshot, deps: MemoryEditorComponentDeps) {
		this.snapshot = ensureFocusedFact(initial);
		this.deps = deps;
	}

	public invalidate(): void {
		this.deps.invalidate();
	}

	public render(width: number): string[] {
		return renderMemoryEditor(this.snapshot, width);
	}

	public handleInput(data: string): void {
		const mode = this.snapshot.mode ?? "command";
		if (mode === "search") {
			if (matchesKey(data, "escape") || data === "escape" || data === "\u001b") {
				this.snapshot = { ...this.snapshot, mode: "command" };
				this.deps.invalidate();
				return;
			}
			if (matchesKey(data, "backspace") || data === "backspace") {
				this.updateSearch(this.snapshot.searchQuery.slice(0, -1));
				return;
			}
			if (matchesKey(data, "enter") || data === "enter" || data === "\r" || data === "\n") {
				this.snapshot = { ...this.snapshot, mode: "command" };
				this.deps.invalidate();
				return;
			}
			if (data.length === 1 && !/\p{Cc}/u.test(data)) {
				this.updateSearch(`${this.snapshot.searchQuery}${data}`);
			}
			return;
		}

		// command mode
		if (matchesKey(data, "escape") || data === "escape" || data === "\u001b") {
			this.deps.close();
			return;
		}
		if (data === "/") {
			this.snapshot = { ...this.snapshot, mode: "search" };
			this.deps.invalidate();
			return;
		}
		if (matchesKey(data, "up") || data === "up") {
			this.moveFocus(-1);
			return;
		}
		if (matchesKey(data, "down") || data === "down") {
			this.moveFocus(1);
			return;
		}
		if (data === "d" && !this.busy) {
			void this.handleForget();
			return;
		}
		if (data === "e") {
			this.deps.notify("revise inline coming soon \u2014 use /sumo:memory forget <id> + /sumo:memory add <text>", "info");
			return;
		}
	}

	private updateSearch(query: string): void {
		const previousVisible = flatVisibleFacts(filterGroups(this.snapshot.groups, this.snapshot.searchQuery));
		const nextVisible = flatVisibleFacts(filterGroups(this.snapshot.groups, query));
		const focusedFactId = nextFocusAfterRemoval(previousVisible, nextVisible, this.snapshot.focusedFactId);
		this.snapshot = { ...this.snapshot, searchQuery: query, focusedFactId };
		this.deps.invalidate();
	}

	private moveFocus(delta: number): void {
		const visible = flatVisibleFacts(filterGroups(this.snapshot.groups, this.snapshot.searchQuery));
		if (visible.length === 0) {
			this.snapshot = { ...this.snapshot, focusedFactId: null };
			this.deps.invalidate();
			return;
		}
		const currentIndex = this.snapshot.focusedFactId === null
			? -1
			: visible.findIndex((fact) => fact.id === this.snapshot.focusedFactId);
		const nextIndex = currentIndex === -1
			? (delta > 0 ? 0 : visible.length - 1)
			: (currentIndex + delta + visible.length) % visible.length;
		this.snapshot = { ...this.snapshot, focusedFactId: visible[nextIndex]!.id };
		this.deps.invalidate();
	}

	private async handleForget(): Promise<void> {
		const focusId = this.snapshot.focusedFactId;
		if (!focusId) {
			this.deps.notify("nothing focused to forget", "info");
			return;
		}
		this.busy = true;
		const previousGroups = this.snapshot.groups;
		const previousSearch = this.snapshot.searchQuery;
		const previousFactsTotal = this.snapshot.factsTotal;
		const optimisticGroups = previousGroups.map((group) => ({
			panel: group.panel,
			facts: group.facts.filter((fact) => fact.id !== focusId),
		}));
		const previousVisible = flatVisibleFacts(filterGroups(previousGroups, previousSearch));
		const nextVisible = flatVisibleFacts(filterGroups(optimisticGroups, previousSearch));
		this.snapshot = {
			...this.snapshot,
			groups: optimisticGroups,
			factsTotal: optimisticGroups.reduce((total, group) => total + group.facts.length, 0),
			focusedFactId: nextFocusAfterRemoval(previousVisible, nextVisible, focusId),
		};
		this.deps.invalidate();
		try {
			await this.deps.client.forget(focusId);
			this.deps.notify("forgotten", "info");
		} catch (error) {
			this.snapshot = { ...this.snapshot, groups: previousGroups, factsTotal: previousFactsTotal, focusedFactId: focusId };
			this.deps.invalidate();
			this.deps.notify(`forget failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
		} finally {
			this.busy = false;
		}
	}
}

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
	const initial: MemoryEditorSnapshot = {
		searchQuery: "",
		groups,
		factsTotal: facts.length,
		focusedFactId: null,
	};

	await ctx.ui.custom<void>(
		(tui: TUI, _theme: unknown, _kb: KeybindingsManager, done: () => void) => new MemoryEditorComponent(initial, {
			client,
			notify: (message, level) => ctx.ui.notify(message, level ?? "info"),
			invalidate: () => tui.requestRender(),
			close: () => done(),
		}),
		{
			overlay: true,
			overlayOptions: MEMORY_EDITOR_OVERLAY_OPTIONS,
			onHandle: (_handle: OverlayHandle) => {
				/* no-op for now; future: programmatic close hook */
			},
		},
	);
}

export function registerMemoryCommand(pi: ExtensionAPI): void {
	pi.registerCommand("sumo:memory", {
		description: "open the cathedral memory scriptorium (or `add` / `forget` for direct ops)",
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
					ctx.ui.notify(`memory added: ${text.slice(0, 40)}${text.length > 40 ? "\u2026" : ""}`, "info");
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
