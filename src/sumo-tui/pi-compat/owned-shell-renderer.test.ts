import type { Component, EditorComponent } from "@mariozechner/pi-tui";
import type { CustomEditor } from "@mariozechner/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { loadYoga } from "../layout/yoga.js";
import { TerminalSessionOwner, type TerminalPatch } from "../runtime/terminal-controller.js";
import { ChatPager } from "../widgets/chat-pager.js";
import { OwnedShellRenderer, ownedShellEnabled } from "./owned-shell-renderer.js";

class StaticComponent implements Component {
	public constructor(private readonly rows: readonly string[]) {}
	public invalidate(): void {}
	public render(width: number): string[] {
		return this.rows.map((row) => (row.length >= width ? row.slice(0, width) : row.padEnd(width, " ")));
	}
}

class StaticEditor implements Component {
	public invalidate(): void {}
	public render(width: number): string[] {
		const top = `┌${"─".repeat(Math.max(0, width - 2))}┐`;
		const mid = `│ > ${" ".repeat(Math.max(0, width - 5))}│`;
		const bot = `└${"─".repeat(Math.max(0, width - 2))}┘`;
		return [top, mid, bot];
	}
}

class FakeTerminal {
	public patches: TerminalPatch[] = [];
	public cursors: ({ row: number; col: number } | null)[] = [];
	public readonly output: { isTTY: boolean; write: (data: string) => unknown };
	public readonly owner: TerminalSessionOwner;

	public constructor() {
		this.output = { isTTY: true, write: vi.fn() };
		this.owner = new TerminalSessionOwner({ output: this.output, paintBackground: false });
		this.owner.writeFramePatches = (patches: readonly TerminalPatch[], cursor: { row: number; col: number } | null) => {
			this.patches = [...patches];
			this.cursors.push(cursor);
		};
	}
}

describe("ownedShellEnabled", () => {
	it("defaults off when env var is unset", () => {
		expect(ownedShellEnabled({})).toBe(false);
	});

	it("treats truthy variants as on", () => {
		expect(ownedShellEnabled({ SUMOCODE_OWNED_SHELL: "1" })).toBe(true);
		expect(ownedShellEnabled({ SUMOCODE_OWNED_SHELL: "true" })).toBe(true);
		expect(ownedShellEnabled({ SUMOCODE_OWNED_SHELL: "YES" })).toBe(true);
	});

	it("treats other values as off", () => {
		expect(ownedShellEnabled({ SUMOCODE_OWNED_SHELL: "0" })).toBe(false);
		expect(ownedShellEnabled({ SUMOCODE_OWNED_SHELL: "off" })).toBe(false);
	});
});

describe("OwnedShellRenderer", () => {
	it("composes the #161 column tree with the footer pinned to the last row", async () => {
		const yoga = await loadYoga();
		const chat = ChatPager.create(yoga);
		const fakeTerminal = new FakeTerminal();

		const renderer = new OwnedShellRenderer({
			yoga,
			chat,
			editor: new StaticEditor() as unknown as CustomEditor | EditorComponent,
			headerContainer: new StaticComponent(["TOP"]),
			widgetContainerBelow: new StaticComponent(["HINT"]),
			footer: new StaticComponent(["FOOTER"]),
			terminal: fakeTerminal.owner,
			dimensions: { columns: 20, rows: 12 },
		});

		renderer.render();
		const lines = fakeTerminal.patches.map((patch) => stripAnsi(patch.ansi));
		expect(lines.length).toBe(12);
		expect(lines[0]?.startsWith("TOP")).toBe(true);
		// footer is pinned to last row
		expect(lines[11]?.startsWith("FOOTER")).toBe(true);
		// hint is one row above footer
		expect(lines[10]?.startsWith("HINT")).toBe(true);
		// editor occupies 3 rows above hint (rows 7..9), hint=10, footer=11
		expect(lines[7]?.startsWith("┌")).toBe(true);
		expect(lines[9]?.startsWith("└")).toBe(true);
		// blank row above editor
		expect(lines[6]?.trim()).toBe("");

		renderer.dispose();
	});

	it("re-renders only deltas after a single change", async () => {
		const yoga = await loadYoga();
		const chat = ChatPager.create(yoga);
		const fakeTerminal = new FakeTerminal();
		const editor = new StaticEditor();
		const renderer = new OwnedShellRenderer({
			yoga,
			chat,
			editor: editor as unknown as CustomEditor | EditorComponent,
			headerContainer: new StaticComponent(["TOP"]),
			widgetContainerBelow: new StaticComponent(["HINT"]),
			footer: new StaticComponent(["FOOTER"]),
			terminal: fakeTerminal.owner,
			dimensions: { columns: 20, rows: 12 },
		});

		renderer.render();
		const firstPatchCount = fakeTerminal.patches.length;
		expect(firstPatchCount).toBeGreaterThan(0);
		renderer.render();
		// Same content → diff returns no patches
		expect(fakeTerminal.patches.length).toBe(0);
		renderer.dispose();
	});
});

function stripAnsi(text: string): string {
	return text.replace(/\u001b\[[0-9;]*m/g, "");
}
