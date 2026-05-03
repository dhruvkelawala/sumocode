import type { Component, OverlayOptions } from "@mariozechner/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { loadYoga } from "../layout/yoga.js";
import { TerminalSessionOwner, type TerminalPatch } from "../runtime/terminal-controller.js";
import { ChatPager } from "../widgets/chat-pager.js";
import { createSplashTree, defaultSplashSnapshot } from "../cathedral/splash-tree.js";
import { OwnedShellRenderer, ownedShellEnabled } from "./owned-shell-renderer.js";

class StaticComponent implements Component {
	public rows: readonly string[];
	public constructor(rows: readonly string[]) {
		this.rows = rows;
	}
	public invalidate(): void {}
	public render(width: number): string[] {
		return this.rows.map((row) => (row.length >= width ? row.slice(0, width) : row.padEnd(width, " ")));
	}
}

class StaticEditor implements Component {
	public extraRows: string[] = [];
	public invalidate(): void {}
	public render(width: number): string[] {
		const top = `┌${"─".repeat(Math.max(0, width - 2))}┐`;
		const mid = `│ > ${" ".repeat(Math.max(0, width - 5))}│`;
		const bot = `└${"─".repeat(Math.max(0, width - 2))}┘`;
		return [top, mid, bot, ...this.extraRows];
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
	it("is always enabled in SumoTUI mode", () => {
		expect(ownedShellEnabled()).toBe(true);
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
			editorContainer: () => new StaticEditor() as Component,
			headerContainer: () => new StaticComponent(["TOP"]),
			widgetContainerBelow: () => new StaticComponent(["HINT"]),
			footer: () => new StaticComponent(["FOOTER"]),
			terminal: fakeTerminal.owner,
			dimensions: { columns: 20, rows: 12 },
		});

		renderer.render();
		const lines = fakeTerminal.patches.map((patch) => stripAnsi(patch.ansi));
		expect(lines.length).toBe(12);
		expect(lines[0]?.startsWith("TOP")).toBe(true);
		// footer is pinned above the terminal-bottom safe row
		expect(lines[10]?.startsWith("FOOTER")).toBe(true);
		expect(lines[11]?.trim()).toBe("");
		// hint is separated from footer by one breathing row
		expect(lines[8]?.startsWith("HINT")).toBe(true);
		expect(lines[9]?.trim()).toBe("");
		// editor occupies 3 rows above hint (rows 5..7), hint=8, footer=10
		expect(lines[5]?.startsWith("┌")).toBe(true);
		expect(lines[7]?.startsWith("└")).toBe(true);
		// blank row above editor
		expect(lines[4]?.trim()).toBe("");

		renderer.dispose();
	});

	it("prefers retained top chrome over Pi header container", async () => {
		const yoga = await loadYoga();
		const chat = ChatPager.create(yoga);
		const fakeTerminal = new FakeTerminal();
		const renderer = new OwnedShellRenderer({
			yoga,
			chat,
			editorContainer: () => new StaticEditor() as Component,
			headerContainer: () => new StaticComponent(["PI-HEADER"]),
			topChromePublication: () => ({ component: new StaticComponent(["RETAINED-TOP"]) }),
			widgetContainerBelow: () => new StaticComponent(["HINT"]),
			footer: () => new StaticComponent(["FOOTER"]),
			terminal: fakeTerminal.owner,
			dimensions: { columns: 24, rows: 12 },
		});

		renderer.render();
		const lines = fakeTerminal.patches.map((patch) => stripAnsi(patch.ansi));
		expect(lines[0]?.startsWith("RETAINED-TOP")).toBe(true);
		expect(lines.join("\n")).not.toContain("PI-HEADER");
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
			editorContainer: () => editor as Component,
			headerContainer: () => new StaticComponent(["TOP"]),
			widgetContainerBelow: () => new StaticComponent(["HINT"]),
			footer: () => new StaticComponent(["FOOTER"]),
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

	it("regrows the editor row when autocomplete content appears", async () => {
		const yoga = await loadYoga();
		const chat = ChatPager.create(yoga);
		const fakeTerminal = new FakeTerminal();
		const editor = new StaticEditor();
		const renderer = new OwnedShellRenderer({
			yoga,
			chat,
			editorContainer: () => editor as Component,
			headerContainer: () => new StaticComponent(["TOP"]),
			widgetContainerBelow: () => new StaticComponent(["HINT"]),
			footer: () => new StaticComponent(["FOOTER"]),
			terminal: fakeTerminal.owner,
			dimensions: { columns: 20, rows: 14 },
		});

		renderer.render();
		editor.extraRows = ["AUTO-1", "AUTO-2", "AUTO-3"]; // simulate autocomplete dropdown
		renderer.render();
		// Patches from render #2 are the diff vs #1 — they should include the
		// autocomplete rows that newly appeared between footer area and previous editor.
		const lines = fakeTerminal.patches.map((patch) => stripAnsi(patch.ansi));
		expect(lines.some((line) => line.includes("AUTO-1"))).toBe(true);
		expect(lines.some((line) => line.includes("AUTO-2"))).toBe(true);
		expect(lines.some((line) => line.includes("AUTO-3"))).toBe(true);
		renderer.dispose();
	});

	it("mounts splash in chat-row when no messages, swaps to ChatPager once messages exist", async () => {
		const yoga = await loadYoga();
		const chat = ChatPager.create(yoga);
		const splash = createSplashTree(yoga, undefined, () => defaultSplashSnapshot(chat.hasMessages()));
		const fakeTerminal = new FakeTerminal();
		const editor = new StaticEditor();
		const renderer = new OwnedShellRenderer({
			yoga,
			chat,
			splash,
			editorContainer: () => editor as Component,
			headerContainer: () => new StaticComponent(["TOP"]),
			widgetContainerBelow: () => new StaticComponent(["HINT"]),
			footer: () => new StaticComponent(["FOOTER"]),
			terminal: fakeTerminal.owner,
			dimensions: { columns: 60, rows: 24 },
		});

		renderer.render();
		const splashLines = fakeTerminal.patches.map((p) => stripAnsi(p.ansi)).join("\n");
		// SUMOCODE block-letter pixel art is the splash signature.
		expect(splashLines).toMatch(/█████ █   █ █   █ █████/);

		chat.addMessage("user", "hello-active");
		renderer.render();
		const activeLines = fakeTerminal.patches.map((p) => stripAnsi(p.ansi)).join("\n");
		expect(activeLines).toContain("hello-active");
		renderer.dispose();
	});

	it("renders Pi-internal selectors (e.g. /resume) when editorContainer swaps children", async () => {
		const yoga = await loadYoga();
		const chat = ChatPager.create(yoga);
		const fakeTerminal = new FakeTerminal();
		let active: Component = new StaticEditor();
		// Mimic Pi's editorContainer: a Container whose render delegates to the
		// currently active child (editor or extension selector).
		const renderer = new OwnedShellRenderer({
			yoga,
			chat,
			editorContainer: () => active,
			headerContainer: () => new StaticComponent(["TOP"]),
			widgetContainerBelow: () => new StaticComponent(["HINT"]),
			footer: () => new StaticComponent(["FOOTER"]),
			terminal: fakeTerminal.owner,
			dimensions: { columns: 40, rows: 20 },
		});

		renderer.render();
		// /resume swap: replace the editor with a session selector component.
		active = new StaticComponent(["SELECT SESSION", " · alpha-session", " · beta-session", " · gamma-session"]);
		renderer.render();

		const lines = fakeTerminal.patches.map((p) => stripAnsi(p.ansi));
		expect(lines.some((line) => line.includes("SELECT SESSION"))).toBe(true);
		expect(lines.some((line) => line.includes("alpha-session"))).toBe(true);
		expect(lines.some((line) => line.includes("beta-session"))).toBe(true);

		// Restore editor; the next render should swap back.
		active = new StaticEditor();
		renderer.render();
		const restoredLines = fakeTerminal.patches.map((p) => stripAnsi(p.ansi));
		expect(restoredLines.some((line) => line.includes("┌─"))).toBe(true);
		renderer.dispose();
	});

	it("follows lazy footer resolver after Pi swaps customFooter (e.g. /resume reload)", async () => {
		const yoga = await loadYoga();
		const chat = ChatPager.create(yoga);
		const fakeTerminal = new FakeTerminal();
		// Simulate the stale-after-reload condition: render() throws once Pi
		// disposes the component because its captured ctx is invalidated.
		const staleFooter: Component = {
			invalidate(): void {},
			render(): string[] {
				throw new Error("extension ctx is stale after session replacement or reload");
			},
		};
		const freshFooter = new StaticComponent(["FRESH-FOOTER"]);
		let currentFooter: Component = staleFooter;
		const renderer = new OwnedShellRenderer({
			yoga,
			chat,
			editorContainer: () => new StaticEditor() as Component,
			headerContainer: () => new StaticComponent(["TOP"]),
			widgetContainerBelow: () => new StaticComponent(["HINT"]),
			footer: () => currentFooter,
			terminal: fakeTerminal.owner,
			dimensions: { columns: 30, rows: 12 },
		});

		// Render with stale footer: proxy swallows the error, returns empty rows.
		expect(() => renderer.render()).not.toThrow();

		// Pi reinstalls the footer; the resolver picks up the new component.
		currentFooter = freshFooter;
		renderer.render();
		const lines = fakeTerminal.patches.map((p) => stripAnsi(p.ansi));
		expect(lines.some((line) => line.includes("FRESH-FOOTER"))).toBe(true);
		renderer.dispose();
	});

	it("composites Pi overlays (sidebar / modal / notification) on top of the buffer", async () => {
		const yoga = await loadYoga();
		const chat = ChatPager.create(yoga);
		const fakeTerminal = new FakeTerminal();
		const overlay: { component: Component; options?: OverlayOptions; hidden?: boolean; focusOrder?: number } = {
			component: new StaticComponent(["│ SIDEBAR │"]),
			options: { width: 10, anchor: "top-right", maxHeight: "100%" },
			focusOrder: 1,
		};
		const overlayHost = { overlayStack: [overlay] };
		const renderer = new OwnedShellRenderer({
			yoga,
			chat,
			editorContainer: () => new StaticEditor() as Component,
			headerContainer: () => new StaticComponent(["TOP"]),
			widgetContainerBelow: () => new StaticComponent(["HINT"]),
			footer: () => new StaticComponent(["FOOTER"]),
			terminal: fakeTerminal.owner,
			dimensions: { columns: 30, rows: 12 },
			overlayHost,
		});

		renderer.render();
		const lines = fakeTerminal.patches.map((p) => stripAnsi(p.ansi));
		expect(lines.some((line) => line.includes("SIDEBAR"))).toBe(true);
		renderer.dispose();
	});

	it("paints queued messages as a Cathedral banner in the chat area", async () => {
		const yoga = await loadYoga();
		const chat = ChatPager.create(yoga);
		const fakeTerminal = new FakeTerminal();
		const pendingMessages = new StaticComponent([]);

		const renderer = new OwnedShellRenderer({
			yoga,
			chat,
			editorContainer: () => new StaticEditor() as Component,
			headerContainer: () => new StaticComponent(["TOP"]),
			widgetContainerBelow: () => new StaticComponent(["HINT"]),
			pendingMessagesContainer: () => pendingMessages as Component,
			footer: () => new StaticComponent(["FOOTER"]),
			terminal: fakeTerminal.owner,
			dimensions: { columns: 40, rows: 14 },
		});

		// First render: no banner
		renderer.render();
		const linesBefore = fakeTerminal.patches.map((p) => stripAnsi(p.ansi));
		expect(linesBefore.some((line) => line.includes("QUEUED"))).toBe(false);

		// Simulate Pi queueing a follow-up
		pendingMessages.rows = ["", "Follow-up: fix the sidebar", "↳ hint"];

		// Re-render: Cathedral banner should appear with QUEUED label and message text
		renderer.render();
		const linesAfter = fakeTerminal.patches.map((p) => stripAnsi(p.ansi));
		expect(linesAfter.some((line) => line.includes("Follow-up: fix the sidebar"))).toBe(true);

		renderer.dispose();
	});

	it("clears queued banner when container becomes empty", async () => {
		const yoga = await loadYoga();
		const chat = ChatPager.create(yoga);
		const fakeTerminal = new FakeTerminal();
		const pendingMessages = new StaticComponent(["", "Steering: test msg", "↳ hint"]);

		const renderer = new OwnedShellRenderer({
			yoga,
			chat,
			editorContainer: () => new StaticEditor() as Component,
			headerContainer: () => new StaticComponent(["TOP"]),
			widgetContainerBelow: () => new StaticComponent(["HINT"]),
			pendingMessagesContainer: () => pendingMessages as Component,
			footer: () => new StaticComponent(["FOOTER"]),
			terminal: fakeTerminal.owner,
			dimensions: { columns: 30, rows: 14 },
		});

		// Render with content
		renderer.render();
		const linesWith = fakeTerminal.patches.map((p) => stripAnsi(p.ansi));
		expect(linesWith.some((line) => line.includes("Steering: test msg"))).toBe(true);

		// Clear and re-render
		pendingMessages.rows = [];
		renderer.render();
		const linesWithout = fakeTerminal.patches.map((p) => stripAnsi(p.ansi));
		expect(linesWithout.some((line) => line.includes("Steering"))).toBe(false);

		renderer.dispose();
	});
});

function stripAnsi(text: string): string {
	return text.replace(/\u001b\[[0-9;]*m/g, "");
}
