/**
 * Native executable entry (plan 117). Compiled by `scripts/build-native.mjs`
 * into the `bin/sumocode` host binary; `bin/sumocode-pi` (compiled Pi child)
 * and `extension/sumocode-extension.bundle.mjs` live beside/below it.
 *
 * One process, three roles, in evaluation order:
 *  1. `--sumocode-terminal-runner <posix|win32> <commandFile> <logFile> <maxBytes>`
 *    — the bounded terminal runner the generated task scripts invoke in place
 *    of `node bounded-terminal-runner.mjs` (task-manager.ts seam 3).
 *  2. The launcher contract pinned in
 *    `test/integration/launcher-runtime-contract.ts` — interactive TTY →
 *    in-process RPC host; `--print/-p/--mode`/non-TTY stdout/`--no-sumo-tui` →
 *    direct Pi; `-h/-v/doctor/diag/-d/--diag-file/--no-clear-diag/--dry-run`.
 *  3. The RPC host itself, imported only after the child is pre-spawned (no
 *    Jiti, no bundle freshness scan — the archive is immutable).
 *
 * Runtime detection never uses Bun globals: `SUMOCODE_NATIVE_DIR` is set here
 * before any host code loads, and `src/native/paths.ts` reads only env.
 */
declare const __SUMOCODE_VERSION__: string | undefined;

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { appendFileSync, closeSync, existsSync, openSync, realpathSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { buildChildSpawnPlan } from "../sumo-tui/rpc/spawn-child.mjs";

const RELOAD_EXIT_CODE = 100;
const PRE_ADOPTION_KILL_GRACE_MS = 250;

// Mirrors TERMINAL_CLEANUP_SEQUENCE in terminal-controller.ts and
// RELOAD_FALLBACK_TERMINAL_CLEANUP in sumo-rpc-host.js (rpc-host-shell.test.ts
// compares them to catch drift).
const RELOAD_FALLBACK_TERMINAL_CLEANUP =
	"\x1b]112\x1b\\" + // cursor colour reset
	"\x1b]111\x1b\\" + // terminal background reset
	"\x1b[<u" + // kitty keyboard pop
	"\x1b[>4;0m" + // xterm modifyOtherKeys off
	"\x1b[?2004l" + // bracketed paste off
	"\x1b[?1003l\x1b[?1002l\x1b[?1006l\x1b[?1000l" + // mouse off
	"\x1b[?1049l" + // altscreen off
	"\x1b[?25h\x1b[0m"; // cursor visible + SGR reset

// The archive layout is root-relative (bin/, extension/, share/). The
// executable lives in bin/, so the archive root is its parent — verified
// against the build layout by the doctor layout checks below.
const EXEC_DIR = dirname(realpathSync(process.execPath));
const NATIVE_DIR = dirname(EXEC_DIR);
process.env.SUMOCODE_NATIVE_DIR = NATIVE_DIR;
process.env.SUMOCODE_ROOT_DIR = NATIVE_DIR;

const PI_BIN = resolveProcessPiBin();
const EXTENSION_ENTRY = join(NATIVE_DIR, "extension/sumocode-extension.bundle.mjs");

function resolveProcessPiBin(): string {
	const fromEnv = process.env.PI_BIN;
	if (fromEnv !== undefined && fromEnv.trim() !== "" && existsSync(fromEnv)) return fromEnv;
	return join(NATIVE_DIR, "bin", "sumocode-pi");
}

function usageError(message: string): never {
	process.stderr.write(`[sumocode] ${message}\n\nRun 'sumocode --help' for usage.\n`);
	process.exit(64);
}

function makePrivateTempFile(prefix: string): string {
	const dir = process.env.TMPDIR && process.env.TMPDIR.trim() !== "" ? process.env.TMPDIR : "/tmp";
	const path = join(dir, `${prefix}.${process.pid}.${Math.random().toString(36).slice(2, 10)}`);
	const fd = openSync(path, "wx", 0o600);
	closeSync(fd);
	return path;
}

interface StartupMarkFields {
	readonly mode?: "native";
}

function writeStartupMark(event: string, fields: StartupMarkFields = {}): void {
	const file = process.env.SUMO_TUI_DIAG_FILE;
	if (!file) return;
	try {
		appendFileSync(file, `${JSON.stringify({ ts: Date.now(), event, ...fields })}\n`, { encoding: "utf8", mode: 0o600 });
	} catch {}
}

// ── argv roles, handled before any launcher/host logic ─────────────────────

async function runTerminalRunnerRole(): Promise<boolean> {
	const argv = process.argv.slice(2);
	if (argv[0] !== "--sumocode-terminal-runner") return false;
	// bounded-terminal-runner.mjs reads process.argv.slice(2) at module
	// evaluation and drives its exit through process.exitCode/exit, exactly as
	// when Node runs the .mjs file directly.
	process.argv = [process.argv[0]!, "bounded-terminal-runner", ...argv.slice(1)];
	// SAFETY: this literal cast only suppresses missing declarations for the
	// side-effect-only .mjs runner; Bun resolves and embeds the literal module.
	await import("../background-tasks/bounded-terminal-runner.mjs" as string);
	return true;
}

// ── Pi parseArgs consumption-class tables (mirrors bin/sumocode.sh, pinned by
// test/integration/spawn-pi-pty.test.ts against pi-coding-agent 0.84.3) ────

const PI_UNCONDITIONAL_VALUE_FLAGS = new Set([
	"--mode", "--provider", "--model", "--api-key", "--system-prompt",
	"--append-system-prompt", "--name", "-n", "--session", "--session-id", "--fork",
	"--session-dir", "--models", "--tools", "-t", "--exclude-tools", "-xt", "--thinking",
	"--export", "--extension", "-e", "--skill", "--prompt-template", "--theme",
]);
const PI_BOOLEAN_FLAGS = new Set([
	"--help", "-h", "--version", "-v", "--continue", "-c", "--resume", "-r", "--no-session",
	"--no-tools", "-nt", "--no-builtin-tools", "-nbt", "--no-extensions", "-ne",
	"--no-skills", "-ns", "--no-prompt-templates", "-np", "--no-themes",
	"--no-context-files", "-nc", "--verbose", "--approve", "-a", "--no-approve", "-na",
	"--offline",
]);

function isUnconditionalValueFlag(arg: string): boolean {
	return PI_UNCONDITIONAL_VALUE_FLAGS.has(arg);
}

function firstDelimiterIndex(args: readonly string[]): number {
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		if (arg === "--") return i;
		if (isUnconditionalValueFlag(arg) && i + 1 < args.length) {
			i += 1;
			continue;
		}
	}
	return -1;
}

