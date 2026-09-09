import { describe, expect, it } from "vitest";
import { publicProbeError, selectReadinessEvent } from "./perf-real-world.mjs";

describe("real-world readiness event selection", () => {
	it("prefers truthful readiness events and uses aliases only for old streams", () => {
		const current = [
			{ event: "editor_ready", ts: 10 },
			{ event: "input_ready", ts: 11 },
			{ event: "app_ready", ts: 20 },
			{ event: "command_ready", ts: 30 },
		];
		expect(selectReadinessEvent(current, "editor_ready", "input_ready", 1)).toEqual(current[0]);
		expect(selectReadinessEvent(current, "command_ready", "app_ready", 1)).toEqual(current[3]);
		expect(selectReadinessEvent(current.slice(0, 3), "command_ready", "app_ready", 1)).toBeUndefined();

		const legacy = [{ event: "input_ready", ts: 11 }, { event: "app_ready", ts: 20 }];
		expect(selectReadinessEvent(legacy, "editor_ready", "input_ready", 1)).toEqual(legacy[0]);
		expect(selectReadinessEvent(legacy, "command_ready", "app_ready", 1)).toEqual(legacy[1]);
	});
});

describe("real-world perf report sanitization", () => {
	it("never exposes Herdr stderr through a command error message", () => {
		const error = new Error('Command failed: private provider token="secret"');
		error.stderr = Buffer.from("private extension output");
		expect(publicProbeError(error)).toBe("probe command failed");
	});

	it("retains only the safe timeout category", () => {
		const error = new Error("timed out with private event payload");
		error.code = "diag-timeout";
		expect(publicProbeError(error)).toBe("diagnostic event timeout");
	});
});
