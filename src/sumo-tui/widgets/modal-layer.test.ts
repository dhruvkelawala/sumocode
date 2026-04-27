import type { Component } from "@mariozechner/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { SumoNode } from "../layout/node.js";
import { DIRECTION_LTR, loadYoga } from "../layout/yoga.js";
import { CellBuffer } from "../render/buffer.js";
import { composite } from "../render/compositor.js";
import { RegionRegistry } from "../pi-compat/region-registry.js";
import { ModalLayer } from "./modal-layer.js";

class CloseOnEnterComponent implements Component {
	public constructor(private readonly done: (value: string) => void) {}
	public invalidate(): void {}
	public handleInput(data: string): void {
		if (data === "enter") this.done("closed");
	}
	public render(): string[] {
		return ["CUSTOM MODAL"];
	}
}

describe("ModalLayer", () => {
	it("renders a full-screen dim backdrop and centered modal card", () => {
		const layer = new ModalLayer({ getTerminalSize: () => ({ columns: 80, rows: 24 }) });
		void layer.confirm("APPROVAL", "Continue?");
		const rows = layer.render(80);

		expect(rows).toHaveLength(24);
		expect(rows.join("\n")).toContain("APPROVAL");
		expect(rows.join("\n")).toContain("╭");
		expect(rows[0]).toContain("\u001b[48;2;18;13;10m");
	});

	it("traps focus until Escape closes the active modal", async () => {
		const layer = new ModalLayer({ getTerminalSize: () => ({ columns: 80, rows: 24 }) });
		const result = layer.select("PICK", ["alpha", "beta"]);

		expect(layer.getActiveKind()).toBe("select");
		layer.handleInput("escape");
		await expect(result).resolves.toBeUndefined();
		expect(layer.getActiveKind()).toBeUndefined();
	});

	it("RegionRegistry mounts custom modals above all content with backdrop", async () => {
		const yoga = await loadYoga();
		const root = new SumoNode(yoga.Node.create());
		const registry = new RegionRegistry({
			yoga,
			root,
			tui: { requestRender: vi.fn(), terminal: { columns: 80, rows: 24, setTitle: vi.fn() } } as never,
			theme: {} as never,
			editorTheme: { borderColor: (value: string) => value, selectList: {} } as never,
			keybindings: {} as never,
		});
		registry.mountHeader(["CONTENT"]);
		registry.mountModal("custom", new CloseOnEnterComponent(() => undefined), { width: 40 });
		root.width = 80;
		root.height = 24;
		root.yogaNode.calculateLayout(80, 24, DIRECTION_LTR);
		const frame = new CellBuffer(24, 80);
		composite(root, frame);

		expect(frame.getCell(0, 0).bg).toBe("#120D0A");
		expect(frame.toPlainRow(11)).toContain("CUSTOM MODAL");
		registry.dispose();
	});
});
