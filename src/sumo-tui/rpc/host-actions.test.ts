import type { RpcSessionState } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it } from "vitest";
import type { MemoryFact, MemoryStatus, RemnicMemoryClient } from "../../memory.js";
import { getActiveTheme, resetThemeRegistryForTests } from "../../themes/index.js";
import type { EditorTextController } from "../pi-compat/extension-ui-adapter.js";
import { ModalManager } from "../widgets/modal.js";
import type { NotificationLevel } from "../widgets/notification.js";
import type { RpcHostControls, RpcModelOption, RpcSlashCommand } from "./controls.js";
import { RpcHostActions, RPC_HOST_COMMAND_PALETTE_INPUT } from "./host-actions.js";
import { RpcHostOverlayManager } from "./host-overlays.js";
import { InlineSelectorHost } from "./inline-selector.js";
import { RpcHostStateStore } from "./state.js";

type Notification = { message: string; level: NotificationLevel };

// `InlineSelectorHost`'s selector wraps pi-tui's real `SelectList`, which
// matches raw terminal byte sequences via its own `getKeybindings()` (see
// select-list.js) -- NOT the lenient symbolic strings (`Key.down`, i.e. the
// literal string "down") `ModalManager.handleInput`'s bespoke `keyEq` accepts.
// These are the actual legacy VT sequences a real terminal sends.
const SELECTOR_DOWN = "\x1b[B";
const SELECTOR_ENTER = "\r";

class FakeInlineEditor {
	public text = "";
	public invalidate(): void {}
	public handleInput(): void {}
	public render(): string[] {
		return ["editor"];
	}
	public getText(): string {
		return this.text;
	}
	public setText(text: string): void {
		this.text = text;
	}
}

class FakeControls {
	public readonly calls: string[] = [];
	public models: RpcModelOption[] = [
		{ provider: "openai", id: "gpt-5", label: "openai/gpt-5", active: false },
		{ provider: "anthropic", id: "claude-opus-4-8", label: "anthropic/claude-opus-4-8", active: true },
	];
	public forkMessages = [{ entryId: "entry-1", text: "forkable message text" }];
	public commands: RpcSlashCommand[] = [];

	public async refreshState(): Promise<Record<string, unknown>> {
		this.calls.push("refreshState");
		return {};
	}

	public async getAvailableModels(): Promise<RpcModelOption[]> {
		this.calls.push("getAvailableModels");
		return this.models;
	}

	public async setModel(provider: string, modelId: string): Promise<Record<string, unknown>> {
		this.calls.push(`setModel:${provider}/${modelId}`);
		return {};
	}

	public async setThinkingLevel(level: RpcSessionState["thinkingLevel"]): Promise<Record<string, unknown>> {
		this.calls.push(`setThinking:${level}`);
		return {};
	}

	public async compact(customInstructions?: string): Promise<Record<string, unknown>> {
		this.calls.push(`compact:${customInstructions ?? ""}`);
		return {};
	}

	public newSessionCancelled = false;
	public switchSessionCancelled = false;
	public forkCancelled = false;
	public cloneCancelled = false;

	public async newSession(): Promise<{ cancelled: boolean }> {
		this.calls.push("newSession");
		return { cancelled: this.newSessionCancelled };
	}

	public async switchSession(sessionPath: string): Promise<{ cancelled: boolean }> {
		this.calls.push(`switchSession:${sessionPath}`);
		return { cancelled: this.switchSessionCancelled };
	}

	public async fork(entryId: string): Promise<{ cancelled: boolean; text?: string }> {
		this.calls.push(`fork:${entryId}`);
		return { cancelled: this.forkCancelled, text: this.forkCancelled ? undefined : "fork from here" };
	}

	public async clone(): Promise<{ cancelled: boolean }> {
		this.calls.push("clone");
		return { cancelled: this.cloneCancelled };
	}

	public async getForkMessages(): Promise<typeof this.forkMessages> {
		this.calls.push("getForkMessages");
		return this.forkMessages;
	}

	public async getSessionStats(): Promise<Record<string, unknown>> {
		this.calls.push("getSessionStats");
		return {
			sessionFile: "/tmp/session.jsonl",
			sessionId: "session-1",
			userMessages: 1,
			assistantMessages: 1,
			toolCalls: 0,
			toolResults: 0,
			totalMessages: 2,
			tokens: { input: 1000, output: 2000, cacheRead: 0, cacheWrite: 0, total: 3000 },
			cost: 0.42,
		};
	}

	public async setSessionName(name: string): Promise<void> {
		this.calls.push(`setSessionName:${name}`);
	}

	public async setAutoCompaction(enabled: boolean): Promise<void> {
		this.calls.push(`setAutoCompaction:${enabled}`);
	}

