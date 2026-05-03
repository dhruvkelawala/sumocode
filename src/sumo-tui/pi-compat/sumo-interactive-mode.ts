/*
 * MIT License
 *
 * Portions of this compatibility boundary are derived from
 * @mariozechner/pi-coding-agent 0.70.2, package `dist/modes/interactive/interactive-mode.js`.
 * The upstream npm package declares license: MIT.
 *
 * Copyright (c) Mario Zechner and pi-mono contributors.
 * Copyright (c) Dhruv Kelawala and SumoCode contributors.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import type { AgentSessionRuntime, InteractiveModeOptions } from "@mariozechner/pi-coding-agent";
import { InteractiveMode } from "@mariozechner/pi-coding-agent";
import type { ExtensionUIContext } from "@mariozechner/pi-coding-agent";
import type { Component } from "@mariozechner/pi-tui";
import { loadSumoCodeConfig } from "../../config/sumocode-config.js";
import { EmptyChatQuoteNode, shouldRenderEmptyChatQuote, type EmptyChatQuoteSnapshot } from "../cathedral/empty-chat-quote.js";
import { createSplashTree, defaultSplashSnapshot, type SplashTree } from "../cathedral/splash-tree.js";
import { SumoNode } from "../layout/node.js";
import { DIRECTION_LTR, FLEX_DIRECTION_COLUMN, loadYoga, type Yoga } from "../layout/yoga.js";
import { bufferToAnsiLines } from "../render/ansi-writer.js";
import { CellBuffer } from "../render/buffer.js";
import { composite } from "../render/compositor.js";
import type { KeyEvent } from "../input/key-router.js";
import type { MouseEvent } from "../input/mouse.js";
import { SelectionController } from "../input/selection.js";
import { diffFrames } from "../render/diff.js";
import { logDiagnostic, logRuntimeStart } from "../runtime/diagnostics.js";
import { FrameScheduler } from "../runtime/frame-scheduler.js";
import { emitResumeBudgetOverlay, measureMaybe, ResumeProfiler, type ResumeProfileMetadata } from "../runtime/resume-profiler.js";
import { defaultTerminalSessionOwner, TerminalSessionOwner, type TerminalOutput } from "../runtime/terminal-controller.js";
import { ChatPager } from "../widgets/chat-pager.js";
import { NotificationCenter } from "../widgets/notification.js";
import { PiComponentLeaf } from "../widgets/pi-component-leaf.js";
import { SIDEBAR_MIN_TERMINAL_WIDTH } from "../../sidebar.js";
import { installChatViewportBridge } from "./chat-viewport-controller.js";
import {
	filterPiNoiseChildren,
	forceHardwareCursorVisible,
	getUpstreamChatContainer,
	installPiNoiseFilter,
	shouldForceHardwareCursor,
	shouldHidePiNoise,
	type PiNoiseFilterState,
} from "./pi-interactive-adapter.js";
export {
	filterPiNoiseChildren,
	forceHardwareCursorVisible,
	installPiNoiseFilter,
	isPiNoiseTextComponent,
	shouldForceHardwareCursor,
	shouldHidePiNoise,
	type PiNoiseFilterState,
} from "./pi-interactive-adapter.js";
import { RetainedShellTransition } from "./retained-shell-transition.js";
import { OwnedShellRenderer } from "./owned-shell-renderer.js";
import { SumoExtensionUIAdapter, type SumoExtensionUIAdapterOptions } from "./extension-ui-adapter.js";
import { createForeignAwareUIContext, type ForeignAwareUIOptions } from "./foreign-extension-warning.js";

export interface SumoInteractiveModeOptions extends InteractiveModeOptions {
	/**
	 * Enables the retained extension UI adapter once the Pi binary fork wires this
	 * class in place of InteractiveMode.
	 */
	readonly retainedExtensionUI?: boolean;
}

export interface CreateExtensionUIContextOptions extends SumoExtensionUIAdapterOptions {
	readonly foreignExtensions?: ForeignAwareUIOptions;
}

interface TerminalLike extends TerminalOutput {
	readonly columns?: number;
	readonly rows?: number;
}

interface SumoInteractiveRuntimeSnapshot {
	readonly root: SumoNode;
	readonly chat: ChatPager;
	readonly scheduler: FrameScheduler;
	readonly splash: SplashTree;
}

