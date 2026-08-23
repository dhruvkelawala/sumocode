import { describe, expect, it } from "vitest";
import { detectTerminalHost } from "./detect.js";

describe("detectTerminalHost", () => {
	it("detects herdr", () => {
		// SAFETY: partial env objects are valid ProcessEnv for detection purposes.
		expect(detectTerminalHost({ HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1" } as NodeJS.ProcessEnv)).toBe("herdr");
	});

	it("requires both herdr environment markers", () => {
		expect(detectTerminalHost({ HERDR_ENV: "1" } as NodeJS.ProcessEnv)).toBe("none");
		expect(detectTerminalHost({ HERDR_PANE_ID: "w1:p1" } as NodeJS.ProcessEnv)).toBe("none");
	});

	it("detects none", () => {
		// SAFETY: partial env objects are valid ProcessEnv for detection purposes.
		expect(detectTerminalHost({} as NodeJS.ProcessEnv)).toBe("none");
	});
});
