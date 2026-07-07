import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Component } from "@earendil-works/pi-tui";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import {
	CommandPaletteComponent,
	type CommandPaletteSnapshot,
	type PaletteMode,
} from "../../command-palette.js";
import {
	renderApprovalModal,
	updateApprovalSnapshot,
	type ApprovalChoice,
	type ApprovalModalSnapshot,
} from "../../approval-modal.js";
import {
	createRemnicMemoryClient,
	MemoryClientError,
	type MemoryFact,
	type RemnicMemoryClient,
} from "../../memory.js";
import { groupFactsByPanel } from "../../memory-categorization.js";
import {
	MemoryEditorComponent,
	formatMemoryStatus,
	type MemoryEditorSnapshot,
} from "../../memory-editor.js";
import { renderThemeCheck, type ThemeBgSlot, type ThemeFgSlot, type ThemeReader } from "../../theme-check.js";
import { activeThemeColors, getActiveTheme, listThemes, setActiveTheme } from "../../themes/index.js";
import { tryCreateOsc52Sequence } from "../input/selection.js";
import type { EditorTextController } from "../pi-compat/extension-ui-adapter.js";
import type { ModalManager } from "../widgets/modal.js";
import type { NotificationCenter, NotificationLevel } from "../widgets/notification.js";
import type { RpcHostControls, RpcModelOption, RpcSessionStats, RpcThinkingLevel } from "./controls.js";
import type { RpcHostOverlayManager } from "./host-overlays.js";
import type { InlineSelectorHost, InlineSelectorItem } from "./inline-selector.js";
import { notifyOnError } from "./safe-send.js";
import { buildSessionTree, listSessions, type SessionEntryLike, type SessionListInfo, type SessionTreeNode } from "./session-reader.js";
import type { RpcHostChromeState, RpcHostStateStore } from "./state.js";

export const RPC_HOST_COMMAND_PALETTE_INPUT = "\u001f";

export interface RpcHostSlashCommand {
	readonly name: string;
	readonly description: string;
}

type HostModals = Pick<ModalManager, "select" | "confirm" | "input">;
type HostInlineSelectors = Pick<InlineSelectorHost, "select">;
type HostNotifications = Pick<NotificationCenter, "notify">;
type MemoryClientFactory = () => RemnicMemoryClient;

export interface RpcHostActionsOptions {
	readonly controls: RpcHostControls;
	readonly stateStore: RpcHostStateStore;
	readonly modals: HostModals;
	readonly overlays: RpcHostOverlayManager;
	/**
	 * In-place selector surface (plan 036, extended by plan 035 phase 1):
	 * `openModelSelector`, `openThinkingSelector`, `openSessionControls`,
	 * `openSettings`, `openForkSelector`, and `openThemeSelector` (migrated off
	 * `modals.select` for consistency -- task 10) present through this instead
	 * of `modals.select(...)`, so they render in the editor's band with the
	 * transcript/chrome still visible instead of a full-screen `ModalLayer`
	 * backdrop. `openResumeSelector` and `openTreeBrowser` (session-reader-backed,
	 * added in plan 035 phase 1) also use this surface. `modals` is kept for
	 * confirm/input and the genuinely-blocking approval/confirm/input flows
	 * elsewhere in the host -- only these selectors moved.
	 */
	readonly inlineSelectors: HostInlineSelectors;
	readonly notifications: HostNotifications;
	readonly editorText?: EditorTextController;
	readonly createMemoryClient?: MemoryClientFactory;
	readonly onStateChange?: (state?: RpcHostChromeState) => void;
	readonly onRenderRequest?: () => void;
	readonly onExitRequest?: (code: number) => void;
	/**
	 * Writes a raw OSC52 clipboard sequence to the real terminal, for `/copy`.
	 * Mirrors the B10 selection-copy path (`SelectionController`'s
	 * `emitClipboard` in `shell-adapter.ts`), which writes through
	 * `ShellTerminalSessionOwner.writeClipboardSequence`. `RpcHostActions` has
	 * no direct handle on the terminal owner (that lives on `RpcHostRuntime`),
	 * so `host.ts` wires this callback through instead. Returns `true` when the
	 * sequence was actually written (a real TTY), `false` otherwise (matches
	 * `writeClipboardSequence`'s own return contract).
	 */
	readonly writeClipboardSequence?: (sequence: string) => boolean;
	/**
	 * SumoCode's own installation root (host.ts's `hostRoot`, i.e.
	 * `SUMOCODE_ROOT_DIR` or `process.cwd()` at launch -- the directory
	 * `src/extension.ts` resolves from, NOT the user's project `cwd`). `/changelog`
	 * reads `CHANGELOG.md` from here so it works regardless of which project
	 * directory the host was launched against.
	 */
	readonly changelogRoot?: string;
	/**
	 * Called after a session operation (new/switch/clone/fork) succeeds, so the
	 * host can refetch `get_messages` from the child and push a fresh transcript
	 * into the runtime. Without this the old session's messages stay on screen
	 * ("ghost transcript") after switching sessions. Not called when the
	 * operation is cancelled or throws.
	 */
	readonly rehydrateTranscript?: () => Promise<void>;
}

