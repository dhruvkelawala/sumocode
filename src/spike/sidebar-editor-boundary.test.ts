import { describe, expect, it } from "vitest";
import { renderEditorOwnedSideBand } from "./sidebar-editor-boundary.js";

describe("editor-boundary sidebar spike", () => {
	it("can draw a side band only on editor-owned rows", () => {
		const lines = renderEditorOwnedSideBand("hello", 130);
		expect(lines).toHaveLength(3);
		expect(lines[0]).toContain("REGISTRY");
		expect(lines[1]).toContain("> hello█");
		expect(lines.every((line) => line.length === 130)).toBe(true);
	});
});
