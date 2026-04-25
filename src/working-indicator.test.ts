import { describe, expect, it } from "vitest";
import { CATHEDRAL_TOKENS } from "./tokens.js";
import { CATHEDRAL_INDICATOR_FRAMES, indicatorFrameAt, renderIndicator } from "./working-indicator.js";

describe("indicatorFrameAt", () => {
	it("returns the frame at the given tick when in range", () => {
		const frames = ["a", "b", "c"];

		expect(indicatorFrameAt(0, frames)).toContain("a");
		expect(indicatorFrameAt(1, frames)).toContain("b");
		expect(indicatorFrameAt(2, frames)).toContain("c");
	});

	it("cycles back to the first frame past the end", () => {
		const frames = ["a", "b", "c"];

		expect(indicatorFrameAt(3, frames)).toContain("a");
		expect(indicatorFrameAt(4, frames)).toContain("b");
		expect(indicatorFrameAt(99, frames)).toContain("a");
	});
});

describe("renderIndicator", () => {
	it("colorizes the current frame with the Cathedral accent", () => {
		const output = renderIndicator(0, CATHEDRAL_INDICATOR_FRAMES, CATHEDRAL_TOKENS.colors.accent);
		const raw = CATHEDRAL_INDICATOR_FRAMES[0];

		expect(output).toContain(raw);
		expect(output).toMatch(/\u001b\[38;2;\d+;\d+;\d+m/);
		expect(output).toMatch(/\u001b\[0m$/);
	});

	it("ships at least 4 Cathedral frames so the breath has perceivable rhythm", () => {
		expect(CATHEDRAL_INDICATOR_FRAMES.length).toBeGreaterThanOrEqual(4);
	});
});
