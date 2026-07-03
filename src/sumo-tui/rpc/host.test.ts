import { describe, expect, it, vi } from "vitest";
import { createRpcExitHandler, createRpcHostInterruptHandler, createUnhandledRejectionHandler, type RpcHostExitDependencies, type RpcHostInterruptDependencies } from "./host.js";

function flush(): Promise<void> {
	return Promise.resolve().then(() => Promise.resolve());
}

function interruptDeps(overrides: Partial<RpcHostInterruptDependencies> = {}): RpcHostInterruptDependencies {
	return {
		modals: { getActiveKind: () => undefined, close: vi.fn() },
		overlays: { getActiveKind: () => undefined, close: vi.fn() },
		editor: { getText: () => "", setText: vi.fn(), isAutocompleteOpen: () => false },
		stateStore: { getSnapshot: () => ({ isStreaming: false }) as never },
		controls: { abort: vi.fn(async () => undefined) },
		notifications: { notify: vi.fn() },
		requestHostExit: vi.fn(),
		now: () => 1_000,
		...overrides,
	};
}

const CTRL_C = "";
const ESCAPE = "";

describe("createRpcHostInterruptHandler wiring", () => {
	it("passes Escape through to the editor when the autocomplete dropdown is open, even while streaming", () => {
		const requestHostExit = vi.fn();
		const handle = createRpcHostInterruptHandler(interruptDeps({
			stateStore: { getSnapshot: () => ({ isStreaming: true }) as never },
			editor: { getText: () => "", setText: vi.fn(), isAutocompleteOpen: () => true },
			requestHostExit,
		}));

		expect(handle(ESCAPE)).toBe(false);
		expect(requestHostExit).not.toHaveBeenCalled();
	});

	it("aborts (not passes) Escape while streaming once autocomplete is closed", () => {
		const controls = { abort: vi.fn(async () => undefined) };
		const handle = createRpcHostInterruptHandler(interruptDeps({
			stateStore: { getSnapshot: () => ({ isStreaming: true }) as never },
			editor: { getText: () => "", setText: vi.fn(), isAutocompleteOpen: () => false },
			controls,
		}));

		expect(handle(ESCAPE)).toBe(true);
		expect(controls.abort).toHaveBeenCalledOnce();
	});

	it("treats the submit-in-flight window as streaming: double Ctrl-C aborts instead of quitting", async () => {
		const controls = { abort: vi.fn(async () => undefined) };
		const requestHostExit = vi.fn();
		const handle = createRpcHostInterruptHandler(interruptDeps({
			stateStore: { getSnapshot: () => ({ isStreaming: false }) as never },
			controls,
			requestHostExit,
			submitInFlight: () => true,
		}));

		// A pair of Ctrl-C presses in the submit -> agent_start window must
		// abort the in-flight send, not arm-quit/quit like a pre-streaming
		// double Ctrl-C would.
		expect(handle(CTRL_C)).toBe(true);
		await flush();
		expect(controls.abort).toHaveBeenCalledOnce();
		expect(handle(CTRL_C)).toBe(true);
		await flush();
		expect(controls.abort).toHaveBeenCalledTimes(2);
		expect(requestHostExit).not.toHaveBeenCalled();
	});

	it("falls back to arm-quit/quit once submitInFlight clears (agent_start landed or send failed)", () => {
		let inFlight = true;
		const requestHostExit = vi.fn();
		const handle = createRpcHostInterruptHandler(interruptDeps({
			stateStore: { getSnapshot: () => ({ isStreaming: false }) as never },
			requestHostExit,
			submitInFlight: () => inFlight,
		}));

		inFlight = false;
		expect(handle(CTRL_C)).toBe(true); // arm-quit
		expect(handle(CTRL_C)).toBe(true); // quit (within the 1.5s window)
		expect(requestHostExit).toHaveBeenCalledWith(130);
	});
});

