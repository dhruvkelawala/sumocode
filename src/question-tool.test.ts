import { describe, expect, it } from "vitest";
import { padQuestionModalLine } from "./question-tool.js";

const ANSI_PATTERN = /\u001b\[[0-9;]*m/g;
const stripAnsi = (value: string): string => value.replace(ANSI_PATTERN, "");

describe("padQuestionModalLine", () => {
	it("keeps edit-mode rows bounded to the modal width", () => {
		const line = padQuestionModalLine("     Your answer: this row is deliberately too long for the modal", 32);

		expect(stripAnsi(line)).toHaveLength(32);
	});

	it("restores Cathedral foreground and lifted background after nested resets", () => {
		const line = padQuestionModalLine("     \u001b[32mgreen from Pi\u001b[0m cursor", 40);

		expect(line).toContain("\u001b[38;2;245;230;200m");
		expect(line).toContain("\u001b[48;2;61;48;36m");
		expect(line).toContain("\u001b[0m\u001b[38;2;245;230;200m\u001b[48;2;61;48;36m");
		expect(stripAnsi(line)).toHaveLength(40);
	});
});