export interface SidebarPublication {
	readonly component: Component;
	readonly isVisible: (cols: number, rows: number) => boolean;
}

export interface TopChromePublication {
	readonly component: Component;
}

// Module-level singleton would normally be enough here, but the retained
// `sumo-interactive-mode.js` jiti loader uses `moduleCache: false` so the
// SumoInteractiveMode and the extension code (sidebar, etc.) end up holding
// different module copies. Cross those copies with a globalThis symbol so a
// single instance is observable from anywhere.
const ACTIVE_SUMO_RUNTIME_KEY = Symbol.for("sumocode.activeSumoRuntime");

interface ActiveRuntimeBox { runtime: SumoInteractiveRuntime | undefined }

function activeRuntimeBox(): ActiveRuntimeBox {
	const host = globalThis as unknown as Record<symbol, ActiveRuntimeBox | undefined>;
	let box = host[ACTIVE_SUMO_RUNTIME_KEY];
	if (!box) {
		box = { runtime: undefined };
		host[ACTIVE_SUMO_RUNTIME_KEY] = box;
	}
	return box;
}

function setActiveSumoRuntime(runtime: SumoInteractiveRuntime | undefined): void {
	activeRuntimeBox().runtime = runtime;
}

/**
 * Module-level accessor so non-Pi extensions (e.g. `installSidebar`) can
 * publish components into the owned shell without going through Pi's overlay
 * stack. Backed by a globalThis symbol because the jiti loader for
 * `sumo-interactive-mode.js` keeps no module cache, which would otherwise give
 * each importer its own private copy of this module.
 */
export function getActiveSumoRuntime(): SumoInteractiveRuntime | undefined {
	return activeRuntimeBox().runtime;
}

function debugLog(message: string): void {
	if (process.env.SUMO_TUI_DEBUG !== "1") return;
	console.error(`[sumo-tui] ${message}`);
}

/**
 * Minimal retained-runtime owner for Phase 4b.
 *
 * The full Pi event-loop port is intentionally incremental: this controller
 * creates the actual sumo-tui primitives (terminal controller, Yoga root,
 * ChatPager, frame scheduler, compositor/diff frame path) before delegating the
 * agent/session loop to upstream Pi. That makes the forked entry point real and
 * testable while keeping Pi behaviour intact until the remaining private
 * interactive-mode responsibilities are ported.
 */
export class SumoInteractiveRuntime {
	private readonly output: TerminalLike;
	private readonly terminal: TerminalSessionOwner;
	private yoga: Yoga | undefined;
	private root: SumoNode | undefined;
	private chat: ChatPager | undefined;
	private splash: SplashTree | undefined;
	private emptyChatQuote: EmptyChatQuoteNode | undefined;
	private selectionNotifications: NotificationCenter | undefined;
	private selectionNotificationNode: PiComponentLeaf | undefined;
	private shellTransition: RetainedShellTransition | undefined;
	private scheduler: FrameScheduler | undefined;
	private readonly selection: SelectionController;
	private previousFrame: CellBuffer | undefined;
	private resizeHandler: (() => void) | undefined;
	private externalRenderControls: { scheduleRender(): void; setStreamingMode(enabled: boolean): void } | undefined;
	private frameVersion = 0;
	private renderedVersion = -1;
	private renderedWidth = 0;
	private renderedHeight = 0;
	private chatFrameCache: { width: number; height: number; version: number; selectionRevision: number; frame: CellBuffer; lines: string[] } | undefined;
	private activeEmptyChat = false;
	private emptyChatUserMessageCount = 0;
	private started = false;
	private pendingResumeProfile: { profile: ResumeProfiler; metadata: ResumeProfileMetadata } | undefined;
	private ownedShellMouseHandler: ((event: MouseEvent) => boolean) | undefined;
	private ownedShellActiveCheck: (() => boolean) | undefined;
	private selectionFrameSource: (() => CellBuffer | undefined) | undefined;
	private sidebarPublication: SidebarPublication | undefined;
	private topChromePublication: TopChromePublication | undefined;

