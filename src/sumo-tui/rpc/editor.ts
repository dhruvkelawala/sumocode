import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import {
	CombinedAutocompleteProvider,
	fuzzyFilter,
	KeybindingsManager as PiTuiKeybindingsManager,
	TUI_KEYBINDINGS,
	type AutocompleteItem,
	type AutocompleteProvider,
	type Component,
	type EditorTheme,
	type KeybindingDefinitions,
	type KeybindingsConfig,
	type SlashCommand,
	type TUI,
} from "@earendil-works/pi-tui";
import { createCathedralEditor, type CathedralEditor } from "../../cathedral/cathedral-editor.js";
import { pasteClipboardImageToTempFile } from "./clipboard-paste.js";
import type { KeyEvent, KeyTarget } from "../input/key-router.js";
import type { EditorTextController } from "../pi-compat/extension-ui-adapter.js";
import type { RpcHostControls, RpcModelOption, RpcSlashCommand } from "./controls.js";
import { RPC_HOST_SLASH_COMMANDS } from "./host-actions.js";
import { notifyOnError, type ErrorNotifier } from "./safe-send.js";

export type RpcEditorAutocompleteControls = Pick<RpcHostControls, "getCommands" | "getAvailableModels">;
type RpcModelCompletionControls = Pick<RpcHostControls, "getAvailableModels">;

export interface RpcEditorAutocompleteOptions {
	readonly controls?: RpcModelCompletionControls;
}

export interface RpcAutocompleteProviderOptions {
	readonly cwd?: string;
	readonly fdPath?: string | null;
}

export interface RpcHostEditorControllerOptions extends RpcAutocompleteProviderOptions {
	readonly controls?: RpcEditorAutocompleteControls;
	readonly tui?: TUI;
	readonly theme?: EditorTheme;
	readonly keybindings?: KeybindingsManager;
	readonly isSplash?: () => boolean;
	readonly onSubmit?: (text: string) => void | Promise<void>;
	readonly errorNotifier?: ErrorNotifier;
	readonly onRenderRequest?: () => void;
	readonly autocompleteMaxVisible?: number;
	/**
	 * Manager-driven `app.exit` action (Ctrl+D by default, or the user's
	 * `keybindings.json` remap). Mirrors pi's `CustomEditor.handleInput`:
	 * `CustomEditor` only invokes this when the editor text is EMPTY (see
	 * `custom-editor.js`: `if (this.getText().length === 0) { ...handler(); }`,
	 * else it falls through to delete-char-forward) -- the empty-only gate is
	 * pi's own semantic, enforced inside `CustomEditor`/`CathedralEditor`
	 * itself, not something this controller needs to re-check.
	 */
	readonly onExit?: () => void;
	/**
	 * Manager-driven `app.interrupt` action (Escape by default, or the user's
	 * remap). `CustomEditor` only invokes this when the autocomplete dropdown
	 * is NOT showing (else Escape falls through to close the dropdown).
	 */
	readonly onInterrupt?: () => void;
	/**
	 * `app.model.cycleForward` (Ctrl+P by default). Unlike `onExit`/`onInterrupt`
	 * (which map to `CustomEditor`'s dedicated `onCtrlD`/`onEscape` props), this
	 * and the handlers below are registered via the generic `editor.onAction(...)`
	 * map `CustomEditor.handleInput` also consults (see custom-editor.js) --
	 * there is no dedicated callback prop for these actions.
	 */
	readonly onModelCycleForward?: () => void;
	/** `app.model.cycleBackward` (Shift+Ctrl+P by default). */
	readonly onModelCycleBackward?: () => void;
	/** `app.model.select` (Ctrl+L by default). */
	readonly onModelSelect?: () => void;
	/** `app.thinking.cycle` (Shift+Tab by default). */
	readonly onThinkingCycle?: () => void;
	/** `app.tools.expand` (Ctrl+O by default). */
	readonly onToolsExpandToggle?: () => void;
	/** `app.theme.cycle` (Shift+Ctrl+T / Alt+T by default). */
	readonly onThemeCycle?: () => void;
	/** `app.message.followUp` (Alt+Enter by default). */
	readonly onMessageFollowUp?: () => void;
	/** `app.message.dequeue` (Alt+Up by default). */
	readonly onMessageDequeue?: () => void;
}

