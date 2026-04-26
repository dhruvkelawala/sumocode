import { describe, expect, it } from "vitest";
import { renderToolPill } from "./tool-pill-renderer.js";

describe("tool pill renderer spike", () => {
	it("renders a chapter-like tool row with running status", () => {
		const lines = renderToolPill({ name: "bash", target: "pnpm test", status: "running", body: "✓ one\n✗ two" }, 72);
		expect(lines[0]).toContain("━━━ [bash]  pnpm test");
		expect(lines[0]).toContain("▶ running");
		expect(lines[1]).toContain("✓ one");
	});
});
