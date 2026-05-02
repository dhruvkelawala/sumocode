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
	it("uses currentContextTokens for CONTEXT meter, not cumulative inputTokens+outputTokens", () => {
		// Reproduces issue #192: sidebar showed 21M (cumulative) instead of 254k (current context)
		const plain = untrack(
			renderRegistrySidebarLines(
				snapshot({
					inputTokens: 10_000_000,
					outputTokens: 11_000_000,
					currentContextTokens: 254_000,
					contextWindow: 272_000,
					cumulativeTokens: 21_000_000,
				}),
				30,
			)
				.map(stripAnsi)
				.join("\n"),
		);
		// CONTEXT section: should show current (254k), not cumulative (21M)
		expect(plain).toContain("254k");
		expect(plain).not.toContain("OVER");
		// SESSION cumul: should still show cumulative
		expect(plain).toContain("21M");
	});

	it("falls back to inputTokens+outputTokens when currentContextTokens is absent", () => {
		const plain = untrack(
			renderRegistrySidebarLines(
				snapshot({ inputTokens: 100_000, outputTokens: 50_000, contextWindow: 200_000 }),
				30,
			)
				.map(stripAnsi)
				.join("\n"),
		);
		expect(plain).toContain("150k");
	});

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
