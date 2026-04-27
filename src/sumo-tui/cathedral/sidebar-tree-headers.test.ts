import { describe, expect, it } from "vitest";
import { stripAnsi } from "./ansi.js";
import { renderRegistrySidebarLines, type RegistrySidebarSnapshot } from "./sidebar-rendering.js";

function snapshot(overrides: Partial<RegistrySidebarSnapshot> = {}): RegistrySidebarSnapshot {
	return {
		projectName: "argent-x",
		branch: "main",
		inputTokens: 12_000,
		outputTokens: 30_000,
		contextWindow: 200_000,
		costUsd: 0.42,
		mcpServers: [{ name: "stitch", status: "ok" }],
		memory: ["prefers TypeScript strict"],
		metrics: {
			cpuPercent: 1,
			memoryMiB: 128,
			fps: 0,
			cpuHistory: [1],
			memoryHistory: [128],
			fpsHistory: [0],
		},
		...overrides,
	};
}

describe("sidebar-tree headers", () => {
	it("uses UX_SPEC §4.2 `┌ LABEL ────` headers for all issue #56 panels", () => {
		const plain = renderRegistrySidebarLines(snapshot(), 49).map(stripAnsi).join("\n");

		expect(plain).toContain("┌ ACTIVE_CONTEXT ─");
		expect(plain).toContain("┌ MCP ─");
		expect(plain).toContain("┌ ACTIVE_MEMORY ─");
		expect(plain).toContain("┌ METRICS ─");
		expect(plain).not.toContain("─── CONTEXT ───");
	});
});
