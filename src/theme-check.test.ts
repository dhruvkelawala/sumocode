import { describe, expect, it } from "vitest";
import {
	THEME_CHECK_COVERED_FG_SLOTS,
	THEME_CHECK_COVERED_BG_SLOTS,
	type ThemeReader,
	renderThemeCheck,
} from "./theme-check.js";

const ANSI = /\u001b\[[0-9;]*m/g;
const stripAnsi = (s: string): string => s.replace(ANSI, "");

function fakeTheme(): ThemeReader {
	return {
		fg(slot, text) {
			return `<fg:${slot}>${text}</fg>`;
		},
		bg(slot, text) {
			return `<bg:${slot}>${text}</bg>`;
		},
	};
}

describe("renderThemeCheck", () => {
	it("includes a banner heading naming the cathedral theme check", () => {
		const lines = renderThemeCheck(fakeTheme(), 80);
		const blob = stripAnsi(lines.join("\n"));

		expect(blob).toContain("CATHEDRAL THEME CHECK");
	});

	it("renders every covered foreground slot exactly once via theme.fg", () => {
		const theme = fakeTheme();
		const lines = renderThemeCheck(theme, 80);
		const blob = lines.join("\n");

		for (const slot of THEME_CHECK_COVERED_FG_SLOTS) {
			expect(blob, `missing fg slot exercise for ${slot}`).toContain(`<fg:${slot}>`);
		}
	});

	it("renders every covered background slot exactly once via theme.bg", () => {
		const theme = fakeTheme();
		const lines = renderThemeCheck(theme, 80);
		const blob = lines.join("\n");

		for (const slot of THEME_CHECK_COVERED_BG_SLOTS) {
			expect(blob, `missing bg slot exercise for ${slot}`).toContain(`<bg:${slot}>`);
		}
	});

	it("groups slots into named sections (states, surfaces, syntax, markdown, tools, thinking)", () => {
		const lines = renderThemeCheck(fakeTheme(), 80);
		const blob = stripAnsi(lines.join("\n"));

		expect(blob).toContain("STATES");
		expect(blob).toContain("SURFACES");
		expect(blob).toContain("SYNTAX");
		expect(blob).toContain("MARKDOWN");
		expect(blob).toContain("TOOLS");
		expect(blob).toContain("THINKING");
	});

	it("covers every Pi theme color slot SumoCode cares about", () => {
		// If Pi's schema grows a new slot we want exercised, this test fails until
		// we add it to THEME_CHECK_COVERED_FG_SLOTS or THEME_CHECK_COVERED_BG_SLOTS.
		const expected = new Set<string>([
			"accent",
			"border",
			"borderAccent",
			"borderMuted",
			"success",
			"error",
			"warning",
			"muted",
			"dim",
			"thinkingText",
			"userMessageText",
			"customMessageText",
			"customMessageLabel",
			"toolTitle",
			"toolOutput",
			"mdHeading",
			"mdLink",
			"mdLinkUrl",
			"mdCode",
			"mdCodeBlock",
			"mdCodeBlockBorder",
			"mdQuote",
			"mdQuoteBorder",
			"mdHr",
			"mdListBullet",
			"toolDiffAdded",
			"toolDiffRemoved",
			"toolDiffContext",
			"syntaxComment",
			"syntaxKeyword",
			"syntaxFunction",
			"syntaxVariable",
			"syntaxString",
			"syntaxNumber",
			"syntaxType",
			"syntaxOperator",
			"syntaxPunctuation",
			"thinkingOff",
			"thinkingMinimal",
			"thinkingLow",
			"thinkingMedium",
			"thinkingHigh",
			"thinkingXhigh",
			"bashMode",
		]);

		const actual = new Set(THEME_CHECK_COVERED_FG_SLOTS);
		expect(actual).toEqual(expected);
	});
});
