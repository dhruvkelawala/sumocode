import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import type { Component } from "@earendil-works/pi-tui";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import {
	CommandPaletteComponent,
	type CommandPaletteSnapshot,
	type PaletteMode,
} from "../../command-palette.js";
import {
	createRemnicMemoryClient,
	MemoryClientError,
	type MemoryFact,
	type RemnicMemoryClient,
} from "../../memory.js";
import { isBackgroundTaskWakeMessage } from "../../background-tasks/task-types.js";
import { groupFactsByPanel } from "../../memory-categorization.js";
import {
	MemoryEditorComponent,
	formatMemoryStatus,
	type MemoryEditorSnapshot,
} from "../../memory-editor.js";
import { renderThemeCheck, type ThemeBgSlot, type ThemeFgSlot, type ThemeReader } from "../../theme-check.js";
import { activeThemeColors, getActiveTheme, listThemes, nextThemeName, setActiveTheme } from "../../themes/index.js";
import { saveSumoCodeConfigPatch } from "../../config/sumocode-config.js";
import { tryCreateOsc52Sequence } from "../input/selection.js";
import type { EditorTextController } from "../pi-compat/extension-ui-adapter.js";
import type { ModalManager } from "../widgets/modal.js";
import type { NotificationCenter, NotificationLevel } from "../widgets/notification.js";
import type { RpcHostControls, RpcModelOption, RpcSessionStats, RpcThinkingLevel } from "./controls.js";
import { validateRpcTreeNavigationRequest, type RpcTreeNavigationOutcome, type RpcTreeNavigationRequest } from "../pi-compat/tree-navigation-command.js";
import type { RpcHostOverlayManager } from "./host-overlays.js";
import {
	LOVELY_WEB_API_KEY_FIELDS,
	LOVELY_WEB_FETCH_PROVIDERS,
	LOVELY_WEB_SEARCH_PROVIDERS,
	loadLovelyWebConfig,
	lovelyWebApiKeyPatch,
	lovelyWebConfigPathForDisplay,
	readLovelyWebPatch,
	updateLovelyWebConfigValue,
	withoutLovelyWebApiKeys,
	writeLovelyWebPatch,
	type LovelyWebConfigKey,
	type LovelyWebConfigScope,
} from "./lovely-web-config.js";
import type { InlineSelectorHost, InlineSelectorItem } from "./inline-selector.js";
import { notifyOnError } from "./safe-send.js";
import { logDiagnostic } from "../runtime/diagnostics.js";
import { listSessions, type SessionListInfo } from "./session-reader.js";
import { buildSessionTreeFromEntries, currentTreeSelection, entryTimestampsFromEntries, flattenSessionTree, formatRelativeTime, sessionExcerpt, treeNodeSummary, treeRowTimestamp } from "./session-tree.js";
import { readAuthoritativeSessionSnapshot } from "./session-snapshot.js";
import type { RpcHostChromeState, RpcHostStateStore } from "./state.js";

export const RPC_HOST_COMMAND_PALETTE_INPUT = "\u001f";

export interface RpcHostSlashCommand {
	readonly name: string;
	readonly description: string;
}

type HostModals = Pick<ModalManager, "select" | "confirm" | "input" | "editor">;
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
	 * confirm/input flows elsewhere in the host -- only these selectors moved.
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
	 * ("ghost transcript") after switching sessions. Cancellation also uses the
	 * authoritative refresh because child events were suppressed while pending.
	 */
	readonly rehydrateTranscript?: () => Promise<void>;
	/** Enter fail-closed rendering immediately before a session-changing RPC. */
	readonly beforeSessionChange?: () => void;
	/** Restore the previous presentation only when a cancelled-operation refresh fails before rebinding. */
	readonly cancelSessionChange?: () => void;
	/** Shared successful new/switch/clone/fork seam. Defaults to refresh + transcript rehydrate. */
	readonly afterSessionChange?: () => Promise<void>;
	/** Reconcile events suppressed while an explicitly cancelled operation was pending. */
	readonly afterCancelledSessionChange?: () => Promise<void>;
	/** Prepare and reconcile an in-place Pi tree mutation without rebinding session ownership. */
	readonly beforeTreeNavigation?: (request: RpcTreeNavigationRequest) => Promise<void>;
	readonly reconcileTreeNavigation?: (outcome?: RpcTreeNavigationOutcome) => Promise<void>;
	readonly setTreeNavigationBusy?: (busy: boolean) => void;
	readonly isTreeNavigationBusy?: () => boolean;
	/**
	 * Persists the chosen theme name to ~/.pi/agent/sumocode.json so the next
	 * boot's applyStartupTheme resolves it. Injectable so tests never write
	 * the developer's real config; production defaults to
	 * saveSumoCodeConfigPatch.
	 */
	readonly persistTheme?: (name: string) => { success: boolean; error?: string };
}

