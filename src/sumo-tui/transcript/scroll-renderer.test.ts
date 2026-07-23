import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { stripAnsi } from "../cathedral/ansi.js";
import { activityFromDelegationViewModel, renderScrollBlock } from "./scroll-renderer.js";
import type { DelegationViewModel } from "./view-model.js";

function delegation(overrides: Partial<DelegationViewModel> = {}): DelegationViewModel {
	return {
		id: "task-1",
		title: "refactor auth flow into smaller modules",
		agent: "scribe",
		status: "running",
		prompt: "Review architecture\nReturn risks.",
		summary: "Running auth tests",
		model: "gpt-5.5",
		thinking: "medium",
		nestedTools: [
			{ id: "read-1", name: "read", status: "success", input: { path: "src/auth.ts" } },
			{ id: "bash-1", name: "bash", status: "running", input: { command: "pnpm test src/auth" } },
		],
		tokensIn: 8000,
		tokensOut: 3000,
		elapsedMs: 22000,
		...overrides,
	};
}

function plain(rows: readonly string[]): string {
	return rows.map(stripAnsi).join("\n");
}

describe("scroll/scribe compatibility wrapper", () => {
	it("projects legacy delegation records into the shared Activity contract", () => {
		expect(activityFromDelegationViewModel(delegation())).toMatchObject({
			id: "task-1",
			kind: "task",
			title: "refactor auth flow into smaller modules",
			status: "running",
			invocation: { prompt: "Review architecture\nReturn risks." },
			subject: "scribe",
			model: "gpt-5.5",
			thinking: "medium",
			activeTools: [
				{ id: "read-1", title: "read", status: "succeeded" },
				{ id: "bash-1", title: "bash", status: "running" },
			],
			metrics: { tokensIn: 8000, tokensOut: 3000, elapsedMs: 22000 },
		});
	});

	it("forwards prompt, nested progress, output, and metrics through Activity rendering", () => {
		const rendered = plain(renderScrollBlock(delegation(), 100));

		expect(rendered).toContain("[refactor auth flow into smaller modules]");
		expect(rendered).toContain("Review architecture");
		expect(rendered).toContain("gpt-5.5 · thinking:medium");
		expect(rendered).toContain("✓ [read]  src/auth.ts");
		expect(rendered).toContain("▶ [bash]  pnpm test src/auth");
		expect(rendered).toContain("↑8k · ↓3k · 22s elapsed");
		expect(rendered).toContain("Running auth tests");
	});

	it("maps settled success, failure, and cancellation statuses", () => {
		expect(activityFromDelegationViewModel(delegation({ status: "success" })).status).toBe("succeeded");
		expect(activityFromDelegationViewModel(delegation({ status: "error" })).status).toBe("failed");
		expect(activityFromDelegationViewModel(delegation({ status: "cancelled" })).status).toBe("cancelled");
	});

	it("bounds output and pads every row to the requested width", () => {
		const rows = renderScrollBlock(delegation({
			status: "success",
			summary: Array.from({ length: 100 }, (_, index) => `line ${index + 1}`).join("\n"),
		}), 72);
		const rendered = rows.map(stripAnsi);

		expect(rows.length).toBeLessThanOrEqual(31);
		expect(rendered.filter((row) => row.includes("collapsed"))).toHaveLength(1);
		expect(rows.every((row) => visibleWidth(row) === 72)).toBe(true);
	});
});
