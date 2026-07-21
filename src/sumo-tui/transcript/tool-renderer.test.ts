import { afterEach, describe, expect, it } from "vitest";
import { stripAnsi } from "../cathedral/ansi.js";
import { visibleWidth } from "@earendil-works/pi-tui";
import { resetThemeRegistryForTests, setActiveTheme } from "../../themes/index.js";
import { renderCompactToolPill, renderToolBlockRows, renderToolLedgerRows } from "./tool-renderer.js";

function rgbAnsi(hex: string, channel: 38 | 48): string {
	const normalized = hex.replace("#", "");
	const r = Number.parseInt(normalized.slice(0, 2), 16);
	const g = Number.parseInt(normalized.slice(2, 4), 16);
	const b = Number.parseInt(normalized.slice(4, 6), 16);
	return `\u001b[${channel};2;${r};${g};${b}m`;
}

function ledgerStyledText(fg: string, text: string): string {
	return `${rgbAnsi(fg, 38)}${rgbAnsi("#100A1D", 48)}${text}`;
}

describe("tool renderer", () => {
	afterEach(() => resetThemeRegistryForTests());

	it("renders compact Cathedral tool pills", () => {
		const line = renderCompactToolPill({ name: "read", status: "success", input: { path: "src/auth/session.ts" } });

		expect(stripAnsi(line)).toBe("✓ [read]  src/auth/session.ts  · ctrl+o expand");
		expect(line).toContain("\u001b[38;2;127;176;105m✓");
		expect(line).toContain("\u001b[38;2;217;119;6m[read]");
	});

	it("renders ledger rows for tool blocks at the available body width", () => {
		const rows = renderToolLedgerRows({
			name: "edit",
			status: "success",
			input: { path: "src/auth/session.ts" },
			output: "+14 -6 session flow updated",
		}, 80);

		expect(rows.map(stripAnsi)).toEqual([
			"╭─ [edit]  src/auth/session.ts ────────────────────────────────────────────── ✓ ",
			"│ +14 -6 session flow updated                                                   ",
			"╰───────────────────────────────────────────────────────────────────────────────",
		]);
		expect(rows.every((row) => stripAnsi(row).length === 80)).toBe(true);
		expect(rows.join("\n")).toContain("48;2;18;13;10m");
	});

	it("covers compact read/edit/write/bash status variants", () => {
		const cases = [
			[{ name: "read", status: "success", input: { path: "src/auth/session.ts" }, details: { lineCount: 184 } }, "✓ [read]  src/auth/session.ts  · 184 lines  · ctrl+o expand"],
			[{ name: "edit", status: "success", input: { path: "src/auth/session.ts" }, output: "+14 -6" }, "✓ [edit]  src/auth/session.ts  · +14 -6  · ctrl+o diff"],
			[{ name: "write", status: "success", input: { path: "src/auth/new.ts" }, details: { lineCount: 47 } }, "✓ [write]  src/auth/new.ts  · 47 lines  · ctrl+o expand"],
			[{ name: "bash", status: "success", input: { command: "pnpm test" }, details: { summary: "22 tests, 1.2s" } }, "✓ [bash]  pnpm test  · 22 tests, 1.2s  · ctrl+o output"],
			[{ name: "bash", status: "error", input: { command: "pnpm test" }, error: "1 failed" }, "✗ [bash]  pnpm test  · 1 failed  · ctrl+o error"],
			[{ name: "bash", status: "running", input: { command: "pnpm test" } }, "▶ [bash]  pnpm test  · ctrl+o output"],
		] as const;

		for (const [tool, expected] of cases) {
			expect(stripAnsi(renderCompactToolPill(tool))).toBe(expected);
		}
	});

	it("renders tool blocks expanded by default", () => {
		const rows = renderToolBlockRows({
			name: "read",
			status: "success",
			input: { path: "src/example.ts" },
			details: { excerpt: ["\tconst value = 1;"], totalLines: 1 },
		}, 60);

		expect(stripAnsi(rows[0]!)).toContain("╭─ [read]");
		expect(stripAnsi(rows.join("\n"))).toContain("    const value = 1;");
		expect(rows.every((row) => visibleWidth(row) <= 60)).toBe(true);
	});

	it("truncates collapsed tool blocks to the available width", () => {
		const rows = renderToolBlockRows({
			name: "read",
			status: "success",
			input: { path: "/Volumes/SumoDeus NVMe/code/sumocode/src/sumo-tui/pi-compat/owned-shell-renderer.ts" },
			details: { lineCount: 184 },
			expanded: false,
		}, 80);

		expect(rows).toHaveLength(1);
		expect(visibleWidth(rows[0]!)).toBeLessThanOrEqual(80);
		expect(stripAnsi(rows[0]!)).toContain("[read]");
	});

	it("renders expanded read ledgers with line gutter and collapsed marker", () => {
		const rows = renderToolLedgerRows({
			name: "read",
			status: "success",
			input: { path: "src/auth/session.ts" },
			details: { excerpt: ["import { Session } from './session';", "export async function getUser() {}"], totalLines: 184 },
		}, 90).map(stripAnsi);

		expect(rows[1]).toContain("   1  import { Session }");
		expect(rows[2]).toContain("   2  export async function");
		expect(rows[3]).toContain("… 182 lines collapsed");
	});

	it("renders expanded edit ledgers with diff colors and collapsed marker", () => {
		const rows = renderToolLedgerRows({
			name: "edit",
			status: "success",
			input: { path: "src/auth/session.ts" },
			details: { diff: ["- old session", "+ new session", "  return session", "+ emit event"], collapsedLines: 8 },
		}, 90);
		const plain = rows.map(stripAnsi).join("\n");

		expect(plain).toContain("- old session");
		expect(plain).toContain("+ new session");
		expect(plain).toContain("… 8 lines collapsed");
		expect(rows.join("\n")).toContain("38;2;193;68;62m");
		expect(rows.join("\n")).toContain("38;2;127;176;105m");
	});

	it("renders Pi's string diff with +/- coloring and embedded line numbers", () => {
		const rows = renderToolLedgerRows({
			name: "edit",
			status: "success",
			input: { path: "src/x.ts" },
			details: { diff: " 12 const a = 1;\n-14 const old = 2;\n+14 const next = 3;" },
		}, 80).map(stripAnsi);

		expect(rows.some((row) => row.includes("+1") && row.includes("-1"))).toBe(true);
		expect(rows.some((row) => row.includes("-14 const old = 2;"))).toBe(true);
		expect(rows.some((row) => row.includes("+14 const next = 3;"))).toBe(true);
		const addedRow = rows.find((row) => row.includes("+14 const next = 3;"));
		expect(addedRow).not.toMatch(/^\│\s+\d+\s+\+14/);
	});

	it("still falls back to the +N/-N summary when no diff string is present", () => {
		const rows = renderToolLedgerRows({
			name: "edit",
			status: "success",
			input: { path: "src/x.ts" },
			output: "+14 -6 session flow updated",
		}, 80).map(stripAnsi);

		expect(rows.some((row) => row.includes("+14") && row.includes("-6"))).toBe(true);
	});

	it("wraps long bash commands and output instead of clipping them", () => {
		const rows = renderToolLedgerRows({
			name: "bash",
			status: "success",
			input: { command: "pnpm vitest run src/sumo-tui/transcript/tool-renderer.test.ts" },
			output: "this is a very long output line that must wrap instead of being clipped",
		}, 36);
		const plain = rows.map(stripAnsi);

		expect(plain.length).toBeGreaterThan(4);
		expect(plain.join("\n")).toContain("src/sumo-tui/transcript/tool-ren");
		expect(plain.join("\n")).toContain("derer.test.ts");
		expect(plain.join("\n")).toContain("that must wrap instead of being");
		expect(plain.join("\n")).toContain("clipped");
		expect(plain.some((row) => row.includes("│ ↳ "))).toBe(true);
		expect(rows.every((row) => visibleWidth(row) === 36)).toBe(true);
	});

	it("caps wrapped bash output by rendered rows", () => {
		const longLine = "word ".repeat(80).trim();
		const rows = renderToolLedgerRows({
			name: "bash",
			status: "success",
			input: { command: "pnpm test" },
			output: Array.from({ length: 25 }, () => longLine).join("\n"),
		}, 80);
		const plain = rows.map(stripAnsi);

		expect(rows.length).toBeLessThanOrEqual(31);
		expect(plain.join("\n")).toContain("display rows collapsed");
	});

	it("keeps all 25 unwrapped bash output lines visible", () => {
		const rows = renderToolLedgerRows({
			name: "bash",
			status: "success",
			input: { command: "pnpm test" },
			output: Array.from({ length: 25 }, (_, index) => `output ${index + 1}`).join("\n"),
		}, 80).map(stripAnsi);

		expect(rows.join("\n")).toContain("output 25");
		expect(rows.join("\n")).not.toContain("display rows collapsed");
	});

	it("bounds a huge single-line bash result before wrapping", () => {
		const render = () => renderToolLedgerRows({
			name: "bash",
			status: "success" as const,
			input: { command: "cat large.json" },
			output: "x".repeat(130_000),
		}, 80);

		expect(render).not.toThrow();
		expect(render().length).toBeLessThanOrEqual(31);
		expect(render().map(stripAnsi).join("\n")).toContain("display rows collapsed");
	});

	it("limits long commands so bash output remains visible with one collapse marker", () => {
		const rows = renderToolLedgerRows({
			name: "bash",
			status: "success",
			input: { command: `printf ${"x".repeat(2_500)}` },
			output: ["OUTPUT-STILL-VISIBLE", ...Array.from({ length: 29 }, (_, index) => `output ${index + 2}`)].join("\n"),
		}, 80).map(stripAnsi);

		expect(rows.join("\n")).toContain("command rows collapsed");
		expect(rows.join("\n")).toContain("OUTPUT-STILL-VISIBLE");
		expect(rows.filter((row) => row.includes("collapsed"))).toHaveLength(1);
	});

	it("keeps all 25 outputs visible when the command wraps", () => {
		const rows = renderToolLedgerRows({
			name: "bash",
			status: "success",
			input: { command: `printf ${"x".repeat(90)}` },
			output: Array.from({ length: 25 }, (_, index) => `output ${index + 1}`).join("\n"),
		}, 80).map(stripAnsi);

		expect(rows.join("\n")).toContain("output 25");
		expect(rows.join("\n")).not.toContain("display rows collapsed");
	});

	it("does not let one huge output line hide later output lines", () => {
		const rows = renderToolLedgerRows({
			name: "bash",
			status: "success",
			input: { command: "run" },
			output: ["x".repeat(3_000), ...Array.from({ length: 24 }, (_, index) => `valuable ${index + 2}`)].join("\n"),
		}, 80).map(stripAnsi);

		expect(rows.join("\n")).toContain("valuable 25");
		expect(rows.join("\n")).toContain("display rows collapsed");
	});

	it("uses the full available width on the first bash row", () => {
		const rows = renderToolLedgerRows({
			name: "bash",
			status: "success",
			input: { command: "true" },
			output: "x".repeat(28),
		}, 30).map(stripAnsi);

		expect(rows).toHaveLength(4);
		expect(rows.join("\n")).not.toContain("↳");
	});

	it("uses a concise collapse marker when detailed reasons do not fit", () => {
		const rows = renderToolLedgerRows({
			name: "bash",
			status: "success",
			input: { command: `printf ${"x".repeat(500)}` },
			output: Array.from({ length: 30 }, () => "y".repeat(100)).join("\n"),
		}, 40).map(stripAnsi);

		expect(rows.join("\n")).toContain("… content collapsed");
	});

	it("uses tool color for running bash rows", () => {
		const rows = renderToolLedgerRows({ name: "bash", status: "running", input: { command: "pnpm test" } }, 60);
		const plain = rows.map(stripAnsi).join("\n");

		expect(plain).toContain("[bash]");
		expect(plain).toContain("> pnpm test");
		expect(plain).toContain("▶");
		expect(rows.join("\n")).toContain("38;2;91;155;213m");
	});

	it("renders compact Ultraviolet tool pills with semantic label, target, and muted roles", () => {
		setActiveTheme("ultraviolet-core");

		const line = renderCompactToolPill({
			name: "read",
			status: "success",
			input: { path: "src/auth/session.ts" },
			details: { lineCount: 184 },
		});

		expect(stripAnsi(line)).toBe("✓ [read]  src/auth/session.ts  · 184 lines  · ctrl+o expand");
		expect(line).toContain(`${rgbAnsi("#B974FF", 38)}[read]`);
		expect(line).toContain(`${rgbAnsi("#DCC7FF", 38)}src/auth/session.ts`);
		expect(line).toContain(`${rgbAnsi("#9B7BBE", 38)}  · `);
		expect(line).not.toContain(rgbAnsi("#100A1D", 48));
	});

	it("renders expanded Ultraviolet read ledgers with violet surface/body roles", () => {
		setActiveTheme("ultraviolet-core");

		const rows = renderToolLedgerRows({
			name: "read",
			status: "success",
			input: { path: "src/auth/session.ts" },
			details: { excerpt: ["export async function getUser() {}"], totalLines: 3 },
		}, 90);
		const raw = rows.join("\n");

		expect(raw).toContain(rgbAnsi("#100A1D", 48));
		expect(raw).toContain(ledgerStyledText("#56347A", "╭─ "));
		expect(raw).toContain(ledgerStyledText("#B974FF", "[read]"));
		expect(raw).toContain(ledgerStyledText("#DCC7FF", "src/auth/session.ts"));
		expect(raw).toContain(ledgerStyledText("#9B7BBE", "   1  "));
		expect(raw).toContain(ledgerStyledText("#DCC7FF", "export async function getUser() {}"));
		expect(raw).toContain(ledgerStyledText("#9B7BBE", "… 2 lines collapsed"));
		expect(rows.every((row) => visibleWidth(row) <= 90)).toBe(true);
	});

	it("renders expanded Ultraviolet edit and bash bodies with semantic roles while preserving state colours", () => {
		setActiveTheme("ultraviolet-core");

		const editRows = renderToolLedgerRows({
			name: "edit",
			status: "success",
			input: { path: "src/auth/session.ts" },
			details: { diff: ["- old session", "+ new session", "  unchanged"], collapsedLines: 2 },
		}, 90).join("\n");
		const bashRows = renderToolLedgerRows({
			name: "bash",
			status: "running",
			input: { command: "pnpm test" },
			output: "✓ one passed\nsummary line",
		}, 80).join("\n");

		expect(editRows).toContain(ledgerStyledText("#DCC7FF", "+1"));
		expect(editRows).toContain(ledgerStyledText("#FF668F", "-1"));
		expect(editRows).toContain(ledgerStyledText("#9B7BBE", "  unchanged"));
		expect(editRows).toContain(ledgerStyledText("#9B7BBE", "… 2 lines collapsed"));
		expect(bashRows).toContain(ledgerStyledText("#DCC7FF", "> pnpm test"));
		expect(bashRows).toContain(ledgerStyledText("#DCC7FF", "✓"));
		expect(bashRows).toContain(ledgerStyledText("#9B7BBE", "summary line"));
		expect(bashRows).toContain(ledgerStyledText("#FFC857", "▶"));
	});
});