function firstPositionalIndex(args: readonly string[]): number {
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		if (arg === "--") {
			i += 1;
			while (i < args.length) {
				const after = args[i]!;
				if (!after.startsWith("@")) return i;
				i += 1;
			}
			return -1;
		}
		if (arg.startsWith("--") && arg.includes("=")) {
			// --flag=value is a single token in args.js's generic handler and
			// never consumes a following value.
			continue;
		}
		if (isUnconditionalValueFlag(arg)) {
			if (i + 1 < args.length) i += 1;
			continue;
		}
		if (PI_BOOLEAN_FLAGS.has(arg)) continue;
		if (arg === "--print" || arg === "-p") {
			const next = i + 1 < args.length ? args[i + 1]! : undefined;
			if (next !== undefined && !next.startsWith("@") && (!next.startsWith("-") || next.startsWith("---"))) {
				i += 1;
			}
			continue;
		}
		if (arg === "--list-models") {
			const next = i + 1 < args.length ? args[i + 1]! : undefined;
			if (next !== undefined && !next.startsWith("-") && !next.startsWith("@")) i += 1;
			continue;
		}
		if (arg === "--tui-mode") {
			const next = i + 1 < args.length ? args[i + 1]! : undefined;
			if (next !== undefined && !next.startsWith("-")) i += 1;
			continue;
		}
		if (arg === "--use-theme") {
			const next = i + 1 < args.length ? args[i + 1]! : undefined;
			if (next !== undefined && !next.startsWith("-")) i += 1;
			continue;
		}
		if (arg.startsWith("@")) continue;
		if (arg.startsWith("--")) {
			const next = i + 1 < args.length ? args[i + 1]! : undefined;
			if (next !== undefined && !next.startsWith("-") && !next.startsWith("@")) i += 1;
			continue;
		}
		if (arg.startsWith("-")) continue;
		return i;
	}
	return -1;
}

/** `--print|-p|--mode|--mode=*` before any `--` delimiter requests direct Pi. */
function argsRequestNoninteractivePi(args: readonly string[]): boolean {
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		if (arg === "--print" || arg === "-p" || arg === "--mode" || arg.startsWith("--mode=")) return true;
		if (arg === "--") break;
		if (isUnconditionalValueFlag(arg) && i + 1 < args.length) i += 1;
	}
	return false;
}

/**
 * Dry-run display of args: every message token and secret option value
 * becomes [redacted] (issue 391). Mirrors redact_sensitive_args.
 */
function redactSensitiveArgs(args: readonly string[]): string {
	const out: string[] = [];
	let inDelimiter = false;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		if (inDelimiter) {
			out.push(arg.startsWith("@") ? arg : "[redacted]");
			continue;
		}
		if (arg === "--") {
			inDelimiter = true;
			out.push(arg);
			continue;
		}
		if (/^(?:--(?:api-key|system-prompt|append-system-prompt|print|p)|-p)=/.test(arg)) {
			out.push(`${arg.slice(0, arg.indexOf("="))}=[redacted]`);
			continue;
		}
		if (arg === "--api-key" || arg === "--system-prompt" || arg === "--append-system-prompt") {
			out.push(arg, "[redacted]");
			i += 1;
			continue;
		}
		if (arg === "--print" || arg === "-p") {
			out.push(arg);
			const next = i + 1 < args.length ? args[i + 1]! : undefined;
			if (next !== undefined && !next.startsWith("@") && (!next.startsWith("-") || next.startsWith("---"))) {
				out.push("[redacted]");
				i += 1;
			}
			continue;
		}
		if (isUnconditionalValueFlag(arg)) {
			out.push(arg);
			if (i + 1 < args.length) {
				out.push(args[i + 1]!);
				i += 1;
			}
			continue;
		}
		if (PI_BOOLEAN_FLAGS.has(arg)) {
			out.push(arg);
			continue;
		}
		if (arg.startsWith("@")) {
			out.push(arg);
			continue;
		}
		if (arg.startsWith("--")) {
			out.push(arg);
			const next = i + 1 < args.length ? args[i + 1]! : undefined;
			if (next !== undefined && !next.startsWith("-") && !next.startsWith("@")) {
				out.push(next);
				i += 1;
			}
			continue;
		}
		if (arg.startsWith("-")) {
			out.push(arg);
			continue;
		}
		out.push("[redacted]");
	}
	return out.join(" ");
}

