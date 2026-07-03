import { describe, expect, it, vi } from "vitest";
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

async function makeAdapter(): Promise<RpcShellAdapter> {
	return RpcShellAdapter.create({
		terminal: { writeFramePatches: () => undefined },
		viewport: { columns: 100, rows: 30 },
		initialState: state(),
		initialTranscript: { messages: [] },
	});
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
