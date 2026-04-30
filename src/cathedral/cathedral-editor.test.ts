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

	it("centers splash autocomplete rows under the centered splash frame", () => {
		const row = "▸ /help";
		const aligned = stripAnsi(alignAutocompleteRow(row, 80, { splash: true, frameWidth: 60 }));

		expect(aligned).toHaveLength(80);
		expect(aligned.indexOf("▸ /help")).toBeGreaterThan(0);
	});

	it("truncates active autocomplete rows after applying the left anchor", () => {
		const row = "▸ /very-long-command-name with a very long description";
		const aligned = stripAnsi(alignAutocompleteRow(row, 20, { splash: false }));

		expect(aligned).toHaveLength(20);
		expect(aligned.startsWith("    ▸")).toBe(true);
	});
});
