import { describe, expect, it } from "vitest";
import { CATHEDRAL_TOKENS } from "../../tokens.js";
import { stripAnsi } from "./ansi.js";
import { mcpStatusColor, renderMcpServerRow } from "./sidebar-rendering.js";

function rgb(hex: string): string {
	const normalized = hex.replace("#", "");
	return `${Number.parseInt(normalized.slice(0, 2), 16)};${Number.parseInt(normalized.slice(2, 4), 16)};${Number.parseInt(normalized.slice(4, 6), 16)}`;
}

describe("sidebar MCP state pills", () => {
	it("maps status dots to UX_SPEC §4.2 colors", () => {
		expect(mcpStatusColor("ok")).toBe(CATHEDRAL_TOKENS.colors.states.idle);
		expect(mcpStatusColor("idle")).toBe(CATHEDRAL_TOKENS.colors.foregroundDim);
		expect(mcpStatusColor("in-flight")).toBe(CATHEDRAL_TOKENS.colors.states.thinking);
		expect(mcpStatusColor("error")).toBe(CATHEDRAL_TOKENS.colors.states.approval);
		expect(mcpStatusColor("down")).toBe(CATHEDRAL_TOKENS.colors.states.approval);
	});

	it("renders a colored ●, foreground server name, and right-aligned status", () => {
		const row = renderMcpServerRow({ name: "chrome-dev", status: "in-flight" }, 30);
		const plain = stripAnsi(row);

		expect(plain).toContain("● chrome-dev");
		expect(plain).toMatch(/in-flight\s*$/);
		expect(row).toContain(rgb(CATHEDRAL_TOKENS.colors.states.thinking));
	});
});
