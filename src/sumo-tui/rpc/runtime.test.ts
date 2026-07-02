import { describe, expect, it } from "vitest";
import { renderRpcHostFrameForTest } from "./runtime.js";

describe("RPC host retained runtime frame", () => {
	it("renders a recognizable empty shell with footer state", () => {
		const frame = renderRpcHostFrameForTest({
			state: {
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
			},
			transcript: { messages: [] },
		}, 80, 24);

		const plain = Array.from({ length: 24 }, (_, row) => frame.toPlainRow(row)).join("\n");
		expect(plain).toContain("sumocode · rpc host");
		expect(plain).toContain("SUMOCODE RPC");
		expect(plain).toContain("empty transcript");
		expect(plain).toContain("READY · branch codex/rpc-host");
		expect(plain).toContain("0/100k · $0.00");
	});
});