/** Removes the first positional (parsed.messages[0]) from args in place. */
function extractFirstPositional(args: string[]): string {
	const index = firstPositionalIndex(args);
	if (index < 0) return "";
	const prompt = args[index]!;
	args.splice(index, 1);
	return prompt;
}

// ── launcher arg parsing (bin/sumocode.sh wrapper layer) ───────────────────

type LauncherCommand = "run" | "doctor" | "diag" | "task" | "worktree";

interface ParsedLaunch {
	command: LauncherCommand;
	debugMode: boolean;
	clearDiag: boolean;
	dryRun: boolean;
	forceDirectPi: boolean;
	diagFile: string;
	promptFile: string;
	taskDir: string;
	forwardedArgs: string[];
}

function parseLauncherArgv(argv: readonly string[]): ParsedLaunch {
	const parsed: ParsedLaunch = {
		command: "run",
		debugMode: false,
		clearDiag: true,
		dryRun: false,
		forceDirectPi: false,
		diagFile: process.env.SUMO_TUI_DIAG_FILE ?? "",
		promptFile: "",
		taskDir: "",
		forwardedArgs: [],
	};
	const args = [...argv];
	while (args.length > 0) {
		const arg = args.shift()!;
		switch (arg) {
			case "doctor":
			case "diag":
			case "task":
				if (parsed.command !== "run") usageError("Only one command may be specified.");
				parsed.command = arg;
				continue;
			case "-w":
			case "--worktree":
				if (parsed.command !== "run") usageError("Only one command may be specified.");
				parsed.command = "worktree";
				continue;
			case "-d":
			case "--debug":
				parsed.debugMode = true;
				continue;
			case "--diag-file":
				if (args.length < 1) usageError("--diag-file requires a path.");
				parsed.debugMode = true;
				parsed.diagFile = args.shift()!;
				continue;
			case "--no-clear-diag":
				parsed.clearDiag = false;
				continue;
			case "--prompt-file":
				if (args.length < 1) usageError("--prompt-file requires a path.");
				parsed.promptFile = args.shift()!;
				continue;
			case "--task-dir":
				if (args.length < 1) usageError("--task-dir requires a path.");
				parsed.taskDir = args.shift()!;
				continue;
			case "--no-sumo-tui":
				parsed.forceDirectPi = true;
				continue;
			case "--dry-run":
				parsed.dryRun = true;
				continue;
			case "-v":
			case "--version":
				process.stdout.write(`sumocode ${__SUMOCODE_VERSION__ ?? "0.0.0"}\n`);
				process.exit(0);
				break; // unreachable
			case "-h":
			case "--help":
				printHelp();
				process.exit(0);
				break; // unreachable
			case "--": {
				// Preserve the delimiter for run/task so mode selection and prompt
				// extraction treat --print/--mode tokens as messages.
				if (parsed.command === "run" || parsed.command === "task") {
					if (args[0] !== "--") parsed.forwardedArgs.push("--");
				}
				parsed.forwardedArgs.push(...args);
				args.length = 0;
				continue;
			}
			default:
				// Unknown flags belong to Pi; everything forwards.
				parsed.forwardedArgs.push(arg);
				continue;
		}
	}
	return parsed;
}

function printHelp(): void {
	process.stdout.write(`SumoCode — Cathedral terminal AI coding agent

USAGE
  sumocode [options] [path]

COMMANDS
  doctor          Check the native runtime, Pi child, and diagnostics path
  diag [file]     Summarize a diagnostics JSONL (default /tmp/sumocode-manual.jsonl)
  task <prompt>   Launch a one-shot task pane kickoff

OPTIONS
  -d, --debug                 Enable diagnostics (JSONL flight recorder)
  --diag-file <path>          Write diagnostics to <path> (implies --debug)
  --no-clear-diag             Keep an existing diagnostics file at startup
  --prompt-file <path>        (task) Read the kickoff prompt from a file
  --task-dir <dir>            (task) Machine-readable task directory contract
  --no-sumo-tui               Bypass the retained runtime; run Pi directly
  --dry-run                   Print the resolved launch plan and exit
  -v, --version               Print the version
  -h, --help                  Print this help

Unknown flags forward to Pi (e.g. --offline, --model, --no-session).
Interactive TTY launches use the SumoCode RPC host. Non-interactive Pi
modes (--print, --mode), non-TTY stdout, and --no-sumo-tui bypass it.

Documentation: https://github.com/dhruvkelawala/sumocode
`);
}

// ── subcommands ────────────────────────────────────────────────────────────

