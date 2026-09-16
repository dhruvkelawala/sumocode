/**
 * Shell wrapper commands for visible terminal-host background tasks.
 *
 * Pi cannot pipe stdout and show live terminal output simultaneously. Visible
 * tasks run inside the host via a wrapper script; Pi tracks log + exit files.
 */

import { dirname, join } from "node:path";
import { mcpLaunchArgs } from "../subagents/backend-pi.js";
import type { McpLaunchCapability } from "../subagents/mcp-capability.js";

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
	piBin?: string;
	model?: string;
	thinking?: string;
	tools?: readonly string[];
	/** Resolved MCP grant; adds the adapter, its startup guard, and its scoped config. */
	mcp?: McpLaunchCapability;
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
	// A visible child runs a full SumoCode launcher session, so unlike the
	// headless path it already has extension discovery. The grant is therefore
	// carried the same way the operator would carry it by hand: load the
	// adapter explicitly and point it at the scoped config, which bounds the
	// gateway to the selected servers.
	// The pane inherits the operator's shell environment, so the grant's scope has
	// to be defended here too (see mcpChildEnv for why that flag matters).
	const mcpFlags = options.mcp ? mcpLaunchArgs(options.mcp) : [];
	return ["task", ...modelFlags, ...thinkingFlags, ...toolsFlags, ...mcpFlags, "--task-dir", dirname(options.paths.promptFile)];
}

/**
 * `env` wrapper for the agent command. `exec env -u …` is needed for a scoped
 * MCP grant, because the pane inherits the operator's shell environment and
 * `PI_MCP_CONFIG_MODE=exclusive` would void the grant's scope. The ambient
 * grant keeps the operator's environment untouched so it resolves the same
 * chain the parent session does.
 */
function envPrefix(piBin: string | undefined, scopedMcp: boolean, requiredMcp: boolean): string[] {
	const flags = [
		...(scopedMcp ? ["-u", "PI_MCP_CONFIG_MODE"] : []),
		...(requiredMcp ? ["SUMOCODE_MCP_REQUIRED=1"] : []),
	];
	if (!piBin) return flags.length > 0 ? ["env", ...flags] : [];
	return ["env", ...flags, shellEscape(`PI_BIN=${piBin}`)];
}

export function buildVisibleAgentCommand(options: VisibleAgentCommandOptions): string {
	const launcher = options.launcher?.trim();
	const piBin = options.piBin?.trim();
	return [
		"cd",
		shellEscape(options.cwd),
		"&&",
		"exec",
		...envPrefix(piBin, options.mcp?.configPath !== undefined, options.mcp?.required === true),
		launcher && launcher !== "sumocode" ? shellEscape(launcher) : "sumocode",
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
