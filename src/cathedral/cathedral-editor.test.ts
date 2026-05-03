import { describe, expect, it } from "vitest";
import { alignAutocompleteRow, normalizeRawMultilinePasteInput } from "./cathedral-editor.js";

const ANSI_PATTERN = /\u001b\[[0-9;]*m/g;
const stripAnsi = (value: string): string => value.replace(ANSI_PATTERN, "");

describe("normalizeRawMultilinePasteInput", () => {
	it("keeps a single raw Enter as submit", () => {
		expect(normalizeRawMultilinePasteInput("\r")).toBe("\r");
	});

	it("turns raw CR multiline paste chunks into editor newlines", () => {
		expect(normalizeRawMultilinePasteInput("line one\rline two\rline three")).toBe("line one\nline two\nline three");
		expect(normalizeRawMultilinePasteInput("line one\r\nline two")).toBe("line one\nline two");
	});

	it("leaves bracketed paste untouched for Pi's editor parser", () => {
		const paste = "\x1b[200~line one\rline two\x1b[201~";
		expect(normalizeRawMultilinePasteInput(paste)).toBe(paste);
	});

	it("preserves modifier-Enter encodings so Shift+Enter / Alt+Enter survive (#201)", () => {
		// Kitty's default Shift+Enter mapping (and the legacy Alt+Enter encoding
		// when kitty protocol is off) is `\x1b\r`. Ghostty's Shift+Enter is
		// `\x1b\n`. Both must pass through verbatim — rewriting the CR to LF
		// yields `\x1b\n`, which pi-tui's editor recognizes as neither
		// shift+enter nor alt+enter, silently dropping the keypress.
		expect(normalizeRawMultilinePasteInput("\x1b\r")).toBe("\x1b\r");
		expect(normalizeRawMultilinePasteInput("\x1b\n")).toBe("\x1b\n");
		// Defend against a hypothetical terminal-batched chunk of two
		// Shift+Enters arriving in one event — must still pass through.
		expect(normalizeRawMultilinePasteInput("\x1b\r\x1b\r")).toBe("\x1b\r\x1b\r");
	});

	it("still normalizes paste even when content contains ESC sequences", () => {
		// Pasting an ANSI-colored multi-line log: the bridge must still turn raw
		// CR into editor newlines so the user's draft preserves all lines. The
		// modifier-Enter bailout is a regex that matches ONLY whole-chunk
		// modifier-Enter encodings, so paste-with-embedded-ESC stays in the
		// rewrite path.
		expect(normalizeRawMultilinePasteInput("\x1b[31mError\x1b[0m\rline two")).toBe("\x1b[31mError\x1b[0m\nline two");
	});
});

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
