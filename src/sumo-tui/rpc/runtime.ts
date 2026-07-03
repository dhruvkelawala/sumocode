import type { Component } from "@earendil-works/pi-tui";
import type { CellBuffer } from "../render/buffer.js";
import { logDiagnostic } from "../runtime/diagnostics.js";
import { defaultTerminalSessionOwner, type TerminalOutput, type TerminalSessionOwner } from "../runtime/terminal-controller.js";
import type { TranscriptViewModel } from "../transcript/view-model.js";
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
	private readonly inputHandler: RpcHostInputHandler | undefined;
	private readonly inputPreview: string | undefined;
	private state: RpcHostChromeState;
	private transcript: TranscriptViewModel;
	private shell: RpcShellAdapter | undefined;
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
		this.shell?.update({ state: this.state, transcript: this.transcript });
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
	options: Pick<RpcHostRuntimeOptions, "editor"> = {},
): Promise<CellBuffer> {
	const shell = await RpcShellAdapter.create({
		terminal: { writeFramePatches: () => undefined },
		viewport: { columns, rows },
		initialState: snapshot.state,
		initialTranscript: snapshot.transcript,
		inputPreview: snapshot.inputPreview,
		editor: options.editor,
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
