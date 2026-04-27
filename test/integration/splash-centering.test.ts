import { describe, expect, it, vi } from "vitest";
import { defaultSplashSnapshot, getSplashContentHeight } from "../../src/sumo-tui/cathedral/splash-tree.js";
import { SumoInteractiveRuntime } from "../../src/sumo-tui/pi-compat/sumo-interactive-mode.js";

const ANSI_PATTERN = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)|_[^\x07]*(?:\x07|\x1b\\))/g;

function stripAnsi(text: string): string {
	return text.replace(ANSI_PATTERN, "");
}

function firstNonBlankRow(lines: readonly string[]): number {
	return lines.findIndex((line) => stripAnsi(line).trim().length > 0);
}

describe("sumo-tui splash centering integration", () => {
	it("centers the retained splash in the empty chat slot and removes it after the first message", async () => {
		const runtime = new SumoInteractiveRuntime({ isTTY: false, columns: 100, rows: 30, write: vi.fn() });
		const snapshot = await runtime.start();
		try {
			const lines = runtime.renderChatLines(100, 30);
			const expectedTop = Math.floor((30 - getSplashContentHeight(defaultSplashSnapshot(false), 100)) / 2);
			expect(firstNonBlankRow(lines)).toBeGreaterThanOrEqual(expectedTop);
			expect(stripAnsi(lines.join("\n"))).toContain("PERFECTION IS ACHIEVED");

			snapshot.chat.addMessage("user", "hello");
			const chatLines = runtime.renderChatLines(100, 30);
			expect(stripAnsi(chatLines.join("\n"))).toContain("USER > hello");
			expect(stripAnsi(chatLines.join("\n"))).not.toContain("PERFECTION IS ACHIEVED");
		} finally {
			runtime.stop();
		}
	});
});
