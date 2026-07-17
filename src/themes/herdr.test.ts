import { describe, expect, it } from "vitest";
import { HERDR_INDICATOR_FRAMES, HERDR_INDICATOR_INTERVAL_MS, HERDR_THEME } from "./herdr.js";

/** WCAG relative luminance for a #RRGGBB hex colour. */
function relativeLuminance(hex: string): number {
	const value = hex.replace("#", "");
	const channel = (offset: number): number => {
		const srgb = Number.parseInt(value.slice(offset, offset + 2), 16) / 255;
		return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
}

/** WCAG contrast ratio between two hex colours. */
function contrastRatio(a: string, b: string): number {
	const la = relativeLuminance(a);
	const lb = relativeLuminance(b);
	const [lighter, darker] = la >= lb ? [la, lb] : [lb, la];
	return (lighter + 0.05) / (darker + 0.05);
}

describe("HERDR_THEME", () => {
	const colors = HERDR_THEME.tokens.colors;

	it("carries the exact plan-pinned metadata", () => {
		expect(HERDR_THEME.name).toBe("herdr");
		expect(HERDR_THEME.displayName).toBe("Herdr Terminal");
		expect(HERDR_THEME.description).toBe("Operational terminal — cyan routing, mint readiness, sharp hacker chrome.");
	});

	it("carries the exact plan-pinned palette values", () => {
		expect(colors).toEqual({
			background: "#0B0B0F",
			surface: "#0D0D14",
			surfaceRecess: "#07090D",
			surfaceLifted: "#1A1A2E",
			foreground: "#F5EFE1",
			foregroundDim: "#8F96A8",
			divider: "#3A3A4A",
			accent: "#00E5FF",
			states: {
				idle: "#4ECCA3",
				thinking: "#00E5FF",
				tool: "#FFD700",
				approval: "#FF3366",
				learning: "#F1D77A",
			},
		});
	});

	it("keeps the five state colours distinct", () => {
		const stateValues = Object.values(colors.states);
		expect(new Set(stateValues).size).toBe(stateValues.length);
	});

	it("meets 4.5:1 contrast for text, accent, and states against every surface", () => {
		// Design contract: `divider` is exempt (decorative only, never the sole
		// carrier of text or state — active borders use `accent`).
		const foregrounds = [colors.foreground, colors.foregroundDim, colors.accent, ...Object.values(colors.states)];
		const surfaces = [colors.background, colors.surface, colors.surfaceRecess, colors.surfaceLifted];
		for (const fg of foregrounds) {
			for (const bg of surfaces) {
				expect(contrastRatio(fg, bg), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
			}
		}
	});

	it("uses only single-cell width chrome glyphs", () => {
		const chrome = HERDR_THEME.chrome;
		const glyphs = [
			...Object.values(chrome.frame),
			...Object.values(chrome.sectionGlyphs).filter((glyph): glyph is string => typeof glyph === "string"),
			chrome.ruleChar,
			chrome.tabActive,
			chrome.tabInactive,
			chrome.bullet,
		];
		for (const glyph of glyphs) {
			expect(glyph.length, `glyph ${JSON.stringify(glyph)}`).toBe(1);
			// Single-cell terminal width: BMP characters outside wide/ambiguous-wide
			// CJK ranges. All Herdr glyphs are ASCII or light box-drawing.
			const codePoint = glyph.codePointAt(0)!;
			expect(codePoint).toBeLessThan(0x3000);
		}
		expect(chrome.sectionTracked).toBe(false);
		expect(chrome.sectionGlyphs).toEqual({ context: ">", memory: "#", mcp: "@", session: "$", registry: "%" });
	});

	it("uses eight unique width-1 ASCII packet frames at 110ms", () => {
		expect(HERDR_INDICATOR_FRAMES).toEqual([".", ":", "+", "*", "#", "%", "@", ">"]);
		expect(new Set(HERDR_INDICATOR_FRAMES).size).toBe(8);
		for (const frame of HERDR_INDICATOR_FRAMES) {
			expect(frame.length).toBe(1);
			expect(frame.codePointAt(0)!).toBeLessThan(0x80);
		}
		expect(HERDR_INDICATOR_INTERVAL_MS).toBe(110);
		expect(HERDR_THEME.workingIndicator.frames).toBe(HERDR_INDICATOR_FRAMES);
		expect(HERDR_THEME.workingIndicator.intervalMs).toBe(HERDR_INDICATOR_INTERVAL_MS);
	});
});
