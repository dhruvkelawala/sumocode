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
import { EmptyChatQuoteNode, shouldRenderEmptyChatQuote, type EmptyChatQuoteSnapshot } from "../cathedral/empty-chat-quote.js";
import { createSplashTree, defaultSplashSnapshot, type SplashTree } from "../cathedral/splash-tree.js";
import { SumoNode } from "../layout/node.js";
import { DIRECTION_LTR, FLEX_DIRECTION_COLUMN, loadYoga, type Yoga } from "../layout/yoga.js";
import { bufferToAnsiLines } from "../render/ansi-writer.js";
import { CellBuffer } from "../render/buffer.js";
import { composite } from "../render/compositor.js";
import { diffFrames } from "../render/diff.js";
import { FrameScheduler } from "../runtime/frame-scheduler.js";
import { TerminalController } from "../runtime/terminal-controller.js";
import { ChatPager } from "../widgets/chat-pager.js";
import { SIDEBAR_MIN_TERMINAL_WIDTH } from "../../sidebar.js";
import { installChatViewportBridge } from "./chat-viewport-controller.js";
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

interface TerminalLike {
	readonly isTTY?: boolean;
	readonly columns?: number;
	readonly rows?: number;
	write(data: string): unknown;
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

const ANSI_PATTERN = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)|_[^\x07]*(?:\x07|\x1b\\))/g;
const FALSE_ENV_VALUES = new Set(["0", "false", "no", "off"]);
const PI_NOISE_FILTER_INSTALLED = Symbol("sumo-tui.pi-noise-filter-installed");

export const PI_NOISE_TEXT_PATTERNS: readonly RegExp[] = [
	/\[Extension issues\]/i,
	/Warning:\s*Anthropic subscription auth is active/i,
	/Anthropic subscription auth is active\. Third-party harness usage/i,
];

interface PiChatContainer {
	children?: unknown[];
	addChild?(component: unknown): void;
	clear?(): void;
	invalidate?(): void;
	render?(width: number): string[];
}

interface FilterablePiChatContainer extends PiChatContainer {
	[PI_NOISE_FILTER_INSTALLED]?: true;
}

export interface PiNoiseFilterState {
	removedNodes: unknown[];
	skipNextSpacer: boolean;
}

function envFlagEnabled(value: string | undefined, defaultValue: boolean): boolean {
	if (value === undefined) return defaultValue;
	return !FALSE_ENV_VALUES.has(value.trim().toLowerCase());
}

function stripAnsi(text: string): string {
	return text.replace(ANSI_PATTERN, "");
}

function getTextComponentContent(component: unknown): string | undefined {
	if (typeof component !== "object" || component === null || !("text" in component)) return undefined;
	const text = (component as { text?: unknown }).text;
	return typeof text === "string" ? text : undefined;
}

function isSpacerComponent(component: unknown): boolean {
	if (typeof component !== "object" || component === null) return false;
	return component.constructor?.name === "Spacer";
}

export function shouldHidePiNoise(env: NodeJS.ProcessEnv = process.env): boolean {
	return envFlagEnabled(env.SUMO_TUI_HIDE_PI_NOISE, true);
}

export function shouldForceHardwareCursor(env: NodeJS.ProcessEnv = process.env): boolean {
	return envFlagEnabled(env.SUMO_TUI_SHOW_HARDWARE_CURSOR, true);
}

export function isPiNoiseTextComponent(component: unknown): boolean {
	const text = getTextComponentContent(component);
	if (text === undefined) return false;
	const plain = stripAnsi(text);
	return PI_NOISE_TEXT_PATTERNS.some((pattern) => pattern.test(plain));
}

function getUpstreamChatContainer(upstream: unknown): PiChatContainer | undefined {
	if (typeof upstream !== "object" || upstream === null || !("chatContainer" in upstream)) return undefined;
	const chatContainer = (upstream as { chatContainer?: unknown }).chatContainer;
	return typeof chatContainer === "object" && chatContainer !== null ? (chatContainer as PiChatContainer) : undefined;
}

export function filterPiNoiseChildren(container: PiChatContainer, state: PiNoiseFilterState = { removedNodes: [], skipNextSpacer: false }): number {
	if (!Array.isArray(container.children)) return 0;
	const nextChildren: unknown[] = [];
	let removed = 0;
	let skipNextSpacer = state.skipNextSpacer;
	for (const child of container.children) {
		if (isPiNoiseTextComponent(child)) {
			state.removedNodes.push(child);
			removed += 1;
			skipNextSpacer = true;
			continue;
		}
		if (skipNextSpacer && isSpacerComponent(child)) {
			state.removedNodes.push(child);
			removed += 1;
			skipNextSpacer = false;
			continue;
		}
		skipNextSpacer = false;
		nextChildren.push(child);
	}
	container.children = nextChildren;
	state.skipNextSpacer = skipNextSpacer;
	return removed;
}

