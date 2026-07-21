import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { loadScenarioRegistry } from "./scenario-registry.mjs";

async function writeManifestWithFinalCellAssertion(assertion) {
	const dir = await mkdtemp(join(tmpdir(), "sumocode-scenario-registry-"));
	const manifestPath = join(dir, "scenarios.json");
	const manifest = {
		version: 1,
		crops: {
			full: { kind: "full" },
		},
		scenarios: [
			{
				id: "bounds-proof",
				lane: "runtime",
				status: "review",
				bibleTarget: "target.png",
				dimensions: { cols: 3, rows: 2 },
				finalCellAssertions: [assertion],
				crops: [{ id: "full" }],
			},
		],
	};
	await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, "utf8");
	return {
		manifestPath,
		cleanup: () => rm(dir, { recursive: true, force: true }),
	};
}

describe("loadScenarioRegistry final cell assertion validation", () => {
	it("rejects a final-cell assertion at scenario.dimensions.rows during manifest loading", async () => {
		const { manifestPath, cleanup } = await writeManifestWithFinalCellAssertion({ row: 2, col: 0, text: "x" });
		try {
			expect(() => loadScenarioRegistry({ manifestPath })).toThrow(/row.*dimensions\.rows/);
		} finally {
			await cleanup();
		}
	});

	it("rejects a final-cell assertion at scenario.dimensions.cols during manifest loading", async () => {
		const { manifestPath, cleanup } = await writeManifestWithFinalCellAssertion({ row: 0, col: 3, text: "x" });
		try {
			expect(() => loadScenarioRegistry({ manifestPath })).toThrow(/col.*dimensions\.cols/);
		} finally {
			await cleanup();
		}
	});
});
