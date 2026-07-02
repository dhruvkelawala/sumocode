import type { Component } from "@earendil-works/pi-tui";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TerminalSessionOwner } from "../runtime/terminal-controller.js";
import { renderRpcHostFrameForTest, RpcHostRuntime } from "./runtime.js";
import type { RpcHostChromeState } from "./state.js";

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
});
