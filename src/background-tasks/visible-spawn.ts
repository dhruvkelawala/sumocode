/**
 * Shell wrapper commands for visible terminal-host background tasks.
 *
 * Pi cannot pipe stdout and show live terminal output simultaneously. Visible
 * tasks run inside the host via a wrapper script; Pi tracks log + exit files.
 */

import { dirname, join } from "node:path";

export interface VisibleTaskPaths {
	/** The task directory itself; artifact confinement is relative to it. */
	dir: string;
	logFile: string;
	exitFile: string;
	markerFile: string;
	scriptFile: string;
	metaFile: string;
	promptFile: string;
	responseFile: string;
	diagFile: string;
	controlDir: string;
}

interface VisibleTaskCommandOptions {
	cwd: string;
	command: string;
	paths: VisibleTaskPaths;
	taskId: string;
}

interface VisibleAgentCommandOptions {
	cwd: string;
	paths: VisibleTaskPaths;
	launcher?: string;
	model?: string;
	thinking?: string;
	tools?: readonly string[];
}

export function visibleTaskPathsInDir(dir: string): VisibleTaskPaths {
	return {
		dir,
		logFile: join(dir, "output.log"),
		exitFile: join(dir, "exit.code"),
		markerFile: join(dir, "started.marker"),
		scriptFile: join(dir, "run.sh"),
		metaFile: join(dir, "meta.json"),
		promptFile: join(dir, "prompt.txt"),
		responseFile: join(dir, "response.md"),
		diagFile: join(dir, "diag.jsonl"),
		controlDir: join(dir, "control"),
	};
}

export function buildVisibleTaskPaths(taskId: string, startedAtMs: number, baseDir?: string): VisibleTaskPaths {
	const root = baseDir ?? join(process.env.TMPDIR ?? "/tmp", "sumocode-bg");
	return visibleTaskPathsInDir(join(root, `${taskId}-${startedAtMs}`));
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
function buildVisibleAgentArgs(options: VisibleAgentCommandOptions): string[] {
	const modelFlags = options.model ? ["--model", options.model] : [];
	const thinkingFlags = options.thinking ? ["--thinking", options.thinking] : [];
	const toolsFlags = options.tools === undefined
		? []
		: options.tools.length === 0
			? ["--no-tools"]
			: ["--tools", options.tools.join(",")];
	return ["task", ...modelFlags, ...thinkingFlags, ...toolsFlags, "--task-dir", dirname(options.paths.promptFile)];
}

export function buildVisibleAgentCommand(options: VisibleAgentCommandOptions): string {
	return [
		"cd",
		shellEscape(options.cwd),
		"&&",
		"exec",
		options.launcher && options.launcher !== "sumocode" ? shellEscape(options.launcher) : "sumocode",
		...buildVisibleAgentArgs(options).map(shellEscape),
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