const identity = (text: string): string => text;
const CSI_U_ENTER = "\x1b[13u";

export function buildRpcAutocompleteCommands(
	rpcCommands: readonly RpcSlashCommand[] = [],
	options: RpcEditorAutocompleteOptions = {},
): SlashCommand[] {
	const seen = new Set<string>();
	const commands: SlashCommand[] = RPC_HOST_SLASH_COMMANDS.map((command) => {
		seen.add(command.name);
		return { name: command.name, description: command.description };
	});
	const modelCommand = commands.find((command) => command.name === "model");
	if (modelCommand && options.controls) {
		modelCommand.getArgumentCompletions = (prefix) => getModelArgumentCompletions(options.controls!, prefix);
	}

	for (const command of rpcCommands) {
		const name = normalizeCommandName(command.name);
		if (!name || seen.has(name)) continue;
		seen.add(name);
		commands.push({
			name,
			description: command.description,
		});
	}

	return commands;
}

export async function loadRpcAutocompleteCommands(controls: RpcEditorAutocompleteControls): Promise<SlashCommand[]> {
	return buildRpcAutocompleteCommands(await controls.getCommands(), { controls });
}

export function createRpcAutocompleteProvider(
	commands: readonly SlashCommand[],
	options: RpcAutocompleteProviderOptions = {},
): CombinedAutocompleteProvider {
	return new CombinedAutocompleteProvider([...commands], options.cwd ?? process.cwd(), options.fdPath ?? null);
}

export async function createRpcAutocompleteProviderFromControls(
	controls: RpcEditorAutocompleteControls,
	options: RpcAutocompleteProviderOptions = {},
): Promise<CombinedAutocompleteProvider> {
	return createRpcAutocompleteProvider(await loadRpcAutocompleteCommands(controls), options);
}

export class RpcHostEditorController implements EditorTextController, KeyTarget {
	public readonly editor: CathedralEditor;
	private readonly tui: TUI;
	private readonly controls: RpcEditorAutocompleteControls | undefined;
	private readonly cwd: string | undefined;
	private readonly fdPath: string | null | undefined;
	private readonly onSubmit: (text: string) => void | Promise<void>;
	private readonly errorNotifier: ErrorNotifier | undefined;
	private isSplashProvider: () => boolean;

