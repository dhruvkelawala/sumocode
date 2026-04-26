import { describe, expect, it } from "vitest";
import { renderCathedralCodeBlock } from "./codeblock-message-renderer.js";

describe("code block message renderer spike", () => {
	it("renders language header and line numbers", () => {
		const lines = renderCathedralCodeBlock({ language: "typescript", code: "const ok = true;\nreturn ok;" }, 50);
		expect(lines[0]).toContain("┌ typescript");
		expect(lines[1]).toContain("1   const ok = true;");
		expect(lines[2]).toContain("2   return ok;");
	});
});
