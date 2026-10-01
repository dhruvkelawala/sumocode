import { describe, expect, it } from "vitest";
import { SUMOCODE_STATES } from "./tokens.js";
import { VOICE } from "./voice.js";

const REQUIRED_SECTIONS = ["context", "mcp"] as const;

describe("VOICE.status", () => {
	it("has a label for every SumoCodeState", () => {
		for (const state of SUMOCODE_STATES) {
			const label = VOICE.status[state];
			expect(label, `missing status label for state "${state}"`).toBeTypeOf("string");
			expect(label.length).toBeGreaterThan(0);
		}
	});

	it("uses cathedral UPPERCASE labels (locked Q5.5)", () => {
		for (const state of SUMOCODE_STATES) {
			const label = VOICE.status[state];
			expect(label, `"${label}" should be uppercase`).toBe(label.toUpperCase());
			expect(label, `"${label}" must not contain '!'`).not.toContain("!");
			expect(label, `"${label}" must not end with a period`).not.toMatch(/\.$/);
		}
	});

	it("uses the cathedral state vocabulary (READY/MEDITATING/ILLUMINATING/DEFERRING)", () => {
		expect(VOICE.status.idle).toBe("READY");
		expect(VOICE.status.thinking).toBe("MEDITATING");
		expect(VOICE.status.tool).toBe("ILLUMINATING");
		expect(VOICE.status.approval).toBe("DEFERRING");
		expect(SUMOCODE_STATES).toEqual(["idle", "thinking", "tool", "approval"]);
	});
});

describe("VOICE.sections", () => {
	it("declares a label for each sidebar section", () => {
		for (const section of REQUIRED_SECTIONS) {
			const label = VOICE.sections[section];
			expect(label, `missing section label for "${section}"`).toBeTypeOf("string");
			expect(label.length).toBeGreaterThan(0);
			expect(label).toBe(label.toLowerCase());
			expect(label).not.toContain("!");
		}
	});
});