const THINKING_LEVELS: readonly RpcThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

export const RPC_HOST_SLASH_COMMANDS: readonly RpcHostSlashCommand[] = Object.freeze([
	{ name: "settings", description: "Open RPC settings" },
	{ name: "model", description: "Select model or set provider/model" },
	{ name: "thinking", description: "Select thinking level" },
	{ name: "theme", description: "Select SumoCode theme" },
	{ name: "sumo:theme", description: "Select SumoCode theme" },
	{ name: "compact", description: "Manually compact the session context" },
	{ name: "new", description: "Start a new session" },
	{ name: "clone", description: "Duplicate the current session" },
	{ name: "fork", description: "Fork from a previous user message" },
	{ name: "sessions", description: "Open session controls" },
	{ name: "resume", description: "Resume a previous session from this project" },
	{ name: "tree", description: "Browse the session branch tree and fork from a node" },
	{ name: "session", description: "Show session info and stats" },
	{ name: "name", description: "Rename the current session" },
	{ name: "copy", description: "Copy the last assistant response to the clipboard" },
	{ name: "export", description: "Export the session transcript to HTML" },
	{ name: "quit", description: "Quit SumoCode" },
	{ name: "sumo:memory", description: "Open or update SumoCode memory" },
	{ name: "sumo:theme-check", description: "Preview current theme tokens" },
	{ name: "sumo:approval", description: "Preview approval overlay" },
	{ name: "sumo:palette", description: "Open the command palette" },
	{ name: "hotkeys", description: "Show the RPC host's keyboard shortcuts" },
	{ name: "changelog", description: "Show SumoCode's changelog" },
]);

const RPC_HOST_SLASH_COMMAND_NAMES = new Set(RPC_HOST_SLASH_COMMANDS.map((command) => command.name));

export function isRpcHostSlashCommandName(name: string): boolean {
	return RPC_HOST_SLASH_COMMAND_NAMES.has(normalizeCommandName(name));
}

function notify(notifications: HostNotifications, message: string, level: NotificationLevel = "info"): void {
	notifications.notify(message, level);
}

function modelSelectorItem(model: RpcModelOption): InlineSelectorItem {
	return { value: model.label, label: model.label, isCurrent: model.active };
}

function parseModelLabel(label: string): { provider: string; id: string } | undefined {
	const cleaned = label.replace(/^Current:\s*/i, "");
	const slash = cleaned.indexOf("/");
	if (slash <= 0) return undefined;
	return { provider: cleaned.slice(0, slash), id: cleaned.slice(slash + 1) };
}

function firstArg(input: string): { command: string; args: string } {
	const trimmed = input.trim();
	const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(trimmed);
	return { command: match?.[1]?.toLowerCase() ?? "", args: match?.[2] ?? "" };
}

function normalizeCommandName(name: string): string {
	return name.trim().replace(/^\/+/, "").toLowerCase();
}

function ansi(hex: string, channel: 38 | 48): string {
	const normalized = hex.replace("#", "");
	const r = parseInt(normalized.slice(0, 2), 16);
	const g = parseInt(normalized.slice(2, 4), 16);
	const b = parseInt(normalized.slice(4, 6), 16);
	return `\u001b[${channel};2;${r};${g};${b}m`;
}

function color(text: string, hex: string): string {
	return `${ansi(hex, 38)}${text}\u001b[39m`;
}

function colorBg(text: string, hex: string): string {
	return `${ansi(hex, 48)}${text}\u001b[49m`;
}

function slotColor(slot: ThemeFgSlot): string {
	const colors = activeThemeColors();
	if (slot === "accent" || slot === "borderAccent" || slot.startsWith("md") || slot.startsWith("syntax")) return colors.accent;
	if (slot === "success" || slot === "thinkingOff" || slot === "thinkingMinimal") return colors.states.idle;
	if (slot === "warning" || slot === "thinkingText" || slot === "thinkingLow" || slot === "thinkingMedium" || slot === "thinkingHigh" || slot === "thinkingXhigh") return colors.states.thinking;
	if (slot === "error") return colors.states.approval;
	if (slot === "border" || slot === "borderMuted" || slot === "mdHr" || slot === "mdQuoteBorder" || slot === "toolDiffContext") return colors.divider;
	if (slot === "muted" || slot === "dim" || slot === "toolOutput" || slot === "bashMode") return colors.foregroundDim;
	if (slot === "toolDiffAdded") return colors.states.learning;
	if (slot === "toolDiffRemoved") return colors.states.approval;
	return colors.foreground;
}

function bgSlotColor(slot: ThemeBgSlot): string {
	const colors = activeThemeColors();
	if (slot === "selectedBg") return colors.surfaceLifted;
	if (slot === "toolErrorBg") return colors.states.approval;
	if (slot === "toolSuccessBg") return colors.states.learning;
	return colors.surface;
}

