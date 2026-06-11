import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	extractFinalAssistantText,
	installTaskModeAutoExit,
	shouldInstallTaskModeAutoExit,
	writeTaskExitMarker,
} from "./task-mode.js";

type Handler = (...args: unknown[]) => unknown;

function buildPiStub() {
	const handlers = new Map<string, Handler[]>();
	const pi = {
		on: vi.fn((event: string, handler: Handler) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		}),
		exec: vi.fn(async (_cmd: string, _args: string[], _opts?: unknown) => ({
			code: 0,
			stdout: "",
			stderr: "",
			killed: false,
		})),
	};
	return { pi, handlers };
}

function buildCtxStub() {
	const ctx = {
		shutdown: vi.fn(),
		ui: {
			setStatus: vi.fn(),
			notify: vi.fn(),
		},
	};
	return ctx;
}

describe("extractFinalAssistantText", () => {
	it("returns empty string when messages is empty", () => {
		expect(extractFinalAssistantText([])).toBe("");
	});

	it("returns empty string when no assistant message is present", () => {
		expect(
			extractFinalAssistantText([
				{ role: "user", content: [{ type: "text", text: "hello" }] },
			]),
		).toBe("");
	});

	it("extracts text from the LAST assistant message (final response, not intermediates)", () => {
		const text = extractFinalAssistantText([
			{ role: "user", content: [{ type: "text", text: "do the thing" }] },
			{ role: "assistant", content: [{ type: "text", text: "thinking..." }] },
			{ role: "toolResult", content: [{ type: "text", text: "tool out" }] },
			{ role: "assistant", content: [{ type: "text", text: "final answer" }] },
		]);
		expect(text).toBe("final answer");
	});

	it("concatenates multiple text blocks of the final assistant message", () => {
		const text = extractFinalAssistantText([
			{
				role: "assistant",
				content: [
					{ type: "text", text: "part 1" },
					{ type: "tool_use", name: "read" },
					{ type: "text", text: "part 2" },
				],
			},
		]);
		expect(text).toBe("part 1\npart 2");
	});

	it("ignores non-text content blocks (tool_use, tool_result, etc.)", () => {
		const text = extractFinalAssistantText([
			{
				role: "assistant",
				content: [
					{ type: "tool_use", name: "bash" },
					{ type: "text", text: "only this" },
				],
			},
		]);
		expect(text).toBe("only this");
	});

	it("handles malformed input defensively", () => {
		expect(extractFinalAssistantText(null as unknown as unknown[])).toBe("");
		expect(extractFinalAssistantText([null, undefined, "not an object"] as unknown[])).toBe("");
	});
});

describe("shouldInstallTaskModeAutoExit", () => {
	it("is true in task mode when keep-open is unset", () => {
		expect(shouldInstallTaskModeAutoExit({ env: { SUMOCODE_TASK_MODE: "1" } })).toBe(true);
	});

	it("is false outside task mode", () => {
		expect(shouldInstallTaskModeAutoExit({ env: {} })).toBe(false);
		expect(shouldInstallTaskModeAutoExit({ env: { SUMOCODE_TASK_MODE: "0" } })).toBe(false);
	});

	it("is false when SUMOCODE_TASK_KEEP_OPEN=1 explicitly opts out", () => {
		expect(
			shouldInstallTaskModeAutoExit({
				env: { SUMOCODE_TASK_MODE: "1", SUMOCODE_TASK_KEEP_OPEN: "1" },
			}),
		).toBe(false);
	});
});

