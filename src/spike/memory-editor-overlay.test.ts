import { describe, expect, it } from "vitest";
import { renderMemoryEditor } from "./memory-editor-overlay.js";

describe("memory editor overlay spike", () => {
	it("renders the four memory panels with a learning indicator", () => {
		const lines = renderMemoryEditor({
			user: "You",
			org: "BigCo",
			preferences: ["TypeScript", "pnpm"],
			stack: ["React", "Vite"],
			projects: ["sumocode [active]"],
			learning: true,
		}, 90);
		const text = lines.join("\n");
		expect(text).toContain("CATHEDRAL-MEMORY-EDITOR  ◆ learning");
		expect(text).toContain("IDENTITY");
		expect(text).toContain("PREFERENCES");
		expect(text).toContain("STACK");
		expect(text).toContain("PROJECTS");
	});
});
