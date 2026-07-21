import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import {
	INPUT_FRAME_LABEL_SPLASH,
	INPUT_FRAME_PLACEHOLDER,
	renderInputFrame,
	renderInputHints,
} from "../../cathedral/input-frame.js";
import { splashInvocationHint } from "../../cathedral/input-hints.js";
import { compactionStatusLabelForReason, renderCompactionStatusRow } from "../../compaction-status-row.js";
import {
	colorHex,
	formatCwd,
	renderFooterBlock,
	renderSplashVersionLine,
	type FooterSnapshot,
	type ThinkingLevel,
} from "../../footer.js";
import { getCachedMcpRoster } from "../../mcp-config-reader.js";
import { SIDEBAR_MIN_TERMINAL_WIDTH, sidebarOverlayTargetRows } from "../../sidebar-placement.js";
import { PLACEHOLDER_MCP, createSidebarPublication, type SidebarSnapshot } from "../../sidebar.js";
import { createTopChromePublication, type TopChromeSnapshot } from "../../top-chrome.js";
import { activeThemeChrome, activeThemeColors, getActiveTheme, onThemeChanged, type SumoCodeState } from "../../themes/index.js";
import { renderIndicator, shouldInstallWorkingIndicator } from "../../working-indicator.js";
import { createSplashTree, defaultSplashSnapshot, type SplashTree } from "../cathedral/splash-tree.js";
import { loadYoga, type Yoga } from "../layout/yoga.js";
import type { CellBuffer } from "../render/buffer.js";
import type { ShellOverlayEntry, ShellRenderable, ShellTerminalSessionOwner, ShellViewport } from "../shell/contracts.js";
import { RetainedShellRenderer } from "../shell/retained-shell-renderer.js";
import type { TranscriptControllerChatSink } from "../transcript/controller.js";
import type { TranscriptViewModel } from "../transcript/view-model.js";
import { ChatPager } from "../widgets/chat-pager.js";
import type { KeyEvent } from "../input/key-router.js";
import type { MouseEvent } from "../input/mouse.js";
import { SelectionController } from "../input/selection.js";
import type { NotificationLevel } from "../widgets/notification.js";
import type { RpcHostChromeState } from "./state.js";

export interface RpcShellAdapterOptions {
	readonly terminal: ShellTerminalSessionOwner;
	readonly viewport: ShellViewport;
	readonly initialState: RpcHostChromeState;
	readonly initialTranscript: TranscriptViewModel;
	readonly inputPreview?: string;
	readonly editor?: Component;
	readonly modal?: Component & { getActiveKind?(): string | undefined };
	readonly overlay?: Component & { getActiveKind?(): string | undefined };
	readonly notifications?: Component & { notify?(message: string, level?: NotificationLevel, timeoutMs?: number): unknown };
	readonly extensionRegions?: {
		readonly aboveEditor?: Component;
		readonly belowEditor?: Component;
		readonly sidebar?: Component;
	};
	/**
	 * Triggers a repaint outside of `update()`'s own call chain -- needed so
	 * the working-indicator timer (see `workingIndicatorTimer`) can animate on
	 * a real wall-clock cadence instead of only advancing when some other
	 * event happens to call `render()`.
	 */
	readonly requestRender?: () => void;
	/**
	 * Optional narrow repaint path for working-indicator ticks. Runtime owners
	 * that can reach the retained renderer install this so the animation avoids
	 * scheduling a full shell render; tests/callers without it fall back to
	 * `requestRender`.
	 */
	readonly requestIndicatorRepaint?: () => void;
}

export interface RpcShellAdapterSnapshot {
	readonly state: RpcHostChromeState;
	readonly transcript: TranscriptViewModel;
	/**
	 * `TranscriptController.getRevision()` at the moment `transcript` was
	 * produced. When a `TranscriptControllerChatSink` (see `getChatSink`) is
	 * wired directly to this adapter's pager, the controller already pushed
	 * this exact transcript's changes into the pager incrementally — passing
	 * the revision here lets `update` recognize that and skip the redundant
	 * (and expensive: dispose/recreate every message) `replaceViewModels`
	 * call. Omit it (or wire no sink) to keep the old always-replace
	 * behavior, e.g. for callers/tests that push transcripts without going
	 * through the sink at all.
	 */
	readonly transcriptRevision?: number;
}

interface SplashAwareComponent extends Component {
	setSplashProvider?(provider: () => boolean): void;
}

interface TextReadableComponent extends Component {
	getText?(): string;
}

