import type { RpcCommand, RpcResponse, RpcSessionState } from "@earendil-works/pi-coding-agent";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ChatMessageViewModel } from "../transcript/view-model.js";
import { SUMOCODE_RELOAD_EXIT_CODE } from "../../commands/reload.js";
import { RpcChildExitError } from "./client.js";
import { RpcHostOverlayManager } from "./host-overlays.js";
import { RpcHostControls, type RpcAvailableModel } from "./controls.js";
import { RpcHostStateStore } from "./state.js";
import {
	createLazyChatSink,
	createModelCycleBackwardHandler,
	createModelCycleForwardHandler,
	createRpcExitHandler,
	createRpcHostInterruptHandler,
	createThinkingCycleHandler,
	handleRpcMessageFollowUp,
	handleRpcMessageDequeue,
	createToolsExpandToggleHandler,
	createUnhandledRejectionHandler,
	submitInitialPromptFromEnv,
	writeExitCodeFile,
	type RpcHostExitDependencies,
	type RpcHostInterruptDependencies,
} from "./host.js";
import { createRpcPromptScheduler } from "./prompt-scheduler.js";

function flush(): Promise<void> {
	return Promise.resolve().then(() => Promise.resolve());
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

class FakeRpcCommandClient {
	public readonly commands: RpcCommand[] = [];
	private readonly responses: RpcResponse[];

	public constructor(...responses: RpcResponse[]) {
		this.responses = [...responses];
	}

	public async send(command: RpcCommand): Promise<RpcResponse> {
		this.commands.push(command);
		const response = this.responses.shift();
		if (!response) throw new Error(`No fake response queued for ${command.type}`);
		return response;
	}
}

function rpcModel(provider: string, id: string): RpcAvailableModel {
	return {
		provider,
		id,
		name: `${provider} ${id}`,
	} as RpcAvailableModel;
}

function rpcState(overrides: Partial<RpcSessionState> = {}): RpcSessionState {
	return {
		model: rpcModel("p", "b"),
		thinkingLevel: "medium",
		isStreaming: false,
		isCompacting: false,
		steeringMode: "all",
		followUpMode: "one-at-a-time",
		sessionId: "session-1",
		sessionName: "Migration",
		autoCompactionEnabled: true,
		messageCount: 3,
		pendingMessageCount: 1,
		...overrides,
	};
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

describe("handleRpcMessageFollowUp", () => {
	function followUpEditor(text: string) {
		return {
			getText: vi.fn(() => text),
			addToHistory: vi.fn(),
			setText: vi.fn(),
			// Identity expansion by default; image tests override.
			expandDraftTokens: vi.fn((draft: string) => draft),
			clearImageDrafts: vi.fn(),
		};
	}

	it("adds history and clears the draft when the scheduler queues the follow-up", async () => {
		const editor = followUpEditor("queued draft");
		const scheduler = {
			getSnapshot: vi.fn(() => ({ busy: true, queuedMessages: [], pausedAfterFailure: false })),
			submit: vi.fn(async () => "queued" as const),
		};

		handleRpcMessageFollowUp({ editor, scheduler, notifications: { notify: vi.fn() } });
		await flush();

		expect(scheduler.submit).toHaveBeenCalledWith("queued draft", { forceQueue: true });
		expect(editor.addToHistory).toHaveBeenCalledWith("queued draft");
		expect(editor.setText).toHaveBeenCalledWith("");
	});

	it("adds history and clears the draft when the scheduler handled a host command", async () => {
		const editor = followUpEditor("/model anthropic/claude-opus-4");
		const scheduler = {
			getSnapshot: vi.fn(() => ({ busy: true, queuedMessages: [], pausedAfterFailure: false })),
			submit: vi.fn(async () => "handled" as const),
		};

		handleRpcMessageFollowUp({ editor, scheduler, notifications: { notify: vi.fn() } });
		await flush();

		expect(scheduler.submit).toHaveBeenCalledWith("/model anthropic/claude-opus-4", { forceQueue: true });
		expect(editor.addToHistory).toHaveBeenCalledWith("/model anthropic/claude-opus-4");
		expect(editor.setText).toHaveBeenCalledWith("");
	});

	it("retains the draft when the scheduler declines the forced follow-up", async () => {
		const editor = followUpEditor("still here");
		const scheduler = {
			getSnapshot: vi.fn(() => ({ busy: true, queuedMessages: [], pausedAfterFailure: false })),
			submit: vi.fn(async () => "ignored" as const),
		};

		handleRpcMessageFollowUp({ editor, scheduler, notifications: { notify: vi.fn() } });
		await flush();

		expect(scheduler.submit).toHaveBeenCalledWith("still here", { forceQueue: true });
		expect(editor.addToHistory).not.toHaveBeenCalled();
		expect(editor.setText).not.toHaveBeenCalled();
		// The image draft state must survive a declined queue — the untouched
		// draft (with its tokens) stays editable.
		expect(editor.clearImageDrafts).not.toHaveBeenCalled();
	});

	it("queues the expanded submission for image drafts and clears drafts only on accept", async () => {
		const editor = followUpEditor("look at [Image 1]");
		editor.expandDraftTokens.mockImplementation((draft: string) => draft.replace("[Image 1]", "/tmp/img-1.png"));
		const scheduler = {
			getSnapshot: vi.fn(() => ({ busy: true, queuedMessages: [], pausedAfterFailure: false })),
			submit: vi.fn(async () => "queued" as const),
		};

		handleRpcMessageFollowUp({ editor, scheduler, notifications: { notify: vi.fn() } });
		await flush();

		// The QUEUED text carries the real path; history keeps the human-readable token form.
		expect(scheduler.submit).toHaveBeenCalledWith("look at /tmp/img-1.png", { forceQueue: true });
		expect(editor.addToHistory).toHaveBeenCalledWith("look at [Image 1]");
		expect(editor.setText).toHaveBeenCalledWith("");
		expect(editor.clearImageDrafts).toHaveBeenCalledOnce();
	});
});

describe("handleRpcMessageDequeue", () => {
	it("restores only queued drafts while preserving an active dispatch", async () => {
		const gate = deferred();
		const sent: string[] = [];
		const scheduler = createRpcPromptScheduler({
			sendPrompt: async (message) => {
				sent.push(message);
				await gate.promise;
			},
		});
		let draft = "";
		const editor = {
			getText: vi.fn(() => draft),
			setText: vi.fn((text: string) => { draft = text; }),
		};
		const stateStore = new RpcHostStateStore();
		const notifications = { notify: vi.fn() };

		await expect(scheduler.submit("prompt A")).resolves.toBe("sent");
		await expect(scheduler.submit("prompt B")).resolves.toBe("queued");

		handleRpcMessageDequeue({ editor, scheduler, stateStore, notifications });

		expect(editor.setText).toHaveBeenCalledWith("prompt B");
		expect(scheduler.getSnapshot()).toMatchObject({ busy: true, queuedMessages: [] });

		draft = "prompt B edited";
		await expect(scheduler.submit(draft)).resolves.toBe("queued");
		expect(sent).toEqual(["prompt A"]);

		gate.resolve();
		await flush();
		expect(sent).toEqual(["prompt A"]);

		scheduler.handleAgentEvent({ type: "agent_settled" });
		await flush();
		expect(sent).toEqual(["prompt A", "prompt B edited"]);
	});
});

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

	it("restores host-owned queued drafts before aborting", () => {
		const controls = { abort: vi.fn(async () => undefined) };
		const restoreQueuedDrafts = vi.fn();
		const handle = createRpcHostInterruptHandler(interruptDeps({
			stateStore: { getSnapshot: () => ({ isStreaming: true }) as never },
			controls,
			restoreQueuedDrafts,
		}));

		expect(handle(CTRL_C)).toBe(true);
		expect(restoreQueuedDrafts).toHaveBeenCalledOnce();
		expect(restoreQueuedDrafts.mock.invocationCallOrder[0]).toBeLessThan(controls.abort.mock.invocationCallOrder[0]!);
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
		overlays: { drain: vi.fn() },
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

describe("app.interrupt action wiring reuses the interrupt tier module", () => {
	// runRpcHost wires the editor's manager-driven `app.interrupt` action
	// (fired by CathedralEditor/CustomEditor once pi's KeybindingsManager
	// confirms the user's app.interrupt binding -- default Escape, or a
	// keybindings.json remap -- was pressed, and autocomplete is closed) to
	// `handlePreEditorInput("\x1b")`: a canonical escape token replayed through
	// the SAME `createRpcHostInterruptHandler` instance Ctrl-C/raw-Escape use.
	// These tests pin that a canonical escape token alone (independent of
	// whatever raw bytes the user's actual remapped key produces) drives the
	// exact same tier decisions real Escape input already does.
	it("replaying a canonical escape token aborts an in-flight stream via the interrupt tier", async () => {
		const controls = { abort: vi.fn(async () => undefined) };
		const handle = createRpcHostInterruptHandler(interruptDeps({
			stateStore: { getSnapshot: () => ({ isStreaming: true }) as never },
			editor: { getText: () => "", setText: vi.fn(), isAutocompleteOpen: () => false },
			controls,
		}));

		const handleAppInterrupt = (): void => { handle("\x1b"); };
		handleAppInterrupt();
		await flush();

		expect(controls.abort).toHaveBeenCalledOnce();
	});

	it("replaying a canonical escape token is a no-op (pass) when not streaming", () => {
		const requestHostExit = vi.fn();
		const notifications = { notify: vi.fn() };
		const handle = createRpcHostInterruptHandler(interruptDeps({
			stateStore: { getSnapshot: () => ({ isStreaming: false }) as never },
			notifications,
			requestHostExit,
		}));

		const handleAppInterrupt = (): void => { handle("\x1b"); };
		handleAppInterrupt();

		expect(requestHostExit).not.toHaveBeenCalled();
		expect(notifications.notify).not.toHaveBeenCalled();
	});

	it("replaying a canonical escape token still dismisses an active modal via the interrupt tier", () => {
		const modals = { getActiveKind: () => "confirm" as const, close: vi.fn() };
		const handle = createRpcHostInterruptHandler(interruptDeps({ modals }));

		const handleAppInterrupt = (): void => { handle("\x1b"); };
		handleAppInterrupt();

		expect(modals.close).toHaveBeenCalledOnce();
	});
});

// Root cause of "keybindings are broken": these actions were declared in
// editor.ts's APP_KEYBINDING_DEFINITIONS (so KeybindingsManager.matches()
// recognizes their chords) but runRpcHost never registered a handler via
// editor.onAction(...), so CustomEditor's actionHandlers loop found nothing
// and pressing the chord was a silent no-op. These tests pin the BEFORE (a
// bare invocation of each factory's returned handler with no wiring at all
// would previously not exist as an export -- createModelCycleForwardHandler/
// createModelCycleBackwardHandler/createThinkingCycleHandler/
// createToolsExpandToggleHandler did not exist prior to this fix) vs AFTER
// (the handler now calls through to the real RpcHostControls/runtime
// methods) behavior for each of the 4 host-side actions wired via host.ts.
describe("createModelCycleForwardHandler (app.model.cycleForward)", () => {
	it("moves forward within the enabled model ring with wraparound instead of calling Pi's full-list cycle_model", async () => {
		const enabledModels = [
			{ provider: "anthropic", id: "claude-opus-4", label: "anthropic/claude-opus-4", active: false },
			{ provider: "google", id: "gemini-3", label: "google/gemini-3", active: false },
			{ provider: "openai", id: "gpt-5", label: "openai/gpt-5", active: true },
		];
		const controls = {
			cycleModel: vi.fn(async () => { throw new Error("cycle_model should not be used for scoped cycling"); }),
			getAvailableModels: vi.fn(async () => [
				{ provider: "disabled", id: "outside-scope", label: "disabled/outside-scope", active: false },
				...enabledModels,
			]),
			getEnabledModels: vi.fn(async () => enabledModels),
			setModel: vi.fn(async () => ({ modelLabel: "anthropic/claude-opus-4" }) as never),
		};
		const notifications = { notify: vi.fn() };
		const onStateChange = vi.fn();
		const handle = createModelCycleForwardHandler({
			controls: controls as never,
			notifications,
			onStateChange,
		});

		handle();
		await flush();

		expect(controls.getEnabledModels).toHaveBeenCalledOnce();
		expect(controls.getAvailableModels).not.toHaveBeenCalled();
		expect(controls.cycleModel).not.toHaveBeenCalled();
		expect(controls.setModel).toHaveBeenCalledOnce();
		expect(controls.setModel).toHaveBeenCalledWith("anthropic", "claude-opus-4");
		expect(onStateChange).toHaveBeenCalledWith({ modelLabel: "anthropic/claude-opus-4" });
		expect(notifications.notify).not.toHaveBeenCalled();
	});

	it("notifies a warning instead of throwing when enabled-model discovery fails", async () => {
		const notifications = { notify: vi.fn() };
		const handle = createModelCycleForwardHandler({
			controls: {
				cycleModel: vi.fn(),
				getAvailableModels: vi.fn(),
				getEnabledModels: vi.fn(async () => { throw new Error("boom"); }),
				setModel: vi.fn(),
			} as never,
			notifications,
		});

		handle();
		await flush();

		expect(notifications.notify).toHaveBeenCalledWith(expect.stringContaining("boom"), "warning");
	});
});

describe("createModelCycleBackwardHandler (app.model.cycleBackward -- the other exact reported-broken chord)", () => {
	it("moves backward within the enabled model ring in the opposite direction with wraparound", async () => {
		const enabledModels = [
			{ provider: "anthropic", id: "claude-opus-4", label: "anthropic/claude-opus-4", active: true },
			{ provider: "google", id: "gemini-3", label: "google/gemini-3", active: false },
			{ provider: "openai", id: "gpt-5", label: "openai/gpt-5", active: false },
		];
		const controls = {
			cycleModel: vi.fn(),
			getAvailableModels: vi.fn(async () => [
				...enabledModels,
				{ provider: "disabled", id: "outside-scope", label: "disabled/outside-scope", active: false },
			]),
			getEnabledModels: vi.fn(async () => enabledModels),
			setModel: vi.fn(async () => ({ modelLabel: "openai/gpt-5" }) as never),
		};
		const notifications = { notify: vi.fn() };
		const onStateChange = vi.fn();
		const handle = createModelCycleBackwardHandler({
			controls: controls as never,
			notifications,
			onStateChange,
		});

		handle();
		await flush();

		expect(controls.getEnabledModels).toHaveBeenCalledOnce();
		expect(controls.getAvailableModels).not.toHaveBeenCalled();
		expect(controls.cycleModel).not.toHaveBeenCalled();
		expect(controls.setModel).toHaveBeenCalledOnce();
		expect(controls.setModel).toHaveBeenCalledWith("openai", "gpt-5");
		expect(onStateChange).toHaveBeenCalledWith({ modelLabel: "openai/gpt-5" });
		expect(notifications.notify).not.toHaveBeenCalled();
	});

	it("stays a single setModel call regardless of scoped list size", async () => {
		const models = Array.from({ length: 531 }, (_, i) => ({
			provider: "p",
			id: `m${i}`,
			label: `p/m${i}`,
			active: i === 200,
		}));
		const controls = {
			cycleModel: vi.fn(),
			getAvailableModels: vi.fn(),
			getEnabledModels: vi.fn(async () => models),
			setModel: vi.fn(async () => ({ modelLabel: "p/m199" }) as never),
		};
		const notifications = { notify: vi.fn() };
		const handle = createModelCycleBackwardHandler({
			controls: controls as never,
			notifications,
		});

		handle();
		await flush();

		expect(controls.cycleModel).not.toHaveBeenCalled();
		expect(controls.setModel).toHaveBeenCalledTimes(1);
		expect(controls.setModel).toHaveBeenCalledWith("p", "m199");
	});

	it("is a no-op when there is only one enabled model", async () => {
		const controls = {
			cycleModel: vi.fn(),
			getAvailableModels: vi.fn(),
			getEnabledModels: vi.fn(async () => [{ provider: "p", id: "only", label: "p/only", active: true }]),
			setModel: vi.fn(),
		};
		const notifications = { notify: vi.fn() };
		const handle = createModelCycleBackwardHandler({
			controls: controls as never,
			notifications,
		});

		handle();
		await flush();

		expect(controls.cycleModel).not.toHaveBeenCalled();
		expect(controls.setModel).not.toHaveBeenCalled();
		expect(notifications.notify).not.toHaveBeenCalled();
	});

	it("warns instead of cycling when no enabled models are available at all", async () => {
		const controls = {
			cycleModel: vi.fn(),
			getAvailableModels: vi.fn(),
			getEnabledModels: vi.fn(async () => []),
			setModel: vi.fn(),
		};
		const notifications = { notify: vi.fn() };
		const handle = createModelCycleBackwardHandler({
			controls: controls as never,
			notifications,
		});

		handle();
		await flush();

		expect(controls.cycleModel).not.toHaveBeenCalled();
		expect(controls.setModel).not.toHaveBeenCalled();
		expect(notifications.notify).toHaveBeenCalledWith("no models available", "warning");
	});

	it("uses RpcHostControls' enabled-model cache across repeated backward-cycle handler invocations", async () => {
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		const dir = mkdtempSync(join(tmpdir(), "sumocode-host-enabled-models-"));
		writeFileSync(join(dir, "settings.json"), JSON.stringify({ enabledModels: ["p/c", "p/a", "p/b"] }));
		process.env.PI_CODING_AGENT_DIR = dir;
		try {
			const client = new FakeRpcCommandClient(
				{
					type: "response",
					command: "get_available_models",
					success: true,
					data: { models: [rpcModel("p", "disabled"), rpcModel("p", "a"), rpcModel("p", "b"), rpcModel("p", "c")] },
				},
				{ type: "response", command: "set_model", success: true, data: rpcModel("p", "a") },
				{ type: "response", command: "set_model", success: true, data: rpcModel("p", "c") },
			);
			const store = new RpcHostStateStore();
			store.hydrateFromRpcState(rpcState({ model: rpcModel("p", "b") }));
			const controls = new RpcHostControls(client, store);
			const notifications = { notify: vi.fn() };
			const handle = createModelCycleBackwardHandler({ controls, notifications });

			handle();
			await flush();
			handle();
			await flush();

			expect(client.commands).toEqual([
				{ type: "get_available_models" },
				{ type: "set_model", provider: "p", modelId: "a" },
				{ type: "set_model", provider: "p", modelId: "c" },
			]);
			expect(notifications.notify).not.toHaveBeenCalled();
		} finally {
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("createThinkingCycleHandler (app.thinking.cycle -- one of the two exact reported-broken chords)", () => {
	it("calls controls.cycleThinkingLevel() and updates state without a confirmation toast", async () => {
		const cycleThinkingLevel = vi.fn(async () => ({ thinkingLevel: "high" }) as never);
		const notifications = { notify: vi.fn() };
		const onStateChange = vi.fn();
		const handle = createThinkingCycleHandler({ controls: { cycleThinkingLevel }, notifications, onStateChange });

		handle();
		await flush();

		expect(cycleThinkingLevel).toHaveBeenCalledOnce();
		expect(onStateChange).toHaveBeenCalledOnce();
		expect(notifications.notify).not.toHaveBeenCalled();
	});
});

describe("createToolsExpandToggleHandler (app.tools.expand)", () => {
	it("delegates every toggle to the presentation-owned pager state", () => {
		const toggleActivityExpansion = vi.fn();
		const requestRender = vi.fn();
		const handle = createToolsExpandToggleHandler({ toggleActivityExpansion, requestRender });

		handle();
		handle();
		handle();
		expect(toggleActivityExpansion).toHaveBeenCalledTimes(3);
		expect(requestRender).toHaveBeenCalledTimes(3);
	});
});

describe("RPC host client-exit shutdown", () => {
	it("closes modals, drains overlays without promotion, clears streaming state, and notifies with a bounded message", async () => {
		const modals = { close: vi.fn() };
		const overlays = new RpcHostOverlayManager();
		const queuedCreate = vi.fn(() => ({ invalidate: () => undefined, render: () => ["queued"] }));
		const active = overlays.show<string | undefined>("active", () => ({ invalidate: () => undefined, render: () => ["active"] }));
		const queued = overlays.show<string | undefined>("queued", queuedCreate);
		const updateRuntimeState = vi.fn();
		const notifications = { notify: vi.fn() };
		const handle = createRpcExitHandler(exitDeps({ modals, overlays, updateRuntimeState, notifications }));

		const hugeStderr = "x".repeat(70_000);
		handle(new Error(`RPC child exited code=1 signal=null. stderr=${hugeStderr}`));

		expect(modals.close).toHaveBeenCalledOnce();
		await expect(active).resolves.toBeUndefined();
		await expect(queued).resolves.toBeUndefined();
		expect(queuedCreate).not.toHaveBeenCalled();
		expect(overlays.getActiveKind()).toBeUndefined();
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

	// /sumo:reload (src/commands/reload.ts) process.exit(100)s the RPC child
	// deliberately. bin/sumocode.sh's respawn loop only relaunches when the
	// HOST process itself exits 100, so the host must propagate that exact
	// code -- and must not show the "exited unexpectedly" crash notification
	// for what is a routine, user-requested reload.
	it("exits the host with code 100 (no crash notification) when the child exits via /sumo:reload", async () => {
		vi.useFakeTimers();
		try {
			const notifications = { notify: vi.fn() };
			const stopHost = vi.fn(async (_code: number) => undefined);
			const exit = vi.fn((_code: number) => undefined);
			const handle = createRpcExitHandler(exitDeps({ notifications, stopHost, exit, shutdownDelayMs: 750 }));

			handle(new RpcChildExitError(`RPC child exited code=${SUMOCODE_RELOAD_EXIT_CODE} signal=null.`, { code: SUMOCODE_RELOAD_EXIT_CODE, signal: null }));
			await flush();

			expect(notifications.notify).not.toHaveBeenCalled();
			expect(stopHost).toHaveBeenCalledWith(SUMOCODE_RELOAD_EXIT_CODE);
			expect(exit).toHaveBeenCalledWith(SUMOCODE_RELOAD_EXIT_CODE);
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not wait out the shutdown delay for a reload exit (no notification needs time to render)", async () => {
		vi.useFakeTimers();
		try {
			const stopHost = vi.fn(async (_code: number) => undefined);
			const exit = vi.fn((_code: number) => undefined);
			const handle = createRpcExitHandler(exitDeps({ stopHost, exit, shutdownDelayMs: 750 }));

			handle(new RpcChildExitError("reload", { code: SUMOCODE_RELOAD_EXIT_CODE, signal: null }));
			await flush();

			expect(stopHost).toHaveBeenCalledOnce();
			expect(exit).toHaveBeenCalledOnce();
		} finally {
			vi.useRealTimers();
		}
	});

	it("still shows the crash notification and uses the configured (not the child's) exit code for a real crash carrying a structured exit code", async () => {
		vi.useFakeTimers();
		try {
			const notifications = { notify: vi.fn() };
			const stopHost = vi.fn(async (_code: number) => undefined);
			const exit = vi.fn((_code: number) => undefined);
			// exitCode: 7 is distinct from both the child's own crash code (2) and
			// the default (1), so a pass here can't be a coincidence of the two
			// numbers happening to match -- it proves the handler used the
			// configured host exitCode, not error.code, for a non-100 exit.
			const handle = createRpcExitHandler(exitDeps({ notifications, stopHost, exit, shutdownDelayMs: 750, exitCode: 7 }));

			handle(new RpcChildExitError("RPC child exited code=2 signal=null.", { code: 2, signal: null }));
			await vi.advanceTimersByTimeAsync(750);

			expect(notifications.notify).toHaveBeenCalledOnce();
			expect(stopHost).toHaveBeenCalledWith(7);
			expect(exit).toHaveBeenCalledWith(7);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("createLazyChatSink (B9 host wiring)", () => {
	const message: ChatMessageViewModel = { id: "m1", role: "sumo", displayName: "SUMO", blocks: [{ type: "markdown", text: "hi" }] };

	it("is a safe no-op (with fallback stats) before the runtime/shell exist", () => {
		const sink = createLazyChatSink(() => undefined);

		const stats = sink.replaceViewModels([message]);
		expect(stats).toEqual({ sourceMessages: 1, acceptedMessages: 1, renderedMessages: 1, archivedMessages: 0 });
		// Must not throw even with no live pager to forward to.
		expect(() => sink.addViewModel(message)).not.toThrow();
		expect(() => sink.replaceViewModelAt(0, message)).not.toThrow();
		expect(() => sink.replaceLastWithViewModel(message)).not.toThrow();
	});

	it("is a safe no-op when the runtime exists but its shell hasn't resolved yet (getChatSink returns undefined)", () => {
		const runtime = { getChatSink: () => undefined };
		const sink = createLazyChatSink(() => runtime);

		expect(() => sink.addViewModel(message)).not.toThrow();
		expect(sink.replaceViewModels([message])).toEqual({ sourceMessages: 1, acceptedMessages: 1, renderedMessages: 1, archivedMessages: 0 });
	});

	it("forwards every call to the live pager once the runtime's chat sink exists", () => {
		const pager = {
			replaceViewModels: vi.fn(() => ({ sourceMessages: 1, acceptedMessages: 1, renderedMessages: 1, archivedMessages: 0 })),
			addViewModel: vi.fn(),
			replaceViewModelAt: vi.fn(),
			replaceLastWithViewModel: vi.fn(),
		};
		const runtime = { getChatSink: () => pager };
		const sink = createLazyChatSink(() => runtime);

		sink.addViewModel(message);
		sink.replaceViewModelAt(0, message);
		sink.replaceLastWithViewModel(message);
		sink.replaceViewModels([message]);

		expect(pager.addViewModel).toHaveBeenCalledWith(message);
		expect(pager.replaceViewModelAt).toHaveBeenCalledWith(0, message);
		expect(pager.replaceLastWithViewModel).toHaveBeenCalledWith(message);
		expect(pager.replaceViewModels).toHaveBeenCalledWith([message]);
	});

	it("re-resolves the runtime/pager on every call (picks up the shell once it appears mid-session)", () => {
		let runtime: { getChatSink: () => import("../transcript/controller.js").TranscriptControllerChatSink | undefined } | undefined;
		const sink = createLazyChatSink(() => runtime);

		// Before the runtime exists: swallowed.
		sink.addViewModel(message);

		// The shell resolves mid-session (mirrors runtime.start()'s async
		// RpcShellAdapter.create landing after some events already fired).
		const addViewModel = vi.fn();
		runtime = {
			getChatSink: () => ({
				addViewModel,
				replaceViewModels: vi.fn(() => ({ sourceMessages: 0, acceptedMessages: 0, renderedMessages: 0, archivedMessages: 0 })),
				replaceViewModelAt: vi.fn(),
				replaceLastWithViewModel: vi.fn(),
			}),
		};
		sink.addViewModel(message);

		expect(addViewModel).toHaveBeenCalledTimes(1);
		expect(addViewModel).toHaveBeenCalledWith(message);
	});
});

describe("submitInitialPromptFromEnv (SUMOCODE_INITIAL_PROMPT seam)", () => {
	// bin/sumocode.sh strips a task/prompt positional out of the argv it
	// forwards to `pi --mode rpc` (which never reads argv positionals -- only
	// InteractiveMode does) and hands it to the host via this env var instead.
	// runRpcHost submits it through `submitFromEditor`, the exact same function
	// wired as the editor's onSubmit, once client.start() + initial hydration
	// have completed.

	it("submits exactly one prompt after start when SUMOCODE_INITIAL_PROMPT is set", async () => {
		const submit = vi.fn(async (_message: string) => undefined);

		await submitInitialPromptFromEnv({ SUMOCODE_INITIAL_PROMPT: "review the diff" }, submit);

		expect(submit).toHaveBeenCalledOnce();
		expect(submit).toHaveBeenCalledWith("review the diff");
	});

	it("submits nothing when SUMOCODE_INITIAL_PROMPT is absent", async () => {
		const submit = vi.fn(async (_message: string) => undefined);

		await submitInitialPromptFromEnv({}, submit);

		expect(submit).not.toHaveBeenCalled();
	});

	it("submits nothing when SUMOCODE_INITIAL_PROMPT is blank", async () => {
		const submit = vi.fn(async (_message: string) => undefined);

		await submitInitialPromptFromEnv({ SUMOCODE_INITIAL_PROMPT: "" }, submit);

		expect(submit).not.toHaveBeenCalled();
	});

	it("propagates a submit failure instead of swallowing it", async () => {
		const submit = vi.fn(async (_message: string) => {
			throw new Error("child not ready");
		});

		await expect(submitInitialPromptFromEnv({ SUMOCODE_INITIAL_PROMPT: "review the diff" }, submit)).rejects.toThrow("child not ready");
	});
});

describe("writeExitCodeFile (SUMOCODE_EXIT_CODE_FILE out-of-band exit-code channel)", () => {
	// bin/sumocode.sh's wait_for_child_exit was verified unreliable under macOS
	// bash 3.2: a SIGTERM-graceful shutdown that the host resolves as exit 0
	// can surface to the launcher as 143 via bash's own `wait` status. This is
	// the single choke point every host exit path (SIGINT/SIGTERM,
	// unhandledRejection/uncaughtException, createRpcExitHandler's reload/crash
	// paths, and main()'s natural-return path) funnels through -- see
	// runRpcHost's `exitProcess` and main() for the call sites.

	it("writes the exit code to the path given by SUMOCODE_EXIT_CODE_FILE", () => {
		const dir = mkdtempSync(join(tmpdir(), "sumocode-exit-code-"));
		const file = join(dir, "exit-code");
		try {
			writeExitCodeFile({ SUMOCODE_EXIT_CODE_FILE: file }, 0);
			expect(readFileSync(file, "utf8")).toBe("0");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("writes a nonzero/reload code just as faithfully as 0", () => {
		const dir = mkdtempSync(join(tmpdir(), "sumocode-exit-code-"));
		const file = join(dir, "exit-code");
		try {
			writeExitCodeFile({ SUMOCODE_EXIT_CODE_FILE: file }, SUMOCODE_RELOAD_EXIT_CODE);
			expect(readFileSync(file, "utf8")).toBe(String(SUMOCODE_RELOAD_EXIT_CODE));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("does not throw when SUMOCODE_EXIT_CODE_FILE is unset", () => {
		expect(() => writeExitCodeFile({}, 0)).not.toThrow();
	});

	it("does not throw when the target directory does not exist (best-effort side channel)", () => {
		expect(() => writeExitCodeFile({ SUMOCODE_EXIT_CODE_FILE: "/nonexistent-dir-xyz/exit-code" }, 1)).not.toThrow();
	});
});
