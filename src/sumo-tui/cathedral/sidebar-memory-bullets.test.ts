import { describe, expect, it } from "vitest";
import { CATHEDRAL_TOKENS } from "../../tokens.js";
import { stripAnsi } from "./ansi.js";
import { renderRegistrySidebarLines, renderMemoryFactLine, type RegistrySidebarSnapshot } from "./sidebar-rendering.js";

function rgb(hex: string): string {
	const normalized = hex.replace("#", "");
	return `${Number.parseInt(normalized.slice(0, 2), 16)};${Number.parseInt(normalized.slice(2, 4), 16)};${Number.parseInt(normalized.slice(4, 6), 16)}`;
}

function snapshot(): RegistrySidebarSnapshot {
	return {
		projectName: "argent-x",
		branch: "main",
		inputTokens: 0,
		outputTokens: 0,
		contextWindow: 200_000,
		costUsd: 0,
		mcpServers: [],
		activeSubTab: "MEMORY",
		memory: [
			"prefers TypeScript strict",
			"pnpm not npm",
			"based in London",
			"uses cmux",
			"visual verification before done",
			"hidden sixth fact",
		],
		memoryTotal: 53,
	};
}

describe("sidebar memory bullets", () => {
	it("renders MEMORY facts with an accented ❧ bullet", () => {
		const line = renderMemoryFactLine("prefers TypeScript strict", 30);
		expect(stripAnsi(line).trim()).toBe("❧ prefers TypeScript strict");
		expect(line).toContain(rgb(CATHEDRAL_TOKENS.colors.accent));
	});

	it("caps visible facts at 5 and renders a dim overflow marker", () => {
		const rendered = renderRegistrySidebarLines(snapshot(), 30);
		const plain = rendered.map(stripAnsi);
		const factRows = plain.filter((line) => /^\s*❧/.test(line));
		const overflow = rendered.find((line) => stripAnsi(line).includes("48 more · ⌘M"));

		expect(factRows).toHaveLength(5);
		expect(plain.join("\n")).not.toContain("hidden sixth fact");
		expect(overflow).toBeDefined();
		expect(overflow).toContain(rgb(CATHEDRAL_TOKENS.colors.foregroundDim));
	});
});
