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
	createRemnicMemoryClient,
	MemoryClientError,
	type MemoryFact,
	type RemnicMemoryClient,
} from "../../memory.js";
import { isBackgroundTaskWakeMessage } from "../../background-tasks/task-types.js";
import { groupFactsByPanel } from "../../memory-categorization.js";
import { collapseImagePathsForDisplay } from "../transcript/view-model.js";
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
	 * ("ghost transcript") after switching sessions. Not called when the
	 * operation is cancelled or throws.
	 */
	readonly rehydrateTranscript?: () => Promise<void>;
	/** Shared successful new/switch/clone/fork seam. Defaults to refresh + transcript rehydrate. */
	readonly afterSessionChange?: () => Promise<void>;
	/**
	 * Persists the chosen theme name to ~/.pi/agent/sumocode.json so the next
	 * boot's applyStartupTheme resolves it. Injectable so tests never write
	 * the developer's real config; production defaults to
	 * saveSumoCodeConfigPatch.
	 */
	readonly persistTheme?: (name: string) => { success: boolean; error?: string };
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

/**
 * Compact relative timestamp for selector rows: "now", "5m ago", "3h ago",
 * "yesterday", "4d ago", then the plain date. Exported for tests.
 */
export function formatRelativeTime(date: Date, now: Date = new Date()): string {
	if (Number.isNaN(date.getTime())) return "";
	const deltaMs = now.getTime() - date.getTime();
	if (deltaMs < 0) return date.toISOString().slice(0, 10);
	const minutes = Math.floor(deltaMs / 60_000);
	if (minutes < 1) return "now";
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	if (days === 1) return "yesterday";
	if (days < 30) return `${days}d ago`;
	return date.toISOString().slice(0, 10);
}

/**
 * Human excerpt of a message for selector rows: skill invocations render as
 * their slash command (raw `<skill …>` XML must never leak into a list),
 * image paths collapse, whitespace normalizes, and over-long text truncates
 * on an ellipsis instead of mid-word.
 */
