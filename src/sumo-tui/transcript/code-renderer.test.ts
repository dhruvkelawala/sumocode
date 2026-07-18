import { afterEach, describe, expect, it } from "vitest";
import { resetThemeRegistryForTests, setActiveTheme } from "../../themes/index.js";
import { renderCathedralCodeBlock } from "./code-renderer.js";

const ANSI = /\u001b\[[0-9;]*m/g;
const stripAnsi = (s: string): string => s.replace(ANSI, "");

function rgbAnsi(hex: string, channel: 38 | 48): string {
	const normalized = hex.replace("#", "");
	const r = Number.parseInt(normalized.slice(0, 2), 16);
	const g = Number.parseInt(normalized.slice(2, 4), 16);
	const b = Number.parseInt(normalized.slice(4, 6), 16);
	return `\u001b[${channel};2;${r};${g};${b}m`;
}

function codeStyledText(fg: string, text: string): string {
	return `${rgbAnsi("#DCC7FF", 38)}${rgbAnsi("#100A1D", 48)}${rgbAnsi(fg, 38)}${text}`;
}

describe("Cathedral code block renderer", () => {
	afterEach(() => resetThemeRegistryForTests());

	it("renders a framed code block with language label and line gutter", () => {
		const rows = renderCathedralCodeBlock("ts", "const x = 1;\nreturn x;", 60);
		const plain = rows.map(stripAnsi);

		expect(plain[0]).toMatch(/^╭─── ts ─+╮$/);
		expect(plain[1]).toContain("  1 ");
		expect(plain[1]).toContain("const x = 1;");
		expect(plain[2]).toContain("  2 ");
		expect(plain[2]).toContain("return x;");
		expect(plain[plain.length - 1]).toMatch(/^╰─+╯$/);
	});

	it("pads every row to exactly the requested width", () => {
		const rows = renderCathedralCodeBlock("ts", "const a = 1;", 80);
		for (const row of rows) {
			expect(stripAnsi(row).length, `row not padded to 80: ${JSON.stringify(stripAnsi(row))}`).toBe(80);
		}
	});

	it("renders without a language label when lang is empty", () => {
		const rows = renderCathedralCodeBlock("", "hello", 40);
		const top = stripAnsi(rows[0]!);
		expect(top).toMatch(/^╭──+╮$/);
		expect(top).not.toContain("  ");
	});

	it("highlights keywords in accent color for TypeScript", () => {
		const rows = renderCathedralCodeBlock("ts", "async function foo() {}", 80);
		const raw = rows[1]!;
		// accent #D97706 -> 217;119;6
		expect(raw).toContain("\u001b[38;2;217;119;6m");
		expect(raw).toContain("async");
		expect(raw).toContain("function");
	});

	it("highlights strings in idle (sage) color", () => {
		const rows = renderCathedralCodeBlock("ts", 'const s = "hello";', 80);
		const raw = rows[1]!;
		// idle #7FB069 -> 127;176;105
		expect(raw).toContain("\u001b[38;2;127;176;105m");
	});

	it("highlights comments in syntax.comment color", () => {
		const rows = renderCathedralCodeBlock("ts", "// this is a comment", 80);
		const raw = rows[1]!;
		// comment #6F5D46 -> 111;93;70
		expect(raw).toContain("\u001b[38;2;111;93;70m");
	});

	it("highlights bash comments with # prefix", () => {
		const rows = renderCathedralCodeBlock("bash", "# archive old files", 80);
		const raw = rows[1]!;
		expect(raw).toContain("\u001b[38;2;111;93;70m");
	});

	it("collapses blocks longer than 20 lines with a collapsed marker", () => {
		const source = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n");
		const rows = renderCathedralCodeBlock("ts", source, 80);
		const plain = rows.map(stripAnsi);

		// 1 top + 20 body + 1 collapsed + 1 bottom = 23
		expect(rows).toHaveLength(23);
		expect(plain[21]).toContain("… 10 lines collapsed");
		expect(plain[21]).toContain("ctrl+o expand");
	});

	it("renders surfaceRecess background on body rows", () => {
		const rows = renderCathedralCodeBlock("ts", "const x = 1;", 60);
		// surfaceRecess #120D0A -> 18;13;10
		expect(rows[1]).toContain("\u001b[48;2;18;13;10m");
	});

	it("handles very narrow widths gracefully", () => {
		const rows = renderCathedralCodeBlock("ts", "const x = 1;", 8);
		expect(rows.length).toBeGreaterThan(0);
		expect(stripAnsi(rows[0]!).length).toBeLessThanOrEqual(8);
	});

	it("renders Ultraviolet code blocks through semantic code roles", () => {
		setActiveTheme("ultraviolet-core");

		const rows = renderCathedralCodeBlock("ts", "// note\nconst total = compute(42, \"ok\");", 96);
		const raw = rows.join("\n");

		expect(raw).toContain(`${rgbAnsi("#56347A", 38)}╭─`);
		expect(raw).toContain(`${rgbAnsi("#9B7BBE", 38)}ts`);
		expect(raw).toContain(rgbAnsi("#100A1D", 48));
		expect(raw).toContain(codeStyledText("#9B7BBE", "  1 "));
		expect(raw).toContain(codeStyledText("#9B7BBE", "// note"));
		expect(raw).toContain(codeStyledText("#B974FF", "const"));
		expect(raw).toContain(codeStyledText("#DCC7FF", "total"));
		expect(raw).toContain(codeStyledText("#75E8FF", "compute"));
		expect(raw).toContain(codeStyledText("#FFC857", "42"));
		expect(raw).toContain(codeStyledText("#75E8FF", "\"ok\""));
	});

	it("renders Ultraviolet collapsed rows with code gutter and surface roles", () => {
		setActiveTheme("ultraviolet-core");
		const source = Array.from({ length: 22 }, (_, i) => `line ${i + 1}`).join("\n");

		const rows = renderCathedralCodeBlock("ts", source, 96);
		const raw = rows.join("\n");

		expect(stripAnsi(rows[21]!)).toContain("… 2 lines collapsed");
		expect(raw).toContain(codeStyledText("#9B7BBE", "… 2 lines collapsed · ctrl+o expand"));
	});
});
