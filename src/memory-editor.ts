/**
 * Cathedral memory editor (Element 7 from CATHEDRAL_DECISIONS.md).
 *
 * Read-only modal that browses the user's Remnic memory and groups facts
 * into 6 cathedral panels (IDENTITY / PREFERENCES / WORKFLOW / PROJECTS /
 * SYSTEM / GENERAL hidden if empty).
 *
 * Triggered via `/sumo:memory edit`.
 *
 * Uses the same flat-hybrid modal style as the approval modal and command
 * palette (Elements 6, 8): title + dividers above/below + footer hints,
 * no double-line border.
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

function divider(width: number): string {
	return colorHex("─".repeat(Math.max(0, width - 6)), activeThemeColors().divider);
}

export type MemoryEditorSnapshot = {
	searchQuery: string;
	groups: readonly PanelGroup[];
	factsTotal: number;
};

export const MEMORY_EDITOR_HINTS = "↑↓ navigate    /  search    ⏎  copy id    esc  close";

/**
 * Render a single panel sub-card with `╭─ NAME ─...╮` border.
 */
function renderPanel(group: PanelGroup, width: number): string[] {
	const innerWidth = Math.max(20, width - 4); // 2 chars border each side
	const labelInner = ` ${group.panel} `;
	const dashes = Math.max(2, innerWidth - labelInner.length - 1);
	const top = `╭─${labelInner}${"─".repeat(dashes)}╮`;
	const bottom = `╰${"─".repeat(innerWidth - 2)}╯`;

	const lines: string[] = [];
	lines.push(colorHex(top, activeThemeColors().divider).replace(
		labelInner,
		colorHex(labelInner, activeThemeColors().accent),
	));

	if (group.facts.length === 0) {
		const empty = ` ${colorHex("(empty)", activeThemeColors().foregroundDim)} `;
		lines.push(`${colorHex("│", activeThemeColors().divider)}${padToWidth(empty, innerWidth - 2)}${colorHex("│", activeThemeColors().divider)}`);
	} else {
		for (const fact of group.facts) {
			const bullet = colorHex("❧", activeThemeColors().accent);
			const text = colorHex(
				fact.text.length > innerWidth - 6 ? `${fact.text.slice(0, innerWidth - 7)}…` : fact.text,
				activeThemeColors().foreground,
			);
			const content = ` ${bullet} ${text}`;
			lines.push(`${colorHex("│", activeThemeColors().divider)}${padToWidth(content, innerWidth - 2)}${colorHex("│", activeThemeColors().divider)}`);
		}
	}

	lines.push(colorHex(bottom, activeThemeColors().divider));
	return lines;
}

/**
 * Pure render of the modal. Returns content lines (the overlay frame /
 * compositing is handled by Pi).
 */
export function renderMemoryEditor(snapshot: MemoryEditorSnapshot, width: number): string[] {
	const lines: string[] = [];

	// Title
	lines.push("");
	lines.push(center(colorHex("SUMOCODE MEMORY", activeThemeColors().accent), width));
	lines.push(divider(width));
	lines.push("");

	// Search input row
	const searchPrompt = colorHex("│ ", activeThemeColors().divider);
	const searchPlaceholder = snapshot.searchQuery === ""
		? `${DIM}${colorHex("search…", activeThemeColors().foregroundDim)}${RESET}`
		: colorHex(snapshot.searchQuery, activeThemeColors().foreground);
	const factsCount = colorHex(`${snapshot.factsTotal} facts`, activeThemeColors().foregroundDim);
	const searchClose = colorHex(" │", activeThemeColors().divider);

	const searchLineLeft = `   ${searchPrompt}${searchPlaceholder}`;
	const searchLineRight = `${factsCount}${searchClose}`;
	const gap = Math.max(2, width - visibleLength(searchLineLeft) - visibleLength(searchLineRight));
	lines.push(`${searchLineLeft}${" ".repeat(gap)}${searchLineRight}`);
	lines.push("");

	// 2-up panel grid
	const groups = snapshot.groups;
	const panelInternalWidth = Math.floor((width - 6) / 2); // 2 panels with gaps
	for (let i = 0; i < groups.length; i += 2) {
		const left = renderPanel(groups[i]!, panelInternalWidth);
		const right = i + 1 < groups.length ? renderPanel(groups[i + 1]!, panelInternalWidth) : null;
		const rowCount = right ? Math.max(left.length, right.length) : left.length;
		for (let r = 0; r < rowCount; r++) {
			const leftLine = padToWidth(left[r] ?? "", panelInternalWidth);
			const rightLine = right ? padToWidth(right[r] ?? "", panelInternalWidth) : "";
			lines.push(`  ${leftLine}  ${rightLine}`);
		}
		lines.push("");
	}

	lines.push(divider(width));
	lines.push(`   ${DIM}${colorHex(MEMORY_EDITOR_HINTS, activeThemeColors().foregroundDim)}${RESET}`);

	return lines;
}

// ============================================================================
// Pi-glue
// ============================================================================

class MemoryEditorComponent implements Component {
	constructor(
		private snapshot: MemoryEditorSnapshot,
		private readonly done: () => void,
	) {}

	invalidate(): void {}

	handleInput(data: string): void {
		if (data === "escape" || matchesKey(data, "escape")) {
			this.done();
			return;
		}
		// Search input: append printable chars to query, backspace removes last char.
		if (data === "backspace" || matchesKey(data, "backspace")) {
			this.snapshot = {
				...this.snapshot,
				searchQuery: this.snapshot.searchQuery.slice(0, -1),
			};
			return;
		}
		if (data.length === 1 && !/\p{Cc}/u.test(data)) {
			this.snapshot = {
				...this.snapshot,
				searchQuery: `${this.snapshot.searchQuery}${data}`,
			};
		}
	}

	render(width: number): string[] {
		return renderMemoryEditor(this.snapshot, width);
	}
}

/**
 * Open the memory editor modal. Reads all active memories and groups them
 * by cathedral panel, then renders the modal until the user dismisses.
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
	const snapshot: MemoryEditorSnapshot = {
		searchQuery: "",
		groups,
		factsTotal: facts.length,
	};

	await ctx.ui.custom<void>(
		(_tui: TUI, _theme: unknown, _kb: KeybindingsManager, done: () => void) =>
			new MemoryEditorComponent(snapshot, done),
		{
			overlay: true,
			overlayOptions: {
				anchor: "center",
				width: "80%",
				minWidth: 70,
				maxHeight: "80%",
			},
			onHandle: (_handle: OverlayHandle) => {
				/* opportunity to programmatically close in the future */
			},
		},
	);
}

/**
 * Register the `/sumo:memory edit` slash command. Future subcommands
 * (`add`, `forget`) can be added here too.
 */
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
