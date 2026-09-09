import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { evaluateNativeGate, nativeCompareOptions, runNativeComparison } from "./perf-native-compare.mjs";

function report({ editorImprovement = 260, commandRegression = 0, failures = 0 } = {}) {
	const baselineCommand = 800;
	const baselineEditor = 820;
	return {
		arms: {
			"dev-source": { failures, commandReady: { medianMs: 1500 }, editorReady: { medianMs: 1400 } },
			"node-bundle": { failures: 0, commandReady: { medianMs: baselineCommand }, editorReady: { medianMs: baselineEditor } },
			native: {
				failures: 0,
				commandReady: { medianMs: baselineCommand + commandRegression },
				editorReady: { medianMs: baselineEditor - editorImprovement },
			},
		},
	};
}

describe("native perf comparison", () => {
	it("parses fixture zero and sample count", () => {
		expect(nativeCompareOptions(["--samples", "15", "--fixture-count", "0"])).toMatchObject({ samples: 15, fixtureCount: 0 });
		expect(() => nativeCompareOptions(["--samples", "0"])).toThrow(/positive integer/);
	});

	it("refuses to overwrite caller report artifacts", async () => {
		const root = await mkdtemp(join(tmpdir(), "sumocode-native-perf-test-"));
		try {
			for (const name of ["results.json", "report.md"]) {
				const outDir = join(root, name.replace(".", "-"));
				await mkdir(outDir);
				const artifact = join(outDir, name);
				await writeFile(artifact, "caller-owned");
				await expect(runNativeComparison({ outDir, fixtureCount: 0 })).rejects.toThrow(`already contains ${name}`);
				expect(await readFile(artifact, "utf8")).toBe("caller-owned");
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("requires 250ms editor improvement, no command regression, and zero failures", () => {
		expect(evaluateNativeGate(report()).verdict).toBe("improved");
		expect(evaluateNativeGate(report({ editorImprovement: 249 })).verdict).toBe("failed");
		expect(evaluateNativeGate(report({ commandRegression: 1 })).verdict).toBe("failed");
		expect(evaluateNativeGate(report({ failures: 1 })).verdict).toBe("failed");
	});
});
