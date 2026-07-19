import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { outDir } from "./paths.mjs";
import { writeReviewPack } from "./review-pack.mjs";

const canonicalResultsPath = join(outDir, "results.json");
const finalCellArtifactPath = join(outDir, "runcat", "raw", "final-cell-contract.txt");

function canonicalResultsSnapshot() {
	return existsSync(canonicalResultsPath) ? readFileSync(canonicalResultsPath, "utf8") : null;
}

function expectedHrefFrom(outputDir, path) {
	return encodeURI(relative(outputDir, path).split("/").map(encodeURIComponent).join("/"));
}

function failedFinalCellResults() {
	return {
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
				artifact: finalCellArtifactPath,
				mismatches: [{ index: 0, row: 36, col: 1, reason: "charPattern", expected: "[\\uE900-\\uE904]", actual: "." }],
			},
		}],
	};
}

describe("writeReviewPack final-cell evidence", () => {
	it("renders pass/fail state, mismatch details, and artifact links", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "sumocode-review-pack-"));
		try {
			const pack = writeReviewPack(failedFinalCellResults(), { outputDir: tempDir });
			const html = readFileSync(pack.indexPath, "utf8");
			expect(html).toContain("Final-cell contract failed");
			expect(html).toContain("checked 1");
			expect(html).toContain("charPattern expected");
			expect(html).toContain("final-cell-contract.txt");
			const href = html.match(/<a href="([^"]+)">final-cell-contract\.txt<\/a>/)?.[1];
			expect(href).toBe(expectedHrefFrom(tempDir, finalCellArtifactPath));
			expect(href).not.toBe("runcat/raw/final-cell-contract.txt");
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("does not overwrite canonical visual results when an output directory is injected", () => {
		const before = canonicalResultsSnapshot();
		const tempDir = mkdtempSync(join(tmpdir(), "sumocode-review-pack-"));
		try {
			const pack = writeReviewPack(failedFinalCellResults(), { outputDir: tempDir });
			expect(pack.resultsPath).toBe(join(tempDir, "results.json"));
			expect(readFileSync(pack.resultsPath, "utf8")).toContain('"result": "failed"');
			expect(canonicalResultsSnapshot()).toBe(before);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
});