	public constructor(options: RpcHostEditorControllerOptions = {}) {
		this.tui = options.tui ?? createFallbackTui(options.onRenderRequest);
		this.controls = options.controls;
		this.cwd = options.cwd;
		this.fdPath = options.fdPath;
		this.onSubmit = options.onSubmit ?? (() => undefined);
		this.errorNotifier = options.errorNotifier;
		this.isSplashProvider = options.isSplash ?? (() => false);
		this.editor = createCathedralEditor(
			this.tui,
			options.theme ?? createFallbackEditorTheme(),
			options.keybindings ?? createNoopKeybindings(),
			{ isSplash: () => this.isSplashProvider() },
		);
		// Manager-driven app actions: `CustomEditor` (which `CathedralEditor`
		// extends) already gates these on the injected `KeybindingsManager` --
		// `onCtrlD`/`onEscape` are its special-cased callback props for
		// `app.exit`/`app.interrupt` (see custom-editor.js), each with pi's own
		// empty-editor / autocomplete-closed guard already enforced internally.
		// `onAction` is the generic per-action handler map for everything else
		// (e.g. `app.suspend`) that CustomEditor's `handleInput` also consults.
		if (options.onExit) this.editor.onCtrlD = options.onExit;
		if (options.onInterrupt) this.editor.onEscape = options.onInterrupt;
		// Generic `app.*` actions: registered through `onAction` (the map
		// `CustomEditor.handleInput`'s fallback loop consults for every action
		// other than `app.interrupt`/`app.exit`) rather than a dedicated prop --
		// see each option's doc comment above.
		if (options.onModelCycleForward) this.editor.onAction("app.model.cycleForward", options.onModelCycleForward);
		if (options.onModelCycleBackward) this.editor.onAction("app.model.cycleBackward", options.onModelCycleBackward);
		if (options.onModelSelect) this.editor.onAction("app.model.select", options.onModelSelect);
		if (options.onThinkingCycle) this.editor.onAction("app.thinking.cycle", options.onThinkingCycle);
		if (options.onToolsExpandToggle) this.editor.onAction("app.tools.expand", options.onToolsExpandToggle);
		if (options.onMessageFollowUp) this.editor.onAction("app.message.followUp", options.onMessageFollowUp);
		if (options.onMessageDequeue) this.editor.onAction("app.message.dequeue", options.onMessageDequeue);
		// Cast: `app.theme.cycle` is a SumoCode-custom action, not part of pi's
		// AppKeybinding union. CustomEditor's action map is string-keyed at
		// runtime and `matches()` consults OUR merged keybindings table (which
		// defines the action above), so only the declared signature is narrow.
		if (options.onThemeCycle) (this.editor.onAction as (action: string, handler: () => void) => void)("app.theme.cycle", options.onThemeCycle);
		// Ctrl+V → app.clipboard.pasteImage: read the clipboard image to a
		// pi-clipboard-* temp file and insert its path; CathedralEditor's
		// insertTextAtCursor collapses it into a compact [Image N] token
		// (expanded back to the real path on submit). Without this wiring
		// CustomEditor.handleInput swallows the keybinding as a no-op.
		this.editor.onPasteImage = () => {
			void (async () => {
				const path = await pasteClipboardImageToTempFile();
				if (!path) return;
				this.editor.insertTextAtCursor(path);
				this.tui.requestRender();
			})();
		};
		this.editor.focused = true;
		this.editor.onChange = () => this.tui.requestRender();
		this.editor.onSubmit = (text) => {
			if (this.errorNotifier) {
				void notifyOnError(() => this.onSubmit(text), this.errorNotifier);
				return;
			}
			void Promise.resolve(this.onSubmit(text)).catch(() => undefined);
		};
		if (options.autocompleteMaxVisible !== undefined) this.editor.setAutocompleteMaxVisible(options.autocompleteMaxVisible);
	}

	public async configureAutocomplete(controls: RpcEditorAutocompleteControls | undefined = this.controls): Promise<void> {
		if (!controls) return;
		this.setAutocompleteProvider(await createRpcAutocompleteProviderFromControls(controls, {
			cwd: this.cwd,
			fdPath: this.fdPath,
		}));
	}

	public setAutocompleteProvider(provider: AutocompleteProvider): void {
		this.editor.setAutocompleteProvider(provider);
	}

	public focus(): Component {
		this.editor.focused = true;
		return this.editor;
	}

	public blur(): void {
		this.editor.focused = false;
	}

	public invalidate(): void {
		this.editor.invalidate();
	}

	public setSplashProvider(provider: () => boolean): void {
		this.isSplashProvider = provider;
		this.tui.requestRender();
	}

	public handleKey(event: KeyEvent): boolean {
		this.handleInput(keyEventToEditorInput(event));
		return true;
	}

	public handleInput(data: string): void {
		for (const chunk of splitCsiUEnter(data)) {
			this.editor.handleInput(chunk);
		}
	}

	public render(width: number): string[] {
		return this.editor.render(width);
	}

	public paste(text: string): void {
		this.editor.insertTextAtCursor(text);
		this.tui.requestRender();
	}

	public setText(text: string): void {
		this.editor.setText(text);
		this.tui.requestRender();
	}

	public addToHistory(text: string): void {
		this.editor.addToHistory?.(text);
	}

	/** See CathedralEditor.expandDraftTokens — expand-only, no clear. */
	public expandDraftTokens(text: string): string {
		return this.editor.expandDraftTokens(text);
	}

	/** See CathedralEditor.clearImageDrafts — the commit-side clear. */
	public clearImageDrafts(): void {
		this.editor.clearImageDrafts();
	}

	public getText(): string {
		return this.editor.getText();
	}

	/**
	 * True while the editor's autocomplete dropdown (slash commands, agent
	 * mentions, file paths) is visible. Mirrors pi's CustomEditor gate on
	 * `app.interrupt`: Esc must reach the editor to close the dropdown
	 * instead of being treated as a streaming-abort/quit interrupt.
	 */
	public isAutocompleteOpen(): boolean {
		return this.editor.isShowingAutocomplete();
	}
}

