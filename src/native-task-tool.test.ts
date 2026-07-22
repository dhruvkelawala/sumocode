import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { taskTool } from "./native-task-tool.js";

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return { ...actual, spawn: vi.fn(actual.spawn) };
});

class FakeTaskProcess extends EventEmitter {
	public readonly stdin = { end: vi.fn() };
	public readonly stdout = new EventEmitter();
	public readonly stderr = new EventEmitter();
	public killed = false;
	public kill = vi.fn(() => {
		this.killed = true;
		return true;
	});
}

function resultExitCodes(update: unknown): number[] {
	return ((update as { details: { results: Array<{ exitCode: number }> } }).details.results).map((result) => result.exitCode);
}

describe("native task tool", () => {
	it("reports unscheduled parallel workers queued until their existing slot starts", async () => {
		let definition: { execute: (...args: unknown[]) => Promise<unknown> } | undefined;
		const pi = {
			registerTool: vi.fn((toolDefinition) => { definition = toolDefinition as typeof definition; }),
			on: vi.fn(),
			getThinkingLevel: vi.fn(() => "low"),
			getActiveTools: vi.fn(() => ["read"]),
		};
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
		const processes: FakeTaskProcess[] = [];
		vi.mocked(spawn).mockImplementation(() => {
			const proc = new FakeTaskProcess();
			processes.push(proc);
			return proc as never;
		});
		const updates: unknown[] = [];

		const execution = definition!.execute(
			"parallel-call",
			{
				type: "parallel",
				tasks: Array.from({ length: 4 }, (_, index) => ({ prompt: `Task ${index + 1}`, fork: false })),
			},
			undefined,
			(update: unknown) => updates.push(update),
			{
				cwd: process.cwd(),
				model: undefined,
				sessionManager: { getSessionFile: () => undefined },
			} as never,
		);

		expect(resultExitCodes(updates[0])).toEqual([-2, -2, -2, -2]);
		expect(processes).toHaveLength(2);
		expect(resultExitCodes(updates.at(-1))).toEqual([-1, -1, -2, -2]);

		processes[0]!.emit("close", 0);
		await vi.waitFor(() => expect(processes).toHaveLength(3));
		expect(resultExitCodes(updates.at(-1))).toEqual([0, -1, -1, -2]);

		processes[1]!.emit("close", 0);
		await vi.waitFor(() => expect(processes).toHaveLength(4));
		expect(resultExitCodes(updates.at(-1))).toEqual([0, 0, -1, -1]);
		processes[2]!.emit("close", 0);
		processes[3]!.emit("close", 0);
		await execution;
	});

	it.each(["single", "chain", "parallel"] as const)("marks %s preparation failures as tool errors", async (mode) => {
		let definition: { execute: (...args: unknown[]) => Promise<{ isError?: boolean; content: Array<{ type: string; text: string }>; details?: { mode?: string; results?: unknown[] } }> } | undefined;
		const pi = {
			registerTool: vi.fn((toolDefinition) => { definition = toolDefinition as typeof definition; }),
			on: vi.fn(),
			getThinkingLevel: vi.fn(() => "low"),
			getActiveTools: vi.fn(() => ["read"]),
		};
		taskTool()(pi as never);

		const result = await definition!.execute(
			`prepare-${mode}`,
			{ type: mode, tasks: [{ prompt: "Do work", skill: "__missing_plan_082_skill__", fork: false }] },
			undefined,
			undefined,
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

	it("marks single-task setup failures as tool errors", async () => {
		let definition: { execute: (...args: unknown[]) => Promise<{ isError?: boolean; content: Array<{ type: string; text: string }> }> } | undefined;
		const pi = {
			registerTool: vi.fn((toolDefinition) => {
				definition = toolDefinition as typeof definition;
			}),
			on: vi.fn(),
			getThinkingLevel: vi.fn(() => "low"),
			getActiveTools: vi.fn(() => ["read"]),
		};

		taskTool()(pi as never);

		const result = await definition?.execute(
			"tc-task",
			{ type: "single", tasks: [{ prompt: "## Needs fork", fork: true }] },
			undefined,
			undefined,
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
