import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { visibleWidth, type Component } from "@earendil-works/pi-tui";
import {
	INPUT_FRAME_HINT_AWAITING,
	INPUT_FRAME_LABEL_SPLASH,
	INPUT_FRAME_PLACEHOLDER,
	renderInputFrame,
	renderInputHints,
} from "../../cathedral/input-frame.js";
import {
	formatCwd,
	renderFooterBlock,
	renderSplashVersionLine,
	type FooterSnapshot,
	type ThinkingLevel,
} from "../../footer.js";
import { getCachedMcpRoster } from "../../mcp-config-reader.js";
import { SIDEBAR_MIN_TERMINAL_WIDTH } from "../../sidebar-placement.js";
import { PLACEHOLDER_MCP, renderSidebar } from "../../sidebar.js";
import { renderTopChromeBlock, type TopChromeSnapshot } from "../../top-chrome.js";
import { type SumoCodeState } from "../../themes/index.js";
import { createSplashTree, defaultSplashSnapshot, type SplashTree } from "../cathedral/splash-tree.js";
import { loadYoga, type Yoga } from "../layout/yoga.js";
import type { CellBuffer } from "../render/buffer.js";
import type { ShellOverlayEntry, ShellRenderable, ShellTerminalSessionOwner, ShellViewport } from "../shell/contracts.js";
import { RetainedShellRenderer } from "../shell/retained-shell-renderer.js";
import type { TranscriptViewModel } from "../transcript/view-model.js";
import { ChatPager } from "../widgets/chat-pager.js";
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
	readonly notifications?: Component;
}

export interface RpcShellAdapterSnapshot {
	readonly state: RpcHostChromeState;
	readonly transcript: TranscriptViewModel;
}

interface SplashAwareComponent extends Component {
	setSplashProvider?(provider: () => boolean): void;
}

interface TextReadableComponent extends Component {
	getText?(): string;
}

class RpcHardwareCursorSuppressor implements ShellTerminalSessionOwner {
	public constructor(private readonly terminal: ShellTerminalSessionOwner) {}

	public writeFramePatches(...args: Parameters<ShellTerminalSessionOwner["writeFramePatches"]>): void {
		const [patches] = args;
		this.terminal.writeFramePatches(patches, null);
	}
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
const VISUAL_THINKING_LEVEL: ThinkingLevel = "medium";

const EMPTY_COMPONENT: ShellRenderable = {
	render(): string[] {
		return [];
	},
	invalidate(): void {},
};

export class RpcShellAdapter {
	private readonly chat: ChatPager;
	private readonly splash: SplashTree;
	private readonly renderer: RetainedShellRenderer;
	private readonly editor: Component | undefined;
	private readonly modal: (Component & { getActiveKind?(): string | undefined }) | undefined;
	private readonly overlay: (Component & { getActiveKind?(): string | undefined }) | undefined;
	private readonly notifications: Component | undefined;
	private state: RpcHostChromeState;
	private transcript: TranscriptViewModel;

	private constructor(yoga: Yoga, options: RpcShellAdapterOptions) {
		this.state = options.initialState;
		this.transcript = options.initialTranscript;
		this.editor = options.editor;
		this.modal = options.modal;
		this.overlay = options.overlay;
		this.notifications = options.notifications;
		this.chat = ChatPager.create(yoga);
		this.chat.replaceViewModels(this.transcript.messages);
		this.splash = createSplashTree(yoga, undefined, () => defaultSplashSnapshot(this.isActive()));
		(this.editor as SplashAwareComponent | undefined)?.setSplashProvider?.(() => !this.isActive());
		const editorComponent = new RpcEditorShellComponent(this, options.inputPreview);
		this.renderer = new RetainedShellRenderer({
			yoga,
			chat: { pager: this.chat },
			splash: { tree: this.splash },
			isActive: () => this.isActive(),
			editor: () => editorComponent,
			topChromeFallback: () => ({ component: this.topChromeComponent() }),
			topChrome: () => ({ component: this.topChromeComponent() }),
			belowEditorWidgets: () => new RpcHintComponent(this),
			aboveEditorWidgets: () => EMPTY_COMPONENT,
			footer: () => new RpcFooterComponent(this),
			terminal: new RpcHardwareCursorSuppressor(options.terminal),
			viewport: options.viewport,
			overlayHost: new RpcOverlayHost(this),
			sidebar: () => this.sidebarPublication(),
		});
	}

