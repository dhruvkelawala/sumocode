import { describe, expect, it } from "vitest";
import { evaluateNativeGate, nativeCompareOptions } from "./perf-native-compare.mjs";

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

	it("requires 250ms editor improvement, no command regression, and zero failures", () => {
		expect(evaluateNativeGate(report()).verdict).toBe("improved");
		expect(evaluateNativeGate(report({ editorImprovement: 249 })).verdict).toBe("failed");
		expect(evaluateNativeGate(report({ commandRegression: 1 })).verdict).toBe("failed");
		expect(evaluateNativeGate(report({ failures: 1 })).verdict).toBe("failed");
	});
});
