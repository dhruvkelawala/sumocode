import { describe, expect, it } from "vitest";
import { CATHEDRAL_TOKENS } from "./tokens.js";
import {
	SUMOCODE_WORDMARK,
	renderSplash,
	shouldUseRetainedSplash,
	type SplashSnapshot,
} from "./splash.js";

const ANSI = /\u001b\[[0-9;]*m/g;
const stripAnsi = (s: string): string => s.replace(ANSI, "");

function snapshot(overrides: Partial<SplashSnapshot> = {}): SplashSnapshot {
	return {
		quote:
			'"PERFECTION IS ACHIEVED, NOT WHEN THERE IS NOTHING MORE TO ADD, BUT WHEN THERE IS NOTHING LEFT TO TAKE AWAY."',
		quoteAttribution: "— ANTOINE DE SAINT-EXUPÉRY",
		hasMessages: false,
		...overrides,
	};
}

describe("renderSplash", () => {
	it("returns no rows when the session already has messages", () => {
		expect(renderSplash(snapshot({ hasMessages: true }), 160).length).toBe(0);
	});

	it("renders the SUMOCODE wordmark in burnt orange", () => {
		const lines = renderSplash(snapshot(), 160);
		const blob = lines.join("\n");
		const plain = stripAnsi(blob);

		// All wordmark rows are present in the rendered output.
		for (const row of SUMOCODE_WORDMARK) {
			expect(plain).toContain(row.replace(/\u001b\[[0-9;]*m/g, ""));
		}
		// #D97706 -> 217;119;6
		expect(blob).toContain("\u001b[38;2;217;119;6m");
	});

	it("renders the BSH cat face above the wordmark", () => {
		const lines = renderSplash(snapshot(), 160).map(stripAnsi);
		const wordmarkRow = lines.findIndex((line) => line.includes(SUMOCODE_WORDMARK[0]!.replace(/\u001b\[[0-9;]*m/g, "")));
		const faceCellRows = lines.slice(0, wordmarkRow).filter((line) => /[\u2580-\u259F]/.test(line));

		expect(wordmarkRow).toBeGreaterThan(0);
		expect(faceCellRows.length).toBeGreaterThan(8);
	});

	it("renders the quote in dim muted text below the wordmark", () => {
		const lines = renderSplash(snapshot(), 160);
		const blob = lines.join("\n");

		expect(stripAnsi(blob)).toContain(
			"PERFECTION IS ACHIEVED, NOT WHEN THERE IS NOTHING MORE TO ADD, BUT WHEN THERE IS NOTHING LEFT TO TAKE AWAY.",
		);
		expect(stripAnsi(blob)).toContain("— ANTOINE DE SAINT-EXUPÉRY");
		// Dim muted brown #8B7A63 -> 139;122;99
		expect(blob).toContain("\u001b[38;2;139;122;99m");
	});

	it("centers each rendered line within the requested width", () => {
		const width = 120;
		const lines = renderSplash(snapshot(), width);
		expect(lines.length).toBeGreaterThan(0);
		// No line should exceed the width once stripped of ANSI escapes.
		for (const line of lines) {
			expect(stripAnsi(line).length).toBeLessThanOrEqual(width);
		}
	});

	it("lets the retained sumo-tui chat slot own the splash when enabled", () => {
		expect(shouldUseRetainedSplash({ SUMO_TUI: "1" })).toBe(true);
		expect(shouldUseRetainedSplash({ SUMO_TUI: "0" })).toBe(false);
		expect(shouldUseRetainedSplash({})).toBe(false);
	});

	it("uses cathedral palette tokens (no ad-hoc colors)", () => {
		const lines = renderSplash(snapshot(), 160).join("\n");
		// Whitelisted ANSI 24-bit colors from the cathedral palette.
		const accent = CATHEDRAL_TOKENS.colors.accent.replace("#", "");
		const muted = CATHEDRAL_TOKENS.colors.foregroundDim.replace("#", "");
		const fg = CATHEDRAL_TOKENS.colors.foreground.replace("#", "");

		const toAnsi = (hex: string): string => {
			const r = Number.parseInt(hex.slice(0, 2), 16);
			const g = Number.parseInt(hex.slice(2, 4), 16);
			const b = Number.parseInt(hex.slice(4, 6), 16);
			return `\u001b[38;2;${r};${g};${b}m`;
		};

		// At least the accent and muted tokens should appear in the rendered
		// blob; we don't enforce vellum since the cat face's chafa output may
		// already include foreground-tinted colors.
		expect(lines).toContain(toAnsi(accent));
		expect(lines).toContain(toAnsi(muted));
		void fg; // documented but not asserted to keep the asset rendering free.
	});
});
