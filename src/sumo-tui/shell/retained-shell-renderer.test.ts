import { CURSOR_MARKER } from "@earendil-works/pi-tui";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createAttrs } from "../render/cell.js";
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
/* oxlint-disable anti-slop/no-chained-type-assertions -- test doubles cast minimal stub objects to Pi context types. */
/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- stub shape is exercised by the assertions below. */

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
	// oxlint-disable-next-line no-control-regex -- intentional ESC byte match to strip ANSI styling in assertions
	return text.replace(/\u001b\[[0-9;]*m/g, "");
}

type RootYogaNodeForTest = {
	readonly calculateLayout: (...args: unknown[]) => void;
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

		it("repaints only above-editor rows when an overlay is visible, leaving the overlay painted", async () => {
			const aboveEditor = new StaticComponent(["", "INDICATOR-A"]);
			const { terminal, renderer } = await createHarness({
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
				const initialRows = frameRows(renderer);
				const overlayRow = rowsContaining(initialRows, "MODAL")[0];
				if (overlayRow === undefined) throw new Error("overlay row was not rendered");
				calculateLayout.mockClear();

				aboveEditor.rows = ["", "INDICATOR-B"];
				renderer.repaintRegion("aboveEditor");

				// #520: a visible overlay must not force the tick back through the full
				// transcript render.
				expect(calculateLayout).not.toHaveBeenCalled();
				const rows = frameRows(renderer);
				expect(rows.join("\n")).toContain("MODAL");
				expect(rows.join("\n")).toContain("INDICATOR-B");
				expect(rows.join("\n")).not.toContain("INDICATOR-A");
				// The overlay's own rows are untouched by the narrow diff.
				expect(rows[overlayRow]).toBe(initialRows[overlayRow]);
				expect(terminal.patches).toHaveLength(1);
			} finally {
				calculateLayout.mockRestore();
				renderer.dispose();
			}
		});

		it("restores overlay rows that intersect the repainted region", async () => {
			const aboveEditor = new StaticComponent(["", "INDICATOR-A"]);
			const { terminal, renderer } = await createHarness({
				aboveEditorWidgets: () => aboveEditor,
				overlayHost: {
					overlayStack: [
						{
							component: new StaticComponent(Array.from({ length: ROWS }, () => "OVERLAY")),
							options: { anchor: "top-left", row: 0, width: "100%" },
						},
					],
				},
			});
			const calculateLayout = vi.spyOn(rootYogaNodeForTest(renderer), "calculateLayout");
			try {
				renderer.render();
				const initialRows = frameRows(renderer);
				// The overlay covers every row, so it also covers the above-editor leaf.
				expect(rowsContaining(initialRows, "INDICATOR-A")).toEqual([]);
				calculateLayout.mockClear();

				aboveEditor.rows = ["", "INDICATOR-B"];
				renderer.repaintRegion("aboveEditor");

				expect(calculateLayout).not.toHaveBeenCalled();
				// The leaf repaint cleared the rows the overlay owns; the narrow path
				// must re-composite the overlay over them (no visible change, so no
				// patches) instead of letting the indicator bleed through.
				expect(frameRows(renderer)).toEqual(initialRows);
				expect(terminal.patches).toHaveLength(0);
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

	describe("repaint diagnostics", () => {
		it("names each narrow-repaint fallback guard and records per-render cost fields", async () => {
			const previousDiagFile = process.env.SUMO_TUI_DIAG_FILE;
			const tempDir = mkdtempSync(join(tmpdir(), "sumocode-repaint-"));
			const file = join(tempDir, "manual.jsonl");
			process.env.SUMO_TUI_DIAG_FILE = file;
			const viewport = { columns: COLS, rows: ROWS };
			const aboveEditor = new StaticComponent(["", "INDICATOR-A"]);
			// The selection pass only bails the narrow path when it would repaint a
			// row outside the above-editor rect differently than the frame already
			// holds: arm it, run one tick, then disarm so the next tick is narrow.
			let selectionMutates = false;
			const selection: ShellSelectionPass = {
				applySelectionHighlight(buffer): void {
					if (!selectionMutates) return;
					buffer.setCell(0, 0, { char: "S", attrs: createAttrs({ bold: true }) });
				},
			};
			const { renderer } = await createHarness({ aboveEditorWidgets: () => aboveEditor, viewport, selection });
			try {
				renderer.repaintRegion("aboveEditor"); // no previous frame
				renderer.render();

				viewport.rows = ROWS + 1;
				renderer.repaintRegion("aboveEditor"); // viewport mismatch
				viewport.rows = ROWS;
				renderer.render();

				selectionMutates = true;
				aboveEditor.rows = ["", "INDICATOR-B"];
				renderer.repaintRegion("aboveEditor"); // selection mismatch
				renderer.render();

				selectionMutates = false;
				aboveEditor.rows = ["", "INDICATOR-C"];
				renderer.repaintRegion("aboveEditor"); // narrow

				const events = readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
				const fallbackGuards = events
					.filter((entry) => entry.event === "owned_shell_repaint_fallback")
					.map((entry) => entry.guard);
				expect(fallbackGuards).toEqual(["no_previous_frame", "viewport_mismatch", "selection_mismatch"]);

				const narrow = events.filter((entry) => entry.event === "owned_shell_repaint_narrow").at(-1);
				expect(narrow).toMatchObject({ leaf: "aboveEditor", patchCount: 1, overlayCount: 0 });
				expect(narrow.repaintMs).toBeGreaterThanOrEqual(0);
				expect(narrow.segmentationCalls).toBeGreaterThanOrEqual(1);

				const full = events.filter((entry) => entry.event === "owned_shell_render").at(-1);
				expect(full.renderMs).toBeGreaterThanOrEqual(0);
				expect(full.segmentationCalls).toBeGreaterThanOrEqual(1);
			} finally {
				if (previousDiagFile === undefined) delete process.env.SUMO_TUI_DIAG_FILE;
				else process.env.SUMO_TUI_DIAG_FILE = previousDiagFile;
				rmSync(tempDir, { recursive: true, force: true });
				renderer.dispose();
			}
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
