import type { Component } from "@earendil-works/pi-tui";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { INPUT_FRAME_PLACEHOLDER } from "../../cathedral/input-frame.js";
import { activeThemeColors } from "../../themes/index.js";
import { TerminalSessionOwner } from "../runtime/terminal-controller.js";
import { RpcHostEditorController } from "./editor.js";
import { submitRpcPrompt } from "./host.js";
import { renderRpcHostFrameForTest, RpcHostRuntime } from "./runtime.js";
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

	public resume(): void {}

	public emit(data: string): void {
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
			.some((cell) => cell.char === " " && cell.bg?.toLowerCase() === cursorBg);
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
			.some((cell) => cell.char === " " && cell.bg?.toLowerCase() === cursorBg);
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
		expect(frame.toPlainRow(1)).toContain("SUMOCODE");
		expect(plain).toContain("READY");
		expect(plain).not.toContain('"Meow meow meow... meow meow"');
		expect(plain).not.toContain("DIVINE INVOCATION");
	});

	it("reserves the V2 sidebar columns in active landscape", async () => {
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

			expect(replaceViewModels).not.toHaveBeenCalled();
			expect(output.chunks.join("")).toContain("MEDITATING");
		} finally {
			runtime.stop();
			replaceViewModels.mockRestore();
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
		expect(terminal.getState()).toMatchObject({ restored: true });
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
