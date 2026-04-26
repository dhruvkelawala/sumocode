import { describe, expect, it } from "vitest";
import { renderHeaderDominatedWorkspace } from "./sidebar-custom-header.js";

describe("custom-header sidebar spike", () => {
	it("reserves a right registry band inside the header lines", () => {
		const lines = renderHeaderDominatedWorkspace({ quote: "quote", registryLines: ["REGISTRY", "v 1.0.0"] }, 130, 4);
		expect(lines).toHaveLength(4);
		expect(lines[0]).toMatch(/REGISTRY\s*$/);
		expect(lines.every((line) => line.length === 130)).toBe(true);
	});
});