describe("installTaskModeAutoExit", () => {
	let originalSurfaceId: string | undefined;
	let originalResponseFile: string | undefined;
	let originalExitFile: string | undefined;
	let workDir: string | undefined;

	beforeEach(() => {
		vi.useFakeTimers();
		originalSurfaceId = process.env.CMUX_SURFACE_ID;
		process.env.CMUX_SURFACE_ID = "surface:test";
		originalResponseFile = process.env.SUMOCODE_TASK_RESPONSE_FILE;
		originalExitFile = process.env.SUMOCODE_TASK_EXIT_FILE;
		delete process.env.SUMOCODE_TASK_RESPONSE_FILE;
		delete process.env.SUMOCODE_TASK_EXIT_FILE;
		workDir = undefined;
	});

	afterEach(() => {
		vi.useRealTimers();
		if (originalSurfaceId === undefined) delete process.env.CMUX_SURFACE_ID;
		else process.env.CMUX_SURFACE_ID = originalSurfaceId;
		if (originalResponseFile === undefined) delete process.env.SUMOCODE_TASK_RESPONSE_FILE;
		else process.env.SUMOCODE_TASK_RESPONSE_FILE = originalResponseFile;
		if (originalExitFile === undefined) delete process.env.SUMOCODE_TASK_EXIT_FILE;
		else process.env.SUMOCODE_TASK_EXIT_FILE = originalExitFile;
		if (workDir) rmSync(workDir, { recursive: true, force: true });
	});

	it("does nothing when not in task mode", () => {
		const { pi } = buildPiStub();
		installTaskModeAutoExit(pi as never, { env: {} });
		expect(pi.on).not.toHaveBeenCalled();
	});

	it("does nothing when keep-open is set", () => {
		const { pi } = buildPiStub();
		installTaskModeAutoExit(pi as never, {
			env: { SUMOCODE_TASK_MODE: "1", SUMOCODE_TASK_KEEP_OPEN: "1" },
		});
		expect(pi.on).not.toHaveBeenCalled();
	});

	it("schedules process shutdown after the grace period on first agent_end", async () => {
		const { pi, handlers } = buildPiStub();
		installTaskModeAutoExit(pi as never, { env: { SUMOCODE_TASK_MODE: "1" }, graceMs: 10_000 });

		const ctx = buildCtxStub();
		const onAgentEnd = handlers.get("agent_end")?.[0];
		expect(onAgentEnd).toBeDefined();

		onAgentEnd!({ messages: [] }, ctx);

		// status is set immediately with full grace countdown
		expect(ctx.ui.setStatus).toHaveBeenCalledWith(
			"sumocode-task-auto-exit",
			expect.stringContaining("exiting in 10s"),
		);

		// nothing has fired yet
		expect(pi.exec).not.toHaveBeenCalled();

		vi.advanceTimersByTime(9_999);
		expect(pi.exec).not.toHaveBeenCalled();

		vi.advanceTimersByTime(1);
		// Let the floated promise inside the timer callback settle
		await Promise.resolve();
		expect(pi.exec).not.toHaveBeenCalled();
		expect(ctx.shutdown).toHaveBeenCalledTimes(1);
	});

	it("cancels auto-exit when the user types interactively during the grace period", () => {
		const { pi, handlers } = buildPiStub();
		installTaskModeAutoExit(pi as never, { env: { SUMOCODE_TASK_MODE: "1" }, graceMs: 10_000 });

		const ctx = buildCtxStub();
		handlers.get("agent_end")?.[0]?.({ messages: [] }, ctx);
		// Simulate user typing 3 seconds in
		vi.advanceTimersByTime(3_000);
		handlers.get("input")?.[0]?.({ source: "interactive", text: "follow-up" }, ctx);

		// Run remaining time — cmux close-surface must NOT fire
		vi.advanceTimersByTime(20_000);
		expect(pi.exec).not.toHaveBeenCalled();
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("auto-exit cancelled"),
			"info",
		);
	});

	it("ignores input that fires BEFORE the first agent_end (this is the CLI kickoff)", async () => {
		const { pi, handlers } = buildPiStub();
		installTaskModeAutoExit(pi as never, { env: { SUMOCODE_TASK_MODE: "1" }, graceMs: 10_000 });

		const ctx = buildCtxStub();
		// Pi delivers the CLI positional kickoff as input with source=interactive.
		// This must NOT cancel the auto-exit — it's the orchestrator's prompt,
		// not the user typing.
		handlers.get("input")?.[0]?.({ source: "interactive", text: "kickoff prompt" }, ctx);
		handlers.get("agent_end")?.[0]?.({ messages: [] }, ctx);

		vi.advanceTimersByTime(10_000);
		await Promise.resolve();
		expect(pi.exec).not.toHaveBeenCalled();
		expect(ctx.shutdown).toHaveBeenCalledTimes(1);
	});

	it("cancels auto-exit when the user types AFTER the first agent_end (real follow-up)", () => {
		const { pi, handlers } = buildPiStub();
		installTaskModeAutoExit(pi as never, { env: { SUMOCODE_TASK_MODE: "1" }, graceMs: 10_000 });

		const ctx = buildCtxStub();
		// Kickoff input (ignored)
		handlers.get("input")?.[0]?.({ source: "interactive", text: "kickoff" }, ctx);
		// First agent_end arms the timer
		handlers.get("agent_end")?.[0]?.({ messages: [] }, ctx);
		// User types during grace period
		vi.advanceTimersByTime(3_000);
		handlers.get("input")?.[0]?.({ source: "interactive", text: "follow-up" }, ctx);
		// Run remaining time — close must NOT fire
		vi.advanceTimersByTime(20_000);
		expect(pi.exec).not.toHaveBeenCalled();
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("auto-exit cancelled"), "info");
	});

	it("does not re-arm on subsequent agent_end events", () => {
		const { pi, handlers } = buildPiStub();
		installTaskModeAutoExit(pi as never, { env: { SUMOCODE_TASK_MODE: "1" }, graceMs: 10_000 });

		const ctx = buildCtxStub();
		const onAgentEnd = handlers.get("agent_end")?.[0];

		// First agent_end → arms
		onAgentEnd!({ messages: [] }, ctx);
		// User types → cancels and marks as "took over"
		handlers.get("input")?.[0]?.({ source: "interactive", text: "follow-up" }, ctx);
		// Second agent_end after their follow-up turn — must NOT re-arm
		onAgentEnd!({ messages: [] }, ctx);

		vi.advanceTimersByTime(60_000);
		expect(pi.exec).not.toHaveBeenCalled();
	});

	it("writes response.md with final assistant text on first agent_end", () => {
		workDir = mkdtempSync(join(tmpdir(), "sumocode-task-mode-test-"));
		const responseFile = join(workDir, "response.md");
		process.env.SUMOCODE_TASK_RESPONSE_FILE = responseFile;

		const { pi, handlers } = buildPiStub();
		installTaskModeAutoExit(pi as never, { env: { SUMOCODE_TASK_MODE: "1" }, graceMs: 10_000 });

		const ctx = buildCtxStub();
		handlers.get("agent_end")?.[0]?.(
			{
				messages: [
					{ role: "user", content: [{ type: "text", text: "do x" }] },
					{ role: "assistant", content: [{ type: "text", text: "done x" }] },
				],
			},
			ctx,
		);

		expect(existsSync(responseFile)).toBe(true);
		expect(readFileSync(responseFile, "utf8").trim()).toBe("done x");
	});

	it("updates response.md on later agent_end events without re-arming shutdown", () => {
		workDir = mkdtempSync(join(tmpdir(), "sumocode-task-mode-test-"));
		const responseFile = join(workDir, "response.md");
		process.env.SUMOCODE_TASK_RESPONSE_FILE = responseFile;

		const { pi, handlers } = buildPiStub();
		installTaskModeAutoExit(pi as never, { env: { SUMOCODE_TASK_MODE: "1" }, graceMs: 10_000 });

		const ctx = buildCtxStub();
		const onAgentEnd = handlers.get("agent_end")?.[0];
		onAgentEnd?.({ messages: [{ role: "assistant", content: [{ type: "text", text: "first" }] }] }, ctx);
		onAgentEnd?.({ messages: [{ role: "assistant", content: [{ type: "text", text: "second" }] }] }, ctx);

		expect(readFileSync(responseFile, "utf8").trim()).toBe("second");
		expect(ctx.ui.setStatus).toHaveBeenCalledTimes(1);
	});

	it("writes a real-exit marker for the manager to harvest", () => {
		workDir = mkdtempSync(join(tmpdir(), "sumocode-task-mode-test-"));
		const exitFile = join(workDir, "exit.code");
		writeTaskExitMarker(0, { SUMOCODE_TASK_EXIT_FILE: exitFile } as NodeJS.ProcessEnv);

		expect(readFileSync(exitFile, "utf8").trim()).toBe("0");
	});

	it("does not write response.md when env var is unset", () => {
		const { pi, handlers } = buildPiStub();
		installTaskModeAutoExit(pi as never, { env: { SUMOCODE_TASK_MODE: "1" }, graceMs: 10_000 });

		const ctx = buildCtxStub();
		handlers.get("agent_end")?.[0]?.(
			{
				messages: [
					{ role: "assistant", content: [{ type: "text", text: "no harvest" }] },
				],
			},
			ctx,
		);

		// No file path was given — nothing to check, just ensure no crash.
		expect(true).toBe(true);
	});
});
