/**
 * Shell wrapper commands for visible cmux background tasks.
 *
 * Pi cannot pipe stdout and show live terminal output simultaneously. Visible
 * tasks run inside cmux via respawn-pane; Pi tracks via log + exit marker files.
 */

import { dirname, join } from "node:path";

export type VisibleTaskRunner = "shell" | "sumocode";

export interface VisibleTaskPaths {
	logFile: string;
	exitFile: string;
	markerFile: string;
	scriptFile: string;
	metaFile: string;
	promptFile: string;
	responseFile: string;
	diagFile: string;
}

export interface VisibleTaskCommandOptions {
	cwd: string;
	command: string;
	paths: VisibleTaskPaths;
	taskId: string;
	runner?: VisibleTaskRunner;
	model?: string;
	thinking?: string;
}

export function buildVisibleTaskPaths(taskId: string, startedAtMs: number, baseDir?: string): VisibleTaskPaths {
	const root = baseDir ?? join(process.env.TMPDIR ?? "/tmp", "sumocode-bg");
	const dir = join(root, `${taskId}-${startedAtMs}`);
	return {
		logFile: join(dir, "output.log"),
		exitFile: join(dir, "exit.code"),
		markerFile: join(dir, "started.marker"),
		scriptFile: join(dir, "run.sh"),
		metaFile: join(dir, "meta.json"),
		promptFile: join(dir, "prompt.txt"),
		responseFile: join(dir, "response.md"),
		diagFile: join(dir, "diag.jsonl"),
	};
}

export function shellEscape(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}



export function buildVisibleTaskScript(options: VisibleTaskCommandOptions): string {
	const { cwd, command, paths, taskId, runner = "shell" } = options;
	if (runner !== "shell") {
		throw new Error("visible pi/sumocode tasks launch directly and do not use run.sh");
	}

	const { logFile, exitFile, markerFile } = paths;
	const dir = dirname(logFile);

	return [
		`#!/usr/bin/env bash`,
		`mkdir -p ${shellEscape(dir)}`,
		`touch ${shellEscape(markerFile)}`,
		// Fail fast if cwd is missing/unreadable. Without this guard, `cd`
		// failure is silent and the task ends up running from $HOME, potentially
		// writing to the wrong project while still reporting a clean lifecycle.
		//
		// Both `cd <cwd>` and the diagnostic `echo` shell-escape `cwd` so that
		// a cwd containing `"` or `$(...)` cannot trigger command substitution
		// when the wrapper script runs.
		`cd ${shellEscape(cwd)} || { echo ${shellEscape(`[sumocode-bg] task=${taskId} cwd-missing: ${cwd}`)} | tee -a ${shellEscape(logFile)}; printf '%s' 1 > ${shellEscape(exitFile)}; exit 1; }`,
		`set -o pipefail`,
		// Forward fork-bomb guard into the child command — if it invokes pi or
		// sumocode, that nested process bails on the helper-subprocess check.
		`export SUMOCODE_BG_CHILD=1`,
		`echo "[sumocode-bg] task=${taskId} started" | tee -a ${shellEscape(logFile)}`,
		`(`,
		`  ${command}`,
		`) 2>&1 | tee -a ${shellEscape(logFile)}`,
		`code=$?`,
		`printf '%s' "$code" > ${shellEscape(exitFile)}`,
		`echo "[sumocode-bg] task=${taskId} exit:$code" | tee -a ${shellEscape(logFile)}`,
		`exit "$code"`,
	].join("\n");
}

/**
 * Build the launch command for a visible sumocode agent pane.
 *
 * Three pieces are stitched together as a single bash one-liner that cmux
 * runs via `respawn-pane --command <cmd>`:
 *
 *   1. Env-var prefix — `SUMOCODE_TASK_RESPONSE_FILE` (where the child writes
 *      its latest assistant message), `SUMOCODE_TASK_EXIT_FILE` (real process
 *      exit marker), and `SUMOCODE_TASK_DIAG_FILE` (lifecycle diagnostics).
 *      `SUMOCODE_TASK_MODE=1` is set by the wrapper itself via the `task`
 *      subcommand. The orchestrator reads response.md to harvest the delegated
 *      work's output only after the exit marker appears.
 *   2. `cd '<cwd>'` so the child opens in the right project.
 *   3. `exec sumocode task --model X --thinking Y --prompt-file '<path>'`.
 *      `exec` ensures the wrapper shell is replaced by the sumocode process;
 *      when the child exits the cmux pane closes. If the tool caller omits
 *      model/thinking, BackgroundTaskManager resolves defaults first:
 *      `openai-codex/gpt-5.5` with `low` thinking, configurable via
 *      `SUMOCODE_BG_AGENT_MODEL` and `SUMOCODE_BG_AGENT_THINKING`.
 *
 * The returned string is a shell command line, NOT directly spawnable: cmux
 * respawn-pane does not run commands through a shell, so
 * buildVisibleTaskCommand wraps this in `bash -c '<...>'` before handing it
 * to cmux.
 *
 * The prompt is passed via `--prompt-file <abs path>` so the cmux respawn
 * command stays short and fixed-length regardless of prompt size. Without
 * this, a long prompt would briefly echo as a wall of text in the pane
 * before Pi takes over the screen.
 *
 * We intentionally do NOT support a bare `pi` runner: it would require
 * duplicate prompt-passing code (no --prompt-file flag), would need to
 * bypass shouldNoopDuplicateInstalledExtension's launcher dedup so the
 * auto-discovered SumoCode would install in the child, and provides no
 * unique value over the sumocode runner since every bg_task user is
 * running SumoCode anyway.
 */
