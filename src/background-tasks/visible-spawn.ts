/**
 * Shell wrapper commands for visible terminal-host background tasks.
 *
 * Pi cannot pipe stdout and show live terminal output simultaneously. Visible
 * tasks run inside the host via a wrapper script; Pi tracks log + exit files.
 */

import { dirname, join } from "node:path";

interface VisibleTaskPaths {
	logFile: string;
	exitFile: string;
	markerFile: string;
	scriptFile: string;
	metaFile: string;
	promptFile: string;
	responseFile: string;
	diagFile: string;
}

interface VisibleTaskCommandOptions {
	cwd: string;
	command: string;
	paths: VisibleTaskPaths;
	taskId: string;
}

interface VisibleAgentCommandOptions {
	cwd: string;
	runner?: "sumocode";
	paths: VisibleTaskPaths;
	model?: string;
	thinking?: string;
	tools?: readonly string[];
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
	const { cwd, command, paths, taskId } = options;
	const { logFile, exitFile, markerFile } = paths;
	const dir = dirname(logFile);

	return [
		`#!/usr/bin/env bash`,
		`mkdir -p ${shellEscape(dir)}`,
		`touch ${shellEscape(markerFile)}`,
		// Fail fast if cwd is missing/unreadable. Both the cd operand and the
		// diagnostic are shell-escaped so command substitutions remain literal.
		`cd ${shellEscape(cwd)} || { echo ${shellEscape(`[sumocode-bg] task=${taskId} cwd-missing: ${cwd}`)} | tee -a ${shellEscape(logFile)}; printf '%s' 1 > ${shellEscape(exitFile)}; exit 1; }`,
		`set -o pipefail`,
		// A nested Pi/SumoCode invocation must not recursively install another UI.
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
 * Shared launch command for the retained SubagentManager's visible backend.
 * BackgroundTaskManager no longer calls this path.
 */
export function buildVisibleAgentCommand(options: VisibleAgentCommandOptions): string {
	const envPrefix = [
		`SUMOCODE_TASK_RESPONSE_FILE=${shellEscape(options.paths.responseFile)}`,
		`SUMOCODE_TASK_EXIT_FILE=${shellEscape(options.paths.exitFile)}`,
		`SUMOCODE_TASK_STARTED_FILE=${shellEscape(options.paths.markerFile)}`,
		`SUMOCODE_TASK_DIAG_FILE=${shellEscape(options.paths.diagFile)}`,
	];
	const modelFlags = options.model ? ["--model", shellEscape(options.model)] : [];
	const thinkingFlags = options.thinking ? ["--thinking", shellEscape(options.thinking)] : [];
	const toolsFlags = options.tools === undefined
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
 * Returns a real-binary command suitable for terminal-host pane spawning.
 * A login shell restores the user's PATH before running the wrapper script.
 */
export function buildVisibleTaskCommand(options: VisibleTaskCommandOptions): string {
	return ["bash", "-l", shellEscape(options.paths.scriptFile)].join(" ");
}

export function readExitCodeFromFile(contents: string): number | null {
	const trimmed = contents.trim();
	if (!/^\d+$/.test(trimmed)) return null;
	return Number.parseInt(trimmed, 10);
}

export function parseExitMarkerLine(line: string): { taskId: string; exitCode: number } | null {
	const match = line.match(/^\[sumocode-bg\] task=([^\s]+) exit:(\d+)$/);
	if (!match) return null;
	return { taskId: match[1], exitCode: Number.parseInt(match[2], 10) };
}
