import { describe, expect, it } from "vitest";
import { stripAnsi } from "./ansi.js";
import { renderRegistrySidebarLines, type RegistrySidebarSnapshot } from "./sidebar-rendering.js";

const untrack = (s: string): string => s.replace(/\u202F/g, "");

function snapshot(overrides: Partial<RegistrySidebarSnapshot> = {}): RegistrySidebarSnapshot {
	return {
		projectName: "argent-x",
		branch: "main",
		inputTokens: 12_000,
		outputTokens: 30_000,
		contextWindow: 200_000,
		cumulativeTokens: 3_400_000,
		costUsd: 0.42,
		mcpServers: [{ name: "stitch", status: "ok" }],
		memory: ["prefers TypeScript strict"],
		...overrides,
	};
}

describe("sidebar-tree headers", () => {
	it("uses the V2 editorial tracked labels and thick rules", () => {
		const plain = untrack(renderRegistrySidebarLines(snapshot(), 30).map(stripAnsi).join("\n"));

		expect(plain).toContain("REGISTRY");
		expect(plain).toContain("◆ CONTEXT");
		expect(plain).toContain("▢ MEMORY");
		expect(plain).toContain("━━━━━━━━━━━━━━━━━━━━━━━━━━");
		expect(plain).not.toContain("┌ ACTIVE_CONTEXT");
		expect(plain).not.toContain("┌ METRICS");
	});
});
