import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { visibleWidth, type Component } from "@earendil-works/pi-tui";
import { INPUT_FRAME_HINT_AWAITING, INPUT_FRAME_PLACEHOLDER, renderInputFrame, renderInputHints } from "../../cathedral/input-frame.js";
import {
	formatCwd,
	renderFooterBlock,
	renderSplashVersionLine,
	type FooterSnapshot,
	type ThinkingLevel,
} from "../../footer.js";
import { getCachedMcpRoster } from "../../mcp-config-reader.js";
import { SIDEBAR_GUTTER_WIDTH, SIDEBAR_MIN_TERMINAL_WIDTH, SIDEBAR_WIDTH } from "../../sidebar-placement.js";
import { renderTopChrome, type TopChromeSnapshot } from "../../top-chrome.js";
import { activeThemeColors, type SumoCodeState } from "../../themes/index.js";
import { createSidebarTree, type SidebarLayoutSnapshot } from "../cathedral/sidebar-tree.js";
import { createSplashTree, defaultSplashSnapshot, getSplashContentHeight } from "../cathedral/splash-tree.js";
import { SumoNode } from "../layout/node.js";
import { DIRECTION_LTR, FLEX_DIRECTION_COLUMN, loadYoga, type Yoga } from "../layout/yoga.js";
import { CellBuffer } from "../render/buffer.js";
import { createAttrs } from "../render/cell.js";
import { composite } from "../render/compositor.js";
import { diffFrames } from "../render/diff.js";
import { logDiagnostic } from "../runtime/diagnostics.js";
import { defaultTerminalSessionOwner, type TerminalOutput, type TerminalSessionOwner } from "../runtime/terminal-controller.js";
import type { TranscriptViewModel } from "../transcript/view-model.js";
import { ChatPager } from "../widgets/chat-pager.js";
import type { RpcHostChromeState } from "./state.js";

export interface RpcHostTerminalOutput extends TerminalOutput {
	readonly columns?: number;
	readonly rows?: number;
	on?(event: "resize", listener: () => void): unknown;
	off?(event: "resize", listener: () => void): unknown;
	removeListener?(event: "resize", listener: () => void): unknown;
}

export interface RpcHostInput {
	readonly isTTY?: boolean;
	on(event: "data", listener: (data: string | Buffer) => void): unknown;
	off?(event: "data", listener: (data: string | Buffer) => void): unknown;
	removeListener?(event: "data", listener: (data: string | Buffer) => void): unknown;
	setRawMode?(enabled: boolean): void;
	resume?(): void;
}

export interface RpcHostInputHandler {
	handleInput(data: string): boolean;
}

export interface RpcHostRuntimeOptions {
	readonly output?: RpcHostTerminalOutput;
	readonly input?: RpcHostInput;
	readonly terminal?: TerminalSessionOwner;
	readonly initialState?: RpcHostChromeState;
	readonly initialTranscript?: TranscriptViewModel;
	readonly inputPreview?: string;
	readonly editor?: Component;
	readonly modal?: Component & { getActiveKind?(): string | undefined };
	readonly overlay?: Component & { getActiveKind?(): string | undefined };
	readonly notifications?: Component;
	readonly inputHandler?: RpcHostInputHandler;
}

export interface RpcHostRuntimeSnapshot {
	readonly state: RpcHostChromeState;
	readonly transcript: TranscriptViewModel;
	readonly inputPreview?: string;
}

const EMPTY_TRANSCRIPT: TranscriptViewModel = { messages: [] };
const FALLBACK_STATE: RpcHostChromeState = {
	isStreaming: false,
	isCompacting: false,
	messageCount: 0,
	pendingMessageCount: 0,
	hasMessages: false,
	taskPartialCount: 0,
	costUsd: 0,
};
const ACTIVE_TOP_ROWS = 3;
const SPLASH_BOTTOM_RESERVED_ROWS = 8;
const SPLASH_INPUT_FRAME_WIDTH = 60;
const PORTRAIT_CHAT_GUTTER_WIDTH = 1;
const ANSI_PATTERN = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\)|_[^\u0007]*(?:\u0007|\u001b\\))/g;

