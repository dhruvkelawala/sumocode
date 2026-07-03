import type { Component } from "@earendil-works/pi-tui";
import type { CellBuffer } from "../render/buffer.js";
import { logDiagnostic } from "../runtime/diagnostics.js";
import { defaultTerminalSessionOwner, type TerminalOutput, type TerminalSessionOwner } from "../runtime/terminal-controller.js";
import type { TranscriptViewModel } from "../transcript/view-model.js";
import { containsCtrlCToken, isEscapeInput, SharedInputRouter } from "../input/shared-input-router.js";
import { RpcShellAdapter } from "./shell-adapter.js";
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
	pause?(): void;
	/**
	 * Node's Readable#setEncoding. When present, the host calls this with
	 * "utf8" so Node's internal StringDecoder reassembles multibyte
	 * codepoints (CJK, emoji, etc.) that a terminal/pty can legitimately
	 * split across separate stdin chunks -- without it, each Buffer is
	 * decoded independently via toString('utf8') and a split codepoint
	 * becomes U+FFFD replacement-character garbage. Optional so fakes/test
	 * doubles that emit whole strings (never split multibyte input) don't
	 * need to implement it; handleInput's Buffer branch below is the
	 * fallback for those.
	 */
	setEncoding?(encoding: "utf8"): void;
}

export interface RpcHostInputHandler {
	handleInput?(data: string): boolean;
	openCommandPalette?(): void | Promise<void>;
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
	readonly extensionRegions?: {
		readonly aboveEditor?: Component;
		readonly belowEditor?: Component;
		readonly sidebar?: Component;
	};
	readonly inputHandler?: RpcHostInputHandler;
	readonly preEditorInputHandler?: (data: string) => boolean | void;
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

function terminalColumns(output: RpcHostTerminalOutput): number {
	return Math.max(1, Math.floor(output.columns ?? 80));
}

function terminalRows(output: RpcHostTerminalOutput): number {
	return Math.max(1, Math.floor(output.rows ?? 24));
}

export class RpcHostRuntime {
	private readonly output: RpcHostTerminalOutput;
	private readonly input: RpcHostInput | undefined;
	private readonly terminal: TerminalSessionOwner;
	private readonly editor: Component | undefined;
	private readonly modal: (Component & { getActiveKind?(): string | undefined }) | undefined;
	private readonly overlay: (Component & { getActiveKind?(): string | undefined }) | undefined;
	private readonly notifications: Component | undefined;
	private readonly extensionRegions: RpcHostRuntimeOptions["extensionRegions"];
	private readonly inputHandler: RpcHostInputHandler | undefined;
	private readonly preEditorInputHandler: ((data: string) => boolean | void) | undefined;
	private readonly inputPreview: string | undefined;
	private readonly inputRouter: SharedInputRouter;
	private state: RpcHostChromeState;
	private transcript: TranscriptViewModel;
	private shell: RpcShellAdapter | undefined;
	private started = false;
	private stopped = false;
	private exitCode: number | undefined;
	private readonly waiters: Array<(code: number) => void> = [];
	private readonly handleResize = (): void => this.render();
	private readonly handleInput = (data: string | Buffer): void => {
		// With setEncoding('utf8') applied in start(), a real stdin stream's
		// "data" events are already reassembled strings (Node's StringDecoder
		// buffers any trailing partial multibyte sequence until the next
		// chunk). The Buffer branch is a fallback for input doubles that don't
		// implement setEncoding and emit raw Buffers instead -- those must
		// only ever emit whole, complete chunks (never a codepoint split
		// across two Buffers), since toString('utf8') per-chunk cannot
		// reassemble a split sequence.
		const text = typeof data === "string" ? data : data.toString("utf8");
		this.inputRouter.handleInput(text);
	};