	public constructor(output: TerminalLike = process.stdout, terminalSession?: TerminalSessionOwner) {
		setActiveSumoRuntime(this);
		this.output = output;
		this.terminal = terminalSession ?? (output === process.stdout ? defaultTerminalSessionOwner : new TerminalSessionOwner({ output }));
		this.selection = new SelectionController({
			emitClipboard: (sequence) => {
				this.terminal.writeClipboardSequence(sequence);
			},
			onCopied: () => {
				const hasNotifications = this.selectionNotifications !== undefined;
				logDiagnostic("selection_copied_toast", { hasNotifications });
				this.selectionNotifications?.notify("copied", "success", 1_400);
				this.requestRender();
			},
			onSelectionChanged: () => this.requestRender(),
		});
	}

	public async start(): Promise<SumoInteractiveRuntimeSnapshot> {
		if (this.started && this.root && this.chat && this.scheduler && this.splash) {
			return { root: this.root, chat: this.chat, scheduler: this.scheduler, splash: this.splash };
		}

		this.yoga = await loadYoga();
		const sumocodeConfig = loadSumoCodeConfig().config;
		this.root = new SumoNode(this.yoga.Node.create());
		this.root.flexDirection = FLEX_DIRECTION_COLUMN;
		this.chat = ChatPager.create(this.yoga, undefined, {
			primaryAgentName: sumocodeConfig.primaryAgentName,
			renderControls: {
				scheduleRender: () => this.requestRender(),
				setStreamingMode: (enabled) => this.setStreamingMode(enabled),
			},
		});
		this.splash = createSplashTree(this.yoga, undefined, () => defaultSplashSnapshot(this.chat?.hasMessages() ?? false));
		this.emptyChatQuote = new EmptyChatQuoteNode(this.yoga.Node.create(), () => this.emptyChatQuoteSnapshot());
		this.selectionNotifications = new NotificationCenter({ onChange: () => this.requestRender() });
		this.selectionNotificationNode = PiComponentLeaf.create(this.yoga, this.selectionNotifications, this.root);
		this.selectionNotificationNode.position = "absolute";
		this.selectionNotificationNode.top = 1;
		this.selectionNotificationNode.left = 0;
		this.selectionNotificationNode.right = 1;
		this.selectionNotificationNode.height = 4;
		this.selectionNotificationNode.zIndex = 20_000;
		this.shellTransition = new RetainedShellTransition({ root: this.root, chat: this.chat, splash: this.splash, emptyChatQuote: this.emptyChatQuote });
		this.syncChatSlot();
		// Retained SumoInteractiveMode owns the application terminal contract.
		// The extension lifecycle shim also enters altscreen when loaded, but the
		// runtime must not depend on extension ordering: mouse wheel chat scrolling
		// only works reliably when SGR mouse mode is enabled before Pi's first
		// interactive frame.
		this.terminal.startRetainedSession();
		logRuntimeStart({
			terminal: {
				columns: this.output.columns ?? null,
				rows: this.output.rows ?? null,
				isTTY: this.output.isTTY,
			},
			features: {
				retainedTui: true,
				mouseSgr: true,
			},
		});
		this.scheduler = new FrameScheduler({ render: () => this.render() });
		this.resizeHandler = () => this.requestRender();
		process.stdout.on("resize", this.resizeHandler);
		this.started = true;
		debugLog("SumoInteractiveMode retained runtime started");
		return { root: this.root, chat: this.chat, scheduler: this.scheduler, splash: this.splash };
	}

	public setExternalRenderControls(controls: { scheduleRender(): void; setStreamingMode(enabled: boolean): void } | undefined): void {
		this.externalRenderControls = controls;
	}

	public requestRender(): void {
		this.invalidateFrameCache();
		if (this.externalRenderControls) {
			this.externalRenderControls.scheduleRender();
			return;
		}
		this.scheduler?.requestRender();
	}

	public renderChatLines(width: number, height: number): string[] {
		return [...this.renderChatFrame(width, height).lines];
	}

	public handleSelectionMouse(event: MouseEvent, width: number, height: number): boolean {
		const frame = this.selectionFrameSource?.() ?? this.renderChatFrame(width, height).frame;
		return this.selection.handleMouseEvent(event, frame);
	}

