import { describe, expect, it } from "vitest";
import { CATHEDRAL_THEME } from "./cathedral.js";
import { resolveThemeWorkingIndicator } from "./indicator.js";
import type { Theme } from "./types.js";

const enhancedTheme: Theme = {
	...CATHEDRAL_THEME,
	workingIndicator: {
		frames: [".", ":"],
		intervalMs: 120,
		enhanced: {
			name: "runcat",
			frames: ["\uE900", "\uE901"],
			intervalMs: 167,
			capabilityEnv: "SUMOCODE_RUNCAT_FONT",
		},
	},
};

describe("resolveThemeWorkingIndicator", () => {
	it("returns the default variant without capability metadata for themes without enhanced variants", () => {
		const resolved = resolveThemeWorkingIndicator(CATHEDRAL_THEME, { SUMOCODE_RUNCAT_FONT: "1" });

		expect(resolved).toEqual({
			name: "default",
			frames: CATHEDRAL_THEME.workingIndicator.frames,
			intervalMs: CATHEDRAL_THEME.workingIndicator.intervalMs,
			capabilityState: "disabled",
		});
		expect("capabilityEnv" in resolved).toBe(false);
	});

	it("enables the enhanced variant for explicit true-like values", () => {
		for (const value of ["1", "true", "TRUE", "yes", "YES", "on", "ON"]) {
			const resolved = resolveThemeWorkingIndicator(enhancedTheme, { SUMOCODE_RUNCAT_FONT: value });
			expect(resolved.name, value).toBe("runcat");
			expect(resolved.frames, value).toBe(enhancedTheme.workingIndicator.enhanced!.frames);
			expect(resolved.intervalMs, value).toBe(167);
			expect(resolved.capabilityEnv, value).toBe("SUMOCODE_RUNCAT_FONT");
			expect(resolved.capabilityState, value).toBe("enabled");
		}
	});

	it("falls back for unset and explicit false-like values", () => {
		for (const value of [undefined, "", "0", "false", "FALSE", "no", "NO", "off", "OFF"]) {
			const env = value === undefined ? {} : { SUMOCODE_RUNCAT_FONT: value };
			const resolved = resolveThemeWorkingIndicator(enhancedTheme, env);
			expect(resolved.name, String(value)).toBe("default");
			expect(resolved.frames, String(value)).toBe(enhancedTheme.workingIndicator.frames);
			expect(resolved.intervalMs, String(value)).toBe(120);
			expect(resolved.capabilityEnv, String(value)).toBe("SUMOCODE_RUNCAT_FONT");
			expect(resolved.capabilityState, String(value)).toBe("disabled");
		}
	});

	it("reports unrecognized non-empty values without failing startup", () => {
		const resolved = resolveThemeWorkingIndicator(enhancedTheme, { SUMOCODE_RUNCAT_FONT: "maybe" });

		expect(resolved.name).toBe("default");
		expect(resolved.frames).toBe(enhancedTheme.workingIndicator.frames);
		expect(resolved.capabilityEnv).toBe("SUMOCODE_RUNCAT_FONT");
		expect(resolved.capabilityState).toBe("unrecognized");
	});

	it("does not mutate env or theme objects", () => {
		const env = { SUMOCODE_RUNCAT_FONT: "1" };
		const beforeTheme = JSON.stringify(enhancedTheme);

		resolveThemeWorkingIndicator(enhancedTheme, env);

		expect(env).toEqual({ SUMOCODE_RUNCAT_FONT: "1" });
		expect(JSON.stringify(enhancedTheme)).toBe(beforeTheme);
	});
});
