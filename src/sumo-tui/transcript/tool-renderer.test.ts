import { describe, expect, it } from "vitest";
import { stripAnsi } from "../cathedral/ansi.js";
import { renderCompactToolPill, renderToolLedgerRows } from "./tool-renderer.js";

describe("tool renderer", () => {
	it("renders compact Cathedral tool pills", () => {
		const line = renderCompactToolPill({ name: "read", status: "success", input: { path: "src/auth/session.ts" } });

		expect(stripAnsi(line)).toBe("✓ [read]  src/auth/session.ts  · ⌘O expand");
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
			"╭─ [edit]  src/auth/session.ts ────────────────── ✓ +14 -6 session flow updated ",
			"│ +14 -6 session flow updated                                                   ",
			"╰───────────────────────────────────────────────────────────────────────────────",
		]);
		expect(rows.every((row) => stripAnsi(row).length === 80)).toBe(true);
	});

	it("covers compact read/edit/write/bash status variants", () => {
		const cases = [
			[{ name: "read", status: "success", input: { path: "src/auth/session.ts" }, details: { lineCount: 184 } }, "✓ [read]  src/auth/session.ts  · 184 lines  · ⌘O expand"],
			[{ name: "edit", status: "success", input: { path: "src/auth/session.ts" }, output: "+14 -6" }, "✓ [edit]  src/auth/session.ts  · +14 -6  · ⌘O diff"],
			[{ name: "write", status: "success", input: { path: "src/auth/new.ts" }, details: { lineCount: 47 } }, "✓ [write]  src/auth/new.ts  · 47 lines  · ⌘O expand"],
			[{ name: "bash", status: "success", input: { command: "pnpm test" }, details: { summary: "22 tests, 1.2s" } }, "✓ [bash]  pnpm test  · 22 tests, 1.2s  · ⌘O output"],
			[{ name: "bash", status: "error", input: { command: "pnpm test" }, error: "1 failed" }, "✗ [bash]  pnpm test  · 1 failed  · ⌘O error"],
			[{ name: "bash", status: "running", input: { command: "pnpm test" } }, "▶ [bash]  pnpm test  · ⌘O output"],
		] as const;

		for (const [tool, expected] of cases) {
			expect(stripAnsi(renderCompactToolPill(tool))).toBe(expected);
		}
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
		expect(rows.join("\n")).toContain("\u001b[38;2;193;68;62m- old session");
		expect(rows.join("\n")).toContain("\u001b[38;2;127;176;105m+ new session");
	});

	it("uses tool color for running bash rows", () => {
		const rows = renderToolLedgerRows({ name: "bash", status: "running", input: { command: "pnpm test" } }, 60);
		const plain = rows.map(stripAnsi).join("\n");

		expect(plain).toContain("[bash]  pnpm test");
		expect(plain).toContain("▶");
		expect(rows.join("\n")).toContain("\u001b[38;2;91;155;213m▶");
	});
});
