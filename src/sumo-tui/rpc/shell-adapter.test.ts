import { describe, expect, it, vi } from "vitest";
import type { CellBuffer } from "../render/buffer.js";
import type { MouseEvent } from "../input/mouse.js";
import { ChatPager } from "../widgets/chat-pager.js";
import { RpcShellAdapter } from "./shell-adapter.js";
import type { RpcHostChromeState } from "./state.js";

function state(overrides: Partial<RpcHostChromeState> = {}): RpcHostChromeState {
	return {
		isStreaming: false,
		isCompacting: false,
		messageCount: 0,
		pendingMessageCount: 0,
		hasMessages: true,
		taskPartialCount: 0,
		costUsd: 0,
		...overrides,
	};
}

class SpyTerminal {
	public readonly clipboardSequences: string[] = [];
	public writeFramePatches(): void {}
	public writeClipboardSequence(sequence: string): boolean {
		this.clipboardSequences.push(sequence);
		return true;
	}
}

class SpyNotifications {
	public readonly notifications: { message: string; level?: string }[] = [];
	public invalidate(): void {}
	public render(): string[] {
		return [];
	}
	public notify(message: string, level?: string): number {
		this.notifications.push({ message, level });
		return this.notifications.length;
	}
}

async function makeAdapter(options: { terminal?: SpyTerminal; notifications?: SpyNotifications } = {}): Promise<RpcShellAdapter> {
	return RpcShellAdapter.create({
		terminal: options.terminal ?? { writeFramePatches: () => undefined },
		viewport: { columns: 100, rows: 30 },
		initialState: state(),
		initialTranscript: { messages: [] },
		notifications: options.notifications,
	});
}

/** Locate the (row, col) of the first occurrence of `needle` in a rendered frame. */
function findText(frame: CellBuffer, needle: string): { row: number; col: number } {
	const { rows } = frame.getDimensions();
	for (let row = 0; row < rows; row += 1) {
		const col = frame.toPlainRow(row).indexOf(needle);
		if (col >= 0) return { row, col };
	}
	throw new Error(`text not found in frame: ${needle}`);
}

function mouseEvent(type: MouseEvent["type"], row: number, col: number): MouseEvent {
	return { type, button: 0, row, col, modifiers: { shift: false, alt: false, ctrl: false } };
}

