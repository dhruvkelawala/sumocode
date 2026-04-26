import { describe, expect, it } from "vitest";
import { renderRegistrySidebar } from "./sidebar-overlay-noncapturing.js";

describe("non-capturing overlay sidebar spike", () => {
	it("renders registry tabs with one active marker", () => {
		const lines = renderRegistrySidebar({ active: "MEMORY", version: "1.0.0", facts: ["strict TS"] }, 49);
		expect(lines.join("\n")).toContain("◆ MEMORY");
		expect(lines.join("\n")).toContain("▢ CONTEXT");
		expect(lines.every((line) => line.length === 49)).toBe(true);
	});
});
