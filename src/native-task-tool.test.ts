// oxlint-disable anti-slop/no-runtime-typeof -- retained args are object-shaped until the budget replaces them with a string preview.
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, promises as fsPromises, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	BoundedUtf8Tail,
	CHILD_JSON_FRAME_MAX_BYTES,
	CHILD_RETAINED_RESULT_MAX_BYTES,
	CHILD_STDERR_TAIL_MAX_BYTES,
	TRUNCATED_HEAD_MARKER,
	TRUNCATED_TAIL_MARKER,
} from "./child-protocol.js";
import { taskTool } from "./native-task-tool.js";

type RetainedPayloadValue = string | number | boolean | null | RetainedPayloadValue[] | RetainedPayloadObject;
type RetainedPayloadObject = { [key: string]: RetainedPayloadValue };

type RetainedContentPart = {
	type: string;
	text?: string;
	thinking?: string;
	data?: string;
	mimeType?: string;
	id?: string;
	name?: string;
	arguments?: RetainedPayloadObject;
};
type RetainedMessage = {
	role: string;
	content: string | RetainedContentPart[];
	toolCallId?: string;
	toolName?: string;
	addedToolNames?: string[];
	details?: RetainedPayloadValue;
	errorMessage?: string;
	usage?: { input: number; output: number };
};
type RetainedTaskResult = {
	exitCode: number;
	stopReason?: string;
	messages?: RetainedMessage[];
	toolEvents?: Array<{ id?: string; name?: string; args?: object | string; status: string; output?: string }>;
	stderr?: string;
	streamingText?: string;
	usage?: { turns: number };
};

interface TaskUpdate {
	content?: Array<{ type: string; text: string }>;
	details: { results: RetainedTaskResult[] };
}

interface TaskToolResult {
	isError?: boolean;
	content: Array<{ type: string; text: string }>;
	details?: { mode?: string; results?: RetainedTaskResult[] };
}

class FakeTaskProcess extends EventEmitter {
	public readonly stdin = { write: vi.fn(), end: vi.fn() };
	public readonly stdout = new EventEmitter();
	public readonly stderr = new EventEmitter();
	public killed = false;
	public readonly kill = vi.fn(() => {
		this.killed = true;
		return true;
	});
}

function registeredTask(
	spawned: FakeTaskProcess,
	options: { fork?: boolean; sessionFile?: string } = {},
) {
	let definition: { execute: (...args: unknown[]) => Promise<TaskToolResult> } | undefined;
	const pi = {
		registerTool: vi.fn((toolDefinition) => {
			// SAFETY: the registration double stores the task definition consumed below.
			definition = toolDefinition as typeof definition;
		}),
		on: vi.fn(),
		getThinkingLevel: vi.fn(() => "low"),
		getActiveTools: vi.fn(() => ["read"]),
	};
	const spawn = vi.fn((_command: string, _args: readonly string[]) => spawned);
	// SAFETY: the Pi double exposes every taskTool registration/runtime method used here.
	taskTool(undefined, spawn as never)(pi as never);
	const execute = (signal?: AbortSignal, onUpdate?: (update: TaskUpdate) => void) => definition!.execute(
		"bounded-task",
		{ type: "single", tasks: [{ prompt: "bounded child", fork: options.fork ?? false }] },
		signal,
		onUpdate,
		// SAFETY: the context double supplies the task execution surface.
		{ cwd: process.cwd(), model: undefined, sessionManager: { getSessionFile: () => options.sessionFile } } as never,
	);
	return { execute, spawn };
}

function resultExitCodes(update: TaskUpdate): number[] {
	return update.details.results.map((result) => result.exitCode);
}

function emitTaskEvent<TEvent extends object>(proc: FakeTaskProcess, event: TEvent): void {
	proc.stdout.emit("data", `${JSON.stringify(event)}\n`);
}

function collectPayloadStrings(value: RetainedPayloadValue | undefined, into: string[]): void {
	if (typeof value === "string") {
		into.push(value);
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) collectPayloadStrings(item, into);
		return;
	}
	if (value && typeof value === "object") {
		for (const item of Object.values(value)) collectPayloadStrings(item, into);
	}
}

function retainedPayloadText(result: RetainedTaskResult): string[] {
	const text: string[] = [];
	for (const message of result.messages ?? []) {
		if (Array.isArray(message.content)) {
			for (const part of message.content) {
				if (part.text !== undefined) text.push(part.text);
				if (part.thinking !== undefined) text.push(part.thinking);
				if (part.data !== undefined) text.push(part.data);
				if (part.arguments !== undefined) collectPayloadStrings(part.arguments, text);
			}
		} else {
			text.push(message.content);
		}
		if (message.details !== undefined) collectPayloadStrings(message.details, text);
		if (message.errorMessage !== undefined) text.push(message.errorMessage);
	}
	for (const event of result.toolEvents ?? []) {
		if (event.args !== undefined) text.push(typeof event.args === "string" ? event.args : JSON.stringify(event.args));
		if (event.output !== undefined) text.push(event.output);
	}
	if (result.streamingText !== undefined) text.push(result.streamingText);
	return text;
}