export function buildVisibleAgentCommand(
	options: Pick<VisibleTaskCommandOptions, "cwd" | "runner" | "paths" | "model" | "thinking"> & {
		/**
		 * Pi tool allowlist forwarded as --tools (or --no-tools when empty).
		 * NOTE: pi's --tools restricts built-in AND extension tools alike, so
		 * callers must only pass this when the parent session is itself
		 * narrowed — a full-toolset child should receive undefined (no flag).
		 * Undefined preserves the legacy bg_task behavior (no restriction).
		 */
		tools?: readonly string[];
	},
): string {
	const runner = options.runner ?? "shell";
	if (runner !== "sumocode") {
		throw new Error("visible agent commands require runner=sumocode");
	}

	const envPrefix: string[] = [
		`SUMOCODE_TASK_RESPONSE_FILE=${shellEscape(options.paths.responseFile)}`,
		`SUMOCODE_TASK_EXIT_FILE=${shellEscape(options.paths.exitFile)}`,
		`SUMOCODE_TASK_STARTED_FILE=${shellEscape(options.paths.markerFile)}`,
		`SUMOCODE_TASK_DIAG_FILE=${shellEscape(options.paths.diagFile)}`,
	];

	const modelFlags: string[] = options.model ? ["--model", shellEscape(options.model)] : [];
	const thinkingFlags: string[] = options.thinking ? ["--thinking", shellEscape(options.thinking)] : [];
	const toolsFlags: string[] = options.tools === undefined
		? []
		: options.tools.length === 0
			? ["--no-tools"]
			: ["--tools", shellEscape(options.tools.join(","))];

	return [
		"cd",
		shellEscape(options.cwd),
		"&&",
		...envPrefix,
		"exec",
		"sumocode",
		"task",
		...modelFlags,
		...thinkingFlags,
		...toolsFlags,
		"--prompt-file",
		shellEscape(options.paths.promptFile),
	].join(" ");
}

/**
 * Returns a command suitable for cmux respawn-pane --command.
 * Shell tasks use a short run.sh wrapper for logging/exit tracking. Agent
 * tasks launch sumocode directly so the pane is readable.
 *
 * IMPORTANT: cmux `respawn-pane --command` does NOT interpret the command
 * through a shell. It tokenizes the string (respecting quotes) and spawns
 * argv[0] directly, so shell builtins (`cd`, `exec`), `&&` chains, and
 * `VAR=x` env prefixes silently fail and the surface closes before anything
 * runs. Every command returned here must therefore start with a real binary:
 * shell tasks spawn `bash -l <run.sh>` and agent tasks wrap their compound
 * launch line in `bash -lc '<...>'`.
 *
 * `-l` (login shell) matters too: cmux spawns panes with a minimal PATH that
 * lacks /opt/homebrew/bin and friends, so a plain `bash -c` cannot find
 * `sumocode`, `node`, `pnpm`, etc. (exit 127). A login shell sources the
 * user's profile and restores their real PATH.
 */
export function buildVisibleTaskCommand(options: VisibleTaskCommandOptions): string {
	const runner = options.runner ?? "shell";
	if (runner === "sumocode") {
		return ["bash", "-lc", shellEscape(buildVisibleAgentCommand(options))].join(" ");
	}
	return ["bash", "-l", shellEscape(options.paths.scriptFile)].join(" ");
}

export function readExitCodeFromFile(contents: string): number | null {
	const trimmed = contents.trim();
	if (!/^\d+$/.test(trimmed)) {
		return null;
	}
	return Number.parseInt(trimmed, 10);
}

export function parseExitMarkerLine(line: string): { taskId: string; exitCode: number } | null {
	const match = line.match(/^\[sumocode-bg\] task=([^\s]+) exit:(\d+)$/);
	if (!match) {
		return null;
	}
	return { taskId: match[1], exitCode: Number.parseInt(match[2], 10) };
}