export async function createRpcHostEditorController(
	options: RpcHostEditorControllerOptions = {},
): Promise<RpcHostEditorController> {
	const controller = new RpcHostEditorController(options);
	await controller.configureAutocomplete(options.controls);
	return controller;
}

function normalizeCommandName(name: string): string {
	return name.trim().replace(/^\/+/, "");
}

function keyEventToEditorInput(event: KeyEvent): string {
	if (event.sequence !== undefined) return event.sequence;
	if (event.key === "enter" || event.key === "Enter") return "\r";
	return event.key;
}

function splitCsiUEnter(data: string): string[] {
	if (!data.includes(CSI_U_ENTER)) return [data];
	const chunks: string[] = [];
	let remaining = data;
	while (remaining.length > 0) {
		const index = remaining.indexOf(CSI_U_ENTER);
		if (index === -1) {
			chunks.push(remaining);
			break;
		}
		if (index > 0) chunks.push(remaining.slice(0, index));
		chunks.push(CSI_U_ENTER);
		remaining = remaining.slice(index + CSI_U_ENTER.length);
	}
	return chunks;
}

async function getModelArgumentCompletions(
	controls: RpcModelCompletionControls,
	prefix: string,
): Promise<AutocompleteItem[] | null> {
	const models = await controls.getAvailableModels();
	if (models.length === 0) return null;
	const items = models.map(modelToAutocompleteItem);
	const filtered = fuzzyFilter(items, prefix, (item) => `${item.value} ${item.description ?? ""}`);
	return filtered.length > 0 ? filtered : null;
}

function modelToAutocompleteItem(model: RpcModelOption): AutocompleteItem {
	return {
		value: model.label,
		label: model.label,
		description: model.active ? "active" : undefined,
	};
}

function createFallbackTui(onRenderRequest: (() => void) | undefined): TUI {
	return {
		requestRender: () => onRenderRequest?.(),
		terminal: { columns: 80, rows: 24, setTitle: () => undefined },
	} as unknown as TUI;
}

