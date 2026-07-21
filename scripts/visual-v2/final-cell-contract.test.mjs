import { describe, expect, it } from "vitest";
import { evaluateFinalCellAssertions, finalCellContractToText, validateFinalCellAssertions } from "./final-cell-contract.mjs";

function snapshot() {
	const row = Array.from({ length: 12 }, () => ({ char: " ", width: 1, fg: "#dcc7ff" }));
	row[1] = { char: "", width: 1, fg: "#B974FF" };
	row[2] = { char: " ", width: 1, fg: "#dcc7ff" };
	for (const [offset, char] of [..."Working…"].entries()) row[3 + offset] = { char, width: 1, fg: "#9b7bbe" };
	return { rows: 1, cols: 12, cells: [row] };
}

describe("validateFinalCellAssertions", () => {
	it("accepts exact text, regex char, width, and foreground assertions", () => {
		expect(() => validateFinalCellAssertions({ id: "ok", finalCellAssertions: [{ row: 0, col: 1, charPattern: "[\\uE900-\\uE904]", width: 1, fg: "#B974FF" }, { row: 0, col: 3, text: "Working…" }] })).not.toThrow();
	});

	it("rejects malformed assertions", () => {
		expect(() => validateFinalCellAssertions({ id: "bad", finalCellAssertions: [{ row: -1, col: 0 }] })).toThrow(/row/);
		expect(() => validateFinalCellAssertions({ id: "bad", finalCellAssertions: [{ row: 0, col: 0, charPattern: "[" }] })).toThrow(/invalid/);
		expect(() => validateFinalCellAssertions({ id: "bad", finalCellAssertions: [{ row: 0, col: 0, fg: "violet" }] })).toThrow(/fg/);
	});

	it("rejects coordinates outside declared scenario dimensions", () => {
		const dimensions = { rows: 2, cols: 3 };
		expect(() => validateFinalCellAssertions({ id: "bad-row", dimensions, finalCellAssertions: [{ row: 2, col: 0, text: "x" }] })).toThrow(/row.*dimensions\.rows/);
		expect(() => validateFinalCellAssertions({ id: "bad-col", dimensions, finalCellAssertions: [{ row: 0, col: 3, text: "x" }] })).toThrow(/col.*dimensions\.cols/);
	});
});

describe("evaluateFinalCellAssertions", () => {
	it("passes matching assertions with normalized foreground", () => {
		const result = evaluateFinalCellAssertions(snapshot(), [
			{ row: 0, col: 1, charPattern: "[\\uE900-\\uE904]", width: 1, fg: "#b974ff" },
			{ row: 0, col: 2, text: " " },
			{ row: 0, col: 3, text: "Working…" },
		]);

		expect(result).toMatchObject({ passed: true, count: 3, mismatches: [] });
		expect(finalCellContractToText(result)).toContain("PASS (3 assertion(s))");
	});

	it("reports out-of-bounds and multiple mismatch reasons", () => {
		const result = evaluateFinalCellAssertions(snapshot(), [
			{ row: 99, col: 1, text: "x" },
			{ row: 0, col: 1, charPattern: "[.:oO@]", width: 2, fg: "#ffffff" },
		]);

		expect(result.passed).toBe(false);
		expect(result.mismatches.map((m) => m.reason)).toEqual(["out-of-bounds", "charPattern", "width", "fg"]);
		expect(finalCellContractToText(result)).toContain("FAIL (4 mismatch(es))");
	});
});
