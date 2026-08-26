import { describe, expect, it } from "vitest";
import { detectTerminalHost } from "./detect.js";

describe("detectTerminalHost", () => {
	it("detects herdr before cmux", () => {
		// SAFETY: partial env objects are valid ProcessEnv for detection purposes.
		expect(detectTerminalHost({ HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", CMUX_SURFACE_ID: "surface:1" } as NodeJS.ProcessEnv)).toBe("herdr");
	});
	it("detects cmux", () => {
		// SAFETY: partial env objects are valid ProcessEnv for detection purposes.
		expect(detectTerminalHost({ CMUX_WORKSPACE_ID: "workspace:1" } as NodeJS.ProcessEnv)).toBe("cmux");
	});
	it("detects none", () => {
		// SAFETY: partial env objects are valid ProcessEnv for detection purposes.
		expect(detectTerminalHost({} as NodeJS.ProcessEnv)).toBe("none");
	});
});
