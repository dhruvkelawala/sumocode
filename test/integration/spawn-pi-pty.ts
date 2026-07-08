import { chmodSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import xterm from "@xterm/headless";
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
	readonly command?: string;
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
 * SumoCode debug/runtime env vars that can leak diagnostics or retired runtime
 * wiring into spawned tests when set in the developer's shell (e.g.
 * `sumocode -d`). They must NOT be inherited by integration child processes
 * unless a test explicitly opts in via `options.env`. See #187.
 */
const RETIRED_MODULE_ENV_KEY = ["SUMO", "TUI", "MODULE"].join("_");
const RETIRED_LEGACY_ENV_KEY = ["SUMO", "LEGACY"].join("_");
const SUMO_DEBUG_ENV_KEYS = [
	"SUMO_TUI",
	"SUMO_TUI_DEBUG",
	"SUMO_TUI_DIAG_FILE",
	RETIRED_MODULE_ENV_KEY,
	"SUMO_TUI_HIDE_PI_NOISE",
	RETIRED_LEGACY_ENV_KEY,
	"SUMO_RPC",
	"SUMOCODE_RPC_CHILD",
	"SUMOCODE_REDUCED_MOTION",
	"SUMOCODE_DEBUG_BRANCH",
	"SUMOCODE_DEBUG_COMMIT",
	"SUMOCODE_TASK_MODE",
	"SUMOCODE_TASK_RESPONSE_FILE",
	"SUMOCODE_TASK_EXIT_FILE",
	"SUMOCODE_TASK_STARTED_FILE",
	"SUMOCODE_TASK_DIAG_FILE",
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
	const command = options.command ?? process.env.PI_BIN ?? "pi";
	const args = applyDefaultProjectTrustOverride(options.args ?? ["--offline", "--no-extensions", "-e", "./src/extension.ts", "--no-session"]);
	const child: IPty = spawn(command, args, {
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

export function spawnSumocodePty(options: SpawnPiPtyOptions = {}): SpawnedPiPty {
	return spawnPiPty({
		...options,
		command: options.command ?? resolve(process.cwd(), "bin/sumocode.sh"),
		args: options.args ?? ["--offline", "--no-extensions", "--no-session", "--approve"],
		env: options.env,
	});
}

/** Plain-text snapshot of the replayed terminal screen (one string per visible row; xterm already decoded all ANSI). */
export interface ScreenSnapshot {
	readonly rows: readonly string[];
	readonly text: string;
}

export interface WaitForScreenOptions {
	/** Terminal width the PTY was spawned with -- the replay must match it. */
	readonly cols: number;
	/** Terminal height the PTY was spawned with -- the replay must match it. */
	readonly rows: number;
	readonly timeoutMs?: number;
	readonly pollIntervalMs?: number;
}

export class WaitForScreenTimeoutError extends Error {
	public override readonly name = "WaitForScreenTimeoutError";

	public constructor(timeoutMs: number, lastScreen: string) {
		super(`waitForScreen: predicate did not hold for two consecutive polls within ${timeoutMs}ms. Last screen:\n${lastScreen}`);
	}
}

/** Replays the PTY's raw byte stream through a headless xterm and returns the visible rows as plain text. */
export async function replayScreenRows(output: string, cols: number, rows: number): Promise<string[]> {
	const term = new xterm.Terminal({ cols, rows, allowProposedApi: true, scrollback: 0 });
	await new Promise<void>((resolve) => term.write(output, () => resolve()));
	const buffer = term.buffer.active;
	const lines: string[] = [];
	for (let row = 0; row < rows; row += 1) {
		const line = buffer.getLine(row);
		let text = "";
		for (let col = 0; col < cols; col += 1) text += line?.getCell(col)?.getChars() ?? " ";
		lines.push(text);
	}
	term.dispose();
	return lines;
}

/**
 * Polls the replayed xterm screen until `predicate` holds for two
 * consecutive polls (guarding against matching a mid-repaint frame), or
 * times out with a `WaitForScreenTimeoutError` carrying the last screen.
 * The poll interval is a sampling cadence, not a "let it settle" sleep:
 * the wait ends as soon as the condition is observably true and stable.
 */
export async function waitForScreen(
	pty: SpawnedPiPty,
	predicate: (screen: ScreenSnapshot) => boolean,
	options: WaitForScreenOptions,
): Promise<ScreenSnapshot> {
	const timeoutMs = options.timeoutMs ?? 5_000;
	const pollIntervalMs = options.pollIntervalMs ?? 25;
	const deadline = Date.now() + timeoutMs;
	let consecutive = 0;
	let snapshot: ScreenSnapshot = { rows: [], text: "" };
	for (;;) {
		const rows = await replayScreenRows(pty.getOutput(), options.cols, options.rows);
		snapshot = { rows, text: rows.join("\n") };
		if (predicate(snapshot)) {
			consecutive += 1;
			if (consecutive >= 2) return snapshot;
		} else {
			consecutive = 0;
		}
		if (Date.now() >= deadline) throw new WaitForScreenTimeoutError(timeoutMs, snapshot.text);
		await new Promise<void>((resolve) => setTimeout(resolve, pollIntervalMs));
	}
}
