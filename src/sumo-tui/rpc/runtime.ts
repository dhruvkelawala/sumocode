import { visibleWidth, type Component } from "@earendil-works/pi-tui";
import { activeThemeColors } from "../../themes/index.js";
import { SumoNode } from "../layout/node.js";
import { DIRECTION_LTR, FLEX_DIRECTION_COLUMN, loadYoga, type Yoga } from "../layout/yoga.js";
import { CellBuffer } from "../render/buffer.js";
import { createAttrs } from "../render/cell.js";
import { composite } from "../render/compositor.js";
import { diffFrames } from "../render/diff.js";
import { lineToAnsi, renderRule, span, textLine, type Line, type Span, type Style } from "../render/primitives.js";
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
	readonly editor?: Component;
	readonly modal?: Component & { getActiveKind?(): string | undefined };
	readonly overlay?: Component & { getActiveKind?(): string | undefined };
	readonly notifications?: Component;
	readonly inputHandler?: RpcHostInputHandler;
}

export interface RpcHostRuntimeSnapshot {
	readonly state: RpcHostChromeState;
	readonly transcript: TranscriptViewModel;
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
const TOP_CHROME_ROWS = 2;
const FOOTER_ROWS = 2;
const EDITOR_ROWS = 4;

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

	public render(columns: number, rows: number): CellBuffer {
		const width = Math.max(1, columns);
		const height = Math.max(0, rows);
		this.root.width = width;
		this.root.height = height;
		this.root.yogaNode.calculateLayout(width, height, DIRECTION_LTR);
		const buffer = new CellBuffer(height, width);
		composite(this.root, buffer);
		return buffer;
	}

	public dispose(): void {
		this.root.dispose();
	}
}

function tokenText(value: number | undefined): string {
	if (value === undefined || !Number.isFinite(value)) return "?";
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
	if (value >= 1_000) return `${Math.round(value / 100) / 10}k`;
	return String(Math.max(0, Math.floor(value)));
}

function linePartsWidth(parts: readonly Span[]): number {
	return parts.reduce((width, part) => width + visibleWidth(part.text), 0);
}

function centeredLine(parts: readonly Span[], width: number, style: Style): Line {
	const padding = Math.max(0, Math.floor((width - linePartsWidth(parts)) / 2));
	return textLine([span(" ".repeat(padding), style), ...parts], style);
}

function splitLine(left: readonly Span[], right: readonly Span[], width: number, style: Style): Line {
	const gap = Math.max(1, width - linePartsWidth(left) - linePartsWidth(right));
	return textLine([...left, span(" ".repeat(gap), style), ...right], style);
}

