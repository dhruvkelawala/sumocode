import { CURSOR_MARKER } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { loadYoga, type Yoga } from "../layout/yoga.js";
import type { TerminalPatch } from "../runtime/terminal-controller.js";
import { ChatPager } from "../widgets/chat-pager.js";
import type {
	RetainedShellRendererOptions,
	ShellRenderable,
	ShellSelectionPass,
	ShellTerminalSessionOwner,
} from "./contracts.js";
import { RetainedShellRenderer } from "./retained-shell-renderer.js";

/**
 * Direct characterization tests for RetainedShellRenderer (plan 049).
 *
 * These pin the renderer's own contracts — cursor masking, overlay clipping,
 * pending-message swallow-on-error, row-diff-only patching, dispose semantics
 * and the selection pass — through the ShellTerminalSessionOwner boundary and
 * getLastFrame(), never through private state. Plan 050 (working-indicator
 * render-path change) relies on these as its regression net.
 *
 * Assertions avoid absolute chrome row indices: rows are located by content
 * from the same render so cosmetic layout tweaks don't invalidate them.
 */

class StaticComponent implements ShellRenderable {
	public rows: readonly string[];
	public constructor(rows: readonly string[]) {
		this.rows = rows;
	}
	public invalidate(): void {}
	public render(width: number): string[] {
		return this.rows.map((row) => (row.length >= width ? row.slice(0, width) : row.padEnd(width, " ")));
	}
}

class StaticEditor implements ShellRenderable {
	public invalidate(): void {}
	public render(width: number): string[] {
		const top = `┌${"─".repeat(Math.max(0, width - 2))}┐`;
		const mid = `│ > ${" ".repeat(Math.max(0, width - 5))}│`;
		const bot = `└${"─".repeat(Math.max(0, width - 2))}┘`;
		return [top, mid, bot];
	}
}

class CursorEditor implements ShellRenderable {
	public invalidate(): void {}
	public render(width: number): string[] {
		const top = `┌${"─".repeat(Math.max(0, width - 2))}┐`;
		const mid = `│ > ${CURSOR_MARKER}${" ".repeat(Math.max(0, width - 5))}│`;
		const bot = `└${"─".repeat(Math.max(0, width - 2))}┘`;
		return [top, mid, bot];
	}
}

/**
 * Shell-only terminal double. `ShellTerminalSessionOwner` documents that test
 * doubles which never exercise selection copy only need `writeFramePatches`.
 */
class FakeShellTerminal implements ShellTerminalSessionOwner {
	/** Patches from the most recent writeFramePatches call. */
	public patches: TerminalPatch[] = [];
	/** One entry per writeFramePatches call (doubles as a call counter). */
	public cursors: ({ row: number; col: number } | null)[] = [];
	public writeFramePatches(patches: readonly TerminalPatch[], cursor: { row: number; col: number } | null): void {
		this.patches = [...patches];
		this.cursors.push(cursor);
	}
}

interface Harness {
	readonly yoga: Yoga;
	readonly chat: ChatPager;
	readonly terminal: FakeShellTerminal;
	readonly renderer: RetainedShellRenderer;
}

const COLS = 30;
const ROWS = 14;

async function createHarness(
	overrides: Partial<RetainedShellRendererOptions> = {},
): Promise<Harness> {
	const yoga = await loadYoga();
	const chat = ChatPager.create(yoga);
	const terminal = new FakeShellTerminal();
	const renderer = new RetainedShellRenderer({
		yoga,
		chat: { pager: chat },
		editor: () => new StaticEditor(),
		topChromeFallback: () => ({ component: new StaticComponent(["TOP"]) }),
		belowEditorWidgets: () => new StaticComponent(["HINT"]),
		footer: () => new StaticComponent(["FOOTER"]),
		terminal,
		viewport: { columns: COLS, rows: ROWS },
		...overrides,
	});
	return { yoga, chat, terminal, renderer };
}

