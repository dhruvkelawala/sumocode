import type { KeybindingsManager, Theme } from "@mariozechner/pi-coding-agent";
import type { Component, EditorTheme, TUI } from "@mariozechner/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { DIRECTION_LTR, loadYoga } from "../layout/yoga.js";
import { CellBuffer } from "../render/buffer.js";
import { composite } from "../render/compositor.js";
import { RegionRegistry } from "../pi-compat/region-registry.js";

class LineComponent implements Component {
	public constructor(private readonly text: string) {}
	public invalidate(): void {}
	public render(width: number): string[] {
		return [this.text.padEnd(width, " ")];
	}
}

function fakeTui(rows: number): TUI {
	return { requestRender: vi.fn(), terminal: { columns: 80, rows, setTitle: vi.fn() } } as unknown as TUI;
}

describe("footer pinning via RegionRegistry shell", () => {
	for (const height of [24, 60, 100]) {
		it(`pins footer to the last row at ${height} rows`, async () => {
			const yoga = await loadYoga();
			const registry = new RegionRegistry({
				yoga,
				tui: fakeTui(height),
				theme: {} as Theme,
				editorTheme: { borderColor: (value: string) => value, selectList: {} } as EditorTheme,
				keybindings: {} as KeybindingsManager,
			});
			registry.mountHeader(new LineComponent("TOP"));
			registry.mountFooter(new LineComponent("FOOTER"));
			registry.root.width = 80;
			registry.root.height = height;
			registry.root.yogaNode.calculateLayout(80, height, DIRECTION_LTR);
			const frame = new CellBuffer(height, 80);
			composite(registry.root, frame);

			expect(frame.toPlainRow(0).startsWith("TOP")).toBe(true);
			expect(frame.toPlainRow(height - 1).startsWith("FOOTER")).toBe(true);
			expect(registry.getSlot("chat").getComputedHeight()).toBe(height - 2);
			registry.dispose();
		});
	}
});
