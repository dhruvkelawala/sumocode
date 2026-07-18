import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createPiChildSpawner, resolveClaudeOauthAdapterEntry } from "./backend-pi.js";
import type { SubagentEvent } from "./domain.js";

class FakeProcess extends EventEmitter {
	public readonly stdin = { end: vi.fn() };
	public readonly stdout = new EventEmitter();
	public readonly stderr = new EventEmitter();
	public pid = 4242;
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

describe("resolveClaudeOauthAdapterEntry", () => {
	it("returns undefined when the package is not installed", () => {
		expect(resolveClaudeOauthAdapterEntry({ PI_CODING_AGENT_DIR: "/nonexistent-agent-dir" })).toBeUndefined();
	});
});

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
		const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
		controller.abort();
		killSpy.mockRestore();
		proc.emit("close", null);
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

	it("injects the claude-oauth adapter via -e when the resolver finds it", () => {
		const proc = new FakeProcess();
		const spawn = vi.fn(() => proc);
		const child = createPiChildSpawner(spawn as never, () => "/fake/adapter/extensions/index.ts")({ prompt: "x", cwd: "/tmp", inherited: {} });
		collect(child.events as (emit: (event: SubagentEvent) => void) => void);
		const args = (spawn.mock.calls[0] as unknown[])[1] as string[];
		const eIndex = args.indexOf("-e");
		expect(eIndex).toBeGreaterThan(-1);
		expect(args[eIndex + 1]).toBe("/fake/adapter/extensions/index.ts");
		// The prompt must remain the trailing positional after the adapter args.
		expect(args[args.length - 1]).toBe("x");
	});

	it("omits the -e flag when no adapter is installed", () => {
		const proc = new FakeProcess();
		const spawn = vi.fn(() => proc);
		const child = createPiChildSpawner(spawn as never, () => undefined)({ prompt: "x", cwd: "/tmp", inherited: {} });
		collect(child.events as (emit: (event: SubagentEvent) => void) => void);
		const args = (spawn.mock.calls[0] as unknown[])[1] as string[];
		expect(args).not.toContain("-e");
	});

	it("spawns the child detached and signals the whole process group on interrupt", () => {
		const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
		try {
			const proc = new FakeProcess();
			const spawn = vi.fn(() => proc);
			const controller = new AbortController();
			const child = createPiChildSpawner(spawn as never)({ prompt: "x", cwd: "/tmp", inherited: {}, signal: controller.signal });
			collect(child.events as (emit: (event: SubagentEvent) => void) => void);
			expect(spawn).toHaveBeenCalledWith("pi", expect.any(Array), expect.objectContaining({ detached: true }));
			controller.abort();
			// Group signal: negative pid targets the whole tree, not just pi.
			expect(killSpy).toHaveBeenCalledWith(-4242, "SIGTERM");
			expect(proc.kill).not.toHaveBeenCalled();
		} finally {
			killSpy.mockRestore();
		}
	});

	it("falls back to single-pid kill when the group signal fails", () => {
		const killSpy = vi.spyOn(process, "kill").mockImplementation(() => { throw new Error("ESRCH"); });
		try {
			const proc = new FakeProcess();
			const controller = new AbortController();
			const child = createPiChildSpawner(vi.fn(() => proc) as never)({ prompt: "x", cwd: "/tmp", inherited: {}, signal: controller.signal });
			collect(child.events as (emit: (event: SubagentEvent) => void) => void);
			controller.abort();
			expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
		} finally {
			killSpy.mockRestore();
		}
	});

	it("escalates to SIGKILL when the child ignores SIGTERM (no close event)", () => {
		vi.useFakeTimers();
		try {
			const proc = new FakeProcess();
			const controller = new AbortController();
			const child = createPiChildSpawner(vi.fn(() => proc) as never)({ prompt: "x", cwd: "/tmp", inherited: {}, signal: controller.signal });
			collect(child.events as (emit: (event: SubagentEvent) => void) => void);
			const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
			try {
				controller.abort();
				expect(killSpy).toHaveBeenCalledWith(-4242, "SIGTERM");
				// The signal was SENT but the process never exited — the fallback
				// must still fire because it tracks close, not killed.
				vi.advanceTimersByTime(5001);
				expect(killSpy).toHaveBeenCalledWith(-4242, "SIGKILL");
			} finally {
				killSpy.mockRestore();
			}
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not SIGKILL a child that exited after SIGTERM", () => {
		vi.useFakeTimers();
		try {
			const proc = new FakeProcess();
			const controller = new AbortController();
			const child = createPiChildSpawner(vi.fn(() => proc) as never)({ prompt: "x", cwd: "/tmp", inherited: {}, signal: controller.signal });
			collect(child.events as (emit: (event: SubagentEvent) => void) => void);
			const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
			try {
				controller.abort();
				proc.emit("close", null);
				vi.advanceTimersByTime(5001);
				const kills = killSpy.mock.calls.filter(([pid]) => pid === -4242);
				expect(kills).toEqual([[-4242, "SIGTERM"]]);
			} finally {
				killSpy.mockRestore();
			}
		} finally {
			vi.useRealTimers();
		}
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

	it("treats an externally signalled child (null code) as failed, not completed", () => {
		const proc = new FakeProcess();
		const child = createPiChildSpawner(vi.fn(() => proc) as never)({ prompt: "x", cwd: "/tmp", inherited: {} });
		const events = collect(child.events as (emit: (event: SubagentEvent) => void) => void);
		// External SIGTERM (operator kill / host cleanup): Node reports
		// code=null with the signal — must never fold as completed.
		proc.emit("close", null, "SIGTERM");
		expect(events.at(-1)).toEqual({ kind: "run-settled", outcome: { kind: "failed", errorText: "pi killed by SIGTERM", partialText: undefined } });
	});

	it("treats exit 0 with empty final text as completed, matching native-task semantics", () => {
		const proc = new FakeProcess();
		const child = createPiChildSpawner(vi.fn(() => proc) as never)({ prompt: "x", cwd: "/tmp", inherited: {} });
		const events = collect(child.events as (emit: (event: SubagentEvent) => void) => void);
		proc.emit("close", 0);
		expect(events.at(-1)).toEqual({ kind: "run-settled", outcome: { kind: "completed", finalText: "" } });
	});
});
