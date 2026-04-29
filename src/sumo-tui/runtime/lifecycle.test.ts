import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { createLifecycleRuntime, useTerminalDimensions, type LifecycleInput, type LifecycleListener, type LifecycleProcess, type LifecycleProcessEvent, type LifecycleSignal } from "./lifecycle.js";
import { ALTSCREEN_ENTER_SEQUENCE, MOUSE_SGR_ENABLE_SEQUENCE, TERMINAL_BG_RESET, TERMINAL_BG_SET, TERMINAL_CLEANUP_SEQUENCE, TerminalSessionOwner, type TerminalOutput } from "./terminal-controller.js";

class FakeProcess implements LifecycleProcess {
	public readonly pid = 4242;
	public readonly kills: Array<{ pid: number; signal: LifecycleSignal }> = [];
	public readonly exits: number[] = [];
	private readonly listeners = new Map<LifecycleProcessEvent, LifecycleListener[]>();

	public on(event: LifecycleProcessEvent, listener: LifecycleListener): void {
		const listeners = this.listeners.get(event) ?? [];
		listeners.push(listener);
		this.listeners.set(event, listeners);
	}

	public removeListener(event: LifecycleProcessEvent, listener: LifecycleListener): void {
		const listeners = this.listeners.get(event) ?? [];
		this.listeners.set(
			event,
			listeners.filter((candidate) => candidate !== listener),
		);
	}

	public kill(pid: number, signal: LifecycleSignal): void {
		this.kills.push({ pid, signal });
	}

	public exit(code?: number): void {
		this.exits.push(code ?? 0);
	}

	public listenerCount(event: LifecycleProcessEvent): number {
		return this.listeners.get(event)?.length ?? 0;
	}

	public emit(event: LifecycleProcessEvent, ...args: unknown[]): void {
		for (const listener of [...(this.listeners.get(event) ?? [])]) {
			listener(...args);
		}
	}
}

class FakeInput implements LifecycleInput {
	public readonly rawModes: boolean[] = [];
	private readonly listeners: Array<(data: string | Buffer) => void> = [];

	public on(_event: "data", listener: (data: string | Buffer) => void): void {
		this.listeners.push(listener);
	}

	public setRawMode(enabled: boolean): void {
		this.rawModes.push(enabled);
	}

	public emit(data: string | Buffer): void {
		for (const listener of this.listeners) listener(data);
	}

	public listenerCount(): number {
		return this.listeners.length;
	}
}

function outputStub(): TerminalOutput & { writes: string[] } {
	return {
		isTTY: true,
		writes: [],
		write(data: string) {
			this.writes.push(data);
			return true;
		},
	};
}

type Handler = (...args: unknown[]) => unknown;

function buildPiStub() {
	const handlers = new Map<string, Handler[]>();
	const pi = {
		on(event: string, handler: Handler) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
	};
	return { pi: pi as unknown as ExtensionAPI, handlers };
}

describe("useTerminalDimensions", () => {
	it("tracks stdout resize events and unsubscribes cleanly", () => {
		const source = new EventEmitter() as EventEmitter & { columns: number; rows: number };
		source.columns = 100;
		source.rows = 40;
		const seen: { cols: number; rows: number }[] = [];
		const handle = useTerminalDimensions((dimensions) => seen.push(dimensions), source);

		expect(handle.getSnapshot()).toEqual({ cols: 100, rows: 40 });
		source.columns = 80;
		source.rows = 24;
		source.emit("resize");
		expect(seen).toEqual([{ cols: 80, rows: 24 }]);
		handle.dispose();
		source.columns = 120;
		source.emit("resize");
		expect(seen).toHaveLength(1);
	});
});

