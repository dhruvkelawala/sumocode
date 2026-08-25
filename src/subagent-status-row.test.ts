import { describe, expect, it } from "vitest";
import { renderSubagentStatusRow } from "./subagent-status-row.js";

const ANSI = /\x1b\[[0-9;]*m/g;
const plain = (value: string): string => value.replace(ANSI, "");

describe("renderSubagentStatusRow", () => {
	it("composes role, age, and queue segments", () => {
		const [row] = renderSubagentStatusRow({
			width: 100,
			running: [
				{ id: "sa-2", roleId: "research", title: "research auth", ageMs: 4 * 60_000 },
				{ id: "sa-5", roleId: "implement-cheap", title: "implement auth", ageMs: 40_000 },
			],
			queuedCount: 1,
		});
		expect(plain(row)).toBe("◈ subagents · sa-2 research 4m · sa-5 implement-cheap 40s · 1 queued");
	});

	it("omits the queue segment when the queue is empty", () => {
		const [row] = renderSubagentStatusRow({
			width: 80,
			running: [{ id: "sa-1", roleId: "review", title: "review", ageMs: 1_000 }],
			queuedCount: 0,
		});
		expect(plain(row)).toContain("sa-1 review 1s");
		expect(plain(row)).not.toContain("queued");
	});

	it("falls back to a bounded title prefix when no role is present", () => {
		const [row] = renderSubagentStatusRow({
			width: 80,
			running: [{ id: "sa-3", title: "a very long custom investigation title", ageMs: 0 }],
			queuedCount: 0,
		});
		expect(plain(row)).toContain("sa-3 a very long custo… 0s");
		expect(plain(row)).not.toContain("investigation");
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