	public async setAutoRetry(enabled: boolean): Promise<void> {
		this.calls.push(`setAutoRetry:${enabled}`);
	}

	public async getCommands(): Promise<RpcSlashCommand[]> {
		this.calls.push("getCommands");
		return this.commands;
	}
}

class FakeMemoryClient implements RemnicMemoryClient {
	public readonly calls: string[] = [];
	public readonly facts: MemoryFact[] = [{
		id: "fact-1",
		text: "host-rendered memory fact",
		tags: ["sumocode:project"],
		status: "active",
	}];

	public async query(): Promise<MemoryFact[]> {
		this.calls.push("query");
		return this.facts;
	}

	public async status(): Promise<MemoryStatus> {
		this.calls.push("status");
		return { ok: true, factCount: this.facts.length, lastExtractionAt: "2026-07-02T10:00:00Z" };
	}

	public async add(text: string): Promise<MemoryFact> {
		this.calls.push(`add:${text}`);
		return { id: "fact-2", text };
	}

	public async forget(factId: string): Promise<void> {
		this.calls.push(`forget:${factId}`);
	}

	public async observe(): Promise<void> {
		this.calls.push("observe");
	}

	public async browse(): Promise<MemoryFact[]> {
		this.calls.push("browse");
		return this.facts;
	}
}

class FakeEditorText implements EditorTextController {
	public text = "";

	public paste(text: string): void {
		this.text += text;
	}

	public setText(text: string): void {
		this.text = text;
	}

	public getText(): string {
		return this.text;
	}
}

function flush(): Promise<void> {
	return Promise.resolve().then(() => Promise.resolve());
}