	public handleSelectionKey(event: KeyEvent, width: number, height: number): boolean {
		const frame = this.selectionFrameSource?.() ?? this.renderChatFrame(width, height).frame;
		return this.selection.handleKey(event, frame);
	}

	public getSelectionController(): SelectionController {
		return this.selection;
	}

	public setSelectionFrameSource(source: (() => CellBuffer | undefined) | undefined): void {
		this.selectionFrameSource = source;
	}

	public startResumeProfile(): ResumeProfiler {
		return new ResumeProfiler();
	}

	public completeResumeHydration(profile: ResumeProfiler, metadata: ResumeProfileMetadata): void {
		this.pendingResumeProfile = { profile, metadata };
	}

	public setOwnedShellMouseHandler(handler: ((event: MouseEvent) => boolean) | undefined): void {
		this.ownedShellMouseHandler = handler;
	}

	public handleOwnedShellMouse(event: MouseEvent): boolean {
		return this.ownedShellMouseHandler?.(event) === true;
	}

	public setOwnedShellActiveCheck(check: (() => boolean) | undefined): void {
		this.ownedShellActiveCheck = check;
	}

	public isOwnedShellActive(): boolean {
		return this.ownedShellActiveCheck?.() === true;
	}

	/**
	 * Publish the sidebar component to the owned-shell so it can mount it as a
	 * Yoga sibling of the chat region. Called by `installSidebar` instead of
	 * `tui.showOverlay()` when owned-shell is enabled. Pass `undefined` to
	 * unpublish (e.g. on session shutdown).
	 */
	public setSidebarComponent(
		component: Component | undefined,
		isVisible: (cols: number, rows: number) => boolean = () => true,
	): void {
		this.sidebarPublication = component ? { component, isVisible } : undefined;
		logDiagnostic("sumo_runtime_sidebar_publication", {
			hasComponent: component !== undefined,
		});
		this.requestRender();
	}

	public getSidebarPublication(): SidebarPublication | undefined {
		return this.sidebarPublication;
	}

	/** Publish the retained top-chrome component consumed by OwnedShellRenderer. */
	public setTopChromeComponent(component: Component | undefined): void {
		this.topChromePublication = component ? { component } : undefined;
		logDiagnostic("sumo_runtime_top_chrome_publication", {
			hasComponent: component !== undefined,
		});
		this.requestRender();
	}

	public getTopChromePublication(): TopChromePublication | undefined {
		return this.topChromePublication;
	}

	public getYoga(): Yoga | undefined {
		return this.yoga;
	}

	public getTerminalSessionOwner(): TerminalSessionOwner {
		return this.terminal;
	}

	private renderChatFrame(width: number, height: number): { frame: CellBuffer; lines: string[] } {
		const safeWidth = Math.max(1, Math.floor(width));
		const safeHeight = Math.max(1, Math.floor(height));
		if (!this.root) {
			const empty = new CellBuffer(safeHeight, safeWidth);
			return { frame: empty, lines: bufferToAnsiLines(empty) };
		}
		const root = this.root;
		const selectionRevision = this.selection.getRevision();
		const cached = this.chatFrameCache;
		if (cached && cached.width === safeWidth && cached.height === safeHeight && cached.version === this.frameVersion && cached.selectionRevision === selectionRevision) {
			return { frame: cached.frame.clone(), lines: [...cached.lines] };
		}

		this.syncChatSlot();
		root.width = safeWidth;
		root.height = safeHeight;
		const pendingProfile = this.claimPendingResumeProfile();
		measureMaybe(pendingProfile?.profile, "yoga_first_layout", () => root.yogaNode.calculateLayout(safeWidth, safeHeight, DIRECTION_LTR));
		const renderStart = performance.now();
		const { frame, lines } = measureMaybe(pendingProfile?.profile, "first_frame_render", () => {
			const nextFrame = new CellBuffer(safeHeight, safeWidth);
			composite(root, nextFrame, { selection: this.selection });
			return { frame: nextFrame, lines: bufferToAnsiLines(nextFrame) };
		});
		const renderMs = performance.now() - renderStart;
		logDiagnostic(renderMs > 33 ? "slow_frame" : "render_frame", { path: "chat_viewport", durationMs: Math.round(renderMs * 100) / 100, width: safeWidth, height: safeHeight, selectionRevision });
		this.chatFrameCache = { width: safeWidth, height: safeHeight, version: this.frameVersion, selectionRevision, frame: frame.clone(), lines };
		if (pendingProfile) this.finishPendingResumeProfile(pendingProfile);
		return { frame: frame.clone(), lines: [...lines] };
	}