function runDoctor(parsed: ParsedLaunch): never {
	let failures = 0;
	const check = (ok: boolean, okLine: string, failLine: string): void => {
		process.stdout.write(`${ok ? "✓" : "✗"} ${ok ? okLine : failLine}\n`);
		if (!ok) failures += 1;
	};
	process.stdout.write("SumoCode doctor\n\n");
	process.stdout.write(`Version: ${__SUMOCODE_VERSION__ ?? "0.0.0"}\n`);
	process.stdout.write(`Root: ${NATIVE_DIR}\n`);
	check(EXEC_DIR === join(NATIVE_DIR, "bin"), `Layout: ${NATIVE_DIR} (bin/, extension/, share/)`, `Layout: executable not under <archive>/bin (${EXEC_DIR})`);
	check(true, `Runtime: native (${process.platform}-${process.arch}, bun ${process.versions.bun ?? "?"})`, "Runtime: native");
	check(existsSync(PI_BIN), `Pi binary: ${PI_BIN}`, "Pi binary: not found or not executable");
	check(existsSync(EXTENSION_ENTRY), `Extension bundle: ${EXTENSION_ENTRY}`, "Extension bundle: missing");
	const yogaWasm = join(NATIVE_DIR, "share/yoga.wasm");
	check(existsSync(yogaWasm), `Yoga wasm: ${yogaWasm}`, "Yoga wasm: missing");
	const diagPath = parsed.diagFile !== "" ? parsed.diagFile : process.env.SUMO_TUI_DIAG_FILE ?? "/tmp/sumocode-manual.jsonl";
	let diagWritable = false;
	try {
		diagWritable = statSync(dirname(diagPath)).isDirectory();
	} catch {
		diagWritable = false;
	}
	check(diagWritable, `diagnostics path writable: ${diagPath}`, `diagnostics directory not writable: ${diagPath}`);
	if (process.stdout.isTTY) {
		process.stdout.write("✓ stdout is TTY\n");
	} else {
		process.stdout.write("! stdout is not a TTY\n");
	}
	process.stdout.write("\n");
	if (failures === 0) {
		process.stdout.write("Doctor passed.\n");
		process.exit(0);
	}
	process.stdout.write(`Doctor found ${failures} problem(s).\n`);
	process.exit(70);
}

async function runDiag(file: string): Promise<never> {
	// diag-summary.mjs reads process.argv[2] at module evaluation, prints the
	// summary, and (unlike the missing-file path) does not exit by itself.
	process.argv = [process.argv[0]!, "diag-summary", file];
	try {
		// SAFETY: this literal cast only suppresses missing declarations for the
		// side-effect-only .mjs summary; Bun resolves and embeds the literal module.
		await import("../../scripts/diag-summary.mjs" as string);
		process.exit(process.exitCode ?? 0);
	} catch (error) {
		process.stderr.write(`[sumocode] diag failed: ${error instanceof Error ? error.message : String(error)}\n`);
		process.exit(1);
	}
}

// ── direct-Pi + reload plumbing (launcher loop) ────────────────────────────

interface DirectPiInvocation {
	readonly args: string[];
	readonly stdinPrompt: string;
}

/**
 * Direct-Pi stdin transport (issue 391): non-TTY stdin reads as the initial
 * message, so the kickoff/task prompt rides stdin while argv keeps flags.
 * Falls back to argv transport (prompt re-inserted) when other message-bearing
 * tokens remain — Pi print mode loops over every message, and --mode reads
 * stdin as a protocol channel. Mirrors the launcher's DIRECT_PI_STDIN_PROMPT
 * block.
 */
function resolveDirectPiStdinPrompt(args: string[]): DirectPiInvocation {
	if (process.stdin.isTTY) return { args, stdinPrompt: "" };
	const promptIndex = firstPositionalIndex(args);
	let stdinPrompt = "";
	if (promptIndex >= 0) {
		stdinPrompt = extractFirstPositional(args);
		if (stdinPrompt === "") return { args, stdinPrompt: "" };

		let fallback = false;
		if (firstPositionalIndex(args) >= 0) {
			fallback = true;
		} else if (args.length > 0) {
			for (const arg of args) {
				if (arg === "-p" || arg === "--print" || arg.startsWith("--print=") || arg.startsWith("-p=") || arg === "--mode" || arg.startsWith("--mode=")) {
					fallback = true;
					break;
				}
			}
		}
		if (fallback) {
			args.splice(promptIndex, 0, stdinPrompt);
			return { args, stdinPrompt: "" };
		}
	}

	// Pi's own print-message form: a sole -p/--print value (no other message
	// token, no --mode) moves to stdin too, keeping the flag for space form.
	if (args.length >= 1) {
		let printValue = "";
		let printTokens = 0;
		let printRemoveIndex = -1;
		let hasMode = false;
		for (let i = 0; i < args.length; i++) {
			const arg = args[i]!;
			if (arg === "--mode" || arg.startsWith("--mode=")) hasMode = true;
			else if (arg.startsWith("--print=") || arg.startsWith("-p=")) {
				printTokens += 1;
				if (printValue === "") {
					printValue = arg.slice(arg.indexOf("=") + 1);
					printRemoveIndex = i;
				}
			} else if (arg === "--print" || arg === "-p") {
				const next = i + 1 < args.length ? args[i + 1]! : undefined;
				if (next !== undefined && !next.startsWith("@") && (!next.startsWith("-") || next.startsWith("---"))) {
					printTokens += 1;
					if (printValue === "") {
						printValue = next;
						printRemoveIndex = i + 1;
					}
				}
			}
		}
		if (!hasMode && printTokens === 1 && printValue !== "" && printRemoveIndex >= 0) {
			const saved = [...args];
			args.splice(printRemoveIndex, 1);
			if (firstPositionalIndex(args) >= 0) {
				// Removing the print message would leave another message behind;
				// argv stays byte-identical to pre-stdin behavior.
				args.length = 0;
				args.push(...saved);
			} else {
				stdinPrompt = printValue;
			}
		}
	}
	return { args, stdinPrompt };
}