const THINKING_LEVELS = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh"]);

interface SplashAwareComponent extends Component {
	setSplashProvider?(provider: () => boolean): void;
}

class RpcTranscriptFrameRenderer {
	private readonly root: SumoNode;
	private readonly chat: ChatPager;

	private constructor(private readonly yoga: Yoga, transcript: TranscriptViewModel) {
		this.root = new SumoNode(this.yoga.Node.create());
		this.root.flexDirection = FLEX_DIRECTION_COLUMN;
		this.chat = ChatPager.create(this.yoga, this.root);
		this.replaceTranscript(transcript);
	}

	public static async create(transcript: TranscriptViewModel): Promise<RpcTranscriptFrameRenderer> {
		const yoga = await loadYoga();
		return new RpcTranscriptFrameRenderer(yoga, transcript);
	}

	public replaceTranscript(transcript: TranscriptViewModel): void {
		this.chat.replaceViewModels(transcript.messages);
	}

	public getYoga(): Yoga {
		return this.yoga;
	}

	public renderChatRegion(state: RpcHostChromeState, columns: number, rows: number): CellBuffer {
		const width = Math.max(1, columns);
		const height = Math.max(0, rows);
		const buffer = new CellBuffer(height, width);
		paintBackground(buffer, width, height);
		if (height === 0) return buffer;

		const root = new SumoNode(this.yoga.Node.create());
		root.flexDirection = FLEX_DIRECTION_COLUMN;
		root.width = width;
		root.height = height;
		const sidebarSnapshot = sidebarLayoutSnapshot(state, width, height, this.chat.hasMessages());
		const tree = createSidebarTree(this.yoga, root, sidebarSnapshot);
		tree.chat.marginRight = sidebarGutterFor(width, height, sidebarSnapshot.sessionHasMessages);
		tree.chat.addChild(this.chat);
		root.yogaNode.calculateLayout(width, height, DIRECTION_LTR);
		composite(root, buffer);
		if (this.chat.parent === tree.chat) tree.chat.removeChild(this.chat);
		root.dispose();
		return buffer;
	}

	public dispose(): void {
		this.chat.dispose();
		this.root.dispose();
	}
}

function terminalColumns(output: RpcHostTerminalOutput): number {
	return Math.max(1, Math.floor(output.columns ?? 80));
}

function terminalRows(output: RpcHostTerminalOutput): number {
	return Math.max(1, Math.floor(output.rows ?? 24));
}

function paintBuffer(target: CellBuffer, source: CellBuffer, top: number, left: number): void {
	const dimensions = source.getDimensions();
	for (let row = 0; row < dimensions.rows; row += 1) {
		for (let col = 0; col < dimensions.cols; col += 1) {
			const targetRow = top + row;
			const targetCol = left + col;
			target.setCell(targetRow, targetCol, source.getCell(row, col));
			const selectionMeta = source.getSelectionMeta(row, col);
			if (selectionMeta) target.setSelectionMeta(targetRow, targetCol, selectionMeta);
		}
	}
}

function paintBackground(buffer: CellBuffer, columns: number, rows: number): void {
	const colors = activeThemeColors();
	buffer.setDefaultForeground(colors.foreground);
	buffer.setDefaultBackground(colors.background);
	buffer.paint({ top: 0, left: 0, width: columns, height: rows }, {
		char: " ",
		fg: colors.foreground,
		bg: colors.background,
		attrs: createAttrs(),
	});
}

function paintAnsiLines(target: CellBuffer, lines: readonly string[], top: number, columns: number): void {
	for (let index = 0; index < lines.length; index += 1) {
		const row = top + index;
		if (row < 0 || row >= target.getDimensions().rows) continue;
		target.paintRow(row, lines[index] ?? "", 0, columns);
	}
}