describe("native task tool", () => {
	it("reports unscheduled parallel workers queued until their existing slot starts", async () => {
		let definition: { execute: (...args: unknown[]) => Promise<TaskToolResult> } | undefined;
		// SAFETY: the registerTool double forwards the definition to the local slot;
		// the tool emits the same shape the execute call sites below expect.
		const pi = {
			registerTool: vi.fn((toolDefinition) => {
				// SAFETY: the registerTool double forwards the definition to the local slot.
				definition = toolDefinition as typeof definition;
			}),
			on: vi.fn(),
			getThinkingLevel: vi.fn(() => "low"),
			getActiveTools: vi.fn(() => ["read"]),
		};
		// SAFETY: the on/registerTool/getThinkingLevel/getActiveTools doubles supply the
		// surfaces taskTool reads; no subprocess runs in this test.
		taskTool({
			name: "task",
			label: "Task",
			description: "test",
			maxParallelTasks: 8,
			maxConcurrency: 2,
			collapsedItemCount: 10,
			skillListLimit: 30,
			systemPromptPatches: [],
		})(pi as never);

		// Faithful subprocess double: a fake `pi` executable that stays alive
		// until a per-pid close file appears, then exits 0. The tool resolves
		// each task's exit code from the child's close event, so the fixture
		// observes the exact scheduling/queueing sequencing the test asserts.
		const fakePiDir = mkdtempSync(join(tmpdir(), "sumocode-fake-pi-"));
		const pidsDir = join(fakePiDir, "pids");
		mkdirSync(pidsDir);
		writeFileSync(join(fakePiDir, "pi"), [
			"#!/usr/bin/env bash",
			`dir="${fakePiDir}"`,
			'echo "$$" > "${dir}/pids/$$"',
			'while [ ! -f "${dir}/close-$$" ]; do sleep 0.02; done',
			"exit 0",
		].join("\n"));
		chmodSync(join(fakePiDir, "pi"), 0o755);
		const originalPath = process.env.PATH ?? "";
		process.env.PATH = `${fakePiDir}:${originalPath}`;
		process.env.SUMOCODE_FAKE_PI_DIR = fakePiDir;

		const updates: TaskUpdate[] = [];
		try {
			const execution = definition!.execute(
				"parallel-call",
				{
					type: "parallel",
					tasks: Array.from({ length: 4 }, (_, index) => ({ prompt: `Task ${index + 1}`, fork: false })),
				},
				undefined,
				(update: TaskUpdate) => updates.push(update),
				// SAFETY: the ctx double supplies the cwd/model/sessionManager surface the tool reads.
				{
					cwd: process.cwd(),
					model: undefined,
					sessionManager: { getSessionFile: () => undefined },
				} as never,
			);

			expect(resultExitCodes(updates[0])).toEqual([-2, -2, -2, -2]);
			await vi.waitFor(() => expect(readdirSync(pidsDir)).toHaveLength(2));
			expect(resultExitCodes(updates.at(-1)!)).toEqual([-1, -1, -2, -2]);

			writeFileSync(join(fakePiDir, `close-${readdirSync(pidsDir).sort()[0]}`), "");
			await vi.waitFor(() => expect(resultExitCodes(updates.at(-1)!)).toEqual([0, -1, -1, -2]));
			await vi.waitFor(() => expect(readdirSync(pidsDir)).toHaveLength(3));

			writeFileSync(join(fakePiDir, `close-${readdirSync(pidsDir).sort()[1]}`), "");
			await vi.waitFor(() => expect(resultExitCodes(updates.at(-1)!)).toEqual([0, 0, -1, -1]));
			await vi.waitFor(() => expect(readdirSync(pidsDir)).toHaveLength(4));

			for (const pid of readdirSync(pidsDir)) writeFileSync(join(fakePiDir, `close-${pid}`), "");
			await execution;
		} finally {
			process.env.PATH = originalPath;
			delete process.env.SUMOCODE_FAKE_PI_DIR;
			rmSync(fakePiDir, { recursive: true, force: true });
		}
	});

	it.each(["single", "chain", "parallel"] as const)("marks %s preparation failures as tool errors", async (mode) => {
		let definition: { execute: (...args: unknown[]) => Promise<{ isError?: boolean; content: Array<{ type: string; text: string }>; details?: { mode?: string; results?: unknown[] } }> } | undefined;
		// SAFETY: the registerTool double forwards the definition to the local slot;
		// the tool emits the same shape the execute call sites below expect.
		const pi = {
			registerTool: vi.fn((toolDefinition) => {
				// SAFETY: the registerTool double forwards the definition to the local slot.
				definition = toolDefinition as typeof definition;
			}),
			on: vi.fn(),
			getThinkingLevel: vi.fn(() => "low"),
			getActiveTools: vi.fn(() => ["read"]),
		};
		// SAFETY: the on/registerTool/getThinkingLevel/getActiveTools doubles supply the
		// surfaces taskTool reads; no subprocess runs in this test.
		taskTool()(pi as never);

		const result = await definition!.execute(
			`prepare-${mode}`,
			{ type: mode, tasks: [{ prompt: "Do work", skill: "__missing_plan_082_skill__", fork: false }] },
			undefined,
			undefined,
			// SAFETY: the ctx double supplies the cwd/model/sessionManager surface the tool reads.
			{
				cwd: process.cwd(),
				model: undefined,
				sessionManager: { getSessionFile: () => undefined },
			} as never,
		);

		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toContain("Unknown skill: __missing_plan_082_skill__");
		expect(result.details?.mode).toBe(mode);
	});

	it("keeps an oversized-frame task and its fork alive until forced child close", async () => {
		vi.useFakeTimers();
		const sessionDir = mkdtempSync(join(tmpdir(), "sumocode-task-session-"));
		const sessionFile = join(sessionDir, "session.jsonl");
		writeFileSync(sessionFile, "");
		const remove = vi.spyOn(fsPromises, "rm");
		try {
			const proc = new FakeTaskProcess();
			const task = registeredTask(proc, { fork: true, sessionFile });
			let resolved = false;
			const running = task.execute().then((result) => {
				resolved = true;
				return result;
			});
			await vi.waitFor(() => expect(task.spawn).toHaveBeenCalledOnce());
			const args = task.spawn.mock.calls[0]?.[1] ?? [];
			const forkDir = args[args.indexOf("--session-dir") + 1] ?? "";

			proc.stdout.emit("data", Buffer.concat([
				Buffer.alloc(CHILD_JSON_FRAME_MAX_BYTES + 1, 0x71),
				Buffer.from("\n"),
			]));
			await Promise.resolve();
			await Promise.resolve();
			expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
			expect(resolved).toBe(false);
			expect(remove).not.toHaveBeenCalledWith(forkDir, { recursive: true, force: true });
			expect(existsSync(forkDir)).toBe(true);

			vi.advanceTimersByTime(5001);
			expect(proc.kill).toHaveBeenCalledWith("SIGKILL");
			expect(resolved).toBe(false);
			expect(existsSync(forkDir)).toBe(true);

			proc.emit("close", null, "SIGKILL");
			proc.emit("error", new Error("late child error"));
			proc.emit("close", 1);
			const result = await running;
			expect(result.isError).toBe(true);
			expect(result.content[0]?.text).toContain(`exceeded ${CHILD_JSON_FRAME_MAX_BYTES} bytes`);
			expect(result.content[0]?.text).not.toContain("qqqq");
			expect(remove).toHaveBeenCalledWith(forkDir, { recursive: true, force: true });
			expect(remove).toHaveBeenCalledTimes(1);
			expect(existsSync(forkDir)).toBe(false);
		} finally {
			remove.mockRestore();
			vi.useRealTimers();
			rmSync(sessionDir, { recursive: true, force: true });
		}
	});

	it("keeps protocol failure ownership when the child errors before close", async () => {
		vi.useFakeTimers();
		try {
			const proc = new FakeTaskProcess();
			const task = registeredTask(proc);
			let resolved = false;
			const running = task.execute().then((result) => {
				resolved = true;
				return result;
			});
			await vi.waitFor(() => expect(task.spawn).toHaveBeenCalledOnce());

			proc.stdout.emit("data", Buffer.concat([
				Buffer.alloc(CHILD_JSON_FRAME_MAX_BYTES + 1, 0x71),
				Buffer.from("\n"),
			]));
			proc.emit("error", new Error("termination failed"));
			await Promise.resolve();
			await Promise.resolve();
			expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
			expect(resolved).toBe(false);

			proc.emit("close", null, "SIGTERM");
			const result = await running;
			expect(result.content[0]?.text).toContain(`exceeded ${CHILD_JSON_FRAME_MAX_BYTES} bytes`);
			expect(result.content[0]?.text).not.toContain("termination failed");
		} finally {
			vi.useRealTimers();
		}
	});

	it("delivers the delegated prompt via stdin and keeps it out of child argv", async () => {
		// Issue 391: same contract as the subagent backend — pinned Pi print mode
		// reads piped stdin verbatim, so the prompt never appears in argv.
		const proc = new FakeTaskProcess();
		const task = registeredTask(proc);
		const running = task.execute();
		await vi.waitFor(() => expect(task.spawn).toHaveBeenCalledOnce());
		const argv = task.spawn.mock.calls[0]?.[1] ?? [];
		expect(argv).not.toContain("bounded child");

		proc.stdout.emit("data", JSON.stringify({
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "done" }],
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
			},
		}));
		proc.emit("close", 0);

		const result = await running;
		expect(result.isError).toBeUndefined();
		expect(proc.stdin.write).toHaveBeenCalledTimes(1);
		expect(proc.stdin.write).toHaveBeenCalledWith("bounded child");
		expect(proc.stdin.end).toHaveBeenCalled();
	});

	it("settles a no-child spawn error without waiting for close", async () => {
		const proc = new FakeTaskProcess();
		const running = registeredTask(proc).execute();
		proc.emit("error", new Error("spawn failed"));

		const result = await running;
		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toContain("spawn failed");
	});

	it("bounds stderr and final results while processing a final partial line", async () => {
		const proc = new FakeTaskProcess();
		const running = registeredTask(proc).execute();
		proc.stderr.emit("data", Buffer.alloc(CHILD_STDERR_TAIL_MAX_BYTES + 1, 0x65));
		const finalText = "r".repeat(CHILD_RETAINED_RESULT_MAX_BYTES + 1);
		proc.stdout.emit("data", JSON.stringify({
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: finalText }],
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
			},
		}));
		proc.emit("close", 0);

		const result = await running;
		expect(result.isError).toBeUndefined();
		expect(result.content[0]?.text).toContain(TRUNCATED_HEAD_MARKER);
		expect(Buffer.byteLength(result.content[0]?.text ?? "")).toBeLessThanOrEqual(CHILD_RETAINED_RESULT_MAX_BYTES);
	});

	it("shares one UTF-8 payload budget across retained messages and tool updates", async () => {
		const proc = new FakeTaskProcess();
		const updates: TaskUpdate[] = [];
		const running = registeredTask(proc).execute(undefined, (update) => updates.push(update));
		const multibyteChunk = "界".repeat(100_000);
		const usage = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 10, cost: { total: 0.01 } };

		for (let index = 0; index < 4; index += 1) {
			emitTaskEvent(proc, {
				type: "message_end",
				message: {
					role: "user",
					content: [{ type: "text", text: multibyteChunk }, { type: "image", data: `image-${index}`, mimeType: "image/png" }],
					timestamp: index,
				},
			});
			emitTaskEvent(proc, {
				type: "tool_result_end",
				message: {
					role: "toolResult",
					toolCallId: `message-tool-${index}`,
					toolName: "read",
					content: [{ type: "text", text: multibyteChunk }],
					details: { page: index },
					isError: false,
					timestamp: index,
				},
			});
			emitTaskEvent(proc, {
				type: "message_end",
				message: {
					role: "assistant",
					content: [
						{ type: "text", text: multibyteChunk },
						{ type: "toolCall", id: `assistant-tool-${index}`, name: "read", arguments: { path: `file-${index}` } },
					],
					usage,
					model: "test-model",
					stopReason: "toolUse",
					timestamp: index,
				},
			});
		}

		for (let index = 0; index < 3; index += 1) {
			emitTaskEvent(proc, {
				type: "tool_execution_update",
				toolCallId: "event-tool-a",
				toolName: "read",
				args: { path: "large-a" },
				partialResult: "a".repeat(200_000 + index),
			});
		}
		emitTaskEvent(proc, {
			type: "tool_execution_end",
			toolCallId: "event-tool-a",
			toolName: "read",
			args: { path: "large-a" },
			result: "a".repeat(200_003),
			isError: false,
		});
		emitTaskEvent(proc, {
			type: "tool_execution_end",
			toolCallId: "event-tool-b",
			toolName: "bash",
			args: { command: "true" },
			result: "b".repeat(100_000),
			isError: false,
		});
		emitTaskEvent(proc, { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "transient" } });
		expect(updates.at(-1)?.details.results[0]?.streamingText).toBe("transient");
		emitTaskEvent(proc, {
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: `FINAL:${multibyteChunk}` }],
				usage,
				model: "test-model",
				stopReason: "stop",
				timestamp: 99,
			},
		});
		proc.emit("close", 0);

		const toolResult = await running;
		const result = toolResult.details?.results?.[0];
		expect(result).toBeDefined();
		if (!result) throw new Error("task result is missing");
		const payload = retainedPayloadText(result);
		expect(payload.reduce((bytes, value) => bytes + Buffer.byteLength(value, "utf8"), 0)).toBeLessThanOrEqual(CHILD_RETAINED_RESULT_MAX_BYTES);
		expect(payload.join("").split(TRUNCATED_HEAD_MARKER)).toHaveLength(2);
		expect(payload.join("")).not.toContain("�");
		expect(toolResult.content[0]?.text).toMatch(/^FINAL:/);
		expect(toolResult.content[0]?.text).toContain(TRUNCATED_HEAD_MARKER);
		expect(result.streamingText).toBeUndefined();
		expect(result.usage?.turns).toBe(5);
		const firstMessage = result.messages?.[0];
		expect(firstMessage?.role).toBe("user");
		expect(Array.isArray(firstMessage?.content) ? firstMessage.content[1] : undefined).toMatchObject({ type: "image", data: "", mimeType: "image/png" });
		const firstToolResult = result.messages?.find((message) => message.role === "toolResult");
		expect(firstToolResult).toMatchObject({ toolCallId: "message-tool-0" });
		expect(firstToolResult?.role === "toolResult" ? firstToolResult.details : undefined).toBeUndefined();
		expect(result.toolEvents).toMatchObject([
			{ id: "event-tool-a", status: "success" },
			{ id: "event-tool-b", status: "success" },
		]);
	});

	it("bounds large native tool args and replaces repeated updates without double charging", async () => {
		const proc = new FakeTaskProcess();
		const running = registeredTask(proc).execute();
		const largeArgs = (suffix: string) => ({ path: `file-${suffix}.txt`, content: `${suffix}:${"x".repeat(1024 * 1024)}` });

		for (let index = 0; index < 6; index += 1) {
			emitTaskEvent(proc, {
				type: "tool_execution_start",
				toolCallId: `write-${index}`,
				toolName: "write",
				args: largeArgs(`start-${index}`),
			});
		}
		for (const suffix of ["update-a", "update-b", "latest"]) {
			emitTaskEvent(proc, {
				type: "tool_execution_update",
				toolCallId: "write-0",
				toolName: "write",
				args: largeArgs(suffix),
			});
		}
		proc.emit("close", 0);

		const toolResult = await running;
		const result = toolResult.details?.results?.[0];
		if (!result) throw new Error("task result is missing");
		const payload = retainedPayloadText(result).join("");
		expect(Buffer.byteLength(payload, "utf8")).toBeLessThanOrEqual(CHILD_RETAINED_RESULT_MAX_BYTES);
		expect(payload.split(TRUNCATED_HEAD_MARKER)).toHaveLength(2);
		expect(result.toolEvents).toHaveLength(6);
		expect(result.toolEvents?.[0]).toMatchObject({ id: "write-0", name: "write", status: "running" });
		expect(payload).toContain("latest");
	});

	it("does not duplicate a retained marker when tool updates omit output", async () => {
		const proc = new FakeTaskProcess();
		const running = registeredTask(proc).execute();
		const args = { path: "large.txt" };

		emitTaskEvent(proc, {
			type: "tool_execution_update",
			toolCallId: "write-1",
			toolName: "write",
			args,
			partialResult: "x".repeat(CHILD_RETAINED_RESULT_MAX_BYTES + 1024),
		});
		for (let index = 0; index < 3; index += 1) {
			emitTaskEvent(proc, {
				type: "tool_execution_update",
				toolCallId: "write-1",
				toolName: "write",
			});
		}
		proc.emit("close", 0);

		const toolResult = await running;
		const result = toolResult.details?.results?.[0];
		if (!result) throw new Error("task result is missing");
		const payload = retainedPayloadText(result).join("");
		expect(Buffer.byteLength(payload, "utf8")).toBeLessThanOrEqual(CHILD_RETAINED_RESULT_MAX_BYTES);
		expect(payload.split(TRUNCATED_HEAD_MARKER)).toHaveLength(2);
		expect(result.toolEvents).toHaveLength(1);
		expect(result.toolEvents?.[0]).toMatchObject({ id: "write-1", name: "write", status: "running" });
	});

	it("bounds non-text message payloads inside the shared run budget", async () => {
		const proc = new FakeTaskProcess();
		const running = registeredTask(proc).execute();
		const usage = { input: 0, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 1, cost: { total: 0 } };
		const huge = (label: string, mebibytes: number) => `${label}:${"x".repeat(mebibytes * 1024 * 1024)}`;

		emitTaskEvent(proc, {
			type: "message_end",
			message: { role: "user", content: [{ type: "image", mimeType: "image/png", data: huge("USER_IMAGE", 2) }] },
		});
		emitTaskEvent(proc, {
			type: "tool_result_end",
			message: {
				role: "toolResult",
				toolCallId: "image-tool",
				toolName: "read",
				content: [{ type: "image", mimeType: "image/png", data: huge("TOOL_IMAGE", 2) }],
				details: { blob: huge("TOOL_DETAILS", 2) },
			},
		});
		for (const turn of ["FIRST", "FINAL"]) {
			emitTaskEvent(proc, {
				type: "message_end",
				message: {
					role: "assistant",
					content: [
						{ type: "thinking", thinking: huge(`${turn}_THINKING`, 1), thinkingSignature: huge("SIGNATURE", 1) },
						{ type: "toolCall", id: `${turn.toLowerCase()}-tool`, name: "write", arguments: { content: huge(`${turn}_ARGUMENTS`, 4) }, thoughtSignature: huge("THOUGHT_SIGNATURE", 1) },
					],
					usage,
				},
			});
		}
		proc.emit("close", 0);

		const toolResult = await running;
		const result = toolResult.details?.results?.[0];
		if (!result) throw new Error("task result is missing");
		const payload = retainedPayloadText(result).join("");
		expect(Buffer.byteLength(payload, "utf8")).toBeLessThanOrEqual(CHILD_RETAINED_RESULT_MAX_BYTES);
		expect(payload.split(TRUNCATED_HEAD_MARKER)).toHaveLength(2);
		expect(payload).not.toContain("FIRST_ARGUMENTS");
		expect(payload).toContain("FINAL_THINKING");
		expect(result.messages?.[0]?.content).toMatchObject([{ type: "image", data: "", mimeType: "image/png" }]);
		expect(result.messages?.[1]).toMatchObject({ role: "toolResult", details: undefined, content: [{ type: "image", data: "" }] });
		expect(result.messages?.[2]?.content).toMatchObject([
			{ type: "thinking", thinking: "" },
			{ type: "toolCall", id: "first-tool", arguments: {} },
		]);
		expect(result.messages?.[3]?.content).toMatchObject([
			{ type: "thinking", thinking: expect.stringContaining("FINAL_THINKING") },
			{ type: "toolCall", id: "final-tool" },
		]);
		expect(JSON.stringify(result.messages)).not.toContain("SIGNATURE");
		expect(result.usage?.turns).toBe(2);
	});

	it("keeps the useful final answer when later assistant frames have no text", async () => {
		const proc = new FakeTaskProcess();
		const running = registeredTask(proc).execute();
		const usage = { input: 0, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 1, cost: { total: 0 } };

		emitTaskEvent(proc, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "x".repeat(5 * 1024 * 1024) }], usage } });
		emitTaskEvent(proc, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "THE USEFUL ANSWER: 42" }], usage } });
		emitTaskEvent(proc, { type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "README.md" } }], usage } });
		emitTaskEvent(proc, { type: "message_end", message: { role: "assistant", content: [{ type: "thinking", thinking: "hmm" }], usage } });
		proc.emit("close", 0);

		const toolResult = await running;
		const result = toolResult.details?.results?.[0];
		if (!result) throw new Error("task result is missing");
		const delivered = toolResult.content[0]?.text ?? "";
		const payload = retainedPayloadText(result).join("");
		expect(delivered).toContain("THE USEFUL ANSWER: 42");
		expect(delivered).toContain(TRUNCATED_HEAD_MARKER);
		expect(delivered).not.toBe("(no output)");
		expect(Buffer.byteLength(payload, "utf8")).toBeLessThanOrEqual(CHILD_RETAINED_RESULT_MAX_BYTES);
		expect(payload.split(TRUNCATED_HEAD_MARKER)).toHaveLength(2);
	});

	it("drops malformed non-text fields without throwing the task event loop", async () => {
		const proc = new FakeTaskProcess();
		const running = registeredTask(proc).execute();
		const usage = { input: 0, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 1, cost: { total: 0 } };

		expect(() => emitTaskEvent(proc, {
			type: "message_end",
			message: { role: "user", content: [{ type: "image", mimeType: "image/png" }] },
		})).not.toThrow();
		expect(() => emitTaskEvent(proc, {
			type: "message_end",
			message: { role: "assistant", content: [{ type: "toolCall", id: "write-1", name: "write" }], usage },
		})).not.toThrow();
		emitTaskEvent(proc, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "safe final" }], usage } });
		proc.emit("close", 0);

		const toolResult = await running;
		expect(toolResult.content[0]?.text).toContain("safe final");
		expect(toolResult.details?.results?.[0]?.messages?.[0]?.content).toMatchObject([{ type: "image", data: "" }]);
	});

	it("caps producer-controlled structural metadata", async () => {
		const proc = new FakeTaskProcess();
		const running = registeredTask(proc).execute();
		const huge = "m".repeat(2 * 1024 * 1024);

		for (let index = 0; index < 8; index += 1) {
			emitTaskEvent(proc, {
				type: "tool_result_end",
				message: {
					role: "toolResult",
					toolCallId: `tool-${index}`,
					toolName: huge,
					addedToolNames: [huge],
					content: [],
					isError: false,
				},
			});
		}
		proc.emit("close", 0);

		const toolResult = await running;
		const result = toolResult.details?.results?.[0];
		if (!result) throw new Error("task result is missing");
		const serialized = JSON.stringify(result.messages);
		expect(Buffer.byteLength(serialized, "utf8")).toBeLessThan(64 * 1024);
		expect(result.messages).toHaveLength(8);
		expect(result.messages?.[0]?.toolName?.length).toBeLessThanOrEqual(256);
		expect(result.messages?.[0]?.addedToolNames?.[0]?.length).toBeLessThanOrEqual(256);
	});

	it("uses bounded tool identifiers as stable update keys", async () => {
		const proc = new FakeTaskProcess();
		const running = registeredTask(proc).execute();
		const hugeId = "i".repeat(1024 * 1024);
		const hugeName = "n".repeat(1024 * 1024);

		emitTaskEvent(proc, { type: "tool_execution_start", toolCallId: hugeId, toolName: hugeName, args: { path: "README.md" } });
		emitTaskEvent(proc, { type: "tool_execution_update", toolCallId: hugeId, toolName: hugeName, partialResult: "working" });
		emitTaskEvent(proc, { type: "tool_execution_end", toolCallId: hugeId, toolName: hugeName, result: "done", isError: false });
		proc.emit("close", 0);

		const toolResult = await running;
		const events = toolResult.details?.results?.[0]?.toolEvents ?? [];
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ status: "success", output: "done" });
		expect(Buffer.byteLength(events[0]?.id ?? "", "utf8")).toBeLessThanOrEqual(256);
		expect(Buffer.byteLength(events[0]?.name ?? "", "utf8")).toBeLessThanOrEqual(256);
	});

	it("keeps bounded native tool identifiers distinct when their prefixes match", async () => {
		const proc = new FakeTaskProcess();
		const running = registeredTask(proc).execute();
		const sharedPrefix = "i".repeat(300);

		for (const toolCallId of [`${sharedPrefix}a`, `${sharedPrefix}b`]) {
			emitTaskEvent(proc, { type: "tool_execution_start", toolCallId, toolName: "read", args: {} });
			emitTaskEvent(proc, { type: "tool_execution_update", toolCallId, toolName: "read", partialResult: "working" });
			emitTaskEvent(proc, { type: "tool_execution_end", toolCallId, toolName: "read", result: "done", isError: false });
		}
		proc.emit("close", 0);

		const toolResult = await running;
		const events = toolResult.details?.results?.[0]?.toolEvents ?? [];
		expect(events).toHaveLength(2);
		expect(new Set(events.map((event) => event.id)).size).toBe(2);
		for (const event of events) {
			expect(event).toMatchObject({ status: "success", output: "done" });
			expect(Buffer.byteLength(event.id ?? "", "utf8")).toBeLessThanOrEqual(256);
		}
	});

	it("preserves literal truncation-marker text when a tool update reuses output", async () => {
		const proc = new FakeTaskProcess();
		const running = registeredTask(proc).execute();
		const literal = `before${TRUNCATED_HEAD_MARKER}after`;

		emitTaskEvent(proc, { type: "tool_execution_start", toolCallId: "marker-tool", toolName: "read", args: { path: "README.md" } });
		emitTaskEvent(proc, { type: "tool_execution_update", toolCallId: "marker-tool", toolName: "read", partialResult: literal });
		emitTaskEvent(proc, { type: "tool_execution_update", toolCallId: "marker-tool", toolName: "read" });
		proc.emit("close", 0);

		const toolResult = await running;
		const events = toolResult.details?.results?.[0]?.toolEvents ?? [];
		expect(events).toHaveLength(1);
		expect(events[0]?.output).toBe(literal);
	});

	it("keeps id-less tool updates bounded and correlated by large raw arguments", async () => {
		const proc = new FakeTaskProcess();
		const running = registeredTask(proc).execute();
		const args = { content: "x".repeat(CHILD_RETAINED_RESULT_MAX_BYTES + 1) };

		emitTaskEvent(proc, { type: "tool_execution_start", toolName: "write", args });
		emitTaskEvent(proc, { type: "tool_execution_end", toolName: "write", args, result: "done", isError: false });
		proc.emit("close", 0);

		const toolResult = await running;
		const events = toolResult.details?.results?.[0]?.toolEvents ?? [];
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ status: "success" });
		expect(events[0]?.id).toMatch(/^h:[0-9a-f]{64}$/);
		expect(Buffer.byteLength(events[0]?.id ?? "", "utf8")).toBeLessThanOrEqual(256);
	});

	it("reclaims prior assistant text when the next answer would overflow", async () => {
		const proc = new FakeTaskProcess();
		const running = registeredTask(proc).execute();
		const usage = { input: 0, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 1, cost: { total: 0 } };
		const finalText = `FINAL:${"f".repeat(3 * 1024 * 1024)}`;

		emitTaskEvent(proc, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "p".repeat(3 * 1024 * 1024) }], usage } });
		emitTaskEvent(proc, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: finalText }], usage } });
		proc.emit("close", 0);

		const toolResult = await running;
		const result = toolResult.details?.results?.[0];
		if (!result) throw new Error("task result is missing");
		const payload = retainedPayloadText(result).join("");
		expect(toolResult.content[0]?.text).toMatch(/^FINAL:/);
		expect(Buffer.byteLength(toolResult.content[0]?.text ?? "", "utf8")).toBeGreaterThanOrEqual(Buffer.byteLength(finalText, "utf8"));
		expect(payload).not.toContain("pppp");
		expect(payload.split(TRUNCATED_HEAD_MARKER)).toHaveLength(2);
		expect(Buffer.byteLength(payload, "utf8")).toBeLessThanOrEqual(CHILD_RETAINED_RESULT_MAX_BYTES);
	});

	it("reclaims prior text when the latest non-text assistant payload would overflow", async () => {
		const proc = new FakeTaskProcess();
		const running = registeredTask(proc).execute();
		const usage = { input: 0, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 1, cost: { total: 0 } };

		emitTaskEvent(proc, { type: "message_end", message: { role: "user", content: "p".repeat(3 * 1024 * 1024) } });
		emitTaskEvent(proc, {
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: "final-tool", name: "write", arguments: { content: "a".repeat(3 * 1024 * 1024) } }],
				usage,
			},
		});
		proc.emit("close", 0);

		const toolResult = await running;
		const result = toolResult.details?.results?.[0];
		if (!result) throw new Error("task result is missing");
		const payload = retainedPayloadText(result).join("");
		expect(payload).not.toContain("pppp");
		expect(payload).toContain("aaaa");
		expect(payload.split(TRUNCATED_HEAD_MARKER)).toHaveLength(2);
		expect(Buffer.byteLength(payload, "utf8")).toBeLessThanOrEqual(CHILD_RETAINED_RESULT_MAX_BYTES);
	});

	it("prioritizes a useful marked final answer and reclaims exhausted prior text", async () => {
		const proc = new FakeTaskProcess();
		const running = registeredTask(proc).execute();
		const usage = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 10, cost: { total: 0.01 } };
		const finalText = `FINAL:${"界".repeat(64)}`;

		emitTaskEvent(proc, {
			type: "message_end",
			message: { role: "user", content: "u".repeat(CHILD_RETAINED_RESULT_MAX_BYTES), timestamp: 1 },
		});
		emitTaskEvent(proc, {
			type: "tool_execution_end",
			toolCallId: "early-tool",
			toolName: "read",
			args: { path: "large", content: "x".repeat(CHILD_RETAINED_RESULT_MAX_BYTES) },
			result: "omitted tool output",
			isError: false,
		});
		emitTaskEvent(proc, {
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: finalText }],
				usage,
				model: "test-model",
				stopReason: "stop",
				timestamp: 2,
			},
		});
		proc.emit("close", 0);

		const toolResult = await running;
		const result = toolResult.details?.results?.[0];
		if (!result) throw new Error("task result is missing");
		const payload = retainedPayloadText(result);
		const firstMessage = result.messages?.[0];
		expect(toolResult.content[0]?.text).toContain(finalText);
		expect(toolResult.content[0]?.text).toContain(TRUNCATED_HEAD_MARKER);
		expect(payload.reduce((bytes, value) => bytes + Buffer.byteLength(value, "utf8"), 0)).toBeLessThanOrEqual(CHILD_RETAINED_RESULT_MAX_BYTES);
		expect(payload.join("").split(TRUNCATED_HEAD_MARKER)).toHaveLength(2);
		expect(Array.isArray(firstMessage?.content) ? firstMessage.content[0]?.text : firstMessage?.content).toBe("");
		expect(result.toolEvents?.[0]).toMatchObject({ id: "early-tool", status: "success", args: {}, output: undefined });
		expect(result.usage?.turns).toBe(1);
	});

	it("lets intervening events use headroom before moving the marker to the next assistant", async () => {
		const proc = new FakeTaskProcess();
		const running = registeredTask(proc).execute();
		const usage = { input: 0, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 1, cost: { total: 0 } };

		emitTaskEvent(proc, { type: "message_end", message: { role: "user", content: "u".repeat(CHILD_RETAINED_RESULT_MAX_BYTES) } });
		emitTaskEvent(proc, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "first answer" }], usage } });
		emitTaskEvent(proc, {
			type: "tool_result_end",
			message: { role: "toolResult", toolCallId: "later-tool", toolName: "read", content: [{ type: "text", text: "later tool output" }] },
		});
		emitTaskEvent(proc, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "second answer" }], usage } });
		proc.emit("close", 0);

		const toolResult = await running;
		const result = toolResult.details?.results?.[0];
		if (!result) throw new Error("task result is missing");
		const payload = retainedPayloadText(result).join("");
		expect(payload).not.toContain("first answer");
		expect(payload).not.toContain("later tool output");
		expect(payload).toContain("second answer");
		expect(payload.split(TRUNCATED_HEAD_MARKER)).toHaveLength(2);
		expect(Buffer.byteLength(payload, "utf8")).toBeLessThanOrEqual(CHILD_RETAINED_RESULT_MAX_BYTES);
		expect(toolResult.content[0]?.text).toContain("second answer");
		expect(toolResult.content[0]?.text).toContain(TRUNCATED_HEAD_MARKER);
		expect(result.usage?.turns).toBe(2);
	});

	it("shares the run budget with a live stream on mid-stream close", async () => {
		const proc = new FakeTaskProcess();
		const running = registeredTask(proc).execute();
		const usage = { input: 0, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 1, cost: { total: 0 } };

		emitTaskEvent(proc, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "prior:" + "p".repeat(1024 * 1024) }], usage } });
		emitTaskEvent(proc, {
			type: "tool_execution_end",
			toolCallId: "mid-stream-write",
			toolName: "write",
			args: { path: "large.txt", content: "a".repeat(256 * 1024) },
			result: "o".repeat(256 * 1024),
			isError: false,
		});
		for (let index = 0; index < 4; index += 1) {
			emitTaskEvent(proc, { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "s".repeat(1024 * 1024) } });
		}
		proc.emit("close", 0);

		const toolResult = await running;
		const result = toolResult.details?.results?.[0];
		if (!result) throw new Error("task result is missing");
		const payload = retainedPayloadText(result).join("");
		expect(Buffer.byteLength(payload, "utf8")).toBeLessThanOrEqual(CHILD_RETAINED_RESULT_MAX_BYTES);
		expect(payload.split(TRUNCATED_HEAD_MARKER)).toHaveLength(2);
		expect(result.streamingText).toContain(TRUNCATED_HEAD_MARKER);
	});

	it("moves a clipped provisional stream marker to the durable final output", async () => {
		const proc = new FakeTaskProcess();
		const running = registeredTask(proc).execute();
		const usage = { input: 0, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 1, cost: { total: 0 } };

		emitTaskEvent(proc, { type: "message_end", message: { role: "user", content: "prior:" + "p".repeat(1024 * 1024) } });
		for (let index = 0; index < 4; index += 1) {
			emitTaskEvent(proc, { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "s".repeat(1024 * 1024) } });
		}
		emitTaskEvent(proc, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "FINAL:" + "f".repeat(3 * 1024 * 1024) }], usage } });
		proc.emit("close", 0);

		const toolResult = await running;
		const result = toolResult.details?.results?.[0];
		if (!result) throw new Error("task result is missing");
		const payload = retainedPayloadText(result).join("");
		expect(result.streamingText).toBeUndefined();
		expect(toolResult.content[0]?.text).toMatch(/^FINAL:/);
		expect(toolResult.content[0]?.text).toContain(TRUNCATED_HEAD_MARKER);
		expect(payload.split(TRUNCATED_HEAD_MARKER)).toHaveLength(2);
		expect(Buffer.byteLength(payload, "utf8")).toBeLessThanOrEqual(CHILD_RETAINED_RESULT_MAX_BYTES);
	});

	it("keeps multi-part and later empty assistant messages useful and UTF-8 clean", async () => {
		const proc = new FakeTaskProcess();
		const running = registeredTask(proc).execute();
		const usage = { input: 0, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 1, cost: { total: 0 } };

		emitTaskEvent(proc, { type: "message_end", message: { role: "user", content: "u".repeat(CHILD_RETAINED_RESULT_MAX_BYTES) } });
		emitTaskEvent(proc, {
			type: "message_end",
			message: { role: "assistant", content: [{ type: "text", text: "" }, { type: "text", text: `FINAL:${"界".repeat(CHILD_RETAINED_RESULT_MAX_BYTES / 2)}` }], usage },
		});
		emitTaskEvent(proc, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "" }], usage } });
		proc.emit("close", 0);

		const toolResult = await running;
		const result = toolResult.details?.results?.[0];
		if (!result) throw new Error("task result is missing");
		const payload = retainedPayloadText(result).join("");
		expect(toolResult.content[0]?.text).toMatch(/^FINAL:/);
		expect(toolResult.content[0]?.text).not.toBe(TRUNCATED_HEAD_MARKER.trim());
		expect(payload.split(TRUNCATED_HEAD_MARKER)).toHaveLength(2);
		expect(payload).not.toContain("�");
		expect(Buffer.byteLength(payload, "utf8")).toBeLessThanOrEqual(CHILD_RETAINED_RESULT_MAX_BYTES);
	});

	it("preserves cancellation and clears its force-kill timer on close", async () => {
		vi.useFakeTimers();
		try {
			const proc = new FakeTaskProcess();
			const controller = new AbortController();
			const running = registeredTask(proc).execute(controller.signal);
			controller.abort();
			expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
			expect(vi.getTimerCount()).toBe(1);
			proc.emit("close", null);

			const result = await running;
			expect(result.isError).toBe(true);
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it("keeps an aborted task owned when the child errors before close", async () => {
		vi.useFakeTimers();
		try {
			const proc = new FakeTaskProcess();
			const controller = new AbortController();
			let resolved = false;
			const running = registeredTask(proc).execute(controller.signal).then((result) => {
				resolved = true;
				return result;
			});

			controller.abort();
			proc.emit("error", new Error("termination failed"));
			await Promise.resolve();
			await Promise.resolve();
			expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
			expect(resolved).toBe(false);
			expect(vi.getTimerCount()).toBe(1);

			vi.advanceTimersByTime(5001);
			expect(proc.kill).toHaveBeenCalledWith("SIGKILL");
			expect(resolved).toBe(false);

			proc.emit("close", null, "SIGKILL");
			const result = await running;
			expect(result.isError).toBe(true);
			expect(result.details?.results?.[0]?.stopReason).toBe("aborted");
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it("keeps a marked, byte-bounded stderr tail on failure", async () => {
		const proc = new FakeTaskProcess();
		const running = registeredTask(proc).execute();
		proc.stderr.emit("data", Buffer.alloc(CHILD_STDERR_TAIL_MAX_BYTES + 1, 0x7a));
		proc.emit("close", 2);

		const result = await running;
		const stderr = result.details?.results?.[0]?.stderr ?? "";
		expect(result.isError).toBe(true);
		expect(stderr).toContain(TRUNCATED_TAIL_MARKER);
		expect(Buffer.byteLength(stderr)).toBeLessThanOrEqual(CHILD_STDERR_TAIL_MAX_BYTES);
	});

	it("materializes stderr only after it changes or when finishing", async () => {
		const proc = new FakeTaskProcess();
		const updates: TaskUpdate[] = [];
		const materialize = vi.spyOn(BoundedUtf8Tail.prototype, "toString");
		try {
			const running = registeredTask(proc).execute(undefined, (update) => updates.push(update));

			for (let index = 0; index < 100; index += 1) proc.stderr.emit("data", "diagnostic");
			expect(materialize).not.toHaveBeenCalled();

			proc.stdout.emit("data", `${JSON.stringify({ type: "tool_execution_start", toolCallId: "1", toolName: "read", args: {} })}\n`);
			expect(materialize).toHaveBeenCalledTimes(1);
			expect(updates.at(-1)?.details.results[0]?.stderr).toContain("diagnostic");

			for (let index = 0; index < 100; index += 1) {
				proc.stdout.emit("data", `${JSON.stringify({ type: "tool_execution_update", toolCallId: "1", partialResult: index })}\n`);
			}
			expect(materialize).toHaveBeenCalledTimes(1);
			proc.stderr.emit("data", "new diagnostic");
			proc.stdout.emit("data", `${JSON.stringify({ type: "tool_execution_update", toolCallId: "1", partialResult: "changed" })}\n`);
			expect(materialize).toHaveBeenCalledTimes(2);

			proc.emit("close", 2);
			await running;
			expect(materialize).toHaveBeenCalledTimes(3);
		} finally {
			materialize.mockRestore();
		}
	});

	it("does not materialize stderr when updates have no reader", async () => {
		const proc = new FakeTaskProcess();
		const materialize = vi.spyOn(BoundedUtf8Tail.prototype, "toString");
		try {
			const running = registeredTask(proc).execute();
			proc.stderr.emit("data", "diagnostic");
			proc.stdout.emit("data", `${JSON.stringify({ type: "tool_execution_start", toolCallId: "1", toolName: "read", args: {} })}\n`);
			expect(materialize).not.toHaveBeenCalled();

			proc.emit("close", 2);
			await running;
			expect(materialize).toHaveBeenCalledOnce();
		} finally {
			materialize.mockRestore();
		}
	});

	it("accumulates many multibyte streaming deltas exactly", async () => {
		const proc = new FakeTaskProcess();
		const updates: TaskUpdate[] = [];
		const running = registeredTask(proc).execute(undefined, (update) => updates.push(update));

		for (let index = 0; index < 1000; index += 1) {
			proc.stdout.emit("data", `${JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "🧘" } })}\n`);
		}
		expect(updates.at(-1)?.details.results[0]?.streamingText).toBe("🧘".repeat(1000));

		proc.emit("close", 0);
		await running;
	});

	it("marks single-task setup failures as tool errors", async () => {
		let definition: { execute: (...args: unknown[]) => Promise<TaskToolResult> } | undefined;
		// SAFETY: the registerTool double forwards the definition to the local slot;
		// the tool emits the same shape the execute call sites below expect.
		const pi = {
			registerTool: vi.fn((toolDefinition) => {
				// SAFETY: the registerTool double forwards the definition to the local slot.
				definition = toolDefinition as typeof definition;
			}),
			on: vi.fn(),
			getThinkingLevel: vi.fn(() => "low"),
			getActiveTools: vi.fn(() => ["read"]),
		};

		// SAFETY: the on/registerTool/getThinkingLevel/getActiveTools doubles supply the
		// surfaces taskTool reads; no subprocess runs in this test.
		taskTool()(pi as never);

		const result = await definition?.execute(
			"tc-task",
			{ type: "single", tasks: [{ prompt: "## Needs fork", fork: true }] },
			undefined,
			undefined,
			// SAFETY: the ctx double supplies the cwd/model/sessionManager surface the tool reads.
			{
				cwd: process.cwd(),
				model: undefined,
				sessionManager: { getSessionFile: () => undefined },
			} as never,
		);

		expect(result?.isError).toBe(true);
		expect(result?.content[0]?.text).toContain("Forked tasks require a persisted session file");
		expect(result).toMatchObject({ details: { mode: "single", results: [], startedAt: expect.any(Number), updatedAt: expect.any(Number) } });
	});
});
