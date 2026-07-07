import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RemnicMemoryClient } from "../../memory.js";
import { resetThemeRegistryForTests } from "../../themes/index.js";
import { SumoTuiTestBackend, type TestBackendFrame } from "../testing/test-backend.js";
import { ModalManager } from "../widgets/modal.js";
import type { NotificationLevel } from "../widgets/notification.js";
import { PiEditorLeaf } from "../widgets/pi-editor-leaf.js";
import type { RpcHostControls, RpcModelOption, RpcSlashCommand } from "./controls.js";
import {
	RpcHostEditorController,
	buildRpcAutocompleteCommands,
	createRpcAutocompleteProvider,
	createRpcHostEditorController,
	createRpcKeybindingsManager,
	loadRpcKeybindingsOverrides,
	resolveRpcAgentDir,
	type RpcEditorAutocompleteControls,
} from "./editor.js";
import { isRpcHostSlashCommandName, RpcHostActions, RPC_HOST_SLASH_COMMANDS } from "./host-actions.js";
import { RpcHostOverlayManager } from "./host-overlays.js";
import { InlineSelectorHost } from "./inline-selector.js";
import { RpcHostStateStore } from "./state.js";

const ANSI_PATTERN = /\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[()][A-Za-z0-9]/g;

function fakeTui(requestRender = vi.fn()): TUI {
	return { requestRender, terminal: { columns: 80, rows: 24, setTitle: vi.fn() } } as unknown as TUI;
}

function fakeEditorTheme(): EditorTheme {
	const identity = (value: string): string => value;
	return {
		borderColor: identity,
		selectList: {
			selectedPrefix: identity,
			selectedText: identity,
			description: identity,
			scrollInfo: identity,
			noMatch: identity,
		},
	};
}

function fakeKeybindings(): KeybindingsManager {
	return { matches: () => false } as unknown as KeybindingsManager;
}

function rpcCommand(name: string, description?: string, source: RpcSlashCommand["source"] = "extension"): RpcSlashCommand {
	return {
		name,
		description,
		source,
		sourceInfo: {
			path: `/tmp/${name}`,
			source,
			scope: "project",
			origin: "top-level",
		},
	};
}

function controlsFor(options: {
	commands?: readonly RpcSlashCommand[];
	models?: readonly RpcModelOption[];
} = {}): RpcEditorAutocompleteControls {
	return {
		getCommands: vi.fn(async () => [...(options.commands ?? [])]),
		getAvailableModels: vi.fn(async () => [...(options.models ?? [])]),
	};
}

async function mountController(controller: RpcHostEditorController, cols = 64, rows = 10): Promise<SumoTuiTestBackend> {
	const backend = await SumoTuiTestBackend.create({ cols, rows });
	const leaf = PiEditorLeaf.create(backend.yoga, controller.editor, backend.root);
	leaf.width = "100%";
	backend.setFocus(controller);
	controller.focus();
	return backend;
}

function plainFrame(frame: TestBackendFrame): string {
	const dimensions = frame.current.getDimensions();
	return Array.from({ length: dimensions.rows }, (_, row) => frame.current.toPlainRow(row)).join("\n");
}

function stripAnsi(value: string): string {
	return value.replace(ANSI_PATTERN, "");
}

