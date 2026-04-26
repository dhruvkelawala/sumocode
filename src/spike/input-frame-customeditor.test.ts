import { describe, expect, it } from "vitest";
import { renderCarvedInputFrame } from "./input-frame-customeditor.js";

describe("carved input CustomEditor spike", () => {
	it("renders the input as a three-row ASCII frame", () => {
		const lines = renderCarvedInputFrame("review files", 30);
		expect(lines).toEqual([
			"┌────────────────────────────┐",
			"│> review files█             │",
			"└────────────────────────────┘",
		]);
	});
});
