import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { instrumentPiEventEmitter, logDiagnostic } from "./diagnostics.js";
import { FrameScheduler, type FrameRenderCallback } from "./frame-scheduler.js";
import { TerminalController } from "./terminal-controller.js";

export type LifecycleSignal = "SIGINT" | "SIGTERM" | "SIGHUP" | "SIGQUIT" | "SIGTSTP" | "SIGCONT";
export type LifecycleProcessEvent = LifecycleSignal | "exit" | "uncaughtException";
export type LifecycleListener = (...args: unknown[]) => void;

export interface LifecycleProcess {
	readonly pid: number;
	on(event: LifecycleProcessEvent, listener: LifecycleListener): unknown;
	removeListener(event: LifecycleProcessEvent, listener: LifecycleListener): unknown;
	kill(pid: number, signal: LifecycleSignal): void;
	exit?(code?: number): void;
}

export interface LifecycleInput {
	on(event: "data", listener: (data: string | Buffer) => void): unknown;
	setRawMode?(enabled: boolean): void;
}

export interface TerminalDimensions {
	readonly cols: number;
	readonly rows: number;
}

export interface TerminalDimensionSource {
	readonly columns?: number;
	readonly rows?: number;
	on?(event: "resize", listener: () => void): unknown;
	off?(event: "resize", listener: () => void): unknown;
	removeListener?(event: "resize", listener: () => void): unknown;
}

export interface TerminalDimensionsHandle {
	getSnapshot(): TerminalDimensions;
	dispose(): void;
}

export interface LifecycleRenderControls {
	scheduleRender(): void;
	setStreamingMode(enabled: boolean): void;
}

export interface LifecycleRuntimeOptions {
	readonly controller?: TerminalController;
	readonly process?: LifecycleProcess;
	readonly input?: LifecycleInput;
	readonly scheduler?: FrameScheduler;
	readonly render?: FrameRenderCallback;
	readonly homeDir?: () => string;
	readonly mkdirSync?: (path: string, options: { recursive: true }) => unknown;
	readonly appendFileSync?: (path: string, data: string, encoding: BufferEncoding) => void;
}

const EXIT_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"] as const;

function getNodeProcess(): LifecycleProcess {
	const processLike = process as unknown as {
		pid: number;
		on(event: string, listener: LifecycleListener): unknown;
		removeListener(event: string, listener: LifecycleListener): unknown;
		kill(pid: number, signal: string): void;
	};

	return {
		pid: process.pid,
		on: (event, listener) => processLike.on(event, listener),
		removeListener: (event, listener) => processLike.removeListener(event, listener),
		kill: (pid, signal) => processLike.kill(pid, signal),
		exit: (code) => process.exit(code),
	};
}

function getNodeInput(): LifecycleInput | undefined {
	const stdin = process.stdin as unknown as {
		readonly isTTY?: boolean;
		on(event: "data", listener: (data: string | Buffer) => void): unknown;
		setRawMode?(enabled: boolean): void;
	};
	if (stdin.isTTY !== true) return undefined;
	return {
		on: (event, listener) => stdin.on(event, listener),
		setRawMode: (enabled) => stdin.setRawMode?.(enabled),
	};
}

function crashText(error: unknown): string {
	if (error instanceof Error) return error.stack ?? `${error.name}: ${error.message}`;
	return String(error);
}

/** Subscribe to terminal resize events and expose the latest cell dimensions. */
export function useTerminalDimensions(
	onChange: (dimensions: TerminalDimensions) => void,
	source: TerminalDimensionSource = process.stdout,
): TerminalDimensionsHandle {
	const snapshot = (): TerminalDimensions => ({
		cols: Math.max(1, source.columns ?? 80),
		rows: Math.max(1, source.rows ?? 24),
	});
	const handleResize = (): void => onChange(snapshot());
	source.on?.("resize", handleResize);
	return {
		getSnapshot: snapshot,
		dispose(): void {
			if (source.off) source.off("resize", handleResize);
			else source.removeListener?.("resize", handleResize);
		},
	};
}

/**
 * Idempotent lifecycle coordinator. The default instance is installed at module
 * load so signal cleanup is registered before later extension/UI code, matching
 * the Phase 1 crash-recovery requirement.
 */
export class LifecycleRuntime {
	private readonly controller: TerminalController;
	private readonly lifecycleProcess: LifecycleProcess;
	private readonly input: LifecycleInput | undefined;
	private readonly scheduler: FrameScheduler;
	private readonly getHomeDir: () => string;
	private readonly makeDir: (path: string, options: { recursive: true }) => unknown;
	private readonly appendFile: (path: string, data: string, encoding: BufferEncoding) => void;
	private processHandlersInstalled = false;
	private sigtstpInstalled = false;
	private suspended = false;
	private readonly signalHandlers = new Map<LifecycleSignal, LifecycleListener>();

	public constructor(options: LifecycleRuntimeOptions = {}) {
		this.controller = options.controller ?? new TerminalController();
		this.lifecycleProcess = options.process ?? getNodeProcess();
		this.input = options.input ?? getNodeInput();
		this.scheduler = options.scheduler ?? new FrameScheduler({ render: options.render ?? (() => undefined) });
		this.getHomeDir = options.homeDir ?? homedir;
		this.makeDir = options.mkdirSync ?? mkdirSync;
		this.appendFile = options.appendFileSync ?? appendFileSync;
	}

