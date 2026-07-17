import { afterEach, describe, expect, it } from "vitest";
import { AMBER_CRT_THEME, CATHEDRAL_THEME, activeThemeColors, cycleActiveTheme, getActiveTheme, getTheme, getThemeVersion, HERDR_THEME, listThemes, nextThemeName, OBSIDIAN_THEME, onThemeChanged, resetThemeRegistryForTests, setActiveTheme } from "./index.js";

describe("theme registry", () => {
	afterEach(() => resetThemeRegistryForTests());

	it("registers Cathedral, Amber CRT, Obsidian, and Herdr in PRD-pinned registry order", () => {
		// PRD § Themes: cathedral first, amber-crt second, obsidian third, herdr fourth.
		expect(listThemes().map((theme) => theme.name)).toEqual(["cathedral", "amber-crt", "obsidian", "herdr"]);
		expect(getTheme("cathedral")).toBe(CATHEDRAL_THEME);
		expect(getTheme(" Cathedral ")).toBe(CATHEDRAL_THEME);
		expect(getTheme("obsidian")).toBe(OBSIDIAN_THEME);
		expect(getTheme("amber-crt")).toBe(AMBER_CRT_THEME);
		expect(getTheme("herdr")).toBe(HERDR_THEME);
		expect(getActiveTheme()).toBe(CATHEDRAL_THEME);
		expect(activeThemeColors().accent).toBe("#D97706");
	});

	it("sets the active theme and notifies subscribers", () => {
		const seen: string[] = [];
		const unsubscribe = onThemeChanged((theme) => seen.push(theme.name));
		const before = getThemeVersion();

		const result = setActiveTheme("cathedral");
		unsubscribe();
		setActiveTheme("cathedral");

		expect(result).toEqual({ success: true, theme: CATHEDRAL_THEME });
		expect(getThemeVersion()).toBe(before + 2);
		expect(seen).toEqual(["cathedral"]);
	});

	it("rejects unknown themes without changing the active theme", () => {
		const before = getThemeVersion();
		const result = setActiveTheme("abyssal-tide");

		expect(result.success).toBe(false);
		if (!result.success) expect(result.error).toContain("Unknown SumoCode theme");
		expect(getActiveTheme()).toBe(CATHEDRAL_THEME);
		expect(getThemeVersion()).toBe(before);
	});

	it("swaps active colors when switching to Amber CRT", () => {
		const result = setActiveTheme("amber-crt");

		expect(result.success).toBe(true);
		if (result.success) expect(result.theme).toBe(AMBER_CRT_THEME);
		expect(getActiveTheme()).toBe(AMBER_CRT_THEME);
		expect(activeThemeColors().background).toBe("#0A0806");
		expect(activeThemeColors().foreground).toBe("#FFB000");
		expect(activeThemeColors().accent).toBe("#FFD700");
		// Preattentive states must remain distinct from Cathedral/Obsidian.
		expect(activeThemeColors().states.idle).toBe("#00FF66");
		expect(activeThemeColors().states.thinking).toBe("#F0F0F0");
		expect(activeThemeColors().states.tool).toBe("#00E5FF");
		expect(activeThemeColors().states.approval).toBe("#FF5500");
		expect(activeThemeColors().states.learning).toBe("#FF66FF");
	});

	it("swaps active colors when switching to Obsidian", () => {
		const result = setActiveTheme("obsidian");

		expect(result.success).toBe(true);
		if (result.success) expect(result.theme).toBe(OBSIDIAN_THEME);
		expect(getActiveTheme()).toBe(OBSIDIAN_THEME);
		expect(activeThemeColors().background).toBe("#050308");
		expect(activeThemeColors().accent).toBe("#F0B400");
		expect(activeThemeColors().states.thinking).toBe("#00E5FF");
	});

	it("swaps active colors when switching to Herdr", () => {
		const result = setActiveTheme("herdr");

		expect(result.success).toBe(true);
		if (result.success) expect(result.theme).toBe(HERDR_THEME);
		expect(getActiveTheme()).toBe(HERDR_THEME);
		expect(activeThemeColors().background).toBe("#0B0B0F");
		expect(activeThemeColors().accent).toBe("#00E5FF");
		expect(activeThemeColors().states.idle).toBe("#4ECCA3");
		expect(activeThemeColors().states.approval).toBe("#FF3366");
	});

	it("reports the next theme name and wraps from last to first", () => {
		expect(nextThemeName("cathedral")).toBe("amber-crt");
		expect(nextThemeName("amber-crt")).toBe("obsidian");
		expect(nextThemeName("obsidian")).toBe("herdr");
		expect(nextThemeName("herdr")).toBe("cathedral");
		expect(nextThemeName("unknown")).toBe("cathedral");
	});

	it("cycles to the next theme and notifies subscribers", () => {
		const before = getThemeVersion();
		const seen: string[] = [];
		const unsubscribe = onThemeChanged((theme) => seen.push(theme.name));

		const next = cycleActiveTheme();
		unsubscribe();

		expect(next).toBe(AMBER_CRT_THEME);
		expect(getActiveTheme()).toBe(AMBER_CRT_THEME);
		expect(getThemeVersion()).toBe(before + 1);
		expect(seen).toEqual(["amber-crt"]);
	});
});
