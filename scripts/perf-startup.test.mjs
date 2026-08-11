import { describe, expect, it } from "vitest";
import { summariseMeasurement } from "./perf-startup.mjs";

describe("startup perf report sanitization", () => {
	it("removes captured process and terminal diagnostics from successful samples", () => {
		const report = summariseMeasurement("probe", [{
			ok: true,
			durationMs: 12,
			stderr: 'Warning: model pattern "private/model"',
			stdout: "private extension output",
			output: "private PTY output",
			diagEvents: [{ project: "/private/project" }],
		}]);

		expect(report.samples).toEqual([{ ok: true, durationMs: 12 }]);
	});

	it("removes captured diagnostics and keeps structured failure status", () => {
		const report = summariseMeasurement("probe", [{
			ok: false,
			durationMs: 12,
			code: 1,
			stderr: "private stderr",
			output: "private PTY output",
		}]);

		expect(report.samples).toEqual([{ ok: false, durationMs: 12, code: 1, error: "process failed" }]);
	});
});