function renderOverlayText(overlays: RpcHostOverlayManager, width = 100): string {
	return overlays.render(width).join("\n").replace(/\u001b\[[0-9;]*m/g, "");
}

function setup(options: {
	readonly memory?: FakeMemoryClient;
	readonly onExitRequest?: (code: number) => void;
} = {}) {
	const controls = new FakeControls();
	const stateStore = new RpcHostStateStore();
	stateStore.hydrateFromRpcState({
		model: { provider: "anthropic", id: "claude-opus-4-8", name: "Claude" } as RpcSessionState["model"],
		thinkingLevel: "medium",
		isStreaming: false,
		isCompacting: false,
		steeringMode: "all",
		followUpMode: "one-at-a-time",
		sessionId: "session-1",
		sessionName: "Migration",
		autoCompactionEnabled: true,
		messageCount: 2,
		pendingMessageCount: 0,
	});
	const modals = new ModalManager();
	const overlays = new RpcHostOverlayManager();
	const inlineSelectors = new InlineSelectorHost(new FakeInlineEditor());
	const notifications: Notification[] = [];
	const memory = options.memory ?? new FakeMemoryClient();
	const editorText = new FakeEditorText();
	const rehydrateCalls: number[] = [];
	const rehydrateTranscript = async (): Promise<void> => {
		rehydrateCalls.push(rehydrateCalls.length + 1);
	};
	const actions = new RpcHostActions({
		controls: controls as unknown as RpcHostControls,
		stateStore,
		modals,
		overlays,
		inlineSelectors,
		notifications: {
			notify: (message, level = "info") => {
				notifications.push({ message, level });
				return notifications.length;
			},
		},
		editorText,
		createMemoryClient: () => memory,
		onExitRequest: options.onExitRequest,
		rehydrateTranscript,
	});

	return { actions, controls, modals, overlays, inlineSelectors, notifications, memory, editorText, rehydrateCalls };
}

function rpcCommand(name: string): RpcSlashCommand {
	return {
		name,
		description: `Run ${name}`,
		source: "prompt",
		sourceInfo: {
			path: `/tmp/${name}`,
			source: "prompt",
			scope: "project",
			origin: "top-level",
		},
	};
}

afterEach(() => {
	resetThemeRegistryForTests();
});

describe("RpcHostActions", () => {
	it.each([RPC_HOST_COMMAND_PALETTE_INPUT, "\x1b[47;5u"])("opens the host command palette from runtime hotkey variant %#", async (hotkey) => {
		const { actions, controls, overlays, inlineSelectors, notifications } = setup();

		expect(actions.handleInput(hotkey)).toBe(true);
		expect(overlays.getActiveKind()).toBe("commandPalette");

		overlays.handleInput(Key.enter);
		await flush();
		// The palette's MODEL row now opens the in-place selector (plan 036),
		// not the full-screen ModalLayer.
		expect(inlineSelectors.getActiveKind()).toBe("select");

		inlineSelectors.handleInput(SELECTOR_ENTER);
		await flush();

		expect(overlays.getActiveKind()).toBeUndefined();
		expect(inlineSelectors.getActiveKind()).toBeUndefined();
		expect(controls.calls).toEqual([
			"getAvailableModels",
			"setModel:openai/gpt-5",
		]);
		expect(notifications).toContainEqual({ message: "model: openai/gpt-5", level: "info" });
	});

	it("handles RPC path slash controls for model, thinking, compaction, and settings", async () => {
		const { actions, controls, modals, notifications } = setup();

		await expect(actions.handleSubmittedText("/model openai/gpt-5")).resolves.toBe(true);
		await expect(actions.handleSubmittedText("/thinking high")).resolves.toBe(true);
		await expect(actions.handleSubmittedText("/compact keep branch summary")).resolves.toBe(true);

		const settings = actions.handleSubmittedText("/settings");
		await flush();
		expect(modals.getActiveKind()).toBe("select");
		modals.handleInput(Key.down);
		modals.handleInput(Key.enter);
		await settings;

		expect(controls.calls).toContain("setModel:openai/gpt-5");
		expect(controls.calls).toContain("setThinking:high");
		expect(controls.calls).toContain("compact:keep branch summary");
		expect(controls.calls).toContain("setAutoCompaction:false");
		expect(notifications).toContainEqual({ message: "auto compaction disabled", level: "info" });
	});

	it("opens the in-place selector for bare /thinking (no args) and applies the chosen level", async () => {
		const { actions, controls, inlineSelectors, notifications } = setup();

		const thinking = actions.handleSubmittedText("/thinking");
		await flush();
		expect(inlineSelectors.getActiveKind()).toBe("select");

		inlineSelectors.handleInput(SELECTOR_DOWN); // off -> minimal
		inlineSelectors.handleInput(SELECTOR_ENTER);
		await thinking;

		expect(inlineSelectors.getActiveKind()).toBeUndefined();
		expect(controls.calls).toContain("setThinking:minimal");
		expect(notifications).toContainEqual({ message: "thinking: minimal", level: "info" });
	});

	it("handles session controls through modal selectors and editor text handoff", async () => {
		const { actions, controls, modals, editorText, rehydrateCalls } = setup();

		const session = actions.handleSubmittedText("/sessions");
		await flush();
		expect(modals.getActiveKind()).toBe("select");
		modals.handleInput(Key.down);
		modals.handleInput(Key.down);
		modals.handleInput(Key.enter);
		await flush();

		expect(modals.getActiveKind()).toBe("select");
		modals.handleInput(Key.enter);
		await session;

		expect(controls.calls).toEqual([
			"getForkMessages",
			"fork:entry-1",
		]);
		expect(editorText.getText()).toBe("fork from here");
		expect(rehydrateCalls).toHaveLength(1);
	});

	it("rehydrates the transcript exactly once after /new, /clone, switch, and a successful fork", async () => {
		const { actions, controls, modals, rehydrateCalls } = setup();

		await expect(actions.handleSubmittedText("/new")).resolves.toBe(true);
		expect(rehydrateCalls).toHaveLength(1);

		await expect(actions.handleSubmittedText("/clone")).resolves.toBe(true);
		expect(rehydrateCalls).toHaveLength(2);

		const switchPromise = actions.handleSubmittedText("/sessions");
		await flush();
		modals.handleInput(Key.down); // Switch session by path
		modals.handleInput(Key.enter);
		await flush();
		modals.handleInput("/tmp/other-session.jsonl");
		modals.handleInput(Key.enter);
		await switchPromise;
		expect(controls.calls).toContain("switchSession:/tmp/other-session.jsonl");
		expect(rehydrateCalls).toHaveLength(3);

		const forkPromise = actions.handleSubmittedText("/fork");
		await flush();
		modals.handleInput(Key.enter);
		await forkPromise;
		expect(rehydrateCalls).toHaveLength(4);
	});

	it("does not rehydrate the transcript when a session operation is cancelled", async () => {
		const { actions, controls, modals, rehydrateCalls } = setup();
		controls.newSessionCancelled = true;
		controls.cloneCancelled = true;
		controls.switchSessionCancelled = true;
		controls.forkCancelled = true;

		await expect(actions.handleSubmittedText("/new")).resolves.toBe(true);
		await expect(actions.handleSubmittedText("/clone")).resolves.toBe(true);

		const switchPromise = actions.handleSubmittedText("/sessions");
		await flush();
		modals.handleInput(Key.down);
		modals.handleInput(Key.enter);
		await flush();
		modals.handleInput("/tmp/other-session.jsonl");
		modals.handleInput(Key.enter);
		await switchPromise;

		const forkPromise = actions.handleSubmittedText("/fork");
		await flush();
		modals.handleInput(Key.enter);
		await forkPromise;

		expect(rehydrateCalls).toHaveLength(0);
	});

	it("does not rehydrate the transcript when the fork selector is dismissed without a selection", async () => {
		const { actions, modals, rehydrateCalls } = setup();

		const forkPromise = actions.handleSubmittedText("/fork");
		await flush();
		modals.handleInput(Key.escape);
		await forkPromise;

		expect(rehydrateCalls).toHaveLength(0);
	});

	it("handles /session stats and /name rename as host commands", async () => {
		const { actions, controls, modals, notifications } = setup();

		await expect(actions.handleSubmittedText("/session")).resolves.toBe(true);
		expect(controls.calls).toContain("getSessionStats");
		expect(notifications).toContainEqual({ message: "session: 2 messages | 3,000 tokens | $0.42", level: "info" });

		const rename = actions.handleSubmittedText("/name");
		await flush();
		expect(modals.getActiveKind()).toBe("input");
		modals.handleInput("Plan 023");
		modals.handleInput(Key.enter);
		await rename;

		expect(controls.calls).toContain("setSessionName:Plan 023");
		expect(controls.calls).toContain("refreshState");
		expect(notifications).toContainEqual({ message: "session name: Plan 023", level: "info" });
	});

	it("renders theme check, approval preview, and memory editor as host overlays", async () => {
		const { actions, overlays, notifications, memory } = setup();

		const themeCheck = actions.handleSubmittedText("/sumo:theme-check");
		await flush();
		expect(overlays.getActiveKind()).toBe("themeCheck");
		expect(renderOverlayText(overlays)).toContain("CATHEDRAL THEME CHECK");
		overlays.handleInput("x");
		await themeCheck;

		const approval = actions.handleSubmittedText("/sumo:approval");
		await flush();
		expect(overlays.getActiveKind()).toBe("approvalPreview");
		expect(renderOverlayText(overlays)).toContain("APPROVAL REQUIRED");
		overlays.handleInput("n");
		await approval;
		expect(notifications).toContainEqual({ message: "approval selected: no", level: "warning" });

		const memoryEditor = actions.handleSubmittedText("/sumo:memory");
		await flush();
		expect(overlays.getActiveKind()).toBe("memoryEditor");
		expect(renderOverlayText(overlays)).toContain("MEMORY SCRIPTORIUM");
		overlays.handleInput(Key.escape);
		await memoryEditor;
		expect(memory.calls).toContain("browse");
	});

	it("supports direct host memory and theme commands without falling through to Pi prompt text", async () => {
		const { actions, memory, notifications } = setup();

		await expect(actions.handleSubmittedText("/sumo:memory status")).resolves.toBe(true);
		await expect(actions.handleSubmittedText("/sumo:memory add remember this")).resolves.toBe(true);
		await expect(actions.handleSubmittedText("/sumo:memory forget fact-1")).resolves.toBe(true);
		await expect(actions.handleSubmittedText("/sumo:theme amber-crt")).resolves.toBe(true);
		await expect(actions.handleSubmittedText("ordinary prompt")).resolves.toBe(false);

		expect(memory.calls).toEqual([
			"status",
			"add:remember this",
			"forget:fact-1",
		]);
		expect(getActiveTheme().name).toBe("amber-crt");
		expect(notifications).toContainEqual({ message: "theme: amber-crt", level: "info" });
	});

	it("notifies memory client failures without throwing from direct memory commands", async () => {
		const memory = new FakeMemoryClient();
		memory.add = async (text: string) => {
			memory.calls.push(`add:${text}`);
			throw new Error("memory offline");
		};
		const { actions, notifications } = setup({ memory });

		await expect(actions.handleSubmittedText("/sumo:memory add remember this")).resolves.toBe(true);

		expect(memory.calls).toEqual(["add:remember this"]);
		expect(notifications).toContainEqual({ message: "rpc error: memory offline", level: "warning" });
	});

	it("handles /quit through the injected exit request", async () => {
		const exits: number[] = [];
		const { actions } = setup({ onExitRequest: (code) => exits.push(code) });

		await expect(actions.handleSubmittedText("/quit")).resolves.toBe(true);

		expect(exits).toEqual([0]);
	});

	it("notifies for unknown slash commands instead of letting them become model prompts", async () => {
		const { actions, controls, notifications } = setup();

		await expect(actions.handleSubmittedText("/hotkeys")).resolves.toBe(true);
		expect(controls.calls).toContain("getCommands");
		expect(notifications).toContainEqual({ message: "unknown command: /hotkeys", level: "warning" });

		controls.commands = [rpcCommand("deploy")];
		await expect(actions.handleSubmittedText("/deploy prod")).resolves.toBe(false);
	});
});