	public writeChatViewport(top: number, left: number, width: number, height: number): boolean {
		this.invalidateFrameCache();
		return this.terminal.writeChatViewport(top, left, this.renderChatLines(width, height));
	}

	public stop(): void {
		if (!this.started) return;
		if (this.resizeHandler) process.stdout.off("resize", this.resizeHandler);
		this.scheduler?.dispose();
		this.chat?.dispose();
		this.splash?.root.dispose();
		this.selectionNotifications?.dispose();
		this.selectionNotificationNode?.dispose();
		this.emptyChatQuote?.dispose();
		this.root?.dispose();
		this.previousFrame = undefined;
		this.chatFrameCache = undefined;
		this.externalRenderControls = undefined;
		this.pendingResumeProfile = undefined;
		this.ownedShellMouseHandler = undefined;
		this.ownedShellActiveCheck = undefined;
		this.selectionFrameSource = undefined;
		this.sidebarPublication = undefined;
		this.topChromePublication = undefined;
		if (getActiveSumoRuntime() === this) setActiveSumoRuntime(undefined);
		this.scheduler = undefined;
		this.chat = undefined;
		this.splash = undefined;
		this.emptyChatQuote = undefined;
		this.selectionNotifications = undefined;
		this.selectionNotificationNode = undefined;
		this.shellTransition = undefined;
		this.root = undefined;
		this.yoga = undefined;
		this.resizeHandler = undefined;
		this.frameVersion = 0;
		this.renderedVersion = -1;
		this.renderedWidth = 0;
		this.renderedHeight = 0;
		this.started = false;
		this.terminal.exitTerminal();
		debugLog("SumoInteractiveMode retained runtime stopped");
	}

	public getSnapshot(): SumoInteractiveRuntimeSnapshot | undefined {
		if (!this.root || !this.chat || !this.scheduler || !this.splash) return undefined;
		return { root: this.root, chat: this.chat, scheduler: this.scheduler, splash: this.splash };
	}

	public setEmptyChatQuoteState(state: { active: boolean; userMessageCount: number }): void {
		const nextCount = Math.max(0, Math.floor(state.userMessageCount));
		const changed = this.activeEmptyChat !== state.active || this.emptyChatUserMessageCount !== nextCount;
		this.activeEmptyChat = state.active;
		this.emptyChatUserMessageCount = nextCount;
		if (changed) this.requestRender();
	}

	public noteUserMessage(): void {
		this.activeEmptyChat = false;
		this.emptyChatUserMessageCount += 1;
		this.requestRender();
	}

	private invalidateFrameCache(): void {
		this.frameVersion += 1;
	}

	private syncChatSlot(): void {
		this.shellTransition?.sync();
	}

	private emptyChatQuoteSnapshot(): EmptyChatQuoteSnapshot {
		return {
			sidebarVisible: (this.output.columns ?? 0) >= SIDEBAR_MIN_TERMINAL_WIDTH,
			isSplash: !this.activeEmptyChat,
			userMessageCount: this.emptyChatUserMessageCount,
		};
	}

	/** @deprecated UX_SPEC §0 says splash, not empty-chat-quote, takes the no-messages slot.
	 *  Kept private so the EmptyChatQuote module + tests still type-check while we let
	 *  the v2 design re-evaluate whether §4.4 ever ships. */
	// @ts-expect-error retained for future v2 work
	private shouldShowEmptyChatQuote(): boolean {
		return shouldRenderEmptyChatQuote(this.emptyChatQuoteSnapshot()) && !(this.chat?.hasMessages() ?? false);
	}

	private setStreamingMode(enabled: boolean): void {
		if (this.externalRenderControls) {
			this.externalRenderControls.setStreamingMode(enabled);
			return;
		}
		if (enabled) this.scheduler?.enterStreamingMode();
		else this.scheduler?.exitStreamingMode();
	}

