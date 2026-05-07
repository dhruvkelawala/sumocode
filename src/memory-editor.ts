/**
 * Cathedral Memory Scriptorium (V2 Bible Element 7).
 *
 * Read-mostly modal that browses the user's Remnic memory and groups facts
 * into 6 panels (IDENTITY / PREFERENCES / WORKFLOW / PROJECTS / SYSTEM /
 * GENERAL hidden if empty). Provides:
 *
 *   - search filter (instant, no LLM)
 *   - up/down focus across visible facts
 *   - `d` to forget the focused fact (optimistic + Remnic round-trip)
 *   - `⎋` to dismiss
 *   - `e` to revise inline (deferred — currently emits a notify hint)
 *
 * Design source of truth: `docs/ui/CATHEDRAL_UX_SPEC_V2.md` Element 7,
 * `docs/ui/bible/07-memory-editor.html`,
 * `docs/ui/bible/07-memory-editor-search.html`,
 * `docs/ui/bible/scene-memory-scriptorium-overlay.html`.
 *
 * Theming reads from `activeThemeColors()` so Cathedral and Obsidian render
 * the same chrome with their own palette. No hardcoded hex values.
 *
 * Triggered via `/sumo:memory` (or `/sumo:memory edit`).
 */

import type { Component, KeybindingsManager, OverlayHandle, TUI } from "@mariozechner/pi-tui";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { matchesKey } from "@mariozechner/pi-tui";
import { colorHex } from "./footer.js";
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