async function waitForRenderedText(controller: RpcHostEditorController, text: string, width = 64): Promise<string> {
	let rendered = "";
	for (let attempt = 0; attempt < 20; attempt += 1) {
		rendered = controller.render(width).map(stripAnsi).join("\n");
		if (rendered.includes(text)) return rendered;
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	return rendered;
}

describe("RPC editor controller", () => {
	it("typing printable characters updates text and moves the hardware cursor through PiEditorLeaf", async () => {
		const controller = new RpcHostEditorController({
			tui: fakeTui(),
			theme: fakeEditorTheme(),
			keybindings: fakeKeybindings(),
		});
		const backend = await mountController(controller);
		try {
			const initialCursor = backend.render().cursor;
			backend.pilot.text("hi");
			const cursor = backend.cursor;

			expect(controller.getText()).toBe("hi");
			expect(initialCursor).not.toBeNull();
			expect(cursor).not.toBeNull();
			expect(cursor!.row).toBe(initialCursor!.row);
			expect(cursor!.col).toBe(initialCursor!.col + 2);
		} finally {
			backend.dispose();
		}
	});

	it("inserts multiline input and renders both lines headlessly", async () => {
		const controller = new RpcHostEditorController({
			tui: fakeTui(),
			theme: fakeEditorTheme(),
			keybindings: fakeKeybindings(),
		});
		const backend = await mountController(controller);
		try {
			controller.handleInput("line one");
			controller.handleInput("\x1b[13;2u");
			controller.handleInput("line two");

			const frame = backend.render();
			const plain = plainFrame(frame);

			expect(controller.getText()).toBe("line one\nline two");
			expect(plain).toContain("line one");
			expect(plain).toContain("line two");
		} finally {
			backend.dispose();
		}
	});

	it("setText and paste update the same editor text controller", () => {
		const requestRender = vi.fn();
		const controller = new RpcHostEditorController({
			tui: fakeTui(requestRender),
			theme: fakeEditorTheme(),
			keybindings: fakeKeybindings(),
		});

		controller.setText("alpha");
		controller.paste("\nbeta");

		expect(controller.getText()).toBe("alpha\nbeta");
		expect(requestRender).toHaveBeenCalled();
	});

	it("submit invokes the injected callback and preserves Pi editor clear-on-submit behavior", () => {
		const submitted: string[] = [];
		const controller = new RpcHostEditorController({
			tui: fakeTui(),
			theme: fakeEditorTheme(),
			keybindings: fakeKeybindings(),
			onSubmit: (text) => {
				submitted.push(text);
			},
		});

		controller.setText("send this");
		controller.handleInput("\r");

		expect(submitted).toEqual(["send this"]);
		expect(controller.getText()).toBe("");
	});

	it("notifies rejected submits without creating an unhandled rejection", async () => {
		const notifications: Array<{ message: string; level?: NotificationLevel }> = [];
		const controller = new RpcHostEditorController({
			tui: fakeTui(),
			theme: fakeEditorTheme(),
			keybindings: fakeKeybindings(),
			onSubmit: async () => {
				throw new Error("prompt timed out");
			},
			errorNotifier: {
				notify: (message, level) => notifications.push({ message, level }),
			},
		});

		controller.setText("send this");
		controller.handleInput("\r");
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(notifications).toEqual([{ message: "rpc error: prompt timed out", level: "warning" }]);
		expect(controller.getText()).toBe("");
	});

	it("submits exact CSI-u Enter as normal Enter", () => {
		const submitted: string[] = [];
		const controller = new RpcHostEditorController({
			tui: fakeTui(),
			theme: fakeEditorTheme(),
			keybindings: fakeKeybindings(),
			onSubmit: (text) => {
				submitted.push(text);
			},
		});

		controller.setText("send via csi-u");
		controller.handleInput("\x1b[13u");

		expect(submitted).toEqual(["send via csi-u"]);
		expect(controller.getText()).toBe("");
	});

	it("accepts slash autocomplete before submitting standalone CSI-u Enter", async () => {
		const submitted: string[] = [];
		const controller = await createRpcHostEditorController({
			controls: controlsFor(),
			tui: fakeTui(),
			theme: fakeEditorTheme(),
			keybindings: fakeKeybindings(),
			cwd: process.cwd(),
			onSubmit: (text) => {
				submitted.push(text);
			},
		});

		controller.handleInput("/");
		controller.handleInput("m");
		controller.handleInput("o");
		controller.handleInput("d");
		await waitForRenderedText(controller, "model");
		controller.handleInput("\x1b[13u");

		expect(submitted).toEqual(["/model"]);
		expect(controller.getText()).toBe("");
	});

	it("coalesces text followed by CSI-u Enter into insertion plus submit", () => {
		const submitted: string[] = [];
		const controller = new RpcHostEditorController({
			tui: fakeTui(),
			theme: fakeEditorTheme(),
			keybindings: fakeKeybindings(),
			onSubmit: (text) => {
				submitted.push(text);
			},
		});

		controller.handleInput("coalesced submit\x1b[13u");

		expect(submitted).toEqual(["coalesced submit"]);
		expect(controller.getText()).toBe("");
	});

	it("renders command autocomplete suggestions from host commands and RPC commands", async () => {
		const controls = controlsFor({ commands: [rpcCommand("deploy", "Deploy current workspace")] });
		const controller = await createRpcHostEditorController({
			controls,
			tui: fakeTui(),
			theme: fakeEditorTheme(),
			keybindings: fakeKeybindings(),
			cwd: process.cwd(),
		});

		controller.handleInput("/");
		controller.handleInput("d");
		controller.handleInput("e");

		const rendered = await waitForRenderedText(controller, "deploy");

		expect(rendered).toContain("deploy");
		expect(controls.getCommands).toHaveBeenCalledTimes(1);
	});

	it("reports isAutocompleteOpen() while the slash-command dropdown is visible and false once dismissed", async () => {
		const controls = controlsFor({ commands: [rpcCommand("deploy", "Deploy current workspace")] });
		const controller = await createRpcHostEditorController({
			controls,
			tui: fakeTui(),
			theme: fakeEditorTheme(),
			keybindings: fakeKeybindings(),
			cwd: process.cwd(),
		});

		expect(controller.isAutocompleteOpen()).toBe(false);

		controller.handleInput("/");
		controller.handleInput("d");
		controller.handleInput("e");
		await waitForRenderedText(controller, "deploy");

		expect(controller.isAutocompleteOpen()).toBe(true);

		controller.handleInput("\x1b"); // Escape cancels the autocomplete in Pi's editor.

		expect(controller.isAutocompleteOpen()).toBe(false);
	});

	it("provides /model argument suggestions from RpcHostControls model options", async () => {
		const controls = controlsFor({
			models: [
				{ provider: "openai", id: "gpt-5", label: "openai/gpt-5", active: true },
				{ provider: "anthropic", id: "claude-sonnet-5", label: "anthropic/claude-sonnet-5", active: false },
			],
		});
		const provider = createRpcAutocompleteProvider(buildRpcAutocompleteCommands([], { controls }), { cwd: process.cwd() });

		const suggestions = await provider.getSuggestions(["/model "], 0, "/model ".length, {
			signal: new AbortController().signal,
		});

		expect(suggestions?.prefix).toBe("");
		expect(suggestions?.items.map((item) => item.label)).toEqual([
			"openai/gpt-5",
			"anthropic/claude-sonnet-5",
		]);
		expect(controls.getAvailableModels).toHaveBeenCalledTimes(1);
	});
});

describe("RPC autocomplete command construction", () => {
	it("keeps host commands ahead of conflicting RPC commands and includes non-conflicting RPC commands", async () => {
		const commands = buildRpcAutocompleteCommands([
			rpcCommand("compact", "Extension compact should not replace built-in"),
			rpcCommand("/ship", "Ship it", "prompt"),
		]);
		const compactCommands = commands.filter((command) => command.name === "compact");
		const provider = createRpcAutocompleteProvider(commands, { cwd: process.cwd() });
		const suggestions = await provider.getSuggestions(["/sh"], 0, 3, {
			signal: new AbortController().signal,
		});

		expect(compactCommands).toEqual([{ name: "compact", description: "Manually compact the session context" }]);
		expect(commands.some((command) => command.name === "ship")).toBe(true);
		expect(suggestions?.items.map((item) => item.value)).toContain("ship");
	});

	it("advertises commands sourced only from the host list or the child's get_commands, excluding /login", () => {
		const childCommands = [
			rpcCommand("deploy", "Deploy current workspace"),
			rpcCommand("export", "Child executable export", "prompt"),
		];
		const commands = buildRpcAutocompleteCommands(childCommands);
		const childNames = new Set(childCommands.map((command) => command.name.replace(/^\/+/, "")));

		// Source-set check only: no advertised command may come from anywhere
		// but the host list or the child's own get_commands. Whether the host
		// list itself is honest (every entry actually dispatches) is proven by
		// the "advertised host slash-command dispatch invariant" suite below,
		// which drives the REAL RpcHostActions.handleSubmittedText.
		for (const command of commands) {
			expect(isRpcHostSlashCommandName(command.name) || childNames.has(command.name)).toBe(true);
		}
		expect(commands.some((command) => command.name === "export")).toBe(true);
		expect(commands.some((command) => command.name === "quit")).toBe(true);
		// /hotkeys is now host-implemented (plan 035 phase 1) and advertised;
		// /login is a Phase-3, upstream-Pi-only command this host still doesn't
		// implement, so it must NOT be advertised unless the child itself
		// exposes it via get_commands (not the case here).
		expect(commands.some((command) => command.name === "hotkeys")).toBe(true);
		expect(commands.some((command) => command.name === "login")).toBe(false);
	});
});

describe("advertised host slash-command dispatch invariant", () => {
	/**
	 * Minimal control surface for driving `handleSubmittedText`. Only the
	 * methods the escape-dismissed dispatch paths actually reach are
	 * implemented; an advertised command reaching an unimplemented method
	 * rejects the dispatch and fails its test loudly with the command name.
	 */
	class FakeDispatchControls {
		public readonly calls: string[] = [];

		public async refreshState(): Promise<Record<string, unknown>> {
			this.calls.push("refreshState");
			return {};
		}

		public async getAvailableModels(): Promise<RpcModelOption[]> {
			this.calls.push("getAvailableModels");
			return [{ provider: "openai", id: "gpt-5", label: "openai/gpt-5", active: true }];
		}

		public async compact(): Promise<Record<string, unknown>> {
			this.calls.push("compact");
			return {};
		}

		public async newSession(): Promise<{ cancelled: boolean }> {
			this.calls.push("newSession");
			return { cancelled: false };
		}

		public async clone(): Promise<{ cancelled: boolean }> {
			this.calls.push("clone");
			return { cancelled: false };
		}

		public async getForkMessages(): Promise<{ entryId: string; text: string }[]> {
			this.calls.push("getForkMessages");
			return [{ entryId: "entry-1", text: "forkable message text" }];
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

		public async getCommands(): Promise<RpcSlashCommand[]> {
			this.calls.push("getCommands");
			return [];
		}

		public async getLastAssistantText(): Promise<string | null> {
			this.calls.push("getLastAssistantText");
			return "last assistant response";
		}

		public async exportHtml(): Promise<{ path: string }> {
			this.calls.push("exportHtml");
			return { path: "/tmp/sumocode-session.html" };
		}
	}

	class FakeSelectorEditor {
		public invalidate(): void {}
		public handleInput(): void {}
		public render(): string[] {
			return ["editor"];
		}
	}

	interface DispatchHarness {
		readonly actions: RpcHostActions;
		readonly controls: FakeDispatchControls;
		readonly modals: ModalManager;
		readonly overlays: RpcHostOverlayManager;
		readonly inlineSelectors: InlineSelectorHost;
		readonly notifications: { message: string; level: NotificationLevel }[];
	}

	function dispatchHarness(changelogRoot: string): DispatchHarness {
		const controls = new FakeDispatchControls();
		const modals = new ModalManager();
		const overlays = new RpcHostOverlayManager();
		const inlineSelectors = new InlineSelectorHost(new FakeSelectorEditor());
		const notifications: { message: string; level: NotificationLevel }[] = [];
		const memoryClient = { browse: async () => [] } as unknown as RemnicMemoryClient;
		const actions = new RpcHostActions({
			controls: controls as unknown as RpcHostControls,
			// Fresh store, deliberately unhydrated: `sessionFile` stays undefined,
			// so /resume and /tree take their deterministic warning branches
			// instead of reading real session files off disk.
			stateStore: new RpcHostStateStore(),
			modals,
			overlays,
			inlineSelectors,
			notifications: {
				notify: (message, level = "info") => {
					notifications.push({ message, level });
					return notifications.length;
				},
			},
			createMemoryClient: () => memoryClient,
			changelogRoot,
		});
		return { actions, controls, modals, overlays, inlineSelectors, notifications };
	}

	function flushMicrotasks(): Promise<void> {
		return Promise.resolve().then(() => Promise.resolve());
	}

	/**
	 * Drives `handleSubmittedText` to completion by cancelling every host
	 * surface (inline selector, overlay, modal prompt) the command opens.
	 * Bounded by iteration count, not wall-clock time: every dismissal is a
	 * synchronous `close()` between microtask drains.
	 */
	async function dispatchToCompletion(harness: DispatchHarness, text: string): Promise<boolean> {
		let outcome: { handled: boolean } | { error: unknown } | undefined;
		void harness.actions.handleSubmittedText(text).then(
			(handled) => {
				outcome = { handled };
			},
			(error: unknown) => {
				outcome = { error };
			},
		);
		for (let attempt = 0; attempt < 32 && outcome === undefined; attempt += 1) {
			await flushMicrotasks();
			if (harness.inlineSelectors.getActiveKind() !== undefined) harness.inlineSelectors.close();
			else if (harness.overlays.getActiveKind() !== undefined) harness.overlays.close();
			else if (harness.modals.getActiveKind() !== undefined) harness.modals.close();
		}
		if (outcome === undefined) throw new Error(`dispatch of "${text}" did not settle after dismissing all host surfaces`);
		if ("error" in outcome) throw outcome.error;
		return outcome.handled;
	}

	let changelogRoot: string;

	beforeEach(() => {
		changelogRoot = mkdtempSync(join(tmpdir(), "sumocode-rpc-dispatch-test-"));
		writeFileSync(join(changelogRoot, "CHANGELOG.md"), "# Changelog\n\n- test entry\n", "utf8");
	});

	afterEach(() => {
		rmSync(changelogRoot, { recursive: true, force: true });
		resetThemeRegistryForTests();
	});

	it.each(RPC_HOST_SLASH_COMMANDS.map((command) => command.name))(
		"the real dispatcher handles advertised host command /%s without unknown-command fallthrough",
		async (name) => {
			const harness = dispatchHarness(changelogRoot);

			const handled = await dispatchToCompletion(harness, `/${name}`);

			// A dead-advertised command ALSO resolves `true`: it falls into the
			// dispatcher's default branch, which (with no child commands) emits
			// the "unknown command: /<name>" warning. The discriminating
			// assertion is therefore the absence of that warning, not the
			// return value alone.
			expect(handled).toBe(true);
			const fallthrough = harness.notifications.filter((notification) => notification.message.startsWith("unknown command:"));
			expect(fallthrough).toEqual([]);
		},
	);
});

describe("RPC keybindings manager construction", () => {
	let agentDir: string;

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "sumocode-rpc-keybindings-test-"));
	});

	afterEach(() => {
		rmSync(agentDir, { recursive: true, force: true });
	});

	it("resolves the agent dir from PI_CODING_AGENT_DIR when set, else <homeDir>/.pi/agent", () => {
		expect(resolveRpcAgentDir({ env: { PI_CODING_AGENT_DIR: agentDir } })).toBe(agentDir);
		expect(resolveRpcAgentDir({ homeDir: "/home/test", env: {} })).toBe(join("/home/test", ".pi", "agent"));
	});

	it("loads no overrides when keybindings.json is absent", () => {
		expect(loadRpcKeybindingsOverrides(agentDir)).toEqual({});
	});

	it("loads no overrides when keybindings.json is malformed JSON", () => {
		writeFileSync(join(agentDir, "keybindings.json"), "{ not json", "utf8");
		expect(loadRpcKeybindingsOverrides(agentDir)).toEqual({});
	});

	it("loads a stubbed user keybindings.json override, dropping invalid entries", () => {
		writeFileSync(
			join(agentDir, "keybindings.json"),
			JSON.stringify({ "app.exit": "ctrl+q", "app.interrupt": ["ctrl+g", "f2"], "app.bogus": 42 }),
			"utf8",
		);
		expect(loadRpcKeybindingsOverrides(agentDir)).toEqual({
			"app.exit": "ctrl+q",
			"app.interrupt": ["ctrl+g", "f2"],
		});
	});

	it("constructs a real manager whose matches() honors the remapped app.exit binding over the default", () => {
		writeFileSync(join(agentDir, "keybindings.json"), JSON.stringify({ "app.exit": "ctrl+q" }), "utf8");
		const manager = createRpcKeybindingsManager({ env: { PI_CODING_AGENT_DIR: agentDir } });

		expect(manager.matches("\x11", "app.exit" as never)).toBe(true); // ctrl+q
		expect(manager.matches("\x04", "app.exit" as never)).toBe(false); // default ctrl+d no longer bound
	});

	it("constructs a real manager that honors default app.* bindings when no override is present", () => {
		const manager = createRpcKeybindingsManager({ env: { PI_CODING_AGENT_DIR: agentDir } });

		expect(manager.matches("\x04", "app.exit" as never)).toBe(true); // default ctrl+d
		expect(manager.matches("\x1b", "app.interrupt" as never)).toBe(true); // default escape
	});

	it("still resolves tui.* editor bindings (undisturbed by app.* merge)", () => {
		const manager = createRpcKeybindingsManager({ env: { PI_CODING_AGENT_DIR: agentDir } });

		expect(manager.matches("\x02", "tui.editor.cursorLeft" as never)).toBe(true); // ctrl+b
	});
});