const ANSI_PATTERN = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\)|_[^\u0007]*(?:\u0007|\u001b\\))/g;
const THINKING_LEVELS = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh"]);
const SPLASH_INPUT_FRAME_WIDTH = 60;
const SIMPLE_INPUT_FRAME_ROWS = 3;
const VISUAL_SIDEBAR_CONTEXT_TOKENS = 42_000;
const VISUAL_SIDEBAR_CONTEXT_WINDOW = 200_000;
const VISUAL_SIDEBAR_CUMULATIVE_TOKENS = 3_400_000;
const VISUAL_SIDEBAR_COST_USD = 0.42;
const VISUAL_MODEL_LABEL = "gpt-5.5";

export class RpcShellAdapter {
	private readonly chat: ChatPager;
	private readonly splash: SplashTree;
	private readonly renderer: RetainedShellRenderer;
	private readonly editor: Component | undefined;
	private readonly modal: (Component & { getActiveKind?(): string | undefined }) | undefined;
	private readonly overlay: (Component & { getActiveKind?(): string | undefined }) | undefined;
	private readonly notifications: (Component & { notify?(message: string, level?: NotificationLevel, timeoutMs?: number): unknown }) | undefined;
	private readonly extensionAboveEditor: Component | undefined;
	private readonly extensionBelowEditor: Component | undefined;
	private readonly extensionSidebar: Component | undefined;
	private readonly viewport: ShellViewport;
	private readonly selection: SelectionController;
	private state: RpcHostChromeState;
	private transcript: TranscriptViewModel;
	/**
	 * Animation tick for the above-editor working indicator. `RetainedShellRenderer`
	 * resolves `aboveEditorWidgets()` fresh on every render (see `LazyComponentProxy`
	 * in retained-shell-renderer.ts), so a new `RpcAboveEditorComponent` instance is
	 * constructed each frame -- any per-frame animation state has to live here, on
	 * the adapter that persists across renders, not on the widget itself.
	 *
	 * Driven by `workingIndicatorTimer` (a real `setInterval`, see
	 * `syncWorkingIndicatorTimer`), NOT by `renderWorkingIndicator` being
	 * called -- render frequency tracks agent activity (bursts of deltas
	 * while streaming, near-silence while waiting on a tool/first token), so
	 * ticking on render made the animation race during streaming and freeze
	 * during "thinking". `renderWorkingIndicator` now only reads this value.
	 */
	private workingIndicatorTick = 0;
	private wasWorkingIndicatorBusy = false;
	private workingIndicatorTimer: ReturnType<typeof setInterval> | undefined;
	private readonly requestRender: (() => void) | undefined;
	private readonly requestIndicatorRepaint: (() => void) | undefined;
	private readonly workingIndicatorThemeUnsubscribe: () => void;

	private constructor(yoga: Yoga, options: RpcShellAdapterOptions) {
		this.state = options.initialState;
		this.transcript = options.initialTranscript;
		this.editor = options.editor;
		this.modal = options.modal;
		this.overlay = options.overlay;
		this.notifications = options.notifications;
		this.extensionAboveEditor = options.extensionRegions?.aboveEditor;
		this.extensionBelowEditor = options.extensionRegions?.belowEditor;
		this.extensionSidebar = options.extensionRegions?.sidebar;
		this.viewport = options.viewport;
		this.requestRender = options.requestRender;
		this.requestIndicatorRepaint = options.requestIndicatorRepaint;
		// Mirrors WorkingIndicatorComponent.restartTimer in working-indicator.ts:
		// a mid-turn theme swap (Ctrl+Shift+T) should pick up the new
		// frames/cadence immediately rather than finishing out the old
		// theme's interval.
		this.workingIndicatorThemeUnsubscribe = onThemeChanged(() => {
			if (this.wasWorkingIndicatorBusy) this.startWorkingIndicatorTimer();
		});
		this.chat = ChatPager.create(yoga);
		this.chat.replaceViewModels(this.transcript.messages);
		this.splash = createSplashTree(yoga, undefined, () => defaultSplashSnapshot(this.isActive()));
		(this.editor as SplashAwareComponent | undefined)?.setSplashProvider?.(() => !this.isActive());
		const editorComponent = new RpcEditorShellComponent(this, options.inputPreview);
		this.selection = new SelectionController({
			readBuffer: () => this.renderer.getLastFrame(),
			emitClipboard: (sequence) => {
				options.terminal.writeClipboardSequence?.(sequence);
			},
			onCopied: () => {
				this.notifications?.notify?.("copied", "success", 1_400);
				this.renderer.invalidatePreviousFrame();
			},
			onSelectionChanged: () => this.renderer.invalidatePreviousFrame(),
		});
		this.renderer = new RetainedShellRenderer({
			yoga,
			chat: { pager: this.chat },
			splash: { tree: this.splash },
			isActive: () => this.isActive(),
			editor: () => editorComponent,
			topChromeFallback: () => this.topChromePublication(),
			topChrome: () => this.topChromePublication(),
			belowEditorWidgets: () => new RpcHintComponent(this),
			aboveEditorWidgets: () => new RpcAboveEditorComponent(this),
			footer: () => new RpcFooterComponent(this),
			terminal: options.terminal,
			viewport: options.viewport,
			overlayHost: new RpcOverlayHost(this),
			sidebar: () => this.sidebarPublication(),
			selection: this.selection,
			paintHardwareCursorAsSoftware: true,
		});
		// Covers construction with an already-busy initialState (e.g.
		// reattaching mid-turn) -- without this, the timer would only start on
		// the NEXT idle->busy transition, leaving the current turn's entire
		// remaining duration frozen on frame 0.
		this.syncWorkingIndicatorTimer();
	}

