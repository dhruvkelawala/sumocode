import { describe, expect, it } from "vitest";
import { CATHEDRAL_TOKENS } from "../../tokens.js";
import { stripAnsi } from "./ansi.js";
import { renderTokenMeter, tokenMeterColor } from "./sidebar-rendering.js";

function rgb(hex: string): string {
	const normalized = hex.replace("#", "");
	return `${Number.parseInt(normalized.slice(0, 2), 16)};${Number.parseInt(normalized.slice(2, 4), 16)};${Number.parseInt(normalized.slice(4, 6), 16)}`;
}

describe("sidebar token bar", () => {
	it("renders a 10-cell visual bar plus formatted used/total text", () => {
		const meter = renderTokenMeter(60_000, 100_000);
		expect(stripAnsi(meter)).toBe("[██████░░░░] 60k/100k");
	});

	it("uses sage below 50%, amber from 50–80%, accent from 80–100%, and terracotta over budget", () => {
		expect(tokenMeterColor(30, 100)).toBe(CATHEDRAL_TOKENS.colors.states.idle);
		expect(tokenMeterColor(60, 100)).toBe(CATHEDRAL_TOKENS.colors.states.thinking);
		expect(tokenMeterColor(90, 100)).toBe(CATHEDRAL_TOKENS.colors.accent);
		expect(tokenMeterColor(101, 100)).toBe(CATHEDRAL_TOKENS.colors.states.approval);

		expect(renderTokenMeter(30, 100)).toContain(rgb(CATHEDRAL_TOKENS.colors.states.idle));
		expect(renderTokenMeter(60, 100)).toContain(rgb(CATHEDRAL_TOKENS.colors.states.thinking));
		expect(renderTokenMeter(90, 100)).toContain(rgb(CATHEDRAL_TOKENS.colors.accent));
		expect(renderTokenMeter(101, 100)).toContain(rgb(CATHEDRAL_TOKENS.colors.states.approval));
		expect(stripAnsi(renderTokenMeter(101, 100))).toBe("[██████████] 101/100 OVER");
	});
});
