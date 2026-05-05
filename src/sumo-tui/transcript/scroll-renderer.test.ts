import { describe, expect, it } from "vitest";
import { renderScrollBlock } from "./scroll-renderer.js";
import type { DelegationViewModel } from "./view-model.js";

const ANSI = /\u001b\[[0-9;]*m/g;
const stripAnsi = (s: string): string => s.replace(ANSI, "");

function delegation(overrides: Partial<DelegationViewModel> = {}): DelegationViewModel {
	return {
		title: "refactor auth flow into smaller modules",
		agent: "scribe",
		status: "running",
		model: "gpt-5.5",
		thinking: "medium",
		nestedTools: [
			{ name: "read", status: "success", input: { path: "src/auth.ts" } },
			{ name: "edit", status: "success", input: { path: "src/auth.ts" } },
			{ name: "bash", status: "running", input: { command: "pnpm test src/auth" } },
		],
		tokensIn: 8000,
		tokensOut: 3000,
		elapsedMs: 22000,
		...overrides,
	};
}

describe("scroll/scribe renderer", () => {
	it("renders a scroll header with [scroll] tag and status", () => {
		const rows = renderScrollBlock(delegation(), 130).map(stripAnsi);
		expect(rows[0]).toContain("[scroll]");
		expect(rows[0]).toContain("refactor auth flow");
		expect(rows[0]).toContain("▶");
		expect(rows[0]).toContain("running");
	});

	it("renders task prompt in the outer scroll frame before the scribe frame", () => {
		const rows = renderScrollBlock(delegation({ prompt: "Review architecture\nReturn risks.", summary: "Scribe result." }), 130).map(stripAnsi);
		const taskHeaderIndex = rows.findIndex((r) => r.includes("┌ task"));
		const scribeHeaderIndex = rows.findIndex((r) => r.includes("┌ scribe"));
		expect(taskHeaderIndex).toBeGreaterThan(0);
		expect(scribeHeaderIndex).toBeGreaterThan(taskHeaderIndex);
		expect(rows.some((r) => r.includes("│ Review architecture"))).toBe(true);
		expect(rows.some((r) => r.includes("│ Scribe result."))).toBe(true);
	});

	it("renders scribe header with agent, model, and thinking", () => {
		const rows = renderScrollBlock(delegation(), 130).map(stripAnsi);
		const header = rows.find((r) => r.includes("scribe"));
		expect(header).toContain("scribe · gpt-5.5 · medium");
		expect(header).toContain("┌");
	});

	it("renders nested tool calls as compact pills", () => {
		const rows = renderScrollBlock(delegation(), 130).map(stripAnsi);
		expect(rows.some((r) => r.includes("✓") && r.includes("[read]") && r.includes("src/auth.ts"))).toBe(true);
		expect(rows.some((r) => r.includes("▶") && r.includes("[bash]") && r.includes("pnpm test"))).toBe(true);
	});

	it("renders completed task summary inside the scribe body", () => {
		const rows = renderScrollBlock(delegation({ status: "success", summary: "Task tool ran." }), 130).map(stripAnsi);
		expect(rows.some((r) => r.includes("│ Task tool ran."))).toBe(true);
	});

	it("renders token and elapsed metadata", () => {
		const rows = renderScrollBlock(delegation(), 130).map(stripAnsi);
		const meta = rows.find((r) => r.includes("Tokens"));
		expect(meta).toContain("↑8k");
		expect(meta).toContain("↓3k");
		expect(meta).toContain("22s elapsed");
	});

	it("renders bottom border with └────", () => {
		const rows = renderScrollBlock(delegation(), 130).map(stripAnsi);
		const bottom = rows[rows.length - 1];
		expect(bottom).toMatch(/└─+/);
	});

	it("renders ✓ done for completed delegations", () => {
		const rows = renderScrollBlock(delegation({ status: "success" }), 130).map(stripAnsi);
		expect(rows[0]).toContain("✓");
		expect(rows[0]).toContain("done");
	});

	it("renders ✗ failed for errored delegations", () => {
		const rows = renderScrollBlock(delegation({ status: "error" }), 130).map(stripAnsi);
		expect(rows[0]).toContain("✗");
		expect(rows[0]).toContain("failed");
	});

	it("uses correct ANSI colors", () => {
		const rows = renderScrollBlock(delegation(), 130);
		const raw = rows.join("\n");
		// accent for [scroll]
		expect(raw).toContain("\u001b[38;2;217;119;6m[scroll]");
		// tool blue for ▶ (running)
		expect(raw).toContain("\u001b[38;2;91;155;213m▶");
		// idle green for ✓
		expect(raw).toContain("\u001b[38;2;127;176;105m✓");
	});

	it("formats elapsed time as minutes when over 60s", () => {
		const rows = renderScrollBlock(delegation({ elapsedMs: 78000 }), 130).map(stripAnsi);
		const meta = rows.find((r) => r.includes("elapsed"));
		expect(meta).toContain("1m 18s elapsed");
	});

	it("pads every row to the requested width", () => {
		const rows = renderScrollBlock(delegation(), 100);
		for (const row of rows) {
			expect(stripAnsi(row).length, `row not padded: ${JSON.stringify(stripAnsi(row))}`).toBe(100);
		}
	});
});
