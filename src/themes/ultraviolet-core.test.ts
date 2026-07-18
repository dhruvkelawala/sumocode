import { describe, expect, it } from "vitest";
import { ULTRAVIOLET_CORE_INDICATOR_FRAMES, ULTRAVIOLET_CORE_INDICATOR_INTERVAL_MS, ULTRAVIOLET_CORE_THEME } from "./ultraviolet-core.js";

function relativeLuminance(hex: string): number {
	const value = hex.replace("#", "");
	const channel = (offset: number): number => {
		const srgb = Number.parseInt(value.slice(offset, offset + 2), 16) / 255;
		return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
}

function contrastRatio(a: string, b: string): number {
	const la = relativeLuminance(a);
	const lb = relativeLuminance(b);
	const [lighter, darker] = la >= lb ? [la, lb] : [lb, la];
	return (lighter + 0.05) / (darker + 0.05);
}

describe("ULTRAVIOLET_CORE_THEME", () => {
	const colors = ULTRAVIOLET_CORE_THEME.tokens.colors;
	const applicationRoles = ULTRAVIOLET_CORE_THEME.applicationRoles!;

	it("pins the plan-approved identity and semantic core palette", () => {
		expect(ULTRAVIOLET_CORE_THEME.name).toBe("ultraviolet-core");
		expect(ULTRAVIOLET_CORE_THEME.displayName).toBe("Ultraviolet Core");
		expect(ULTRAVIOLET_CORE_THEME.description).toBe("Ultraviolet command layer — violet focus, ice signal, deep spatial surfaces.");
		expect(colors).toEqual({
			background: "#06050B",
			surface: "#0D0917",
			surfaceRecess: "#0A0711",
			surfaceLifted: "#1B102E",
			foreground: "#DCC7FF",
			foregroundDim: "#9B7BBE",
			divider: "#56347A",
			accent: "#B974FF",
			states: {
				idle: "#DCC7FF",
				thinking: "#B974FF",
				tool: "#FFC857",
				approval: "#FF668F",
				learning: "#75E8FF",
			},
		});
	});

	it("pins tool-ledger and code application roles", () => {
		expect(applicationRoles).toEqual({
			toolLedger: {
				surface: "#17100D",
				border: "#6B4A1C",
				label: "#FFC857",
				target: "#FFE1A6",
				body: "#FFE1A6",
				bodyMuted: "#C7A96D",
			},
			code: {
				surface: "#100A1D",
				border: "#56347A",
				foreground: "#DCC7FF",
				gutter: "#9B7BBE",
				comment: "#9B7BBE",
				keyword: "#B974FF",
				string: "#75E8FF",
				number: "#FFC857",
				function: "#75E8FF",
			},
		});
	});

	it("keeps operational states distinct while allowing idle to match body lavender", () => {
		expect(new Set(Object.values(colors.states)).size).toBe(Object.values(colors.states).length);
		expect(colors.states.idle).toBe(colors.foreground);
		expect(colors.states.thinking).toBe(colors.accent);
	});

	it("keeps readable core roles above 4.5:1 on every declared core surface", () => {
		const foregrounds = [colors.foreground, colors.foregroundDim, colors.accent, ...Object.values(colors.states)];
		const surfaces = [colors.background, colors.surface, colors.surfaceRecess, colors.surfaceLifted];
		for (const fg of foregrounds) {
			for (const bg of surfaces) expect(contrastRatio(fg, bg), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
		}
	});

	it("keeps readable tool and code roles above 4.5:1 on their application surfaces", () => {
		const toolForegrounds = [
			applicationRoles.toolLedger.label,
			applicationRoles.toolLedger.target,
			applicationRoles.toolLedger.body,
			applicationRoles.toolLedger.bodyMuted,
			colors.states.approval,
		];
		for (const fg of toolForegrounds) expect(contrastRatio(fg, applicationRoles.toolLedger.surface), `tool ${fg}`).toBeGreaterThanOrEqual(4.5);

		const codeForegrounds = [
			applicationRoles.code.foreground,
			applicationRoles.code.gutter,
			applicationRoles.code.comment,
			applicationRoles.code.keyword,
			applicationRoles.code.string,
			applicationRoles.code.number,
			applicationRoles.code.function,
		];
		for (const fg of codeForegrounds) expect(contrastRatio(fg, applicationRoles.code.surface), `code ${fg}`).toBeGreaterThanOrEqual(4.5);
	});

	it("uses single-cell chrome and an ASCII orbital pulse", () => {
		const chrome = ULTRAVIOLET_CORE_THEME.chrome;
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
			expect(glyph.codePointAt(0)!).toBeLessThan(0x3000);
		}
		expect(chrome.sectionTracked).toBe(false);
		expect(ULTRAVIOLET_CORE_INDICATOR_FRAMES).toEqual([".", ":", "o", "O", "@", "O", "o", ":"]);
		for (const frame of ULTRAVIOLET_CORE_INDICATOR_FRAMES) expect(frame.codePointAt(0)!).toBeLessThan(0x80);
		expect(ULTRAVIOLET_CORE_INDICATOR_INTERVAL_MS).toBe(120);
		expect(ULTRAVIOLET_CORE_THEME.workingIndicator.frames).toBe(ULTRAVIOLET_CORE_INDICATOR_FRAMES);
		expect(ULTRAVIOLET_CORE_THEME.workingIndicator.intervalMs).toBe(ULTRAVIOLET_CORE_INDICATOR_INTERVAL_MS);
	});
});