function childExitCode(code: number | null, signal: string | null): number {
	if (signal === "SIGINT") return 130;
	if (signal !== null) return 143;
	return code ?? 1;
}

function spawnDirectPi(args: readonly string[], stdinPrompt: string, reloadReadyFile: string): Promise<number> {
	if (!existsSync(PI_BIN)) {
		process.stderr.write(`[sumocode] Could not find Pi binary at ${PI_BIN}.\n`);
		process.exit(70);
	}
	const childEnv: NodeJS.ProcessEnv = { ...process.env, SUMOCODE_RELOAD_READY_FILE: reloadReadyFile };
	const child = spawn(PI_BIN, ["-e", EXTENSION_ENTRY, ...args], {
		stdio: stdinPrompt === "" ? "inherit" : ["pipe", "inherit", "inherit"],
		env: childEnv,
	});
	if (stdinPrompt !== "") {
		// Caller-piped stdin streams first (cat), then the prompt bytes —
		// Pi composes stdin + messages[0] with no separator.
		const childStdin = child.stdin;
		if (childStdin !== null) {
			// Keep the writable open after caller stdin reaches EOF so the prompt
			// can follow it, matching `{ cat; printf prompt; } | pi` exactly.
			process.stdin.once("end", () => {
				childStdin.end(stdinPrompt);
			});
			process.stdin.pipe(childStdin, { end: false });
		}
	}
	const forwarding = (signal: NodeJS.Signals): void => {
		try {
			child.kill(signal);
		} catch {
			// Child may have already exited.
		}
	};
	process.on("SIGINT", forwarding);
	process.on("SIGTERM", forwarding);
	return new Promise<number>((resolveCode) => {
		child.on("error", () => resolveCode(70));
		child.on("close", (code, signal) => {
			process.off("SIGINT", forwarding);
			process.off("SIGTERM", forwarding);
			resolveCode(childExitCode(code, signal));
		});
	});
}

// ── RPC-host branch: pre-adoption signal ownership (sumo-rpc-host.js port) ─

let preSpawnedChild: ChildProcessWithoutNullStreams | undefined;
let relayingEarlySignal = false;
let earlyCleanupPromise: Promise<void> = Promise.resolve();
const preSpawnErrorSymbol = Symbol.for("sumocode.rpc.preSpawnError");

function childHasExited(): boolean {
	return !preSpawnedChild || preSpawnedChild.exitCode !== null || preSpawnedChild.signalCode !== null;
}

function waitForPreSpawnedChildExit(timeoutMs: number): Promise<boolean> {
	if (childHasExited()) return Promise.resolve(true);
	return new Promise((resolveDone) => {
		let settled = false;
		const finish = (exited: boolean): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			preSpawnedChild?.removeListener("exit", onExit);
			resolveDone(exited);
		};
		const onExit = (): void => finish(true);
		const timer = setTimeout(() => finish(childHasExited()), timeoutMs);
		preSpawnedChild!.once("exit", onExit);
	});
}

async function terminateUnadoptedChild(): Promise<void> {
	if (childHasExited()) return;
	try {
		preSpawnedChild!.kill("SIGTERM");
	} catch {
		// The process may have exited between the state check and kill.
	}
	if (await waitForPreSpawnedChildExit(PRE_ADOPTION_KILL_GRACE_MS)) return;
	try {
		preSpawnedChild!.kill("SIGKILL");
	} catch {
		// SIGTERM may have landed at the grace boundary.
	}
	await waitForPreSpawnedChildExit(PRE_ADOPTION_KILL_GRACE_MS);
}

function restoreFailedReloadTerminal(): void {
	if (process.env.SUMOCODE_RELOAD !== "1" || process.stdout.isTTY !== true) return;
	try {
		process.stdin.setRawMode?.(false);
	} catch {}
	try {
		process.stdout.write(RELOAD_FALLBACK_TERMINAL_CLEANUP);
	} catch {}
	const readyFile = process.env.SUMOCODE_RELOAD_READY_FILE;
	if (readyFile) {
		try {
			writeFileSync(readyFile, "ready", { mode: 0o600 });
		} catch {}
	}
}

// ── debug/dry-run/runtime selection ────────────────────────────────────────

function applyDebugMode(parsed: ParsedLaunch): void {
	if (!parsed.debugMode) return;
	const diagPath = parsed.diagFile !== "" ? parsed.diagFile : "/tmp/sumocode-manual.jsonl";
	if (parsed.clearDiag && !parsed.dryRun) {
		try {
			rmSync(diagPath, { force: true });
		} catch {}
	}
	if (!parsed.dryRun) {
		try {
			// Pre-create owner-only; append keeps --no-clear-diag content intact.
			const fd = openSync(diagPath, "a", 0o600);
			closeSync(fd);
		} catch {}
	}
	process.env.SUMO_TUI_DIAG_FILE = diagPath;
	process.env.SUMO_TUI_DEBUG = process.env.SUMO_TUI_DEBUG ?? "1";
	if (!parsed.dryRun) {
		process.stderr.write(`[sumocode] Debug diagnostics enabled: ${diagPath}\n`);
	}
}

