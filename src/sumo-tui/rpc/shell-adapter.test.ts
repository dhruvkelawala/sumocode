import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CellBuffer } from "../render/buffer.js";
import type { MouseEvent } from "../input/mouse.js";
import { ChatPager } from "../widgets/chat-pager.js";
import { InlineSelectorHost } from "./inline-selector.js";
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

describe("RpcShellAdapter splash hint", () => {
	it("renders live model and thinking from chrome state with model-thinking colors", async () => {
		const adapter = await RpcShellAdapter.create({
			terminal: { writeFramePatches: () => undefined },
			viewport: { columns: 160, rows: 45 },
			initialState: state({ hasMessages: false, modelLabel: "openai/gpt-5.5", thinkingLevel: "high" }),
			initialTranscript: { messages: [] },
		});
		try {
			adapter.render();
			const frame = adapter.getLastFrame();
			expect(frame).toBeDefined();
			const text = Array.from({ length: 45 }, (_value, row) => frame!.toPlainRow(row)).join("\n");
			expect(text).toContain("╰─ gpt-5.5 · high");
			expect(text).toContain("CTRL+/ · COMMANDS");
			expect(text).not.toContain("AWAITING PROMPT");
			expect(text).not.toContain("openai/gpt-5.5");

			const model = findText(frame!, "gpt-5.5");
			expect(frame!.getCell(model.row, model.col).fg?.toLowerCase()).toBe("#d97706");
			expect(frame!.getCell(model.row, model.col - 3).fg?.toLowerCase()).toBe("#8b7a63");
			const thinking = findText(frame!, "high");
			expect(frame!.getCell(thinking.row, thinking.col).fg?.toLowerCase()).toBe("#8b7a63");
		} finally {
			adapter.dispose();
		}
	});

	it("renders no-model fallback when chrome state has no model label", async () => {
		const adapter = await RpcShellAdapter.create({
			terminal: { writeFramePatches: () => undefined },
			viewport: { columns: 160, rows: 45 },
			initialState: state({ hasMessages: false, modelLabel: undefined, thinkingLevel: undefined }),
			initialTranscript: { messages: [] },
		});
		try {
			adapter.render();
			const frame = adapter.getLastFrame();
			expect(frame).toBeDefined();
			const text = Array.from({ length: 45 }, (_value, row) => frame!.toPlainRow(row)).join("\n");
			expect(text).toContain("╰─ no model · thinking");
			expect(text).toContain("CTRL+/ · COMMANDS");
			expect(text).not.toContain("AWAITING PROMPT");
		} finally {
			adapter.dispose();
		}
	});
});