const FALLBACK_THINKING_LEVELS: readonly RpcThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export const RPC_HOST_SLASH_COMMANDS: readonly RpcHostSlashCommand[] = Object.freeze([
	{ name: "settings", description: "Open RPC settings" },
	{ name: "login", description: "Configure provider authentication" },
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
	{ name: "tree", description: "Browse and navigate the session branch tree" },
	{ name: "session", description: "Show session info and stats" },
	{ name: "name", description: "Rename the current session" },
	{ name: "copy", description: "Copy the last assistant response to the clipboard" },
	{ name: "export", description: "Export the session transcript to HTML" },
	{ name: "quit", description: "Quit SumoCode" },
	{ name: "sumo:memory", description: "Open or update SumoCode memory" },
	{ name: "sumo:theme-check", description: "Preview current theme tokens" },
	{ name: "sumo:palette", description: "Open the command palette" },
	{ name: "hotkeys", description: "Show the RPC host's keyboard shortcuts" },
	{ name: "lovely-web", description: "Configure Lovely Web web tools" },
	{ name: "changelog", description: "Show SumoCode's changelog" },
]);

export const RPC_HOST_ROUTED_CHILD_COMMANDS = Object.freeze(["mcp", "mcp-auth"] as const);
const RPC_HOST_SLASH_COMMAND_NAMES = new Set(RPC_HOST_SLASH_COMMANDS.map((command) => command.name));

export function isRpcHostSlashCommandName(name: string): boolean {
	return RPC_HOST_SLASH_COMMAND_NAMES.has(normalizeCommandName(name));
}

function notify(notifications: HostNotifications, message: string, level: NotificationLevel = "info"): void {
	notifications.notify(message, level);
}

