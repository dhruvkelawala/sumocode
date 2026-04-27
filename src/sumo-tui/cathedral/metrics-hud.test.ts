import { describe, expect, it, vi } from "vitest";
import { CATHEDRAL_TOKENS } from "../../tokens.js";
import { stripAnsi } from "./ansi.js";
import { MetricsHud, cpuMetricColor, fpsMetricColor, memoryMetricColor, renderMetricsHudLines, renderSparkline } from "./metrics-hud.js";

describe("metrics HUD", () => {
	it("renders CPU/MEM/FPS rows with 10-cell sparklines", () => {
		const lines = renderMetricsHudLines({
			cpuPercent: 12,
			memoryMiB: 256,
			fps: 3,
			cpuHistory: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
			memoryHistory: [200, 210, 220, 230, 240, 250, 260, 270, 280, 290],
			fpsHistory: [0, 1, 2, 3, 4, 5, 4, 3, 2, 1],
		}, 49).map(stripAnsi);

		expect(lines[0]).toContain("┌ METRICS ─");
		expect(lines[1]).toMatch(/CPU\s+[▁▂▃▄▅▆▇█]{10}\s+12%\s*$/);
		expect(lines[2]).toMatch(/MEM\s+[▁▂▃▄▅▆▇█]{10}\s+256M\s*$/);
		expect(lines[3]).toMatch(/FPS\s+[▁▂▃▄▅▆▇█]{10}\s+3\/s\s*$/);
	});

	it("maps metric severities to cathedral colors", () => {
		expect(cpuMetricColor(1)).toBe(CATHEDRAL_TOKENS.colors.foregroundDim);
		expect(cpuMetricColor(10)).toBe(CATHEDRAL_TOKENS.colors.states.thinking);
		expect(cpuMetricColor(25)).toBe(CATHEDRAL_TOKENS.colors.states.approval);
		expect(memoryMetricColor(128)).toBe(CATHEDRAL_TOKENS.colors.foregroundDim);
		expect(memoryMetricColor(250)).toBe(CATHEDRAL_TOKENS.colors.states.thinking);
		expect(memoryMetricColor(400)).toBe(CATHEDRAL_TOKENS.colors.states.approval);
		expect(fpsMetricColor(0)).toBe(CATHEDRAL_TOKENS.colors.foregroundDim);
		expect(fpsMetricColor(3)).toBe(CATHEDRAL_TOKENS.colors.states.idle);
		expect(fpsMetricColor(12)).toBe(CATHEDRAL_TOKENS.colors.states.thinking);
		expect(fpsMetricColor(31)).toBe(CATHEDRAL_TOKENS.colors.states.approval);
	});

	it("samples CPU/RSS/FPS with one interval", () => {
		vi.useFakeTimers();
		try {
			let now = 0;
			let cpu = { user: 0, system: 0 };
			const hud = new MetricsHud({
				now: () => now,
				cpuUsage: () => cpu,
				memoryUsage: () => ({ rss: 256 * 1024 * 1024 } as NodeJS.MemoryUsage),
				getRendersPerSecond: () => 4,
			});

			hud.start();
			expect(vi.getTimerCount()).toBe(1);
			now = 1000;
			cpu = { user: 50_000, system: 50_000 };
			vi.advanceTimersByTime(1000);

			const snapshot = hud.snapshot();
			expect(snapshot.cpuPercent).toBeCloseTo(10);
			expect(snapshot.memoryMiB).toBe(256);
			expect(snapshot.fps).toBe(4);
			expect(snapshot.cpuHistory.length).toBeLessThanOrEqual(10);
			hud.stop();
			expect(renderSparkline([0, 50, 100], 100)).toHaveLength(10);
		} finally {
			vi.useRealTimers();
		}
	});
});
