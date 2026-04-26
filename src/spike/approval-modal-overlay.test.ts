import { describe, expect, it } from "vitest";
import { renderApprovalModal } from "./approval-modal-overlay.js";

describe("approval modal overlay spike", () => {
	it("renders a framed approval prompt for a command", () => {
		const lines = renderApprovalModal("rm -rf node_modules/", 70);
		const text = lines.join("\n");
		expect(lines[0]).toMatch(/^╔/);
		expect(text).toContain("◆ APPROVAL REQUIRED");
		expect(text).toContain("rm -rf node_modules/");
		expect(text).toContain("Proceed? [Y/n]");
	});
});