	public static async create(options: RpcShellAdapterOptions): Promise<RpcShellAdapter> {
		return new RpcShellAdapter(await loadYoga(), options);
	}

	public update(snapshot: Partial<RpcShellAdapterSnapshot>): void {
		if (snapshot.state) {
			this.state = snapshot.state;
			this.syncWorkingIndicatorTimer();
		}
		if (snapshot.transcript) {
			this.transcript = snapshot.transcript;
			// A `transcriptRevision` means this transcript came from a
			// `TranscriptController` wired to THIS adapter's pager via
			// `getChatSink()` -- every path that bumps the controller's revision
			// (`handleAgentEvent`'s diffing publish AND the hydration/session-op
			// full-replace publish) already pushed the corresponding change into
			// `this.chat` before returning. Calling `replaceViewModels` again
			// here would be the exact full teardown/rebuild per event that B9
			// exists to avoid, so only fall back to a full replace when no
			// revision is present at all (no sink wired for this call -- the
			// pre-B9 behavior, kept for callers/tests that push transcripts
			// without going through a revisioned controller).
			if (snapshot.transcriptRevision === undefined) {
				this.chat.replaceViewModels(snapshot.transcript.messages);
			}
			// Every transcript-carrying update repaints some of the chat
			// viewport's rows -- whether via the sink's incremental
			// addViewModel/replaceLastWithViewModel (B9 path) or the full
			// replaceViewModels above. A held selection's anchor/focus are
			// row/col coordinates into that same viewport, so leaving it in
			// place would keep highlighting/copying whatever now happens to
			// render at those coordinates instead of the text the user
			// actually dragged over. Clearing unconditionally on any
			// transcript application is the simplest rule that stays correct
			// for both paths.
			this.selection.clear();
		}
	}

	/**
	 * Exposes this adapter's `ChatPager` as a `TranscriptControllerChatSink`
	 * for `host.ts` to wire directly into the `TranscriptController` that
	 * drives this session, so streaming deltas apply incrementally
	 * (replaceLastWithViewModel/addViewModel) instead of only ever reaching
	 * the pager through this adapter's own full `replaceViewModels` path.
	 */
	public getChatSink(): TranscriptControllerChatSink {
		return this.chat;
	}

	/**
	 * Applies `app.tools.expand`'s toggled expansion state directly to this
	 * adapter's live `ChatPager` -- the same pattern `writeClipboardSequence`
	 * uses for OSC52 (`host-actions.ts`/`RpcHostActions` has no direct handle
	 * on adapter-owned state, only `RpcHostRuntime` does, so `host.ts` wires
	 * this through as a callback rather than exposing the `ChatPager` type
	 * itself past this adapter).
	 */
	public setToolExpansion(expanded: boolean): void {
		this.chat.setToolExpansion(expanded);
	}

	public render(): void {
		this.renderer.render();
	}

	public repaintWorkingIndicator(): void {
		this.renderer.repaintRegion("aboveEditor");
	}

	public handleMouseEvent(event: MouseEvent): boolean {
		// Wheel scroll and drag-select are mutually exclusive over the same SGR
		// mouse stream: `ScrollBox.handleMouseEvent` (reached via
		// `renderer.handleMouseEvent`) only ever claims `type === "scroll"`
		// events, so routing scroll through the renderer first and every other
		// event type (down/drag/up/move) to the selection controller keeps
		// wheel scroll and drag-select from fighting over the same bytes.
		if (event.type === "scroll") {
			const handled = this.renderer.handleMouseEvent(event);
			// Scrolling repaints different transcript content into the same
			// absolute viewport rows the selection's anchor/focus point into --
			// see the matching comment in update() for why any repaint of the
			// selected region clears it.
			if (handled) this.selection.clear();
			return handled;
		}
		const selectionHandled = this.selection.handleMouseEvent(event);
		const shellHandled = this.renderer.handleMouseEvent(event);
		return selectionHandled || shellHandled;
	}