function scopedValueDescription(scopeValue: unknown, effectiveValue: unknown): string {
	return scopeValue === undefined ? `${String(effectiveValue)} (inherited)` : String(scopeValue);
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

/**
 * One selector row per session: the NAME (or first-message excerpt) is the
 * label; the identifier lives in the right-aligned description — short
 * session id, message count, relative age — so two sessions with the same
 * title remain distinguishable (the old single-string label had no id at
 * all). Count and age are padded to per-list column widths so the
 * description blocks line up as real columns instead of a ragged edge.
 */
function resumeSessionRows(sessions: readonly SessionListInfo[], now: Date = new Date()): { label: string; description: string }[] {
	const counts = sessions.map((session) => `${formatInteger(session.messageCount)}${session.truncatedScan ? "+" : ""} ${session.messageCount === 1 && !session.truncatedScan ? "msg" : "msgs"}`);
	const ages = sessions.map((session) => formatRelativeTime(session.modified, now));
	const countWidth = Math.max(...counts.map((count) => count.length));
	const ageWidth = Math.max(...ages.map((age) => age.length));
	return sessions.map((session, index) => ({
		label: session.name?.trim() || sessionExcerpt(session.firstMessage, 52) || "(empty session)",
		description: `${session.id.slice(0, 8)} · ${counts[index]!.padStart(countWidth)} · ${ages[index]!.padStart(ageWidth)}`,
	}));
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
	private readonly beforeSessionChange: () => void;
	private readonly cancelSessionChange: () => void;
	private readonly afterSessionChange: () => Promise<void>;
	private readonly afterCancelledSessionChange: () => Promise<void>;
	private readonly beforeTreeNavigation: (request: RpcTreeNavigationRequest) => Promise<void>;
	private readonly reconcileTreeNavigation: (outcome?: RpcTreeNavigationOutcome) => Promise<void>;
	private readonly setTreeNavigationBusy: (busy: boolean) => void;
	private readonly isTreeNavigationBusy: () => boolean;
	private readonly writeClipboardSequence: (sequence: string) => boolean;
	private readonly changelogRoot: string;
	private readonly persistTheme: (name: string) => { success: boolean; error?: string };
	private loginActive = false;

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
		this.beforeSessionChange = options.beforeSessionChange ?? (() => undefined);
		this.cancelSessionChange = options.cancelSessionChange ?? (() => undefined);
		this.afterSessionChange = options.afterSessionChange ?? (async () => {
			await this.controls.refreshState();
			await this.rehydrateTranscript();
		});
		this.afterCancelledSessionChange = options.afterCancelledSessionChange ?? this.afterSessionChange;
		this.beforeTreeNavigation = options.beforeTreeNavigation ?? (async () => undefined);
		this.reconcileTreeNavigation = options.reconcileTreeNavigation ?? (async () => undefined);
		this.setTreeNavigationBusy = options.setTreeNavigationBusy ?? (() => undefined);
		this.isTreeNavigationBusy = options.isTreeNavigationBusy ?? (() => false);
		this.writeClipboardSequence = options.writeClipboardSequence ?? (() => false);
		this.changelogRoot = options.changelogRoot ?? process.cwd();
		this.persistTheme = options.persistTheme ?? ((name) => saveSumoCodeConfigPatch({ themeName: name }));
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
		if (this.isTreeNavigationBusy() && this.isTreeNavigationBlockedCommand(command)) {
			notify(this.notifications, "branch summary in progress", "warning");
			return true;
		}
		if (!command.startsWith("/")) return false;
		switch (command) {
			case "/mcp":
				if (!await this.requireChildCommand(command)) return true;
				await this.handleMcpCommand(args);
				return true;
			case "/mcp-auth":
				if (!await this.requireChildCommand(command)) return true;
				await this.authenticateMcpServer(args);
				return true;
			case "/login":
				if (this.loginActive) {
					notify(this.notifications, "login already in progress", "warning");
					return true;
				}
				this.loginActive = true;
				try {
					await this.controls.executeExtensionCommand(args.trim() ? `/login ${args.trim()}` : "/login");
				} catch (error) {
					// A host-side timeout/rejection does not cancel Pi's child command.
					// Abort it explicitly so the next /login is not blocked forever.
					try { await this.controls.cancelLogin(); } catch { /* preserve the original failure */ }
					throw error;
				} finally {
					this.loginActive = false;
				}
				return true;
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
			case "/lovely-web":
				await this.openLovelyWebConfig();
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
			case "/sumo:palette":
				await this.openCommandPalette();
				return true;
			default:
				if (command.startsWith("/")) {
					// Filesystem paths start with "/" too — e.g. an image-only submit
					// expands to /tmp/pi-clipboard-….png (see EditorImageDraftState).
					// Only single-segment /command[:sub] shapes are command attempts;
					// anything with a second slash is a prompt, not an unknown command
					// to swallow.
					if (!/^\/[\w:.-]+$/.test(command)) return false;
					if (await this.childCanExecuteCommand(command)) return false;
					notify(this.notifications, `unknown command: ${command}`, "warning");
					return true;
				}
				return false;
		}
	}

	private async handleMcpCommand(args: string): Promise<void> {
		const subcommand = args.trim();
		if (subcommand) {
			await this.controls.executeExtensionCommand(`/mcp ${subcommand}`);
			return;
		}

		// pi-mcp-adapter's bare /mcp opens ctx.ui.custom(), which Pi RPC does
		// not bridge. Present the actionable subset through retained primitives
		// and forward a concrete, non-custom command to the child extension.
		const action = await this.modals.select("MCP controls", [
			"authenticate server",
			"reconnect all servers",
			"list tools",
			"log out server",
		]);
		if (action === "authenticate server") await this.authenticateMcpServer("");
		else if (action === "reconnect all servers") await this.controls.executeExtensionCommand("/mcp reconnect");
		else if (action === "list tools") await this.controls.executeExtensionCommand("/mcp tools");
		else if (action === "log out server") {
			const serverName = (await this.modals.input("MCP server to log out", "server name"))?.trim();
			if (serverName) await this.controls.executeExtensionCommand(`/mcp logout ${serverName}`);
		}
	}

	private async authenticateMcpServer(args: string): Promise<void> {
		const serverName = args.trim() || (await this.modals.input("Authenticate MCP server", "server name"))?.trim();
		if (!serverName) return;
		await this.controls.executeExtensionCommand(`/mcp-auth ${serverName}`);
	}

	public isLoginActive(): boolean {
		return this.loginActive;
	}

	private isTreeNavigationBlockedCommand(command: string): boolean {
		return new Set([
			"/tree",
			"/fork",
			"/new",
			"/clone",
			"/resume",
			"/sessions",
			"/settings",
			"/compact",
			"/name",
			"/model",
			"/thinking",
			"/login",
			"/mcp",
			"/mcp-auth",
		]).has(command);
	}

	public async cancelLogin(): Promise<void> {
		if (!this.loginActive) return;
		await this.controls.cancelLogin();
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
		if (this.isTreeNavigationBusy()) {
			notify(this.notifications, "branch summary in progress", "warning");
			return;
		}
		const models = await this.controls.getEnabledModels();
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
		const state = await this.controls.setModel(parsed.provider, parsed.id);
		this.onStateChange(state);
	}

	public async openThinkingSelector(): Promise<void> {
		if (this.isTreeNavigationBusy()) {
			notify(this.notifications, "branch summary in progress", "warning");
			return;
		}
		const currentLevel = this.stateStore.getSnapshot().thinkingLevel;
		const levels = await this.availableThinkingLevels();
		const items: InlineSelectorItem[] = levels.map((level) => ({
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
		if (this.isTreeNavigationBusy()) {
			notify(this.notifications, "branch summary in progress", "warning");
			return;
		}
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
		if (this.isTreeNavigationBusy()) {
			notify(this.notifications, "branch summary in progress", "warning");
			return;
		}
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

	public async openLovelyWebConfig(): Promise<void> {
		const cwd = process.cwd();
		let state: ReturnType<typeof loadLovelyWebConfig>;
		try {
			state = loadLovelyWebConfig(cwd);
		} catch (error) {
			notify(this.notifications, `Lovely Web config error: ${error instanceof Error ? error.message : String(error)}`, "error");
			return;
		}
		const summary = `search ${state.value.webSearchProvider} · fetch ${state.value.webFetchProvider} · image ${state.value.webImageEnabled ? "on" : "off"}`;
		const selected = await this.inlineSelectors.select("Lovely Web config", [
			{ value: "user", label: "User config", description: lovelyWebConfigPathForDisplay(state.userPath) },
			{ value: "workspace", label: "Workspace config", description: lovelyWebConfigPathForDisplay(state.workspacePath) },
			{ value: "raw:user", label: "Raw user JSON", description: summary },
			{ value: "raw:workspace", label: "Raw workspace JSON", description: "project override" },
		]);
		if (selected === undefined) return;
		if (selected === "raw:user") {
			await this.openLovelyWebRawEditor("user", cwd);
			return;
		}
		if (selected === "raw:workspace") {
			await this.openLovelyWebRawEditor("workspace", cwd);
			return;
		}
		if (selected === "user" || selected === "workspace") await this.openLovelyWebScopeEditor(selected, cwd);
	}

	private async openLovelyWebScopeEditor(scope: LovelyWebConfigScope, cwd: string): Promise<void> {
		for (;;) {
			const state = loadLovelyWebConfig(cwd);
			const patch = scope === "user" ? state.userPatch : state.workspacePatch;
			const path = scope === "user" ? state.userPath : state.workspacePath;
			const selected = await this.inlineSelectors.select(`Lovely Web ${scope}`, [
				{ value: "webSearchProvider", label: "web_search provider", description: scopedValueDescription(patch.webSearchProvider, state.value.webSearchProvider) },
				{ value: "webFetchProvider", label: "web_fetch provider", description: scopedValueDescription(patch.webFetchProvider, state.value.webFetchProvider) },
				{ value: "webImageEnabled", label: "web_image", description: state.value.webImageEnabled ? "enabled" : "disabled" },
				{ value: "webImageResize", label: "resize images", description: state.value.webImageResize ? "enabled" : "disabled" },
				{ value: "webImageMaxSize", label: "max image size", description: String(state.value.webImageMaxSize) },
				{ value: "smartSearchEnabled", label: "smart search", description: state.value.smartSearchEnabled ? "enabled" : "disabled" },
				{ value: "smartSearchModel", label: "smart search model", description: state.value.smartSearchModel || "current/default" },
				{ value: "smartSearchMaxTokens", label: "smart search max tokens", description: String(state.value.smartSearchMaxTokens) },
				{ value: "smartSearchSystemPrompt", label: "smart search system prompt", description: state.value.smartSearchSystemPrompt ? "custom" : "built-in" },
				...(scope === "user" ? this.lovelyWebApiKeyItems(state.value) : []),
				{ value: "raw", label: "raw JSON", description: lovelyWebConfigPathForDisplay(path) },
				{ value: "done", label: "done", description: "close Lovely Web config" },
			]);
			if (selected === undefined || selected === "done") return;
			if (selected === "webSearchProvider") await this.setLovelyWebProvider(scope, cwd, "webSearchProvider", LOVELY_WEB_SEARCH_PROVIDERS, state.value.webSearchProvider);
			else if (selected === "webFetchProvider") await this.setLovelyWebProvider(scope, cwd, "webFetchProvider", LOVELY_WEB_FETCH_PROVIDERS, state.value.webFetchProvider);
			else if (selected === "webImageEnabled") this.saveLovelyWebValue(scope, cwd, "webImageEnabled", !state.value.webImageEnabled);
			else if (selected === "webImageResize") this.saveLovelyWebValue(scope, cwd, "webImageResize", !state.value.webImageResize);
			else if (selected === "webImageMaxSize") await this.setLovelyWebNumber(scope, cwd, "webImageMaxSize", state.value.webImageMaxSize, "Lovely Web max image size");
			else if (selected === "smartSearchEnabled") this.saveLovelyWebValue(scope, cwd, "smartSearchEnabled", !state.value.smartSearchEnabled);
			else if (selected === "smartSearchModel") await this.setLovelyWebString(scope, cwd, "smartSearchModel", "Lovely Web smart search model", "provider/model; blank for current/default");
			else if (selected === "smartSearchMaxTokens") await this.setLovelyWebNumber(scope, cwd, "smartSearchMaxTokens", state.value.smartSearchMaxTokens, "Lovely Web smart search max tokens");
			else if (selected === "smartSearchSystemPrompt") await this.setLovelyWebText(scope, cwd, "smartSearchSystemPrompt", state.value.smartSearchSystemPrompt, "Lovely Web smart search system prompt");
			else if (selected.startsWith("apiKey:")) await this.setLovelyWebApiKey(scope, cwd, selected.slice("apiKey:".length));
			else if (selected === "raw") await this.openLovelyWebRawEditor(scope, cwd);
		}
	}

	private lovelyWebApiKeyItems(value: { readonly firecrawlApiKey: string; readonly exaApiKey: string; readonly tavilyApiKey: string; readonly braveApiKey: string }): InlineSelectorItem[] {
		return (Object.entries(LOVELY_WEB_API_KEY_FIELDS) as Array<[string, LovelyWebConfigKey]>).map(([provider, key]) => ({
			value: `apiKey:${provider}`,
			label: `${provider} API key`,
			description: value[key as keyof typeof value] ? "set" : "unset",
		}));
	}

	private async setLovelyWebProvider(
		scope: LovelyWebConfigScope,
		cwd: string,
		key: "webSearchProvider" | "webFetchProvider",
		providers: readonly string[],
		current: string,
	): Promise<void> {
		const selected = await this.inlineSelectors.select(`Lovely Web ${key}`, providers.map((provider) => ({
			value: provider,
			label: provider,
			isCurrent: provider === current,
		})));
		if (selected === undefined) return;
		this.saveLovelyWebValue(scope, cwd, key, selected);
	}

	private async setLovelyWebNumber(scope: LovelyWebConfigScope, cwd: string, key: LovelyWebConfigKey, current: number, title: string): Promise<void> {
		const value = await this.modals.input(title, "positive number; blank to clear", { initialValue: String(current) });
		if (value === undefined) return;
		if (value.trim() === "") {
			this.saveLovelyWebValue(scope, cwd, key, undefined);
			return;
		}
		const numberValue = Number(value);
		if (!Number.isFinite(numberValue) || numberValue < 1) {
			notify(this.notifications, `${title}: enter a positive number`, "warning");
			return;
		}
		this.saveLovelyWebValue(scope, cwd, key, numberValue);
	}

	private async setLovelyWebString(scope: LovelyWebConfigScope, cwd: string, key: LovelyWebConfigKey, title: string, placeholder: string): Promise<void> {
		const value = await this.modals.input(title, placeholder);
		if (value === undefined) return;
		this.saveLovelyWebValue(scope, cwd, key, value.trim());
	}

	private async setLovelyWebText(scope: LovelyWebConfigScope, cwd: string, key: LovelyWebConfigKey, current: string, title: string): Promise<void> {
		const value = await this.modals.editor(title, current);
		if (value === undefined) return;
		this.saveLovelyWebValue(scope, cwd, key, value.trim());
	}

	private async setLovelyWebApiKey(scope: LovelyWebConfigScope, cwd: string, provider: string): Promise<void> {
		if (scope !== "user") {
			notify(this.notifications, "Lovely Web API keys are user-only", "warning");
			return;
		}
		const key = LOVELY_WEB_API_KEY_FIELDS[provider as keyof typeof LOVELY_WEB_API_KEY_FIELDS];
		if (!key) {
			notify(this.notifications, `unknown Lovely Web provider: ${provider}`, "warning");
			return;
		}
		const value = await this.modals.input(`${provider} API key`, "paste key; blank to clear", { secret: true });
		if (value === undefined) return;
		this.saveLovelyWebValue(scope, cwd, key, value.trim());
	}

	private async openLovelyWebRawEditor(scope: LovelyWebConfigScope, cwd: string): Promise<void> {
		const patch = readLovelyWebPatch(scope, cwd);
		const safePatch = withoutLovelyWebApiKeys(patch);
		const edited = await this.modals.editor(`Lovely Web ${scope} JSON`, `${JSON.stringify(safePatch, null, 2)}\n`);
		if (edited === undefined) return;
		let parsed: unknown;
		try {
			parsed = JSON.parse(edited);
		} catch (error) {
			notify(this.notifications, `invalid Lovely Web JSON: ${error instanceof Error ? error.message : String(error)}`, "error");
			return;
		}
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			notify(this.notifications, "invalid Lovely Web JSON: expected an object", "error");
			return;
		}
		const editedPatch = withoutLovelyWebApiKeys(parsed as Record<string, unknown>);
		const preservedSecrets = scope === "user" ? lovelyWebApiKeyPatch(patch) : {};
		const path = writeLovelyWebPatch(scope, cwd, { ...editedPatch, ...preservedSecrets });
		this.notifyLovelyWebSaved(path);
	}

	private saveLovelyWebValue(scope: LovelyWebConfigScope, cwd: string, key: LovelyWebConfigKey, value: unknown): void {
		const path = updateLovelyWebConfigValue(scope, cwd, key, value);
		this.notifyLovelyWebSaved(path);
	}

	private notifyLovelyWebSaved(path: string): void {
		notify(this.notifications, `Lovely Web config saved: ${lovelyWebConfigPathForDisplay(path)}. Run /sumo:reload or restart SumoCode for tool enable/disable changes.`, "info");
	}

	/**
	 * `/fork` — pick a USER message to branch from, mirroring pi's
	 * interactive UserMessageSelector: the data source is pi's own
	 * `get_fork_messages` (user prompts only), synthetic bg-task wake
	 * messages are filtered out (they're user-ROLE but orchestrator-injected,
	 * not something anyone forks from), labels are single-line with image
	 * paths collapsed, each row carries `N of M` positional metadata, and the
	 * LATEST message is preselected — all matching pi's UX.
	 */
	public async openForkSelector(): Promise<void> {
		if (this.isTreeNavigationBusy()) {
			notify(this.notifications, "branch summary in progress", "warning");
			return;
		}
		const messages = (await this.controls.getForkMessages())
			.filter((message) => !isBackgroundTaskWakeMessage(message.text));
		logDiagnostic("fork.selector_loaded", { entryCount: messages.length });
		if (messages.length === 0) {
			notify(this.notifications, "no forkable messages", "warning");
			return;
		}
		// Timestamps aren't in the RPC fork payload; read them (best-effort)
		// from the on-disk session so rows carry "when", not just "what".
		const forkState = this.stateStore.getSnapshot();
		let timestamps = new Map<string, string>();
		try {
			if (forkState.sessionFile) {
				const forkSnapshot = await readAuthoritativeSessionSnapshot(this.controls, { sessionFile: forkState.sessionFile, sessionId: forkState.sessionId });
				timestamps = entryTimestampsFromEntries(forkSnapshot.entries);
			}
		} catch {
			// Timestamp decoration is best effort. The selector remains useful when
			// the local file or flat metadata request is unavailable.
		}
		const forkNow = new Date();
		const indexWidth = String(messages.length).length;
		const items: InlineSelectorItem[] = messages.map((message, index) => {
			const timestamp = timestamps.get(message.entryId);
			const age = timestamp ? formatRelativeTime(new Date(timestamp), forkNow) : "";
			return {
				value: message.entryId,
				label: `▷ ${sessionExcerpt(message.text, 66)}`,
				description: age ? `#${String(index + 1).padStart(indexWidth)} · ${age}` : `#${String(index + 1).padStart(indexWidth)}`,
			};
		});
		const selected = await this.inlineSelectors.select("Fork from message", items, {
			initialValue: messages[messages.length - 1]?.entryId,
		});
		if (!selected) return;
		const message = messages.find((candidate) => candidate.entryId === selected);
		if (!message) return;
		const result = await this.applySessionChange(
			() => this.controls.fork(message.entryId),
			(current) => { if (current.text) this.editorText?.setText(current.text); },
		);
		if (!result.cancelled) this.onStateChange();
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
		const rows = resumeSessionRows(sessions);
		const items: InlineSelectorItem[] = sessions.map((session, index) => ({
			value: session.path,
			label: rows[index]!.label,
			description: rows[index]!.description,
			isCurrent: session.path === sessionFile,
		}));
		const selected = await this.inlineSelectors.select("Resume session", items);
		if (!selected) return;
		const session = sessions.find((candidate) => candidate.path === selected);
		if (!session) return;
		const result = await this.applySessionChange(() => this.controls.switchSession(session.path));
		if (!result.cancelled) this.onStateChange();
	}

	/** Browse and navigate the current session tree in place, matching Pi's summary loop. */
	public async openTreeBrowser(initialSelectedId?: string): Promise<void> {
		if (this.isTreeNavigationBusy()) {
			notify(this.notifications, "branch summary in progress", "warning");
			return;
		}
		if (typeof (this.controls as unknown as { getEntries?: unknown }).getEntries !== "function") {
			notify(this.notifications, "session tree unavailable", "warning");
			return;
		}
		let selectedId = initialSelectedId;
		for (;;) {
			const state = this.stateStore.getSnapshot();
			const snapshot = await readAuthoritativeSessionSnapshot(this.controls, { sessionFile: state.sessionFile, sessionId: state.sessionId });
			const tree = buildSessionTreeFromEntries(snapshot.entries);
			if (tree.length === 0) {
				notify(this.notifications, "session has no entries yet", "warning");
				return;
			}
			const rows = flattenSessionTree(tree);
			if (rows.length === 0) {
				notify(this.notifications, "session has no navigable nodes yet", "warning");
				return;
			}
			logDiagnostic("tree.selector_loaded", { entryCount: snapshot.entries.length, visibleEntryCount: rows.length });
			const treeNow = new Date();
			let previousAge = "";
			const items: InlineSelectorItem[] = rows.map((row) => {
				const age = treeRowTimestamp(row.node.entry, treeNow);
				const description = age === previousAge ? "" : age;
				previousAge = age;
				return { value: row.node.entry.id, label: `${row.prefix}${treeNodeSummary(row.node)}`, description, isCurrent: row.node.entry.id === snapshot.leafId };
			});
			const currentSelection = currentTreeSelection(tree, snapshot.leafId);
			const selected = await this.inlineSelectors.select("Session tree", items, {
				initialValue: selectedId ?? currentSelection ?? rows[rows.length - 1]?.node.entry.id,
			});
			if (!selected) return;
			selectedId = selected;
			if (selected === snapshot.leafId) {
				notify(this.notifications, "already at this point", "info");
				return;
			}

			// Keep the summary choice as a nested state. Cancelling the custom
			// editor returns to this selector; cancelling this selector returns to
			// the tree with `selectedId` preserved.
			let summaryChoice: string | undefined;
			let customInstructions: string | undefined;
			for (;;) {
				summaryChoice = await this.inlineSelectors.select("Summarize branch?", ["No summary", "Summarize", "Summarize with custom prompt"]);
				if (summaryChoice === undefined) break;
				if (summaryChoice !== "Summarize with custom prompt") break;
				customInstructions = await this.modals.editor("Custom summarization instructions", "");
				if (customInstructions !== undefined) break;
			}
			if (summaryChoice === undefined) continue;
			const request: RpcTreeNavigationRequest = {
				requestId: randomUUID(),
				targetId: selected,
				summarize: summaryChoice !== "No summary",
				...(customInstructions === undefined ? {} : { customInstructions }),
			};
			try {
				validateRpcTreeNavigationRequest(request);
			} catch {
				notify(this.notifications, "invalid tree navigation request", "warning");
				return;
			}
			this.setTreeNavigationBusy(true);
			try {
				await this.beforeTreeNavigation(request);
				let outcome: RpcTreeNavigationOutcome;
				try {
					outcome = await this.controls.navigateTree(request);
				} catch (error) {
					try {
						await this.reconcileTreeNavigation();
					} catch {
						// Preserve the original transport error for the caller; the host
						// lifecycle remains guarded if reconciliation could not finish.
					}
					throw error;
				}
				await this.reconcileTreeNavigation(outcome);
				if (outcome.status === "committed") {
					this.onStateChange();
					notify(this.notifications, "tree navigated", "info");
				} else if (outcome.status === "cancelled") {
					notify(this.notifications, "tree navigation cancelled", "info");
				} else {
					notify(this.notifications, "tree navigation failed", "error");
				}
				return;
			} finally {
				this.setTreeNavigationBusy(false);
			}
		}
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
		const state = await this.controls.setModel(parsed.provider, parsed.id);
		this.onStateChange(state);
		notify(this.notifications, `model: ${parsed.provider}/${parsed.id}`, "info");
	}

	private async setThinkingFromText(value: string): Promise<void> {
		const level = value.trim().toLowerCase() as RpcThinkingLevel;
		const levels = await this.availableThinkingLevels();
		if (!levels.includes(level)) {
			notify(this.notifications, `unknown thinking level: ${value}`, "warning");
			return;
		}
		const state = await this.controls.setThinkingLevel(level);
		this.onStateChange(state);
		notify(this.notifications, `thinking: ${level}`, "info");
	}

	private async availableThinkingLevels(): Promise<readonly RpcThinkingLevel[]> {
		const levels = await this.controls.getAvailableThinkingLevels();
		return levels.length === 0 ? FALLBACK_THINKING_LEVELS : levels;
	}

	private setThemeFromText(value: string): void {
		const result = setActiveTheme(value);
		if (!result.success) {
			notify(this.notifications, result.error, "warning");
			return;
		}
		// Persist so the next boot's applyStartupTheme resolves the same theme
		// from ~/.pi/agent/sumocode.json — without this, /theme and the theme
		// selector changed the live palette but reverted on restart.
		const persisted = this.persistTheme(result.theme.name);
		this.onRenderRequest();
		if (persisted.success) {
			notify(this.notifications, `theme: ${result.theme.name}`, "info");
		} else {
			notify(this.notifications, `theme: ${result.theme.name} (not persisted: ${persisted.error})`, "warning");
		}
	}

	/**
	 * Cycle to the next registered theme (host-side Ctrl+Shift+T / Alt+T).
	 * The child extension's pi.registerShortcut variant never fires in RPC
	 * mode — the host owns the terminal — so the cycle lives here.
	 */
	public cycleTheme(): void {
		this.setThemeFromText(nextThemeName());
	}

	private async compact(instructions: string): Promise<void> {
		await this.controls.compact(instructions.length > 0 ? instructions : undefined);
		this.onStateChange();
		notify(this.notifications, "compaction requested", "info");
	}

	private async applySessionChange<T extends { readonly cancelled: boolean }>(
		operation: () => Promise<T>,
		onSucceeded?: (result: T) => void,
	): Promise<T> {
		this.beforeSessionChange();
		let result: T;
		try {
			result = await operation();
		} catch (error) {
			// The mutating RPC may have succeeded in the child before its response
			// was lost. Never restore A on an ambiguous failure; re-query ownership.
			// refreshSessionRuntime ends in a fail-closed blank view if that also fails.
			try {
				await this.afterSessionChange();
			} catch {
				// Preserve the original operation error for the command notifier.
			}
			throw error;
		}
		if (result.cancelled) {
			// Events are held while ownership is ambiguous. Explicit cancellation
			// reconciles that buffered unchanged-session stream without rebuilding the
			// retained pager presentation.
			try {
				await this.afterCancelledSessionChange();
			} catch (error) {
				this.cancelSessionChange();
				throw error;
			}
			return result;
		}
		onSucceeded?.(result);
		await this.afterSessionChange();
		return result;
	}

	private async newSession(): Promise<void> {
		const result = await this.applySessionChange(() => this.controls.newSession());
		if (!result.cancelled) {
			this.onStateChange();
			notify(this.notifications, "new session", "info");
		}
	}

	private async switchSessionByPath(): Promise<void> {
		const path = await this.modals.input("Switch session", "path to session jsonl");
		const trimmed = path?.trim() ?? "";
		if (!trimmed) return;
		const result = await this.applySessionChange(() => this.controls.switchSession(trimmed));
		if (!result.cancelled) {
			this.onStateChange();
			notify(this.notifications, "session switched", "info");
		}
	}

	private async cloneSession(): Promise<void> {
		const result = await this.applySessionChange(() => this.controls.clone());
		if (!result.cancelled) {
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

	private async requireChildCommand(command: string): Promise<boolean> {
		if (await this.childCanExecuteCommand(command)) return true;
		notify(this.notifications, `unknown command: ${command}`, "warning");
		return false;
	}

	private async childCanExecuteCommand(command: string): Promise<boolean> {
		const name = normalizeCommandName(command);
		if (!name) return false;
		const commands = await this.controls.getCommands();
		return commands.some((childCommand) => normalizeCommandName(childCommand.name) === name);
	}
}
