import { afterEach, describe, expect, it } from "vitest";
import { CATHEDRAL_THEME, activeThemeColors, getActiveTheme, getTheme, getThemeVersion, listThemes, onThemeChanged, resetThemeRegistryForTests, setActiveTheme } from "./index.js";

describe("theme registry", () => {
	afterEach(() => resetThemeRegistryForTests());

	it("registers Cathedral as the default and first theme", () => {
		expect(listThemes().map((theme) => theme.name)).toEqual(["cathedral"]);
		expect(getTheme("cathedral")).toBe(CATHEDRAL_THEME);
		expect(getTheme(" Cathedral ")).toBe(CATHEDRAL_THEME);
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
		const result = setActiveTheme("amber-crt");

		expect(result.success).toBe(false);
		if (!result.success) expect(result.error).toContain("Unknown SumoCode theme");
		expect(getActiveTheme()).toBe(CATHEDRAL_THEME);
		expect(getThemeVersion()).toBe(before);
	});
});
