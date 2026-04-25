import { describe, expect, it } from "vitest";
import { SUMOCODE_STATES } from "./tokens.js";
import { VOICE } from "./voice.js";

describe("VOICE.status", () => {
	it("has a label for every SumoCodeState", () => {
		for (const state of SUMOCODE_STATES) {
			const label = VOICE.status[state];
			expect(label, `missing status label for state "${state}"`).toBeTypeOf("string");
			expect(label.length).toBeGreaterThan(0);
		}
	});

	it("uses lowercase, no exclamation marks, no trailing punctuation", () => {
		for (const state of SUMOCODE_STATES) {
			const label = VOICE.status[state];
			expect(label, `"${label}" should be lowercase`).toBe(label.toLowerCase());
			expect(label, `"${label}" must not contain '!'`).not.toContain("!");
			expect(label, `"${label}" must not end with a period`).not.toMatch(/\.$/);
		}
	});
});