function themeReader(): ThemeReader {
	return {
		fg: (slot, text) => color(text, slotColor(slot)),
		bg: (slot, text) => colorBg(color(text, activeThemeColors().foreground), bgSlotColor(slot)),
	};
}

function formatInteger(value: number): string {
	return Number.isFinite(value) ? Math.round(value).toLocaleString("en-US") : "0";
}

function formatCost(value: number): string {
	if (!Number.isFinite(value)) return "$0.00";
	return `$${value.toFixed(value > 0 && value < 0.01 ? 4 : 2)}`;
}

/**
 * `/session` -- renders the FULL `get_session_stats` payload (message
 * breakdown, token breakdown, cost, context window usage, session file) as a
 * multi-line panel, replacing the old one-line toast. Modeled on
 * `openThemeCheck`'s `LinesOverlayComponent`.
 */
function renderSessionPanel(theme: ThemeReader, stats: RpcSessionStats, width: number): string[] {
	const heading = (text: string) => theme.fg("accent", text);
	const dim = (text: string) => theme.fg("muted", text);
	const row = (label: string, value: string) => `  ${theme.fg("muted", label.padEnd(16))} ${value}`;

	const lines: string[] = [];
	lines.push(heading("SESSION"));
	lines.push("");
	lines.push(row("Session ID", stats.sessionId));
	if (stats.sessionFile) lines.push(row("File", stats.sessionFile));
	lines.push("");
	lines.push(heading("MESSAGES"));
	lines.push(row("Total", formatInteger(stats.totalMessages)));
	lines.push(row("User", formatInteger(stats.userMessages)));
	lines.push(row("Assistant", formatInteger(stats.assistantMessages)));
	lines.push(row("Tool calls", formatInteger(stats.toolCalls)));
	lines.push(row("Tool results", formatInteger(stats.toolResults)));
	lines.push("");
	lines.push(heading("TOKENS"));
	lines.push(row("Input", formatInteger(stats.tokens.input)));
	lines.push(row("Output", formatInteger(stats.tokens.output)));
	lines.push(row("Cache read", formatInteger(stats.tokens.cacheRead)));
	lines.push(row("Cache write", formatInteger(stats.tokens.cacheWrite)));
	lines.push(row("Total", formatInteger(stats.tokens.total)));
	lines.push("");
	lines.push(heading("COST"));
	lines.push(row("Session cost", formatCost(stats.cost)));
	if (stats.contextUsage) {
		lines.push("");
		lines.push(heading("CONTEXT WINDOW"));
		const used = stats.contextUsage.tokens;
		const percent = stats.contextUsage.percent;
		lines.push(row("Used", used === null ? "unknown" : formatInteger(used)));
		lines.push(row("Window", formatInteger(stats.contextUsage.contextWindow)));
		lines.push(row("Percent", percent === null ? "unknown" : `${percent.toFixed(1)}%`));
	}
	lines.push("");
	lines.push(dim("Press any key to close."));
	return lines.map((line) => (line.length > width ? line.slice(0, width) : line));
}

/**
 * `/hotkeys` -- documents the RPC HOST's own keymap, not Pi's. The host owns
 * terminal input routing end-to-end (`RpcHostRuntime`'s `handleInput` ->
 * `createRpcHostInterruptHandler`/`RpcShellAdapter`), so these bindings are
 * SumoCode's, verified against:
 *  - `RPC_HOST_COMMAND_PALETTE_INPUT`/`Key.ctrl("/")` (this file's
 *    `handleInput`) for the command palette.
 *  - `decideRpcInterrupt` (interrupt.ts) for the Ctrl-C tiers: a modal/overlay
 *    dismisses first, then a non-empty draft clears, then an in-flight stream
 *    aborts, then a first press arms quit and a second press (within the
 *    armed window) actually quits.
 *  - `chatScrollCommandFromKey`/`chatScrollCommandFromInput`
 *    (widgets/chat-scroll-command.ts) for the transcript scroll keys.
 *  - `isCopyKey` (input/selection.ts) for the selection-copy binding the B10
 *    OSC52 path uses.
 * Modeled on `openThemeCheck`'s `LinesOverlayComponent` (static content
 * overlay, closes on any key) rather than inventing new overlay machinery.
 */