const RESET = "\u001b[0m";
const ANSI_PATTERN = /\u001b\[[0-9;]*m/g;
const DIM = "\u001b[2m";
const SEARCH_PROMPT_GLYPH = "❯";
const FOCUSED_FACT_GLYPH = "❈";
const UNFOCUSED_FACT_GLYPH = "·";
const TITLE_FLOWER = "✾";

function visibleLength(text: string): number {
	return text.replace(ANSI_PATTERN, "").length;
}

function center(line: string, width: number): string {
	const len = visibleLength(line);
	if (len >= width) return line;
	const pad = Math.floor((width - len) / 2);
	return `${" ".repeat(pad)}${line}`;
}

function padToWidth(line: string, width: number): string {
	const len = visibleLength(line);
	if (len >= width) return line;
	return `${line}${" ".repeat(width - len)}`;
}

/**
 * Bible-style split rule: two short box-drawing runs separated by a centered `·`.
 * Keeps the modal feeling like a hand-illuminated page rather than a CLI.
 */
function splitRule(width: number): string {
	const segment = Math.max(4, Math.floor((width - 8) / 2));
	const left = "─".repeat(segment);
	const right = "─".repeat(segment);
	const div = activeThemeColors().divider;
	const piece = `${colorHex(left, div)}  ${colorHex("·", div)}  ${colorHex(right, div)}`;
	return center(piece, width);
}

export type MemoryEditorSnapshot = {
	searchQuery: string;
	groups: readonly PanelGroup[];
	factsTotal: number;
	focusedFactId: string | null;
};

export const MEMORY_EDITOR_HINTS = "↑↓ wander    /  search    e  revise    d  forget    ⎋ retreat";

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

function renderPanel(group: PanelGroup, width: number, focusedFactId: string | null): string[] {
	const innerWidth = Math.max(20, width - 4);
	const labelInner = ` ${group.panel} `;
	const dashes = Math.max(2, innerWidth - labelInner.length - 1);
	const top = `╭─${labelInner}${"─".repeat(dashes)}╮`;
	const bottom = `╰${"─".repeat(innerWidth - 2)}╯`;

	const div = activeThemeColors().divider;
	const accent = activeThemeColors().accent;
	const fg = activeThemeColors().foreground;
	const dim = activeThemeColors().foregroundDim;

	const lines: string[] = [];
	lines.push(colorHex(top, div).replace(labelInner, colorHex(labelInner, accent)));

	if (group.facts.length === 0) {
		const empty = ` ${colorHex("(empty)", dim)} `;
		lines.push(`${colorHex("│", div)}${padToWidth(empty, innerWidth - 2)}${colorHex("│", div)}`);
	} else {
		for (const fact of group.facts) {
			const focused = fact.id === focusedFactId;
			const marker = focused
				? colorHex(FOCUSED_FACT_GLYPH, accent)
				: colorHex(UNFOCUSED_FACT_GLYPH, div);
			const maxBody = innerWidth - 6;
			const body = fact.text.length > maxBody ? `${fact.text.slice(0, maxBody - 1)}…` : fact.text;
			const text = colorHex(body, fg);
			const content = ` ${marker} ${text}`;
			lines.push(`${colorHex("│", div)}${padToWidth(content, innerWidth - 2)}${colorHex("│", div)}`);
		}
	}

	lines.push(colorHex(bottom, div));
	return lines;
}

export function renderMemoryEditor(snapshot: MemoryEditorSnapshot, width: number): string[] {
	const filtered = filterGroups(snapshot.groups, snapshot.searchQuery);
	const lines: string[] = [];
	const accent = activeThemeColors().accent;
	const fg = activeThemeColors().foreground;
	const dim = activeThemeColors().foregroundDim;

	lines.push("");
	const flower = colorHex(TITLE_FLOWER, accent);
	const titleText = colorHex("MEMORY SCRIPTORIUM", accent);
	lines.push(center(`${flower}  ${titleText}  ${flower}`, width));
	lines.push("");
	lines.push(splitRule(width));
	lines.push("");

	const chevron = colorHex(SEARCH_PROMPT_GLYPH, accent);
	const queryDisplay = snapshot.searchQuery === ""
		? `${DIM}${colorHex("search remembered facts…", dim)}${RESET}`
		: colorHex(snapshot.searchQuery, fg);
	const factsCount = colorHex(`${snapshot.factsTotal} facts`, dim);
	const left = `   ${chevron}  ${queryDisplay}`;
	const right = `${factsCount}   `;
	const gap = Math.max(2, width - visibleLength(left) - visibleLength(right));
	lines.push(`${left}${" ".repeat(gap)}${right}`);
	lines.push("");

	const visibleGroups = filtered.filter((group) => group.panel !== "GENERAL" || group.facts.length > 0);
	const panelInternalWidth = Math.floor((width - 6) / 2);
	for (let i = 0; i < visibleGroups.length; i += 2) {
		const leftPanel = renderPanel(visibleGroups[i]!, panelInternalWidth, snapshot.focusedFactId);
		const rightPanel = i + 1 < visibleGroups.length
			? renderPanel(visibleGroups[i + 1]!, panelInternalWidth, snapshot.focusedFactId)
			: null;
		const rowCount = rightPanel ? Math.max(leftPanel.length, rightPanel.length) : leftPanel.length;
		for (let r = 0; r < rowCount; r++) {
			const leftLine = padToWidth(leftPanel[r] ?? "", panelInternalWidth);
			const rightLine = rightPanel ? padToWidth(rightPanel[r] ?? "", panelInternalWidth) : "";
			lines.push(`  ${leftLine}  ${rightLine}`);
		}
		lines.push("");
	}

	lines.push(splitRule(width));
	lines.push(`   ${DIM}${colorHex(MEMORY_EDITOR_HINTS, dim)}${RESET}`);

	return lines;
}

export interface MemoryEditorComponentDeps {
	readonly client: RemnicMemoryClient;
	readonly notify: (message: string, level?: "info" | "warning") => void;
	readonly invalidate: () => void;
	readonly close: () => void;
}

/**
 * Choose the next focused fact id when the focused one disappears (forget,
 * filter change). Falls back to the closest still-visible fact, then to the
 * first visible fact, then to null.
 */
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
		if (matchesKey(data, "escape") || data === "escape" || data === "\u001b") {
			this.deps.close();
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
			this.deps.notify("revise inline coming soon — use /sumo:memory forget <id> + /sumo:memory add <text>", "info");
			return;
		}
		if (matchesKey(data, "backspace") || data === "backspace") {
			this.updateSearch(this.snapshot.searchQuery.slice(0, -1));
			return;
		}
		if (data.length === 1 && !/\p{Cc}/u.test(data)) {
			this.updateSearch(`${this.snapshot.searchQuery}${data}`);
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
		let nextIndex: number;
		if (currentIndex === -1) {
			nextIndex = delta > 0 ? 0 : visible.length - 1;
		} else {
			nextIndex = (currentIndex + delta + visible.length) % visible.length;
		}
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

function ensureFocusedFact(snapshot: MemoryEditorSnapshot): MemoryEditorSnapshot {
	if (snapshot.focusedFactId !== null) return snapshot;
	const visible = flatVisibleFacts(filterGroups(snapshot.groups, snapshot.searchQuery));
	if (visible.length === 0) return snapshot;
	return { ...snapshot, focusedFactId: visible[0]!.id };
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
			overlayOptions: { anchor: "center", width: "80%", minWidth: 70, maxHeight: "80%" },
			onHandle: (_handle: OverlayHandle) => {
				/* no-op for now; future: programmatic close hook */
			},
		},
	);
}

export function registerMemoryCommand(pi: ExtensionAPI): void {
	pi.registerCommand("sumo:memory", {
		description: "open the cathedral memory editor (or `add` / `forget` for direct ops)",
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
