import { describe, expect, it } from "vitest";
import { detectTerminalHost } from "./detect.js";

describe("detectTerminalHost", () => {
	it("detects herdr before cmux", () => {
		expect(detectTerminalHost({ HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", CMUX_SURFACE_ID: "surface:1" } as NodeJS.ProcessEnv)).toBe("herdr");
	});
	it("detects cmux", () => {
		expect(detectTerminalHost({ CMUX_WORKSPACE_ID: "workspace:1" } as NodeJS.ProcessEnv)).toBe("cmux");
	});
	it("detects none", () => {
		expect(detectTerminalHost({} as NodeJS.ProcessEnv)).toBe("none");
	});
});
