import { chmodSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { spawn, type IPty } from "node-pty";
import { ALTSCREEN_ENTER_SEQUENCE, MOUSE_SGR_DISABLE_SEQUENCE, MOUSE_SGR_ENABLE_SEQUENCE, TERMINAL_CLEANUP_SEQUENCE } from "../../src/sumo-tui/runtime/terminal-controller.js";

export interface TerminalStateProbe {
	readonly altscreenActive: boolean;
	readonly mouseSGRActive: boolean;
	readonly kittyKeyboardPopped: boolean;
	readonly cursorVisible: boolean;
	readonly cleanupSequenceSeen: boolean;
	readonly lastWriteBuffer: string;
	readonly probeMethod: "write-buffer";
}

export interface SpawnPiPtyOptions {
	readonly cwd?: string;
	readonly cols?: number;
	readonly rows?: number;
	readonly env?: NodeJS.ProcessEnv;
	readonly args?: string[];
}

export interface SpawnedPiPty {
	sendInput(data: string): void;
	waitForOutput(pattern: string | RegExp, timeoutMs?: number): Promise<string>;
	sendSignal(signal: NodeJS.Signals): void;
	getCurrentTerminalState(): TerminalStateProbe;
	getOutput(): string;
	cleanup(): void;
}

interface Waiter {
	readonly pattern: string | RegExp;
	readonly resolve: (output: string) => void;
	readonly reject: (error: Error) => void;
	readonly timer: ReturnType<typeof setTimeout>;
}

function ensureNodePtySpawnHelperExecutable(): void {
	const require = createRequire(import.meta.url);
	const nodePtyMain = require.resolve("node-pty");
	const spawnHelper = join(dirname(nodePtyMain), "..", "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper");
	if (!existsSync(spawnHelper)) return;
	chmodSync(spawnHelper, 0o755);
}

function matches(output: string, pattern: string | RegExp): boolean {
	return typeof pattern === "string" ? output.includes(pattern) : pattern.test(output);
}

function lastModeState(buffer: string, enableSequence: string, disableSequence: string): boolean {
	return buffer.lastIndexOf(enableSequence) > buffer.lastIndexOf(disableSequence);
}

function parseTerminalState(buffer: string): TerminalStateProbe {
	const altscreenActive = lastModeState(buffer, "\x1b[?1049h", "\x1b[?1049l");
	const mouseSGRActive = buffer.lastIndexOf(MOUSE_SGR_ENABLE_SEQUENCE) > buffer.lastIndexOf(MOUSE_SGR_DISABLE_SEQUENCE);
	const cursorVisible = buffer.lastIndexOf("\x1b[?25h") > buffer.lastIndexOf("\x1b[?25l");

	return {
		altscreenActive,
		mouseSGRActive,
		kittyKeyboardPopped: buffer.includes("\x1b[<u"),
		cursorVisible,
		cleanupSequenceSeen: buffer.includes(TERMINAL_CLEANUP_SEQUENCE),
		lastWriteBuffer: buffer.slice(-4096),
		probeMethod: "write-buffer",
	};
}

/**
 * Pi 0.79 asks about project trust before retained-mode boot whenever a
 * project or ancestor has trust-gated inputs. Integration tests exercise
 * SumoCode runtime behavior, not the trust prompt, so approve for the child
 * PTY unless a test explicitly supplies a trust override.
 */
function applyDefaultProjectTrustOverride(args: readonly string[]): string[] {
	if (args.some((arg) => arg === "--approve" || arg === "-a" || arg === "--no-approve" || arg === "-na")) return [...args];
	return [...args, "--approve"];
}

/**
 * SumoCode debug env vars that leak retained-mode wiring or diagnostics into
 * spawned tests when set in the developer's shell (e.g. `sumocode -d`). They
 * must NOT be inherited by integration child processes unless a test
 * explicitly opts in via `options.env`. See #187.
 */
const SUMO_DEBUG_ENV_KEYS = [
	"SUMO_TUI",
	"SUMO_TUI_DEBUG",
	"SUMO_TUI_DIAG_FILE",
	"SUMO_TUI_MODULE",
	"SUMO_TUI_HIDE_PI_NOISE",
	"SUMOCODE_REDUCED_MOTION",
	"SUMOCODE_DEBUG_BRANCH",
	"SUMOCODE_DEBUG_COMMIT",
] as const;

export function buildSpawnEnv(parent: NodeJS.ProcessEnv, overrides: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
	const scrubbed: NodeJS.ProcessEnv = { ...parent };
	for (const key of SUMO_DEBUG_ENV_KEYS) delete scrubbed[key];
	return {
		...scrubbed,
		...(overrides ?? {}),
		PI_OFFLINE: "1",
		TERM: "xterm-256color",
	};
}

export function spawnPiPty(options: SpawnPiPtyOptions = {}): SpawnedPiPty {
	ensureNodePtySpawnHelperExecutable();

	const cwd = resolve(options.cwd ?? process.cwd());
	const args = applyDefaultProjectTrustOverride(options.args ?? ["--offline", "--no-extensions", "-e", "./src/extension.ts", "--no-session"]);
	const child: IPty = spawn(process.env.PI_BIN ?? "pi", args, {
		name: "xterm-256color",
		cols: options.cols ?? 100,
		rows: options.rows ?? 30,
		cwd,
		env: buildSpawnEnv(process.env, options.env),
	});

	let output = "";
	const waiters: Waiter[] = [];

	function settleWaiters(): void {
		for (let index = waiters.length - 1; index >= 0; index--) {
			const waiter = waiters[index];
			if (!matches(output, waiter.pattern)) continue;
			clearTimeout(waiter.timer);
			waiters.splice(index, 1);
			waiter.resolve(output);
		}
	}

	child.onData((data) => {
		output += data;
		if (output.length > 200_000) output = output.slice(-100_000);
		settleWaiters();
	});

	child.onExit(({ exitCode, signal }) => {
		for (const waiter of waiters.splice(0)) {
			clearTimeout(waiter.timer);
			if (matches(output, waiter.pattern)) {
				waiter.resolve(output);
			} else {
				waiter.reject(new Error(`pi pty exited before output matched ${String(waiter.pattern)} (exitCode=${exitCode}, signal=${signal})`));
			}
		}
	});

	return {
		sendInput(data: string): void {
			child.write(data);
		},
		waitForOutput(pattern: string | RegExp, timeoutMs = 5_000): Promise<string> {
			if (matches(output, pattern)) return Promise.resolve(output);
			return new Promise((resolveWaiter, rejectWaiter) => {
				const waiter: Waiter = {
					pattern,
					resolve: resolveWaiter,
					reject: rejectWaiter,
					timer: setTimeout(() => {
						const index = waiters.indexOf(waiter);
						if (index >= 0) waiters.splice(index, 1);
						rejectWaiter(new Error(`Timed out waiting for ${String(pattern)}. Last output: ${JSON.stringify(output.slice(-1000))}`));
					}, timeoutMs),
				};
				waiters.push(waiter);
			});
		},
		sendSignal(signal: NodeJS.Signals): void {
			child.kill(signal);
		},
		getCurrentTerminalState(): TerminalStateProbe {
			// node-pty gives us the child side of the PTY, not a full terminal
			// emulator that can answer DECRQM. Fall back to parsing the write buffer.
			return parseTerminalState(output);
		},
		getOutput(): string {
			return output;
		},
		cleanup(): void {
			for (const waiter of waiters.splice(0)) {
				clearTimeout(waiter.timer);
				waiter.reject(new Error("pi pty cleaned up before matcher completed"));
			}
			try {
				child.kill("SIGTERM");
			} catch {
				// Child may have already exited.
			}
		},
	};
}

export const PI_BOOT_SEQUENCE = ALTSCREEN_ENTER_SEQUENCE;