	private render(): void {
		if (!this.root || !this.output.isTTY) return;
		const root = this.root;
		const width = Math.max(1, this.output.columns ?? 80);
		const height = Math.max(1, this.output.rows ?? 24);
		if (this.previousFrame && this.renderedVersion === this.frameVersion && this.renderedWidth === width && this.renderedHeight === height && !root.yogaNode.isDirty()) {
			return;
		}
		this.syncChatSlot();
		root.width = width;
		root.height = height;
		const pendingProfile = this.claimPendingResumeProfile();
		measureMaybe(pendingProfile?.profile, "yoga_first_layout", () => root.yogaNode.calculateLayout(width, height, DIRECTION_LTR));
		const renderStart = performance.now();
		const nextFrame = measureMaybe(pendingProfile?.profile, "first_frame_render", () => {
			const frame = new CellBuffer(height, width);
			const compositeResult = composite(root, frame, { selection: this.selection });
			const patches = diffFrames(this.previousFrame, frame);
			this.terminal.writeFramePatches(patches, compositeResult.hardwareCursor);
			logDiagnostic("render_patches", { patchCount: patches.length, cursor: compositeResult.hardwareCursor ?? null });
			return frame;
		});
		const renderMs = performance.now() - renderStart;
		logDiagnostic(renderMs > 33 ? "slow_frame" : "render_frame", { path: "full_root", durationMs: Math.round(renderMs * 100) / 100, width, height, version: this.frameVersion });
		this.previousFrame = nextFrame.clone();
		this.renderedVersion = this.frameVersion;
		this.renderedWidth = width;
		this.renderedHeight = height;
		if (pendingProfile) this.finishPendingResumeProfile(pendingProfile);
	}

	private claimPendingResumeProfile(): { profile: ResumeProfiler; metadata: ResumeProfileMetadata } | undefined {
		const pendingProfile = this.pendingResumeProfile;
		if (!pendingProfile) return undefined;
		// Resume can paint through the hybrid chat-frame path or the full retained
		// root path. The first renderer to claim the profile is the user-visible
		// transition owner; clearing here prevents a later render pass from
		// appending unreported stages to the same profile.
		this.pendingResumeProfile = undefined;
		return pendingProfile;
	}

	private finishPendingResumeProfile(pendingProfile: { profile: ResumeProfiler; metadata: ResumeProfileMetadata }): void {
		emitResumeBudgetOverlay(pendingProfile.profile.finish(pendingProfile.metadata));
	}
}

/**
 * Small Phase 4 fork boundary for Pi 0.70.x.
 *
 * Pi's CLI constructs `InteractiveMode` directly in
 * `node_modules/.pnpm/@mariozechner+pi-coding-agent@0.70.2.../dist/main.js:548-571`.
 * The fork patch now replaces that constructor call with `new
 * SumoInteractiveMode(...)` when `SUMO_TUI=1` or `--sumo-tui` is set.
 *
 * Borrowed responsibilities, with source citations:
 * - interactive entrypoint shape (`init`, `run`, `stop`) mirrors
 *   `interactive-mode.js:389-465`, `interactive-mode.js:501-556`, and
 *   `interactive-mode.js:4512-4530`.
 * - extension UI binding seam is the upstream `createExtensionUIContext()`
 *   dispatch table at `interactive-mode.js:1522-1557`.
 * - extension lifecycle bind remains upstream's `bindCurrentSessionExtensions()`
 *   responsibility at `interactive-mode.js:1128-1207`; this class starts the
 *   retained runtime and exposes the retained UI context object used by tests
 *   and the next private-mode port.
 */
export class SumoInteractiveMode {
	private upstream: InteractiveMode | undefined;
	private readonly retainedRuntime = new SumoInteractiveRuntime();
	private readonly piNoiseFilterState: PiNoiseFilterState = { removedNodes: [], skipNextSpacer: false };
	private retainedUIContext: ExtensionUIContext | undefined;
	private chatViewportBridgeCleanup: (() => void) | undefined;
	private ownedShell: OwnedShellRenderer | undefined;
	private ownedShellOriginalDoRender: (() => void) | undefined;

	public constructor(
		private readonly runtimeHost: AgentSessionRuntime,
		private readonly options: SumoInteractiveModeOptions = {},
	) {}

