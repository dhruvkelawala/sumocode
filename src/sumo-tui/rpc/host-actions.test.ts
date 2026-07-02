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
import { RpcHostStateStore } from "./state.js";

type Notification = { message: string; level: NotificationLevel };

class FakeControls {
	public readonly calls: string[] = [];
	public models: RpcModelOption[] = [
		{ provider: "openai", id: "gpt-5", label: "openai/gpt-5", active: false },
		{ provider: "anthropic", id: "claude-opus-4-8", label: "anthropic/claude-opus-4-8", active: true },
	];
	public forkMessages = [{ entryId: "entry-1", text: "forkable message text" }];

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

	public async newSession(): Promise<{ cancelled: boolean }> {
		this.calls.push("newSession");
		return { cancelled: false };
	}

	public async switchSession(sessionPath: string): Promise<{ cancelled: boolean }> {
		this.calls.push(`switchSession:${sessionPath}`);
		return { cancelled: false };
	}

	public async fork(entryId: string): Promise<{ cancelled: boolean; text?: string }> {
		this.calls.push(`fork:${entryId}`);
		return { cancelled: false, text: "fork from here" };
	}

	public async clone(): Promise<{ cancelled: boolean }> {
		this.calls.push("clone");
		return { cancelled: false };
	}

	public async getForkMessages(): Promise<typeof this.forkMessages> {
		this.calls.push("getForkMessages");
		return this.forkMessages;
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
		return [];
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

function setup() {
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
	const notifications: Notification[] = [];
	const memory = new FakeMemoryClient();
	const editorText = new FakeEditorText();
	const actions = new RpcHostActions({
		controls: controls as unknown as RpcHostControls,
		stateStore,
		modals,
		overlays,
		notifications: {
			notify: (message, level = "info") => {
				notifications.push({ message, level });
				return notifications.length;
			},
		},
		editorText,
		createMemoryClient: () => memory,
	});

	return { actions, controls, modals, overlays, notifications, memory, editorText };
}

afterEach(() => {
	resetThemeRegistryForTests();
});

describe("RpcHostActions", () => {
	it("opens the host command palette from the runtime hotkey and routes model selection to RPC controls", async () => {
		const { actions, controls, modals, overlays, notifications } = setup();

		expect(actions.handleInput(RPC_HOST_COMMAND_PALETTE_INPUT)).toBe(true);
		expect(overlays.getActiveKind()).toBe("commandPalette");

		overlays.handleInput(Key.enter);
		await flush();
		expect(modals.getActiveKind()).toBe("select");

		modals.handleInput(Key.enter);
		await flush();

		expect(overlays.getActiveKind()).toBeUndefined();
		expect(modals.getActiveKind()).toBeUndefined();
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

	it("handles session controls through modal selectors and editor text handoff", async () => {
		const { actions, controls, modals, editorText } = setup();

		const session = actions.handleSubmittedText("/session");
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
});