	public static async create(options: RpcShellAdapterOptions): Promise<RpcShellAdapter> {
		return new RpcShellAdapter(await loadYoga(), options);
	}

	public update(snapshot: Partial<RpcShellAdapterSnapshot>): void {
		if (snapshot.state) this.state = snapshot.state;
		if (snapshot.transcript) {
			this.transcript = snapshot.transcript;
			this.chat.replaceViewModels(snapshot.transcript.messages);
		}
	}

	public render(): void {
		this.renderer.render();
	}

	public getLastFrame(): CellBuffer | undefined {
		return this.renderer.getLastFrame();
	}

	public dispose(): void {
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
		if (!this.isActive()) {
			if (rows.length > 0 && !isSimpleSplashEditorFrame(rows)) return rows;
			return renderSplashEditorFrame(width, readEditorText(this.editor));
		}
		if (rows.length > 0 && !activeEditorIsEmpty(rows)) return rows;
		const submittedPrompt = inputPreview ?? (width >= SIDEBAR_MIN_TERMINAL_WIDTH ? latestUserPrompt(this.transcript) : undefined);
		return renderInputFrame(submittedPrompt ?? "", width, { promptColor: "accent", cursorStyle: "cell" });
	}

	private topChromeComponent(): ShellRenderable {
		return new RpcTopChromeComponent(this);
	}

	private sidebarPublication(): { component: ShellRenderable; isVisible: (cols: number, rows: number) => boolean } | undefined {
		if (!this.isActive()) return undefined;
		return {
			component: new RpcSidebarComponent(this),
			isVisible: (cols, _rows) => this.isActive() && cols >= SIDEBAR_MIN_TERMINAL_WIDTH,
		};
	}
}

export function rpcSessionIsActive(state: RpcHostChromeState, transcript: TranscriptViewModel): boolean {
	return state.hasMessages
		|| state.messageCount > 0
		|| state.pendingMessageCount > 0
		|| state.taskPartialCount > 0
		|| state.isStreaming
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

function footerSnapshot(state: RpcHostChromeState, isSplash: boolean): FooterSnapshot {
	if (isVisualHarness() && !isSplash) {
		return {
			cwd: hostCwd(),
			branch: "main",
			inputTokens: VISUAL_SIDEBAR_CONTEXT_TOKENS,
			outputTokens: 0,
			contextTokens: VISUAL_SIDEBAR_CONTEXT_TOKENS,
			contextWindow: VISUAL_SIDEBAR_CONTEXT_WINDOW,
			costUsd: VISUAL_SIDEBAR_COST_USD,
			state: "idle",
			modelId: VISUAL_MODEL_LABEL,
			thinkingLevel: VISUAL_THINKING_LEVEL,
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
		modelId: state.modelLabel ?? "no-model",
		thinkingLevel: normalizeThinkingLevel(state.thinkingLevel),
		isSplash,
	};
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

function renderSplashHint(width: number): string {
	const frameWidth = Math.min(width, SPLASH_INPUT_FRAME_WIDTH);
	const hint = renderInputHints(frameWidth, { leftHint: INPUT_FRAME_HINT_AWAITING });
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

class RpcTopChromeComponent implements ShellRenderable {
	public constructor(private readonly adapter: RpcShellAdapter) {}
	public invalidate(): void {}
	public render(width: number): string[] {
		if (!this.adapter.isActive()) return [];
		const block = renderTopChromeBlock(topChromeSnapshot(this.adapter.getState()), width);
		return width >= 80 ? ["", ...block] : block;
	}
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
		if (!this.adapter.isActive()) return [renderSplashHint(width)];
		const sidebarVisible = width >= SIDEBAR_MIN_TERMINAL_WIDTH;
		return [renderActiveHint(this.adapter.getState(), width, sidebarVisible)];
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

class RpcSidebarComponent implements ShellRenderable {
	public constructor(private readonly adapter: RpcShellAdapter) {}
	public invalidate(): void {}
	public render(width: number): string[] {
		const cwd = hostCwd();
		const state = this.adapter.getState();
		const visualHarness = isVisualHarness();
		// Runtime captures still submit through the live RPC prompt path; only
		// volatile sidebar metadata is normalized to keep required crop gates stable.
		const contextTokens = visualHarness ? VISUAL_SIDEBAR_CONTEXT_TOKENS : state.contextTokens ?? 0;
		return renderSidebar({
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
		}, width);
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
				options: { anchor: "center", width: "80%", maxHeight: "80%" },
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