export function sessionExcerpt(text: string, maxLength: number): string {
	const cleaned = collapseImagePathsForDisplay(text)
		.replace(/<skill\s+name="([^"]+)"[^>]*>/gi, "/$1 ")
		.replace(/<\/skill>/gi, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (cleaned.length <= maxLength) return cleaned;
	return `${cleaned.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
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

interface TreeRow {
	readonly node: SessionTreeNode;
	readonly depth: number;
	/** Box-drawing connector prefix (`│  `, `├─ `, `└─ `) for this row. */
	readonly prefix: string;
}

/** Depth-first flatten of `buildSessionTree`'s roots, preserving the oldest-first child order the port already sorts by. */
function treeEntryRoleAndText(entry: SessionEntryLike): { role: string; text: string } | undefined {
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
	return text ? { role: message.role, text } : undefined;
}

/**
 * Default tree visibility, mirroring pi's tree-selector default mode: only
 * conversation-spine entries appear — user prompts (minus orchestrator
 * bg-task wake messages, same rule as /fork) and assistant replies that have
 * actual text (assistant messages that are pure tool-call envelopes are
 * hidden). Settings/bookkeeping entries (label, custom, model_change,
 * thinking_level_change, session_info), tool results, and bash executions
 * never render as nodes. Labeled bookmarks are always shown regardless.
 */
function isTreeNodeVisible(node: SessionTreeNode): boolean {
	if (node.label) return true;
	if (node.entry.type !== "message") return false;
	const extracted = treeEntryRoleAndText(node.entry);
	if (!extracted) return false;
	if (extracted.role === "user") return !isBackgroundTaskWakeMessage(extracted.text);
	return extracted.role === "assistant";
}

/**
 * Flattens the tree into visible rows with STRUCTURAL depth: indentation
 * increases only at real fork points (a node with multiple children), not
 * per chain link — session entries chain parent→child linearly, so per-link
 * depth pushed labels off-screen within ~40 entries. A linear session is a
 * flat list; each branch adds one indent level.
 */
function flattenSessionTree(roots: readonly SessionTreeNode[]): TreeRow[] {
	const rows: TreeRow[] = [];
	// `pendingGlyph` carries a `├─ `/`└─ ` branch connector until the first
	// VISIBLE row of that branch consumes it — filtered nodes (tool results,
	// bookkeeping entries) must not eat the connector or branches would look
	// like linear runs. Linear runs render at their branch's indent with no
	// glyph, so a session with no forks stays perfectly flat while every fork
	// point fans out like a real tree.
	// The connector renders at the PARENT's indent (`glyphIndent`); once the
	// first visible row of a branch consumes it, the rest of that branch's
	// rows sit at the branch's own `indent` (which carries the `│  `/`   `
	// continuation).
	const visit = (node: SessionTreeNode, depth: number, indent: string, glyphIndent: string, pendingGlyph: string): string => {
		let glyph = pendingGlyph;
		if (isTreeNodeVisible(node)) {
			rows.push({ node, depth, prefix: glyph ? `${glyphIndent}${glyph}` : indent });
			glyph = "";
		}
		if (node.children.length > 1) {
			for (const [index, child] of node.children.entries()) {
				const last = index === node.children.length - 1;
				visit(child, depth + 1, `${indent}${last ? "   " : "│  "}`, indent, last ? "└─ " : "├─ ");
			}
		} else if (node.children.length === 1) {
			glyph = visit(node.children[0]!, depth, indent, glyphIndent, glyph);
		}
		return glyph;
	};
	for (const root of roots) visit(root, 0, "", "", "");
	return rows;
}

/** One-line summary for a tree row: label bookmark if present, then `role: text` (image paths collapsed, whitespace normalized). */
/**
 * One-line summary for a tree row: role glyph (▷ you, ✦ sumo), bookmark
 * label if present, then the message excerpt (image paths collapsed,
 * whitespace normalized).
 */
function treeNodeSummary(node: SessionTreeNode): string {
	const bookmark = node.label ? `[${node.label}] ` : "";
	const extracted = node.entry.type === "message" ? treeEntryRoleAndText(node.entry) : undefined;
	const glyph = extracted?.role === "user" ? "▷ " : extracted?.role === "assistant" ? "✦ " : "· ";
	const body = extracted ? sessionExcerpt(extracted.text, 68) : node.entry.type;
	return `${glyph}${bookmark}${body}`;
}

function treeRowTimestamp(entry: SessionEntryLike, now: Date = new Date()): string {
	return formatRelativeTime(new Date(entry.timestamp), now);
}

/** Best-effort entryId → timestamp map from the on-disk session, for enriching RPC fork rows (the RPC payload has no timestamps). */
function entryTimestampsFromTree(roots: readonly SessionTreeNode[]): Map<string, string> {
	const map = new Map<string, string>();
	const visit = (node: SessionTreeNode): void => {
		if (typeof node.entry.id === "string" && typeof node.entry.timestamp === "string") map.set(node.entry.id, node.entry.timestamp);
		for (const child of node.children) visit(child);
	};
	for (const root of roots) visit(root);
	return map;
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
	private readonly afterSessionChange: () => Promise<void>;
	private readonly writeClipboardSequence: (sequence: string) => boolean;
	private readonly changelogRoot: string;
	private readonly persistTheme: (name: string) => { success: boolean; error?: string };

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
		this.afterSessionChange = options.afterSessionChange ?? (async () => {
			await this.controls.refreshState();
			await this.rehydrateTranscript();
		});
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
		await this.controls.setModel(parsed.provider, parsed.id);
		this.onStateChange();
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
		const messages = (await this.controls.getForkMessages())
			.filter((message) => !isBackgroundTaskWakeMessage(message.text));
		if (messages.length === 0) {
			notify(this.notifications, "no forkable messages", "warning");
			return;
		}
		// Timestamps aren't in the RPC fork payload; read them (best-effort)
		// from the on-disk session so rows carry "when", not just "what".
		const forkSessionFile = this.stateStore.getSnapshot().sessionFile;
		const forkTree = forkSessionFile ? await buildSessionTree(forkSessionFile).catch(() => undefined) : undefined;
		const timestamps = forkTree ? entryTimestampsFromTree(forkTree) : new Map<string, string>();
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
		const result = await this.controls.fork(message.entryId);
		if (!result.cancelled) {
			if (result.text) this.editorText?.setText(result.text);
			await this.afterSessionChange();
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
		const result = await this.controls.switchSession(session.path);
		if (!result.cancelled) {
			await this.afterSessionChange();
			this.onStateChange();
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
		if (rows.length === 0) {
			notify(this.notifications, "session has no forkable nodes yet", "warning");
			return;
		}
		const treeNow = new Date();
		// Deduplicate consecutive identical ages: a burst of rows from the same
		// minutes reads as one dim timestamp instead of a column of repeats.
		let previousAge = "";
		const items: InlineSelectorItem[] = rows.map((row) => {
			const age = treeRowTimestamp(row.node.entry, treeNow);
			const description = age === previousAge ? "" : age;
			previousAge = age;
			return {
				value: row.node.entry.id,
				label: `${row.prefix}${treeNodeSummary(row.node)}`,
				description,
			};
		});
		const selected = await this.inlineSelectors.select("Session tree (fork from a node)", items, {
			initialValue: rows[rows.length - 1]?.node.entry.id,
		});
		if (!selected) return;
		const row = rows.find((candidate) => candidate.node.entry.id === selected);
		if (!row) return;
		const result = await this.controls.fork(row.node.entry.id);
		if (!result.cancelled) {
			if (result.text) this.editorText?.setText(result.text);
			await this.afterSessionChange();
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

	private async newSession(): Promise<void> {
		const result = await this.controls.newSession();
		if (!result.cancelled) {
			await this.afterSessionChange();
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
			await this.afterSessionChange();
			this.onStateChange();
			notify(this.notifications, "session switched", "info");
		}
	}

	private async cloneSession(): Promise<void> {
		const result = await this.controls.clone();
		if (!result.cancelled) {
			await this.afterSessionChange();
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