describe("LifecycleRuntime", () => {
	it("registers process signal handlers exactly once", () => {
		const fakeProcess = new FakeProcess();
		const output = outputStub();
		const runtime = createLifecycleRuntime({ process: fakeProcess, terminalSession: new TerminalSessionOwner({ output }) });

		runtime.installProcessHandlers();
		runtime.installProcessHandlers();

		for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT", "SIGTSTP", "SIGCONT"] as const) {
			expect(fakeProcess.listenerCount(signal)).toBe(1);
		}
		expect(fakeProcess.listenerCount("uncaughtException")).toBe(1);
		expect(fakeProcess.listenerCount("exit")).toBe(1);
	});

	it("installLifecycle wires session_start and session_shutdown through the controller", () => {
		const fakeProcess = new FakeProcess();
		const output = outputStub();
		const runtime = createLifecycleRuntime({ process: fakeProcess, terminalSession: new TerminalSessionOwner({ output }) });
		const { pi, handlers } = buildPiStub();

		runtime.installLifecycle(pi);
		for (const handler of handlers.get("session_start") ?? []) {
			handler({ type: "session_start" }, { hasUI: true });
		}
		for (const handler of handlers.get("session_shutdown") ?? []) {
			handler({ type: "session_shutdown" }, { hasUI: true });
		}

		expect(output.writes).toEqual([`${ALTSCREEN_ENTER_SEQUENCE}${TERMINAL_BG_SET}`, MOUSE_SGR_ENABLE_SEQUENCE, `${TERMINAL_BG_RESET}${TERMINAL_CLEANUP_SEQUENCE}`]);
	});

	it("session_start ignores non-UI contexts", () => {
		const fakeProcess = new FakeProcess();
		const output = outputStub();
		const runtime = createLifecycleRuntime({ process: fakeProcess, terminalSession: new TerminalSessionOwner({ output }) });
		const { pi, handlers } = buildPiStub();

		runtime.installLifecycle(pi);
		for (const handler of handlers.get("session_start") ?? []) {
			handler({ type: "session_start" }, { hasUI: false });
		}

		expect(output.writes).toEqual([]);
	});

	it("cleanup runs once even if called twice", () => {
		const fakeProcess = new FakeProcess();
		const output = outputStub();
		const runtime = createLifecycleRuntime({ process: fakeProcess, terminalSession: new TerminalSessionOwner({ output }) });

		runtime.restoreTerminal();
		runtime.restoreTerminal();

		expect(output.writes).toEqual([TERMINAL_CLEANUP_SEQUENCE]);
	});

	it("SIGINT restores once, unregisters itself, and re-raises (EC-5.1)", () => {
		const fakeProcess = new FakeProcess();
		const output = outputStub();
		const runtime = createLifecycleRuntime({ process: fakeProcess, terminalSession: new TerminalSessionOwner({ output }) });

		runtime.installProcessHandlers();
		fakeProcess.emit("SIGINT");
		fakeProcess.emit("SIGINT");

		expect(output.writes).toEqual([TERMINAL_CLEANUP_SEQUENCE]);
		expect(fakeProcess.kills).toEqual([{ pid: fakeProcess.pid, signal: "SIGINT" }]);
		expect(fakeProcess.listenerCount("SIGINT")).toBe(0);
	});

	it("SIGTSTP restores before suspend and SIGCONT re-enters altscreen + mouse (EC-5.4)", () => {
		const fakeProcess = new FakeProcess();
		const fakeInput = new FakeInput();
		const output = outputStub();
		const runtime = createLifecycleRuntime({ process: fakeProcess, input: fakeInput, terminalSession: new TerminalSessionOwner({ output }) });

		runtime.installProcessHandlers();
		fakeProcess.emit("SIGTSTP");
		fakeProcess.emit("SIGCONT");

		expect(output.writes).toEqual([TERMINAL_CLEANUP_SEQUENCE, `${ALTSCREEN_ENTER_SEQUENCE}${TERMINAL_BG_SET}`, MOUSE_SGR_ENABLE_SEQUENCE]);
		expect(fakeInput.rawModes).toEqual([false, true]);
		expect(fakeProcess.kills).toEqual([{ pid: fakeProcess.pid, signal: "SIGTSTP" }]);
		expect(fakeProcess.listenerCount("SIGTSTP")).toBe(1);
	});

	it("raw Ctrl+C input restores terminal and exits with SIGINT convention", () => {
		const fakeProcess = new FakeProcess();
		const fakeInput = new FakeInput();
		const output = outputStub();
		const runtime = createLifecycleRuntime({ process: fakeProcess, input: fakeInput, terminalSession: new TerminalSessionOwner({ output }) });

		runtime.installProcessHandlers();
		fakeInput.emit("\x03");

		expect(fakeInput.listenerCount()).toBe(1);
		expect(fakeInput.rawModes).toEqual([false]);
		expect(output.writes).toEqual([TERMINAL_CLEANUP_SEQUENCE]);
		expect(fakeProcess.exits).toEqual([130]);
	});

	it("uncaughtException restores terminal, logs crash.log, and rethrows (EC-5.3)", async () => {
		const fakeProcess = new FakeProcess();
		const output = outputStub();
		const tmpHome = await mkdtemp(join(tmpdir(), "sumocode-crash-"));
		const runtime = createLifecycleRuntime({
			process: fakeProcess,
			terminalSession: new TerminalSessionOwner({ output }),
			homeDir: () => tmpHome,
		});
		const error = new Error("phase 1 crash proof");

		runtime.installProcessHandlers();
		expect(() => fakeProcess.emit("uncaughtException", error)).toThrow(error);

		const crashLog = join(tmpHome, ".sumocode", "crash.log");
		expect(output.writes).toEqual([TERMINAL_CLEANUP_SEQUENCE]);
		expect(existsSync(crashLog)).toBe(true);
		expect(readFileSync(crashLog, "utf8")).toContain("phase 1 crash proof");
	});
});
