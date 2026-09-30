import { describe, expect, it } from "vitest";
import { parseTaskTitle, taskPromptText } from "./session-task-name.js";

describe("taskPromptText", () => {
	it("collapses expanded skill blocks to their name", () => {
		expect(taskPromptText('<skill name="eli25" location="/x/SKILL.md">\nlong body\n</skill>\n\nfor #486')).toBe("/eli25\n\nfor #486");
	});
});

describe("parseTaskTitle", () => {
	it("keeps a clean short label", () => {
		expect(parseTaskTitle("v0.8 consumer fix")).toBe("v0.8 consumer fix");
	});

	it("strips quotes, trailing punctuation, and extra lines", () => {
		expect(parseTaskTitle('"Herdr task naming."\nbecause the prompt asks')).toBe("Herdr task naming");
	});

	it("caps words and length at a word boundary", () => {
		expect(parseTaskTitle("one two three four five")).toBe("one two three four");
		expect(parseTaskTitle("extraordinarily-long-identifier another-long-word")).toBe("extraordinarily-long-identifier");
	});

	it("rejects empty replies", () => {
		expect(parseTaskTitle("  \n")).toBeUndefined();
	});
});
