import { describe, expect, it } from "vitest";
import { withCathedralForeground } from "./question-tool.js";

const ANSI_PATTERN = /\[[0-9;]*m/g;
const stripAnsi = (value: string): string => value.replace(ANSI_PATTERN, "");

describe("withCathedralForeground", () => {
	it("re-applies Cathedral foreground after Pi default-fg reset (\\x1b[39m)", () => {
		const line = withCathedralForeground("[32mgreen from Pi[39m trailing");

		// Cathedral fg = 245;230;200
		expect(line.startsWith("[38;2;245;230;200m")).toBe(true);
		// After Pi's `[39m` default-fg reset, re-apply Cathedral fg so
		// trailing content stays inside the palette
		expect(line).toContain("[39m[38;2;245;230;200m");
		// Visible text is unchanged
		expect(stripAnsi(line)).toBe("green from Pi trailing");
	});

	it("re-applies Cathedral foreground after a full reset (\\x1b[0m)", () => {
		const line = withCathedralForeground("[0m[32mgreen[0m plain");

		expect(line).toContain("[0m[38;2;245;230;200m");
		expect(stripAnsi(line)).toBe("green plain");
	});

	it("does not change visible width", () => {
		const input = "     hello world cursor here";
		const wrapped = withCathedralForeground(input);
		expect(stripAnsi(wrapped)).toBe(input);
	});
});