	public installLifecycle(pi: ExtensionAPI): LifecycleRenderControls {
		this.installProcessHandlers();
		instrumentPiEventEmitter(pi);

		pi.on("session_start", (_event, ctx) => {
			if (!ctx.hasUI) return;
			this.controller.enterAltscreen();
			this.controller.enableMouseSGR();
		});

		pi.on("session_shutdown", () => {
			this.restoreTerminal();
		});

		return this.getRenderControls();
	}

	public scheduleRender(): void {
		this.scheduler.requestRender();
	}

	public setStreamingMode(enabled: boolean): void {
		if (enabled) this.scheduler.enterStreamingMode();
		else this.scheduler.exitStreamingMode();
	}

	public getRenderControls(): LifecycleRenderControls {
		return {
			scheduleRender: () => this.scheduleRender(),
			setStreamingMode: (enabled) => this.setStreamingMode(enabled),
		};
	}

	public installProcessHandlers(): void {
		if (this.processHandlersInstalled) return;
		this.processHandlersInstalled = true;

		for (const signal of EXIT_SIGNALS) {
			this.registerReraisingSignal(signal);
		}
		this.registerSuspendSignal();
		this.registerContinueSignal();
		this.registerRawCtrlCExit();

		this.lifecycleProcess.on("uncaughtException", (error) => {
			logDiagnostic("process_event", { name: "uncaughtException" });
			// Edge case 5.3: restore first, then persist a crash breadcrumb, then
			// rethrow so Node/Pi still fail loudly with the original exception.
			this.restoreTerminal();
			this.logCrash(error);
			throw error;
		});

		this.lifecycleProcess.on("exit", () => {
			logDiagnostic("process_event", { name: "exit" });
			this.restoreTerminal();
		});
	}

	public restoreTerminal(): void {
		this.releaseRawMode();
		this.controller.exitTerminal();
	}

	private registerReraisingSignal(signal: (typeof EXIT_SIGNALS)[number]): void {
		let reraised = false;
		const handler = (): void => {
			logDiagnostic("process_event", { name: signal });
			if (reraised) return;
			reraised = true;
			// Edge case 5.1: Ctrl+C and termination restore terminal state before
			// yielding back to the default/Pi signal path.
			this.restoreTerminal();
			this.lifecycleProcess.removeListener(signal, handler);
			this.lifecycleProcess.kill(this.lifecycleProcess.pid, signal);
		};
		this.signalHandlers.set(signal, handler);
		this.lifecycleProcess.on(signal, handler);
	}

	private registerSuspendSignal(): void {
		if (this.sigtstpInstalled) return;
		const existingHandler = this.signalHandlers.get("SIGTSTP");
		let handler: LifecycleListener;
		if (existingHandler) {
			handler = existingHandler;
		} else {
			handler = (): void => {
				logDiagnostic("process_event", { name: "SIGTSTP" });
				if (this.suspended) return;
				// Edge case 5.4: Ctrl+Z must leave the user's shell in a clean mode
				// before the OS suspends the process.
				this.suspended = true;
				this.restoreTerminal();
				this.sigtstpInstalled = false;
				this.lifecycleProcess.removeListener("SIGTSTP", handler);
				this.lifecycleProcess.kill(this.lifecycleProcess.pid, "SIGTSTP");
			};
		}
		this.signalHandlers.set("SIGTSTP", handler);
		this.lifecycleProcess.on("SIGTSTP", handler);
		this.sigtstpInstalled = true;
	}

	private registerContinueSignal(): void {
		const handler = (): void => {
			logDiagnostic("process_event", { name: "SIGCONT" });
			this.suspended = false;
			this.acquireRawMode();
			this.controller.enterAltscreen();
			this.controller.enableMouseSGR();
			this.registerSuspendSignal();
		};
		this.signalHandlers.set("SIGCONT", handler);
		this.lifecycleProcess.on("SIGCONT", handler);
	}

	private registerRawCtrlCExit(): void {
		this.input?.on("data", (data) => {
			const text = typeof data === "string" ? data : data.toString("utf8");
			if (!text.includes("\x03")) return;
			this.restoreTerminal();
			if (this.lifecycleProcess.exit) {
				this.lifecycleProcess.exit(130);
				return;
			}
			this.lifecycleProcess.kill(this.lifecycleProcess.pid, "SIGINT");
		});
	}

	private releaseRawMode(): void {
		try {
			this.input?.setRawMode?.(false);
		} catch {
			// Shutdown/suspend cleanup must be best-effort.
		}
	}

	private acquireRawMode(): void {
		try {
			this.input?.setRawMode?.(true);
		} catch {
			// Pi may already have disposed stdin during process teardown.
		}
	}

	private logCrash(error: unknown): void {
		try {
			const logDir = join(this.getHomeDir(), ".sumocode");
			this.makeDir(logDir, { recursive: true });
			this.appendFile(join(logDir, "crash.log"), `[${new Date().toISOString()}] uncaughtException\n${crashText(error)}\n\n`, "utf8");
		} catch {
			// Best-effort crash logging. Cleanup/rethrow semantics matter more than
			// the log file when the terminal is already recovering from a crash.
		}
	}
}

export function createLifecycleRuntime(options: LifecycleRuntimeOptions = {}): LifecycleRuntime {
	return new LifecycleRuntime(options);
}

const defaultLifecycle = createLifecycleRuntime();
defaultLifecycle.installProcessHandlers();

export function installLifecycle(pi: ExtensionAPI): LifecycleRenderControls {
	return defaultLifecycle.installLifecycle(pi);
}

export function scheduleRender(): void {
	defaultLifecycle.scheduleRender();
}

export function setStreamingMode(enabled: boolean): void {
	defaultLifecycle.setStreamingMode(enabled);
}