	public async init(): Promise<void> {
		await this.retainedRuntime.start();
		const upstream = this.ensureUpstream();
		this.configureUpstreamBeforeInit(upstream);
		await upstream.init();
		this.configureUpstreamAfterInit(upstream);
	}

	public async run(): Promise<void> {
		await this.init();
		debugLog("SumoInteractiveMode.run() delegating to Pi session loop");
		await this.ensureUpstream().run();
	}

	public stop(): void {
		this.chatViewportBridgeCleanup?.();
		this.chatViewportBridgeCleanup = undefined;
		this.uninstallOwnedShell();
		this.upstream?.stop();
		this.retainedRuntime.stop();
	}

	public createExtensionUIContext(options: CreateExtensionUIContextOptions): ExtensionUIContext {
		const base = new SumoExtensionUIAdapter(options);
		this.retainedUIContext = options.foreignExtensions
			? createForeignAwareUIContext(base, options.foreignExtensions)
			: base;
		return this.retainedUIContext;
	}

	public getRetainedUIContext(): ExtensionUIContext | undefined {
		return this.retainedUIContext;
	}

	public getRetainedRuntimeSnapshot(): SumoInteractiveRuntimeSnapshot | undefined {
		return this.retainedRuntime.getSnapshot();
	}

	public isRetainedExtensionUIEnabled(): boolean {
		return this.options.retainedExtensionUI === true;
	}

	private ensureUpstream(): InteractiveMode {
		if (!this.upstream) {
			if (shouldForceHardwareCursor() && process.env.PI_HARDWARE_CURSOR === undefined) process.env.PI_HARDWARE_CURSOR = "1";
			this.upstream = new InteractiveMode(this.runtimeHost, this.options);
			this.configureUpstreamBeforeInit(this.upstream);
		}
		return this.upstream;
	}

	private configureUpstreamBeforeInit(upstream: InteractiveMode): void {
		if (shouldHidePiNoise()) installPiNoiseFilter(upstream, this.piNoiseFilterState);
		if (!this.chatViewportBridgeCleanup) this.chatViewportBridgeCleanup = installChatViewportBridge(upstream, this.retainedRuntime);
		if (shouldForceHardwareCursor()) forceHardwareCursorVisible(upstream);
	}

	private configureUpstreamAfterInit(upstream: InteractiveMode): void {
		if (shouldHidePiNoise()) {
			const chatContainer = getUpstreamChatContainer(upstream);
			if (chatContainer) filterPiNoiseChildren(chatContainer, this.piNoiseFilterState);
		}
		if (shouldForceHardwareCursor()) forceHardwareCursorVisible(upstream);
		this.installOwnedShell(upstream);
	}

