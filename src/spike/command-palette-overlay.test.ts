import { describe, expect, it } from "vitest";
import { renderCommandPalette } from "./command-palette-overlay.js";

describe("command palette overlay spike", () => {
	it("renders selected row with star marker inside a modal frame", () => {
		const lines = renderCommandPalette([
			{ label: "SESSION", value: "WORK" },
			{ label: "MODEL", value: "OPUS" },
		], 1, 60);
		expect(lines[0]).toMatch(/^╔/);
		expect(lines.join("\n")).toContain("═══ COMMAND PALETTE ═══");
		expect(lines.join("\n")).toContain("★ MODEL");
		expect(lines.at(-1)).toMatch(/^╚/);
	});
});
