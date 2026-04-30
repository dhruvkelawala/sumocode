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
import { FrameScheduler } from "../runtime/frame-scheduler.js";
import { defaultTerminalSessionOwner, TerminalSessionOwner, type TerminalOutput } from "../runtime/terminal-controller.js";
import { ChatPager } from "../widgets/chat-pager.js";
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

	public constructor(output: TerminalLike = process.stdout, terminalSession?: TerminalSessionOwner) {
		this.output = output;
		this.terminal = terminalSession ?? (output === process.stdout ? defaultTerminalSessionOwner : new TerminalSessionOwner({ output }));
		this.selection = new SelectionController({
			emitClipboard: (sequence) => {
				this.terminal.writeClipboardSequence(sequence);
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
		this.shellTransition = new RetainedShellTransition({ root: this.root, chat: this.chat, splash: this.splash, emptyChatQuote: this.emptyChatQuote });
		this.syncChatSlot();
		// Retained SumoInteractiveMode owns the application terminal contract.
		// The extension lifecycle shim also enters altscreen when loaded, but the
		// runtime must not depend on extension ordering: mouse wheel chat scrolling
		// only works reliably when SGR mouse mode is enabled before Pi's first
		// interactive frame.
		this.terminal.startRetainedSession();
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
		const frame = this.renderChatFrame(width, height).frame;
		return this.selection.handleMouseEvent(event, frame);
	}

	public handleSelectionKey(event: KeyEvent, width: number, height: number): boolean {
		const frame = this.renderChatFrame(width, height).frame;
		return this.selection.handleKey(event, frame);
	}

	private renderChatFrame(width: number, height: number): { frame: CellBuffer; lines: string[] } {
		const safeWidth = Math.max(1, Math.floor(width));
		const safeHeight = Math.max(1, Math.floor(height));
		if (!this.root) {
			const empty = new CellBuffer(safeHeight, safeWidth);
			return { frame: empty, lines: bufferToAnsiLines(empty) };
		}
		const selectionRevision = this.selection.getRevision();
		const cached = this.chatFrameCache;
		if (cached && cached.width === safeWidth && cached.height === safeHeight && cached.version === this.frameVersion && cached.selectionRevision === selectionRevision) {
			return { frame: cached.frame.clone(), lines: [...cached.lines] };
		}

		this.syncChatSlot();
		this.root.width = safeWidth;
		this.root.height = safeHeight;
		this.root.yogaNode.calculateLayout(safeWidth, safeHeight, DIRECTION_LTR);
		const frame = new CellBuffer(safeHeight, safeWidth);
		composite(this.root, frame, { selection: this.selection });
		const lines = bufferToAnsiLines(frame);
		this.chatFrameCache = { width: safeWidth, height: safeHeight, version: this.frameVersion, selectionRevision, frame: frame.clone(), lines };
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
		this.emptyChatQuote?.dispose();
		this.root?.dispose();
		this.previousFrame = undefined;
		this.chatFrameCache = undefined;
		this.externalRenderControls = undefined;
		this.scheduler = undefined;
		this.chat = undefined;
		this.splash = undefined;
		this.emptyChatQuote = undefined;
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
		const width = Math.max(1, this.output.columns ?? 80);
		const height = Math.max(1, this.output.rows ?? 24);
		if (this.previousFrame && this.renderedVersion === this.frameVersion && this.renderedWidth === width && this.renderedHeight === height && !this.root.yogaNode.isDirty()) {
			return;
		}
		this.syncChatSlot();
		this.root.width = width;
		this.root.height = height;
		this.root.yogaNode.calculateLayout(width, height, DIRECTION_LTR);
		const nextFrame = new CellBuffer(height, width);
		const result = composite(this.root, nextFrame, { selection: this.selection });
		const patches = diffFrames(this.previousFrame, nextFrame);
		this.terminal.writeFramePatches(patches, result.hardwareCursor);
		this.previousFrame = nextFrame.clone();
		this.renderedVersion = this.frameVersion;
		this.renderedWidth = width;
		this.renderedHeight = height;
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
	}
}

export function sumoInteractiveMode(runtimeHost: AgentSessionRuntime, options: SumoInteractiveModeOptions = {}): SumoInteractiveMode {
	return new SumoInteractiveMode(runtimeHost, options);
}