function renderHotkeysOverlay(theme: ThemeReader, width: number): string[] {
	const heading = (text: string) => theme.fg("accent", text);
	const dim = (text: string) => theme.fg("muted", text);
	const row = (keys: string, description: string) => `  ${theme.fg("borderAccent", keys.padEnd(18))} ${description}`;

	const lines: string[] = [];
	lines.push(heading("SUMOCODE RPC HOST HOTKEYS"));
	lines.push("");
	lines.push(heading("GLOBAL"));
	lines.push(row("Ctrl+/", "Open the command palette"));
	lines.push("");
	lines.push(heading("INTERRUPT (Ctrl-C / Escape)"));
	lines.push(row("Ctrl-C / Esc", "Dismiss an open modal, overlay, or selector"));
	lines.push(row("Ctrl-C", "Clear a non-empty draft"));
	lines.push(row("Ctrl-C / Esc", "Abort an in-flight response"));
	lines.push(row("Ctrl-C (1st)", "Arm quit (press again to confirm)"));
	lines.push(row("Ctrl-C (2nd)", "Quit SumoCode"));
	lines.push(dim("  Esc alone never quits -- only Ctrl-C arms/confirms exit."));
	lines.push("");
	lines.push(heading("TRANSCRIPT SCROLL"));
	lines.push(row("PageUp / PageDown", "Scroll the transcript by a page"));
	lines.push(row("Home", "Jump to the top of the transcript"));
	lines.push(row("End / Shift+Down", "Jump to the bottom of the transcript"));
	lines.push("");
	lines.push(heading("SELECTOR / EDITOR"));
	lines.push(row("Up / Down", "Move the selection in an open selector"));
	lines.push(row("Enter", "Confirm the highlighted selector option"));
	lines.push(row("Esc", "Cancel the open selector, return to the editor"));
	lines.push(row("Cmd/Ctrl+C", "Copy the current terminal selection (OSC52)"));
	lines.push("");
	lines.push(dim("Press any key to close."));
	return lines.map((line) => (line.length > width ? line.slice(0, width) : line));
}

function resumeSessionLabel(session: SessionListInfo): string {
	const when = Number.isNaN(session.modified.getTime()) ? "" : session.modified.toISOString().slice(0, 16).replace("T", " ");
	const title = session.name?.trim() || session.firstMessage.slice(0, 60);
	return `${when} — ${title} (${formatInteger(session.messageCount)}${session.truncatedScan ? "+" : ""} msgs)`;
}

interface TreeRow {
	readonly node: SessionTreeNode;
	readonly depth: number;
}

/** Depth-first flatten of `buildSessionTree`'s roots, preserving the oldest-first child order the port already sorts by. */
function flattenSessionTree(roots: readonly SessionTreeNode[]): TreeRow[] {
	const rows: TreeRow[] = [];
	const visit = (node: SessionTreeNode, depth: number): void => {
		rows.push({ node, depth });
		for (const child of node.children) visit(child, depth + 1);
	};
	for (const root of roots) visit(root, 0);
	return rows;
}

