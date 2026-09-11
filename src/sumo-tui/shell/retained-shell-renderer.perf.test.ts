import { describe, expect, it } from "vitest";
import { loadYoga } from "../layout/yoga.js";
import { graphemeSegmentationCount } from "../runtime/diagnostics.js";
import type { TerminalPatch } from "../runtime/terminal-controller.js";
import type { ChatBlock, ChatMessageViewModel } from "../transcript/view-model.js";
import { ChatPager } from "../widgets/chat-pager.js";
import type { ShellRenderable, ShellTerminalSessionOwner } from "./contracts.js";
import { RetainedShellRenderer } from "./retained-shell-renderer.js";

/**
 * #520: the working-indicator tick repaints only the above-editor row. When
 * anything on the repaint path bails into `render()`, every tick re-composites
 * the whole shell -- including grapheme segmentation of the visible transcript
 * -- and a long session pegs a host core while the RPC child is idle.
 *
 * This exercises the host's real tick rate (200 consecutive ticks) against a
 * ~700 KB transcript with a visible overlay entry, which is the state that used
 * to force a full render per tick. Bounds are structural (no relayout, no
 * sibling leaf re-render) plus the process-local grapheme-segmentation count,
 * so the test fails on the work done rather than on wall-clock alone.
 */

class CountingComponent implements ShellRenderable {
	public constructor(public rows: readonly string[]) {}
	public renderCalls = 0;
	public invalidate(): void {}
	public render(width: number): string[] {
		this.renderCalls += 1;
		return this.rows.map((row) => (row.length >= width ? row.slice(0, width) : row.padEnd(width, " ")));
	}
	public resetRenderCalls(): void {
		this.renderCalls = 0;
	}
}

class FakeShellTerminal implements ShellTerminalSessionOwner {
	public patches: TerminalPatch[] = [];
	public writeFramePatches(patches: readonly TerminalPatch[]): void {
		this.patches = [...patches];
	}
}

const TICKS = 200;
const COLS = 100;
const ROWS = 30;
const TRANSCRIPT_BYTES = 700 * 1024;

function longTranscript(targetBytes: number): ChatMessageViewModel[] {
	const messages: ChatMessageViewModel[] = [];
	let bytes = 0;
	let index = 0;
	while (bytes < targetBytes) {
		const source = `// file-${index}\n${Array.from({ length: 120 }, (_, line) => `const value_${line} = compute(${line}, "payload ${index}");`).join("\n")}\n`;
		const blocks: ChatBlock[] = [
			{ type: "markdown", text: `## step ${index}\n\nProse body for step ${index} with enough words to wrap across the chat width.` },
			{ type: "code", lang: "ts", source, collapsed: false },
		];
		bytes += source.length + 200;
		messages.push({
			id: `m${index}`,
			role: index % 2 === 0 ? "user" : "sumo",
			displayName: index % 2 === 0 ? "you" : "sumo",
			timestamp: new Date(1_700_000_000_000 + index * 1000),
			blocks,
		});
		index += 1;
	}
	return messages;
}

describe("RetainedShellRenderer idle indicator ticks", () => {
	it("bounds grapheme segmentation and full renders across 200 ticks on a 700 KB transcript", async () => {
		const yoga = await loadYoga();
		const chat = ChatPager.create(yoga);
		const terminal = new FakeShellTerminal();
		const aboveEditor = new CountingComponent(["", "WORKING 0"]);
		const overlay = new CountingComponent(["NOTICE"]);
		const topChrome = new CountingComponent(["TOP"]);
		const editor = new CountingComponent(["┌EDITOR┐", "│ >    │", "└EDITOR┘"]);
		const belowEditor = new CountingComponent(["HINT"]);
		const footer = new CountingComponent(["FOOTER"]);
		const renderer = new RetainedShellRenderer({
			yoga,
			chat: { pager: chat },
			editor: () => editor,
			topChromeFallback: () => ({ component: topChrome }),
			belowEditorWidgets: () => belowEditor,
			footer: () => footer,
			aboveEditorWidgets: () => aboveEditor,
			// A visible overlay-stack entry (the host's selector/notice slot) is
			// what routed the tick through `repaintRegion`'s overlay guard.
			overlayHost: {
				overlayStack: [
					{ component: overlay, options: { anchor: "top-left", row: 3, width: "100%" }, focusOrder: 10 },
				],
			},
			terminal,
			viewport: { columns: COLS, rows: ROWS },
		});

		try {
			renderer.render();
			const transcript = longTranscript(TRANSCRIPT_BYTES);
			chat.replaceViewModels(transcript);
			renderer.render();
			for (const component of [aboveEditor, topChrome, editor, belowEditor, footer]) component.resetRenderCalls();

			const segmentStart = graphemeSegmentationCount();
			const started = performance.now();
			for (let tick = 1; tick <= TICKS; tick += 1) {
				aboveEditor.rows = ["", `WORKING ${tick}`];
				renderer.repaintRegion("aboveEditor");
			}
			const elapsedMs = performance.now() - started;
			const segmentationCalls = graphemeSegmentationCount() - segmentStart;

			// One changed row per tick (the spinner); two runs per row is headroom
			// for a styled multi-escape indicator. The overlay rows are outside the
			// repaint rect and must not be re-segmented. Measured before #520:
			// 62,400 calls (312/tick) because every tick re-rendered the screen.
			expect(segmentationCalls).toBeLessThanOrEqual(TICKS * 2);
			// A full render re-composites every sibling leaf; 200 narrow repaints
			// must leave them untouched.
			expect(topChrome.renderCalls).toBe(0);
			expect(editor.renderCalls).toBe(0);
			expect(belowEditor.renderCalls).toBe(0);
			expect(footer.renderCalls).toBe(0);
			// Wall-clock ceiling, secondary to the call-count assertions above: the
			// fixed path measured 0.8 ms/tick and the overlay-guard regression
			// 6.3 ms/tick in this harness. It is deliberately loose so a loaded CI
			// worker cannot flake it; the structural assertions are the real gate.
			expect(elapsedMs).toBeLessThan(2_000);

			const frame = renderer.getLastFrame();
			if (!frame) throw new Error("renderer produced no frame");
			const rendered = Array.from({ length: ROWS }, (_, row) => frame.toPlainRow(row)).join("\n");
			expect(rendered).toContain(`WORKING ${TICKS}`);
			expect(rendered).toContain("NOTICE");
		} finally {
			renderer.dispose();
		}
	});
}, 30_000);