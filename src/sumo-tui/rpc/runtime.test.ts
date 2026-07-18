import type { Component } from "@earendil-works/pi-tui";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { afterEach, describe, expect, it, vi } from "vitest";
import { INPUT_FRAME_PLACEHOLDER } from "../../cathedral/input-frame.js";
import { activeThemeColors, resetThemeRegistryForTests, setActiveTheme } from "../../themes/index.js";
import { SharedInputRouter } from "../input/shared-input-router.js";
import { TerminalSessionOwner } from "../runtime/terminal-controller.js";
import { RpcHostEditorController } from "./editor.js";
import { submitRpcPrompt } from "./host.js";
import { renderRpcHostFrameForTest, RpcHostRuntime } from "./runtime.js";
import { RpcShellAdapter } from "./shell-adapter.js";
import type { RpcHostChromeState } from "./state.js";
import { rpcVisualFixtureFromEnv } from "./visual-fixtures.js";
import { ChatPager } from "../widgets/chat-pager.js";


function state(overrides: Partial<RpcHostChromeState> = {}): RpcHostChromeState {
	return {
		sessionId: "session-a",
		modelLabel: "test/model",
		thinkingLevel: "minimal",
		isStreaming: false,
		isCompacting: false,
		messageCount: 0,
		pendingMessageCount: 0,
		hasMessages: false,
		gitBranch: "codex/rpc-host",
		taskPartialCount: 0,
		contextTokens: 0,
		contextWindow: 100_000,
		costUsd: 0,
		...overrides,
	};
}

class FakeOutput {
	public readonly isTTY = true;
	public readonly columns = 90;
	public readonly rows = 24;
	public readonly chunks: string[] = [];

	public write(data: string): void {
		this.chunks.push(data);
	}

	public on(_event: "resize", _listener: () => void): void {}
	public off(_event: "resize", _listener: () => void): void {}
}

class FakeInput {
	public readonly isTTY = true;
	public readonly rawModes: boolean[] = [];
	public readonly encodings: string[] = [];
	public pauseCount = 0;
	private listener: ((data: string | Buffer) => void) | undefined;

	public on(_event: "data", listener: (data: string | Buffer) => void): void {
		this.listener = listener;
	}

	public off(_event: "data", listener: (data: string | Buffer) => void): void {
		if (this.listener === listener) this.listener = undefined;
	}

	public setRawMode(enabled: boolean): void {
		this.rawModes.push(enabled);
	}

	public setEncoding(encoding: "utf8"): void {
		this.encodings.push(encoding);
	}

	public resume(): void {}

	public pause(): void {
		this.pauseCount += 1;
	}

	public emit(data: string | Buffer): void {
		this.listener?.(data);
	}
}

class FakeEditor implements Component {
	public readonly inputs: string[] = [];

	public invalidate(): void {}

	public handleInput(data: string): void {
		this.inputs.push(data);
	}

	public render(width: number): string[] {
		return [`${" ".repeat(Math.max(0, width - 6))}editor`];
	}
}

class CursorCaptureTerminal {
	public readonly cursors: ({ row: number; col: number } | null)[] = [];

	public startRetainedSession(): void {}
	public exitTerminal(): void {}
	public writeFramePatches(_patches: readonly unknown[], cursor: { row: number; col: number } | null): void {
		this.cursors.push(cursor);
	}
}

class StaticComponent implements Component {
	public constructor(private readonly rows: readonly string[]) {}
	public invalidate(): void {}
	public render(_width: number): string[] {
		return [...this.rows];
	}
}

class ActiveModalComponent implements Component {
	public readonly inputs: string[] = [];
	public invalidate(): void {}
	public getActiveKind(): string {
		return "select";
	}
	public handleInput(data: string): void {
		this.inputs.push(data);
	}
	public render(_width: number): string[] {
		return ["active modal"];
	}
}

