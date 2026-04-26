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
 *   - Saint-Exupéry quote in dim muted brown
 *
 * The Pi-glue lives in `installTabBar` because Pi exposes only ONE setHeader
 * slot. The splash and the tab bar are stacked into a single header render.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CATHEDRAL_TOKENS } from "./tokens.js";

const RESET = "\u001b[0m";
const ANSI_PATTERN = /\u001b\[[0-9;]*m/g;

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
	if (len >= width) return line;
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
		const raw = readFileSync(FACE_PATH, "utf8").replace(/\r?\n$/, "");
		return raw.split("\n");
	} catch {
		return [];
	}
}

const SUMO_FACE = loadFace();

export const SUMOCODE_QUOTE = '"perfection is achieved when there is nothing left to take away."';
export const SUMOCODE_QUOTE_ATTRIBUTION = "— saint-exupéry";

export type SplashSnapshot = {
	quote: string;
	quoteAttribution: string;
	hasMessages: boolean;
};

/**
 * Vertical layout reserved for the rest of Pi's chrome below the splash.
 * Used to compute how much top padding to add for vertical centering.
 *
 *   1 row : top chrome bar (Element 2)
 *   1 row : input frame (Pi's editor)
 *   1 row : input hints (Element 4)
 *   1 row : footer (Element 5)
 *   2 rows: anthropic warning (Pi-hardcoded)
 *   1 row : breathing room
 *   3 rows: anthropic auth banner / package updates (Pi-hardcoded, varies)
 */
const CHROME_RESERVED_ROWS = 9;

/**
 * Pure render of the cathedral splash. Returns an empty array if the session
 * already has messages — caller can splice this into a header without
 * conditional logic.
 *
 * `terminalHeight` is optional. When provided, the splash output is padded
 * with blank rows at the top so the cat + wordmark + quote sit vertically
 * centered in the viewport, with chrome reserved at top and bottom. Without
 * it, the splash starts immediately below whatever rendered above (the
 * pre-altscreen behaviour).
 */
export function renderSplash(snapshot: SplashSnapshot, width: number, terminalHeight?: number): string[] {
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

	// Saint-Exupéry quote in dim muted brown.
	content.push(center(`${DIM}${MUTED}${snapshot.quote}${RESET}`, width));
	content.push(center(`${DIM}${MUTED}${snapshot.quoteAttribution}${RESET}`, width));

	// Vertical centering: pad with blank rows above the content so the splash
	// sits in the middle of the available viewport. Reserve CHROME_RESERVED_ROWS
	// for the bottom chrome (input + hints + footer + anthropic warning).
	if (terminalHeight && terminalHeight > content.length + CHROME_RESERVED_ROWS) {
		const availableForCentering = terminalHeight - CHROME_RESERVED_ROWS;
		const topPad = Math.max(2, Math.floor((availableForCentering - content.length) / 2));
		const out: string[] = [];
		for (let i = 0; i < topPad; i++) out.push("");
		out.push(...content);
		return out;
	}

	// Fallback: small fixed top padding (legacy behaviour).
	const out: string[] = [];
	for (let i = 0; i < 4; i++) out.push("");
	out.push(...content);
	return out;
}
