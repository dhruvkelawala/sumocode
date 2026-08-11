import { describe, expect, it } from "vitest";
import { publicProbeError } from "./perf-real-world.mjs";

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