	public handleChatKey(event: KeyEvent): boolean {
		const handled = this.chat.handleKey(event);
		// See handleMouseEvent's scroll branch: a key-driven scroll command
		// (page-up/page-down/jump-top/jump-bottom) repaints the same rows a
		// held selection anchors into.
		if (handled) this.selection.clear();
		return handled;
	}

	public handleSelectionKey(event: KeyEvent): boolean {
		return this.selection.handleKey(event);
	}

	public getLastFrame(): CellBuffer | undefined {
		return this.renderer.getLastFrame();
	}

	public dispose(): void {
		this.clearWorkingIndicatorTimer();
		this.workingIndicatorThemeUnsubscribe();
		this.renderer.dispose();
		this.chat.dispose();
		this.splash.root.dispose();
	}

	public getState(): RpcHostChromeState {
		return this.state;
	}

	public getTranscript(): TranscriptViewModel {
		return this.transcript;
	}

	public isActive(): boolean {
		return rpcSessionIsActive(this.state, this.transcript);
	}

	public getModal(): (Component & { getActiveKind?(): string | undefined }) | undefined {
		return this.modal;
	}

	public getOverlay(): (Component & { getActiveKind?(): string | undefined }) | undefined {
		return this.overlay;
	}

	public getNotifications(): Component | undefined {
		return this.notifications;
	}

	public renderEditor(width: number, inputPreview: string | undefined): string[] {
		const rows = this.editor?.render(width) ?? [];
		if (this.editor && rows.length > 0) return rows;
		if (!this.isActive()) {
			if (rows.length > 0 && !isSimpleSplashEditorFrame(rows)) return rows;
			return renderSplashEditorFrame(width, readEditorText(this.editor));
		}
		if (rows.length > 0 && !activeEditorIsEmpty(rows)) return rows;
		const submittedPrompt = inputPreview ?? (width >= SIDEBAR_MIN_TERMINAL_WIDTH ? latestUserPrompt(this.transcript) : undefined);
		return renderInputFrame(submittedPrompt ?? "", width, { promptColor: "accent", cursorStyle: "cell" });
	}

	private topChromePublication(): { component: ShellRenderable } {
		return createTopChromePublication(
			() => topChromeSnapshot(this.state),
			() => this.isActive(),
		);
	}

	private sidebarPublication(): { component: ShellRenderable; isVisible: (cols: number, rows: number) => boolean } | undefined {
		if (!this.isActive()) return undefined;
		return createSidebarPublication(
			() => sidebarSnapshot(this.state),
			(cols, _rows) => this.isActive() && cols >= SIDEBAR_MIN_TERMINAL_WIDTH,
			this.extensionSidebar,
			// Matches main's classic `installSidebar` (src/sidebar.ts), which reads
			// the live Pi TUI terminal's row count inside the sidebar component's
			// own `render` closure and pads with background-filled empty rows down
			// to `sidebarOverlayTargetRows(terminalRows)`. The RPC shell has no
			// equivalent "ask the terminal" hook inside the component itself, but
			// `this.viewport` (the live `ShellViewport` passed in at construction,
			// see `RpcHostRuntime.start`'s `viewport: this.output`) exposes the same
			// current row count, so read it here instead -- same target, same
			// formula, without widening `ShellRenderable.render` to take a height.
			() => sidebarOverlayTargetRows(this.viewport.rows ?? 24),
		);
	}

	public renderExtensionAboveEditor(width: number): string[] {
		return this.extensionAboveEditor?.render(width) ?? [];
	}