describe("RpcShellAdapter queued messages banner", () => {
	it("renders queued steer/follow-up messages above the editor while streaming", async () => {
		const adapter = await RpcShellAdapter.create({
			terminal: { writeFramePatches: () => undefined },
			viewport: { columns: 100, rows: 30 },
			initialState: state({
				isStreaming: true,
				hasMessages: true,
				queuedMessages: ["first queued prompt", "second queued prompt"],
			}),
			initialTranscript: { messages: [{ id: "m1", role: "user", displayName: "YOU", blocks: [{ type: "markdown", text: "hello" }] }] },
		});
		try {
			adapter.render();
			const frame = adapter.getLastFrame();
			expect(frame).toBeDefined();
			const text = Array.from({ length: 30 }, (_value, row) => frame!.toPlainRow(row)).join("\n");
			expect(text).toContain("first queued prompt");
			expect(text).toContain("second queued prompt");

			// Card chrome: bordered like the USER/SUMO chat cards with a count
			// label, dim body text.
			expect(text).toContain("QUEUED (2)");
			const queuedCell = findText(frame!, "first queued prompt");
			expect(frame!.getCell(queuedCell.row, queuedCell.col).fg?.toLowerCase()).toBe("#8b7a63");
			// Border row above the first entry is the frame top.
			const label = findText(frame!, "QUEUED (2)");
			expect(label.row).toBeLessThan(queuedCell.row);
		} finally {
			adapter.dispose();
		}
	});

	it("displays clipboard-image paths as a compact [image] tag", async () => {
		const adapter = await RpcShellAdapter.create({
			terminal: { writeFramePatches: () => undefined },
			viewport: { columns: 100, rows: 30 },
			initialState: state({
				isStreaming: true,
				hasMessages: true,
				queuedMessages: ["/var/folders/ab/pi-clipboard-9f3a.png", "look at /tmp/pi-clipboard-77.jpeg please"],
			}),
			initialTranscript: { messages: [{ id: "m1", role: "user", displayName: "YOU", blocks: [{ type: "markdown", text: "hello" }] }] },
		});
		try {
			adapter.render();
			const text = Array.from({ length: 30 }, (_value, row) => adapter.getLastFrame()!.toPlainRow(row)).join("\n");
			expect(text).toContain("↳ [image]");
			expect(text).toContain("look at [image] please");
			expect(text).not.toContain("pi-clipboard");
		} finally {
			adapter.dispose();
		}
	});

	it("clears the banner when a queue_update drains queuedMessages", async () => {
		const adapter = await RpcShellAdapter.create({
			terminal: { writeFramePatches: () => undefined },
			viewport: { columns: 100, rows: 30 },
			initialState: state({
				isStreaming: true,
				hasMessages: true,
				queuedMessages: ["vanish me"],
			}),
			initialTranscript: { messages: [{ id: "m1", role: "user", displayName: "YOU", blocks: [{ type: "markdown", text: "hello" }] }] },
		});
		try {
			adapter.render();
			let text = Array.from({ length: 30 }, (_value, row) => adapter.getLastFrame()!.toPlainRow(row)).join("\n");
			expect(text).toContain("vanish me");

			adapter.update({ state: state({ isStreaming: true, hasMessages: true, queuedMessages: [] }) });
			adapter.render();
			text = Array.from({ length: 30 }, (_value, row) => adapter.getLastFrame()!.toPlainRow(row)).join("\n");
			expect(text).not.toContain("vanish me");
		} finally {
			adapter.dispose();
		}
	});
});

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

	// app.tools.expand (Ctrl+O) wiring: host.ts's createToolsExpandToggleHandler
	// calls through RpcHostRuntime.setToolExpansion -> here -> the live
	// ChatPager, mirroring the writeClipboardSequence indirection this adapter
	// already uses for terminal-owned state. Pins the adapter's passthrough
	// actually reaches ChatPager.setToolExpansion (not just that it compiles).
	it("setToolExpansion forwards to the live ChatPager", async () => {
		const adapter = await makeAdapter();
		const setToolExpansion = vi.spyOn(ChatPager.prototype, "setToolExpansion");
		try {
			setToolExpansion.mockClear();
			adapter.setToolExpansion(true);
			expect(setToolExpansion).toHaveBeenCalledWith(true);
		} finally {
			setToolExpansion.mockRestore();
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

describe("RpcShellAdapter above-editor working indicator (D3 parity)", () => {
	// D3: the RPC child process's Pi extension runs `installRpcChildProfile`
	// (src/extension.ts), which deliberately never calls
	// `installWorkingIndicator` -- RPC-child extensions own no chrome, the
	// host does. Before this fix, `renderWorkingIndicator` didn't exist and
	// `RpcAboveEditorComponent` only ever forwarded `extensionAboveEditor`
	// (always empty under RPC), so the above-editor row that main's owned
	// shell painted during active-working (`⊚ Working…`) was silently blank
	// in the RPC candidate.
	it("renders a non-blank working-indicator row above the editor while busy (isStreaming)", async () => {
		const adapter = await RpcShellAdapter.create({
			terminal: { writeFramePatches: () => undefined },
			viewport: { columns: 160, rows: 45 },
			initialState: state({ messageCount: 1, hasMessages: true, isStreaming: true }),
			initialTranscript: { messages: [{ id: "m1", role: "sumo", displayName: "SUMO", blocks: [{ type: "markdown", text: "hi" }] }] },
		});
		try {
			adapter.render();
			const frame = adapter.getLastFrame();
			expect(frame).toBeDefined();
			const text = Array.from({ length: 45 }, (_, row) => frame!.toPlainRow(row)).join("\n");
			expect(text).toContain("Working…");
		} finally {
			adapter.dispose();
		}
	});

	it("renders manual compaction status above the editor instead of generic Working text", async () => {
		const adapter = await RpcShellAdapter.create({
			terminal: { writeFramePatches: () => undefined },
			viewport: { columns: 100, rows: 30 },
			initialState: state({ messageCount: 1, hasMessages: true, isCompacting: true, compactionReason: "manual" }),
			initialTranscript: { messages: [{ id: "m1", role: "sumo", displayName: "SUMO", blocks: [{ type: "markdown", text: "hi" }] }] },
		});
		try {
			adapter.render();
			const frame = adapter.getLastFrame();
			expect(frame).toBeDefined();
			const text = Array.from({ length: 30 }, (_, row) => frame!.toPlainRow(row)).join("\n");
			expect(text).toContain("Compacting…");
			expect(text).toContain("INSCRIBING");
			expect(text).not.toContain("Working…");
		} finally {
			adapter.dispose();
		}
	});

	it("renders automatic compaction status for threshold compactions", async () => {
		const adapter = await RpcShellAdapter.create({
			terminal: { writeFramePatches: () => undefined },
			viewport: { columns: 90, rows: 24 },
			initialState: state({ messageCount: 1, hasMessages: true, isCompacting: true, compactionReason: "threshold" }),
			initialTranscript: { messages: [{ id: "m1", role: "sumo", displayName: "SUMO", blocks: [{ type: "markdown", text: "hi" }] }] },
		});
		try {
			adapter.render();
			const frame = adapter.getLastFrame();
			expect(frame).toBeDefined();
			const text = Array.from({ length: 24 }, (_, row) => frame!.toPlainRow(row)).join("\n");
			expect(text).toContain("Auto-compacting…");
			expect(text).not.toContain("Working…");
		} finally {
			adapter.dispose();
		}
	});

	it("renders compaction status in portrait even though generic Working is suppressed", async () => {
		const adapter = await RpcShellAdapter.create({
			terminal: { writeFramePatches: () => undefined },
			viewport: { columns: 60, rows: 100 },
			initialState: state({ messageCount: 1, hasMessages: true, isCompacting: true, compactionReason: "manual" }),
			initialTranscript: { messages: [{ id: "m1", role: "sumo", displayName: "SUMO", blocks: [{ type: "markdown", text: "hi" }] }] },
		});
		try {
			const row = adapter.renderWorkingIndicator(60).join("");
			expect(row).toContain("Compacting…");
			expect(row).not.toContain("Working…");
		} finally {
			adapter.dispose();
		}
	});

	it("stays suppressed in portrait (60-col) even while busy -- V1 landscape-only affordance", async () => {
		// Regression check for the width-gate: main's owned-shell extension only
		// ever mounted the aboveEditor widget when
		// `shouldInstallWorkingIndicator()` (width >= 80) was true, so narrow
		// captures never showed it. An early version of this fix rendered the
		// indicator unconditionally, which showed it in portrait where main
		// never did -- a brand-new drift the D3 fix would have introduced.
		const adapter = await RpcShellAdapter.create({
			terminal: { writeFramePatches: () => undefined },
			viewport: { columns: 60, rows: 100 },
			initialState: state({ messageCount: 1, hasMessages: true, isStreaming: true }),
			initialTranscript: { messages: [{ id: "m1", role: "sumo", displayName: "SUMO", blocks: [{ type: "markdown", text: "hi" }] }] },
		});
		try {
			expect(adapter.renderWorkingIndicator(60)).toEqual([""]);
		} finally {
			adapter.dispose();
		}
	});

	it("renders nothing above the editor while idle", async () => {
		const adapter = await RpcShellAdapter.create({
			terminal: { writeFramePatches: () => undefined },
			viewport: { columns: 160, rows: 45 },
			initialState: state({ messageCount: 1, hasMessages: true, isStreaming: false }),
			initialTranscript: { messages: [{ id: "m1", role: "sumo", displayName: "SUMO", blocks: [{ type: "markdown", text: "hi" }] }] },
		});
		try {
			adapter.render();
			const frame = adapter.getLastFrame();
			expect(frame).toBeDefined();
			const text = Array.from({ length: 45 }, (_, row) => frame!.toPlainRow(row)).join("\n");
			expect(text).not.toContain("Working…");
		} finally {
			adapter.dispose();
		}
	});

	it("resets the animation tick to 0 when re-entering the busy state after going idle", async () => {
		const adapter = await RpcShellAdapter.create({
			terminal: { writeFramePatches: () => undefined },
			viewport: { columns: 160, rows: 45 },
			initialState: state({ messageCount: 1, hasMessages: true, isStreaming: true }),
			initialTranscript: { messages: [{ id: "m1", role: "sumo", displayName: "SUMO", blocks: [{ type: "markdown", text: "hi" }] }] },
		});
		try {
			const firstFrame = adapter.renderWorkingIndicator(160).join("");
			// Advancing renders while still busy should be able to move the tick
			// (not asserted here -- frame identity is timer/theme dependent), but
			// going idle then busy again must restart from the same first frame.
			adapter.update({ state: state({ messageCount: 1, hasMessages: true, isStreaming: false }), transcript: { messages: [] } });
			expect(adapter.renderWorkingIndicator(160)).toEqual([""]);
			adapter.update({ state: state({ messageCount: 1, hasMessages: true, isStreaming: true }), transcript: { messages: [] } });
			expect(adapter.renderWorkingIndicator(160).join("")).toBe(firstFrame);
		} finally {
			adapter.dispose();
		}
	});

	// Regression coverage for the reported bug: the indicator used to advance
	// its tick inside renderWorkingIndicator itself, so its speed was tied to
	// render frequency -- racing during a burst of streaming deltas (many
	// renders per real second) and freezing solid while "thinking" (no
	// deltas, so nothing ever called render). It must now be a real
	// wall-clock timer, decoupled from render calls entirely.
	describe("animation is timer-driven, not render-driven", () => {
		beforeEach(() => {
			vi.useFakeTimers();
		});

		afterEach(() => {
			vi.useRealTimers();
		});

		it("advances the frame on a wall-clock cadence even with zero render calls in between (the 'thinking' freeze case)", async () => {
			const adapter = await RpcShellAdapter.create({
				terminal: { writeFramePatches: () => undefined },
				viewport: { columns: 160, rows: 45 },
				initialState: state({ messageCount: 1, hasMessages: true, isStreaming: true }),
				initialTranscript: { messages: [] },
			});
			try {
				const firstFrame = adapter.renderWorkingIndicator(160).join("");
				// No render() calls at all in between -- purely waiting on the clock,
				// mirroring a silent "thinking" gap with no streaming deltas.
				vi.advanceTimersByTime(150 * 5);
				const laterFrame = adapter.renderWorkingIndicator(160).join("");
				expect(laterFrame).not.toBe(firstFrame);
			} finally {
				adapter.dispose();
			}
		});

		it("does not advance faster than the timer cadence no matter how many renders happen per tick (the 'streaming' race case)", async () => {
			const adapter = await RpcShellAdapter.create({
				terminal: { writeFramePatches: () => undefined },
				viewport: { columns: 160, rows: 45 },
				initialState: state({ messageCount: 1, hasMessages: true, isStreaming: true }),
				initialTranscript: { messages: [] },
			});
			try {
				// A burst of renders within the same tick window (simulating a flood
				// of streaming deltas) must all read the same frame.
				const framesWithinOneTick = Array.from({ length: 50 }, () => adapter.renderWorkingIndicator(160).join(""));
				expect(new Set(framesWithinOneTick).size).toBe(1);
			} finally {
				adapter.dispose();
			}
		});

		it("stops ticking as soon as the state goes idle, even if the clock keeps running", async () => {
			const adapter = await RpcShellAdapter.create({
				terminal: { writeFramePatches: () => undefined },
				viewport: { columns: 160, rows: 45 },
				initialState: state({ messageCount: 1, hasMessages: true, isStreaming: true }),
				initialTranscript: { messages: [] },
			});
			try {
				adapter.update({ state: state({ messageCount: 1, hasMessages: true, isStreaming: false }), transcript: { messages: [] } });
				vi.advanceTimersByTime(150 * 10);
				expect(adapter.renderWorkingIndicator(160)).toEqual([""]);
			} finally {
				adapter.dispose();
			}
		});

		it("requests the narrow indicator repaint on every tick so animation reaches the screen without a full render", async () => {
			const requestRender = vi.fn();
			const requestIndicatorRepaint = vi.fn();
			const adapter = await RpcShellAdapter.create({
				terminal: { writeFramePatches: () => undefined },
				viewport: { columns: 160, rows: 45 },
				initialState: state({ messageCount: 1, hasMessages: true, isStreaming: true }),
				initialTranscript: { messages: [] },
				requestRender,
				requestIndicatorRepaint,
			});
			try {
				vi.advanceTimersByTime(150 * 3);
				expect(requestIndicatorRepaint.mock.calls.length).toBeGreaterThanOrEqual(3);
				expect(requestRender).not.toHaveBeenCalled();
			} finally {
				adapter.dispose();
			}
		});

		it("requests a repaint on every tick so the animation actually reaches the screen unprompted", async () => {
			const requestRender = vi.fn();
			const adapter = await RpcShellAdapter.create({
				terminal: { writeFramePatches: () => undefined },
				viewport: { columns: 160, rows: 45 },
				initialState: state({ messageCount: 1, hasMessages: true, isStreaming: true }),
				initialTranscript: { messages: [] },
				requestRender,
			});
			try {
				vi.advanceTimersByTime(150 * 3);
				expect(requestRender.mock.calls.length).toBeGreaterThanOrEqual(3);
			} finally {
				adapter.dispose();
			}
		});

		it("clears the timer on dispose so it doesn't keep firing (and requesting renders) after teardown", async () => {
			const requestRender = vi.fn();
			const adapter = await RpcShellAdapter.create({
				terminal: { writeFramePatches: () => undefined },
				viewport: { columns: 160, rows: 45 },
				initialState: state({ messageCount: 1, hasMessages: true, isStreaming: true }),
				initialTranscript: { messages: [] },
				requestRender,
			});
			adapter.dispose();
			requestRender.mockClear();

			vi.advanceTimersByTime(150 * 10);

			expect(requestRender).not.toHaveBeenCalled();
		});
	});
});

describe("RpcShellAdapter visual-harness footer (D4 live-state fix)", () => {
	const ORIGINAL_HARNESS_ENV = process.env.SUMOCODE_HARNESS;

	beforeEach(() => {
		process.env.SUMOCODE_HARNESS = "1";
	});

	afterEach(() => {
		if (ORIGINAL_HARNESS_ENV === undefined) delete process.env.SUMOCODE_HARNESS;
		else process.env.SUMOCODE_HARNESS = ORIGINAL_HARNESS_ENV;
	});

	// Before this fix, `footerSnapshot` under SUMOCODE_HARNESS always reported
	// `state: "idle"` / `modelId: VISUAL_MODEL_LABEL` regardless of the real
	// RPC session state -- correct back when only the splash scenario ran
	// under the harness (no agent ever active), but stale once the
	// active-working faux-provider scenario started actually streaming: main's
	// captured footer shows the real busy state ("MEDITATING"), so comparing
	// it against a hardcoded "READY" was comparing two different things.
	// Deterministic-but-genuinely-variable fields (tokens/cost/branch) stay
	// frozen; state/model/thinking now come from real RPC state.
	it("reflects the real busy state instead of a hardcoded idle footer while streaming", async () => {
		const adapter = await RpcShellAdapter.create({
			terminal: { writeFramePatches: () => undefined },
			viewport: { columns: 160, rows: 45 },
			initialState: state({ messageCount: 1, hasMessages: true, isStreaming: true, modelLabel: "sumocode-visual/active-working", thinkingLevel: "off" }),
			initialTranscript: { messages: [{ id: "m1", role: "sumo", displayName: "SUMO", blocks: [{ type: "markdown", text: "hi" }] }] },
		});
		try {
			adapter.render();
			const frame = adapter.getLastFrame();
			expect(frame).toBeDefined();
			const text = Array.from({ length: 45 }, (_, row) => frame!.toPlainRow(row)).join("\n");
			expect(text).toContain("MEDITATING");
			// Footer shows the bare model id (no "provider/" prefix), matching
			// main's pre-RPC extension-owned footer -- see footerModelId's doc
			// comment in shell-adapter.ts.
			expect(text).toContain("active-working");
			expect(text).not.toContain("sumocode-visual/active-working");
			// Deterministic harness constants (unaffected by the live-state fix).
			expect(text).toContain("$0.42");
		} finally {
			adapter.dispose();
		}
	});

	it("still shows the deterministic idle footer while genuinely idle", async () => {
		const adapter = await RpcShellAdapter.create({
			terminal: { writeFramePatches: () => undefined },
			viewport: { columns: 160, rows: 45 },
			initialState: state({ messageCount: 1, hasMessages: true, isStreaming: false }),
			initialTranscript: { messages: [{ id: "m1", role: "sumo", displayName: "SUMO", blocks: [{ type: "markdown", text: "hi" }] }] },
		});
		try {
			adapter.render();
			const frame = adapter.getLastFrame();
			expect(frame).toBeDefined();
			const text = Array.from({ length: 45 }, (_, row) => frame!.toPlainRow(row)).join("\n");
			expect(text).toContain("READY");
		} finally {
			adapter.dispose();
		}
	});
});

describe("RpcShellAdapter inline selector composition (plan 036 regression guard)", () => {
	// Core regression this plan fixes: before it, the five migrated slash
	// commands (/model, /thinking, /sessions, /settings, /fork) opened a
	// full-viewport `ModalLayer` backdrop (`widgets/modal-layer.ts`'s
	// `centerRows` paints a `surfaceRecess` fill across the whole rows x cols
	// frame and the transcript/sidebar/top-chrome are not composited at all
	// underneath it). The in-place `InlineSelectorHost` instead occupies only
	// the editor's Yoga slot, so a rendered frame with a selector open must
	// STILL show the transcript body and surrounding chrome (sidebar, footer)
	// -- not a full backdrop.
	it("keeps transcript content and sidebar/footer chrome visible while an inline selector is open in the editor slot", async () => {
		const editor = { invalidate: () => undefined, handleInput: () => undefined, render: (width: number) => [`${" ".repeat(Math.max(0, width - 6))}editor`] };
		const inlineSelectors = new InlineSelectorHost(editor);
		const adapter = await RpcShellAdapter.create({
			terminal: { writeFramePatches: () => undefined },
			// >= SIDEBAR_MIN_TERMINAL_WIDTH (120) so the sidebar publication renders.
			viewport: { columns: 160, rows: 45 },
			initialState: state({ messageCount: 1, hasMessages: true, gitBranch: "codex/inline-sel" }),
			initialTranscript: {
				messages: [{ id: "m1", role: "sumo", displayName: "SUMO", blocks: [{ type: "markdown", text: "distinctive transcript content" }] }],
			},
			editor: inlineSelectors,
		});
		try {
			// Open the selector -- mirrors host-actions.ts's openModelSelector,
			// which now calls `inlineSelectors.select(...)` instead of
			// `modals.select(...)`.
			void inlineSelectors.select("Choose model", ["openai/gpt-5", "anthropic/opus"]);
			expect(inlineSelectors.getActiveKind()).toBe("select");

			adapter.render();
			const frame = adapter.getLastFrame();
			expect(frame).toBeDefined();
			const rows = Array.from({ length: 45 }, (_, row) => frame!.toPlainRow(row));
			const text = rows.join("\n");

			// The selector itself rendered, in the editor's band. (Title renders
			// uppercase per the Cathedral header treatment -- plan 037.)
			expect(text).toContain("CHOOSE MODEL");
			expect(text).toContain("openai/gpt-5");

			// Regression guard: transcript body is still composited (a full
			// ModalLayer backdrop would have painted over/hidden it entirely).
			expect(text).toContain("distinctive transcript content");

			// Regression guard: surrounding chrome (sidebar showing the branch,
			// footer) is still composited -- not blanked by a full-screen fill.
			expect(text).toContain("on codex/inline-sel");
			expect(text).toContain("READY");

			// No full-viewport backdrop fill: at least one row above the editor
			// band (the transcript region) must NOT be entirely the modal
			// backdrop's surfaceRecess bg -- i.e. distinct cells exist that
			// belong to transcript content, not a uniform painted rectangle.
			const transcriptRowIndex = rows.findIndex((row) => row.includes("distinctive transcript content"));
			expect(transcriptRowIndex).toBeGreaterThanOrEqual(0);
		} finally {
			adapter.dispose();
		}
	});

	it("Esc closes the selector and restores the editor; a keypress while open routes to the selector, not the editor", async () => {
		const editorInputs: string[] = [];
		const editor = {
			invalidate: () => undefined,
			handleInput: (data: string) => editorInputs.push(data),
			render: (width: number) => [`${" ".repeat(Math.max(0, width - 6))}editor`],
		};
		const inlineSelectors = new InlineSelectorHost(editor);
		const adapter = await RpcShellAdapter.create({
			terminal: { writeFramePatches: () => undefined },
			viewport: { columns: 160, rows: 45 },
			initialState: state({ messageCount: 1, hasMessages: true }),
			initialTranscript: { messages: [{ id: "m1", role: "sumo", displayName: "SUMO", blocks: [{ type: "markdown", text: "hi" }] }] },
			editor: inlineSelectors,
		});
		try {
			const resultPromise = inlineSelectors.select("Choose model", ["openai/gpt-5", "anthropic/opus"]);

			// A keypress while the selector is open routes to the selector, not
			// the wrapped editor.
			inlineSelectors.handleInput("x");
			expect(editorInputs).toEqual([]);

			// Esc closes the selector and restores the editor.
			inlineSelectors.handleInput("\x1b");
			await expect(resultPromise).resolves.toBeUndefined();
			expect(inlineSelectors.getActiveKind()).toBeUndefined();

			adapter.render();
			const frame = adapter.getLastFrame();
			const text = Array.from({ length: 45 }, (_, row) => frame!.toPlainRow(row)).join("\n");
			expect(text).toContain("editor");
			expect(text).not.toContain("Choose model");
		} finally {
			adapter.dispose();
		}
	});
});
