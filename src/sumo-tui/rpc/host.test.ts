import { describe, expect, it, vi } from "vitest";
import { createRpcHostInterruptHandler, createUnhandledRejectionHandler, type RpcHostInterruptDependencies } from "./host.js";

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
});
