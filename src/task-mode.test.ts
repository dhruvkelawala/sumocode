import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installTaskModeAutoExit, shouldInstallTaskModeAutoExit } from "./task-mode.js";

type Handler = (...args: unknown[]) => unknown;

function buildPiStub() {
	const handlers = new Map<string, Handler[]>();
	const pi = {
		on: vi.fn((event: string, handler: Handler) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		}),
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
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
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

	it("schedules shutdown after the grace period on first agent_end", () => {
		const { pi, handlers } = buildPiStub();
		installTaskModeAutoExit(pi as never, { env: { SUMOCODE_TASK_MODE: "1" }, graceMs: 10_000 });

		const ctx = buildCtxStub();
		const onAgentEnd = handlers.get("agent_end")?.[0];
		expect(onAgentEnd).toBeDefined();

		onAgentEnd!({ messages: [] }, ctx);

		// status is set immediately with full grace countdown
		expect(ctx.ui.setStatus).toHaveBeenCalledWith(
			"sumocode-task-auto-exit",
			expect.stringContaining("auto-closing in 10s"),
		);

		// nothing has fired yet
		expect(ctx.shutdown).not.toHaveBeenCalled();

		vi.advanceTimersByTime(9_999);
		expect(ctx.shutdown).not.toHaveBeenCalled();

		vi.advanceTimersByTime(1);
		expect(ctx.shutdown).toHaveBeenCalledOnce();
	});

	it("cancels auto-exit when the user types interactively during the grace period", () => {
		const { pi, handlers } = buildPiStub();
		installTaskModeAutoExit(pi as never, { env: { SUMOCODE_TASK_MODE: "1" }, graceMs: 10_000 });

		const ctx = buildCtxStub();
		handlers.get("agent_end")?.[0]?.({ messages: [] }, ctx);
		// Simulate user typing 3 seconds in
		vi.advanceTimersByTime(3_000);
		handlers.get("input")?.[0]?.({ source: "interactive", text: "follow-up" }, ctx);

		// Run remaining time — shutdown must NOT fire
		vi.advanceTimersByTime(20_000);
		expect(ctx.shutdown).not.toHaveBeenCalled();
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("auto-exit cancelled"),
			"info",
		);
	});

	it("ignores non-interactive input (kickoff prompts, extension messages)", () => {
		const { pi, handlers } = buildPiStub();
		installTaskModeAutoExit(pi as never, { env: { SUMOCODE_TASK_MODE: "1" }, graceMs: 10_000 });

		const ctx = buildCtxStub();
		// Kickoff prompt arrives as "extension" source
		handlers.get("input")?.[0]?.({ source: "extension", text: "kickoff" }, ctx);
		handlers.get("agent_end")?.[0]?.({ messages: [] }, ctx);

		// Auto-exit should still proceed because user didn't actually type
		vi.advanceTimersByTime(10_000);
		expect(ctx.shutdown).toHaveBeenCalledOnce();
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
		expect(ctx.shutdown).not.toHaveBeenCalled();
	});
});
