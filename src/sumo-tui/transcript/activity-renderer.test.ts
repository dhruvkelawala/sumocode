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
	it("renders the running empty state after a command row", () => {
		const rendered = plain(renderActivityLedgerRows(activity({
			body: { kind: "terminal", command: "pnpm test", text: "" },
		}), 60));

		expect(rendered).toContain("> pnpm test");
		expect(rendered).toContain("waiting for output…");
	});

	it("renders the settled empty state after an invocation row", () => {
		const rendered = plain(renderActivityLedgerRows(activity({
			status: "succeeded",
			invocation: { query: "sumo" },
			body: { kind: "text", text: "" },
		}), 60));

		expect(rendered).toContain('> {"query":"sumo"}');
		expect(rendered).toContain("no output captured");
	});

	it("renders every bounded bodyless Activity field before using the empty fallback", () => {
		const rows = renderActivityLedgerRows(activity({
			invocation: { query: "bodyless invocation" },
			currentStep: "checking the index",
			outputTail: "partial output",
			result: { error: "visible error", summary: "useful summary" },
		}), 64);
		const rendered = plain(rows);

		for (const value of ["bodyless invocation", "checking the index", "partial output", "visible error", "useful summary"]) {
			expect(rendered).toContain(value);
		}
		expect(rendered).not.toContain("waiting for output…");
		expect(rows.length).toBeLessThanOrEqual(31);
		expect(rows.every((row) => visibleWidth(row) === 64)).toBe(true);
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

	it("sanitizes producer titles and every producer-controlled header field", () => {
		const rows = renderActivityLedgerRows(activity({
			title: "\u001b[31mread\u001b[0m\tunsafe\rtitle",
			subject: "\u001b]8;;https://example.com\u0007src/a.ts\u001b]8;;\u0007",
			currentStep: "\u001b[2Kworking\tstep",
			result: { summary: "\u001b[35msettled\u001b[0m" },
			body: { kind: "text", text: "ok" },
		}), 72);
		const rendered = plain(rows);

		expect(rendered).toContain("[read unsafe title]");
		expect(rendered).toContain("src/a.ts");
		expect(rendered).toContain("settled");
		expect(rows.join("\n")).not.toContain("\u001b[31m");
		expect(rows.join("\n")).not.toContain("\u001b]8;");
		expect(rows.every((row) => visibleWidth(row) === 72)).toBe(true);
	});

	it.each([60, 128])("budgets malicious titles before header construction at %d columns", (width) => {
		const rows = renderActivityLedgerRows(activity({
			title: `\u001b[31m${"界".repeat(100_000)}\u001b[0m`,
			currentStep: "phase 4/5 · preserving progress note",
			body: { kind: "text", text: "working" },
		}), width);
		const header = stripAnsi(rows[0]!);

		expect(visibleWidth(rows[0]!)).toBe(width);
		expect(header).toContain("…]");
		expect(header).toContain("▶");
		expect(header).toContain("phase 4/5");
		expect(header.indexOf("▶")).toBeGreaterThan(header.indexOf("…]"));
		expect(rows[0]).not.toContain("\u001b[31m");
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

	it("preserves interior source blank lines and real read offsets", () => {
		const rows = renderActivityLedgerRows(activity({
			status: "succeeded",
			title: "read",
			subject: "src/a.ts",
			body: { kind: "source", text: "alpha\n\nomega", startLine: 7, totalLines: 9 },
		}), 70).map(stripAnsi);

		expect(rows.some((row) => row.includes("   7  alpha"))).toBe(true);
		expect(rows.some((row) => row.includes("   8  "))).toBe(true);
		expect(rows.some((row) => row.includes("   9  omega"))).toBe(true);
	});

	it("counts collapsed source lines from the absolute total in an offset read notice", () => {
		const projected = projectPiToolActivity({
			id: "offset-read",
			name: "read",
			status: "success",
			arguments: { path: "src/a.ts", offset: 21 },
			content: [{ type: "text", text: "line 21\nline 22\n\n[Showing lines 21-22 of 100 (50KB limit). Use offset=23 to continue.]" }],
			details: { truncation: { totalLines: 78 } },
		}, { messageId: "m1", blockIndex: 0 });
		if (!projected) throw new Error("projection failed");

		expect(projected.body).toMatchObject({ startLine: 21, totalLines: 100 });
		const rows = renderActivityLedgerRows(projected, 70).map(stripAnsi);
		expect(rows.some((row) => row.includes("… 78 lines collapsed"))).toBe(true);
		expect(rows.some((row) => row.includes("… 98 lines collapsed"))).toBe(false);
	});

	it("bounds generic producer output before line allocation and sanitization", () => {
		const rows = renderActivityLedgerRows(activity({
			body: { kind: "text", text: "producer output\n".repeat(200_000) },
		}), 64);
		const rendered = rows.map(stripAnsi);

		expect(rows.length).toBeLessThanOrEqual(31);
		expect(rendered.filter((row) => row.includes("collapsed"))).toHaveLength(1);
		expect(rows.every((row) => visibleWidth(row) === 64)).toBe(true);
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

	it("renders compact settled write results from invocation content", () => {
		const projected = projectPiToolActivity({
			toolCallId: "write-1",
			name: "write",
			status: "success",
			arguments: { path: "src/new.ts", content: "one\n\nthree" },
			content: [{ type: "text", text: "Successfully wrote 10 bytes to src/new.ts" }],
		}, { messageId: "m1", blockIndex: 0 });
		if (!projected) throw new Error("projection failed");

		const compact = stripAnsi(renderCompactActivityPill(projected));
		expect(compact).toContain("src/new.ts");
		expect(compact).toContain("3 lines");
		expect(compact).not.toContain("one");
	});

	it("renders child Activities, model context, and aggregate metrics", () => {
		const rows = renderActivityLedgerRows(activity({
			kind: "subagent",
			title: "review auth",
			model: "openai/gpt-5",
			thinking: "high",
			currentStep: "running tests",
			activeTools: [
				activity({ id: "read-1", title: "read", status: "succeeded", subject: "src/auth.ts" }),
				activity({
					id: "task-child",
					kind: "task",
					title: "verify auth",
					activeTools: [activity({ id: "bash-1", title: "bash", subject: "pnpm test" })],
				}),
			],
			metrics: { tokens: 1200, contextWindow: 128000, turns: 2, costUsd: 0.04, elapsedMs: 22000 },
		}), 80);
		const rendered = plain(rows);

		expect(rendered).toContain("openai/gpt-5 · thinking:high");
		expect(rendered).toContain("✓ [read]  src/auth.ts");
		expect(rendered).toContain("▶ [verify auth]");
		expect(rendered).toContain("↳ ▶ [bash]  pnpm test");
		expect(rendered).toContain("2 turns · 1.2k tokens · ctx:128k · $0.0400 · 22s elapsed");
		expect(rows.length).toBeLessThanOrEqual(31);
		expect(rows.every((row) => visibleWidth(row) === 80)).toBe(true);
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
