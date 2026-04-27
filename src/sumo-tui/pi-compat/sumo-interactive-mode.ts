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
import { SumoNode } from "../layout/node.js";
import { DIRECTION_LTR, FLEX_DIRECTION_COLUMN, loadYoga, type Yoga } from "../layout/yoga.js";
import { CellBuffer } from "../render/buffer.js";
import { composite, type HardwareCursor } from "../render/compositor.js";
import { diffFrames, type FrameDiffPatch } from "../render/diff.js";
import { FrameScheduler } from "../runtime/frame-scheduler.js";
import { TerminalController } from "../runtime/terminal-controller.js";
import { ChatPager } from "../widgets/chat-pager.js";
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
class SumoInteractiveRuntime {
	private readonly output: TerminalLike;
	private readonly terminal: TerminalController;
	private yoga: Yoga | undefined;
	private root: SumoNode | undefined;
	private chat: ChatPager | undefined;
	private scheduler: FrameScheduler | undefined;
	private previousFrame: CellBuffer | undefined;
	private resizeHandler: (() => void) | undefined;
	private started = false;

	public constructor(output: TerminalLike = process.stdout) {
		this.output = output;
		this.terminal = new TerminalController({ output });
	}

	public async start(): Promise<SumoInteractiveRuntimeSnapshot> {
		if (this.started && this.root && this.chat && this.scheduler) {
			return { root: this.root, chat: this.chat, scheduler: this.scheduler };
		}

		this.yoga = await loadYoga();
		this.root = new SumoNode(this.yoga.Node.create());
		this.root.flexDirection = FLEX_DIRECTION_COLUMN;
		this.chat = ChatPager.create(this.yoga, this.root, {
			renderControls: {
				scheduleRender: () => this.scheduler?.requestRender(),
				setStreamingMode: (enabled) => {
					if (enabled) this.scheduler?.enterStreamingMode();
					else this.scheduler?.exitStreamingMode();
				},
			},
		});
		this.scheduler = new FrameScheduler({ render: () => this.render() });
		this.resizeHandler = () => this.scheduler?.requestRender();
		process.stdout.on("resize", this.resizeHandler);
		this.started = true;
		debugLog("SumoInteractiveMode retained runtime started");
		return { root: this.root, chat: this.chat, scheduler: this.scheduler };
	}

	public requestRender(): void {
		this.scheduler?.requestRender();
	}

	public stop(): void {
		if (!this.started) return;
		if (this.resizeHandler) process.stdout.off("resize", this.resizeHandler);
		this.scheduler?.dispose();
		this.root?.dispose();
		this.previousFrame = undefined;
		this.scheduler = undefined;
		this.chat = undefined;
		this.root = undefined;
		this.yoga = undefined;
		this.resizeHandler = undefined;
		this.started = false;
		this.terminal.exitTerminal();
		debugLog("SumoInteractiveMode retained runtime stopped");
	}

	public getSnapshot(): SumoInteractiveRuntimeSnapshot | undefined {
		if (!this.root || !this.chat || !this.scheduler) return undefined;
		return { root: this.root, chat: this.chat, scheduler: this.scheduler };
	}

	private render(): void {
		if (!this.root || !this.output.isTTY) return;
		const width = Math.max(1, this.output.columns ?? 80);
		const height = Math.max(1, this.output.rows ?? 24);
		this.root.width = width;
		this.root.height = height;
		this.root.yogaNode.calculateLayout(width, height, DIRECTION_LTR);
		const nextFrame = new CellBuffer(height, width);
		const result = composite(this.root, nextFrame);
		const patches = diffFrames(this.previousFrame, nextFrame);
		this.writePatches(patches, result.hardwareCursor);
		this.previousFrame = nextFrame.clone();
	}

	private writePatches(patches: readonly FrameDiffPatch[], hardwareCursor: HardwareCursor | null): void {
		if (patches.length === 0 && !hardwareCursor) return;
		let output = "\x1b[?2026h";
		for (const patch of patches) {
			if (patch.type === "scroll") {
				output += patch.ansi;
				continue;
			}
			output += `\x1b[${patch.row + 1};1H${patch.ansi}\x1b[K`;
		}
		if (hardwareCursor) output += `\x1b[${hardwareCursor.row + 1};${hardwareCursor.col + 1}H\x1b[?25h`;
		output += "\x1b[?2026l";
		this.output.write(output);
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