describe("RPC editor controller app-level action wiring", () => {
	it("invokes onExit via Ctrl+D only when the editor is empty (pi's own CustomEditor gate)", () => {
		const onExit = vi.fn();
		const controller = new RpcHostEditorController({
			tui: fakeTui(),
			theme: fakeEditorTheme(),
			keybindings: createRpcKeybindingsManager({ env: {} }),
			onExit,
		});

		controller.setText("draft in progress");
		controller.handleInput("\x04"); // ctrl+d
		expect(onExit).not.toHaveBeenCalled();
		// Pi's own semantic falls through to delete-char-forward when non-empty;
		// the draft is unaffected here because ctrl+d deletes forward from the
		// cursor, which sits at the end of the inserted text.
		expect(controller.getText()).toBe("draft in progress");

		controller.setText("");
		controller.handleInput("\x04"); // ctrl+d on an empty editor
		expect(onExit).toHaveBeenCalledTimes(1);
	});

	it("invokes onInterrupt via Escape when autocomplete is not open", () => {
		const onInterrupt = vi.fn();
		const controller = new RpcHostEditorController({
			tui: fakeTui(),
			theme: fakeEditorTheme(),
			keybindings: createRpcKeybindingsManager({ env: {} }),
			onInterrupt,
		});

		controller.handleInput("\x1b"); // escape, no autocomplete showing
		expect(onInterrupt).toHaveBeenCalledTimes(1);
	});

	it("does not invoke onInterrupt via Escape while the autocomplete dropdown is open", async () => {
		const onInterrupt = vi.fn();
		const controls = controlsFor({ commands: [rpcCommand("deploy", "Deploy current workspace")] });
		const controller = await createRpcHostEditorController({
			controls,
			tui: fakeTui(),
			theme: fakeEditorTheme(),
			keybindings: createRpcKeybindingsManager({ env: {} }),
			cwd: process.cwd(),
			onInterrupt,
		});

		controller.handleInput("/");
		controller.handleInput("d");
		controller.handleInput("e");
		await waitForRenderedText(controller, "deploy");
		expect(controller.isAutocompleteOpen()).toBe(true);

		controller.handleInput("\x1b");

		expect(onInterrupt).not.toHaveBeenCalled();
		expect(controller.isAutocompleteOpen()).toBe(false);
	});

	it("honors a remapped app.exit binding from keybindings.json instead of the default ctrl+d", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "sumocode-rpc-keybindings-wiring-test-"));
		try {
			writeFileSync(join(agentDir, "keybindings.json"), JSON.stringify({ "app.exit": "ctrl+q" }), "utf8");
			const onExit = vi.fn();
			const controller = new RpcHostEditorController({
				tui: fakeTui(),
				theme: fakeEditorTheme(),
				keybindings: createRpcKeybindingsManager({ env: { PI_CODING_AGENT_DIR: agentDir } }),
				onExit,
			});

			controller.handleInput("\x04"); // default ctrl+d no longer triggers app.exit
			expect(onExit).not.toHaveBeenCalled();

			controller.handleInput("\x11"); // remapped ctrl+q
			expect(onExit).toHaveBeenCalledTimes(1);
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("leaves editor internals (arrow keys, undo) unaffected by the real keybindings manager", () => {
		const controller = new RpcHostEditorController({
			tui: fakeTui(),
			theme: fakeEditorTheme(),
			keybindings: createRpcKeybindingsManager({ env: {} }),
		});

		controller.handleInput("abc");
		controller.handleInput("\x1b[D"); // left arrow
		controller.handleInput("X");

		expect(controller.getText()).toBe("abXc");
	});

	// Root cause of "keybindings are broken": these 5 app.* actions were
	// declared in APP_KEYBINDING_DEFINITIONS (so KeybindingsManager.matches()
	// recognizes their chords) but runRpcHost never called editor.onAction(...)
	// to register a handler -- CustomEditor.handleInput's fallback loop
	// (custom-editor.js) found no entry in actionHandlers and silently fell
	// through to super.handleInput with no effect. These tests pin each
	// handler actually fires on its default chord once wired.
	it("invokes onThinkingCycle via Shift+Tab (app.thinking.cycle -- one of the two exact reported-broken chords)", () => {
		const onThinkingCycle = vi.fn();
		const controller = new RpcHostEditorController({
			tui: fakeTui(),
			theme: fakeEditorTheme(),
			keybindings: createRpcKeybindingsManager({ env: {} }),
			onThinkingCycle,
		});

		controller.handleInput("\x1b[Z"); // shift+tab
		expect(onThinkingCycle).toHaveBeenCalledTimes(1);
	});

	it("invokes onModelCycleForward via Ctrl+P", () => {
		const onModelCycleForward = vi.fn();
		const controller = new RpcHostEditorController({
			tui: fakeTui(),
			theme: fakeEditorTheme(),
			keybindings: createRpcKeybindingsManager({ env: {} }),
			onModelCycleForward,
		});

		controller.handleInput("\x10"); // ctrl+p
		expect(onModelCycleForward).toHaveBeenCalledTimes(1);
	});

	it("invokes onModelCycleBackward via Shift+Ctrl+P (the other exact reported-broken chord)", () => {
		const onModelCycleBackward = vi.fn();
		const controller = new RpcHostEditorController({
			tui: fakeTui(),
			theme: fakeEditorTheme(),
			keybindings: createRpcKeybindingsManager({ env: {} }),
			onModelCycleBackward,
		});

		controller.handleInput("\x1b[80;6u"); // CSI-u shift+ctrl+p
		expect(onModelCycleBackward).toHaveBeenCalledTimes(1);
	});

	it("invokes onModelSelect via Ctrl+L", () => {
		const onModelSelect = vi.fn();
		const controller = new RpcHostEditorController({
			tui: fakeTui(),
			theme: fakeEditorTheme(),
			keybindings: createRpcKeybindingsManager({ env: {} }),
			onModelSelect,
		});

		controller.handleInput("\x0c"); // ctrl+l
		expect(onModelSelect).toHaveBeenCalledTimes(1);
	});

	it("invokes onToolsExpandToggle via Ctrl+O", () => {
		const onToolsExpandToggle = vi.fn();
		const controller = new RpcHostEditorController({
			tui: fakeTui(),
			theme: fakeEditorTheme(),
			keybindings: createRpcKeybindingsManager({ env: {} }),
			onToolsExpandToggle,
		});

		controller.handleInput("\x0f"); // ctrl+o
		expect(onToolsExpandToggle).toHaveBeenCalledTimes(1);
	});

	it("regression guard: an unbound key still reaches the editor as normal text after wiring app.* actions", () => {
		const onModelCycleForward = vi.fn();
		const onModelCycleBackward = vi.fn();
		const onModelSelect = vi.fn();
		const onThinkingCycle = vi.fn();
		const onToolsExpandToggle = vi.fn();
		const controller = new RpcHostEditorController({
			tui: fakeTui(),
			theme: fakeEditorTheme(),
			keybindings: createRpcKeybindingsManager({ env: {} }),
			onModelCycleForward,
			onModelCycleBackward,
			onModelSelect,
			onThinkingCycle,
			onToolsExpandToggle,
		});

		controller.handleInput("hello world");

		expect(controller.getText()).toBe("hello world");
		expect(onModelCycleForward).not.toHaveBeenCalled();
		expect(onModelCycleBackward).not.toHaveBeenCalled();
		expect(onModelSelect).not.toHaveBeenCalled();
		expect(onThinkingCycle).not.toHaveBeenCalled();
		expect(onToolsExpandToggle).not.toHaveBeenCalled();
	});
});
