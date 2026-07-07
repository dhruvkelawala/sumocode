import { CURSOR_MARKER } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
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

class CountingComponent extends StaticComponent {
	public renderCalls = 0;
	public override render(width: number): string[] {
		this.renderCalls += 1;
		return super.render(width);
	}
	public resetRenderCalls(): void {
		this.renderCalls = 0;
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

type RootYogaNodeForTest = {
	readonly calculateLayout: (...args: unknown[]) => unknown;
};

type RendererInternalsForTest = {
	readonly root: {
		readonly yogaNode: RootYogaNodeForTest;
	};
};

function rootYogaNodeForTest(renderer: RetainedShellRenderer): RootYogaNodeForTest {
	// Test-only access to the renderer's root Yoga node is the observable seam
	// for Plan 050's layout-skipping contract.
	const rendererInternals = renderer as unknown as RendererInternalsForTest;
	return rendererInternals.root.yogaNode;
}

function frameRows(renderer: RetainedShellRenderer): string[] {
	const frame = renderer.getLastFrame();
	if (!frame) throw new Error("renderer did not produce a frame");
	const { rows } = frame.getDimensions();
	return Array.from({ length: rows }, (_, row) => frame.toPlainRow(row));
}

function rowsContaining(rows: readonly string[], needle: string): number[] {
	return rows.flatMap((row, index) => (row.includes(needle) ? [index] : []));
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

	describe("above-editor narrow repaint", () => {
		it("repaints changed above-editor rows without relayout and converges with a full render", async () => {
			const aboveEditor = new StaticComponent(["", "INDICATOR-A"]);
			const { terminal, renderer } = await createHarness({ aboveEditorWidgets: () => aboveEditor });
			const calculateLayout = vi.spyOn(rootYogaNodeForTest(renderer), "calculateLayout");
			let fresh: Harness | undefined;
			try {
				renderer.render();
				const initialRows = frameRows(renderer);
				const aboveRows = rowsContaining(initialRows, "INDICATOR-A");
				expect(aboveRows).toEqual([expect.any(Number)]);
				const aboveStart = aboveRows[0];
				if (aboveStart === undefined) throw new Error("above-editor row was not rendered");
				const aboveEnd = aboveRows.at(-1);
				if (aboveEnd === undefined) throw new Error("above-editor row was not rendered");

				calculateLayout.mockClear();
				aboveEditor.rows = ["", "INDICATOR-B"];
				renderer.repaintRegion("aboveEditor");

				expect(calculateLayout).not.toHaveBeenCalled();
				expect(terminal.patches).toHaveLength(1);
				for (const patch of terminal.patches) {
					expect(patch.type).toBe("row");
					expect(patch.row).toBeGreaterThanOrEqual(aboveStart);
					expect(patch.row).toBeLessThanOrEqual(aboveEnd);
				}
				expect(stripAnsi(terminal.patches[0]?.ansi ?? "")).toContain("INDICATOR-B");

				const narrowRows = frameRows(renderer);
				expect(narrowRows.join("\n")).not.toContain("INDICATOR-A");
				expect(rowsContaining(narrowRows, "INDICATOR-B")).toEqual(aboveRows);

				calculateLayout.mockRestore();
				renderer.render();
				fresh = await createHarness({ aboveEditorWidgets: () => new StaticComponent(["", "INDICATOR-B"]) });
				fresh.renderer.render();

				expect(narrowRows).toEqual(frameRows(fresh.renderer));
				expect(frameRows(renderer)).toEqual(frameRows(fresh.renderer));
			} finally {
				calculateLayout.mockRestore();
				fresh?.renderer.dispose();
				renderer.dispose();
			}
		});

		it("falls back to a full render when an overlay is visible during repaint", async () => {
			const aboveEditor = new StaticComponent(["", "INDICATOR-A"]);
			const { renderer } = await createHarness({
				aboveEditorWidgets: () => aboveEditor,
				overlayHost: {
					overlayStack: [
						{
							component: new StaticComponent(["MODAL"]),
							options: { width: 10, anchor: "center" },
						},
					],
				},
			});
			const calculateLayout = vi.spyOn(rootYogaNodeForTest(renderer), "calculateLayout");
			try {
				renderer.render();
				calculateLayout.mockClear();

				aboveEditor.rows = ["", "INDICATOR-B"];
				renderer.repaintRegion("aboveEditor");

				expect(calculateLayout).toHaveBeenCalledTimes(1);
				expect(frameRows(renderer).join("\n")).toContain("MODAL");
				expect(frameRows(renderer).join("\n")).toContain("INDICATOR-B");
			} finally {
				calculateLayout.mockRestore();
				renderer.dispose();
			}
		});

		it("uses only the above-editor leaf for ten static indicator repaints, with no relayout or full-root composite", async () => {
			const topChrome = new CountingComponent(["TOP"]);
			const aboveEditor = new CountingComponent(["", "STATIC-INDICATOR-0"]);
			const editor = new CountingComponent(["┌EDITOR┐", "│ >    │", "└EDITOR┘"]);
			const belowEditor = new CountingComponent(["HINT"]);
			const footer = new CountingComponent(["FOOTER"]);
			const { terminal, renderer } = await createHarness({
				topChromeFallback: () => ({ component: topChrome }),
				aboveEditorWidgets: () => aboveEditor,
				editor: () => editor,
				belowEditorWidgets: () => belowEditor,
				footer: () => footer,
			});
			const calculateLayout = vi.spyOn(rootYogaNodeForTest(renderer), "calculateLayout");
			try {
				renderer.render();
				calculateLayout.mockClear();
				for (const component of [topChrome, aboveEditor, editor, belowEditor, footer]) {
					component.resetRenderCalls();
				}

				for (let tick = 1; tick <= 10; tick += 1) {
					aboveEditor.rows = ["", `STATIC-INDICATOR-${tick}`];
					renderer.repaintRegion("aboveEditor");
				}

				expect(calculateLayout).not.toHaveBeenCalled();
				// Spying on the imported compositor is not robust after RetainedShellRenderer
				// captures the ESM binding. A full-root composite would re-render these
				// sibling leaves; ten narrow repaints leave them untouched.
				expect(topChrome.renderCalls).toBe(0);
				expect(editor.renderCalls).toBe(0);
				expect(belowEditor.renderCalls).toBe(0);
				expect(footer.renderCalls).toBe(0);
				expect(aboveEditor.renderCalls).toBe(10);
				expect(terminal.patches).toHaveLength(1);
				expect(terminal.patches[0]?.type).toBe("row");
				expect(stripAnsi(terminal.patches[0]?.ansi ?? "")).toContain("STATIC-INDICATOR-10");
			} finally {
				calculateLayout.mockRestore();
				renderer.dispose();
			}
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
