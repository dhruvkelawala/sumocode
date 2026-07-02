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

describe("RPC host retained runtime frame", () => {
	it("renders a recognizable empty shell with footer state", async () => {
		const frame = await renderRpcHostFrameForTest({
			state: state(),
			transcript: { messages: [] },
		}, 80, 24);

		const plain = Array.from({ length: 24 }, (_, row) => frame.toPlainRow(row)).join("\n");
		expect(plain).toContain("sumocode · rpc host");
		expect(plain).toContain("SUMOCODE RPC");
		expect(plain).toContain("empty transcript");
		expect(plain).toContain("READY · branch codex/rpc-host");
		expect(plain).toContain("0/100k · $0.00");
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
});