function stripAnsi(text: string): string {
	return text.replace(/\u001b\[[0-9;]*m/g, "");
}

describe("RetainedShellRenderer", () => {
	describe("first render", () => {
		it("emits a full frame of row patches through the terminal contract", async () => {
			const { terminal, renderer } = await createHarness();

			renderer.render();

			// No previous frame → every screen row is written exactly once.
			expect(terminal.cursors).toHaveLength(1);
			expect(terminal.patches).toHaveLength(ROWS);
			for (const patch of terminal.patches) {
				expect(patch.type).toBe("row");
				expect(patch.startCol).toBe(0);
			}
			const lines = terminal.patches.map((patch) => stripAnsi(patch.ansi));
			expect(lines[0]?.startsWith("TOP")).toBe(true);
			expect(lines.some((line) => line.startsWith("FOOTER"))).toBe(true);
			expect(lines.some((line) => line.startsWith("HINT"))).toBe(true);
			expect(lines.some((line) => line.startsWith("┌"))).toBe(true);
			expect(renderer.getLastFrame()?.getDimensions()).toEqual({ rows: ROWS, cols: COLS });

			renderer.dispose();
		});
	});

	describe("overlay cursor masking", () => {
		it("passes the composite hardware cursor through when no overlay is visible", async () => {
			const { terminal, renderer } = await createHarness({ editor: () => new CursorEditor() });

			renderer.render();

			const cursor = terminal.cursors.at(-1);
			expect(cursor).not.toBeNull();
			// The cursor must sit on the editor's marker row/column. Locate the
			// row by content instead of hardcoding chrome positions.
			const midPatch = terminal.patches.find((patch) => stripAnsi(patch.ansi).startsWith("│ >"));
			expect(midPatch).toBeDefined();
			expect(cursor?.row).toBe(midPatch?.row);
			expect(cursor?.col).toBe(4);

			renderer.dispose();
		});

		it("nulls the hardware cursor while a visible overlay is composited", async () => {
			const { terminal, renderer } = await createHarness({
				editor: () => new CursorEditor(),
				overlayHost: {
					overlayStack: [
						{
							component: new StaticComponent(["MODAL"]),
							options: { width: 10, anchor: "center" },
							focusOrder: 1,
						},
					],
				},
			});

			renderer.render();

			expect(terminal.cursors.at(-1)).toBeNull();
			expect(terminal.patches.some((patch) => stripAnsi(patch.ansi).includes("MODAL"))).toBe(true);

			renderer.dispose();
		});

		it("keeps the hardware cursor when the only overlay is hidden", async () => {
			const { terminal, renderer } = await createHarness({
				editor: () => new CursorEditor(),
				overlayHost: {
					overlayStack: [
						{
							component: new StaticComponent(["MODAL"]),
							options: { width: 10, anchor: "center" },
							hidden: true,
						},
					],
				},
			});

			renderer.render();

			expect(terminal.cursors.at(-1)).not.toBeNull();
			expect(terminal.patches.some((patch) => stripAnsi(patch.ansi).includes("MODAL"))).toBe(false);

			renderer.dispose();
		});
	});

	describe("overlay clipping", () => {
		it("clips an oversized overlay to the viewport bounds", async () => {
			// 100 lines of 60 'X' columns against a 30x14 viewport, anchored above
			// the top edge: both axes must clamp.
			const oversized = {
				render: (_width: number): string[] => Array.from({ length: 100 }, () => "X".repeat(60)),
				invalidate: (): void => {},
			};
			const { terminal, renderer } = await createHarness({
				overlayHost: {
					overlayStack: [
						{
							component: oversized,
							options: { width: 200, anchor: "top-left", row: -5 },
						},
					],
				},
			});

			renderer.render();

			// Every emitted patch stays inside the viewport.
			for (const patch of terminal.patches) {
				expect(patch.row).toBeGreaterThanOrEqual(0);
				expect(patch.row).toBeLessThan(ROWS);
				expect(stripAnsi(patch.ansi).length).toBeLessThanOrEqual(COLS);
			}
			// The overlay still painted up to the bounds — full width, clipped.
			const frame = renderer.getLastFrame();
			expect(frame?.getDimensions()).toEqual({ rows: ROWS, cols: COLS });
			expect(frame?.toPlainRow(0)).toBe("X".repeat(COLS));
			expect(frame?.toPlainRow(ROWS - 1)).toBe("X".repeat(COLS));

			renderer.dispose();
		});
	});

	describe("pending-message painting", () => {
		it("completes the render when the pending-messages container render throws", async () => {
			const throwing: ShellRenderable = {
				invalidate(): void {},
				render(): string[] {
					throw new Error("pending container exploded");
				},
			};
			const { terminal, renderer } = await createHarness({ pendingMessageWidgets: () => throwing });

			expect(() => renderer.render()).not.toThrow();

			// The rest of the frame still painted.
			const lines = terminal.patches.map((patch) => stripAnsi(patch.ansi));
			expect(lines).toHaveLength(ROWS);
			expect(lines[0]?.startsWith("TOP")).toBe(true);
			expect(lines.some((line) => line.startsWith("FOOTER"))).toBe(true);
			expect(lines.some((line) => line.startsWith("┌"))).toBe(true);

			renderer.dispose();
		});

		it("completes the render when the pending-messages resolver itself throws", async () => {
			const { terminal, renderer } = await createHarness({
				pendingMessageWidgets: () => {
					throw new Error("container not ready yet");
				},
			});

			expect(() => renderer.render()).not.toThrow();
			expect(terminal.patches.some((patch) => stripAnsi(patch.ansi).startsWith("FOOTER"))).toBe(true);

			renderer.dispose();
		});
	});

	describe("row-diff only", () => {
		it("emits no patches when nothing changed between renders", async () => {
			const { terminal, renderer } = await createHarness();

			renderer.render();
			renderer.render();

			expect(terminal.cursors).toHaveLength(2);
			expect(terminal.patches).toHaveLength(0);

			renderer.dispose();
		});

		it("patches only the single changed middle row, never scroll sequences", async () => {
			const hint = new StaticComponent(["HINT"]);
			const { terminal, renderer } = await createHarness({ belowEditorWidgets: () => hint });

			renderer.render();
			const hintRow = terminal.patches.find((patch) => stripAnsi(patch.ansi).startsWith("HINT"))?.row;
			expect(hintRow).toBeDefined();
			// Interior row: a scroll-region regression would drag neighbours along.
			expect(hintRow).toBeGreaterThan(0);
			expect(hintRow).toBeLessThan(ROWS - 1);

			hint.rows = ["HINT-CHANGED"];
			renderer.render();

			expect(terminal.patches).toHaveLength(1);
			expect(terminal.patches[0]?.row).toBe(hintRow);
			expect(terminal.patches[0]?.type).toBe("row");

			renderer.dispose();
		});
	});

	describe("dispose", () => {
		it("is idempotent and render() after dispose is a silent no-op", async () => {
			const { terminal, renderer } = await createHarness();

			renderer.render();
			expect(terminal.cursors).toHaveLength(1);

			renderer.dispose();
			expect(() => renderer.dispose()).not.toThrow();

			// characterization: documents current behavior, see report — render()
			// after dispose() returns early without throwing and writes nothing.
			expect(() => renderer.render()).not.toThrow();
			expect(terminal.cursors).toHaveLength(1);
		});
	});

	describe("selection pass", () => {
		it("applies the selection highlight to every composited frame", async () => {
			const selection: ShellSelectionPass = {
				applySelectionHighlight(buffer): void {
					for (let col = 0; col < 5; col += 1) {
						buffer.updateCellAttrs(2, col, (attrs) => ({ ...attrs, inverse: true }));
					}
				},
			};
			const { terminal, renderer } = await createHarness({ selection });

			renderer.render();

			const frame = renderer.getLastFrame();
			expect(frame).toBeDefined();
			for (let col = 0; col < 5; col += 1) {
				expect(frame?.getCell(2, col).attrs.inverse).toBe(true);
			}
			// Cells outside the selected region stay unmarked.
			expect(frame?.getCell(2, 5).attrs.inverse).toBe(false);
			expect(frame?.getCell(3, 0).attrs.inverse).toBe(false);

			// The pass runs on the fresh buffer of EVERY render, not once.
			renderer.render();
			expect(renderer.getLastFrame()?.getCell(2, 0).attrs.inverse).toBe(true);
			expect(terminal.cursors).toHaveLength(2);

			renderer.dispose();
		});
	});
});