export function installPiNoiseFilter(upstream: unknown, state: PiNoiseFilterState = { removedNodes: [], skipNextSpacer: false }): boolean {
	const container = getUpstreamChatContainer(upstream) as FilterablePiChatContainer | undefined;
	if (!container?.addChild || container[PI_NOISE_FILTER_INSTALLED]) return false;
	const originalAddChild = container.addChild.bind(container);
	container.addChild = (component: unknown): void => {
		if (isPiNoiseTextComponent(component)) {
			state.removedNodes.push(component);
			state.skipNextSpacer = true;
			debugLog("suppressed Pi startup noise from chatContainer");
			return;
		}
		if (state.skipNextSpacer && isSpacerComponent(component)) {
			state.removedNodes.push(component);
			state.skipNextSpacer = false;
			return;
		}
		state.skipNextSpacer = false;
		originalAddChild(component);
	};
	container[PI_NOISE_FILTER_INSTALLED] = true;
	return true;
}

export function forceHardwareCursorVisible(upstream: unknown): boolean {
	if (typeof upstream !== "object" || upstream === null || !("ui" in upstream)) return false;
	const ui = (upstream as { ui?: unknown }).ui;
	if (typeof ui !== "object" || ui === null || !("setShowHardwareCursor" in ui)) return false;
	const setShowHardwareCursor = (ui as { setShowHardwareCursor?: unknown }).setShowHardwareCursor;
	if (typeof setShowHardwareCursor !== "function") return false;
	setShowHardwareCursor.call(ui, true);
	return true;
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
	private readonly terminal: TerminalController;
	private yoga: Yoga | undefined;
	private root: SumoNode | undefined;
	private chat: ChatPager | undefined;
	private splash: SplashTree | undefined;
	private emptyChatQuote: EmptyChatQuoteNode | undefined;
	private scheduler: FrameScheduler | undefined;
	private previousFrame: CellBuffer | undefined;
	private resizeHandler: (() => void) | undefined;
	private externalRenderControls: { scheduleRender(): void; setStreamingMode(enabled: boolean): void } | undefined;
	private frameVersion = 0;
	private renderedVersion = -1;
	private renderedWidth = 0;
	private renderedHeight = 0;
	private chatFrameCache: { width: number; height: number; version: number; lines: string[] } | undefined;
	private activeEmptyChat = false;
	private emptyChatUserMessageCount = 0;
	private started = false;

	public constructor(output: TerminalLike = process.stdout) {
		this.output = output;
		this.terminal = new TerminalController({ output });
	}

	public async start(): Promise<SumoInteractiveRuntimeSnapshot> {
		if (this.started && this.root && this.chat && this.scheduler && this.splash) {
			return { root: this.root, chat: this.chat, scheduler: this.scheduler, splash: this.splash };
		}

		this.yoga = await loadYoga();
		this.root = new SumoNode(this.yoga.Node.create());
		this.root.flexDirection = FLEX_DIRECTION_COLUMN;
		this.chat = ChatPager.create(this.yoga, undefined, {
			renderControls: {
				scheduleRender: () => this.requestRender(),
				setStreamingMode: (enabled) => this.setStreamingMode(enabled),
			},
		});
		this.splash = createSplashTree(this.yoga, undefined, () => defaultSplashSnapshot(this.chat?.hasMessages() ?? false));
		this.emptyChatQuote = new EmptyChatQuoteNode(this.yoga.Node.create(), () => this.emptyChatQuoteSnapshot());
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
		if (!this.root) return [];
		const safeWidth = Math.max(1, Math.floor(width));
		const safeHeight = Math.max(1, Math.floor(height));
		const cached = this.chatFrameCache;
		if (cached && cached.width === safeWidth && cached.height === safeHeight && cached.version === this.frameVersion) {
			return [...cached.lines];
		}

		this.syncChatSlot();
		this.root.width = safeWidth;
		this.root.height = safeHeight;
		this.root.yogaNode.calculateLayout(safeWidth, safeHeight, DIRECTION_LTR);
		const frame = new CellBuffer(safeHeight, safeWidth);
		composite(this.root, frame);
		const lines = bufferToAnsiLines(frame);
		this.chatFrameCache = { width: safeWidth, height: safeHeight, version: this.frameVersion, lines };
		return [...lines];
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
		if (!this.root || !this.chat || !this.splash) return;
		const hasMessages = this.chat.hasMessages();
		this.splash.syncVisibility();
		// Per UX_SPEC §0: "no messages → splash (cat + SUMOCODE wordmark + quote,
		// full width); first message / /resume → cathedral active state". The
		// empty-chat-quote (§4.4) was a misinterpretation that contradicted §0 —
		// it stole the splash slot whenever sidebar was visible + no messages,
		// causing the splash to flash for one frame at boot then disappear. We
		// keep the EmptyChatQuoteNode allocated for v2 work but never mount it.
		if (this.emptyChatQuote && this.emptyChatQuote.parent === this.root) {
			this.root.removeChild(this.emptyChatQuote);
		}
		if (hasMessages) {
			if (this.splash.root.parent === this.root) this.root.removeChild(this.splash.root);
			if (this.chat.parent !== this.root) this.root.addChild(this.chat);
			return;
		}
		if (this.chat.parent === this.root) this.root.removeChild(this.chat);
		if (this.splash.root.parent !== this.root) this.root.addChild(this.splash.root);
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
		const result = composite(this.root, nextFrame);
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
