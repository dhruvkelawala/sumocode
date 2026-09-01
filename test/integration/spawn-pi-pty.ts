import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import xterm from "@xterm/headless";
import { spawn, type IPty } from "node-pty";
import {
	createChildEvidenceContext,
	HARNESS_SIGNATURE,
	HARNESS_SIGNATURE_ENV_KEY,
	recordPtyExit,
	supervisePtyProcess,
	waitForDiagnosticReadiness,
	type ChildEvidenceContext,
	type ReadinessState,
} from "./harness-supervisor.js";
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
	readonly spawn?: typeof spawn;
}

export interface SpawnedPiPty {
	sendInput(data: string): void;
	waitForOutput(pattern: string | RegExp, timeoutMs?: number): Promise<string>;
	waitForReady(state: ReadinessState, timeoutMs?: number): Promise<void>;
	sendSignal(signal: NodeJS.Signals): void;
	getCurrentTerminalState(): TerminalStateProbe;
	getOutput(): string;
	getEvidenceDir(): string;
	captureEvidence(finalScreen?: string): Promise<string>;
	cleanup(): void;
	cleanupAndWait(): Promise<void>;
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

function isStringPattern(pattern: string | RegExp): pattern is string {
	return typeof pattern === "string";
}

function matches(output: string, pattern: string | RegExp): boolean {
	return isStringPattern(pattern) ? output.includes(pattern) : pattern.test(output);
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
	"SUMOCODE_HOST_BUNDLE",
	"SUMOCODE_ROOT_DIR",
	"SUMOCODE_PROJECT_CWD",
	"SUMOCODE_LAUNCHER",
	"SUMOCODE_RELOAD",
	"SUMOCODE_REDUCED_MOTION",
	"SUMOCODE_DEBUG_BRANCH",
	"SUMOCODE_DEBUG_COMMIT",
	"SUMOCODE_TASK_MODE",
	"SUMOCODE_TASK_RESPONSE_FILE",
	"SUMOCODE_TASK_EXIT_FILE",
	"SUMOCODE_TASK_STARTED_FILE",
	"SUMOCODE_TASK_DIAG_FILE",
	"SUMOCODE_TEST_PRE_ADOPTION_DELAY_MS",
	"SUMOCODE_TEST_PRE_MAIN_DELAY_MS",
	"SUMOCODE_TEST_PRE_ADOPTION_MAIN_DELAY_MS",
	"SUMOCODE_TEST_POST_ADOPTION_DELAY_MS",
	"SUMOCODE_TEST_CHROME_CACHE_DELAY_MS",
	"SUMOCODE_TEST_BUNDLE_SCAN_DELAY_MS",
] as const;

const PROVIDER_CREDENTIAL_PREFIX = /^(?:AWS_|AZURE_|GOOGLE_|GEMINI_|OPENAI_|ANTHROPIC_|MISTRAL_|GROQ_|XAI_|DEEPSEEK_|OPENROUTER_|TOGETHER_|FIRECRAWL_|TAVILY_|BRAVE_)/i;
const CREDENTIAL_SUFFIX = /(?:API_KEY|API_TOKEN|AUTH_TOKEN|ACCESS_TOKEN|CLIENT_SECRET|PASSWORD|_SECRET|_TOKEN)$/i;

/** Test-only policy for environment keys that may carry provider credentials. */
export function isCredentialEnvKey(key: string): boolean {
	return PROVIDER_CREDENTIAL_PREFIX.test(key) || CREDENTIAL_SUFFIX.test(key);
}

const CHILD_ENV_ALLOWLIST = new Set([
	"PATH",
	"HOME",
	"USER",
	"LOGNAME",
	"SHELL",
	"LANG",
	"LC_ALL",
	"LC_CTYPE",
	"TZ",
	"EDITOR",
	"VISUAL",
	"COLORTERM",
	"CI",
	"NO_COLOR",
	"FORCE_COLOR",
	"PI_BIN",
	"SUMOCODE_INTEGRATION_RUN_ROOT",
	"SUMOCODE_INTEGRATION_MANIFEST",
	"SUMOCODE_INTEGRATION_PACKAGE_ROOT",
]);

/**
 * Constructs test-child environments from a small allowlist, then applies
 * explicit synthetic overrides. Run-scoped cache and temp paths are pinned
 * last so neither the developer shell nor a test can escape the namespace.
 */
export function buildSpawnEnv(parent: NodeJS.ProcessEnv, overrides: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
	const allowed: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(parent)) {
		if (value !== undefined && CHILD_ENV_ALLOWLIST.has(key) && !isCredentialEnvKey(key)) allowed[key] = value;
	}
	for (const key of SUMO_DEBUG_ENV_KEYS) delete allowed[key];
	const env: NodeJS.ProcessEnv = {
		...allowed,
		...overrides,
		PI_OFFLINE: "1",
		TERM: "xterm-256color",
	};
	const runRoot = parent.SUMOCODE_INTEGRATION_RUN_ROOT;
	if (runRoot !== undefined) {
		const tempRoot = join(runRoot, "tmp");
		const compileCache = join(runRoot, "node-compile-cache");
		mkdirSync(tempRoot, { recursive: true, mode: 0o700 });
		mkdirSync(compileCache, { recursive: true, mode: 0o700 });
		env.SUMOCODE_INTEGRATION_RUN_ROOT = runRoot;
		env.TMPDIR = tempRoot;
		env.NODE_COMPILE_CACHE = compileCache;
		delete env.NODE_PATH;
	}
	return env;
}

