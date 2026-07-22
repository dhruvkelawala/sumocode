import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { TranscriptController } from "../transcript/controller.js";
import { chatMessageViewModelToPlainText, createTranscriptViewModelMapper } from "../transcript/view-model.js";
import { RpcTranscriptPump } from "./transcript-pump.js";

function readJson(path: string): unknown {
	return JSON.parse(readFileSync(resolve(process.cwd(), path), "utf8"));
}

function readJsonl(path: string): unknown[] {
	return readFileSync(resolve(process.cwd(), path), "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as unknown);
}

function comparable(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(comparable);
	if (typeof value !== "object" || value === null) return value;
	const source = value as Record<string, unknown>;
	const result: Record<string, unknown> = {};
	for (const key of Object.keys(source).sort()) {
		const child = source[key];
		if (key === "displayName" || key === "timestamp") continue;
		if (key === "expanded" && child === true) continue;
		if (key === "hidden" && child === false) continue;
		if (child === undefined) continue;
		result[key] = comparable(child);
	}
	if (result.type === "activity" && typeof result.activity === "object" && result.activity !== null) {
		const activity = result.activity as Record<string, unknown>;
		if (activity.status === "queued") activity.status = "running";
	}
	return result;
}

function replay(path: string): unknown {
	const pump = new RpcTranscriptPump();
	for (const event of readJsonl(path)) pump.handleAgentEvent(event);
	return comparable(pump.viewModel());
}

describe("RpcTranscriptPump", () => {
	it.each([
		["tool", "scratch/rpc-spike/events-tool.jsonl", "scratch/rpc-spike/view-model-tool-events.json"],
		["image", "scratch/rpc-spike/events-image.jsonl", "scratch/rpc-spike/view-model-image-events.json"],
		["abort", "scratch/rpc-spike/events-abort.jsonl", "scratch/rpc-spike/view-model-abort-events.json"],
	])("replays Plan 001 %s events into the committed final view model", (_name, eventsPath, expectedPath) => {
		expect(replay(eventsPath)).toEqual(comparable(readJson(expectedPath)));
	});

	it("captures live task partial output from tool_execution_update.partialResult", () => {
		const pump = new RpcTranscriptPump();
		for (const event of readJsonl("scratch/rpc-spike/events-task-partial.jsonl")) {
			pump.handleAgentEvent(event);
			if ((event as { type?: unknown }).type === "tool_execution_update") break;
		}

		const partials = pump.getTaskPartials();
		expect(partials).toHaveLength(1);
		expect(partials[0]).toMatchObject({
			toolCallId: "rpc-spike-task-1",
			toolName: "task",
			partialResult: {
				content: [{ type: "text", text: "task partial output" }],
			},
		});
	});

	it("maps committed messages once while replacing only the live draft across streaming updates", () => {
		const mapper = createTranscriptViewModelMapper();
		const originalMessageFromPiMessage = mapper.messageFromPiMessage.bind(mapper);
		const messageFromPiMessage = vi.fn(originalMessageFromPiMessage);
		mapper.messageFromPiMessage = messageFromPiMessage;
		const controller = new TranscriptController({ mapper });

		controller.replaceFromMessages([
			{ id: "u1", role: "user", content: "question" },
			{ id: "a1", role: "assistant", content: "committed answer" },
		]);
		messageFromPiMessage.mockClear();

		for (let index = 0; index < 5; index += 1) {
			controller.handleAgentEvent({
				type: "message_update",
				message: { id: "draft", role: "assistant", content: `draft ${index}` },
			});
		}

		expect(messageFromPiMessage).toHaveBeenCalledTimes(5);
		expect(messageFromPiMessage.mock.calls.map(([message]) => (message as { id?: string }).id)).toEqual(["draft", "draft", "draft", "draft", "draft"]);
	});

	it("prunes live tool and task partial state after authoritative agent_end messages arrive", () => {
		const pump = new RpcTranscriptPump();
		pump.handleAgentEvent({
			type: "tool_execution_update",
			toolCallId: "task-1",
			toolName: "task",
			args: { prompt: "Track task output" },
			partialResult: { content: [{ type: "text", text: "partial" }] },
		});
		pump.handleAgentEvent({
			type: "tool_execution_start",
			toolCallId: "read-1",
			toolName: "read",
			args: { path: "src/auth.ts" },
		});

		expect(pump.getTaskPartials()).toHaveLength(1);
		expect(pump.getLiveStateSnapshot()).toMatchObject({ liveTools: 2, taskPartials: 1 });

		pump.handleAgentEvent({
			type: "agent_end",
			messages: [{ id: "final", role: "assistant", content: "done" }],
		});

		expect(pump.getTaskPartials()).toHaveLength(0);
		expect(pump.getLiveStateSnapshot()).toMatchObject({ liveTools: 0, taskPartials: 0, draftMessage: false });
		expect(pump.viewModel().messages.map((message) => message.id)).toEqual(["final"]);
	});

	it("drops the committed-message cache on rehydration so old session messages cannot ghost", () => {
		const pump = new RpcTranscriptPump();

		expect(pump.replaceFromMessages([{ id: "old", role: "user", content: "old session" }]).messages.map((message) => message.id)).toEqual(["old"]);
		expect(pump.getLiveStateSnapshot().committedCacheMessages).toBe(1);

		const next = pump.replaceFromMessages([{ id: "new", role: "user", content: "new session" }]);

		expect(next.messages.map((message) => message.id)).toEqual(["new"]);
		expect(next.messages.map((message) => chatMessageViewModelToPlainText(message))).toEqual(["new session"]);
	});

	it("preserves Track B transcript blocks through the RPC controller", () => {
		const pump = new RpcTranscriptPump();
		const transcript = pump.replaceFromMessages([
			{
				id: "skill-user",
				role: "user",
				content: "<skill name=\"deep-research\" location=\"/skills/dr/SKILL.md\">\nbody\n</skill>\n\nplease research",
			},
			{
				id: "markdown-code",
				role: "assistant",
				content: "Before code.\n```ts\nconst value = 1;\n```\nAfter code.",
			},
			{
				id: "edit-call",
				role: "assistant",
				content: [{ type: "toolCall", id: "edit-1", name: "edit", arguments: { path: "src/auth.ts" } }],
			},
			{
				role: "toolResult",
				toolCallId: "edit-1",
				toolName: "edit",
				name: "edit",
				content: [{ type: "text", text: "+1 -1" }],
				details: { diff: "- old\n+ new" },
			},
			{ id: "custom", role: "custom", customType: "sumocode-theme-result", display: true, content: "switched to obsidian" },
			{ id: "compaction", role: "compactionSummary", summary: "Kept the important state.", tokensBefore: 42000 },
		]);

		expect(transcript.messages).toHaveLength(5);
		expect(transcript.messages[0]?.blocks).toEqual([
			{ type: "skill", name: "deep-research", expanded: false, content: "body" },
			{ type: "markdown", text: "please research" },
		]);
		expect(transcript.messages[1]?.blocks).toEqual([
			{ type: "markdown", text: "Before code.\n" },
			{ type: "code", lang: "ts", source: "const value = 1;" },
			{ type: "markdown", text: "\nAfter code." },
		]);
		expect(transcript.messages[2]?.blocks).toEqual([{
			type: "activity",
			activity: {
				id: "edit-1",
				kind: "tool",
				title: "edit",
				status: "succeeded",
				invocation: { path: "src/auth.ts" },
				subject: "src/auth.ts",
				outputTail: "+1 -1",
				body: { kind: "diff", text: "- old\n+ new" },
			},
		}]);
		expect(chatMessageViewModelToPlainText(transcript.messages[2]!)).toContain("ctrl+o diff");
		expect(transcript.messages[3]?.blocks).toEqual([
			{ type: "markdown", text: "[sumocode-theme-result]" },
			{ type: "markdown", text: "switched to obsidian" },
		]);
		expect(transcript.messages[4]?.blocks).toEqual([{
			type: "summary",
			kind: "compaction",
			label: "[compaction] Compacted from 42,000 tokens",
			content: "Kept the important state.",
			expanded: false,
		}]);
	});

	it("folds live task execution partial details into the active Activity block", () => {
		const pump = new RpcTranscriptPump();
		const taskCall = {
			type: "toolCall",
			id: "tc-task",
			name: "task",
			arguments: { type: "single", tasks: [{ prompt: "## Audit auth\n\nFind risky files." }] },
		};

		pump.handleAgentEvent({ type: "message_start", message: { role: "assistant", content: "" } });
		pump.handleAgentEvent({ type: "message_update", message: { role: "assistant", content: [taskCall] } });
		const transcript = pump.handleAgentEvent({
			type: "tool_execution_update",
			toolCallId: "tc-task",
			toolName: "task",
			args: taskCall.arguments,
			partialResult: {
				content: [{ type: "text", text: "reading auth files" }],
				details: {
					mode: "single",
					results: [{
						prompt: "## Audit auth\n\nFind risky files.",
						exitCode: -1,
						messages: [],
						toolEvents: [{ id: "read-1", name: "read", args: { path: "src/auth.ts" }, status: "running" }],
						usage: { input: 0, output: 0 },
						model: "openai-codex/gpt-5.5",
						thinking: "high",
					}],
				},
			},
		});

		expect(transcript.messages[0]?.blocks[0]).toMatchObject({
			type: "activity",
			activity: {
				title: "Audit auth",
				model: "openai-codex/gpt-5.5",
				thinking: "high",
				status: "running",
				activeTools: [{ id: "read-1", title: "read", status: "running", invocation: { path: "src/auth.ts" } }],
			},
		});
	});

	it("folds non-task live tool execution updates into one SUMO block by toolCallId", () => {
		const pump = new RpcTranscriptPump();
		pump.handleAgentEvent({
			type: "message_start",
			message: {
				role: "assistant",
				content: [
					{ type: "text", text: "Reading." },
					{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "src/auth/session.ts" } },
				],
			},
		});
		pump.handleAgentEvent({
			type: "message_end",
			message: {
				role: "assistant",
				content: [
					{ type: "text", text: "Reading." },
					{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "src/auth/session.ts" } },
				],
			},
		});
		pump.handleAgentEvent({
			type: "tool_execution_start",
			toolCallId: "read-1",
			toolName: "read",
			args: { path: "src/auth/session.ts" },
		});

		let transcript = pump.viewModel();
		let activityBlocks = transcript.messages.flatMap((message) => message.blocks).filter((block) => block.type === "activity");
		expect(transcript.messages).toHaveLength(1);
		expect(activityBlocks).toHaveLength(1);
		expect(activityBlocks[0]).toMatchObject({
			type: "activity",
			activity: { id: "read-1", title: "read", status: "running", invocation: { path: "src/auth/session.ts" } },
		});

		pump.handleAgentEvent({
			type: "tool_execution_update",
			toolCallId: "read-1",
			toolName: "read",
			args: { path: "src/auth/session.ts" },
			partialResult: { content: [{ type: "text", text: "partial file contents" }] },
		});
		expect(pump.viewModel().messages[0]?.blocks[1]).toMatchObject({
			type: "activity",
			activity: { id: "read-1", status: "running", outputTail: "partial file contents" },
		});

		pump.handleAgentEvent({
			type: "tool_execution_end",
			toolCallId: "read-1",
			toolName: "read",
			args: { path: "src/auth/session.ts" },
			result: { content: [{ type: "text", text: "final file contents" }] },
			isError: false,
		});
		pump.handleAgentEvent({
			type: "message_start",
			message: {
				role: "toolResult",
				toolCallId: "read-1",
				toolName: "read",
				content: [{ type: "text", text: "final file contents" }],
				isError: false,
			},
		});

		transcript = pump.viewModel();
		activityBlocks = transcript.messages.flatMap((message) => message.blocks).filter((block) => block.type === "activity");
		expect(transcript.messages).toHaveLength(1);
		expect(transcript.messages[0]?.role).toBe("sumo");
		expect(activityBlocks).toHaveLength(1);
		expect(activityBlocks[0]).toEqual({
			type: "activity",
			activity: {
				id: "read-1",
				kind: "tool",
				title: "read",
				status: "succeeded",
				invocation: { path: "src/auth/session.ts" },
				subject: "src/auth/session.ts",
				outputTail: "final file contents",
				body: { kind: "source", text: "final file contents", totalLines: 1 },
			},
		});
	});
});
