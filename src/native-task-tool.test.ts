import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { taskTool } from "./native-task-tool.js";

interface TaskUpdate {
	content?: Array<{ type: string; text: string }>;
	details: { results: Array<{ exitCode: number }> };
}

interface TaskToolResult {
	isError?: boolean;
	content: Array<{ type: string; text: string }>;
	details?: { mode?: string; results?: unknown[] };
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
