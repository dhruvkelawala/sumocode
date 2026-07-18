import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createPiChildSpawner } from "./backend-pi.js";
import type { SubagentEvent } from "./domain.js";

class FakeProcess extends EventEmitter {
	public readonly stdin = { end: vi.fn() };
	public readonly stdout = new EventEmitter();
	public readonly stderr = new EventEmitter();
	public killed = false;
	public kill = vi.fn(() => {
		this.killed = true;
		return true;
	});
}

const collect = (events: ((emit: (event: SubagentEvent) => void) => void)): SubagentEvent[] => {
	const collected: SubagentEvent[] = [];
	events((event) => collected.push(event));
	return collected;
};

describe("spawnPiChild", () => {
	it("translates pi json-line events", () => {
		const proc = new FakeProcess();
		const spawn = vi.fn(() => proc);
		const child = createPiChildSpawner(spawn as never)({
			prompt: "do work",
			cwd: "/tmp/project",
			inherited: { thinking: "low" },
		});
		const events = collect(child.events as (emit: (event: SubagentEvent) => void) => void);

		proc.stdout.emit("data", `${JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hel" } })}\n`);
		proc.stdout.emit("data", `${JSON.stringify({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "echo hi" } })}\n`);
		proc.stdout.emit("data", `${JSON.stringify({ type: "tool_execution_update", toolCallId: "t1", partialResult: { content: [{ type: "text", text: "hi" }] } })}\n`);
		proc.stdout.emit("data", `${JSON.stringify({ type: "tool_execution_end", toolCallId: "t1", toolName: "bash", isError: false, result: "done" })}\n`);
		proc.stdout.emit("data", `${JSON.stringify({ type: "message_end", message: { role: "assistant", content: "hello", usage: { totalTokens: 12, cost: { total: 0.01 } } } })}\n`);
		proc.emit("close", 0);

		expect(spawn).toHaveBeenCalledWith("pi", expect.arrayContaining(["--mode", "json", "-p", "do work"]), expect.objectContaining({ cwd: "/tmp/project" }));
		expect(events).toEqual([
			{ kind: "run-started" },
			{ kind: "assistant-delta", delta: "hel" },
			expect.objectContaining({ kind: "tool-start", toolId: "t1", name: "bash" }),
			{ kind: "tool-update", toolId: "t1", outputPreview: "hi" },
			{ kind: "tool-end", toolId: "t1", name: "bash", isError: false, outputPreview: "done" },
			{ kind: "message-end", role: "assistant", text: "hello" },
			{ kind: "usage", tokens: 12, contextWindow: undefined, costUsd: 0.01 },
			{ kind: "run-settled", outcome: { kind: "completed", finalText: "hello" } },
		]);
	});

	it("reports abort as interrupted", () => {
		const proc = new FakeProcess();
		const controller = new AbortController();
		const child = createPiChildSpawner(vi.fn(() => proc) as never)({ prompt: "x", cwd: "/tmp", inherited: {}, signal: controller.signal });
		const events = collect(child.events as (emit: (event: SubagentEvent) => void) => void);
		controller.abort();
		proc.emit("close", null);
		expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
		expect(events.at(-1)).toEqual({ kind: "run-settled", outcome: { kind: "interrupted", partialText: undefined } });
	});

	it("reports nonzero exit with stderr", () => {
		const proc = new FakeProcess();
		const child = createPiChildSpawner(vi.fn(() => proc) as never)({ prompt: "x", cwd: "/tmp", inherited: {} });
		const events = collect(child.events as (emit: (event: SubagentEvent) => void) => void);
		proc.stderr.emit("data", "boom");
		proc.emit("close", 2);
		expect(events.at(-1)).toEqual({ kind: "run-settled", outcome: { kind: "failed", errorText: "boom", partialText: undefined } });
	});

	it("settles as failed without spawning when the model override is invalid", () => {
		const spawn = vi.fn();
		const child = createPiChildSpawner(spawn as never)({ prompt: "x", cwd: "/tmp", model: "gpt5-no-slash", inherited: {} });
		const events = collect(child.events as (emit: (event: SubagentEvent) => void) => void);
		expect(spawn).not.toHaveBeenCalled();
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ kind: "run-settled", outcome: { kind: "failed" } });
		expect(() => child.interrupt()).not.toThrow();
	});

	it("treats exit 0 with empty final text as completed, matching native-task semantics", () => {
		const proc = new FakeProcess();
		const child = createPiChildSpawner(vi.fn(() => proc) as never)({ prompt: "x", cwd: "/tmp", inherited: {} });
		const events = collect(child.events as (emit: (event: SubagentEvent) => void) => void);
		proc.emit("close", 0);
		expect(events.at(-1)).toEqual({ kind: "run-settled", outcome: { kind: "completed", finalText: "" } });
	});
});