describe("RPC host retained runtime frame", () => {
	it("renders the Cathedral splash instead of the provisional empty shell", async () => {
		const frame = await renderRpcHostFrameForTest({
			state: state(),
			transcript: { messages: [] },
		}, 160, 45);

		const plain = Array.from({ length: 45 }, (_, row) => frame.toPlainRow(row)).join("\n");
		expect(plain).toContain('"Meow meow meow... meow meow"');
		expect(plain).toContain("SUMOCODE V0.3.0");
		expect(plain).not.toContain("SUMOCODE RPC");
		expect(plain).not.toContain("empty transcript");
		expect(plain).not.toContain("rpc host");
	});

	it("paints a software cursor for live RPC splash editor rows", async () => {
		const frame = await renderRpcHostFrameForTest({
			state: state(),
			transcript: { messages: [] },
		}, 160, 45, { editor: new RpcHostEditorController() });

		const placeholderRow = Array.from({ length: 45 }, (_value, row) => row)
			.find((row) => frame.toPlainRow(row).includes(INPUT_FRAME_PLACEHOLDER));
		expect(placeholderRow).toBeDefined();

		const cursorBg = activeThemeColors().accent.toLowerCase();
		const { cols } = frame.getDimensions();
		const hasSoftwareCursor = Array.from({ length: cols }, (_value, col) => frame.getCell(placeholderRow!, col))
			.some((cell) => cell.bg?.toLowerCase() === cursorBg);
		expect(hasSoftwareCursor).toBe(true);
	});

	it("paints a software cursor for live active RPC editor rows", async () => {
		const editor = new RpcHostEditorController();
		editor.setText("editing prompt");
		const frame = await renderRpcHostFrameForTest({
			state: state({ messageCount: 1, hasMessages: true }),
			transcript: {
				messages: [{
					id: "message-1",
					role: "user",
					displayName: "YOU",
					blocks: [{ type: "markdown", text: "active chat body" }],
				}],
			},
		}, 90, 24, { editor });

		const editorRow = Array.from({ length: 24 }, (_value, row) => row)
			.find((row) => frame.toPlainRow(row).includes("│ > editing prompt"));
		expect(editorRow).toBeDefined();

		const cursorBg = activeThemeColors().accent.toLowerCase();
		const { cols } = frame.getDimensions();
		const hasSoftwareCursor = Array.from({ length: cols }, (_value, col) => frame.getCell(editorRow!, col))
			.some((cell) => cell.bg?.toLowerCase() === cursorBg);
		expect(hasSoftwareCursor).toBe(true);
	});

	it("renders transcript messages through the retained ChatPager buffer", async () => {
		const frame = await renderRpcHostFrameForTest({
			state: state({ messageCount: 1, hasMessages: true }),
			transcript: {
				messages: [{
					id: "message-1",
					role: "user",
					displayName: "YOU",
					blocks: [{ type: "markdown", text: "visible rpc transcript body" }],
				}],
			},
		}, 90, 24);

		const plain = Array.from({ length: 24 }, (_, row) => frame.toPlainRow(row)).join("\n");
		expect(plain).toContain("USER");
		expect(plain).toContain("visible rpc transcript body");
		expect(plain).not.toContain("1 message transcript");
	});

	it("mounts the active chat shell when host state is active but the transcript is still empty", async () => {
		const frame = await renderRpcHostFrameForTest({
			state: state({ messageCount: 1, hasMessages: true }),
			transcript: { messages: [] },
		}, 160, 45);

		const plain = Array.from({ length: 45 }, (_, row) => frame.toPlainRow(row)).join("\n");
		expect(frame.toPlainRow(0)).toContain("SUMOCODE");
		expect(plain).toContain("READY");
		expect(plain).not.toContain('"Meow meow meow... meow meow"');
		expect(plain).not.toContain("DIVINE INVOCATION");
	});

	it("reserves the V2 sidebar columns in active landscape", async () => {
		const previousCwd = process.env.SUMOCODE_PROJECT_CWD;
		process.env.SUMOCODE_PROJECT_CWD = "/tmp/sumocode";
		try {
			const frame = await renderRpcHostFrameForTest({
				state: state({ messageCount: 1, hasMessages: true }),
				transcript: {
					messages: [{
						id: "message-1",
						role: "user",
						displayName: "YOU",
						blocks: [{ type: "markdown", text: "landscape chat body" }],
					}],
				},
			}, 160, 45);

			const sidebarText = Array.from({ length: 34 }, (_, row) => frame.toPlainRow(row + 3).slice(130)).join("\n");
			const chatText = Array.from({ length: 34 }, (_, row) => frame.toPlainRow(row + 3).slice(0, 128)).join("\n");
			expect(sidebarText).toContain("REGISTRY");
			expect(sidebarText).toContain("sumocode");
			expect(chatText).toContain("landscape chat body");
		} finally {
			if (previousCwd === undefined) delete process.env.SUMOCODE_PROJECT_CWD;
			else process.env.SUMOCODE_PROJECT_CWD = previousCwd;
		}
	});

	// Regression test for the sidebar-fill-height bug: a fixed 45-row capture
	// never exercises the tail of the sidebar's column because the sidebar's
	// own content (REGISTRY/CONTEXT/MCP sections) already reaches close to 45
	// rows. The bug only shows up once the terminal is meaningfully taller
	// than the sidebar's rendered content -- the RPC shell painted only the
	// content rows the sidebar component returned and left everything below
	// that as bare terminal background, instead of extending the sidebar's own
	// surface/frame styling down to the bottom of its reserved column (main's
	// classic `installSidebar` fills down to `sidebarOverlayTargetRows`). Use
	// 160x100, well beyond the 45-row parity scenario, so the fill gap can't
	// hide inside the sidebar's own content.
	it("fills the sidebar column's background to the bottom of its region at a tall terminal size", async () => {
		const frame = await renderRpcHostFrameForTest({
			state: state({ messageCount: 1, hasMessages: true }),
			transcript: {
				messages: [{
					id: "message-1",
					role: "user",
					displayName: "YOU",
					blocks: [{ type: "markdown", text: "landscape chat body" }],
				}],
			},
		}, 160, 100);

		// The sidebar column sits within chatRow, which is sandwiched between
		// the top-chrome (2 rows) and the editor/hint/footer rows at the
		// bottom (see RetainedShellRenderer's composition comment): at 100
		// terminal rows, chatRow (and therefore the sidebar leaf, height:
		// "100%" of it) spans rows 2..91 inclusive. Assert the LAST few rows
		// of that region still carry the sidebar's own surface background,
		// not the bare terminal default -- this is exactly the tail segment
		// that a 45-row capture never reaches.
		const sidebarSurfaceBg = activeThemeColors().surface.toLowerCase();
		const sidebarCol = 135;
		const lastSidebarRows = [86, 87, 88, 89, 90, 91];
		for (const row of lastSidebarRows) {
			const cell = frame.getCell(row, sidebarCol);
			expect(cell.bg?.toLowerCase(), `row ${row} col ${sidebarCol} should carry the sidebar surface bg`).toBe(sidebarSurfaceBg);
		}
	});

	it("renders RPC extension widgets and statuses through shared shell regions", async () => {
		const frame = await renderRpcHostFrameForTest({
			state: state({ messageCount: 1, hasMessages: true }),
			transcript: {
				messages: [{
					id: "message-1",
					role: "user",
					displayName: "YOU",
					blocks: [{ type: "markdown", text: "region body" }],
				}],
			},
		}, 160, 45, {
			extensionRegions: {
				aboveEditor: new StaticComponent(["fast-mode: fast", "rpc above widget"]),
				sidebar: new StaticComponent(["rpc sidebar widget"]),
			},
		});

		const plain = Array.from({ length: 45 }, (_, row) => frame.toPlainRow(row)).join("\n");
		expect(plain).toContain("fast-mode: fast");
		expect(plain).toContain("rpc above widget");
		expect(plain).toContain("rpc sidebar widget");
	});

	it("renders RPC notifications through the overlay layer", async () => {
		const frame = await renderRpcHostFrameForTest({
			state: state({ messageCount: 1, hasMessages: true }),
			transcript: {
				messages: [{
					id: "message-1",
					role: "user",
					displayName: "YOU",
					blocks: [{ type: "markdown", text: "notification body" }],
				}],
			},
		}, 100, 30, {
			notifications: new StaticComponent(["rpc notification toast"]),
		});

		const plain = Array.from({ length: 30 }, (_, row) => frame.toPlainRow(row)).join("\n");
		expect(plain).toContain("rpc notification toast");
	});

	it("hides the sidebar in portrait and moves project context to the hint row", async () => {
		const previousCwd = process.env.SUMOCODE_PROJECT_CWD;
		process.env.SUMOCODE_PROJECT_CWD = "/Volumes/SumoDeus NVMe/code/sumocode";
		try {
			const frame = await renderRpcHostFrameForTest({
				state: state({ messageCount: 1, hasMessages: true }),
				transcript: {
					messages: [{
						id: "message-1",
						role: "user",
						displayName: "YOU",
						blocks: [{ type: "markdown", text: "portrait chat body" }],
					}],
				},
			}, 60, 100);

			const plain = Array.from({ length: 100 }, (_, row) => frame.toPlainRow(row)).join("\n");
			expect(plain).toContain("portrait chat body");
			expect(plain).toContain("sumocode");
			expect(plain).not.toContain("REGISTRY");
		} finally {
			if (previousCwd === undefined) delete process.env.SUMOCODE_PROJECT_CWD;
			else process.env.SUMOCODE_PROJECT_CWD = previousCwd;
		}
	});

	it("maps streaming and compacting state to Cathedral footer labels", async () => {
		const streaming = await renderRpcHostFrameForTest({
			state: state({ messageCount: 1, hasMessages: true, isStreaming: true }),
			transcript: {
				messages: [{
					id: "message-1",
					role: "user",
					displayName: "YOU",
					blocks: [{ type: "markdown", text: "state body" }],
				}],
			},
		}, 90, 24);
		const compacting = await renderRpcHostFrameForTest({
			state: state({ messageCount: 1, hasMessages: true, isCompacting: true }),
			transcript: {
				messages: [{
					id: "message-1",
					role: "user",
					displayName: "YOU",
					blocks: [{ type: "markdown", text: "state body" }],
				}],
			},
		}, 90, 24);

		expect(Array.from({ length: 24 }, (_, row) => streaming.toPlainRow(row)).join("\n")).toContain("MEDITATING");
		expect(Array.from({ length: 24 }, (_, row) => compacting.toPlainRow(row)).join("\n")).toContain("INSCRIBING");
	});

	it("renders compacting status rows in full retained frames", async () => {
		const manual = await renderRpcHostFrameForTest({
			state: state({ messageCount: 1, hasMessages: true, isCompacting: true, compactionReason: "manual" }),
			transcript: {
				messages: [{
					id: "message-1",
					role: "user",
					displayName: "YOU",
					blocks: [{ type: "markdown", text: "state body" }],
				}],
			},
		}, 90, 24);
		const auto = await renderRpcHostFrameForTest({
			state: state({ messageCount: 1, hasMessages: true, isCompacting: true, compactionReason: "overflow" }),
			transcript: {
				messages: [{
					id: "message-1",
					role: "user",
					displayName: "YOU",
					blocks: [{ type: "markdown", text: "state body" }],
				}],
			},
		}, 60, 100);

		const manualText = Array.from({ length: 24 }, (_, row) => manual.toPlainRow(row)).join("\n");
		const autoText = Array.from({ length: 100 }, (_, row) => auto.toPlainRow(row)).join("\n");
		expect(manualText).toContain("Compacting…");
		expect(manualText).toContain("INSCRIBING");
		expect(manualText).not.toContain("Working…");
		expect(autoText).toContain("Auto-compacting…");
		expect(autoText).toContain("INSCRIBING");
	});

	it("renders updated runtime transcripts through terminal frame patches", async () => {
		const output = new FakeOutput();
		const terminal = new TerminalSessionOwner({ output });
		const runtime = new RpcHostRuntime({
			output,
			input: { isTTY: false, on: () => undefined },
			terminal,
			initialState: state(),
			initialTranscript: { messages: [] },
		});

		await runtime.start();
		runtime.update({
			state: state({ messageCount: 1, hasMessages: true }),
			transcript: {
				messages: [{
					id: "message-2",
					role: "sumo",
					displayName: "SUMO",
					blocks: [{ type: "markdown", text: "updated rpc transcript body" }],
				}],
			},
		});
		// update() coalesces its render onto a microtask (see runtime.ts's
		// scheduleRender) instead of painting synchronously -- flush it before
		// asserting on terminal output.
		await Promise.resolve();
		runtime.stop();

		const terminalOutput = output.chunks.join("");
		expect(terminalOutput).toContain("SUMO");
		expect(terminalOutput).toContain("updated rpc transcript body");
		expect(terminalOutput).not.toContain("1 message transcript");
	});

	it("updates runtime chrome without replacing retained chat state on state-only updates", async () => {
		const replaceViewModels = vi.spyOn(ChatPager.prototype, "replaceViewModels");
		const output = new FakeOutput();
		const terminal = new TerminalSessionOwner({ output });
		const runtime = new RpcHostRuntime({
			output,
			input: { isTTY: false, on: () => undefined },
			terminal,
			initialState: state({ messageCount: 1, hasMessages: true }),
			initialTranscript: {
				messages: [{
					id: "message-3",
					role: "sumo",
					displayName: "SUMO",
					blocks: [{ type: "markdown", text: "retained scroll transcript body" }],
				}],
			},
		});

		try {
			await runtime.start();
			replaceViewModels.mockClear();
			output.chunks.length = 0;

			runtime.update({ state: state({ messageCount: 1, hasMessages: true, isStreaming: true }) });
			// See the coalescing note above: flush the scheduled render.
			await Promise.resolve();

			expect(replaceViewModels).not.toHaveBeenCalled();
			expect(output.chunks.join("")).toContain("MEDITATING");
		} finally {
			runtime.stop();
			replaceViewModels.mockRestore();
		}
	});

	it("exposes the shell's chat sink only once start() has resolved, undefined before/after", async () => {
		const output = new FakeOutput();
		const terminal = new TerminalSessionOwner({ output });
		const runtime = new RpcHostRuntime({
			output,
			input: { isTTY: false, on: () => undefined },
			terminal,
			initialState: state(),
			initialTranscript: { messages: [] },
		});

		expect(runtime.getChatSink()).toBeUndefined();
		await runtime.start();
		expect(runtime.getChatSink()).toBeDefined();
		runtime.stop();
		expect(runtime.getChatSink()).toBeUndefined();
	});

	// app.tools.expand (Ctrl+O) wiring: host.ts's createToolsExpandToggleHandler
	// calls runtime.setToolExpansion(expanded), which must reach the live
	// shell's ChatPager only once start() has resolved, and be a safe no-op
	// otherwise -- same lifecycle window as getChatSink() above.
	it("setToolExpansion is a no-op before start()/after stop(), and forwards to the live ChatPager once started", async () => {
		const setToolExpansion = vi.spyOn(ChatPager.prototype, "setToolExpansion");
		const output = new FakeOutput();
		const terminal = new TerminalSessionOwner({ output });
		const runtime = new RpcHostRuntime({
			output,
			input: { isTTY: false, on: () => undefined },
			terminal,
			initialState: state(),
			initialTranscript: { messages: [] },
		});

		try {
			expect(() => runtime.setToolExpansion(true)).not.toThrow();
			expect(setToolExpansion).not.toHaveBeenCalled();

			await runtime.start();
			setToolExpansion.mockClear();
			runtime.setToolExpansion(true);
			expect(setToolExpansion).toHaveBeenCalledWith(true);

			runtime.stop();
			setToolExpansion.mockClear();
			expect(() => runtime.setToolExpansion(false)).not.toThrow();
			expect(setToolExpansion).not.toHaveBeenCalled();
		} finally {
			setToolExpansion.mockRestore();
		}
	});

	it("skips the pager's replaceViewModels end-to-end when update() carries a transcriptRevision (host.ts's B9 sink-wiring contract)", async () => {
		const replaceViewModels = vi.spyOn(ChatPager.prototype, "replaceViewModels");
		const output = new FakeOutput();
		const terminal = new TerminalSessionOwner({ output });
		const runtime = new RpcHostRuntime({
			output,
			input: { isTTY: false, on: () => undefined },
			terminal,
			initialState: state(),
			initialTranscript: { messages: [] },
		});

		try {
			await runtime.start();
			replaceViewModels.mockClear();

			// Simulate host.ts: the controller already pushed this message into
			// the pager directly via getChatSink() before runtime.update() is
			// ever called (this is what the lazy sink + transcriptRevision
			// contract guarantees in production).
			const message = { id: "m1", role: "sumo" as const, displayName: "SUMO", blocks: [{ type: "markdown" as const, text: "sink-applied" }] };
			runtime.getChatSink()?.addViewModel(message);

			runtime.update({
				state: state({ messageCount: 1, hasMessages: true }),
				transcript: { messages: [message] },
				transcriptRevision: 1,
			});
			await Promise.resolve();

			expect(replaceViewModels).not.toHaveBeenCalled();
		} finally {
			runtime.stop();
			replaceViewModels.mockRestore();
		}
	});

	it("coalesces any number of update()/requestRender() calls in one synchronous turn into a single render", async () => {
		const output = new FakeOutput();
		const terminal = new TerminalSessionOwner({ output });
		let scheduled: (() => void) | undefined;
		const renderScheduler = vi.fn((callback: () => void) => {
			scheduled = callback;
		});
		const runtime = new RpcHostRuntime({
			output,
			input: { isTTY: false, on: () => undefined },
			terminal,
			initialState: state(),
			initialTranscript: { messages: [] },
			renderScheduler,
		});

		try {
			await runtime.start();
			renderScheduler.mockClear();
			const renderSpy = vi.spyOn(output, "write");
			renderSpy.mockClear();

			// A burst of updates in the same synchronous turn (e.g. several
			// per-delta agent events processed back to back) must schedule
			// exactly one coalesced render, not one per call.
			for (let index = 0; index < 5; index += 1) {
				runtime.update({
					state: state({ messageCount: 1, hasMessages: true }),
					transcript: { messages: [{ id: `m${index}`, role: "sumo", displayName: "SUMO", blocks: [{ type: "markdown", text: `chunk ${index}` }] }] },
				});
			}
			runtime.requestRender();

			expect(renderScheduler).toHaveBeenCalledTimes(1);
			expect(renderSpy).not.toHaveBeenCalled(); // nothing painted yet -- still coalesced, not flushed

			scheduled?.();
			expect(renderSpy).toHaveBeenCalledTimes(1); // exactly one render for the whole burst

			// The next update after the scheduled render ran must schedule again.
			renderScheduler.mockClear();
			runtime.requestRender();
			expect(renderScheduler).toHaveBeenCalledTimes(1);
		} finally {
			runtime.stop();
		}
	});

	it("emits startup readiness diagnostics after the first retained render", async () => {
		const previousDiagFile = process.env.SUMO_TUI_DIAG_FILE;
		const dir = mkdtempSync(join(tmpdir(), "sumocode-rpc-runtime-diag-"));
		const diagFile = join(dir, "diag.jsonl");
		process.env.SUMO_TUI_DIAG_FILE = diagFile;
		try {
			const output = new FakeOutput();
			const terminal = new TerminalSessionOwner({ output });
			const runtime = new RpcHostRuntime({
				output,
				input: { isTTY: false, on: () => undefined },
				terminal,
				initialState: state(),
				initialTranscript: { messages: [] },
			});

			await runtime.start();
			runtime.stop();

			const events = readFileSync(diagFile, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as { event: string; surface?: string; cols?: number; rows?: number });
			for (const event of ["boot_screen_frame", "stable_chrome_ready", "app_ready", "input_ready"]) {
				expect(events).toContainEqual(expect.objectContaining({
					event,
					surface: "rpc_host",
					cols: 90,
					rows: 24,
				}));
			}
		} finally {
			if (previousDiagFile === undefined) delete process.env.SUMO_TUI_DIAG_FILE;
			else process.env.SUMO_TUI_DIAG_FILE = previousDiagFile;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("keeps q as editor input when the retained editor is active and still cleans up on ctrl-c", async () => {
		const output = new FakeOutput();
		const input = new FakeInput();
		const editor = new FakeEditor();
		const terminal = new TerminalSessionOwner({ output });
		const runtime = new RpcHostRuntime({
			output,
			input,
			terminal,
			editor,
			initialState: state(),
			initialTranscript: { messages: [] },
		});

		await runtime.start();
		input.emit("q");

		expect(editor.inputs).toEqual(["q"]);
		expect(input.rawModes).toEqual([true]);

		input.emit("\u0003");
		await expect(runtime.waitForExit()).resolves.toBe(130);
		expect(input.rawModes).toEqual([true, false]);
		expect(input.pauseCount).toBe(1);
		expect(terminal.getState()).toMatchObject({ restored: true });
	});

	it("sets stdin to utf8 encoding on start so Node reassembles multibyte input split across chunks", async () => {
		const output = new FakeOutput();
		const input = new FakeInput();
		const runtime = new RpcHostRuntime({
			output,
			input,
			initialState: state(),
			initialTranscript: { messages: [] },
		});

		await runtime.start();

		expect(input.encodings).toEqual(["utf8"]);
	});

	it("leaves Apple Terminal Enter unchanged when Pi's native Shift probe is false", async () => {
		const output = new FakeOutput();
		const input = new FakeInput();
		const editor = new FakeEditor();
		const nativeModifierProbe = vi.fn(() => false);
		const runtime = new RpcHostRuntime({
			output,
			input,
			editor,
			nativeModifierProbe,
			env: { TERM_PROGRAM: "Apple_Terminal" } as NodeJS.ProcessEnv,
			initialState: state(),
			initialTranscript: { messages: [] },
		});

		await runtime.start();
		input.emit("\r");

		if (process.platform === "darwin") {
			expect(nativeModifierProbe).toHaveBeenCalledWith("shift");
		} else {
			expect(nativeModifierProbe).not.toHaveBeenCalled();
		}
		expect(editor.inputs).toEqual(["\r"]);
	});

	it("rewrites Apple Terminal Shift+Enter at the runtime input path when Pi's native Shift probe is true", async () => {
		const output = new FakeOutput();
		const input = new FakeInput();
		const editor = new FakeEditor();
		const nativeModifierProbe = vi.fn(() => true);
		const runtime = new RpcHostRuntime({
			output,
			input,
			editor,
			nativeModifierProbe,
			env: { TERM_PROGRAM: "Apple_Terminal" } as NodeJS.ProcessEnv,
			initialState: state(),
			initialTranscript: { messages: [] },
		});

		await runtime.start();
		input.emit("\r");

		if (process.platform === "darwin") {
			expect(nativeModifierProbe).toHaveBeenCalledWith("shift");
			expect(editor.inputs).toEqual(["\x1b[13;2u"]);
		} else {
			expect(nativeModifierProbe).not.toHaveBeenCalled();
			expect(editor.inputs).toEqual(["\r"]);
		}
	});

	it("falls back to plain Enter when Pi's native Shift probe throws", async () => {
		const output = new FakeOutput();
		const input = new FakeInput();
		const editor = new FakeEditor();
		const nativeModifierProbe = vi.fn(() => {
			throw new Error("native modifier probe unavailable");
		});
		const runtime = new RpcHostRuntime({
			output,
			input,
			editor,
			nativeModifierProbe,
			env: { TERM_PROGRAM: "Apple_Terminal" } as NodeJS.ProcessEnv,
			initialState: state(),
			initialTranscript: { messages: [] },
		});

		await runtime.start();
		expect(() => input.emit("\r")).not.toThrow();

		if (process.platform === "darwin") {
			expect(nativeModifierProbe).toHaveBeenCalledWith("shift");
		} else {
			expect(nativeModifierProbe).not.toHaveBeenCalled();
		}
		expect(editor.inputs).toEqual(["\r"]);
	});

	// The RpcHostInput fake above emits whole strings, so it can't reproduce
	// a real pty splitting a multibyte UTF-8 codepoint's bytes across two
	// separate 'data' events. What actually fixes defect 4 is calling
	// process.stdin.setEncoding('utf8') (asserted above) so Node's own
	// StringDecoder -- not our handleInput -- does the reassembly. This test
	// exercises that exact StringDecoder contract directly: feeding a 3-byte
	// UTF-8 character (e.g. "字", U+5B57, E5 AD 97) split across two Buffer
	// chunks must yield the correct character only once the full sequence has
	// arrived, with no U+FFFD replacement character in between.
	it("StringDecoder (what setEncoding('utf8') delegates to) reassembles a multibyte codepoint split across two chunks", () => {
		const decoder = new StringDecoder("utf8");
		const codepoint = "字"; // U+5B57, encodes to 3 bytes in UTF-8: 0xE5 0xAD 0x97
		const bytes = Buffer.from(codepoint, "utf8");
		expect(bytes.length).toBe(3);

		const firstChunk = bytes.subarray(0, 2); // 0xE5 0xAD: an incomplete sequence
		const secondChunk = bytes.subarray(2); // 0x97: completes it

		const firstResult = decoder.write(firstChunk);
		// The incomplete trailing sequence is buffered internally, not flushed
		// as garbage -- this is precisely what a per-chunk toString('utf8')
		// (the pre-fix behavior) gets wrong, emitting U+FFFD instead.
		expect(firstResult).toBe("");
		expect(firstResult).not.toContain("�");

		const secondResult = decoder.write(secondChunk);
		expect(secondResult).toBe(codepoint);
		expect(secondResult).not.toContain("�");

		expect(firstResult + secondResult).toBe(codepoint);
	});

	it("keeps Ctrl-C as a global exit request while a modal is focused", async () => {
		const output = new FakeOutput();
		const input = new FakeInput();
		const modal = new ActiveModalComponent();
		const terminal = new TerminalSessionOwner({ output });
		const runtime = new RpcHostRuntime({
			output,
			input,
			terminal,
			modal,
			initialState: state(),
			initialTranscript: { messages: [] },
		});

		await runtime.start();
		input.emit("\u0003");

		await expect(runtime.waitForExit()).resolves.toBe(130);
		expect(modal.inputs).toEqual([]);
	});

	it("does not dispatch initial bare ESC when buffering split SGR mouse input", () => {
		const handleFocusedModalInput = vi.fn(() => true);
		const handleFocusedOverlayInput = vi.fn(() => true);
		const handlePreEditorInput = vi.fn(() => true);
		const forwardToEditor = vi.fn(() => true);
		const handleUnhandledInput = vi.fn(() => true);
		const handleMouseEvent = vi.fn(() => true);
		const scheduleMouseRender = vi.fn();
		const router = new SharedInputRouter({
			handleFocusedModalInput,
			handleFocusedOverlayInput,
			handlePreEditorInput,
			forwardToEditor,
			handleUnhandledInput,
			handleMouseEvent,
			scheduleMouseRender,
		});

		expect(router.handleInput("\x1b")).toEqual({ consume: true });
		expect(handleFocusedModalInput).not.toHaveBeenCalled();
		expect(handleFocusedOverlayInput).not.toHaveBeenCalled();
		expect(handlePreEditorInput).not.toHaveBeenCalled();
		expect(forwardToEditor).not.toHaveBeenCalled();
		expect(handleUnhandledInput).not.toHaveBeenCalled();

		expect(router.handleInput("[<64;10;5M")).toEqual({ consume: true });
		expect(handleMouseEvent).toHaveBeenCalledWith({
			type: "scroll",
			button: 64,
			scrollDir: "up",
			row: 4,
			col: 9,
			modifiers: { shift: false, alt: false, ctrl: false },
		});
		expect(scheduleMouseRender).toHaveBeenCalledTimes(1);
	});

	it("defers a trailing bare ESC that is coalesced after SGR mouse input", async () => {
		vi.useFakeTimers();
		const handlePreEditorInput = vi.fn(() => true);
		const forwardToEditor = vi.fn(() => true);
		const handleUnhandledInput = vi.fn(() => true);
		const handleMouseEvent = vi.fn(() => true);
		const scheduleMouseRender = vi.fn();
		const dispatchDelayedInput = vi.fn(() => true);
		const router = new SharedInputRouter({
			handlePreEditorInput,
			forwardToEditor,
			handleUnhandledInput,
			handleMouseEvent,
			scheduleMouseRender,
			dispatchDelayedInput,
		});

		try {
			expect(router.handleInput("\x1b[<64;10;5M\x1b")).toEqual({ consume: true });
			expect(handleMouseEvent).toHaveBeenCalledWith({
				type: "scroll",
				button: 64,
				scrollDir: "up",
				row: 4,
				col: 9,
				modifiers: { shift: false, alt: false, ctrl: false },
			});
			expect(scheduleMouseRender).toHaveBeenCalledTimes(1);
			expect(dispatchDelayedInput).not.toHaveBeenCalled();
			expect(handlePreEditorInput).not.toHaveBeenCalled();
			expect(forwardToEditor).not.toHaveBeenCalled();
			expect(handleUnhandledInput).not.toHaveBeenCalled();

			await vi.advanceTimersByTimeAsync(25);

			expect(dispatchDelayedInput).toHaveBeenCalledWith("\x1b");
			expect(handlePreEditorInput).not.toHaveBeenCalled();
			expect(forwardToEditor).not.toHaveBeenCalled();
			expect(handleUnhandledInput).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	it.each(["\u001f", "\x1b[47;5u"])("opens the RPC command palette from Ctrl+/ variant %#", async (inputBytes) => {
		const output = new FakeOutput();
		const input = new FakeInput();
		const editor = new FakeEditor();
		const openCommandPalette = vi.fn();
		const terminal = new TerminalSessionOwner({ output });
		const runtime = new RpcHostRuntime({
			output,
			input,
			terminal,
			editor,
			inputHandler: { openCommandPalette },
			initialState: state(),
			initialTranscript: { messages: [] },
		});

		await runtime.start();
		input.emit(inputBytes);
		runtime.stop();

		expect(openCommandPalette).toHaveBeenCalledTimes(1);
		expect(editor.inputs).toEqual([]);
	});

	it("normalizes raw multiline paste before forwarding to the RPC editor", async () => {
		const output = new FakeOutput();
		const input = new FakeInput();
		const editor = new FakeEditor();
		const terminal = new TerminalSessionOwner({ output });
		const runtime = new RpcHostRuntime({
			output,
			input,
			terminal,
			editor,
			initialState: state(),
			initialTranscript: { messages: [] },
		});

		await runtime.start();
		input.emit("line one\rline two");
		runtime.stop();

		expect(editor.inputs).toEqual(["line one\nline two"]);
	});

	it("exposes a pre-editor interception point for raw Escape after the mouse ambiguity window and Ctrl-C", async () => {
		const output = new FakeOutput();
		const input = new FakeInput();
		const editor = new FakeEditor();
		const preEditorInputHandler = vi.fn((data: string) => data === "\x1b" || data === "\u0003");
		const terminal = new TerminalSessionOwner({ output });
		const runtime = new RpcHostRuntime({
			output,
			input,
			terminal,
			editor,
			preEditorInputHandler,
			initialState: state(),
			initialTranscript: { messages: [] },
		});

		await runtime.start();
		vi.useFakeTimers();
		try {
			input.emit("\x1b");
			expect(preEditorInputHandler).not.toHaveBeenCalledWith("\x1b");
			await vi.advanceTimersByTimeAsync(25);
			input.emit("\u0003");
		} finally {
			runtime.stop();
			vi.useRealTimers();
		}

		expect(preEditorInputHandler).toHaveBeenCalledWith("\x1b");
		expect(preEditorInputHandler).toHaveBeenCalledWith("\u0003");
		expect(editor.inputs).toEqual([]);
	});

	it("passes the shell-owned editor cursor to terminal frame patches", async () => {
		const output = new FakeOutput();
		const terminal = new CursorCaptureTerminal();
		const runtime = new RpcHostRuntime({
			output,
			input: { isTTY: false, on: () => undefined },
			terminal: terminal as unknown as TerminalSessionOwner,
			editor: new RpcHostEditorController(),
			initialState: state(),
			initialTranscript: { messages: [] },
		});

		await runtime.start();
		runtime.stop();

		expect(terminal.cursors.some((cursor) => cursor !== null)).toBe(true);
	});

	it("wires the copy-key input token through to the shell's selection controller (handleSelectionKey)", async () => {
		const output = new FakeOutput();
		const input = new FakeInput();
		const terminal = new TerminalSessionOwner({ output });
		const handleSelectionKey = vi.spyOn(RpcShellAdapter.prototype, "handleSelectionKey");
		const runtime = new RpcHostRuntime({
			output,
			input,
			terminal,
			initialState: state(),
			initialTranscript: { messages: [] },
		});

		try {
			await runtime.start();
			handleSelectionKey.mockClear();
			input.emit("cmd+c");

			expect(handleSelectionKey).toHaveBeenCalledWith({ key: "c", sequence: "cmd+c", meta: true });
		} finally {
			runtime.stop();
			handleSelectionKey.mockRestore();
		}
	});

	it("keeps the duplicate RPC full-frame compositor out of runtime.ts", () => {
		const source = readFileSync(new URL("./runtime.ts", import.meta.url), "utf8");

		expect(source).toContain("RpcShellAdapter");
		expect(source).not.toMatch(/\b(renderRpcFrame|renderSplashFrame|renderActiveFrame|activeBottomRows|activeEditorRows|sidebarLayoutSnapshot)\b/);
		expect(source).not.toContain("../../cathedral/input-frame.js");
		expect(source).not.toContain("../../footer.js");
		expect(source).not.toContain("../../top-chrome.js");
		expect(source).not.toContain("../cathedral/sidebar-tree.js");
	});

	it("sends submitted prompts in harness/offline mode unless an explicit visual fixture is active", async () => {
		const send = vi.fn(async () => ({
			type: "response",
			id: "prompt",
			command: "prompt",
			success: true,
		} as const));
		const onBeforeSend = vi.fn();
		const visualFixture = rpcVisualFixtureFromEnv({
			SUMOCODE_HARNESS: "1",
			PI_OFFLINE: "1",
		} as NodeJS.ProcessEnv);

		expect(visualFixture).toBeUndefined();

		await submitRpcPrompt("real runtime prompt", {
			visualFixture,
			stateStore: { getSnapshot: () => state() },
			client: { send },
			onBeforeSend,
		});

		expect(onBeforeSend).toHaveBeenCalledWith("real runtime prompt");
		expect(send).toHaveBeenCalledWith({ type: "prompt", message: "real runtime prompt" });

		send.mockClear();
		await submitRpcPrompt("fixture prompt", {
			visualFixture: { state: state({ hasMessages: true, messageCount: 1 }), transcript: { messages: [] } },
			stateStore: { getSnapshot: () => state() },
			client: { send },
		});

		expect(send).not.toHaveBeenCalled();
	});
});

describe("RPC host terminal theme palette", () => {
	afterEach(() => resetThemeRegistryForTests());

	const HERDR_BG = "\x1b]11;#040704\x1b\\";
	const HERDR_CURSOR = "\x1b]12;#39FF14\x1b\\";
	const CATHEDRAL_BG = "\x1b]11;#1A1511\x1b\\";
	const CATHEDRAL_CURSOR = "\x1b]12;#D97706\x1b\\";
	const countOccurrences = (chunks: readonly string[], needle: string): number =>
		chunks.join("").split(needle).length - 1;

	function buildRuntime() {
		const output = new FakeOutput();
		const terminal = new TerminalSessionOwner({ output });
		const runtime = new RpcHostRuntime({
			output,
			input: { isTTY: false, on: () => undefined },
			terminal,
			initialState: state(),
			initialTranscript: { messages: [] },
		});
		return { output, terminal, runtime };
	}

	it("Herdr startup's first OSC 11/12 use the Herdr palette with no Cathedral flash", async () => {
		setActiveTheme("herdr");
		const { output, runtime } = buildRuntime();

		await runtime.start();

		const joined = output.chunks.join("");
		expect(joined).toContain(HERDR_BG);
		expect(joined).toContain(HERDR_CURSOR);
		expect(joined).not.toContain(CATHEDRAL_BG);
		expect(joined).not.toContain(CATHEDRAL_CURSOR);
		runtime.stop();
	});

	it("live Cathedral → Herdr switch emits the Herdr background and accent without restarting the session", async () => {
		const { output, terminal, runtime } = buildRuntime();
		await runtime.start();
		expect(output.chunks.join("")).toContain(CATHEDRAL_BG);
		output.chunks.length = 0;

		setActiveTheme("herdr");

		const joined = output.chunks.join("");
		expect(joined).toContain(HERDR_BG);
		expect(joined).toContain(HERDR_CURSOR);
		expect(terminal.getState().altscreenActive).toBe(true);
		expect(terminal.getState().restored).toBe(false);
		runtime.stop();
	});

	it("repeated selection of the same theme does not spam duplicate OSC writes", async () => {
		const { output, runtime } = buildRuntime();
		await runtime.start();

		setActiveTheme("herdr");
		setActiveTheme("herdr");
		setActiveTheme("herdr");

		expect(countOccurrences(output.chunks, HERDR_BG)).toBe(1);
		expect(countOccurrences(output.chunks, HERDR_CURSOR)).toBe(1);
		runtime.stop();
	});

	it("an explicit cursor reset survives a theme switch: background updates, cursor stays default", async () => {
		const { output, terminal, runtime } = buildRuntime();
		await runtime.start();
		terminal.resetCursorColor();
		output.chunks.length = 0;

		setActiveTheme("herdr");

		const joined = output.chunks.join("");
		expect(joined).toContain(HERDR_BG);
		expect(joined).not.toContain(HERDR_CURSOR);
		expect(terminal.getState().cursorColorOverridden).toBe(false);
		runtime.stop();
	});

	it("shutdown resets OSC background/cursor and terminal mode exactly once", async () => {
		setActiveTheme("herdr");
		const { output, runtime } = buildRuntime();
		await runtime.start();

		runtime.stop();
		runtime.stop();

		expect(countOccurrences(output.chunks, "\x1b]112\x1b\\")).toBe(1);
		expect(countOccurrences(output.chunks, "\x1b]111\x1b\\")).toBe(1);
		expect(countOccurrences(output.chunks, "\x1b[?1049l")).toBe(1);
	});

	it("non-TTY outputs emit no palette sequences", async () => {
		setActiveTheme("herdr");
		const output = new FakeOutput();
		(output as { isTTY: boolean }).isTTY = false;
		const terminal = new TerminalSessionOwner({ output });
		const runtime = new RpcHostRuntime({
			output,
			input: { isTTY: false, on: () => undefined },
			terminal,
			initialState: state(),
			initialTranscript: { messages: [] },
		});

		await runtime.start();
		setActiveTheme("cathedral");
		runtime.stop();

		expect(output.chunks.join("")).not.toContain("\x1b]11;");
		expect(output.chunks.join("")).not.toContain("\x1b]12;");
	});

	it("stop removes the theme listener so later theme changes stop reaching the terminal", async () => {
		const { output, runtime } = buildRuntime();
		await runtime.start();
		runtime.stop();
		output.chunks.length = 0;

		setActiveTheme("herdr");

		expect(output.chunks).toEqual([]);
	});
});
