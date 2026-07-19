import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { writeReviewPack } from "./review-pack.mjs";

describe("writeReviewPack final-cell evidence", () => {
	it("renders pass/fail state, mismatch details, and artifact links", () => {
		const pack = writeReviewPack({
			version: 1,
			mode: "review",
			commit: "test",
			generatedAt: "2026-07-19T00:00:00.000Z",
			scenarios: [{
				id: "runcat",
				lane: "runtime",
				status: "review",
				result: "failed",
				crops: [],
				artifacts: {},
				finalCellContract: {
					passed: false,
					count: 1,
					mismatchCount: 1,
					artifact: "docs/visual/out/parity/runcat/raw/final-cell-contract.txt",
					mismatches: [{ index: 0, row: 36, col: 1, reason: "charPattern", expected: "[\\uE900-\\uE904]", actual: "." }],
				},
			}],
		});
		const html = readFileSync(pack.indexPath, "utf8");
		expect(html).toContain("Final-cell contract failed");
		expect(html).toContain("checked 1");
		expect(html).toContain("charPattern expected");
		expect(html).toContain("final-cell-contract.txt");
	});
});