describe("RPC host unhandled rejection shutdown", () => {
	it("awaits cleanup before exiting and ignores duplicate rejection events", async () => {
		let finishCleanup: (() => void) | undefined;
		const writes: string[] = [];
		const cleanup = vi.fn(async () => {
			await new Promise<void>((resolve) => {
				finishCleanup = resolve;
			});
		});
		const exit = vi.fn();
		const handler = createUnhandledRejectionHandler({
			stderr: { write: (chunk: string) => { writes.push(chunk); return true; } },
			cleanup,
			exit,
		});

		handler(new Error("rpc prompt rejected"));
		handler(new Error("second rejection"));
		await flush();

		expect(cleanup).toHaveBeenCalledOnce();
		expect(cleanup).toHaveBeenCalledWith(1);
		expect(exit).not.toHaveBeenCalled();
		expect(writes.join("")).toContain("unhandled rejection: Error: rpc prompt rejected");

		finishCleanup?.();
		await flush();

		expect(exit).toHaveBeenCalledOnce();
		expect(exit).toHaveBeenCalledWith(1);
	});

	it("runs the same stop()-then-exit(1) path for a sync throw (uncaughtException) as for a rejection", async () => {
		// runRpcHost wires this exact handler instance to both process.on("unhandledRejection", ...)
		// and process.once("uncaughtException", ...) -- a sync throw from the event -> render path
		// must restore the terminal via the same stopHost() cleanup an unhandled rejection uses, not
		// fall through with no handler at all (the pre-fix state: only unhandledRejection was wired).
		const writes: string[] = [];
		const cleanup = vi.fn(async (_code: number) => undefined);
		const exit = vi.fn((_code: number) => undefined);
		const handler = createUnhandledRejectionHandler({
			stderr: { write: (chunk: string) => { writes.push(chunk); return true; } },
			cleanup,
			exit,
		});

		// Simulates process.once("uncaughtException", handler) firing with a
		// real Error (Node calls uncaughtException listeners with (error, origin)
		// but this handler only reads the first argument, same as for a rejection reason).
		handler(new Error("sync render throw"));
		await flush();

		expect(cleanup).toHaveBeenCalledOnce();
		expect(cleanup).toHaveBeenCalledWith(1);
		expect(exit).toHaveBeenCalledOnce();
		expect(exit).toHaveBeenCalledWith(1);
		expect(writes.join("")).toContain("unhandled rejection: Error: sync render throw");
	});
});

function exitDeps(overrides: Partial<RpcHostExitDependencies> = {}): RpcHostExitDependencies {
	return {
		modals: { close: vi.fn() },
		overlays: { close: vi.fn() },
		stateStore: { getSnapshot: () => ({ isStreaming: true, isCompacting: true }) as never },
		notifications: { notify: vi.fn() },
		requestRender: vi.fn(),
		stopHost: vi.fn(async () => undefined),
		exit: vi.fn(),
		updateRuntimeState: vi.fn(),
		shutdownDelayMs: 0,
		...overrides,
	};
}

describe("RPC host client-exit shutdown", () => {
	it("closes modals and overlays, clears streaming state, and notifies with a bounded message", () => {
		const modals = { close: vi.fn() };
		const overlays = { close: vi.fn() };
		const updateRuntimeState = vi.fn();
		const notifications = { notify: vi.fn() };
		const handle = createRpcExitHandler(exitDeps({ modals, overlays, updateRuntimeState, notifications }));

		const hugeStderr = "x".repeat(70_000);
		handle(new Error(`RPC child exited code=1 signal=null. stderr=${hugeStderr}`));

		expect(modals.close).toHaveBeenCalledOnce();
		expect(overlays.close).toHaveBeenCalledOnce();
		expect(updateRuntimeState).toHaveBeenCalledWith(expect.objectContaining({ isStreaming: false, isCompacting: false }));
		expect(notifications.notify).toHaveBeenCalledOnce();
		const [message] = notifications.notify.mock.calls[0] as [string, string, number];
		expect(message.length).toBeLessThan(600);
		expect(message).toContain("RPC child exited unexpectedly");
	});

	it("stops the runtime with a nonzero exit code after the shutdown delay", async () => {
		vi.useFakeTimers();
		try {
			const stopHost = vi.fn(async (_code: number) => undefined);
			const exit = vi.fn((_code: number) => undefined);
			const handle = createRpcExitHandler(exitDeps({ stopHost, exit, shutdownDelayMs: 750 }));

			handle(new Error("child crashed"));
			expect(stopHost).not.toHaveBeenCalled();

			await vi.advanceTimersByTimeAsync(750);

			expect(stopHost).toHaveBeenCalledOnce();
			expect(stopHost.mock.calls[0]?.[0]).toBeGreaterThan(0);
			expect(exit).toHaveBeenCalledOnce();
			expect(exit.mock.calls[0]?.[0]).toBeGreaterThan(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it("requests a render immediately so the notification is visible before shutdown", () => {
		const requestRender = vi.fn();
		const handle = createRpcExitHandler(exitDeps({ requestRender }));

		handle(new Error("child crashed"));

		expect(requestRender).toHaveBeenCalled();
	});
});