	/**
	 * Above-editor working indicator (D3 parity item): the Pi child process
	 * that the RPC host spawns runs `installRpcChildProfile` (see
	 * `src/extension.ts`), which deliberately skips `installWorkingIndicator`
	 * -- RPC-child extensions own no chrome, the host does. So this can't
	 * rely on the extension's `ctx.ui.setWidget(..., { placement: "aboveEditor" })`
	 * path (that's what the pre-RPC owned shell used); it has to derive the
	 * same visual directly from `RpcHostChromeState` the way the footer/topbar
	 * already do. Mirrors `WorkingIndicatorComponent` in working-indicator.ts:
	 * one row, empty while idle, animated theme frame + dim "Working…" label
	 * while busy.
	 */
	public renderWorkingIndicator(width: number): string[] {
		if (this.state.isCompacting) {
			return renderCompactionStatusRow({
				width,
				label: compactionStatusLabelForReason(this.state.compactionReason),
				tick: this.workingIndicatorTick,
			});
		}

		// V1 scope: the working indicator is a landscape affordance. Portrait's
		// 60-column width reserves the pre-input breathing row instead (see
		// shouldInstallWorkingIndicator's doc comment in working-indicator.ts) --
		// main's owned-shell extension gated on this via `ctx.hasUI` +
		// `shouldInstallWorkingIndicator()` before ever mounting the aboveEditor
		// widget, so narrow captures never showed it. Mirror that gate here too,
		// or portrait would show a landscape-only affordance main never did.
		//
		// This is a pure read: the tick itself is advanced by
		// `workingIndicatorTimer` (see `syncWorkingIndicatorTimer`), on a real
		// wall-clock cadence, not by how often this method happens to get
		// called -- render frequency tracks agent activity, which is bursty
		// (many renders while streaming, none while waiting on a first token),
		// and ticking here made the animation race during streaming and
		// visibly freeze during "thinking".
		if (sumoState(this.state) === "idle" || !shouldInstallWorkingIndicator(width)) return [""];
		const theme = getActiveTheme();
		const frame = renderIndicator(this.workingIndicatorTick, theme.workingIndicator.frames, theme.tokens.colors.accent);
		const label = colorHex("Working…", activeThemeColors().foregroundDim);
		const line = ` ${frame} ${label}`;
		return width > 0 ? [truncateToWidth(line, width)] : [line];
	}

	/**
	 * Render queued messages above the editor. `state.queuedMessages` is a
	 * display-only composition of SumoCode's host-owned prompt queue plus any
	 * unexpected Pi-owned queue_update entries; only the host-owned portion is
	 * undoable, but the card geometry stays shared.
	 */
	public renderQueuedMessages(width: number): string[] {
		const queued = this.state.queuedMessages;
		if (!queued || queued.length === 0 || width < 8) return [];
		const colors = activeThemeColors();
		const accent = getActiveTheme().tokens.colors.accent;
		const frame = activeThemeChrome().frame;
		const divider = (glyphs: string) => colorHex(glyphs, colors.divider);

		// Bordered card in the same visual language as the USER/SUMO chat
		// cards (dim divider frame, dim body), so queued prompts read as part
		// of the conversation surface rather than loose banner rows:
		//
		//   ╭ QUEUED (2) ──────────────────────╮
		//   │ ↳ first queued prompt              │
		//   ╰──────────────────────────────────╯
		const label = `QUEUED (${queued.length})`;
		const topRule = Math.max(0, width - 4 - label.length);
		const top = `${divider(`${frame.topLeft} `)}${colorHex(label, colors.foregroundDim)}${divider(` ${frame.horizontal.repeat(topRule)}${frame.topRight}`)}`;
		const bottom = divider(`${frame.bottomLeft}${frame.horizontal.repeat(Math.max(0, width - 2))}${frame.bottomRight}`);

		const textAvail = Math.max(1, width - 6); // "│ ↳ " + " │"
		const rows = queued.map((text) => {
			// Clipboard-image paths are an implementation detail — show a compact
			// [image] tag instead of the raw /tmp/pi-clipboard-….png path.
			const display = text.replace(/\S*pi-clipboard-[\w-]+\.(?:png|jpe?g|gif|webp)/gi, "[image]");
			const single = truncateToWidth(display.replace(/\s+/g, " ").trim(), textAvail);
			const pad = " ".repeat(Math.max(0, textAvail - visibleWidth(single)));
			return `${divider(frame.vertical)} ${colorHex("↳", accent)} ${colorHex(single, colors.foregroundDim)}${pad} ${divider(frame.vertical)}`;
		});

		return [top, ...rows, bottom];
	}

	/**
	 * Starts/stops the wall-clock timer driving `workingIndicatorTick` when
	 * `sumoState` crosses the idle/busy boundary; a no-op otherwise (e.g. a
	 * `message_update` delta arriving mid-turn doesn't restart the timer or
	 * reset the tick). Width is deliberately NOT part of this decision --
	 * "is the agent busy" and "is the indicator currently visible at this
	 * render width" are independent; a resize mid-turn shouldn't reset the
	 * animation, only whether `renderWorkingIndicator` currently shows it.
	 */
	private syncWorkingIndicatorTimer(): void {
		const busy = sumoState(this.state) !== "idle";
		if (busy === this.wasWorkingIndicatorBusy) return;
		this.wasWorkingIndicatorBusy = busy;
		this.workingIndicatorTick = 0;
		if (busy) this.startWorkingIndicatorTimer();
		else this.clearWorkingIndicatorTimer();
	}

