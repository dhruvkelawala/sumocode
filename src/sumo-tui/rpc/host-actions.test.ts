// oxlint-disable no-control-regex -- intentional ESC byte matches for terminal frame assertions
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RpcSessionState } from "@earendil-works/pi-coding-agent";

/** JSON-ish fixture payload returned by the controls double. */
type FixtureValue = string | number | boolean | null | FixtureValue[] | FixturePayload;
interface FixturePayload {
	[key: string]: FixtureValue;
}
import { Key } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it } from "vitest";
import type { MemoryFact, MemoryStatus, RemnicMemoryClient } from "../../memory.js";
import { getActiveTheme, resetThemeRegistryForTests } from "../../themes/index.js";
import type { EditorTextController } from "../pi-compat/extension-ui-adapter.js";
import { MAX_CLIPBOARD_BYTES } from "../input/selection.js";
import { ModalManager } from "../widgets/modal.js";
import type { NotificationLevel } from "../widgets/notification.js";
import type { RpcHostControls, RpcModelOption, RpcSlashCommand } from "./controls.js";
import type { RpcTreeNavigationOutcome, RpcTreeNavigationRequest } from "../pi-compat/tree-navigation-command.js";
import type { SessionEntryLike } from "./session-reader.js";
import { isRpcHostSlashCommandName, RpcHostActions, RPC_HOST_COMMAND_PALETTE_INPUT, RPC_HOST_ROUTED_CHILD_COMMANDS, RPC_HOST_SLASH_COMMANDS } from "./host-actions.js";
import { RpcHostOverlayManager } from "./host-overlays.js";
import { writeLovelyWebPatch } from "./lovely-web-config.js";
import { InlineSelectorHost } from "./inline-selector.js";
import { RpcHostStateStore, type RpcHostChromeState } from "./state.js";

type Notification = { message: string; level: NotificationLevel };

