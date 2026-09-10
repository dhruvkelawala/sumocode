import { describe, expect, it } from "vitest";
import { renderSubagentStatusRow, shortId } from "./subagent-status-row.js";

const ANSI = /\x1b\[[0-9;]*m/g; // oxlint-disable-line no-control-regex -- intentional ANSI escape sequence stripping in a render test.
const plain = (value: string): string => value.replace(ANSI, "");

describe("shortId", () => {
	it("collapses a namespaced uuid id to its sequence suffix", () => {
		expect(shortId("sa-7e8fc89b-3545-43af-bf97-d603cdefdea2-2")).toBe("sa-2");
	});

	it("passes already-short ids through unchanged", () => {
		expect(shortId("sa-1")).toBe("sa-1");
	});

	it("passes non-sa ids through unchanged", () => {
		expect(shortId("task-7")).toBe("task-7");
	});
});

describe("renderSubagentStatusRow", () => {
	it("composes aggregate counts before per-agent title, short id, role, and age segments", () => {
		const [row] = renderSubagentStatusRow({
			width: 120,
			running: [
				{ id: "sa-2", roleId: "research", title: "research auth", ageMs: 4 * 60_000 },
				{ id: "sa-5", roleId: "implement-cheap", title: "implement auth", ageMs: 40_000 },
			],
			queuedCount: 1,
		});
		expect(plain(row)).toBe(
			"  ◈ subagents · 2 running · 1 queued · research auth sa-2 research 4m · implement auth sa-5 implement-cheap 40s",
		);
	});

	it("shows the human title and a shortened id for namespaced subagent ids", () => {
		const [row] = renderSubagentStatusRow({
			width: 200,
			running: [
				{
					id: "sa-7e8fc89b-3545-43af-bf97-d603cdefdea2-2",
					roleId: "implement-cheap",
					title: "rebase-471-herdr-panes",
					ageMs: 13 * 60_000,
				},
			],
			queuedCount: 0,
		});
		expect(plain(row)).toContain("rebase-471-herdr-panes sa-2 implement-cheap 13m");
		expect(plain(row)).not.toContain("7e8fc89b");
	});

	it("keeps single-namespace short ids unchanged", () => {
		const [row] = renderSubagentStatusRow({
			width: 200,
			running: [
				{ id: "sa-7e8fc89b-3545-43af-bf97-d603cdefdea2-1", title: "one", ageMs: 0 },
				{ id: "sa-7e8fc89b-3545-43af-bf97-d603cdefdea2-2", title: "two", ageMs: 0 },
			],
			queuedCount: 0,
		});
		expect(plain(row)).toContain("one sa-1 0s");
		expect(plain(row)).toContain("two sa-2 0s");
		expect(plain(row)).not.toContain("7e8fc89b");
	});

	it("disambiguates colliding short ids with a namespace fragment", () => {
		const [row] = renderSubagentStatusRow({
			width: 200,
			running: [
				{ id: "sa-01234567-89ab-cdef-0123-456789abcdef-1", title: "old", ageMs: 1_000 },
				{ id: "sa-89abcdef-0123-4567-89ab-cdef01234567-1", title: "new", ageMs: 2_000 },
				{ id: "sa-89abcdef-0123-4567-89ab-cdef01234567-2", title: "next", ageMs: 3_000 },
			],
			queuedCount: 0,
		});
		const text = plain(row);
		expect(text).toContain("old sa-01234567-1 1s");
		expect(text).toContain("new sa-89abcdef-1 2s");
		// Only colliding ids widen; the unambiguous sibling keeps the short form.
		expect(text).toContain("next sa-2 3s");
	});

	it("keeps aggregate counts visible when per-agent detail is truncated", () => {
		const [row] = renderSubagentStatusRow({
			width: 60,
			running: Array.from({ length: 10 }, (_, index) => ({
				id: `sa-${index + 1}`,
				roleId: "research",
				title: "research",
				ageMs: 1_000,
			})),
			queuedCount: 1,
		});
		expect(plain(row)).toContain("10 running");
		expect(plain(row)).toContain("1 queued");
		expect(plain(row).length).toBeLessThanOrEqual(60);
	});

	it("renders only the queued aggregate when no agents are running", () => {
		const [row] = renderSubagentStatusRow({
			width: 80,
			running: [],
			queuedCount: 2,
		});
		expect(plain(row)).toBe("  ◈ subagents · 2 queued");
	});

	it("omits the queue segment when the queue is empty", () => {
		const [row] = renderSubagentStatusRow({
			width: 80,
			running: [{ id: "sa-1", roleId: "review", title: "review", ageMs: 1_000 }],
			queuedCount: 0,
		});
		expect(plain(row)).toContain("1 running · review sa-1 1s");
		expect(plain(row)).not.toContain("queued");
	});

	it("skips a role that duplicates the title", () => {
		const [row] = renderSubagentStatusRow({
			width: 200,
			running: [
				{ id: "sa-1", roleId: "research", title: "research", ageMs: 1_000 },
				{ id: "sa-2", roleId: "implement-cheap", title: "rebase-471-herdr-panes", ageMs: 2_000 },
			],
			queuedCount: 0,
		});
		expect(plain(row)).toContain("research sa-1 1s");
		expect(plain(row)).not.toContain("research sa-1 research");
		expect(plain(row)).toContain("rebase-471-herdr-panes sa-2 implement-cheap 2s");
	});

	it("caps a long title so the short id stays visible", () => {
		const [row] = renderSubagentStatusRow({
			width: 120,
			running: [{
				id: "sa-7e8fc89b-3545-43af-bf97-d603cdefdea2-2",
				roleId: "implement-cheap",
				title: "investigate the failing flaky integration test ".repeat(8),
				ageMs: 13 * 60_000,
			}],
			queuedCount: 0,
		});
		const text = plain(row);
		expect(text).toContain("…");
		expect(text).toContain("sa-2 implement-cheap 13m");
		expect(text.length).toBeLessThanOrEqual(120);
	});

	it("falls back to the generic label when the title is empty", () => {
		const [row] = renderSubagentStatusRow({
			width: 80,
			running: [{ id: "sa-3", title: "", ageMs: 0 }],
			queuedCount: 0,
		});
		expect(plain(row)).toContain("subagent sa-3 0s");
	});

	it("renders non-sa ids verbatim", () => {
		const [row] = renderSubagentStatusRow({
			width: 80,
			running: [{ id: "task-7", roleId: "plan", title: "refactor", ageMs: 0 }],
			queuedCount: 0,
		});
		expect(plain(row)).toContain("refactor task-7 plan 0s");
	});

	it("truncates the rendered row to the requested width", () => {
		for (const width of [0, 1, 12, 30]) {
			const [row] = renderSubagentStatusRow({
				width,
				running: [{ id: "sa-99", roleId: "implement-smart", title: "implementation", ageMs: 9_000 }],
				queuedCount: 12,
			});
			expect(plain(row).length).toBeLessThanOrEqual(width);
		}
	});
});
