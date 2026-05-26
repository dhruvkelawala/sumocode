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
	};
}

export function shellEscape(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function buildPromptArg(command: string): string {
	const trimmed = command.trim();
	return trimmed ? ` ${shellEscape(trimmed)}` : "";
}

export function buildVisibleTaskScript(options: VisibleTaskCommandOptions): string {
	const { cwd, command, paths, taskId, runner = "shell" } = options;
	const { logFile, exitFile, markerFile } = paths;
	const dir = dirname(logFile);

	const header = [
		`#!/usr/bin/env bash`,
		`mkdir -p ${shellEscape(dir)}`,
		`touch ${shellEscape(markerFile)}`,
		`cd ${shellEscape(cwd)}`,
	];

	if (runner === "pi" || runner === "sumocode") {
		const binary = runner === "sumocode" ? "sumocode" : "pi";
		return [
			...header,
			`printf '[sumocode-bg] task=%s started runner=${runner}\\n' ${shellEscape(taskId)} >> ${shellEscape(logFile)}`,
			`${binary}${buildPromptArg(command)}`,
			`code=$?`,
			`printf '%s' "$code" > ${shellEscape(exitFile)}`,
			`printf '[sumocode-bg] task=%s exit:%s\\n' ${shellEscape(taskId)} "$code" >> ${shellEscape(logFile)}`,
			`exit "$code"`,
		].join("\n");
	}

	return [
		...header,
		`set -o pipefail`,
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
 * Returns a short command suitable for cmux respawn-pane --command.
 * The actual wrapper lives in scriptFile so the cmux pane does not show a huge
 * quoted shell payload before useful output.
 */
export function buildVisibleTaskCommand(options: VisibleTaskCommandOptions): string {
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