	public constructor(options: RpcHostRuntimeOptions = {}) {
		this.output = options.output ?? process.stdout;
		this.input = options.input ?? (process.stdin as RpcHostInput);
		this.terminal = options.terminal ?? defaultTerminalSessionOwner;
		this.state = options.initialState ?? FALLBACK_STATE;
		this.transcript = options.initialTranscript ?? EMPTY_TRANSCRIPT;
		this.inputPreview = options.inputPreview;
		this.editor = options.editor;
		this.modal = options.modal;
		this.overlay = options.overlay;
		this.notifications = options.notifications;
		this.extensionRegions = options.extensionRegions;
		this.inputHandler = options.inputHandler;
		this.preEditorInputHandler = options.preEditorInputHandler;
		this.inputRouter = new SharedInputRouter({
			openCommandPalette: () => {
				if (this.inputHandler?.openCommandPalette) {
					void this.inputHandler.openCommandPalette();
					return;
				}
				this.inputHandler?.handleInput?.("\u001f");
			},
			requestRender: () => this.render(),
			handleFocusedModalInput: (data) => {
				if (!this.modal?.getActiveKind?.()) return false;
				this.modal.handleInput?.(data);
				return true;
			},
			handleFocusedOverlayInput: (data) => {
				if (!this.overlay?.getActiveKind?.()) return false;
				this.overlay.handleInput?.(data);
				return true;
			},
			handleMouseEvent: (event) => this.shell?.handleMouseEvent(event) === true,
			scheduleMouseRender: () => this.render(),
			handleChatScrollKey: (event) => this.shell?.handleChatKey(event) === true,
			handlePreEditorInput: (data) => {
				if (this.preEditorInputHandler?.(data) === true) return true;
				// Fallback for when there's no host-level interrupt handler wired
				// (e.g. bare RpcHostRuntime in tests): containsCtrlCToken, not a
				// substring/equality test, so pasted content containing a literal
				// 0x03 byte cannot be mistaken for a Ctrl-C keypress here either.
				if (containsCtrlCToken(data)) {
					this.requestExit(130);
					return true;
				}
				return false;
			},
			forwardToEditor: (data) => {
				if (!this.editor) return false;
				this.editor.handleInput?.(data);
				return true;
			},
			handleUnhandledInput: (data) => {
				if (data.includes("q") || isEscapeInput(data)) {
					this.requestExit(0);
					return true;
				}
				return false;
			},
		});
	}

	public async start(): Promise<void> {
		if (this.started) return;
		this.started = true;
		this.terminal.startRetainedSession();
		if (this.input?.isTTY === true) {
			this.input.setRawMode?.(true);
			// Mirrors pi-tui's ProcessTerminal, which calls
			// process.stdin.setEncoding('utf8') so Node's StringDecoder
			// reassembles multibyte codepoints split across "data" events. Without
			// this, handleInput's toString('utf8') fallback below decodes each
			// Buffer independently and a split CJK/emoji codepoint becomes
			// U+FFFD garbage instead of the intended character.
			this.input.setEncoding?.("utf8");
			this.input.resume?.();
			this.input.on("data", this.handleInput);
		}
		this.output.on?.("resize", this.handleResize);
		const shell = await RpcShellAdapter.create({
			terminal: this.terminal,
			viewport: this.output,
			initialState: this.state,
			initialTranscript: this.transcript,
			inputPreview: this.inputPreview,
			editor: this.editor,
			modal: this.modal,
			overlay: this.overlay,
			notifications: this.notifications,
			extensionRegions: this.extensionRegions,
		});
		if (this.stopped) {
			shell.dispose();
			return;
		}
		this.shell = shell;
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
		}
		this.shell?.update(snapshot.transcript
			? { state: this.state, transcript: this.transcript }
			: { state: this.state });
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
		this.input?.pause?.();
		if (this.output.off) this.output.off("resize", this.handleResize);
		else this.output.removeListener?.("resize", this.handleResize);
		this.shell?.dispose();
		this.shell = undefined;
		this.terminal.exitTerminal();
		for (const resolve of this.waiters.splice(0)) resolve(code);
	}

	private render(): void {
		if (!this.started || this.stopped) return;
		this.shell?.render();
	}

	private requestExit(code: number): void {
		this.stop(code);
	}
}

export async function renderRpcHostFrameForTest(
	snapshot: RpcHostRuntimeSnapshot,
	columns: number,
	rows: number,
	options: Pick<RpcHostRuntimeOptions, "editor" | "extensionRegions" | "notifications"> = {},
): Promise<CellBuffer> {
	const shell = await RpcShellAdapter.create({
		terminal: { writeFramePatches: () => undefined },
		viewport: { columns, rows },
		initialState: snapshot.state,
		initialTranscript: snapshot.transcript,
		inputPreview: snapshot.inputPreview,
		editor: options.editor,
		notifications: options.notifications,
		extensionRegions: options.extensionRegions,
	});
	try {
		shell.render();
		const frame = shell.getLastFrame();
		if (!frame) throw new Error("RPC shell did not produce a frame");
		return frame.clone();
	} finally {
		shell.dispose();
	}
}