function createFallbackEditorTheme(): EditorTheme {
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

function createNoopKeybindings(): KeybindingsManager {
	return {
		matches: () => false,
	} as unknown as KeybindingsManager;
}

/**
 * `app.*` keybinding defaults, mirrored from
 * `@earendil-works/pi-coding-agent`'s internal `KEYBINDINGS` table
 * (`dist/core/keybindings.js`). That table -- and the `KeybindingsManager`
 * subclass that merges it with `TUI_KEYBINDINGS` and loads the user's
 * `keybindings.json` (`KeybindingsManager.create(agentDir)`) -- is NOT
 * reachable from the package's public surface: `package.json#exports`
 * restricts the package to its `"."` entry point only (verified: importing
 * `@earendil-works/pi-coding-agent/dist/core/keybindings.js` throws Node's
 * `ERR_PACKAGE_PATH_NOT_EXPORTED` at runtime, under both ESM and CJS
 * resolution), and the main index only re-exports `KeybindingsManager` as a
 * TYPE (`export type { ... KeybindingsManager ... }`), not a value --
 * `typeof (await import("@earendil-works/pi-coding-agent")).KeybindingsManager
 * === "undefined"` confirms this empirically. Pi's own interactive mode only
 * ever constructs it via a deep relative import internal to the package
 * (`../../core/keybindings.js`), never through its own public entry point.
 *
 * `@earendil-works/pi-tui`'s `KeybindingsManager` (imported below as
 * `PiTuiKeybindingsManager`) IS a public value export with no `exports`
 * restriction, and it is the exact base class pi-coding-agent's manager
 * extends -- `matches()`, the method `CustomEditor.handleInput` actually
 * calls, is implemented there, not overridden. Constructing
 * `PiTuiKeybindingsManager` directly with `TUI_KEYBINDINGS` (also public)
 * merged with this locally-declared `app.*` table reproduces the same
 * `matches()` behavior pi's real manager provides, including honoring a
 * user's `keybindings.json` override merged in as `userBindings` -- without
 * depending on an internal module path Node refuses to resolve.
 *
 * Judgment call: `migrateKeybindingsConfig` (renames legacy pre-namespaced
 * keys like `"exit"` -> `"app.exit"`) is also internal-only and is not
 * reimplemented here. `keybindings.json` files written against the current,
 * namespaced action names (`"app.exit"`, `"app.interrupt"`, ...) -- the only
 * form documented/produced today -- are unaffected; only pre-migration
 * legacy key names would silently fail to apply.
 */
const APP_KEYBINDING_DEFINITIONS: KeybindingDefinitions = {
	"app.interrupt": { defaultKeys: "escape", description: "Cancel or abort" },
	"app.clear": { defaultKeys: "ctrl+c", description: "Clear editor" },
	"app.exit": { defaultKeys: "ctrl+d", description: "Exit when editor is empty" },
	"app.suspend": { defaultKeys: process.platform === "win32" ? [] : "ctrl+z", description: "Suspend to background" },
	"app.thinking.cycle": { defaultKeys: "shift+tab", description: "Cycle thinking level" },
	"app.model.cycleForward": { defaultKeys: "ctrl+p", description: "Cycle to next model" },
	"app.model.cycleBackward": { defaultKeys: "shift+ctrl+p", description: "Cycle to previous model" },
	"app.model.select": { defaultKeys: "ctrl+l", description: "Open model selector" },
	"app.tools.expand": { defaultKeys: "ctrl+o", description: "Toggle tool output" },
	"app.thinking.toggle": { defaultKeys: "ctrl+t", description: "Toggle thinking blocks" },
	// alt+t mirrors the classic extension's fallback for terminals that grab
	// Ctrl+Shift chords; shift+ctrl order matches app.model.cycleBackward.
	"app.theme.cycle": { defaultKeys: ["shift+ctrl+t", "alt+t"], description: "Cycle SumoCode theme" },
	"app.session.toggleNamedFilter": { defaultKeys: "ctrl+n", description: "Toggle named session filter" },
	"app.editor.external": { defaultKeys: "ctrl+g", description: "Open external editor" },
	"app.message.followUp": { defaultKeys: "alt+enter", description: "Queue follow-up message" },
	"app.message.dequeue": { defaultKeys: "alt+up", description: "Restore queued messages" },
	"app.clipboard.pasteImage": { defaultKeys: process.platform === "win32" ? "alt+v" : "ctrl+v", description: "Paste image from clipboard" },
	"app.session.new": { defaultKeys: [], description: "Start a new session" },
	"app.session.tree": { defaultKeys: [], description: "Open session tree" },
	"app.session.fork": { defaultKeys: [], description: "Fork current session" },
	"app.session.resume": { defaultKeys: [], description: "Resume a session" },
	"app.tree.foldOrUp": { defaultKeys: ["ctrl+left", "alt+left"], description: "Fold tree branch or move up" },
	"app.tree.unfoldOrDown": { defaultKeys: ["ctrl+right", "alt+right"], description: "Unfold tree branch or move down" },
	"app.tree.editLabel": { defaultKeys: "shift+l", description: "Edit tree label" },
	"app.tree.toggleLabelTimestamp": { defaultKeys: "shift+t", description: "Toggle tree label timestamps" },
	"app.session.togglePath": { defaultKeys: "ctrl+p", description: "Toggle session path display" },
	"app.session.toggleSort": { defaultKeys: "ctrl+s", description: "Toggle session sort mode" },
	"app.session.rename": { defaultKeys: "ctrl+r", description: "Rename session" },
	"app.session.delete": { defaultKeys: "ctrl+d", description: "Delete session" },
	"app.session.deleteNoninvasive": { defaultKeys: "ctrl+backspace", description: "Delete session when query is empty" },
	"app.models.save": { defaultKeys: "ctrl+s", description: "Save model selection" },
	"app.models.enableAll": { defaultKeys: "ctrl+a", description: "Enable all models" },
	"app.models.clearAll": { defaultKeys: "ctrl+x", description: "Clear all models" },
	"app.models.toggleProvider": { defaultKeys: "ctrl+p", description: "Toggle all models for provider" },
	"app.models.reorderUp": { defaultKeys: "alt+up", description: "Move model up in order" },
	"app.models.reorderDown": { defaultKeys: "alt+down", description: "Move model down in order" },
	"app.tree.filter.default": { defaultKeys: "ctrl+d", description: "Tree filter: default view" },
	"app.tree.filter.noTools": { defaultKeys: "ctrl+t", description: "Tree filter: hide tool results" },
	"app.tree.filter.userOnly": { defaultKeys: "ctrl+u", description: "Tree filter: user messages only" },
	"app.tree.filter.labeledOnly": { defaultKeys: "ctrl+l", description: "Tree filter: labeled entries only" },
	"app.tree.filter.all": { defaultKeys: "ctrl+a", description: "Tree filter: show all entries" },
	"app.tree.filter.cycleForward": { defaultKeys: "ctrl+o", description: "Tree filter: cycle forward" },
	"app.tree.filter.cycleBackward": { defaultKeys: "shift+ctrl+o", description: "Tree filter: cycle backward" },
};

const RPC_KEYBINDING_DEFINITIONS: KeybindingDefinitions = { ...TUI_KEYBINDINGS, ...APP_KEYBINDING_DEFINITIONS };

export interface ResolveRpcAgentDirOptions {
	readonly homeDir?: string;
	readonly env?: NodeJS.ProcessEnv;
}

/**
 * Resolve pi's agent config directory the same env-aware way pi's own
 * `getAgentDir()` does (`core/config.js`: check `PI_CODING_AGENT_DIR` first,
 * else `<homeDir>/.pi/agent`) -- and the same pattern
 * `resolveGlobalSumoCodeConfigPath` in `src/config/sumocode-config.ts` uses
 * for SumoCode's own config file, so an isolated `PI_CODING_AGENT_DIR` (used
 * by the visual harness and other tooling to sandbox a whole agent dir)
 * redirects `keybindings.json` resolution the same way it redirects
 * `sumocode.json`.
 */
export function resolveRpcAgentDir(options: ResolveRpcAgentDirOptions = {}): string {
	const env = options.env ?? process.env;
	const piAgentDir = env.PI_CODING_AGENT_DIR;
	if (piAgentDir) return resolve(piAgentDir);
	return join(resolve(options.homeDir ?? homedir()), ".pi", "agent");
}

function isKeyIdLike(value: unknown): value is string | string[] {
	if (typeof value === "string") return true;
	return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

/**
 * Load and validate the user's `keybindings.json` override from the
 * resolved agent dir. Missing file, unreadable file, invalid JSON, or a
 * non-object root all resolve to "no overrides" rather than throwing --
 * a malformed keybindings file must not prevent the RPC host from starting.
 * Per-key values that aren't a `KeyId` or `KeyId[]` are dropped individually
 * (mirrors pi's own `toKeybindingsConfig` filtering).
 */
export function loadRpcKeybindingsOverrides(agentDir: string): KeybindingsConfig {
	const path = join(agentDir, "keybindings.json");
	if (!existsSync(path)) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return {};
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
	// User-authored keybindings.json is untyped JSON at the boundary -- `KeyId`
	// is a template-literal union pi-tui validates internally via `matches()`
	// at lookup time, not something we can narrow to statically here. Filtering
	// to string/string[] shapes (mirrors pi's own `toKeybindingsConfig`) is the
	// same validation depth pi's real loader applies before this cast.
	const config: KeybindingsConfig = {};
	for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
		if (isKeyIdLike(value)) config[key] = value as never;
	}
	return config;
}

export interface CreateRpcKeybindingsManagerOptions extends ResolveRpcAgentDirOptions {}

/**
 * Construct the RPC host's real `KeybindingsManager`: `pi-tui`'s public
 * manager class, seeded with pi's `app.*` action defaults merged with
 * `TUI_KEYBINDINGS`, with the user's `keybindings.json` overrides loaded
 * from the (env-aware) agent dir. See `APP_KEYBINDING_DEFINITIONS` above for
 * why this can't just call pi-coding-agent's own `KeybindingsManager.create`.
 */
export function createRpcKeybindingsManager(options: CreateRpcKeybindingsManagerOptions = {}): KeybindingsManager {
	const agentDir = resolveRpcAgentDir(options);
	const userBindings = loadRpcKeybindingsOverrides(agentDir);
	return new PiTuiKeybindingsManager(RPC_KEYBINDING_DEFINITIONS, userBindings) as unknown as KeybindingsManager;
}
