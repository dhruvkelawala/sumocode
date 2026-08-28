import type { Component } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { SumoNode } from "../layout/node.js";
import { DIRECTION_LTR, loadYoga } from "../layout/yoga.js";
import { CellBuffer } from "../render/buffer.js";
import { composite } from "../render/compositor.js";
import { RegionRegistry } from "../pi-compat/region-registry.js";
import { stripAnsi } from "../cathedral/ansi.js";
import { ModalLayer } from "./modal-layer.js";
/* oxlint-disable anti-slop/no-chained-type-assertions -- test doubles cast minimal stub objects to Pi context types. */
/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- stub shape is exercised by the assertions below. */

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

	it("renders long selects as a search-mode Divine Query: filter row, no letters", async () => {
		const layer = new ModalLayer({ getTerminalSize: () => ({ columns: 80, rows: 40 }) });
		const options = Array.from({ length: 12 }, (_, index) => `choice-${String(index).padStart(2, "0")}`);
		options.push("research model");
		const result = layer.select("SUBAGENT ROLES", options);

		const beforeLines = layer.render(80);
		const before = beforeLines.join("\n");
		// Command-palette language: dialog title in the ✾ header, filter row,
		// no DIVINE QUERY branding, no letter labels, windowed rows.
		expect(before).toContain("SUBAGENT ROLES");
		expect(before).not.toContain("DIVINE QUERY");
		expect(before).toContain("type to filter");
		expect(before).not.toContain("A) choice-00");
		expect(beforeLines.filter((line) => line.includes("choice-")).length).toBeLessThanOrEqual(12);
		expect(before).toContain("more");

		// Typing filters (no letter-jump), Enter answers with the match.
		for (const char of "research") layer.handleInput(char);
		const filtered = layer.render(80).join("\n");
		expect(filtered).toContain("research");
		expect(filtered).not.toContain("choice-00");
		layer.handleInput("enter");
		await expect(result).resolves.toBe("research model");
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

	it("renders the empty input cursor before the non-editable placeholder", () => {
		const layer = new ModalLayer({ getTerminalSize: () => ({ columns: 40, rows: 24 }) });
		void layer.input("Answer", "type your answer");

		const text = stripAnsi(layer.render(40).join("\n"));

		expect(text).toContain("> █type your answer");
		expect(text).not.toContain("type your answer█");
	});

	it("keeps login link and redirect controls inside a 24-row terminal overlay cap", () => {
		const layer = new ModalLayer({ getTerminalSize: () => ({ columns: 60, rows: 24 }) });
		const loginUrl = `https://claude.ai/oauth/authorize?${"oauth=value&".repeat(18)}`;
		void layer.input(
			"Complete login in your browser, or paste the authorization code / redirect URL here:",
			undefined,
			{
				details: ["Complete login in your browser:", loginUrl],
				copyValue: loginUrl,
			},
		);

		// RpcOverlayHost caps centered modals at 65% of a 24-row terminal.
		const renderedRows = layer.render(60);
		expect(renderedRows.length).toBeLessThanOrEqual(15);
		const visibleRows = renderedRows.slice(0, 15);
		const visibleText = stripAnsi(visibleRows.join("\n"));
		const visibleAnsi = visibleRows.join("\n");

		expect(visibleText).toContain("https://claude.ai/oauth/authorize");
		expect(visibleText).toContain("…");
		expect(visibleText).toContain("> █");
		expect(visibleText).toContain("ctrl+y copy full URL");
		expect(visibleText).toContain("⏎ submit");
		expect(visibleAnsi).toContain(`\x1b]8;;${loginUrl}\x1b\\`);
	});

	it("wraps long input values without dropping hidden characters", () => {
		const layer = new ModalLayer({ getTerminalSize: () => ({ columns: 32, rows: 24 }) });
		void layer.input("Answer", "type your answer");
		const value = "x".repeat(80);
		layer.handleInput(value);

		const rows = layer.render(32).map(stripAnsi);
		const inputRows = rows.filter((row) => row.includes("x"));

		expect(inputRows.length).toBeGreaterThan(1);
		expect(inputRows.join("").match(/x/g)).toHaveLength(value.length);
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
