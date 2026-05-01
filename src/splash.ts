/**
 * Cathedral splash screen — full-viewport empty-state for SumoCode.
 *
 * Rendered above the chat area when `sessionManager.getBranch()` returns no
 * messages. As soon as the first user prompt arrives, the splash collapses
 * and only the cathedral tab bar remains.
 *
 * Composition (top to bottom):
 *   - blank rows for vertical centering
 *   - Sumo BSH cat face (chafa-converted from a Gemini-generated PNG)
 *   - SUMOCODE block-letter wordmark in burnt orange
 *   - Visual Bible quote in dim muted brown
 *
 * The Pi-glue lives in `installTabBar` because Pi exposes only ONE setHeader
 * slot. The splash and the tab bar are stacked into a single header render.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { truncateToWidth } from "@mariozechner/pi-tui";
import type { Component } from "@mariozechner/pi-tui";
import { sessionHasMessages as cachedSessionHasMessages } from "./session-cache.js";
import { CATHEDRAL_TOKENS } from "./tokens.js";

const RESET = "\u001b[0m";
const ANSI_PATTERN = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))/g;
const CURSOR_VISIBILITY_PATTERN = /\u001b\[\?25[lh]/g;

function fg(hex: string): string {
	const n = hex.replace("#", "");
	const r = Number.parseInt(n.slice(0, 2), 16);
	const g = Number.parseInt(n.slice(2, 4), 16);
	const b = Number.parseInt(n.slice(4, 6), 16);
	return `\u001b[38;2;${r};${g};${b}m`;
}

const ACCENT = fg(CATHEDRAL_TOKENS.colors.accent);
const MUTED = fg(CATHEDRAL_TOKENS.colors.foregroundDim);
const DIM = "\u001b[2m";

function visibleLength(text: string): number {
	return text.replace(ANSI_PATTERN, "").length;
}

function center(line: string, width: number): string {
	const len = visibleLength(line);
	if (len >= width) return truncateToWidth(line, width, "");
	const pad = Math.floor((width - len) / 2);
	return `${" ".repeat(pad)}${line}`;
}

/**
 * SUMOCODE wordmark, hand-built block letters. Each glyph is 6 cells wide
 * and 5 rows tall. Stored uncolored; the renderer applies the cathedral
 * accent at output time.
 */
export const SUMOCODE_WORDMARK: readonly string[] = (() => {
	const glyphs: Record<string, readonly string[]> = {
		S: ["█████ ", "█     ", "█████ ", "    █ ", "█████ "],
		U: ["█   █ ", "█   █ ", "█   █ ", "█   █ ", "█████ "],
		M: ["█   █ ", "██ ██ ", "█ █ █ ", "█   █ ", "█   █ "],
		O: ["█████ ", "█   █ ", "█   █ ", "█   █ ", "█████ "],
		C: ["█████ ", "█     ", "█     ", "█     ", "█████ "],
		D: ["████  ", "█   █ ", "█   █ ", "█   █ ", "████  "],
		E: ["█████ ", "█     ", "████  ", "█     ", "█████ "],
	};
	const letters = "SUMOCODE".split("");
	const rows = Array.from({ length: 5 }, (_, i) =>
		letters.map((ch) => glyphs[ch]![i] ?? "      ").join(""),
	);
	return rows;
})();

const ASSET_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "assets");
const FACE_PATH = resolve(ASSET_DIR, "sumo-face.ans");

/**
 * Sumo BSH cat face (24×14 cells). Generated via:
 *
 *   bun ~/sumocode-config/pi-agent/skills/art/tools/generate-image.ts \
 *     --prompt "<Bastet BSH face spec>" --size 1K --aspect-ratio 1:1
 *   chafa --format=symbols --symbols=block --fg-only --colors=full \
 *         --size=24x14 sumo-face.png > src/assets/sumo-face.ans
 */
function loadFace(): readonly string[] {
	try {
		const raw = readFileSync(FACE_PATH, "utf8").replace(CURSOR_VISIBILITY_PATTERN, "");
		return raw.replace(/\r?\n$/, "").split(/\r?\n/).filter((line) => line.length > 0);
	} catch {
		return [];
	}
}

const SUMO_FACE = loadFace();

// Quote text + attribution locked by the V2 Visual Bible Element 3 splash.
export const SUMOCODE_QUOTE = '"Meow meow meow... meow meow"';
export const SUMOCODE_QUOTE_ATTRIBUTION = "— SUMO";

export type SplashSnapshot = {
	quote: string;
	quoteAttribution: string;
	hasMessages: boolean;
};

/**
 * Standalone splash content: cat + wordmark + quote only.
 *
 * The retained sumo-tui splash tree centers this fixed-height leaf with Yoga
 * flex spacers. Keep this function free of viewport padding and chrome
 * reservation hacks so centering remains a layout concern.
 */
export function renderSplashContent(snapshot: SplashSnapshot, width: number): string[] {
	if (snapshot.hasMessages) return [];

	const content: string[] = [];

	// Cat face — already 24-bit-color ANSI, no extra coloring required.
	for (const row of SUMO_FACE) content.push(center(row, width));

	if (SUMO_FACE.length > 0) {
		content.push("");
		content.push("");
	}

	// SUMOCODE wordmark in burnt orange.
	for (const row of SUMOCODE_WORDMARK) {
		content.push(center(`${ACCENT}${row}${RESET}`, width));
	}

	content.push("");
	content.push("");

	// V2 Visual Bible quote in dim muted brown.
	content.push(center(`${DIM}${MUTED}${snapshot.quote}${RESET}`, width));
	content.push(center(`${DIM}${MUTED}${snapshot.quoteAttribution}${RESET}`, width));

	return content;
}

/**
 * Legacy line renderer retained for preview scripts and non-retained fallback.
 * When `terminalHeight` is provided it centers against the whole viewport — no
 * `CHROME_RESERVED_ROWS` subtraction. The retained runtime should prefer
 * `renderSplashContent()` inside `splash-tree.ts`.
 */
export function renderSplash(snapshot: SplashSnapshot, width: number, terminalHeight?: number): string[] {
	const content = renderSplashContent(snapshot, width);
	if (content.length === 0) return [];

	if (terminalHeight && terminalHeight > content.length) {
		const topPad = Math.max(0, Math.floor((terminalHeight - content.length) / 2));
		return [...Array.from({ length: topPad }, () => ""), ...content];
	}

	return content;
}

function sessionHasMessages(ctx: ExtensionContext): boolean {
	try {
		return cachedSessionHasMessages(ctx);
	} catch {
		return false;
	}
}

export function shouldUseRetainedSplash(env: NodeJS.ProcessEnv = process.env): boolean {
	return env.SUMO_TUI === "1";
}

class SplashComponent implements Component {
	public constructor(private readonly ctx: ExtensionContext) {}
	public invalidate(): void {}
	public render(width: number): string[] {
		return renderSplash(
			{
				quote: SUMOCODE_QUOTE,
				quoteAttribution: SUMOCODE_QUOTE_ATTRIBUTION,
				hasMessages: sessionHasMessages(this.ctx),
			},
			width,
			process.stdout.rows,
		);
	}
}

/** Mounts the splash as its own chrome region instead of piggybacking on the top bar. */
export function installSplash(pi: ExtensionAPI): void {
	let render: (() => void) | undefined;

	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI || shouldUseRetainedSplash()) return;
		ctx.ui.setWidget("sumocode-splash", (tui) => {
			render = () => tui.requestRender();
			return new SplashComponent(ctx);
		});
	});

	pi.on("message_start", () => render?.());
	pi.on("message_end", () => render?.());
}
