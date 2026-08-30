import { describe, expect, it } from "vitest";
import { classifyRpcProbeLine, readinessTimeline, summariseMeasurement } from "./perf-startup.mjs";

describe("startup RPC readiness classification", () => {
	it("accepts only a successful matching get_state response", () => {
		expect(classifyRpcProbeLine('{"type":"response","id":"probe-1","command":"get_state","success":true}')).toBe("success");
		expect(classifyRpcProbeLine('{"type":"response","id":"probe-1","command":"get_state","success":false}')).toBe("failure");
		expect(classifyRpcProbeLine('{"type":"event","id":"probe-1","success":true}')).toBeUndefined();
		expect(classifyRpcProbeLine('{"type":"response","id":"other","command":"get_state","success":true}')).toBeUndefined();
		expect(classifyRpcProbeLine("not json")).toBeUndefined();
	});
});

describe("startup readiness timeline", () => {
	it("measures editor readiness, command readiness, and their gap from the new events", () => {
		expect(readinessTimeline([
			{ event: "editor_ready", ts: 110 },
			{ event: "input_ready", ts: 111 },
			{ event: "app_ready", ts: 200 },
			{ event: "command_ready", ts: 260 },
		], 100)).toEqual({ editorReadyMs: 10, commandReadyMs: 160, editorToCommandGapMs: 150 });
	});

	it("uses the one-release aliases only for an old event stream", () => {
		expect(readinessTimeline([
			{ event: "input_ready", ts: 115 },
			{ event: "app_ready", ts: 225 },
		], 100)).toEqual({ editorReadyMs: 15, commandReadyMs: 125, editorToCommandGapMs: 110 });
		expect(readinessTimeline([
			{ event: "editor_ready", ts: 115 },
			{ event: "app_ready", ts: 225 },
		], 100)).toEqual({ editorReadyMs: 15, commandReadyMs: undefined, editorToCommandGapMs: undefined });
	});
});

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
			error: "spawn /Users/private/project/pi ENOENT",
			stderr: "private stderr",
			output: "private PTY output",
		}]);

		expect(report.samples).toEqual([{ ok: false, durationMs: 12, code: 1, error: "process failed" }]);
	});
});
