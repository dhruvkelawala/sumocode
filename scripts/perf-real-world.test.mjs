import { describe, expect, it } from "vitest";
import { publicProbeError, selectReadinessEvent } from "./perf-real-world.mjs";

describe("real-world readiness event selection", () => {
	it("selects the truthful readiness events by occurrence", () => {
		const current = [
			{ event: "editor_ready", ts: 10 },
			{ event: "command_ready", ts: 30 },
			{ event: "editor_ready", ts: 40 },
			{ event: "command_ready", ts: 50 },
		];
		expect(selectReadinessEvent(current, "editor_ready", 1)).toEqual(current[0]);
		expect(selectReadinessEvent(current, "command_ready", 1)).toEqual(current[1]);
		expect(selectReadinessEvent(current, "editor_ready", 2)).toEqual(current[2]);
		expect(selectReadinessEvent(current, "command_ready", 3)).toBeUndefined();
	});

	it("ignores the removed alias events", () => {
		const legacy = [{ event: "input_ready", ts: 11 }, { event: "app_ready", ts: 20 }];
		expect(selectReadinessEvent(legacy, "editor_ready", 1)).toBeUndefined();
		expect(selectReadinessEvent(legacy, "command_ready", 1)).toBeUndefined();
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
