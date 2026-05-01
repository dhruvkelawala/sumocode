import { describe, expect, it } from "vitest";
import { alignAutocompleteRow } from "./cathedral-editor.js";

const ANSI_PATTERN = /\u001b\[[0-9;]*m/g;
const stripAnsi = (value: string): string => value.replace(ANSI_PATTERN, "");

describe("alignAutocompleteRow", () => {
	it("anchors active autocomplete under the Cathedral input content, not terminal col 0", () => {
		const row = "▸ /resume  resume previous session";
		const aligned = stripAnsi(alignAutocompleteRow(row, 48, { splash: false }));

		expect(aligned).toHaveLength(48);
		expect(aligned.startsWith("    ▸ /resume")).toBe(true);
		expect(aligned.startsWith("▸")).toBe(false);
	});

	it("anchors splash autocomplete rows to the centered splash frame content column", () => {
		const shortRow = "▸ /help";
		const longRow = "▸ /resume  resume previous session";
		const alignedShort = stripAnsi(alignAutocompleteRow(shortRow, 80, { splash: true, frameWidth: 60 }));
		const alignedLong = stripAnsi(alignAutocompleteRow(longRow, 80, { splash: true, frameWidth: 60 }));

		expect(alignedShort).toHaveLength(80);
		expect(alignedLong).toHaveLength(80);
		expect(alignedShort.indexOf("▸ /help")).toBe(11);
		expect(alignedLong.indexOf("▸ /resume")).toBe(11);
	});

	it("truncates active autocomplete rows after applying the left anchor", () => {
		const row = "▸ /very-long-command-name with a very long description";
		const aligned = stripAnsi(alignAutocompleteRow(row, 20, { splash: false }));

		expect(aligned).toHaveLength(20);
		expect(aligned.startsWith("    ▸")).toBe(true);
	});
});
