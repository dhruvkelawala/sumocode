import { describe, expect, it } from "vitest";
import { renderSidebar, type SidebarSnapshot } from "./sidebar.js";

const ANSI = /\u001b\[[0-9;]*m/g;
const stripAnsi = (s: string): string => s.replace(ANSI, "");

function snapshot(overrides: Partial<SidebarSnapshot> = {}): SidebarSnapshot {
	return {
		projectName: "argent-x",
		inputTokens: 12_000,
		outputTokens: 8_000,
		contextWindow: 200_000,
		costUsd: 0.42,
		mcpServers: [
			{ name: "github", status: "idle" },
			{ name: "stitch", status: "tool" },
		],
		memory: [
			"prefers pnpm",
			"never autoformat go",
			"writes commits in cathedral voice",
		],
		...overrides,
	};
}

describe("renderSidebar — context section", () => {
	it("shows the project name, a token gauge, and cost in a context block", () => {
		const lines = renderSidebar(snapshot(), 32).map(stripAnsi);
		const blob = lines.join("\n");

		expect(blob).toContain("CONTEXT");
		expect(blob).toContain("argent-x");
		expect(blob).toContain("20k/200k"); // 12k input + 8k output of 200k
		expect(blob).toContain("$0.42");
	});
});

describe("renderSidebar — mcp section", () => {
	it("lists each MCP server with a colored status dot", () => {
		const rendered = renderSidebar(snapshot(), 32);
		const blob = rendered.map(stripAnsi).join("\n");

		expect(blob).toContain("MCP");
		expect(blob).toContain("github");
		expect(blob).toContain("stitch");

		// Each MCP line carries a state-colored dot. The status row for github (idle)
		// must include the green idle hex; stitch (tool) must include the blue tool hex.
		const githubRow = rendered.find((line) => line.includes("github"));
		const stitchRow = rendered.find((line) => line.includes("stitch"));

		expect(githubRow).toBeDefined();
		expect(stitchRow).toBeDefined();
		expect(githubRow).toContain("127;176;105"); // #7FB069 idle (green)
		expect(stitchRow).toContain("91;155;213"); // #5B9BD5 tool (blue)
	});
});

describe("renderSidebar — memory section", () => {
	it("renders each memory item with a ❧ bullet", () => {
		const lines = renderSidebar(snapshot(), 32);
		const memoryLines = lines.map(stripAnsi).filter((l) => l.startsWith("❧"));

		expect(memoryLines.length).toBe(3);
		expect(memoryLines[0]).toContain("prefers pnpm");
		expect(memoryLines[1]).toContain("never autoformat go");
	});

	it("caps display at the first 5 memory items even if more are supplied", () => {
		const many = snapshot({
			memory: ["a", "b", "c", "d", "e", "f", "g"],
		});
		const lines = renderSidebar(many, 32);
		const memoryLines = lines.map(stripAnsi).filter((l) => l.startsWith("❧"));

		expect(memoryLines.length).toBe(5);
		expect(memoryLines[4]).toContain("e");
		expect(memoryLines.some((l) => l.includes("f"))).toBe(false);
	});
});