describe("RpcShellAdapter chat update", () => {
	it("replaces the pager when no transcriptRevision is supplied (back-compat: no sink wired)", async () => {
		const adapter = await makeAdapter();
		const replaceViewModels = vi.spyOn(ChatPager.prototype, "replaceViewModels");
		try {
			replaceViewModels.mockClear();
			adapter.update({
				state: state(),
				transcript: { messages: [{ id: "m1", role: "sumo", displayName: "SUMO", blocks: [{ type: "markdown", text: "hi" }] }] },
			});
			expect(replaceViewModels).toHaveBeenCalledTimes(1);
		} finally {
			replaceViewModels.mockRestore();
			adapter.dispose();
		}
	});

	it("skips replaceViewModels when the transcriptRevision was already applied via the chat sink", async () => {
		const adapter = await makeAdapter();
		const replaceViewModels = vi.spyOn(ChatPager.prototype, "replaceViewModels");
		try {
			replaceViewModels.mockClear();
			const sink = adapter.getChatSink();
			const message = { id: "m1", role: "sumo" as const, displayName: "SUMO", blocks: [{ type: "markdown" as const, text: "hi" }] };
			sink.addViewModel(message);

			adapter.update({
				state: state(),
				transcript: { messages: [message] },
				transcriptRevision: 1,
			});

			expect(replaceViewModels).not.toHaveBeenCalled();
		} finally {
			replaceViewModels.mockRestore();
			adapter.dispose();
		}
	});

	it("keeps skipping replaceViewModels across multiple revisioned updates in a row", async () => {
		const adapter = await makeAdapter();
		const replaceViewModels = vi.spyOn(ChatPager.prototype, "replaceViewModels");
		try {
			replaceViewModels.mockClear();
			const sink = adapter.getChatSink();
			const first = { id: "m1", role: "sumo" as const, displayName: "SUMO", blocks: [{ type: "markdown" as const, text: "hi" }] };
			sink.addViewModel(first);
			adapter.update({ state: state(), transcript: { messages: [first] }, transcriptRevision: 1 });

			const second = { id: "m2", role: "user" as const, displayName: "YOU", blocks: [{ type: "markdown" as const, text: "second" }] };
			sink.addViewModel(second);
			adapter.update({ state: state(), transcript: { messages: [first, second] }, transcriptRevision: 2 });

			expect(replaceViewModels).not.toHaveBeenCalled();
		} finally {
			replaceViewModels.mockRestore();
			adapter.dispose();
		}
	});

	it("falls back to a full replace for any update that arrives without a transcriptRevision (no sink wired for that call)", async () => {
		const adapter = await makeAdapter();
		const replaceViewModels = vi.spyOn(ChatPager.prototype, "replaceViewModels");
		try {
			replaceViewModels.mockClear();
			const sink = adapter.getChatSink();
			const first = { id: "m1", role: "sumo" as const, displayName: "SUMO", blocks: [{ type: "markdown" as const, text: "hi" }] };
			sink.addViewModel(first);
			adapter.update({ state: state(), transcript: { messages: [first] }, transcriptRevision: 1 });
			expect(replaceViewModels).not.toHaveBeenCalled();

			// A caller/path that pushes a transcript WITHOUT a revision (e.g. a
			// legacy/test caller not going through the revisioned controller)
			// must still get the safe, always-correct full replace.
			const rehydrated = { id: "m2", role: "user" as const, displayName: "YOU", blocks: [{ type: "markdown" as const, text: "fresh session" }] };
			adapter.update({ state: state(), transcript: { messages: [rehydrated] } });

			expect(replaceViewModels).toHaveBeenCalledTimes(1);
		} finally {
			replaceViewModels.mockRestore();
			adapter.dispose();
		}
	});

	it("getChatSink exposes the same pager the renderer paints (round-trips through update)", async () => {
		const adapter = await makeAdapter();
		try {
			const sink = adapter.getChatSink();
			sink.addViewModel({ id: "m1", role: "sumo", displayName: "SUMO", blocks: [{ type: "markdown", text: "sink message" }] });
			adapter.render();
			const frame = adapter.getLastFrame();
			const text = frame ? Array.from({ length: 30 }, (_, row) => frame.toPlainRow(row)).join("\n") : "";
			expect(text).toContain("sink message");
		} finally {
			adapter.dispose();
		}
	});
});