function resolveTaskLaunch(parsed: ParsedLaunch): void {
	if (parsed.command !== "task") {
		if (parsed.promptFile !== "") usageError("--prompt-file is only valid with the 'task' subcommand.");
		if (parsed.taskDir !== "") usageError("--task-dir is only valid with the 'task' subcommand.");
		return;
	}
	if (parsed.taskDir !== "") {
		let isDir = false;
		try {
			isDir = statSync(parsed.taskDir).isDirectory();
		} catch {
			isDir = false;
		}
		if (!isDir) usageError(`--task-dir path does not exist: ${parsed.taskDir}`);
		if (parsed.promptFile !== "") usageError("--task-dir cannot be combined with --prompt-file.");
		parsed.promptFile = join(parsed.taskDir, "prompt.txt");
		process.env.SUMOCODE_TASK_RESPONSE_FILE = join(parsed.taskDir, "response.md");
		process.env.SUMOCODE_TASK_EXIT_FILE = join(parsed.taskDir, "exit.code");
		process.env.SUMOCODE_TASK_STARTED_FILE = join(parsed.taskDir, "started.marker");
		process.env.SUMOCODE_TASK_DIAG_FILE = join(parsed.taskDir, "diag.jsonl");
		process.env.SUMOCODE_TASK_CONTROL_DIR = join(parsed.taskDir, "control");
	}
	if (parsed.promptFile !== "") {
		let contents = "";
		try {
			contents = readFileSync(parsed.promptFile, "utf8").replace(/\n$/, "");
		} catch {
			usageError(`--prompt-file path does not exist: ${parsed.promptFile}`);
		}
		// Place the file prompt where Pi parses it as the first task message:
		// after a preserved `--` delimiter when present, else appended.
		const delimiter = firstDelimiterIndex(parsed.forwardedArgs);
		if (delimiter >= 0) parsed.forwardedArgs.splice(delimiter + 1, 0, contents);
		else parsed.forwardedArgs.push(contents);
	}
	const promptIndex = firstPositionalIndex(parsed.forwardedArgs);
	if (promptIndex < 0 || parsed.forwardedArgs[promptIndex]!.trim() === "") {
		usageError(`task requires a non-empty prompt argument or --prompt-file <path>. Example: sumocode task "review the diff".`);
	}
	process.env.SUMOCODE_TASK_MODE = "1";
}

function validateCommandArgs(parsed: ParsedLaunch): void {
	if (parsed.command === "doctor" && parsed.forwardedArgs.length > 0) {
		usageError("doctor does not accept a path argument.");
	}
	if (parsed.command === "diag" && parsed.forwardedArgs.length > 1) {
		usageError("diag accepts at most one diagnostics file path.");
	}
}