function removeOwnedAgentDir(agentDir: string | undefined): void {
	if (agentDir === undefined) return;
	try {
		rmSync(agentDir, { recursive: true, force: true });
	} catch {
		// Best-effort exit cleanup must not obscure the PTY's result.
	}
}

function createOwnedAgentDir(): string {
	const agentDir = mkdtempSync(join(tmpdir(), "sumocode-pi-agent-"));
	try {
		chmodSync(agentDir, 0o700);
		return agentDir;
	} catch (error) {
		removeOwnedAgentDir(agentDir);
		throw error;
	}
}

export function spawnPiPty(options: SpawnPiPtyOptions = {}): SpawnedPiPty {
	ensureNodePtySpawnHelperExecutable();

	const cwd = resolve(options.cwd ?? process.cwd());
	const command = options.command ?? process.env.PI_BIN ?? "pi";
	const args = applyDefaultProjectTrustOverride(options.args ?? ["--offline", "--no-extensions", "-e", "./src/extension.ts", "--no-session"]);
	const spawnPty = options.spawn ?? spawn;
	const ownedAgentDir = options.env?.PI_CODING_AGENT_DIR === undefined ? createOwnedAgentDir() : undefined;
	const envOverrides = ownedAgentDir === undefined ? options.env : { ...options.env, PI_CODING_AGENT_DIR: ownedAgentDir };
	const childEnv = buildSpawnEnv(process.env, envOverrides);
	const evidence: ChildEvidenceContext = createChildEvidenceContext([command, ...args], childEnv, childEnv.SUMO_TUI_DIAG_FILE);
	childEnv.SUMO_TUI_DIAG_FILE = evidence.diagPath;
	childEnv[HARNESS_SIGNATURE_ENV_KEY] = HARNESS_SIGNATURE;
	const isRealPty = options.spawn === undefined;
	let child: IPty;
	try {
		child = spawnPty(command, args, {
			name: "xterm-256color",
			cols: options.cols ?? 100,
			rows: options.rows ?? 30,
			cwd,
			env: childEnv,
		});
	} catch (error) {
		removeOwnedAgentDir(ownedAgentDir);
		throw error;
	}
	const supervision = isRealPty ? supervisePtyProcess(child.pid, evidence, childEnv) : undefined;

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
		if (isRealPty) appendFileSync(evidence.stderrPath, data);
		output += data;
		settleWaiters();
		// Retained frames are ANSI-heavy. Keep enough history for a waiter that
		// starts after the boot marker but before the next stable frame settles.
		if (output.length > 1_000_000) output = output.slice(-500_000);
	});

	let resolveExit: (() => void) | undefined;
	const exited = new Promise<void>((resolveChildExit) => { resolveExit = resolveChildExit; });

	async function capture(finalScreen?: string): Promise<string> {
		let screen = finalScreen;
		if (screen === undefined) {
			try {
				screen = (await replayScreenRows(output, options.cols ?? 100, options.rows ?? 30)).join("\n");
			} catch (error) {
				screen = `<screen replay failed: ${String(error)}>`;
			}
		}
		return supervision?.captureFailure(output, screen) ?? evidence.evidenceDir;
	}

	child.onExit(({ exitCode, signal }) => {
		if (supervision) recordPtyExit(supervision.pid, supervision.pgid, exitCode, signal, childEnv);
		resolveExit?.();
		void (async () => {
			try {
				for (const waiter of waiters.splice(0)) {
					clearTimeout(waiter.timer);
					if (matches(output, waiter.pattern)) {
						waiter.resolve(output);
					} else {
						const evidenceDir = await capture();
						waiter.reject(new Error(`pi pty exited before output matched ${String(waiter.pattern)} (exitCode=${exitCode}, signal=${signal}). Evidence: ${evidenceDir}`));
					}
				}
			} finally {
				removeOwnedAgentDir(ownedAgentDir);
			}
		})();
	});

	function requestCleanup(): void {
		for (const waiter of waiters.splice(0)) {
			clearTimeout(waiter.timer);
			waiter.reject(new Error("pi pty cleaned up before matcher completed"));
		}
		if (supervision) {
			void supervision.terminate();
			return;
		}
		try { child.kill("SIGTERM"); } catch { /* Child may have already exited. */ }
	}

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
						void capture().then((evidenceDir) => rejectWaiter(new Error(`Timed out waiting for ${String(pattern)}. Evidence: ${evidenceDir}`)));
					}, timeoutMs),
				};
				waiters.push(waiter);
			});
		},
		async waitForReady(state: ReadinessState, timeoutMs = 15_000): Promise<void> {
			try {
				await waitForDiagnosticReadiness(evidence.diagPath, state, timeoutMs);
			} catch (error) {
				const evidenceDir = await capture();
				throw new Error(`${String(error)}. Evidence: ${evidenceDir}`);
			}
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
		getEvidenceDir(): string {
			return evidence.evidenceDir;
		},
		captureEvidence(finalScreen?: string): Promise<string> {
			return capture(finalScreen);
		},
		cleanup(): void {
			requestCleanup();
		},
		async cleanupAndWait(): Promise<void> {
			for (const waiter of waiters.splice(0)) {
				clearTimeout(waiter.timer);
				waiter.reject(new Error("pi pty cleaned up before matcher completed"));
			}
			if (supervision) await supervision.terminate();
			else {
				try { child.kill("SIGTERM"); } catch { /* Child may have already exited. */ }
			}
			await Promise.race([exited, new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 1_500))]);
		},
	};
}

export const PI_BOOT_SEQUENCE = ALTSCREEN_ENTER_SEQUENCE;

export function spawnSumocodePty(options: SpawnPiPtyOptions = {}): SpawnedPiPty {
	const packageRoot = process.env.SUMOCODE_INTEGRATION_PACKAGE_ROOT ?? process.cwd();
	return spawnPiPty({
		...options,
		command: options.command ?? resolve(packageRoot, "bin/sumocode.sh"),
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

	public constructor(timeoutMs: number, evidenceDir: string) {
		super(`waitForScreen: predicate did not hold for two consecutive observations within ${timeoutMs}ms. Evidence: ${evidenceDir}`);
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
		if (Date.now() >= deadline) {
			const evidenceDir = await pty.captureEvidence(snapshot.text);
			throw new WaitForScreenTimeoutError(timeoutMs, evidenceDir);
		}
		await new Promise<void>((resolve) => setTimeout(resolve, pollIntervalMs));
	}
}