describe("RpcShellAdapter mouse drag-select + OSC52 copy", () => {
	it("turns a drag press/move/up over chat text into a selection, auto-copies via OSC52, and shows a copied notification", async () => {
		const terminal = new SpyTerminal();
		const notifications = new SpyNotifications();
		const adapter = await makeAdapter({ terminal, notifications });
		try {
			adapter.getChatSink().addViewModel({
				id: "m1",
				role: "sumo",
				displayName: "SUMO",
				blocks: [{ type: "markdown", text: "selectable drag target" }],
			});
			adapter.render();
			const frame = adapter.getLastFrame();
			expect(frame).toBeDefined();
			const start = findText(frame!, "selectable drag target");
			const end = { row: start.row, col: start.col + "selectable drag target".length - 1 };

			expect(adapter.handleMouseEvent(mouseEvent("down", start.row, start.col))).toBe(true);
			expect(adapter.handleMouseEvent(mouseEvent("drag", end.row, end.col))).toBe(true);
			expect(adapter.handleMouseEvent(mouseEvent("up", end.row, end.col))).toBe(true);

			expect(terminal.clipboardSequences.length).toBe(1);
			expect(terminal.clipboardSequences[0]).toMatch(/^\x1b\]52;c;/);
			const decoded = Buffer.from(terminal.clipboardSequences[0]!.replace(/^\x1b\]52;c;/, "").replace(/\x1b\\$/, ""), "base64").toString("utf8");
			expect(decoded).toContain("selectable drag target");

			expect(notifications.notifications).toContainEqual(expect.objectContaining({ message: "copied", level: "success" }));
		} finally {
			adapter.dispose();
		}
	});

	it("renders the active selection via the shell's composite selection pass (inverted cells)", async () => {
		const adapter = await makeAdapter();
		try {
			adapter.getChatSink().addViewModel({
				id: "m1",
				role: "sumo",
				displayName: "SUMO",
				blocks: [{ type: "markdown", text: "highlight me please" }],
			});
			adapter.render();
			const before = adapter.getLastFrame();
			const start = findText(before!, "highlight me please");
			const end = { row: start.row, col: start.col + "highlight me please".length - 1 };

			adapter.handleMouseEvent(mouseEvent("down", start.row, start.col));
			adapter.handleMouseEvent(mouseEvent("drag", end.row, end.col));
			// Still dragging (no "up" yet): selection is live but not yet copied.
			adapter.render();

			const frame = adapter.getLastFrame();
			expect(frame).toBeDefined();
			expect(frame!.getCell(start.row, start.col).attrs.inverse).toBe(true);
			expect(frame!.getCell(end.row, end.col).attrs.inverse).toBe(true);
		} finally {
			adapter.dispose();
		}
	});

	it("clears the selection when a new transcript is applied (chat sink application repaints the same rows)", async () => {
		const terminal = new SpyTerminal();
		const adapter = await makeAdapter({ terminal });
		try {
			adapter.getChatSink().addViewModel({
				id: "m1",
				role: "sumo",
				displayName: "SUMO",
				blocks: [{ type: "markdown", text: "clear me on repaint" }],
			});
			adapter.render();
			const start = findText(adapter.getLastFrame()!, "clear me on repaint");
			const end = { row: start.row, col: start.col + "clear me on repaint".length - 1 };

			adapter.handleMouseEvent(mouseEvent("down", start.row, start.col));
			adapter.handleMouseEvent(mouseEvent("drag", end.row, end.col));
			adapter.handleMouseEvent(mouseEvent("up", end.row, end.col));
			expect(terminal.clipboardSequences.length).toBe(1);

			// A fresh transcript update (e.g. a subsequent streamed message)
			// must drop the held selection so a later copy-key press or drag
			// doesn't operate on stale coordinates.
			adapter.update({
				state: state(),
				transcript: { messages: [{ id: "m2", role: "sumo", displayName: "SUMO", blocks: [{ type: "markdown", text: "next message" }] }] },
			});

			expect(adapter.handleSelectionKey({ key: "c", cmd: true })).toBe(false);
			expect(terminal.clipboardSequences.length).toBe(1);
		} finally {
			adapter.dispose();
		}
	});

	it("keeps wheel scroll routed to the pager instead of starting a selection", async () => {
		const terminal = new SpyTerminal();
		const adapter = await makeAdapter({ terminal });
		try {
			for (let index = 0; index < 40; index += 1) {
				adapter.getChatSink().addViewModel({
					id: `m${index}`,
					role: "sumo",
					displayName: "SUMO",
					blocks: [{ type: "markdown", text: `scroll body ${index}` }],
				});
			}
			adapter.render();

			const scrollEvent: MouseEvent = { type: "scroll", scrollDir: "up", row: 10, col: 10, modifiers: { shift: false, alt: false, ctrl: false } };
			adapter.handleMouseEvent(scrollEvent);
			adapter.render();

			// A scroll event must never be interpreted as a selection drag: no
			// clipboard write should ever happen from wheel input alone.
			expect(terminal.clipboardSequences.length).toBe(0);
		} finally {
			adapter.dispose();
		}
	});
});
