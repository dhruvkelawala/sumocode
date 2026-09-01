import { EventEmitter } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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

interface TaskUpdate {
	content?: Array<{ type: string; text: string }>;
	details: { results: Array<{ exitCode: number; stderr?: string; streamingText?: string }> };
}

interface TaskToolResult {
	isError?: boolean;
	content: Array<{ type: string; text: string }>;
	details?: { mode?: string; results?: Array<{ stderr?: string }> };
}

class FakeTaskProcess extends EventEmitter {
	public readonly stdin = { end: vi.fn() };
	public readonly stdout = new EventEmitter();
	public readonly stderr = new EventEmitter();
	public killed = false;
	public readonly kill = vi.fn(() => {
		this.killed = true;
		return true;
	});
}

function registeredTask(spawned: FakeTaskProcess) {
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
	// SAFETY: the Pi double exposes every taskTool registration/runtime method used here.
	taskTool(undefined, vi.fn(() => spawned) as never)(pi as never);
	const execute = (signal?: AbortSignal, onUpdate?: (update: TaskUpdate) => void) => definition!.execute(
		"bounded-task",
		{ type: "single", tasks: [{ prompt: "bounded child", fork: false }] },
		signal,
		onUpdate,
		// SAFETY: the context double supplies the task execution surface.
		{ cwd: process.cwd(), model: undefined, sessionManager: { getSessionFile: () => undefined } } as never,
	);
	return { execute };
}

function resultExitCodes(update: TaskUpdate): number[] {
	return update.details.results.map((result) => result.exitCode);
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

	it("fails an oversized JSON frame once without exposing child content", async () => {
		const proc = new FakeTaskProcess();
		const running = registeredTask(proc).execute();
		proc.stdout.emit("data", Buffer.concat([
			Buffer.alloc(CHILD_JSON_FRAME_MAX_BYTES + 1, 0x71),
			Buffer.from("\n"),
		]));
		proc.emit("error", new Error("late child error"));
		proc.emit("close", 1);

		const result = await running;
		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toContain(`exceeded ${CHILD_JSON_FRAME_MAX_BYTES} bytes`);
		expect(result.content[0]?.text).not.toContain("qqqq");
		expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
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

	it("materializes stderr only when publishing an update or finishing", async () => {
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

			proc.emit("close", 2);
			await running;
			expect(materialize).toHaveBeenCalledTimes(2);
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