function entryMessageText(entry: SessionEntryLike): string | undefined {
	const message = entry.message as { role?: unknown; content?: unknown } | undefined;
	if (!message || typeof message !== "object" || typeof message.role !== "string") return undefined;
	const content = message.content;
	const text = typeof content === "string"
		? content
		: Array.isArray(content)
			? content
				.filter((block): block is { type: string; text: string } => typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text")
				.map((block) => block.text)
				.join(" ")
			: "";
	return text ? `${message.role}: ${text}` : undefined;
}

/** One-line summary for a tree row: label bookmark if present, else the message text, else the entry type. */
function treeNodeSummary(node: SessionTreeNode): string {
	const summary = node.label
		? `[${node.label}] `
		: "";
	const body = node.entry.type === "message" ? entryMessageText(node.entry) : undefined;
	return `${summary}${(body ?? node.entry.type).slice(0, 72)}`;
}

class LinesOverlayComponent implements Component {
	public constructor(
		private readonly renderLines: (width: number) => string[],
		private readonly done: () => void,
	) {}

	public invalidate(): void {}

	public handleInput(_data: string): void {
		this.done();
	}

	public render(width: number): string[] {
		return this.renderLines(width);
	}
}

class HostApprovalPreviewComponent implements Component {
	private snapshot: ApprovalModalSnapshot;

	public constructor(command: string, private readonly done: (choice: ApprovalChoice) => void) {
		this.snapshot = {
			command,
			descriptionLines: ["This is a host-side RPC approval preview."],
			activeButton: "no",
		};
	}

	public invalidate(): void {}

	public handleInput(data: string): void {
		const result = updateApprovalSnapshot(this.snapshot, data);
		this.snapshot = result.snapshot;
		if (result.done) this.done(result.done);
	}

	public render(width: number): string[] {
		return renderApprovalModal(this.snapshot, width);
	}
}

export class RpcHostActions {
	private readonly controls: RpcHostControls;
	private readonly stateStore: RpcHostStateStore;
	private readonly modals: HostModals;
	private readonly overlays: RpcHostOverlayManager;
	private readonly inlineSelectors: HostInlineSelectors;
	private readonly notifications: HostNotifications;
	private readonly editorText: EditorTextController | undefined;
	private readonly createMemoryClient: MemoryClientFactory;
	private readonly onStateChange: (state?: RpcHostChromeState) => void;
	private readonly onRenderRequest: () => void;
	private readonly onExitRequest: (code: number) => void;
	private readonly rehydrateTranscript: () => Promise<void>;
	private readonly writeClipboardSequence: (sequence: string) => boolean;
	private readonly changelogRoot: string;

	public constructor(options: RpcHostActionsOptions) {
		this.controls = options.controls;
		this.stateStore = options.stateStore;
		this.modals = options.modals;
		this.overlays = options.overlays;
		this.inlineSelectors = options.inlineSelectors;
		this.notifications = options.notifications;
		this.editorText = options.editorText;
		this.createMemoryClient = options.createMemoryClient ?? createRemnicMemoryClient;
		this.onStateChange = options.onStateChange ?? (() => undefined);
		this.onRenderRequest = options.onRenderRequest ?? (() => undefined);
		this.onExitRequest = options.onExitRequest ?? (() => undefined);
		this.rehydrateTranscript = options.rehydrateTranscript ?? (() => Promise.resolve());
		this.writeClipboardSequence = options.writeClipboardSequence ?? (() => false);
		this.changelogRoot = options.changelogRoot ?? process.cwd();
	}

	public handleInput(data: string): boolean {
		if (data === RPC_HOST_COMMAND_PALETTE_INPUT || data === "ctrl+/" || matchesKey(data, Key.ctrl("/"))) {
			void notifyOnError(() => this.openCommandPalette(), this.notifications);
			return true;
		}
		return false;
	}

	public async handleSubmittedText(text: string): Promise<boolean> {
		const { command, args } = firstArg(text);
		if (!command.startsWith("/")) return false;
		switch (command) {
			case "/model":
				if (args.trim()) await this.setModelFromText(args.trim());
				else await this.openModelSelector();
				return true;
			case "/thinking":
				if (args.trim()) await this.setThinkingFromText(args.trim());
				else await this.openThinkingSelector();
				return true;
			case "/theme":
			case "/sumo:theme":
				if (args.trim()) this.setThemeFromText(args.trim());
				else await this.openThemeSelector();
				return true;
			case "/compact":
				await this.compact(args.trim());
				return true;
			case "/new":
				await this.newSession();
				return true;
			case "/clone":
				await this.cloneSession();
				return true;
			case "/fork":
				await this.openForkSelector();
				return true;
			case "/session":
				await this.showSessionStats();
				return true;
			case "/sessions":
				await this.openSessionControls();
				return true;
			case "/name":
				await this.renameSession();
				return true;
			case "/settings":
				await this.openSettings();
				return true;
			case "/copy":
				await this.copyLastAssistantText();
				return true;
			case "/export":
				await this.exportHtml();
				return true;
			case "/resume":
				await this.openResumeSelector();
				return true;
			case "/tree":
				await this.openTreeBrowser();
				return true;
			case "/hotkeys":
				await this.openHotkeys();
				return true;
			case "/changelog":
				await this.openChangelog();
				return true;
			case "/quit":
				this.onExitRequest(0);
				return true;
			case "/sumo:memory":
				await this.handleMemoryCommand(args);
				return true;
			case "/sumo:theme-check":
				await this.openThemeCheck();
				return true;
			case "/sumo:approval":
				await this.openApprovalPreview();
				return true;
			case "/sumo:palette":
				await this.openCommandPalette();
				return true;
			default:
				if (command.startsWith("/")) {
					if (await this.childCanExecuteCommand(command)) return false;
					notify(this.notifications, `unknown command: ${command}`, "warning");
					return true;
				}
				return false;
		}
	}

	public async openCommandPalette(): Promise<void> {
		const selection = await this.overlays.show<PaletteMode | undefined>(
			"commandPalette",
			(done) => new CommandPaletteComponent(this.buildPaletteSnapshot(), done),
		);
		await this.handlePaletteSelection(selection);
	}

	public async handlePaletteSelection(selection: PaletteMode | undefined): Promise<void> {
		if (selection === undefined) return;
		if (selection === "MODEL") await this.openModelSelector();
		else if (selection === "THINKING") await this.openThinkingSelector();
		else if (selection === "SESSION") await this.openSessionControls();
		else if (selection === "MEMORY") await this.openMemoryEditor();
		else if (selection === "THEME") await this.openThemeSelector();
		else if (selection === "SETTINGS") await this.openSettings();
	}

	public async openModelSelector(): Promise<void> {
		const models = await this.controls.getAvailableModels();
		if (models.length === 0) {
			notify(this.notifications, "no models available", "warning");
			return;
		}
		const items = models.map(modelSelectorItem);
		const selected = await this.inlineSelectors.select("Choose model", items);
		if (selected === undefined) return;
		const parsed = parseModelLabel(selected);
		if (!parsed) {
			notify(this.notifications, `unknown model: ${selected}`, "warning");
			return;
		}
		await this.controls.setModel(parsed.provider, parsed.id);
		this.onStateChange();
		notify(this.notifications, `model: ${parsed.provider}/${parsed.id}`, "info");
	}

	public async openThinkingSelector(): Promise<void> {
		const currentLevel = this.stateStore.getSnapshot().thinkingLevel;
		const items: InlineSelectorItem[] = THINKING_LEVELS.map((level) => ({
			value: level,
			label: level,
			isCurrent: level === currentLevel,
		}));
		const selected = await this.inlineSelectors.select("Set thinking level", items);
		if (selected === undefined) return;
		await this.setThinkingFromText(selected);
	}

	public async openThemeSelector(): Promise<void> {
		const currentTheme = getActiveTheme().name;
		const items: InlineSelectorItem[] = listThemes().map((theme) => ({
			value: theme.name,
			label: theme.name,
			isCurrent: theme.name === currentTheme,
		}));
		const selected = await this.inlineSelectors.select("Choose SumoCode theme", items);
		if (selected) this.setThemeFromText(selected);
	}

	public async openSessionControls(): Promise<void> {
		const selected = await this.inlineSelectors.select("Session controls", [
			"New session",
			"Switch session by path",
			"Fork from message",
			"Clone session",
			"Rename session",
		]);
		if (selected === "New session") await this.newSession();
		else if (selected === "Switch session by path") await this.switchSessionByPath();
		else if (selected === "Fork from message") await this.openForkSelector();
		else if (selected === "Clone session") await this.cloneSession();
		else if (selected === "Rename session") await this.renameSession();
	}

	public async openSettings(): Promise<void> {
		const selected = await this.inlineSelectors.select("RPC settings", [
			"Enable auto compaction",
			"Disable auto compaction",
			"Enable auto retry",
			"Disable auto retry",
		]);
		if (selected === "Enable auto compaction") await this.setAutoCompaction(true);
		else if (selected === "Disable auto compaction") await this.setAutoCompaction(false);
		else if (selected === "Enable auto retry") await this.setAutoRetry(true);
		else if (selected === "Disable auto retry") await this.setAutoRetry(false);
	}

	public async openForkSelector(): Promise<void> {
		const messages = await this.controls.getForkMessages();
		if (messages.length === 0) {
			notify(this.notifications, "no forkable messages", "warning");
			return;
		}
		const items: InlineSelectorItem[] = messages.map((message, index) => ({
			value: message.entryId,
			label: `${index + 1}. ${message.text.slice(0, 72)}`,
		}));
		const selected = await this.inlineSelectors.select("Fork from message", items);
		if (!selected) return;
		const message = messages.find((candidate) => candidate.entryId === selected);
		if (!message) return;
		const result = await this.controls.fork(message.entryId);
		if (!result.cancelled) {
			if (result.text) this.editorText?.setText(result.text);
			await this.rehydrateTranscript();
		}
		this.onStateChange();
	}

	/**
	 * `/resume` -- lists every session (`.jsonl` file) sitting alongside the
	 * current one on disk and lets the user pick one to load. Pi's RPC surface
	 * has no "list sessions" verb, so this reads the session directory
	 * directly (`session-reader.ts`'s `listSessions`, a faithful port of Pi's
	 * own `SessionManager.list`/`buildSessionInfo`), deriving the directory
	 * from `sessionFile` (threaded through `get_state` -- see state.ts). The
	 * chosen path is loaded through the existing `switch_session` control, the
	 * same path `/sessions` -> "Switch session by path" already uses, so
	 * rehydration/state-refresh behavior is identical.
	 */
	public async openResumeSelector(): Promise<void> {
		const sessionFile = this.stateStore.getSnapshot().sessionFile;
		if (!sessionFile) {
			notify(this.notifications, "no session file available to resume from", "warning");
			return;
		}
		const sessions = await listSessions(dirname(sessionFile));
		if (sessions.length === 0) {
			notify(this.notifications, "no sessions found", "warning");
			return;
		}
		const labels = sessions.map((session) => resumeSessionLabel(session));
		const items: InlineSelectorItem[] = sessions.map((session, index) => ({
			value: session.path,
			label: labels[index]!,
			isCurrent: session.path === sessionFile,
		}));
		const selected = await this.inlineSelectors.select("Resume session", items);
		if (!selected) return;
		const session = sessions.find((candidate) => candidate.path === selected);
		if (!session) return;
		const result = await this.controls.switchSession(session.path);
		if (!result.cancelled) {
			await this.controls.refreshState();
			await this.rehydrateTranscript();
			this.onStateChange();
			notify(this.notifications, "session resumed", "info");
		}
	}

	/**
	 * `/tree` -- browses the current session's branch structure (ported via
	 * `session-reader.ts`'s `buildSessionTree`, a faithful copy of Pi's
	 * `SessionManager.getTree()`). RPC has no "navigate to node" verb (that's
	 * Phase 3, tracked separately -- switching the LEAF pointer without loading
	 * a whole session isn't exposed here), so the only real action on a picked
	 * node is forking from it via the existing `fork(entryId)` control. The
	 * selector option for each row is explicitly labeled "Fork from ..." so
	 * this doesn't read as a fake in-place jump.
	 */
	public async openTreeBrowser(): Promise<void> {
		const sessionFile = this.stateStore.getSnapshot().sessionFile;
		if (!sessionFile) {
			notify(this.notifications, "no session file available to browse", "warning");
			return;
		}
		const tree = await buildSessionTree(sessionFile);
		if (!tree) {
			notify(this.notifications, "session tree unavailable", "warning");
			return;
		}
		if (tree.length === 0) {
			notify(this.notifications, "session has no entries yet", "warning");
			return;
		}
		const rows = flattenSessionTree(tree);
		const items: InlineSelectorItem[] = rows.map((row) => ({
			value: row.node.entry.id,
			label: `${"  ".repeat(row.depth)}Fork from: ${treeNodeSummary(row.node)}`,
		}));
		const selected = await this.inlineSelectors.select("Session tree (fork from a node)", items);
		if (!selected) return;
		const row = rows.find((candidate) => candidate.node.entry.id === selected);
		if (!row) return;
		const result = await this.controls.fork(row.node.entry.id);
		if (!result.cancelled) {
			if (result.text) this.editorText?.setText(result.text);
			await this.rehydrateTranscript();
		}
		this.onStateChange();
	}

	public async openThemeCheck(): Promise<void> {
		await this.overlays.show<void>(
			"themeCheck",
			(done) => new LinesOverlayComponent(
				(width) => renderThemeCheck(themeReader(), Math.max(40, Math.min(width, 120))),
				done,
			),
		);
	}

	public async openHotkeys(): Promise<void> {
		await this.overlays.show<void>(
			"hotkeys",
			(done) => new LinesOverlayComponent(
				(width) => renderHotkeysOverlay(themeReader(), Math.max(40, Math.min(width, 120))),
				done,
			),
		);
	}

	/**
	 * `/changelog` -- reads and renders SumoCode's own `CHANGELOG.md` (repo
	 * root, resolved from `changelogRoot`, NOT the user's project `cwd`) as an
	 * overlay. Plain local file read; no RPC round-trip needed.
	 */
	public async openChangelog(): Promise<void> {
		let content: string;
		try {
			content = readFileSync(join(this.changelogRoot, "CHANGELOG.md"), "utf8");
		} catch {
			notify(this.notifications, "CHANGELOG.md not found", "warning");
			return;
		}
		const lines = content.split("\n");
		await this.overlays.show<void>(
			"changelog",
			(done) => new LinesOverlayComponent(
				(width) => lines.map((line) => (line.length > width ? line.slice(0, width) : line)),
				done,
			),
		);
	}

	public async openApprovalPreview(command = "rm -rf node_modules/"): Promise<void> {
		const choice = await this.overlays.show<ApprovalChoice>(
			"approvalPreview",
			(done) => new HostApprovalPreviewComponent(command, done),
		);
		notify(this.notifications, `approval selected: ${choice}`, choice === "no" ? "warning" : "info");
	}

	public async openMemoryEditor(): Promise<void> {
		let facts: MemoryFact[];
		const client = this.createMemoryClient();
		try {
			facts = await client.browse({ status: "active", limit: 500 });
		} catch (error) {
			const message = error instanceof MemoryClientError ? error.message : String(error);
			notify(this.notifications, `memory unavailable: ${message}`, "warning");
			return;
		}
		const initial: MemoryEditorSnapshot = {
			searchQuery: "",
			groups: groupFactsByPanel(facts),
			factsTotal: facts.length,
			focusedFactId: null,
		};
		await this.overlays.show<void>(
			"memoryEditor",
			(done) => new MemoryEditorComponent(initial, {
				client,
				notify: (message, level) => notify(this.notifications, message, level ?? "info"),
				invalidate: this.onRenderRequest,
				close: () => done(),
			}),
		);
	}

	public async handleMemoryCommand(args: string): Promise<void> {
		const { command, args: rest } = firstArg(args);
		const client = this.createMemoryClient();
		if (command === "" || command === "edit") {
			await this.openMemoryEditor();
			return;
		}
		if (command === "status") {
			await notifyOnError(async () => {
				notify(this.notifications, formatMemoryStatus(await client.status()), "info");
			}, this.notifications);
			return;
		}
		if (command === "add") {
			const text = rest.trim();
			if (!text) {
				notify(this.notifications, "usage: /sumo:memory add <text>", "info");
				return;
			}
			await notifyOnError(async () => {
				await client.add(text);
				notify(this.notifications, `memory added: ${text.slice(0, 40)}${text.length > 40 ? "…" : ""}`, "info");
			}, this.notifications);
			return;
		}
		if (command === "forget") {
			const id = rest.trim();
			if (!id) {
				notify(this.notifications, "usage: /sumo:memory forget <fact-id>", "info");
				return;
			}
			await notifyOnError(async () => {
				await client.forget(id);
				notify(this.notifications, `memory forgotten: ${id}`, "info");
			}, this.notifications);
			return;
		}
		notify(this.notifications, "usage: /sumo:memory [edit|add <text>|forget <id>|status]", "info");
	}

	private buildPaletteSnapshot(): CommandPaletteSnapshot {
		const state = this.stateStore.getSnapshot();
		return {
			searchQuery: "",
			activeIndex: 1,
			rows: [
				{ label: "SESSION", currentValue: state.sessionName ?? state.sessionId ?? "current session" },
				{ label: "MODEL", currentValue: state.modelLabel ?? "model pending" },
				{ label: "THINKING", currentValue: state.thinkingLevel ?? "medium" },
				{ label: "MEMORY", currentValue: "host" },
				{ label: "THEME", currentValue: getActiveTheme().name },
				{ label: "SETTINGS", currentValue: "host controls" },
			],
		};
	}

	private async setModelFromText(value: string): Promise<void> {
		const parsed = parseModelLabel(value);
		if (!parsed) {
			notify(this.notifications, "usage: /model <provider/model>", "warning");
			return;
		}
		await this.controls.setModel(parsed.provider, parsed.id);
		this.onStateChange();
		notify(this.notifications, `model: ${parsed.provider}/${parsed.id}`, "info");
	}

	private async setThinkingFromText(value: string): Promise<void> {
		const level = value.trim().toLowerCase() as RpcThinkingLevel;
		if (!THINKING_LEVELS.includes(level)) {
			notify(this.notifications, `unknown thinking level: ${value}`, "warning");
			return;
		}
		await this.controls.setThinkingLevel(level);
		this.onStateChange();
		notify(this.notifications, `thinking: ${level}`, "info");
	}

	private setThemeFromText(value: string): void {
		const result = setActiveTheme(value);
		if (!result.success) {
			notify(this.notifications, result.error, "warning");
			return;
		}
		this.onRenderRequest();
		notify(this.notifications, `theme: ${result.theme.name}`, "info");
	}

	private async compact(instructions: string): Promise<void> {
		await this.controls.compact(instructions.length > 0 ? instructions : undefined);
		this.onStateChange();
		notify(this.notifications, "compaction requested", "info");
	}

	private async newSession(): Promise<void> {
		const result = await this.controls.newSession();
		if (!result.cancelled) {
			await this.controls.refreshState();
			await this.rehydrateTranscript();
			this.onStateChange();
			notify(this.notifications, "new session", "info");
		}
	}

	private async switchSessionByPath(): Promise<void> {
		const path = await this.modals.input("Switch session", "path to session jsonl");
		const trimmed = path?.trim() ?? "";
		if (!trimmed) return;
		const result = await this.controls.switchSession(trimmed);
		if (!result.cancelled) {
			await this.controls.refreshState();
			await this.rehydrateTranscript();
			this.onStateChange();
			notify(this.notifications, "session switched", "info");
		}
	}

	private async cloneSession(): Promise<void> {
		const result = await this.controls.clone();
		if (!result.cancelled) {
			await this.controls.refreshState();
			await this.rehydrateTranscript();
			this.onStateChange();
			notify(this.notifications, "session cloned", "info");
		}
	}

	private async showSessionStats(): Promise<void> {
		const stats = await this.controls.getSessionStats();
		this.stateStore.hydrateFromSessionStats(stats);
		this.onStateChange();
		await this.overlays.show<void>(
			"session",
			(done) => new LinesOverlayComponent(
				(width) => renderSessionPanel(themeReader(), stats, Math.max(40, Math.min(width, 120))),
				done,
			),
		);
	}

	private async copyLastAssistantText(): Promise<void> {
		const text = await this.controls.getLastAssistantText();
		if (!text) {
			notify(this.notifications, "no assistant response to copy", "warning");
			return;
		}
		const sequence = tryCreateOsc52Sequence(text);
		if (!sequence.ok) {
			notify(this.notifications, "response too large to copy", "warning");
			return;
		}
		const wrote = this.writeClipboardSequence(sequence.sequence);
		if (!wrote) {
			notify(this.notifications, "copy unavailable (not a TTY)", "warning");
			return;
		}
		notify(this.notifications, "copied", "success");
	}

	private async exportHtml(): Promise<void> {
		const result = await this.controls.exportHtml();
		notify(this.notifications, `exported: ${result.path}`, "info");
	}

	private async renameSession(): Promise<void> {
		const name = await this.modals.input("Rename session", "session name");
		const trimmed = name?.trim() ?? "";
		if (!trimmed) return;
		const state = await this.controls.setSessionName(trimmed);
		this.onStateChange(state);
		notify(this.notifications, `session name: ${trimmed}`, "info");
	}

	private async setAutoCompaction(enabled: boolean): Promise<void> {
		await this.controls.setAutoCompaction(enabled);
		notify(this.notifications, `auto compaction ${enabled ? "enabled" : "disabled"}`, "info");
	}

	private async setAutoRetry(enabled: boolean): Promise<void> {
		await this.controls.setAutoRetry(enabled);
		this.onStateChange();
		notify(this.notifications, `auto retry ${enabled ? "enabled" : "disabled"}`, "info");
	}

	private async childCanExecuteCommand(command: string): Promise<boolean> {
		const name = normalizeCommandName(command);
		if (!name) return false;
		const commands = await this.controls.getCommands();
		return commands.some((childCommand) => normalizeCommandName(childCommand.name) === name);
	}
}
