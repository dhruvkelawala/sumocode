import { afterEach, describe, expect, it } from "vitest";
import {
	AMBER_CRT_THEME,
	CATHEDRAL_THEME,
	HERDR_THEME,
	OBSIDIAN_THEME,
	activeThemeApplicationRoles,
	resetThemeRegistryForTests,
	setActiveTheme,
	type ThemeApplicationRoles,
} from "./index.js";

const LEGACY_COMMENT = "#6F5D46";

function expectedFallback(theme: typeof CATHEDRAL_THEME): ThemeApplicationRoles {
	const colors = theme.tokens.colors;
	return {
		toolLedger: {
			surface: colors.surfaceRecess,
			border: colors.divider,
			label: colors.accent,
			target: colors.foreground,
			body: colors.foreground,
			bodyMuted: colors.foregroundDim,
		},
		code: {
			surface: colors.surfaceRecess,
			border: colors.divider,
			foreground: colors.foreground,
			gutter: colors.foregroundDim,
			comment: LEGACY_COMMENT,
			keyword: colors.accent,
			string: colors.states.idle,
			number: colors.states.thinking,
			function: colors.states.thinking,
		},
	};
}

describe("theme application roles", () => {
	afterEach(() => {
		delete CATHEDRAL_THEME.applicationRoles;
		resetThemeRegistryForTests();
	});

	it("resolves Cathedral to the exact legacy tool/code renderer roles", () => {
		expect(activeThemeApplicationRoles()).toEqual({
			toolLedger: {
				surface: "#120D0A",
				border: "#5A4D3C",
				label: "#D97706",
				target: "#F5E6C8",
				body: "#F5E6C8",
				bodyMuted: "#8B7A63",
			},
			code: {
				surface: "#120D0A",
				border: "#5A4D3C",
				foreground: "#F5E6C8",
				gutter: "#8B7A63",
				comment: LEGACY_COMMENT,
				keyword: "#D97706",
				string: "#7FB069",
				number: "#E8B339",
				function: "#E8B339",
			},
		});
	});

	it.each([
		["amber-crt", AMBER_CRT_THEME],
		["obsidian", OBSIDIAN_THEME],
		["herdr", HERDR_THEME],
	] as const)("derives legacy-compatible fallback roles for %s", (name, theme) => {
		setActiveTheme(name);
		expect(activeThemeApplicationRoles()).toEqual(expectedFallback(theme));
	});

	it("updates resolved roles immediately when the active theme changes", () => {
		expect(activeThemeApplicationRoles().toolLedger.label).toBe(CATHEDRAL_THEME.tokens.colors.accent);
		setActiveTheme("herdr");
		expect(activeThemeApplicationRoles().toolLedger.label).toBe(HERDR_THEME.tokens.colors.accent);
		expect(activeThemeApplicationRoles().code.string).toBe(HERDR_THEME.tokens.colors.states.idle);
	});

	it("returns Cathedral fallback roles after registry reset", () => {
		setActiveTheme("amber-crt");
		expect(activeThemeApplicationRoles()).toEqual(expectedFallback(AMBER_CRT_THEME));

		resetThemeRegistryForTests();
		expect(activeThemeApplicationRoles()).toEqual(expectedFallback(CATHEDRAL_THEME));
	});

	it("returns a complete explicit application-role override unchanged", () => {
		const override: ThemeApplicationRoles = {
			toolLedger: {
				surface: "#010101",
				border: "#020202",
				label: "#030303",
				target: "#040404",
				body: "#050505",
				bodyMuted: "#060606",
			},
			code: {
				surface: "#111111",
				border: "#121212",
				foreground: "#131313",
				gutter: "#141414",
				comment: "#151515",
				keyword: "#161616",
				string: "#171717",
				number: "#181818",
				function: "#191919",
			},
		};
		CATHEDRAL_THEME.applicationRoles = override;

		expect(activeThemeApplicationRoles()).toBe(override);
	});
});
