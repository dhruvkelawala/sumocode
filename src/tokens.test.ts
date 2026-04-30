import { describe, expect, it } from "vitest";
import { CATHEDRAL_TOKENS } from "./tokens.js";

describe("CATHEDRAL_TOKENS", () => {
	it("uses the V2 warmer lifted surface token", () => {
		expect(CATHEDRAL_TOKENS.colors.surfaceLifted).toBe("#3D3024");
	});
});