	private startWorkingIndicatorTimer(): void {
		this.clearWorkingIndicatorTimer();
		const intervalMs = getActiveTheme().workingIndicator.intervalMs;
		this.workingIndicatorTimer = setInterval(() => {
			this.workingIndicatorTick += 1;
			(this.requestIndicatorRepaint ?? this.requestRender)?.();
		}, intervalMs);
	}

	private clearWorkingIndicatorTimer(): void {
		if (this.workingIndicatorTimer !== undefined) {
			clearInterval(this.workingIndicatorTimer);
			this.workingIndicatorTimer = undefined;
		}
	}

	public renderExtensionBelowEditor(width: number): string[] {
		return this.extensionBelowEditor?.render(width) ?? [];
	}
}

export function rpcSessionIsActive(state: RpcHostChromeState, transcript: TranscriptViewModel): boolean {
	return state.hasMessages
		|| state.messageCount > 0
		|| state.pendingMessageCount > 0
		|| state.taskPartialCount > 0
		|| state.isStreaming
		|| state.isCompacting
		|| transcript.messages.length > 0;
}

function hostCwd(env: NodeJS.ProcessEnv = process.env): string {
	return resolve(env.SUMOCODE_PROJECT_CWD ?? process.cwd());
}

function resolvePiAgentDir(env: NodeJS.ProcessEnv = process.env): string {
	return env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

function isVisualHarness(env: NodeJS.ProcessEnv = process.env): boolean {
	return env.SUMOCODE_HARNESS === "1";
}

function normalizeThinkingLevel(value: string | undefined): ThinkingLevel {
	return THINKING_LEVELS.has(value as ThinkingLevel) ? value as ThinkingLevel : "medium";
}

function sumoState(state: RpcHostChromeState): SumoCodeState {
	if (state.isCompacting) return "learning";
	if (state.lastEventType === "tool_call" || state.lastEventType === "tool_execution_update") return "tool";
	if (state.isStreaming) return "thinking";
	return "idle";
}

function sessionLabel(state: RpcHostChromeState): string {
	return state.sessionName ?? state.sessionId?.slice(0, 8) ?? "session";
}

function topChromeSnapshot(state: RpcHostChromeState): TopChromeSnapshot {
	return {
		activeSession: {
			id: state.sessionId ?? "rpc-session",
			label: sessionLabel(state),
			state: sumoState(state),
		},
		recentSessions: [],
		hidden: false,
	};
}

function sidebarSnapshot(state: RpcHostChromeState): SidebarSnapshot {
	const cwd = hostCwd();
	const visualHarness = isVisualHarness();
	const contextTokens = visualHarness ? VISUAL_SIDEBAR_CONTEXT_TOKENS : state.contextTokens ?? 0;
	return {
		projectName: basename(cwd) || cwd,
		branch: visualHarness ? "main" : state.gitBranch,
		inputTokens: contextTokens,
		outputTokens: 0,
		currentContextTokens: contextTokens,
		contextWindow: visualHarness ? VISUAL_SIDEBAR_CONTEXT_WINDOW : state.contextWindow ?? 0,
		cumulativeTokens: visualHarness ? VISUAL_SIDEBAR_CUMULATIVE_TOKENS : undefined,
		costUsd: visualHarness ? VISUAL_SIDEBAR_COST_USD : state.costUsd,
		mcpServers: visualHarness ? PLACEHOLDER_MCP : getCachedMcpRoster({ cwd, piAgentDir: resolvePiAgentDir() }),
		memory: [],
		memoryTotal: 0,
		activeSubTab: "CONTEXT",
		sessions: [{ name: sessionLabel(state), branch: state.gitBranch, active: true }],
	};
}

function footerSnapshot(state: RpcHostChromeState, isSplash: boolean): FooterSnapshot {
	if (isVisualHarness() && !isSplash) {
		// Tokens/cost/branch are frozen here because they're genuinely
		// non-deterministic across real sessions (see VISUAL_SIDEBAR_* above).
		// `state`/`modelId`/`thinkingLevel` are NOT: they're driven by real RPC
		// session events (agent_start/agent_end/tool_call/model_select), so a
		// scripted harness scenario (e.g. the active-working faux-provider
		// scenario) reproduces them exactly every run. Freezing them to "idle" /
		// VISUAL_MODEL_LABEL regardless of actual activity was correct back when
		// only the splash scenario existed (no agent ever ran), but went stale
		// once active-working scenarios started actually streaming -- main's
		// captured footer shows the real busy state ("MEDITATING"/live model),
		// so the RPC harness footer must too or the two are comparing different
		// things.
		return {
			cwd: hostCwd(),
			branch: "main",
			inputTokens: VISUAL_SIDEBAR_CONTEXT_TOKENS,
			outputTokens: 0,
			contextTokens: VISUAL_SIDEBAR_CONTEXT_TOKENS,
			contextWindow: VISUAL_SIDEBAR_CONTEXT_WINDOW,
			costUsd: VISUAL_SIDEBAR_COST_USD,
			state: sumoState(state),
			modelId: footerModelId(state.modelLabel) ?? VISUAL_MODEL_LABEL,
			thinkingLevel: normalizeThinkingLevel(state.thinkingLevel),
			isSplash,
		};
	}
	const contextTokens = state.contextTokens ?? 0;
	return {
		cwd: hostCwd(),
		branch: state.gitBranch ?? null,
		inputTokens: contextTokens,
		outputTokens: 0,
		contextTokens,
		contextWindow: state.contextWindow,
		costUsd: state.costUsd,
		state: sumoState(state),
		modelId: footerModelId(state.modelLabel) ?? "no-model",
		thinkingLevel: normalizeThinkingLevel(state.thinkingLevel),
		isSplash,
	};
}

/**
 * `RpcHostChromeState.modelLabel` is `provider/id` (see `modelLabelFrom` in
 * state.ts) -- the fuller form the model-picker overlay wants so providers
 * sharing a model id stay distinguishable (host-actions.ts's MODEL row).
 * The footer, however, is shared render code (footer.ts's `formatFooterLineInner`)
 * with the pre-RPC extension-owned footer, which only ever had `ctx.model?.id`
 * (no provider) to work with -- so main's footer has always shown the bare
 * model id. Stripping the provider prefix here (footer-display only) keeps
 * that convention instead of introducing a new "provider/id" footer format
 * RPC-only sessions would show and main never did.
 */
function footerModelId(modelLabel: string | undefined): string | undefined {
	if (!modelLabel) return undefined;
	const slash = modelLabel.indexOf("/");
	return slash >= 0 ? modelLabel.slice(slash + 1) : modelLabel;
}

function stripAnsi(value: string): string {
	return value.replace(ANSI_PATTERN, "");
}

function readEditorText(editor: Component | undefined): string {
	const text = (editor as TextReadableComponent | undefined)?.getText?.();
	return typeof text === "string" ? text : "";
}

function isSimpleSplashEditorFrame(rows: readonly string[]): boolean {
	return rows.length === 0
		|| rows.length === SIMPLE_INPUT_FRAME_ROWS
		|| rows.some((row) => stripAnsi(row).includes(INPUT_FRAME_PLACEHOLDER));
}

function renderSplashEditorFrame(width: number, input: string): string[] {
	const frameWidth = Math.min(width, SPLASH_INPUT_FRAME_WIDTH);
	return centerRows(renderInputFrame(input, frameWidth, {
		label: INPUT_FRAME_LABEL_SPLASH,
		placeholder: INPUT_FRAME_PLACEHOLDER,
		cursorStyle: "cell",
	}), width);
}

function activeEditorIsEmpty(rows: readonly string[]): boolean {
	const content = rows.find((row) => stripAnsi(row).startsWith("│ >"));
	if (!content) return false;
	return /^│ >\s+│$/.test(stripAnsi(content));
}

function latestUserPrompt(transcript: TranscriptViewModel): string | undefined {
	for (let index = transcript.messages.length - 1; index >= 0; index -= 1) {
		const message = transcript.messages[index];
		if (message?.role !== "user") continue;
		const text = message.blocks
			.filter((block) => block.type === "markdown")
			.map((block) => block.text)
			.join("\n")
			.trim();
		if (text.length > 0) return text;
	}
	return undefined;
}

function renderActiveHint(state: RpcHostChromeState, width: number, sidebarVisible: boolean): string {
	const pad = width > 2 ? 1 : 0;
	const innerWidth = Math.max(0, width - pad * 2);
	const visualHarness = isVisualHarness();
	const project = visualHarness ? "sumocode" : formatCwd(hostCwd());
	const branch = visualHarness ? "main" : state.gitBranch;
	const leftHint = sidebarVisible ? undefined : branch ? `${project} (${branch})` : project;
	const hint = renderInputHints(innerWidth, {
		leftHint,
		leftHintOverflow: "truncate",
		leftHintStyle: "project-branch",
	});
	return `${" ".repeat(pad)}${hint}${" ".repeat(pad)}`;
}

function renderSplashHint(state: RpcHostChromeState, width: number): string {
	const frameWidth = Math.min(width, SPLASH_INPUT_FRAME_WIDTH);
	const modelId = state.modelLabel ? state.modelLabel.split("/").pop()! : "no model";
	const hint = renderInputHints(frameWidth, {
		leftHint: splashInvocationHint(modelId, state.thinkingLevel),
		leftHintStyle: "model-thinking",
	});
	return centerAnsi(hint, width);
}

function centerAnsi(line: string, width: number): string {
	const visible = visibleWidth(line);
	if (visible >= width) return line;
	const left = Math.floor((width - visible) / 2);
	const right = width - visible - left;
	return `${" ".repeat(left)}${line}${" ".repeat(right)}`;
}

function centerRows(rows: readonly string[], width: number): string[] {
	return rows.map((row) => centerAnsi(row, width));
}

class RpcEditorShellComponent implements ShellRenderable {
	public constructor(
		private readonly adapter: RpcShellAdapter,
		private readonly inputPreview: string | undefined,
	) {}
	public invalidate(): void {}
	public render(width: number): string[] {
		return this.adapter.renderEditor(width, this.inputPreview);
	}
}

class RpcHintComponent implements ShellRenderable {
	public constructor(private readonly adapter: RpcShellAdapter) {}
	public invalidate(): void {}
	public render(width: number): string[] {
		const extensionRows = this.adapter.renderExtensionBelowEditor(width).filter((row) => stripAnsi(row).trim().length > 0);
		if (extensionRows.length > 0) return [extensionRows[0]!];
		if (!this.adapter.isActive()) return [renderSplashHint(this.adapter.getState(), width)];
		const sidebarVisible = width >= SIDEBAR_MIN_TERMINAL_WIDTH;
		return [renderActiveHint(this.adapter.getState(), width, sidebarVisible)];
	}
}

class RpcAboveEditorComponent implements ShellRenderable {
	public constructor(private readonly adapter: RpcShellAdapter) {}
	public invalidate(): void {}
	public render(width: number): string[] {
		// Queued steer/follow-up messages render above everything else in this
		// region (visually: bottom of the chat area), including when an
		// extension region (e.g. approval prompt) is active — a queued message
		// must never silently vanish from view.
		const queuedRows = this.adapter.renderQueuedMessages(width);
		const extensionRows = this.adapter.renderExtensionAboveEditor(width);
		if (extensionRows.length > 0) return ["", ...queuedRows, ...extensionRows];
		if (!this.adapter.isActive()) return queuedRows.length > 0 ? ["", ...queuedRows] : [];
		const indicatorRows = this.adapter.renderWorkingIndicator(width).filter((row) => row.length > 0);
		const rows = [...queuedRows, ...indicatorRows];
		return rows.length > 0 ? ["", ...rows] : [];
	}
}

class RpcFooterComponent implements ShellRenderable {
	public constructor(private readonly adapter: RpcShellAdapter) {}
	public invalidate(): void {}
	public render(width: number): string[] {
		if (!this.adapter.isActive()) {
			const version = renderSplashVersionLine(width);
			return version ? [version] : [""];
		}
		return renderFooterBlock(footerSnapshot(this.adapter.getState(), false), width);
	}
}

class RpcOverlayHost {
	public constructor(private readonly adapter: RpcShellAdapter) {}

	public get overlayStack(): readonly ShellOverlayEntry[] {
		const entries: ShellOverlayEntry[] = [];
		const notifications = this.adapter.getNotifications();
		if (notifications) {
			entries.push({
				component: notifications,
				options: { anchor: "top-left", row: this.adapter.isActive() ? 3 : 0, width: "100%" },
				focusOrder: 10,
			});
		}
		const overlay = this.adapter.getOverlay();
		if (overlay) {
			entries.push({
				component: overlay,
				options: { anchor: "center", width: "80%", maxHeight: "80%" },
				hidden: !overlay.getActiveKind?.(),
				focusOrder: 20,
			});
		}
		const modal = this.adapter.getModal();
		if (modal) {
			entries.push({
				component: modal,
				// Centered card, NOT a full-screen surface: ModalLayer renders the
				// Divine Query panel (or generic card for editor kind) and the
				// renderer anchors it, so the transcript and chrome stay visible
				// behind the modal. Geometry mirrors DIVINE_QUERY_OVERLAY_OPTIONS
				// (divine-query.ts) so RPC-path dialogs sit exactly where the
				// owned shell put them.
				options: { anchor: "center", width: 80, minWidth: 56, maxHeight: "65%" },
				hidden: !modal.getActiveKind?.(),
				focusOrder: 30,
			});
		}
		return entries;
	}

	public isOverlayVisible(entry: ShellOverlayEntry): boolean {
		if (entry.hidden === true) return false;
		return entry.component.render(1).length > 0;
	}
}
