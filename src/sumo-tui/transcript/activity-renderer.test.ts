import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import type { ActivitySnapshot } from "../../activity/domain.js";
import { projectPiToolActivity } from "../../activity/pi-projector.js";
import { stripAnsi } from "../cathedral/ansi.js";
import { renderActivityBlockRows, renderActivityLedgerRows, renderCompactActivityPill } from "./activity-renderer.js";

function activity(overrides: Partial<ActivitySnapshot> = {}): ActivitySnapshot {
	return {
		id: "activity-1",
		kind: "tool",
		title: "custom",
		status: "running",
		...overrides,
	};
}

function plain(rows: readonly string[]): string {
	return rows.map(stripAnsi).join("\n");
}

describe("Activity renderer", () => {
	it("renders running and settled empty states with exact useful copy", () => {
		expect(plain(renderActivityLedgerRows(activity({ body: { kind: "text", text: "" } }), 60))).toContain("waiting for output…");
		expect(plain(renderActivityLedgerRows(activity({ status: "succeeded", body: { kind: "text", text: "" } }), 60))).toContain("no output captured");
	});

	it("renders unknown tool output, error, and redacted invocation instead of a contentless fallback", () => {
		const invocation: Record<string, unknown> = { query: "sumo", apiKey: "hidden", nested: { password: "hidden-too" } };
		invocation.self = invocation;
		const projected = projectPiToolActivity({
			id: "custom-1",
			name: "mcp.search",
			status: "failed",
			arguments: invocation,
			output: "three matches",
			error: "request failed",
		}, { messageId: "m1", blockIndex: 0 });
		if (!projected) throw new Error("projection failed");
		const rendered = plain(renderActivityLedgerRows(projected, 72));

		expect(rendered).toContain("sumo");
		expect(rendered).toContain("[REDACTED]");
		expect(rendered).toContain("request failed");
		expect(rendered).toContain("three matches");
		expect(rendered).not.toContain("hidden-too");
	});

	it("sanitizes ANSI, tabs, carriage returns, and preserves wide characters before measuring", () => {
		const rows = renderActivityLedgerRows(activity({
			subject: "run\t界",
			body: { kind: "terminal", command: "run\t界", text: "\u001b[31mred\u001b[0m\t界\rnext" },
		}), 42);
		const rendered = plain(rows);

		expect(rendered).toContain("red    界");
		expect(rendered).toContain("next");
		expect(rows.join("\n")).not.toContain("\u001b[31m");
		expect(rows.every((row) => visibleWidth(row) === 42)).toBe(true);
	});

	it("bounds huge invocation/output to 31 exact-width rows with one truncation marker", () => {
		const rows = renderActivityLedgerRows(activity({
			invocation: { query: "x".repeat(20_000) },
			body: { kind: "text", text: Array.from({ length: 80 }, (_, index) => `output ${index} ${"界".repeat(80)}`).join("\n") },
		}), 64);
		const rendered = rows.map(stripAnsi);

		expect(rows.length).toBeLessThanOrEqual(31);
		expect(rows.every((row) => visibleWidth(row) === 64)).toBe(true);
		expect(rendered.filter((row) => row.includes("collapsed"))).toHaveLength(1);
	});

	it("shows no more than 25 source rows plus one consolidated truncation marker", () => {
		const rows = renderActivityLedgerRows(activity({
			status: "succeeded",
			title: "read",
			subject: "src/a.ts",
			body: { kind: "source", text: Array.from({ length: 40 }, (_, index) => `line ${index + 1}`).join("\n"), startLine: 10, totalLines: 100 },
		}), 70);
		const rendered = rows.map(stripAnsi);

		expect(rendered.some((row) => row.includes("  34  line 25"))).toBe(true);
		expect(rendered.some((row) => row.includes("line 26"))).toBe(false);
		expect(rendered.filter((row) => row.includes("collapsed"))).toHaveLength(1);
		expect(rows.length).toBeLessThanOrEqual(31);
	});

	it("renders compact settled result previews when presentation state is collapsed", () => {
		const settled = activity({
			status: "succeeded",
			title: "bash",
			subject: "pnpm test",
			body: { kind: "terminal", command: "pnpm test", text: "22 passed" },
			result: { summary: "22 tests, 1.2s" },
		});
		const compact = stripAnsi(renderCompactActivityPill(settled));
		const rows = renderActivityBlockRows(settled, 70, { expanded: false });

		expect(compact).toContain("22 tests, 1.2s");
		expect(rows).toHaveLength(1);
		expect(visibleWidth(rows[0]!)).toBe(70);
	});
});
