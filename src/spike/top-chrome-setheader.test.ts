import { describe, expect, it } from "vitest";
import { renderTopChrome } from "./top-chrome-setheader.js";

describe("top chrome setHeader spike", () => {
	it("renders brand, tabs, and an underline under the active tab", () => {
		const [line, underline] = renderTopChrome({ activeTab: "SCRIPTOR" }, 88);
		expect(line).toContain("SUMOCODE");
		expect(line).toContain("SCRIPTOR");
		expect(underline.indexOf("───────")).toBe(line.indexOf("SCRIPTOR"));
	});

	it("drops rightmost tabs before overflowing", () => {
		const [line] = renderTopChrome({ activeTab: "EDITOR" }, 30);
		expect(line.length).toBe(30);
		expect(line).toContain("EDITOR");
		expect(line).not.toContain("SETTINGS");
	});
});
