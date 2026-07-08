import type { Component } from "@earendil-works/pi-tui";
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
	it("renders confirm dialogs as a Divine Query panel (no full-frame backdrop)", () => {
		const layer = new ModalLayer({ getTerminalSize: () => ({ columns: 80, rows: 24 }) });
		void layer.confirm("APPROVAL", "Continue?");
		const rows = layer.render(80);

		// Panel rows only — positioning belongs to the overlay renderer
		// (anchor: center). A 24-row full-frame fill here previously blacked
		// out the entire terminal behind the modal.
		expect(rows.length).toBeGreaterThan(2);
		expect(rows.length).toBeLessThan(24);
		const text = rows.join("\n");
		expect(text).toContain("DIVINE QUERY");
		expect(text).toContain("APPROVAL");
		expect(text).toContain("Continue?");
		expect(text).toContain("A) Yes");
		expect(text).toContain("B) No");
	});

	it("renders select dialogs in the Divine Query language with lettered options", () => {
		const layer = new ModalLayer({ getTerminalSize: () => ({ columns: 80, rows: 24 }) });
		void layer.select("Which treatment do you want?", ["bordered card", "hint line"]);
		const text = layer.render(80).join("\n");

		expect(text).toContain("DIVINE QUERY");
		expect(text).toContain("Which treatment do you want?");
		expect(text).toContain("A) bordered card");
		expect(text).toContain("B) hint line");
	});

	it("selects an option directly via its letter (Divine Query parity)", async () => {
		const layer = new ModalLayer({ getTerminalSize: () => ({ columns: 80, rows: 24 }) });
		const result = layer.select("PICK", ["alpha", "beta"]);

		layer.handleInput("b");
		await expect(result).resolves.toBe("beta");
	});

	it("traps focus until Escape closes the active modal", async () => {
		const layer = new ModalLayer({ getTerminalSize: () => ({ columns: 80, rows: 24 }) });
		const result = layer.select("PICK", ["alpha", "beta"]);

		expect(layer.getActiveKind()).toBe("select");
		layer.handleInput("escape");
		await expect(result).resolves.toBeUndefined();
		expect(layer.getActiveKind()).toBeUndefined();
	});

	it("routes input to the visible modal while later modals are queued", async () => {
		const layer = new ModalLayer({ getTerminalSize: () => ({ columns: 80, rows: 24 }) });
		const input = layer.input("PATH");
		const select = layer.select("NEXT", ["alpha", "beta"]);

		layer.handleInput("/tmp/sumocode");
		expect(layer.render(80).join("\n")).toContain("/tmp/sumocode");
		expect(layer.render(80).join("\n")).not.toContain("NEXT");

		layer.handleInput("enter");
		await expect(input).resolves.toBe("/tmp/sumocode");
		expect(layer.render(80).join("\n")).toContain("NEXT");

		layer.handleInput("down");
		layer.handleInput("enter");
		await expect(select).resolves.toBe("beta");
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