// `InlineSelectorHost`'s selector wraps pi-tui's real `SelectList`, which
// matches raw terminal byte sequences via its own `getKeybindings()` (see
// select-list.js) -- NOT the lenient symbolic strings (`Key.down`, i.e. the
// literal string "down") `ModalManager.handleInput`'s bespoke `keyEq` accepts.
// These are the actual legacy VT sequences a real terminal sends.
const SELECTOR_DOWN = "\x1b[B";
const SELECTOR_ENTER = "\r";
const SELECTOR_ESCAPE = "\x1b";
const SELECTOR_TAB = "\t";

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
	public enabledModels: RpcModelOption[] | undefined;
	public thinkingLevels: RpcSessionState["thinkingLevel"][] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

	public forkMessages = [{ entryId: "entry-1", text: "forkable message text" }];
	public commands: RpcSlashCommand[] = [];
	public sessionFile: string | undefined;
	public leafId: string | null = "not-visible";
	public readonly treeRequests: RpcTreeNavigationRequest[] = [];
	public treeOutcomeStatus: RpcTreeNavigationOutcome["status"] = "committed";
	public treeOutcomeLeafId: string | null | undefined;
	public treeNavigationError: Error | undefined;

	public async refreshState(): Promise<RpcHostChromeState> {
		this.calls.push("refreshState");
		return new RpcHostStateStore().getSnapshot();
	}

	public async getAvailableModels(): Promise<RpcModelOption[]> {
		this.calls.push("getAvailableModels");
		return this.models;
	}

	public async getEnabledModels(): Promise<RpcModelOption[]> {
		this.calls.push("getEnabledModels");
		return this.enabledModels ?? this.models;
	}

	public async setModel(provider: string, modelId: string): Promise<FixturePayload> {
		this.calls.push(`setModel:${provider}/${modelId}`);
		return { modelLabel: `${provider}/${modelId}` };
	}

	public async setThinkingLevel(level: RpcSessionState["thinkingLevel"]): Promise<FixturePayload> {
		this.calls.push(`setThinking:${level}`);
		return { thinkingLevel: level };
	}

	public async getAvailableThinkingLevels(): Promise<RpcSessionState["thinkingLevel"][]> {
		this.calls.push("getAvailableThinkingLevels");
		return this.thinkingLevels;
	}

	public async compact(customInstructions?: string): Promise<FixturePayload> {
		this.calls.push(`compact:${customInstructions ?? ""}`);
		return {};
	}

	public async executeExtensionCommand(message: string): Promise<void> {
		this.calls.push(`executeExtensionCommand:${message}`);
	}

	public async cancelLogin(): Promise<void> {
		this.calls.push("cancelLogin");
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

	public async getEntries(since?: string): Promise<{ entries: SessionEntryLike[]; leafId: string | null }> {
		this.calls.push(`getEntries:${since ?? ""}`);
		if (!this.sessionFile) return { entries: [], leafId: this.leafId };
		let content: string;
		try {
			content = await readFile(this.sessionFile, "utf8");
		} catch {
			return { entries: [], leafId: this.leafId };
		}
		// SAFETY: the fixture writes one jsonl entry per line; only id/type are
		// read here, matching the session-reader contract.
		const lines = content.split("\n").filter(Boolean).map((line) => JSON.parse(line) as SessionEntryLike & { type: string });
		const entries = lines.filter((line) => line.type !== "session");
		const start = since === undefined ? 0 : entries.findIndex((line) => line.id === since) + 1;
		const selected = start < 0 ? [] : entries.slice(start);
		return { entries: selected, leafId: this.leafId };
	}

	public async navigateTree(request: RpcTreeNavigationRequest): Promise<RpcTreeNavigationOutcome> {
		this.treeRequests.push(request);
		this.calls.push(`navigateTree:${request.targetId}:${String(request.summarize)}:${request.customInstructions ?? ""}`);
		if (this.treeNavigationError) throw this.treeNavigationError;
		if (this.treeOutcomeStatus === "committed") this.leafId = request.targetId;
		return { requestId: request.requestId, status: this.treeOutcomeStatus, leafId: this.treeOutcomeLeafId ?? this.leafId };
	}

	public async getSessionStats(): Promise<FixturePayload> {
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

	public async setSessionName(name: string): Promise<FixturePayload> {
		this.calls.push(`setSessionName:${name}`);
		return { sessionName: name };
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

	public lastAssistantText: string | null = "last assistant response";

	public async getLastAssistantText(): Promise<string | null> {
		this.calls.push("getLastAssistantText");
		return this.lastAssistantText;
	}

	public exportedPath = "/tmp/sumocode-session.html";

	public async exportHtml(): Promise<{ path: string }> {
		this.calls.push("exportHtml");
		return { path: this.exportedPath };
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

/**
 * `/resume` reads the session directory off real disk (`node:fs/promises`
 * `readdir`, then a `readline` stream per fixture file), which resolves via
 * libuv's thread pool across several chained async hops -- more than
 * `flush()`'s two `Promise.resolve()` microtask hops (or a single
 * `setImmediate`) reliably drains. A short real-time wait is simplest here
 * given how small the fixture files are.
 */
function flushIO(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 20));
}

function renderOverlayText(overlays: RpcHostOverlayManager, width = 100): string {
	return overlays.render(width).join("\n").replace(/\u001b\[[0-9;]*m/g, "");
}

function setup(options: {
	readonly memory?: FakeMemoryClient;
	readonly onExitRequest?: (code: number) => void;
	readonly writeClipboardSequence?: (sequence: string) => boolean;
	readonly sessionFile?: string;
	readonly changelogRoot?: string;
	readonly onStateChange?: (state?: RpcHostChromeState) => void;
	readonly mermaidMode?: "off" | "final" | "streaming";
	readonly onMermaidModeChange?: (mode: "off" | "final" | "streaming") => void;
	readonly onRenderRequest?: () => void;
	readonly beforeTreeNavigation?: (request: RpcTreeNavigationRequest) => Promise<void>;
	readonly reconcileTreeNavigation?: (outcome?: RpcTreeNavigationOutcome) => Promise<void>;
	readonly setTreeNavigationBusy?: (busy: boolean) => void;
	readonly isTreeNavigationBusy?: () => boolean;
} = {}) {
	const controls = new FakeControls();
	controls.sessionFile = options.sessionFile;
	const stateStore = new RpcHostStateStore();
	// SAFETY: fixtures populate only the model fields these tests read.
	stateStore.hydrateFromRpcState({
		model: { provider: "anthropic", id: "claude-opus-4-8", name: "Claude" } as RpcSessionState["model"],
		thinkingLevel: "medium",
		isStreaming: false,
		isCompacting: false,
		steeringMode: "all",
		followUpMode: "one-at-a-time",
		sessionId: "session-1",
		sessionName: "Migration",
		sessionFile: options.sessionFile,
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
	const stateChanges: Array<RpcHostChromeState | undefined> = [];
	const persistedThemes: string[] = [];
	const actions = new RpcHostActions({
		// SAFETY: the controls double implements the dispatch surface driven by
		// these tests; unrelated members are never invoked.
		controls: controls as RpcHostControls & typeof controls,
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
		onStateChange: (state) => {
			stateChanges.push(state);
			options.onStateChange?.(state);
		},
		onRenderRequest: options.onRenderRequest,
		getMermaidRenderingMode: () => options.mermaidMode ?? "streaming",
		setMermaidRenderingMode: (mode) => options.onMermaidModeChange?.(mode),
		rehydrateTranscript,
		beforeTreeNavigation: options.beforeTreeNavigation,
		reconcileTreeNavigation: options.reconcileTreeNavigation,
		setTreeNavigationBusy: options.setTreeNavigationBusy,
		isTreeNavigationBusy: options.isTreeNavigationBusy,
		writeClipboardSequence: options.writeClipboardSequence,
		changelogRoot: options.changelogRoot,
		// Never write the developer's real ~/.pi/agent/sumocode.json from tests.
		persistTheme: (name) => {
			persistedThemes.push(name);
			return { success: true };
		},
	});

	return { actions, controls, modals, overlays, inlineSelectors, notifications, memory, editorText, rehydrateCalls, stateChanges, persistedThemes };
}

function rpcCommand(name: string, source: RpcSlashCommand["source"] = "prompt"): RpcSlashCommand {
	return {
		name,
		description: `Run ${name}`,
		source,
		sourceInfo: {
			path: `/tmp/${name}`,
			source,
			scope: "project",
			origin: "top-level",
		},
	};
}

afterEach(() => {
	resetThemeRegistryForTests();
});

describe("RpcHostActions", () => {
	it.each([RPC_HOST_COMMAND_PALETTE_INPUT, "\x1b[47;5u"])("opens the host command palette and applies the model selector without a toast from runtime hotkey variant %#", async (hotkey) => {
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
			"getEnabledModels",
			"getAvailableModels",
			"setModel:openai/gpt-5",
		]);
		expect(notifications).toEqual([]);
	});

	it("starts the bare /model selector on the enabled-model tab when all models include disabled entries", async () => {
		const { actions, controls, inlineSelectors } = setup();
		controls.models = [
			{ provider: "disabled", id: "outside-scope", label: "disabled/outside-scope", active: false },
			{ provider: "anthropic", id: "claude-opus-4-8", label: "anthropic/claude-opus-4-8", active: true },
			{ provider: "google", id: "gemini-3", label: "google/gemini-3", active: false },
		];
		controls.enabledModels = [
			{ provider: "anthropic", id: "claude-opus-4-8", label: "anthropic/claude-opus-4-8", active: true },
			{ provider: "google", id: "gemini-3", label: "google/gemini-3", active: false },
		];

		const model = actions.handleSubmittedText("/model");
		await flush();
		expect(inlineSelectors.getActiveKind()).toBe("select");

		inlineSelectors.handleInput(SELECTOR_ENTER);
		await model;

		expect(controls.calls).toEqual([
			"getEnabledModels",
			"getAvailableModels",
			"setModel:anthropic/claude-opus-4-8",
		]);
	});

	it("lets Tab switch the bare /model selector from enabled models to all models", async () => {
		const { actions, controls, inlineSelectors } = setup();
		controls.models = [
			{ provider: "disabled", id: "outside-scope", label: "disabled/outside-scope", active: false },
			{ provider: "anthropic", id: "claude-opus-4-8", label: "anthropic/claude-opus-4-8", active: true },
			{ provider: "google", id: "gemini-3", label: "google/gemini-3", active: false },
		];
		controls.enabledModels = [
			{ provider: "anthropic", id: "claude-opus-4-8", label: "anthropic/claude-opus-4-8", active: true },
			{ provider: "google", id: "gemini-3", label: "google/gemini-3", active: false },
		];

		const model = actions.handleSubmittedText("/model");
		await flush();
		expect(inlineSelectors.getActiveKind()).toBe("select");
		let rendered = inlineSelectors.render(100).join("\n").replace(/\u001b\[[0-9;]*m/g, "");
		expect(rendered).toContain("ENABLED");
		expect(rendered).toContain("ALL");
		expect(rendered).not.toContain("disabled/outside-scope");

		inlineSelectors.handleInput(SELECTOR_TAB);
		rendered = inlineSelectors.render(100).join("\n").replace(/\u001b\[[0-9;]*m/g, "");
		expect(rendered).toContain("disabled/outside-scope");

		inlineSelectors.handleInput(SELECTOR_ENTER);
		await model;

		expect(controls.calls).toEqual([
			"getEnabledModels",
			"getAvailableModels",
			"setModel:disabled/outside-scope",
		]);
	});

	it("lets the bare /model selector show the full list when getEnabledModels falls back to the full list", async () => {
		const { actions, controls, inlineSelectors } = setup();
		controls.enabledModels = controls.models;

		const model = actions.handleSubmittedText("/model");
		await flush();
		expect(inlineSelectors.getActiveKind()).toBe("select");

		inlineSelectors.handleInput(SELECTOR_ENTER);
		await model;

		expect(controls.calls).toEqual([
			"getEnabledModels",
			"getAvailableModels",
			"setModel:openai/gpt-5",
		]);
	});

	it("handles RPC path slash controls for model, thinking, compaction, and settings", async () => {
		const { actions, controls, inlineSelectors, notifications, stateChanges } = setup();

		await expect(actions.handleSubmittedText("/model openai/gpt-5")).resolves.toBe(true);
		await expect(actions.handleSubmittedText("/thinking high")).resolves.toBe(true);
		await expect(actions.handleSubmittedText("/compact keep branch summary")).resolves.toBe(true);

		const settings = actions.handleSubmittedText("/settings");
		await flush();
		expect(inlineSelectors.getActiveKind()).toBe("select");
		inlineSelectors.handleInput(SELECTOR_DOWN);
		inlineSelectors.handleInput(SELECTOR_ENTER);
		await settings;

		expect(controls.calls).toEqual([
			"setModel:openai/gpt-5",
			"getAvailableThinkingLevels",
			"setThinking:high",
			"compact:keep branch summary",
			"setAutoCompaction:false",
		]);
		expect(stateChanges).toEqual([
			{ modelLabel: "openai/gpt-5" },
			{ thinkingLevel: "high" },
			undefined,
		]);
		expect(notifications).toContainEqual({ message: "auto compaction disabled", level: "info" });
	});

	it("persists Mermaid mode through RPC settings and requests an immediate repaint", async () => {
		const changes: string[] = [];
		let renders = 0;
		const { actions, inlineSelectors } = setup({
			mermaidMode: "final",
			onMermaidModeChange: (mode) => changes.push(mode),
			onRenderRequest: () => { renders += 1; },
		});

		const settings = actions.handleSubmittedText("/settings");
		await flush();
		const rendered = inlineSelectors.render(80).join("\n").replace(/\u001b\[[0-9;]*m/g, "");
		expect(rendered).toContain("mermaid diagrams: final");
		expect(rendered).toContain("current");
		for (let index = 0; index < 6; index += 1) inlineSelectors.handleInput(SELECTOR_DOWN);
		inlineSelectors.handleInput(SELECTOR_ENTER);
		await settings;

		expect(changes).toEqual(["streaming"]);
		expect(renders).toBe(1);
	});

	it("does not swallow filesystem paths as unknown commands (image-only submits)", async () => {
		const { actions, notifications } = setup();

		// An image-only submit expands to a bare clipboard path — starts with
		// "/" but is a prompt, not a command attempt. handleSubmittedText must
		// return false so the caller forwards it to the agent.
		await expect(actions.handleSubmittedText("/var/folders/ab/pi-clipboard-123.png")).resolves.toBe(false);
		await expect(actions.handleSubmittedText("/tmp/pi-clipboard-9f.png what is this?")).resolves.toBe(false);
		expect(notifications).not.toContainEqual(expect.objectContaining({ level: "warning" }));
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
		expect(controls.calls).toContain("getAvailableThinkingLevels");
		expect(controls.calls).toContain("setThinking:minimal");
		expect(notifications).toContainEqual({ message: "thinking: minimal", level: "info" });
	});

	it("validates explicit /thinking values against Pi's available thinking levels", async () => {
		const { actions, controls, notifications } = setup();
		controls.thinkingLevels = ["off", "minimal", "low", "medium", "high"];

		await expect(actions.handleSubmittedText("/thinking xhigh")).resolves.toBe(true);

		expect(controls.calls).toEqual(["getAvailableThinkingLevels"]);
		expect(notifications).toContainEqual({ message: "unknown thinking level: xhigh", level: "warning" });
	});

	it("handles /lovely-web in the retained host instead of delegating to Pi's unsupported RPC custom UI", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "sumocode-lovely-web-host-test-"));
		const agentDir = mkdtempSync(join(tmpdir(), "sumocode-lovely-web-agent-test-"));
		const configDir = mkdtempSync(join(tmpdir(), "sumocode-lovely-web-private-test-"));
		mkdirSync(join(configDir, ".git"));
		const originalCwd = process.cwd();
		const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
		const originalConfigDir = process.env.SUMOCODE_CONFIG_DIR;
		try {
			process.chdir(cwd);
			process.env.PI_CODING_AGENT_DIR = agentDir;
			process.env.SUMOCODE_CONFIG_DIR = configDir;
			const { actions, inlineSelectors, notifications } = setup();

			const lovelyWeb = actions.handleSubmittedText("/lovely-web");
			await flush();
			expect(inlineSelectors.getActiveKind()).toBe("select");
			inlineSelectors.handleInput(SELECTOR_ENTER); // user config
			await flush();
			inlineSelectors.handleInput(SELECTOR_ENTER); // web_search provider
			await flush();
			inlineSelectors.handleInput(SELECTOR_DOWN);
			inlineSelectors.handleInput(SELECTOR_DOWN); // disabled -> firecrawl -> exa
			inlineSelectors.handleInput(SELECTOR_ENTER);
			await flush();
			inlineSelectors.handleInput(SELECTOR_ESCAPE); // close scope editor
			await lovelyWeb;

			// SAFETY: the file was written by the code under test; tests only
			// assert on string/boolean fields via toMatchObject.
			const config: FixturePayload = JSON.parse(await readFile(join(agentDir, "xl0-pi-lovely-web.json"), "utf8"));
			expect(config).toMatchObject({ webSearchProvider: "exa" });
			expect(notifications).toContainEqual(expect.objectContaining({ message: expect.stringContaining("Lovely Web config saved"), level: "info" }));
		} finally {
			process.chdir(originalCwd);
			if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
			if (originalConfigDir === undefined) delete process.env.SUMOCODE_CONFIG_DIR;
			else process.env.SUMOCODE_CONFIG_DIR = originalConfigDir;
			rmSync(cwd, { recursive: true, force: true });
			rmSync(agentDir, { recursive: true, force: true });
			rmSync(configDir, { recursive: true, force: true });
		}
	});

	it("masks Lovely Web API keys while entering and saving them", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "sumocode-lovely-web-secret-test-"));
		const agentDir = mkdtempSync(join(tmpdir(), "sumocode-lovely-web-secret-agent-test-"));
		const configDir = mkdtempSync(join(tmpdir(), "sumocode-lovely-web-secret-private-test-"));
		mkdirSync(join(configDir, ".git"));
		const originalCwd = process.cwd();
		const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
		const originalConfigDir = process.env.SUMOCODE_CONFIG_DIR;
		try {
			process.chdir(cwd);
			process.env.PI_CODING_AGENT_DIR = agentDir;
			process.env.SUMOCODE_CONFIG_DIR = configDir;
			const { actions, inlineSelectors, modals } = setup();

			const lovelyWeb = actions.handleSubmittedText("/lovely-web");
			await flush();
			inlineSelectors.handleInput(SELECTOR_ENTER); // user config
			await flush();
			for (let index = 0; index < 9; index += 1) inlineSelectors.handleInput(SELECTOR_DOWN);
			inlineSelectors.handleInput(SELECTOR_ENTER); // firecrawl API key
			await flush();
			expect(modals.isSecretInputActive()).toBe(true);

			modals.handleInput("fc-secret-key");
			expect(modals.render(80).join("\n")).not.toContain("fc-secret-key");
			modals.handleInput(SELECTOR_ENTER);
			await flush();
			inlineSelectors.handleInput(SELECTOR_ESCAPE);
			await lovelyWeb;

			// SAFETY: the file was written by the code under test; tests only
			// assert on string/boolean fields via toMatchObject.
			const config: FixturePayload = JSON.parse(await readFile(join(agentDir, "xl0-pi-lovely-web.json"), "utf8"));
			expect(config.firecrawlApiKey).toBe("fc-secret-key");
		} finally {
			process.chdir(originalCwd);
			if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
			if (originalConfigDir === undefined) delete process.env.SUMOCODE_CONFIG_DIR;
			else process.env.SUMOCODE_CONFIG_DIR = originalConfigDir;
			rmSync(cwd, { recursive: true, force: true });
			rmSync(agentDir, { recursive: true, force: true });
			rmSync(configDir, { recursive: true, force: true });
		}
	});

	it("keeps API keys out of raw JSON editors and workspace actions", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "sumocode-lovely-web-raw-test-"));
		const agentDir = mkdtempSync(join(tmpdir(), "sumocode-lovely-web-raw-agent-test-"));
		const configDir = mkdtempSync(join(tmpdir(), "sumocode-lovely-web-raw-private-test-"));
		mkdirSync(join(configDir, ".git"));
		const originalCwd = process.cwd();
		const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
		const originalConfigDir = process.env.SUMOCODE_CONFIG_DIR;
		try {
			process.chdir(cwd);
			process.env.PI_CODING_AGENT_DIR = agentDir;
			process.env.SUMOCODE_CONFIG_DIR = configDir;
			writeLovelyWebPatch("user", cwd, { firecrawlApiKey: "must-stay-secret", webSearchProvider: "exa" });
			const { actions, inlineSelectors, modals } = setup();

			const rawUser = actions.handleSubmittedText("/lovely-web");
			await flush();
			inlineSelectors.handleInput(SELECTOR_DOWN);
			inlineSelectors.handleInput(SELECTOR_DOWN);
			inlineSelectors.handleInput(SELECTOR_ENTER); // raw user JSON
			await flush();
			const rawText = modals.render(100).join("\n");
			expect(rawText).toContain("webSearchProvider");
			expect(rawText).not.toContain("must-stay-secret");
			expect(rawText).not.toContain("firecrawlApiKey");
			const initialRaw = `${JSON.stringify({ webSearchProvider: "exa" }, null, 2)}\n`;
			for (let index = 0; index < initialRaw.length; index += 1) modals.handleInput("backspace");
			modals.handleInput(JSON.stringify({ webSearchProvider: "tavily", exaApiKey: "must-not-save", webApiKeys: { brave: "also-must-not-save" } }));
			modals.handleInput(SELECTOR_ENTER);
			await rawUser;
			// SAFETY: same written-by-test contract as above.
			const saved: FixturePayload = JSON.parse(await readFile(join(agentDir, "xl0-pi-lovely-web.json"), "utf8"));
			expect(saved).toMatchObject({ webSearchProvider: "tavily", firecrawlApiKey: "must-stay-secret" });
			expect(saved.exaApiKey).toBeUndefined();
			expect(saved.braveApiKey).toBeUndefined();
			expect(saved.webApiKeys).toBeUndefined();

			const workspace = actions.handleSubmittedText("/lovely-web");
			await flush();
			inlineSelectors.handleInput(SELECTOR_DOWN);
			inlineSelectors.handleInput(SELECTOR_ENTER); // workspace config
			await flush();
			const workspaceText = inlineSelectors.render(100).join("\n");
			expect(workspaceText).not.toContain("API key");
			inlineSelectors.handleInput(SELECTOR_ESCAPE);
			await workspace;
		} finally {
			process.chdir(originalCwd);
			if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
			if (originalConfigDir === undefined) delete process.env.SUMOCODE_CONFIG_DIR;
			else process.env.SUMOCODE_CONFIG_DIR = originalConfigDir;
			rmSync(cwd, { recursive: true, force: true });
			rmSync(agentDir, { recursive: true, force: true });
			rmSync(configDir, { recursive: true, force: true });
		}
	});

	it("handles session controls through in-place selectors and editor text handoff", async () => {
		const { actions, controls, inlineSelectors, editorText, rehydrateCalls } = setup();

		const session = actions.handleSubmittedText("/sessions");
		await flush();
		// Top-level "Session controls" list renders in place (plan 036).
		expect(inlineSelectors.getActiveKind()).toBe("select");
		inlineSelectors.handleInput(SELECTOR_DOWN);
		inlineSelectors.handleInput(SELECTOR_DOWN);
		inlineSelectors.handleInput(SELECTOR_ENTER);
		await flush();

		// "Fork from message" -> openForkSelector, also in place.
		expect(inlineSelectors.getActiveKind()).toBe("select");
		inlineSelectors.handleInput(SELECTOR_ENTER);
		await session;

		expect(controls.calls).toEqual([
			"getForkMessages",
			"fork:entry-1",
			"refreshState",
		]);
		expect(editorText.getText()).toBe("fork from here");
		expect(rehydrateCalls).toHaveLength(1);
	});

	it("rehydrates the transcript exactly once after /new, /clone, switch, and a successful fork", async () => {
		const { actions, controls, modals, inlineSelectors, rehydrateCalls } = setup();

		await expect(actions.handleSubmittedText("/new")).resolves.toBe(true);
		expect(rehydrateCalls).toHaveLength(1);

		await expect(actions.handleSubmittedText("/clone")).resolves.toBe(true);
		expect(rehydrateCalls).toHaveLength(2);

		const switchPromise = actions.handleSubmittedText("/sessions");
		await flush();
		inlineSelectors.handleInput(SELECTOR_DOWN); // Switch session by path
		inlineSelectors.handleInput(SELECTOR_ENTER);
		await flush();
		modals.handleInput("/tmp/other-session.jsonl"); // modals.input -- blocking prompt, unchanged
		modals.handleInput(Key.enter);
		await switchPromise;
		expect(controls.calls).toContain("switchSession:/tmp/other-session.jsonl");
		expect(rehydrateCalls).toHaveLength(3);

		const forkPromise = actions.handleSubmittedText("/fork");
		await flush();
		inlineSelectors.handleInput(SELECTOR_ENTER);
		await forkPromise;
		expect(rehydrateCalls).toHaveLength(4);
	});

	it("rehydrates the unchanged session after a session operation is cancelled", async () => {
		const { actions, controls, modals, inlineSelectors, rehydrateCalls } = setup();
		controls.newSessionCancelled = true;
		controls.cloneCancelled = true;
		controls.switchSessionCancelled = true;
		controls.forkCancelled = true;

		await expect(actions.handleSubmittedText("/new")).resolves.toBe(true);
		await expect(actions.handleSubmittedText("/clone")).resolves.toBe(true);

		const switchPromise = actions.handleSubmittedText("/sessions");
		await flush();
		inlineSelectors.handleInput(SELECTOR_DOWN);
		inlineSelectors.handleInput(SELECTOR_ENTER);
		await flush();
		modals.handleInput("/tmp/other-session.jsonl");
		modals.handleInput(Key.enter);
		await switchPromise;

		const forkPromise = actions.handleSubmittedText("/fork");
		await flush();
		inlineSelectors.handleInput(SELECTOR_ENTER);
		await forkPromise;

		expect(rehydrateCalls).toHaveLength(4);
	});

	it("does not rehydrate the transcript when the fork selector is dismissed without a selection", async () => {
		const { actions, inlineSelectors, rehydrateCalls } = setup();

		const forkPromise = actions.handleSubmittedText("/fork");
		await flush();
		inlineSelectors.handleInput(SELECTOR_ESCAPE);
		await forkPromise;

		expect(rehydrateCalls).toHaveLength(0);
	});

	it("forks from the selected entry id when fork message summaries collide, preselecting the latest", async () => {
		const { actions, controls, inlineSelectors, editorText, rehydrateCalls } = setup();
		controls.forkMessages = [
			{ entryId: "entry-a", text: "same visible fork summary" },
			{ entryId: "entry-b", text: "same visible fork summary" },
		];

		const forkPromise = actions.handleSubmittedText("/fork");
		await flush();
		expect(inlineSelectors.getActiveKind()).toBe("select");
		// pi parity: the LATEST user message is preselected — Enter forks it
		// directly, and colliding labels still resolve by entryId, not text.
		inlineSelectors.handleInput(SELECTOR_ENTER);
		await forkPromise;

		expect(controls.calls).toEqual(["getForkMessages", "fork:entry-b", "refreshState"]);
		expect(editorText.getText()).toBe("fork from here");
		expect(rehydrateCalls).toHaveLength(1);
	});

	it("filters bg-task wake messages out of the fork list and normalizes labels", async () => {
		const { actions, controls, inlineSelectors, rehydrateCalls } = setup();
		controls.forkMessages = [
			{ entryId: "entry-real", text: 'check "/tmp/pi-clipboard-9f.png"\nand this\nmultiline prompt' },
			{ entryId: "entry-wake", text: "background task bg-abc123 failed: smoke tests (cmux surface:41)" },
		];

		const forkPromise = actions.handleSubmittedText("/fork");
		await flush();
		expect(inlineSelectors.getActiveKind()).toBe("select");
		const rendered = inlineSelectors.render(100).join("\n");
		// Synthetic orchestrator wake messages are not forkable nodes.
		expect(rendered).not.toContain("background task bg-abc123");
		// Labels are single-line with a role glyph and image paths collapsed,
		// plus a #N index identifier.
		expect(rendered).toContain("▷ check [Image: pi-clipboard-9f.png] and this multiline prompt");
		expect(rendered).toContain("#1");

		inlineSelectors.handleInput(SELECTOR_ENTER);
		await forkPromise;
		expect(controls.calls).toEqual(["getForkMessages", "fork:entry-real", "refreshState"]);
		expect(rehydrateCalls).toHaveLength(1);
	});

	describe("/resume", () => {
		function jsonl(lines: readonly unknown[]): string {
			return `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
		}

		function writeFixtureSession(dir: string, fileName: string, id: string, timestamp: string, firstMessage: string): string {
			const path = join(dir, fileName);
			writeFileSync(path, jsonl([
				{ type: "session", version: 3, id, timestamp, cwd: "/repo" },
				{
					type: "message",
					id: "e1",
					parentId: null,
					timestamp,
					message: { role: "user", content: firstMessage, timestamp: new Date(timestamp).getTime() },
				},
			]));
			return path;
		}

		function writeLargeFixtureSession(dir: string, fileName: string, id: string, timestamp: string, firstMessage: string): string {
			const path = join(dir, fileName);
			const prefix = jsonl([
				{ type: "session", version: 3, id, timestamp, cwd: "/repo" },
				{
					type: "message",
					id: "e1",
					parentId: null,
					timestamp,
					message: { role: "user", content: firstMessage, timestamp: new Date(timestamp).getTime() },
				},
			]);
			const hiddenMessage = JSON.stringify({
				type: "message",
				id: "e2",
				parentId: "e1",
				timestamp,
				message: { role: "assistant", content: "x".repeat(300 * 1024), timestamp: new Date(timestamp).getTime() },
			});
			writeFileSync(path, `${prefix}${hiddenMessage}\n`);
			return path;
		}

		it("lists fixture sessions from the current session's directory and loads the chosen path", async () => {
			const dir = mkdtempSync(join(tmpdir(), "sumocode-resume-test-"));
			try {
				const currentFile = writeFixtureSession(dir, "2026-07-02T20-00-00-000Z_current.jsonl", "current", "2026-07-02T20:00:00.000Z", "current session first message");
				const olderPath = writeFixtureSession(dir, "2026-07-02T19-00-00-000Z_older.jsonl", "older", "2026-07-02T19:00:00.000Z", "older session first message");

				const { actions, controls, inlineSelectors, rehydrateCalls } = setup({ sessionFile: currentFile });

				const resumePromise = actions.handleSubmittedText("/resume");
				await flushIO();
				expect(inlineSelectors.getActiveKind()).toBe("select");
				inlineSelectors.handleInput(SELECTOR_DOWN); // move to the older session
				inlineSelectors.handleInput(SELECTOR_ENTER);
				await resumePromise;

				expect(controls.calls).toContain(`switchSession:${olderPath}`);
				expect(controls.calls).toContain("refreshState");
				expect(rehydrateCalls).toHaveLength(1);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});

		it("marks truncated session counts as floors in resume labels", async () => {
			const dir = mkdtempSync(join(tmpdir(), "sumocode-resume-truncated-label-test-"));
			try {
				const sessionFile = writeLargeFixtureSession(dir, "2026-07-02T20-00-00-000Z_large.jsonl", "large", "2026-07-02T20:00:00.000Z", "large session first message");
				const { actions, inlineSelectors } = setup({ sessionFile });

				const resumePromise = actions.handleSubmittedText("/resume");
				await flushIO();
				expect(inlineSelectors.getActiveKind()).toBe("select");
				const rendered = inlineSelectors.render(120).join("\n").replace(/\u001b\[[0-9;]*m/g, "");
				// Identifier block: short id · floor-marked count · relative age.
				expect(rendered).toContain("1+ msgs");
				expect(rendered).toContain("large ·");
				inlineSelectors.handleInput(SELECTOR_ESCAPE);
				await resumePromise;
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});

		it("loads the selected path when session labels collide", async () => {
			const dir = mkdtempSync(join(tmpdir(), "sumocode-resume-collision-test-"));
			try {
				const newerPath = writeFixtureSession(dir, "2026-07-02T20-00-30-000Z_newer.jsonl", "newer", "2026-07-02T20:00:30.000Z", "same visible title");
				const olderPath = writeFixtureSession(dir, "2026-07-02T20-00-10-000Z_older.jsonl", "older", "2026-07-02T20:00:10.000Z", "same visible title");
				const { actions, controls, inlineSelectors, rehydrateCalls } = setup({ sessionFile: newerPath });

				const resumePromise = actions.handleSubmittedText("/resume");
				await flushIO();
				expect(inlineSelectors.getActiveKind()).toBe("select");
				inlineSelectors.handleInput(SELECTOR_DOWN);
				inlineSelectors.handleInput(SELECTOR_ENTER);
				await resumePromise;

				// Both visible labels are identical; the old labels.indexOf(selected)
				// path switched to the first row even after selecting the second.
				expect(controls.calls).toContain(`switchSession:${olderPath}`);
				expect(controls.calls).not.toContain(`switchSession:${newerPath}`);
				expect(rehydrateCalls).toHaveLength(1);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});

		it("warns when there is no session file to resume from", async () => {
			const { actions, notifications } = setup();

			await expect(actions.handleSubmittedText("/resume")).resolves.toBe(true);

			expect(notifications).toContainEqual({ message: "no session file available to resume from", level: "warning" });
		});

		it("warns when the session directory has no sessions", async () => {
			const dir = mkdtempSync(join(tmpdir(), "sumocode-resume-empty-test-"));
			try {
				const { actions, notifications } = setup({ sessionFile: join(dir, "2026-07-02T20-00-00-000Z_missing.jsonl") });

				await expect(actions.handleSubmittedText("/resume")).resolves.toBe(true);

				expect(notifications).toContainEqual({ message: "no sessions found", level: "warning" });
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});
	});

	describe("/tree", () => {
		function jsonl(lines: readonly unknown[]): string {
			return `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
		}

		function writeBranchedFixture(dir: string): string {
			const path = join(dir, "2026-07-02T22-00-00-000Z_branched.jsonl");
			writeFileSync(path, jsonl([
				{ type: "session", version: 3, id: "branched", timestamp: "2026-07-02T22:00:00.000Z", cwd: "/repo" },
				{ type: "message", id: "root", parentId: null, timestamp: "2026-07-02T22:00:01.000Z", message: { role: "user", content: "root message" } },
				{ type: "message", id: "child-a", parentId: "root", timestamp: "2026-07-02T22:00:02.000Z", message: { role: "assistant", content: "first branch reply" } },
				{ type: "message", id: "child-b", parentId: "root", timestamp: "2026-07-02T22:00:03.000Z", message: { role: "assistant", content: "second branch reply" } },
			]));
			return path;
		}

		it("builds a navigable, indented tree and navigates from the chosen node", async () => {
			const dir = mkdtempSync(join(tmpdir(), "sumocode-tree-test-"));
			try {
				const sessionFile = writeBranchedFixture(dir);
				const { actions, controls, inlineSelectors, editorText, rehydrateCalls } = setup({ sessionFile });

				const treePromise = actions.handleSubmittedText("/tree");
				await flushIO();
				expect(inlineSelectors.getActiveKind()).toBe("select");

				// Latest node (child-b) is preselected — Enter opens Pi's summary choice.
				inlineSelectors.handleInput(SELECTOR_ENTER);
				await flushIO();
				expect(inlineSelectors.getActiveKind()).toBe("select");
				inlineSelectors.handleInput(SELECTOR_ENTER);
				await treePromise;

				expect(controls.calls).toEqual(["getEntries:", "navigateTree:child-b:false:"]);
				expect(editorText.getText()).toBe("");
				expect(rehydrateCalls).toHaveLength(0);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});

		it("hides bookkeeping entries, tool results, textless assistant turns, and wake messages; keeps structural depth flat on linear chains", async () => {
			const dir = mkdtempSync(join(tmpdir(), "sumocode-tree-filter-test-"));
			try {
				const sessionFile = join(dir, "2026-07-02T23-00-00-000Z_noisy.jsonl");
				writeFileSync(sessionFile, jsonl([
					{ type: "session", version: 3, id: "noisy", timestamp: "2026-07-02T23:00:00.000Z", cwd: "/repo" },
					{ type: "message", id: "u1", parentId: null, timestamp: "2026-07-02T23:00:01.000Z", message: { role: "user", content: "real prompt\nwith newline" } },
					{ type: "message", id: "a1", parentId: "u1", timestamp: "2026-07-02T23:00:02.000Z", message: { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "bash" }] } },
					{ type: "message", id: "tr1", parentId: "a1", timestamp: "2026-07-02T23:00:03.000Z", message: { role: "toolResult", content: [{ type: "text", text: "tool output noise" }] } },
					{ type: "model_change", id: "mc1", parentId: "tr1", timestamp: "2026-07-02T23:00:04.000Z" },
					{ type: "message", id: "a2", parentId: "mc1", timestamp: "2026-07-02T23:00:05.000Z", message: { role: "assistant", content: [{ type: "text", text: "assistant reply" }] } },
					{ type: "message", id: "wake", parentId: "a2", timestamp: "2026-07-02T23:00:06.000Z", message: { role: "user", content: "background task bg-x1 completed: smoke" } },
				]));
				const { actions, inlineSelectors } = setup({ sessionFile });

				const treePromise = actions.handleSubmittedText("/tree");
				await flushIO();
				const rendered = inlineSelectors.render(120).join("\n").replace(/\u001b\[[0-9;]*m/g, "");

				expect(rendered).toContain("▷ real prompt with newline");
				expect(rendered).toContain("✦ assistant reply");
				expect(rendered).not.toContain("tool output noise");
				expect(rendered).not.toContain("model_change");
				expect(rendered).not.toContain("background task bg-x1");
				// Linear chain: no runaway indentation — both visible rows start at
				// the SAME column (no connectors on a session with no forks).
				const lines = rendered.split("\n");
				const userCol = lines.find((line) => line.includes("▷ real prompt"))!.indexOf("▷ real prompt");
				const assistantCol = lines.find((line) => line.includes("✦ assistant reply"))!.indexOf("✦ assistant reply");
				expect(userCol).toBe(assistantCol);
				expect(rendered).not.toContain("├─");
				expect(rendered).not.toContain("└─");

				inlineSelectors.handleInput(SELECTOR_ESCAPE);
				await treePromise;
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});

		it("navigates by selected entry id when tree summaries collide", async () => {
			const dir = mkdtempSync(join(tmpdir(), "sumocode-tree-collision-test-"));
			try {
				const sessionFile = join(dir, "2026-07-02T22-05-00-000Z_colliding-tree.jsonl");
				writeFileSync(sessionFile, jsonl([
					{ type: "session", version: 3, id: "colliding-tree", timestamp: "2026-07-02T22:05:00.000Z", cwd: "/repo" },
					{ type: "message", id: "root", parentId: null, timestamp: "2026-07-02T22:05:01.000Z", message: { role: "user", content: "root message" } },
					{ type: "message", id: "child-a", parentId: "root", timestamp: "2026-07-02T22:05:02.000Z", message: { role: "assistant", content: "same branch summary" } },
					{ type: "message", id: "child-b", parentId: "root", timestamp: "2026-07-02T22:05:03.000Z", message: { role: "assistant", content: "same branch summary" } },
				]));
				const { actions, controls, inlineSelectors } = setup({ sessionFile });

				const treePromise = actions.handleSubmittedText("/tree");
				await flushIO();
				expect(inlineSelectors.getActiveKind()).toBe("select");
				// Preselected on child-b (latest) — Enter must navigate by entryId even
				// though child-a renders the identical summary text.
				inlineSelectors.handleInput(SELECTOR_ENTER);
				await flushIO();
				inlineSelectors.handleInput(SELECTOR_ENTER);
				await treePromise;

				expect(controls.calls).toEqual(["getEntries:", "navigateTree:child-b:false:"]);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});

		it("renders the navigation title and indents branch children", async () => {
			const dir = mkdtempSync(join(tmpdir(), "sumocode-tree-label-test-"));
			try {
				const sessionFile = writeBranchedFixture(dir);
				const { actions, inlineSelectors } = setup({ sessionFile });

				const treePromise = actions.handleSubmittedText("/tree");
				await flushIO();
				const rendered = inlineSelectors.render(100).join("\n").replace(/\[[0-9;]*m/g, "");
				expect(rendered).toContain("SESSION TREE");
				// root has two children — each branch head gets a box-drawing
				// connector: first branch ├─, last branch └─.
				expect(rendered).toContain("├─ ✦ first branch reply");
				expect(rendered).toContain("└─ ✦ second branch reply");
				const lines = rendered.split("\n");
				const rootCol = lines.find((line) => line.includes("▷ root message"))!.indexOf("▷ root message");
				const branchCol = lines.find((line) => line.includes("├─ ✦ first branch reply"))!.indexOf("├─");
				expect(branchCol).toBe(rootCol);

				inlineSelectors.handleInput(SELECTOR_ESCAPE);
				await treePromise;
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});

		it.each([
			["no summary", 0, false, undefined],
			["default summary", 1, true, undefined],
			["custom summary", 2, true, "retain the API decisions\nand list open risks"],
		] as const)("forwards %s navigation choices without forking", async (_name, choiceIndex, summarize, customInstructions) => {
			const dir = mkdtempSync(join(tmpdir(), "sumocode-tree-choice-test-"));
			try {
				const sessionFile = writeBranchedFixture(dir);
				const { actions, controls, inlineSelectors, modals } = setup({ sessionFile });
				const treePromise = actions.handleSubmittedText("/tree");
				await flushIO();
				inlineSelectors.handleInput(SELECTOR_ENTER);
				await flushIO();
				for (let index = 0; index < choiceIndex; index += 1) inlineSelectors.handleInput(SELECTOR_DOWN);
				inlineSelectors.handleInput(SELECTOR_ENTER);
				if (customInstructions !== undefined) {
					await flush();
					modals.handleInput(customInstructions);
					modals.handleInput(Key.enter);
				}
				await treePromise;
				const request = controls.treeRequests[0];
				const expected: FixturePayload = { targetId: "child-b", summarize };
				if (customInstructions !== undefined) expected["customInstructions"] = customInstructions;
				expect(request).toMatchObject(expected);
				expect(controls.calls.some((call) => call.startsWith("fork:"))).toBe(false);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});

		it("treats the authoritative current leaf as a no-op", async () => {
			const dir = mkdtempSync(join(tmpdir(), "sumocode-tree-current-test-"));
		try {
				const sessionFile = writeBranchedFixture(dir);
				const { actions, controls, inlineSelectors, notifications } = setup({ sessionFile });
				controls.leafId = "child-b";
				const treePromise = actions.handleSubmittedText("/tree");
				await flushIO();
				inlineSelectors.handleInput(SELECTOR_ENTER);
				await treePromise;
				expect(controls.treeRequests).toHaveLength(0);
				expect(notifications).toContainEqual({ message: "already at this point", level: "info" });
		} finally {
				rmSync(dir, { recursive: true, force: true });
		}
		});

		it("returns from the summary selector to the same tree selection", async () => {
			const dir = mkdtempSync(join(tmpdir(), "sumocode-tree-cancel-test-"));
		try {
				const sessionFile = writeBranchedFixture(dir);
				const { actions, controls, inlineSelectors } = setup({ sessionFile });
				const treePromise = actions.handleSubmittedText("/tree");
				await flushIO();
				inlineSelectors.handleInput(SELECTOR_ENTER);
				await flush();
				inlineSelectors.handleInput(SELECTOR_ESCAPE);
				await flushIO();
				expect(inlineSelectors.getActiveKind()).toBe("select");
				expect(inlineSelectors.render(120).join("\n")).toContain("second branch reply");
				inlineSelectors.handleInput(SELECTOR_ESCAPE);
				await treePromise;
				expect(controls.treeRequests).toHaveLength(0);
		} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});

		it("returns from the custom editor to the summary selector, not the tree", async () => {
			const dir = mkdtempSync(join(tmpdir(), "sumocode-tree-custom-cancel-test-"));
		try {
				const sessionFile = writeBranchedFixture(dir);
				const { actions, controls, inlineSelectors, modals } = setup({ sessionFile });
				const treePromise = actions.handleSubmittedText("/tree");
				await flushIO();
				inlineSelectors.handleInput(SELECTOR_ENTER);
				await flush();
				inlineSelectors.handleInput(SELECTOR_DOWN);
				inlineSelectors.handleInput(SELECTOR_DOWN);
				inlineSelectors.handleInput(SELECTOR_ENTER);
				await flush();
				expect(modals.getActiveKind()).toBe("editor");
				modals.handleInput(SELECTOR_ESCAPE);
				await flush();
				expect(modals.getActiveKind()).toBeUndefined();
				expect(inlineSelectors.getActiveKind()).toBe("select");
				inlineSelectors.handleInput(SELECTOR_ESCAPE);
				await flushIO();
				inlineSelectors.handleInput(SELECTOR_ESCAPE);
				await treePromise;
				expect(controls.treeRequests).toHaveLength(0);
		} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});

		it("rehydrates once through the in-place lifecycle and preserves callback order", async () => {
			const dir = mkdtempSync(join(tmpdir(), "sumocode-tree-lifecycle-test-"));
		try {
				const sessionFile = writeBranchedFixture(dir);
				const order: string[] = [];
				const { actions, controls, inlineSelectors, rehydrateCalls } = setup({
					sessionFile,
					beforeTreeNavigation: async () => { order.push("before"); },
					reconcileTreeNavigation: async (outcome) => { order.push(`reconcile:${outcome?.status ?? "unknown"}`); },
					setTreeNavigationBusy: (busy) => { order.push(`busy:${String(busy)}`); },
				});
				const treePromise = actions.handleSubmittedText("/tree");
				await flushIO();
				inlineSelectors.handleInput(SELECTOR_ENTER);
				await flush();
				inlineSelectors.handleInput(SELECTOR_ENTER);
				await treePromise;
				expect(order).toEqual(["busy:true", "before", "reconcile:committed", "busy:false"]);
				expect(rehydrateCalls).toHaveLength(0);
				expect(controls.calls.some((call) => call.startsWith("fork:"))).toBe(false);
		} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});

		it("releases the busy guard after an ambiguous navigation recovery without an unhandled rejection", async () => {
			const dir = mkdtempSync(join(tmpdir(), "sumocode-tree-recovery-release-test-"));
			const transitions: boolean[] = [];
			let capture = true;
			let busy = false;
			const unhandled: unknown[] = [];
			const onUnhandled = (cause: unknown): void => { unhandled.push(cause); };
			process.on("unhandledRejection", onUnhandled);
			try {
				const sessionFile = writeBranchedFixture(dir);
				const { actions, controls, inlineSelectors } = setup({
					sessionFile,
					beforeTreeNavigation: async () => undefined,
					reconcileTreeNavigation: async () => {
						// Represents the host's fail-closed replacement completion: the
						// capture is released before the action's finally clears busy.
						capture = false;
					},
					setTreeNavigationBusy: (next) => {
						if (!next && capture) return;
						busy = next;
						transitions.push(next);
					},
				});
				controls.treeNavigationError = new Error("ambiguous tree command timeout");
				const treePromise = actions.handleSubmittedText("/tree");
				await flushIO();
				inlineSelectors.handleInput(SELECTOR_ENTER);
				await flush();
				inlineSelectors.handleInput(SELECTOR_ENTER);
				await expect(treePromise).rejects.toThrow("ambiguous tree command timeout");
				await flush();

				expect(transitions).toEqual([true, false]);
				expect(capture).toBe(false);
				expect(busy).toBe(false);
				expect(unhandled).toEqual([]);
			} finally {
				process.off("unhandledRejection", onUnhandled);
				rmSync(dir, { recursive: true, force: true });
			}
		});

		it("opens a 6,001-entry tree and fork selector without recursive traversal", async () => {
			const dir = mkdtempSync(join(tmpdir(), "sumocode-tree-long-test-"));
			try {
				const sessionFile = join(dir, "2026-07-02T23-30-00-000Z_long.jsonl");
				const entries = Array.from({ length: 6_001 }, (_, index) => ({
					type: "message",
					id: `long-${index}`,
					parentId: index === 0 ? null : `long-${index - 1}`,
					timestamp: `2026-07-02T23:30:${String(index % 60).padStart(2, "0")}.000Z`,
					message: { role: "user", content: `long prompt ${index}` },
				}));
				writeFileSync(sessionFile, jsonl([{ type: "session", version: 3, id: "session-1", timestamp: "2026-07-02T23:30:00.000Z", cwd: "/repo" }, ...entries]));
				const { actions, controls, inlineSelectors } = setup({ sessionFile });
				controls.leafId = "long-6000";
				const treePromise = actions.handleSubmittedText("/tree");
				await new Promise<void>((resolve) => setTimeout(resolve, 100));
				expect(inlineSelectors.render(120).join("\n")).toContain("long prompt 6000");
				inlineSelectors.handleInput(SELECTOR_ESCAPE);
				await treePromise;

				controls.forkMessages = entries.map((entry) => ({ entryId: entry.id, text: entry.message.content }));
				const forkPromise = actions.handleSubmittedText("/fork");
				await new Promise<void>((resolve) => setTimeout(resolve, 100));
				expect(inlineSelectors.render(120).join("\n")).toContain("long prompt 6000");
				inlineSelectors.handleInput(SELECTOR_ENTER);
				await forkPromise;
				expect(controls.calls).toContain("fork:long-6000");
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});

		it("keeps tree diagnostics structural and free of synthetic message or custom text", async () => {
			const diagFile = join(tmpdir(), "sumocode-tree-diagnostics-privacy.jsonl");
			const previousDiagFile = process.env.SUMO_TUI_DIAG_FILE;
			process.env.SUMO_TUI_DIAG_FILE = diagFile;
			try {
				const dir = mkdtempSync(join(tmpdir(), "sumocode-tree-diagnostics-test-"));
				try {
					const sessionFile = writeBranchedFixture(dir);
					const { actions, inlineSelectors } = setup({ sessionFile });
					const treePromise = actions.handleSubmittedText("/tree");
					await flushIO();
					inlineSelectors.handleInput(SELECTOR_ESCAPE);
					await treePromise;
					const diagnostics = await readFile(diagFile, "utf8");
					expect(diagnostics).toContain("tree.selector_loaded");
					expect(diagnostics).not.toContain("root message");
					expect(diagnostics).not.toContain("retain the API decisions");
				} finally {
					rmSync(dir, { recursive: true, force: true });
				}
			} finally {
				if (previousDiagFile === undefined) delete process.env.SUMO_TUI_DIAG_FILE;
				else process.env.SUMO_TUI_DIAG_FILE = previousDiagFile;
				rmSync(diagFile, { force: true });
			}
		});

		it("blocks concurrent session mutations while keeping ordinary host commands available", async () => {
			let busy = true;
			const { actions, controls, notifications } = setup({ isTreeNavigationBusy: () => busy });
			await expect(actions.handleSubmittedText("/fork")).resolves.toBe(true);
			await expect(actions.handleSubmittedText("/tree")).resolves.toBe(true);
			await expect(actions.handleSubmittedText("/new")).resolves.toBe(true);
			expect(controls.calls).toEqual([]);
			expect(notifications.filter((entry) => entry.message === "branch summary in progress")).toHaveLength(3);
			busy = false;
			await expect(actions.handleSubmittedText("/copy")).resolves.toBe(true);
			expect(controls.calls).toContain("getLastAssistantText");
		});

		it("warns when there is no session file to browse", async () => {
			const { actions, notifications } = setup();

			await expect(actions.handleSubmittedText("/tree")).resolves.toBe(true);

			expect(notifications).toContainEqual({ message: "session has no entries yet", level: "warning" });
		});

		it("warns instead of rejecting when the session file cannot be read", async () => {
			const dir = mkdtempSync(join(tmpdir(), "sumocode-tree-missing-test-"));
			try {
				const { actions, controls, notifications } = setup({ sessionFile: join(dir, "missing.jsonl") });

				await expect(actions.handleSubmittedText("/tree")).resolves.toBe(true);

				expect(notifications).toContainEqual({ message: "session has no entries yet", level: "warning" });
				expect(controls.calls.some((call) => call.startsWith("navigateTree:"))).toBe(false);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});
	});

	it("renders the full /session stats payload as a multi-line panel, not a one-line toast", async () => {
		const { actions, controls, overlays } = setup();

		const session = actions.handleSubmittedText("/session");
		await flush();
		expect(controls.calls).toContain("getSessionStats");
		expect(overlays.getActiveKind()).toBe("session");
		const rendered = renderOverlayText(overlays);
		expect(rendered).toContain("SESSION");
		expect(rendered).toContain("MESSAGES");
		expect(rendered).toContain("TOKENS");
		expect(rendered).toContain("COST");
		expect(rendered).toContain("session-1");
		overlays.handleInput("x");
		await session;
		expect(overlays.getActiveKind()).toBeUndefined();
	});

	it("handles /name rename as a host command", async () => {
		const { actions, controls, modals, notifications, stateChanges } = setup();

		const rename = actions.handleSubmittedText("/name");
		await flush();
		expect(modals.getActiveKind()).toBe("input");
		modals.handleInput("Plan 023");
		modals.handleInput(Key.enter);
		await rename;

		expect(controls.calls).toEqual(["setSessionName:Plan 023"]);
		expect(stateChanges).toEqual([{ sessionName: "Plan 023" }]);
		expect(notifications).toContainEqual({ message: "session name: Plan 023", level: "info" });
	});

	it("copies the last assistant response via OSC52 and shows a terse toast", async () => {
		const sequences: string[] = [];
		const { actions, controls, notifications } = setup({
			writeClipboardSequence: (sequence) => {
				sequences.push(sequence);
				return true;
			},
		});
		controls.lastAssistantText = "here is the answer";

		await expect(actions.handleSubmittedText("/copy")).resolves.toBe(true);

		expect(controls.calls).toContain("getLastAssistantText");
		expect(sequences).toHaveLength(1);
		expect(sequences[0]).toContain("\x1b]52;c;");
		expect(sequences[0]).toContain(Buffer.from("here is the answer", "utf8").toString("base64"));
		expect(notifications).toContainEqual({ message: "copied", level: "success" });
	});

	it("refuses to copy oversized assistant responses without sending a clipboard sequence", async () => {
		const sequences: string[] = [];
		const { actions, controls, notifications } = setup({
			writeClipboardSequence: (sequence) => {
				sequences.push(sequence);
				return true;
			},
		});
		controls.lastAssistantText = "x".repeat(MAX_CLIPBOARD_BYTES + 1);

		await expect(actions.handleSubmittedText("/copy")).resolves.toBe(true);

		expect(controls.calls).toContain("getLastAssistantText");
		expect(sequences).toHaveLength(0);
		expect(notifications).toContainEqual({ message: "response too large to copy", level: "warning" });
	});

	it("warns instead of copying when there is no assistant response yet", async () => {
		const sequences: string[] = [];
		const { actions, controls, notifications } = setup({
			writeClipboardSequence: (sequence) => {
				sequences.push(sequence);
				return true;
			},
		});
		controls.lastAssistantText = null;

		await expect(actions.handleSubmittedText("/copy")).resolves.toBe(true);

		expect(sequences).toHaveLength(0);
		expect(notifications).toContainEqual({ message: "no assistant response to copy", level: "warning" });
	});

	it("warns when the clipboard write is unavailable (non-TTY host)", async () => {
		const { actions, notifications } = setup({ writeClipboardSequence: () => false });

		await expect(actions.handleSubmittedText("/copy")).resolves.toBe(true);

		expect(notifications).toContainEqual({ message: "copy unavailable (not a TTY)", level: "warning" });
	});

	it("exports the session to HTML and notifies with the resulting path", async () => {
		const { actions, controls, notifications } = setup();
		controls.exportedPath = "/tmp/custom-export.html";

		await expect(actions.handleSubmittedText("/export")).resolves.toBe(true);

		expect(controls.calls).toContain("exportHtml");
		expect(notifications).toContainEqual({ message: "exported: /tmp/custom-export.html", level: "info" });
	});

	it("renders theme check and memory editor as host overlays", async () => {
		const { actions, overlays, memory } = setup();

		const themeCheck = actions.handleSubmittedText("/sumo:theme-check");
		await flush();
		expect(overlays.getActiveKind()).toBe("themeCheck");
		expect(renderOverlayText(overlays)).toContain("CATHEDRAL THEME CHECK");
		overlays.handleInput("x");
		await themeCheck;

		const memoryEditor = actions.handleSubmittedText("/sumo:memory");
		await flush();
		expect(overlays.getActiveKind()).toBe("memoryEditor");
		expect(renderOverlayText(overlays)).toContain("MEMORY SCRIPTORIUM");
		overlays.handleInput(Key.escape);
		await memoryEditor;
		expect(memory.calls).toContain("browse");
	});

	it("renders the RPC host's own hotkey reference as an overlay, closing on any key", async () => {
		const { actions, overlays } = setup();

		const hotkeys = actions.handleSubmittedText("/hotkeys");
		await flush();
		expect(overlays.getActiveKind()).toBe("hotkeys");
		const rendered = renderOverlayText(overlays);
		expect(rendered).toContain("SUMOCODE RPC HOST HOTKEYS");
		expect(rendered).toContain("Ctrl+/");
		expect(rendered).toContain("Cmd+Enter");
		expect(rendered).toContain("PageUp / PageDown");
		overlays.handleInput("x");
		await hotkeys;
		expect(overlays.getActiveKind()).toBeUndefined();
	});

	describe("/changelog", () => {
		it("reads CHANGELOG.md from the changelog root and renders it as an overlay", async () => {
			const dir = mkdtempSync(join(tmpdir(), "sumocode-changelog-test-"));
			try {
				writeFileSync(join(dir, "CHANGELOG.md"), "# Changelog\n\n## [0.9.0]\n- Added something great\n");
				const { actions, overlays } = setup({ changelogRoot: dir });

				const changelog = actions.handleSubmittedText("/changelog");
				await flush();
				expect(overlays.getActiveKind()).toBe("changelog");
				const rendered = renderOverlayText(overlays);
				expect(rendered).toContain("# Changelog");
				expect(rendered).toContain("Added something great");
				overlays.handleInput("x");
				await changelog;
				expect(overlays.getActiveKind()).toBeUndefined();
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});

		it("warns when CHANGELOG.md is missing from the changelog root", async () => {
			const dir = mkdtempSync(join(tmpdir(), "sumocode-changelog-missing-test-"));
			try {
				const { actions, notifications } = setup({ changelogRoot: dir });

				await expect(actions.handleSubmittedText("/changelog")).resolves.toBe(true);

				expect(notifications).toContainEqual({ message: "CHANGELOG.md not found", level: "warning" });
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});
	});

	it("persists theme changes and cycles themes host-side (Ctrl+Shift+T path)", async () => {
		const { actions, notifications, persistedThemes } = setup();

		// /sumo:theme <name> applies AND persists.
		await expect(actions.handleSubmittedText("/sumo:theme amber-crt")).resolves.toBe(true);
		expect(getActiveTheme().name).toBe("amber-crt");
		expect(persistedThemes).toEqual(["amber-crt"]);

		// cycleTheme (the host keybinding handler) advances the registry and
		// persists the new choice too.
		const before = getActiveTheme().name;
		actions.cycleTheme();
		const after = getActiveTheme().name;
		expect(after).not.toBe(before);
		expect(persistedThemes).toEqual(["amber-crt", after]);
		expect(notifications).toContainEqual({ message: `theme: ${after}`, level: "info" });
	});

	it("warns when theme persistence fails but still applies the theme", async () => {
		const { actions, notifications } = setup();
		// Simulate persistence failure: the own property below shadows the
		// prototype's host-private persistTheme without touching real disk state.
		Object.assign(actions, {
			persistTheme: () => ({ success: false, error: "disk full" }),
		});

		await expect(actions.handleSubmittedText("/sumo:theme amber-crt")).resolves.toBe(true);
		expect(getActiveTheme().name).toBe("amber-crt");
		expect(notifications).toContainEqual({ message: "theme: amber-crt (not persisted: disk full)", level: "warning" });
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

	it("opens /theme's picker through the in-place InlineSelectorHost, not modals.select", async () => {
		const { actions, modals, inlineSelectors, notifications } = setup();

		const themePromise = actions.handleSubmittedText("/theme");
		await flush();
		expect(inlineSelectors.getActiveKind()).toBe("select");
		expect(modals.getActiveKind()).toBeUndefined();
		inlineSelectors.handleInput(SELECTOR_DOWN); // cathedral -> amber-crt
		inlineSelectors.handleInput(SELECTOR_ENTER);
		await themePromise;

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

		await expect(actions.handleSubmittedText("/sumo:does-not-exist")).resolves.toBe(true);
		expect(controls.calls).toContain("getCommands");
		expect(notifications).toContainEqual({ message: "unknown command: /sumo:does-not-exist", level: "warning" });

		controls.commands = [
			rpcCommand("fast", "extension"),
			rpcCommand("deploy", "prompt"),
			rpcCommand("reload", "extension"),
		];
		await expect(actions.handleSubmittedText("/fast")).resolves.toBe(true);
		expect(controls.calls).toContain("executeExtensionCommand:/fast");

		await expect(actions.handleSubmittedText("/deploy prod")).resolves.toBe(false);
		await expect(actions.handleSubmittedText("/reload")).resolves.toBe(true);
		expect(controls.calls).toContain("executeExtensionCommand:/reload");
		expect(notifications).not.toContainEqual({ message: "unknown command: /reload", level: "warning" });
	});

	it("opens retained MCP controls instead of forwarding bare custom-UI commands", async () => {
		const { actions, controls, modals } = setup();
		controls.commands = [rpcCommand("mcp"), rpcCommand("mcp-auth")];

		expect(isRpcHostSlashCommandName("mcp")).toBe(false);
		expect(isRpcHostSlashCommandName("mcp-auth")).toBe(false);

		const mcp = actions.handleSubmittedText("/mcp");
		await flush();
		expect(modals.getActiveKind()).toBe("select");
		expect(modals.render(80).join("\n")).toContain("MCP controls");
		modals.handleInput("down");
		modals.handleInput("enter");
		await expect(mcp).resolves.toBe(true);
		expect(controls.calls).toContain("executeExtensionCommand:/mcp reconnect");

		const auth = actions.handleSubmittedText("/mcp-auth");
		await flush();
		expect(modals.getActiveKind()).toBe("input");
		modals.handleInput("github");
		modals.handleInput("enter");
		await expect(auth).resolves.toBe(true);
		expect(controls.calls).toContain("executeExtensionCommand:/mcp-auth github");
	});

	it("forwards argument-bearing MCP commands directly to the child extension", async () => {
		const { actions, controls } = setup();
		controls.commands = [rpcCommand("mcp"), rpcCommand("mcp-auth")];

		await expect(actions.handleSubmittedText("/mcp tools")).resolves.toBe(true);
		await expect(actions.handleSubmittedText("/mcp-auth railway")).resolves.toBe(true);

		expect(controls.calls).toContain("executeExtensionCommand:/mcp tools");
		expect(controls.calls).toContain("executeExtensionCommand:/mcp-auth railway");
	});

	it("rejects MCP commands when the child adapter is unavailable", async () => {
		const { actions, controls, notifications } = setup();

		await expect(actions.handleSubmittedText("/mcp tools")).resolves.toBe(true);
		await expect(actions.handleSubmittedText("/mcp-auth railway")).resolves.toBe(true);

		expect(controls.calls.some((call) => call.startsWith("executeExtensionCommand:"))).toBe(false);
		expect(notifications).toContainEqual({ message: "unknown command: /mcp", level: "warning" });
		expect(notifications).toContainEqual({ message: "unknown command: /mcp-auth", level: "warning" });
	});

	it("executes /login directly against the RPC child without entering the agent prompt scheduler", async () => {
		const { actions, controls, notifications } = setup();

		expect(isRpcHostSlashCommandName("login")).toBe(true);
		await expect(actions.handleSubmittedText("/login anthropic")).resolves.toBe(true);
		expect(controls.calls).toContain("executeExtensionCommand:/login anthropic");
		expect(notifications).not.toContainEqual({ message: "unknown command: /login", level: "warning" });

		// /import remains an unsupported Pi built-in.
		expect(isRpcHostSlashCommandName("import")).toBe(false);
		await expect(actions.handleSubmittedText("/import")).resolves.toBe(true);
		expect(notifications).toContainEqual({ message: "unknown command: /import", level: "warning" });
		expect(controls.calls.filter((call) => call === "getCommands")).toHaveLength(1);
	});

	it("keeps the first login authoritative and rejects concurrent submissions", async () => {
		const { actions, controls, notifications } = setup();
		let release!: () => void;
		controls.executeExtensionCommand = async (message: string) => {
			controls.calls.push(`executeExtensionCommand:${message}`);
			await new Promise<void>((resolve) => { release = resolve; });
		};

		const first = actions.handleSubmittedText("/login anthropic");
		await flush();
		expect(actions.isLoginActive()).toBe(true);
		await expect(actions.handleSubmittedText("/login openai")).resolves.toBe(true);
		expect(notifications).toContainEqual({ message: "login already in progress", level: "warning" });
		expect(controls.calls.filter((call) => call.startsWith("executeExtensionCommand:"))).toEqual([
			"executeExtensionCommand:/login anthropic",
		]);

		release();
		await first;
		expect(actions.isLoginActive()).toBe(false);
	});

	it("cancels the child login when host-side execution fails or times out", async () => {
		const { actions, controls } = setup();
		controls.executeExtensionCommand = async () => { throw new Error("RPC request timed out"); };

		await expect(actions.handleSubmittedText("/login anthropic")).rejects.toThrow("RPC request timed out");

		expect(controls.calls).toContain("cancelLogin");
		expect(actions.isLoginActive()).toBe(false);
	});

	it("keeps RPC_HOST_SLASH_COMMANDS and handleSubmittedText's switch in exact 1:1 correspondence", async () => {
		// Every advertised command must have a real handler (no dead
		// advertising -- task 11), and nothing handled here should be missing
		// from the advertised list. This is a static shape check against the
		// module's own source rather than invoking every command (several open
		// blocking pickers/overlays that would hang without simulated input).
		const hostActionsSource = await readFile(new URL("./host-actions.ts", import.meta.url), "utf8");
		const switchCaseNames = [...hostActionsSource.matchAll(/case "\/([a-z0-9:_-]+)":/g)].map((match) => match[1]);
		const routedNames = [...RPC_HOST_SLASH_COMMANDS.map((command) => command.name), ...RPC_HOST_ROUTED_CHILD_COMMANDS];

		expect(new Set(switchCaseNames)).toEqual(new Set(routedNames));
	});
});
