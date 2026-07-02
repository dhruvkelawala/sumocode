import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
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
	if (result.type === "tool" && typeof result.tool === "object" && result.tool !== null) {
		const tool = result.tool as Record<string, unknown>;
		if (tool.status === "pending") tool.status = "running";
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
		for (const event of readJsonl("scratch/rpc-spike/events-task-partial.jsonl")) pump.handleAgentEvent(event);

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
		let toolBlocks = transcript.messages.flatMap((message) => message.blocks).filter((block) => block.type === "tool");
		expect(transcript.messages).toHaveLength(1);
		expect(toolBlocks).toHaveLength(1);
		expect(toolBlocks[0]).toMatchObject({
			type: "tool",
			tool: { id: "read-1", name: "read", status: "running", input: { path: "src/auth/session.ts" }, output: undefined },
		});

		pump.handleAgentEvent({
			type: "tool_execution_update",
			toolCallId: "read-1",
			toolName: "read",
			args: { path: "src/auth/session.ts" },
			partialResult: { content: [{ type: "text", text: "partial file contents" }] },
		});
		expect(pump.viewModel().messages[0]?.blocks[1]).toMatchObject({
			type: "tool",
			tool: { id: "read-1", status: "running", output: "partial file contents" },
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
		toolBlocks = transcript.messages.flatMap((message) => message.blocks).filter((block) => block.type === "tool");
		expect(transcript.messages).toHaveLength(1);
		expect(transcript.messages[0]?.role).toBe("sumo");
		expect(toolBlocks).toHaveLength(1);
		expect(toolBlocks[0]).toEqual({
			type: "tool",
			tool: {
				id: "read-1",
				name: "read",
				status: "success",
				input: { path: "src/auth/session.ts" },
				output: "final file contents",
				details: undefined,
				error: undefined,
				expanded: true,
			},
		});
	});
});