function writeDryRun(parsed: ParsedLaunch, useRpcHost: boolean): never {
	let initialPrompt = "";
	if (useRpcHost) initialPrompt = extractFirstPositional(parsed.forwardedArgs);
	const transport = useRpcHost && initialPrompt !== "" ? "one-shot-file" : "(none)";
	const redacted = redactSensitiveArgs(parsed.forwardedArgs);
	const piArg = useRpcHost ? `--mode rpc -e` : `-e`;
	process.stdout.write(`sumocode dry run
PI_BIN=${PI_BIN}
ROOT_DIR=${NATIVE_DIR}
PROJECT_CWD=${process.cwd()}
SUMO_TUI=${process.env.SUMO_TUI ?? ""}
SUMO_RPC=${process.env.SUMO_RPC ?? ""}
SUMO_TUI_DIAG_FILE=${process.env.SUMO_TUI_DIAG_FILE ?? ""}
SUMO_TUI_DEBUG=${process.env.SUMO_TUI_DEBUG ?? ""}
COMMAND=${parsed.command}
ARGS=${redacted}
KICKOFF_PROMPT_TRANSPORT=${transport}
exec ${shellQuote(PI_BIN)} ${piArg} ${shellQuote(EXTENSION_ENTRY)}${redacted !== "" ? ` ${redacted}` : ""}
`);
	process.exit(0);
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

// ── reload respawn handoff ─────────────────────────────────────────────────

function stripOneShotMessages(forwarded: readonly string[]): string[] {
	const kept = [...forwarded];
	for (let i = 0; i < kept.length;) {
		const arg = kept[i]!;
		if (arg.startsWith("--print=") || arg.startsWith("-p=")) {
			kept.splice(i, 1);
			continue;
		}
		if (arg === "--print" || arg === "-p") {
			const value = kept[i + 1];
			const consumesValue = value !== undefined && !value.startsWith("@") && (!value.startsWith("-") || value.startsWith("---"));
			kept.splice(i, consumesValue ? 2 : 1);
			continue;
		}
		i += 1;
	}
	for (;;) {
		const index = firstPositionalIndex(kept);
		if (index < 0) return kept;
		kept.splice(index, 1);
	}
}

function reloadSuccessorArgs(forwarded: readonly string[]): string[] {
	// Strip one-shot pickers and messages, then resume the existing session.
	const kept = stripOneShotMessages(forwarded).filter((arg) => arg !== "--resume" && arg !== "-r");
	const haveContinue = kept.some((arg) => arg === "--continue" || arg === "-c" || arg === "--no-session");
	return haveContinue ? kept : ["--continue", ...kept];
}

// ── main launcher flow ─────────────────────────────────────────────────────

function enterProjectDirectory(args: string[]): void {
	const index = firstPositionalIndex(args);
	if (index < 0) return;
	const candidate = resolve(process.cwd(), args[index]!);
	try {
		if (!statSync(candidate).isDirectory()) return;
		const projectCwd = realpathSync(candidate);
		process.chdir(projectCwd);
		args.splice(index, 1);
		process.env.SUMOCODE_PROJECT_CWD = projectCwd;
	} catch {
		// A non-directory positional remains a Pi prompt.
	}
}

async function launcherFlow(): Promise<void> {
	const parsed = parseLauncherArgv(process.argv.slice(2));

	// The native archive has no repo checkout to open a worktree from.
	if (parsed.command === "worktree") {
		process.stderr.write("[sumocode] the worktree command requires a source checkout (bin/sumocode.sh).\n");
		process.exit(64);
	}

	validateCommandArgs(parsed);
	resolveTaskLaunch(parsed);
	applyDebugMode(parsed);

	if (parsed.command === "doctor") runDoctor(parsed);
	if (parsed.command === "diag") await runDiag(parsed.forwardedArgs[0] ?? "/tmp/sumocode-manual.jsonl");
	if (parsed.command === "run") enterProjectDirectory(parsed.forwardedArgs);

	const useRpcHost = !parsed.forceDirectPi
		&& process.stdout.isTTY === true
		&& !argsRequestNoninteractivePi(parsed.forwardedArgs);

	if (useRpcHost) {
		process.env.SUMO_RPC = "1";
		process.env.SUMO_TUI = "0";
	} else {
		delete process.env.SUMO_RPC;
		process.env.SUMO_TUI = "0";
	}

	if (parsed.dryRun) writeDryRun(parsed, useRpcHost);

	if (useRpcHost) await runRpcBranch(parsed);
	else await runDirectPiBranch(parsed);
}

function freshExitCodeFile(): string {
	return makePrivateTempFile("sumocode-exit-code");
}

async function runRpcBranch(parsed: ParsedLaunch): Promise<void> {
	for (;;) {
		const code = await runRpcBranchOnce(parsed);
		if (code !== RELOAD_EXIT_CODE) {
			process.exitCode = code;
			return;
		}
		parsed.forwardedArgs = reloadSuccessorArgs(parsed.forwardedArgs);
		delete process.env.SUMOCODE_TASK_MODE;
		process.env.SUMOCODE_RELOAD = "1";
	}
}

async function runRpcBranchOnce(parsed: ParsedLaunch): Promise<number> {
	preSpawnedChild = undefined;
	relayingEarlySignal = false;
	earlyCleanupPromise = Promise.resolve();
	// Extract the kickoff prompt ONCE; a reload must never re-submit it.
	const rpcInitialPrompt = extractFirstPositional(parsed.forwardedArgs);

	let kickoffPromptFile = "";
	if (rpcInitialPrompt !== "") {
		kickoffPromptFile = makePrivateTempFile("sumocode-kickoff");
		writeFileSync(kickoffPromptFile, rpcInitialPrompt, { mode: 0o600 });
	}
	const cleanupKickoffFile = (): void => {
		if (kickoffPromptFile === "") return;
		try {
			rmSync(kickoffPromptFile, { force: true });
		} catch {}
		kickoffPromptFile = "";
	};
	process.on("exit", cleanupKickoffFile);

	const handleEarlySigint = (): void => void relayEarlySignal("SIGINT");
	const handleEarlySigterm = (): void => void relayEarlySignal("SIGTERM");

	async function relayEarlySignal(signal: NodeJS.Signals): Promise<void> {
		if (relayingEarlySignal) return;
		relayingEarlySignal = true;
		earlyCleanupPromise = (async () => {
			await terminateUnadoptedChild();
			releasePreAdoptionSignalHandlers();
			restoreFailedReloadTerminal();
			// Match the steady-state host contract: SIGTERM is a graceful exit,
			// SIGINT is 130. Record the side channel before exiting so the
			// (historical bash) consumer never substitutes a timing-dependent 143.
			const exitCode = signal === "SIGTERM" ? 0 : 130;
			const exitCodePath = process.env.SUMOCODE_EXIT_CODE_FILE;
			if (exitCodePath) {
				try {
					writeFileSync(exitCodePath, String(exitCode));
				} catch {}
			}
			process.exit(exitCode);
		})();
		await earlyCleanupPromise;
	}

	function releasePreAdoptionSignalHandlers(): void {
		process.removeListener("SIGINT", handleEarlySigint);
		process.removeListener("SIGTERM", handleEarlySigterm);
	}

	process.env.SUMOCODE_PROJECT_CWD = process.env.SUMOCODE_PROJECT_CWD ?? process.cwd();
	process.env.SUMOCODE_INITIAL_PROMPT_FILE = kickoffPromptFile;
	process.env.SUMOCODE_RELOAD = process.env.SUMOCODE_RELOAD === "1" ? "1" : "0";
	process.env.SUMOCODE_RELOAD_READY_FILE = process.env.SUMOCODE_RELOAD === "1" ? makePrivateTempFile("sumocode-reload-ready") : "";
	process.env.PI_BIN = PI_BIN;
	process.env.SUMOCODE_EXIT_CODE_FILE = freshExitCodeFile();
	process.env.SUMOCODE_TERMINAL_INDEX_GATE = makePrivateTempFile("sumocode-terminal-index");
	rmSync(process.env.SUMOCODE_TERMINAL_INDEX_GATE, { force: true });

	// Pre-spawn the Pi child before importing the host; own early signals from
	// before the spawn so the child cannot publish its PID while default signal
	// disposition would kill us mid-import.
	if (process.stdout.isTTY === true) {
		const plan = buildChildSpawnPlan({ ...process.env }, parsed.forwardedArgs, PI_BIN);
		if (plan) {
			process.on("SIGINT", handleEarlySigint);
			process.on("SIGTERM", handleEarlySigterm);
			try {
				writeStartupMark("child_spawn_start", { mode: "native" });
				preSpawnedChild = spawn(plan.command, [...plan.args], {
					cwd: plan.cwd,
					env: plan.env,
					stdio: ["pipe", "pipe", "pipe"],
				});
				writeStartupMark("child_spawned", { mode: "native" });
				preSpawnedChild.once("error", (error) => {
					if (preSpawnedChild !== undefined) Reflect.set(preSpawnedChild, preSpawnErrorSymbol, error);
				});
			} catch {
				preSpawnedChild = undefined;
				releasePreAdoptionSignalHandlers();
			}
		}
	}

	// Integration-only seam pinning the ownership phase; inert outside tests.
	const preAdoptionDelayMs = process.env.NODE_ENV === "test"
		? Number.parseInt(process.env.SUMOCODE_TEST_PRE_ADOPTION_DELAY_MS ?? "0", 10)
		: 0;
	if (Number.isFinite(preAdoptionDelayMs) && preAdoptionDelayMs > 0) {
		await new Promise((resolveDelay) => setTimeout(resolveDelay, preAdoptionDelayMs));
	}

	writeStartupMark("host_import_ready", { mode: "native" });
	const host = await import("../sumo-tui/rpc/host.js");

	// An early signal may have begun reaping the child during import; never
	// adopt or enter the retained runtime once cleanup started.
	if (relayingEarlySignal) {
		await earlyCleanupPromise;
		return 0;
	}

	const preMainDelayMs = process.env.NODE_ENV === "test"
		? Number.parseInt(process.env.SUMOCODE_TEST_PRE_MAIN_DELAY_MS ?? "0", 10)
		: 0;
	if (Number.isFinite(preMainDelayMs) && preMainDelayMs > 0) {
		await new Promise((resolveDelay) => setTimeout(resolveDelay, preMainDelayMs));
	}

	let code: number;
	try {
		code = await host.runRpcHost({
			argv: parsed.forwardedArgs,
			exit: () => undefined,
			preSpawnedChild,
			onPreSpawnedChildAdopted: () => {
				releasePreAdoptionSignalHandlers();
			},
			shouldAbortAdoption: () => relayingEarlySignal,
			env: process.env,
		});
	} catch (error) {
		// The host can reject before adoption; the entry still owns the child.
		await terminateUnadoptedChild();
		if (!relayingEarlySignal) restoreFailedReloadTerminal();
		cleanupKickoffFile();
		process.removeListener("exit", cleanupKickoffFile);
		throw error;
	}

	try {
		writeFileSync(process.env.SUMOCODE_EXIT_CODE_FILE ?? "", String(code), { mode: 0o600 });
	} catch {}
	cleanupKickoffFile();
	process.removeListener("exit", cleanupKickoffFile);
	return code;
}

async function runDirectPiBranch(parsed: ParsedLaunch): Promise<void> {
	for (;;) {
		const isReload = process.env.SUMOCODE_RELOAD === "1";
		const readyFile = isReload ? makePrivateTempFile("sumocode-reload-ready") : "";
		const { args, stdinPrompt } = resolveDirectPiStdinPrompt([...parsed.forwardedArgs]);
		process.env.SUMOCODE_RELOAD_READY_FILE = readyFile;
		process.env.PI_BIN = PI_BIN;
		const code = await spawnDirectPi(args, stdinPrompt, readyFile);
		if (code !== RELOAD_EXIT_CODE) {
			process.exitCode = code;
			return;
		}
		// Reload: the first launch consumed its prompt; retain only flags.
		parsed.forwardedArgs = reloadSuccessorArgs(args);
		delete process.env.SUMOCODE_TASK_MODE;
		process.env.SUMOCODE_RELOAD = "1";
	}
}

// ── entry ──────────────────────────────────────────────────────────────────

if (await runTerminalRunnerRole()) {
	// The runner keeps the process alive via its spawned shell; its exit code
	// is already set on process.exitCode. Nothing else may run.
} else {
	await launcherFlow();
}