function centerAnsi(line: string, width: number): string {
	const visible = visibleWidth(line);
	if (visible >= width) return line;
	const left = Math.floor((width - visible) / 2);
	const right = width - visible - left;
	return `${" ".repeat(left)}${line}${" ".repeat(right)}`;
}

function stripAnsi(value: string): string {
	return value.replace(ANSI_PATTERN, "");
}

interface RpcHostRuntimeSurfaces {
	readonly editor?: Component;
	readonly modal?: Component;
	readonly overlay?: Component;
	readonly notifications?: Component;
}

function hostCwd(env: NodeJS.ProcessEnv = process.env): string {
	return resolve(env.SUMOCODE_PROJECT_CWD ?? process.cwd());
}

function resolvePiAgentDir(env: NodeJS.ProcessEnv = process.env): string {
	return env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
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

function sidebarLayoutSnapshot(
	state: RpcHostChromeState,
	terminalWidth: number,
	terminalHeight: number,
	hasMessages: boolean,
): SidebarLayoutSnapshot {
	const cwd = hostCwd();
	const contextTokens = state.contextTokens ?? 0;
	const sidebarEnabled = hasMessages && terminalWidth >= SIDEBAR_MIN_TERMINAL_WIDTH;
	return {
		terminalWidth,
		terminalHeight,
		sessionHasMessages: sidebarEnabled,
		dockMinWidth: SIDEBAR_MIN_TERMINAL_WIDTH,
		sidebarWidth: SIDEBAR_WIDTH,
		projectName: basename(cwd) || cwd,
		branch: state.gitBranch,
		inputTokens: contextTokens,
		outputTokens: 0,
		currentContextTokens: state.contextTokens,
		contextWindow: state.contextWindow ?? 0,
		costUsd: state.costUsd,
		mcpServers: getCachedMcpRoster({ cwd, piAgentDir: resolvePiAgentDir() }),
		memory: [],
		memoryTotal: 0,
		activeSubTab: "CONTEXT",
		sessions: [{ name: sessionLabel(state), branch: state.gitBranch, active: true }],
	};
}

function sidebarGutterFor(columns: number, _rows: number, sidebarEnabled: boolean): number {
	if (sidebarEnabled) return SIDEBAR_GUTTER_WIDTH;
	return columns < SIDEBAR_MIN_TERMINAL_WIDTH ? PORTRAIT_CHAT_GUTTER_WIDTH : 0;
}

function renderActiveHint(state: RpcHostChromeState, width: number, sidebarVisible: boolean): string {
	const pad = width > 2 ? 1 : 0;
	const innerWidth = Math.max(0, width - pad * 2);
	const project = formatCwd(hostCwd());
	const branch = state.gitBranch;
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
	const hint = renderInputHints(frameWidth, {
		leftHint: INPUT_FRAME_HINT_AWAITING,
	});
	return centerAnsi(hint, width);
}

function paintSplashCursor(buffer: CellBuffer, editorRows: readonly string[], editorTop: number, columns: number): void {
	const contentRowIndex = editorRows.findIndex((row) => stripAnsi(row).includes(INPUT_FRAME_PLACEHOLDER));
	if (contentRowIndex === -1) return;
	const frameWidth = Math.min(columns, SPLASH_INPUT_FRAME_WIDTH);
	const frameLeft = Math.max(0, Math.floor((columns - frameWidth) / 2));
	const cursorCol = frameLeft + 4 + Math.min(INPUT_FRAME_PLACEHOLDER.length, Math.max(0, frameWidth - 7));
	const colors = activeThemeColors();
	buffer.setCell(editorTop + contentRowIndex, cursorCol, {
		char: " ",
		fg: colors.background,
		bg: colors.accent,
		attrs: createAttrs(),
	});
}

function activeTopRows(state: RpcHostChromeState, width: number): string[] {
	return ["", renderTopChrome(topChromeSnapshot(state), width), ""];
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

function activeEditorIsEmpty(rows: readonly string[]): boolean {
	const content = rows.find((row) => stripAnsi(row).startsWith("│ >"));
	if (!content) return false;
	return /^│ >\s+│$/.test(stripAnsi(content));
}

function activeEditorRows(snapshot: RpcHostRuntimeSnapshot, width: number, surfaces: RpcHostRuntimeSurfaces): string[] {
	const rows = surfaces.editor?.render(width) ?? [];
	if (activeEditorIsEmpty(rows)) {
		const submittedPrompt = snapshot.inputPreview ?? (width >= SIDEBAR_MIN_TERMINAL_WIDTH ? latestUserPrompt(snapshot.transcript) : undefined);
		return renderInputFrame(submittedPrompt ?? "", width, { promptColor: "accent", cursorStyle: "cell" });
	}
	return rows;
}

function activeBottomRows(snapshot: RpcHostRuntimeSnapshot, width: number, hasMessages: boolean, surfaces: RpcHostRuntimeSurfaces): string[] {
	const state = snapshot.state;
	const sidebarVisible = hasMessages && width >= SIDEBAR_MIN_TERMINAL_WIDTH;
	return [
		"",
		...activeEditorRows(snapshot, width, surfaces),
		renderActiveHint(state, width, sidebarVisible),
		"",
		...renderFooterBlock(footerSnapshot(state, false), width),
		"",
	];
}

function renderSplashFrame(
	columns: number,
	rows: number,
	transcriptRenderer: RpcTranscriptFrameRenderer,
	surfaces: RpcHostRuntimeSurfaces,
): CellBuffer {
	const buffer = new CellBuffer(rows, columns);
	paintBackground(buffer, columns, rows);

	const splashAreaHeight = Math.max(1, rows - SPLASH_BOTTOM_RESERVED_ROWS);
	const yoga = transcriptRenderer.getYoga();
	const root = new SumoNode(yoga.Node.create());
	root.flexDirection = FLEX_DIRECTION_COLUMN;
	root.width = columns;
	root.height = splashAreaHeight;
	const splashSnapshot = defaultSplashSnapshot(false);
	const splash = createSplashTree(yoga, root, () => splashSnapshot);
	root.yogaNode.calculateLayout(columns, splashAreaHeight, DIRECTION_LTR);
	const splashBuffer = new CellBuffer(splashAreaHeight, columns);
	paintBackground(splashBuffer, columns, splashAreaHeight);
	composite(root, splashBuffer);
	paintBuffer(buffer, splashBuffer, -1, 0);
	const contentTop = splash.content.getComputedTop();
	const contentHeight = getSplashContentHeight(splashSnapshot, columns);
	root.dispose();

	const editorRows = surfaces.editor?.render(columns) ?? [];
	const editorTop = Math.min(
		Math.max(0, rows - editorRows.length),
		Math.max(0, contentTop + contentHeight + 1),
	);
	paintAnsiLines(buffer, editorRows, editorTop, columns);
	paintSplashCursor(buffer, editorRows, editorTop, columns);
	const hintTop = Math.min(rows - 1, editorTop + editorRows.length + 1);
	paintAnsiLines(buffer, [renderSplashHint(columns)], hintTop, columns);
	const versionTop = Math.min(rows - 1, hintTop + 3);
	const version = renderSplashVersionLine(columns);
	if (version !== "") paintAnsiLines(buffer, [version], versionTop, columns);

	return buffer;
}

function renderActiveFrame(
	snapshot: RpcHostRuntimeSnapshot,
	columns: number,
	rows: number,
	transcriptRenderer: RpcTranscriptFrameRenderer,
	surfaces: RpcHostRuntimeSurfaces,
): CellBuffer {
	const buffer = new CellBuffer(rows, columns);
	paintBackground(buffer, columns, rows);
	const topRows = activeTopRows(snapshot.state, columns);
	const bottomRows = activeBottomRows(snapshot, columns, true, surfaces);
	const chatHeight = Math.max(0, rows - topRows.length - bottomRows.length);
	paintAnsiLines(buffer, topRows, 0, columns);
	if (chatHeight > 0) {
		paintBuffer(buffer, transcriptRenderer.renderChatRegion(snapshot.state, columns, chatHeight), topRows.length, 0);
	}
	paintAnsiLines(buffer, bottomRows, topRows.length + chatHeight, columns);
	return buffer;
}

function renderRpcFrame(
	snapshot: RpcHostRuntimeSnapshot,
	columns: number,
	rows: number,
	transcriptRenderer?: RpcTranscriptFrameRenderer,
	surfaces: RpcHostRuntimeSurfaces = {},
): CellBuffer {
	const hasMessages = snapshot.transcript.messages.length > 0 || snapshot.state.hasMessages;
	const buffer = !hasMessages
		? renderSplashFrame(columns, rows, transcriptRenderer!, surfaces)
		: renderActiveFrame(snapshot, columns, rows, transcriptRenderer!, surfaces);
	const overlayBaseTop = hasMessages ? ACTIVE_TOP_ROWS : 0;
	if (surfaces.notifications) {
		paintAnsiLines(buffer, surfaces.notifications.render(columns), overlayBaseTop, columns);
	}
	if (surfaces.overlay) {
		const overlayLines = surfaces.overlay.render(columns);
		const overlayTop = Math.max(overlayBaseTop, Math.floor((rows - overlayLines.length) / 2));
		paintAnsiLines(buffer, overlayLines, overlayTop, columns);
	}
	if (surfaces.modal) {
		const modalLines = surfaces.modal.render(columns);
		const modalTop = Math.max(overlayBaseTop, Math.floor((rows - modalLines.length) / 2));
		paintAnsiLines(buffer, modalLines, modalTop, columns);
	}
	return buffer;
}

export class RpcHostRuntime {
	private readonly output: RpcHostTerminalOutput;
	private readonly input: RpcHostInput | undefined;
	private readonly terminal: TerminalSessionOwner;
	private readonly editor: Component | undefined;
	private readonly modal: (Component & { getActiveKind?(): string | undefined }) | undefined;
	private readonly overlay: (Component & { getActiveKind?(): string | undefined }) | undefined;
	private readonly notifications: Component | undefined;
	private readonly inputHandler: RpcHostInputHandler | undefined;
	private readonly inputPreview: string | undefined;
	private state: RpcHostChromeState;
	private transcript: TranscriptViewModel;
	private transcriptRenderer: RpcTranscriptFrameRenderer | undefined;
	private previousFrame: CellBuffer | undefined;
	private started = false;
	private stopped = false;
	private exitCode: number | undefined;
	private readonly waiters: Array<(code: number) => void> = [];
	private readonly handleResize = (): void => this.render();
	private readonly handleInput = (data: string | Buffer): void => {
		const text = typeof data === "string" ? data : data.toString("utf8");
		if (text.includes("\u0003")) {
			this.requestExit(130);
			return;
		}
		if (this.modal?.getActiveKind?.()) {
			this.modal.handleInput?.(text);
			this.render();
			return;
		}
		if (this.overlay?.getActiveKind?.()) {
			this.overlay.handleInput?.(text);
			this.render();
			return;
		}
		if (this.inputHandler?.handleInput(text)) {
			this.render();
			return;
		}
		if (this.editor) {
			this.editor.handleInput?.(text);
			this.render();
			return;
		}
		if (text.includes("q") || text.includes("\u001b")) this.requestExit(0);
	};

	public constructor(options: RpcHostRuntimeOptions = {}) {
		this.output = options.output ?? process.stdout;
		this.input = options.input ?? (process.stdin as RpcHostInput);
		this.terminal = options.terminal ?? defaultTerminalSessionOwner;
		this.state = options.initialState ?? FALLBACK_STATE;
		this.transcript = options.initialTranscript ?? EMPTY_TRANSCRIPT;
		this.inputPreview = options.inputPreview;
		this.editor = options.editor;
		(this.editor as SplashAwareComponent | undefined)?.setSplashProvider?.(() => this.transcript.messages.length === 0 && !this.state.hasMessages);
		this.modal = options.modal;
		this.overlay = options.overlay;
		this.notifications = options.notifications;
		this.inputHandler = options.inputHandler;
	}

	public async start(): Promise<void> {
		if (this.started) return;
		this.started = true;
		this.terminal.startRetainedSession();
		if (this.input?.isTTY === true) {
			this.input.setRawMode?.(true);
			this.input.resume?.();
			this.input.on("data", this.handleInput);
		}
		this.output.on?.("resize", this.handleResize);
		const transcriptRenderer = await RpcTranscriptFrameRenderer.create(this.transcript);
		if (this.stopped) {
			transcriptRenderer.dispose();
			return;
		}
		transcriptRenderer.replaceTranscript(this.transcript);
		this.transcriptRenderer = transcriptRenderer;
		const cols = terminalColumns(this.output);
		const rows = terminalRows(this.output);
		this.render();
		for (const event of ["boot_screen_frame", "stable_chrome_ready", "app_ready", "input_ready"]) {
			logDiagnostic(event, { surface: "rpc_host", cols, rows });
		}
	}

	public update(snapshot: Partial<RpcHostRuntimeSnapshot>): void {
		if (snapshot.state) this.state = snapshot.state;
		if (snapshot.transcript) {
			this.transcript = snapshot.transcript;
			this.transcriptRenderer?.replaceTranscript(snapshot.transcript);
		}
		this.render();
	}

	public requestRender(): void {
		this.render();
	}

	public waitForExit(): Promise<number> {
		if (this.exitCode !== undefined) return Promise.resolve(this.exitCode);
		return new Promise((resolve) => this.waiters.push(resolve));
	}

	public stop(code = 0): void {
		if (this.stopped) return;
		this.stopped = true;
		this.exitCode = code;
		this.input?.setRawMode?.(false);
		if (this.input?.off) this.input.off("data", this.handleInput);
		else this.input?.removeListener?.("data", this.handleInput);
		if (this.output.off) this.output.off("resize", this.handleResize);
		else this.output.removeListener?.("resize", this.handleResize);
		this.transcriptRenderer?.dispose();
		this.transcriptRenderer = undefined;
		this.terminal.exitTerminal();
		for (const resolve of this.waiters.splice(0)) resolve(code);
	}

	private render(): void {
		if (!this.started || this.stopped) return;
		if (!this.transcriptRenderer) return;
		const frame = renderRpcFrame(
			{ state: this.state, transcript: this.transcript, inputPreview: this.inputPreview },
			terminalColumns(this.output),
			terminalRows(this.output),
			this.transcriptRenderer,
			{ editor: this.editor, modal: this.modal, overlay: this.overlay, notifications: this.notifications },
		);
		const patches = diffFrames(this.previousFrame, frame, { detectScroll: false });
		this.terminal.writeFramePatches(patches, null);
		this.previousFrame = frame.clone();
	}

	private requestExit(code: number): void {
		this.stop(code);
	}
}

export async function renderRpcHostFrameForTest(snapshot: RpcHostRuntimeSnapshot, columns: number, rows: number): Promise<CellBuffer> {
	const transcriptRenderer = await RpcTranscriptFrameRenderer.create(snapshot.transcript);
	try {
		return renderRpcFrame(snapshot, columns, rows, transcriptRenderer);
	} finally {
		transcriptRenderer.dispose();
	}
}