	private installOwnedShell(upstream: InteractiveMode): void {
		const yoga = this.retainedRuntime.getYoga();
		const snapshot = this.retainedRuntime.getSnapshot();
		const host = upstream as unknown as {
			editorContainer?: unknown;
			headerContainer?: unknown;
			widgetContainerBelow?: unknown;
			pendingMessagesContainer?: unknown;
			footer?: unknown;
			customFooter?: unknown;
			ui?: {
				terminal?: { columns?: number; rows?: number };
				doRender?: () => void;
				overlayStack?: readonly unknown[];
				isOverlayVisible?(entry: unknown): boolean;
			};
		};
		// Pi swaps `customFooter` in for `footer` when an extension calls
		// `setFooter()`. Owned-shell needs to wrap whichever footer Pi is
		// actually painting into the bottom row.
		const footerComponent = host.customFooter ?? host.footer;
		if (!yoga || !snapshot || !host.ui || !host.editorContainer || !host.headerContainer || !host.widgetContainerBelow || !footerComponent) {
			logDiagnostic("owned_shell_install_skipped", {
				hasYoga: yoga !== undefined,
				hasSnapshot: snapshot !== undefined,
				hasUi: host.ui !== undefined,
				hasEditorContainer: host.editorContainer !== undefined,
				hasHeader: host.headerContainer !== undefined,
				hasHint: host.widgetContainerBelow !== undefined,
				hasFooter: footerComponent !== undefined,
			});
			return;
		}

		const dimensions = host.ui.terminal ?? { columns: process.stdout.columns ?? 80, rows: process.stdout.rows ?? 24 };
		const selectionPass = this.retainedRuntime.getSelectionController();
		this.ownedShell = new OwnedShellRenderer({
			yoga,
			chat: snapshot.chat,
			splash: snapshot.splash,
			selection: selectionPass,
			// Resolve Pi container/footer references LAZILY at render time.
			// Pi recreates `customFooter` (and other slots) on session reload
			// (`/resume`, `ctx.newSession`, `ctx.fork`). Capturing references at
			// install time would keep painting disposed components and trigger
			// `ExtensionRunner.assertActive: extension ctx is stale`.
			editorContainer: () => host.editorContainer as never,
			headerContainer: () => host.headerContainer as never,
			topChromePublication: () => this.retainedRuntime.getTopChromePublication(),
			widgetContainerBelow: () => host.widgetContainerBelow as never,
			pendingMessagesContainer: host.pendingMessagesContainer ? (() => host.pendingMessagesContainer as never) : undefined,
			footer: () => (host.customFooter ?? host.footer) as never,
			terminal: this.retainedRuntime.getTerminalSessionOwner(),
			dimensions,
			overlayHost: host.ui as never,
			sidebarPublication: () => this.retainedRuntime.getSidebarPublication(),
		});

		// Selection's hit-test buffer is the OwnedShellRenderer's last full-frame
		// composite. Mouse coords are terminal-absolute, which lines up with the
		// chat region painted into the same buffer.
		this.retainedRuntime.setSelectionFrameSource(() => this.ownedShell?.getLastFrame());

		// Mouse events arrive in stdin bursts (mac trackpads + smooth-scroll mice
		// fire 30+ events per gesture). Apply state synchronously but schedule
		// paint through Pi's frame loop so a burst collapses into a single render.
		this.retainedRuntime.setOwnedShellMouseHandler((event) => {
			const widgetHandled = this.ownedShell?.handleMouseEvent(event) === true;
			let selectionHandled = false;
			if (event.type !== "scroll") {
				const chatRect = this.ownedShell?.getChatRect();
				if (chatRect) {
					selectionHandled = this.retainedRuntime.handleSelectionMouse(event, chatRect.width, chatRect.height);
				}
			}
			const handled = widgetHandled || selectionHandled;
			if (handled) (host.ui as { requestRender?: (force?: boolean) => void } | undefined)?.requestRender?.(true);
			return handled;
		});
		this.retainedRuntime.setOwnedShellActiveCheck(() => this.ownedShell !== undefined);

		// Replace Pi's TUI rendering with the owned-shell render. Pi's stdin
		// listening, requestRender scheduling, and overlay/focus logic continue
		// to drive the render cadence. Patch route, no upstream Pi changes.
		const targetUi = host.ui as { doRender?: () => void };
		this.ownedShellOriginalDoRender = targetUi.doRender?.bind(targetUi);
		targetUi.doRender = () => this.ownedShell?.render();

		// Trigger an immediate paint so the owned shell appears without waiting
		// for the next Pi-driven render request.
		process.nextTick(() => this.ownedShell?.render());

		logDiagnostic("owned_shell_installed", {
			cols: dimensions.columns ?? null,
			rows: dimensions.rows ?? null,
		});
	}

	private uninstallOwnedShell(): void {
		if (!this.ownedShell) return;
		const targetUi = (this.upstream as unknown as { ui?: { doRender?: () => void } } | undefined)?.ui;
		if (targetUi && this.ownedShellOriginalDoRender) targetUi.doRender = this.ownedShellOriginalDoRender;
		this.ownedShellOriginalDoRender = undefined;
		this.retainedRuntime.setOwnedShellMouseHandler(undefined);
		this.retainedRuntime.setOwnedShellActiveCheck(undefined);
		this.retainedRuntime.setSelectionFrameSource(undefined);
		this.ownedShell.dispose();
		this.ownedShell = undefined;
		logDiagnostic("owned_shell_uninstalled", {});
	}
}

export function sumoInteractiveMode(runtimeHost: AgentSessionRuntime, options: SumoInteractiveModeOptions = {}): SumoInteractiveMode {
	return new SumoInteractiveMode(runtimeHost, options);
}