function stateLabel(state: RpcHostChromeState): string {
	if (state.isCompacting) return "INSCRIBING";
	if (state.isStreaming) return "MEDITATING";
	return "READY";
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

function paintAnsiLines(target: CellBuffer, lines: readonly string[], top: number, columns: number): void {
	for (let index = 0; index < lines.length; index += 1) {
		const row = top + index;
		if (row < 0 || row >= target.getDimensions().rows) continue;
		target.paintRow(row, lines[index] ?? "", 0, columns);
	}
}

interface RpcHostRuntimeSurfaces {
	readonly editor?: Component;
	readonly modal?: Component;
	readonly overlay?: Component;
	readonly notifications?: Component;
}

function renderRpcFrame(
	snapshot: RpcHostRuntimeSnapshot,
	columns: number,
	rows: number,
	transcriptRenderer?: RpcTranscriptFrameRenderer,
	surfaces: RpcHostRuntimeSurfaces = {},
): CellBuffer {
	const colors = activeThemeColors();
	const base: Style = { fg: colors.foreground, bg: colors.background };
	const dim: Style = { fg: colors.foregroundDim, bg: colors.background };
	const accent: Style = { fg: colors.accent, bg: colors.background, bold: true };
	const idle: Style = { fg: colors.states.idle, bg: colors.background, bold: true };
	const tool: Style = { fg: colors.states.tool, bg: colors.background, bold: true };
	const divider: Style = { fg: colors.divider, bg: colors.background };
	const buffer = new CellBuffer(rows, columns);
	buffer.paint({ top: 0, left: 0, width: columns, height: rows }, { char: " ", fg: colors.foreground, bg: colors.background, attrs: createAttrs() });

	const state = snapshot.state;
	const transcript = snapshot.transcript;
	const label = stateLabel(state);
	const model = state.modelLabel ?? "model pending";
	const session = state.sessionName ?? state.sessionId ?? "ephemeral session";
	const branch = state.gitBranch ? `branch ${state.gitBranch}` : "branch unknown";
	const context = `${tokenText(state.contextTokens)}/${tokenText(state.contextWindow)}`;
	const footerLeft = `${label} · ${branch}`;
	const footerRight = `${context} · $${state.costUsd.toFixed(2)}`;
	const centerRow = Math.max(4, Math.floor(rows / 2) - 3);
	const hasMessages = transcript.messages.length > 0;
	const editorRows = surfaces.editor ? Math.min(EDITOR_ROWS, Math.max(0, rows - TOP_CHROME_ROWS - FOOTER_ROWS)) : 0;
	const editorTop = Math.max(TOP_CHROME_ROWS, rows - FOOTER_ROWS - editorRows);
	const lines: Array<{ row: number; line: Line }> = [
		{
			row: 0,
			line: splitLine(
				[span(" sumocode", accent), span(" · rpc host", dim)],
				[span(label, label === "READY" ? idle : tool), span(" ", base)],
				columns,
				base,
			),
		},
		{ row: 1, line: renderRule(columns, { char: "─", style: divider, lineStyle: base }) },
		{ row: rows - 2, line: renderRule(columns, { char: "─", style: divider, lineStyle: base }) },
		{
			row: rows - 1,
			line: splitLine(
				[span(` ${footerLeft}`, label === "READY" ? idle : tool)],
				[span(footerRight, dim), span(" ", base)],
				columns,
				base,
			),
		},
	];
	if (!hasMessages) {
		lines.push(
			{ row: centerRow, line: centeredLine([span("SUMOCODE", accent), span(" RPC", tool)], columns, base) },
			{ row: centerRow + 2, line: centeredLine([span("empty transcript", dim)], columns, base) },
			{ row: centerRow + 3, line: centeredLine([span(session, base)], columns, base) },
			{ row: centerRow + 4, line: centeredLine([span(model, dim)], columns, base) },
		);
	} else if (transcriptRenderer) {
		const chatTop = TOP_CHROME_ROWS;
		const chatHeight = Math.max(0, rows - TOP_CHROME_ROWS - FOOTER_ROWS - editorRows);
		if (chatHeight > 0) paintBuffer(buffer, transcriptRenderer.render(columns, chatHeight), chatTop, 0);
	}

	for (const { row, line } of lines) {
		if (row < 0 || row >= rows) continue;
		buffer.paintRow(row, lineToAnsi(line, { width: columns, style: base }));
	}
	if (surfaces.editor && editorRows > 0) {
		paintAnsiLines(buffer, surfaces.editor.render(columns).slice(0, editorRows), editorTop, columns);
	}
	if (surfaces.notifications) {
		paintAnsiLines(buffer, surfaces.notifications.render(columns), TOP_CHROME_ROWS, columns);
	}
	if (surfaces.overlay) {
		const overlayLines = surfaces.overlay.render(columns);
		const overlayTop = Math.max(TOP_CHROME_ROWS, Math.floor((rows - overlayLines.length) / 2));
		paintAnsiLines(buffer, overlayLines, overlayTop, columns);
	}
	if (surfaces.modal) {
		const modalLines = surfaces.modal.render(columns);
		const modalTop = Math.max(TOP_CHROME_ROWS, Math.floor((rows - modalLines.length) / 2));
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
		this.editor = options.editor;
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
		this.render();
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
			{ state: this.state, transcript: this.transcript },
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
