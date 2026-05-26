/**
 * Shell wrapper commands for visible cmux background tasks.
 *
 * Pi cannot pipe stdout and show live terminal output simultaneously. Visible
 * tasks run inside cmux via respawn-pane; Pi tracks via log + exit marker files.
 */

import { dirname, join } from "node:path";

export type VisibleTaskRunner = "shell" | "pi" | "sumocode";

export interface VisibleTaskPaths {
	logFile: string;
	exitFile: string;
	markerFile: string;
	scriptFile: string;
	metaFile: string;
	promptFile: string;
}

export interface VisibleTaskCommandOptions {
	cwd: string;
	command: string;
	paths: VisibleTaskPaths;
	taskId: string;
	runner?: VisibleTaskRunner;
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
	const header = [
		`#!/usr/bin/env bash`,
		`mkdir -p ${shellEscape(dir)}`,
		`touch ${shellEscape(markerFile)}`,
		`cd ${shellEscape(cwd)}`,
	];

	return [
		...header,
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
 * Build the launch command for a visible pi/sumocode agent pane.
 *
 * For the sumocode runner, the prompt is passed via `--prompt-file <abs path>`
 * so the cmux respawn-pane command stays short and fixed-length regardless
 * of prompt size. Without this, a long prompt would briefly echo as a wall
 * of text in the pane before Pi takes over the screen. The wrapper reads
 * the file, sets `SUMOCODE_TASK_MODE=1` (so the extension skips splash),
 * and forwards the contents as Pi's kickoff `[messages...]` positional.
 *
 * For the pi runner, we keep the inline positional. Pi has no `--prompt-file`
 * flag of its own, and adding a bash wrapper just to read the file would
 * obscure the command in another layer. Pi-runner consumers should keep
 * their prompts compact.
 */
export function buildVisibleAgentCommand(options: Pick<VisibleTaskCommandOptions, "cwd" | "command" | "runner" | "paths">): string {
	const runner = options.runner ?? "shell";
	if (runner !== "pi" && runner !== "sumocode") {
		throw new Error("visible agent commands require runner=pi or runner=sumocode");
	}

	if (runner === "sumocode") {
		return [
			"cd",
			shellEscape(options.cwd),
			"&&",
			"exec",
			"sumocode",
			"task",
			"--prompt-file",
			shellEscape(options.paths.promptFile),
		].join(" ");
	}

	return ["cd", shellEscape(options.cwd), "&&", "exec", "pi", shellEscape(options.command)].join(" ");
}

/**
 * Returns a command suitable for cmux respawn-pane --command.
 * Shell tasks use a short run.sh wrapper for logging/exit tracking. Agent
 * tasks launch the native pi/sumocode command directly so the pane is readable.
 */
export function buildVisibleTaskCommand(options: VisibleTaskCommandOptions): string {
	const runner = options.runner ?? "shell";
	if (runner === "pi" || runner === "sumocode") {
		return buildVisibleAgentCommand(options);
	}
	return ["exec", "bash", shellEscape(options.paths.scriptFile)].join(" ");
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
