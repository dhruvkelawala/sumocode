import type { PaneRef } from "../terminal-host/index.js";

export type BackgroundTaskStatus = "running" | "completed" | "failed" | "stopped";
export type SplitDirection = "right" | "down";

/** New background terminal spawns are shell-only. */
export type BackgroundTaskRunner = "shell";
/** Legacy agent metadata remains readable during recovery. */
export type PersistedBackgroundTaskRunner = BackgroundTaskRunner | "sumocode";

export interface BackgroundTaskCmuxRefs {
	workspaceRef: string;
	surfaceRef: string;
}

export interface BackgroundTaskWorktreeRef {
	path: string;
	branch: string;
	baseRef: string;
	repoRoot: string;
}

export type BackgroundTaskThinking = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface BackgroundTask {
	id: string;
	pid?: number;
	command: string;
	cwd: string;
	title?: string;
	status: BackgroundTaskStatus;
	startedAt: number;
	updatedAt: number;
	exitCode?: number | null;
	logFile: string;
	exitFile?: string;
	metaFile?: string;
	markerFile?: string;
	promptFile?: string;
	responseFile?: string;
	diagFile?: string;
	processStartTime?: string;
	visible: boolean;
	runner: PersistedBackgroundTaskRunner;
	model?: string;
	thinking?: BackgroundTaskThinking;
	pane?: PaneRef;
	worktree?: BackgroundTaskWorktreeRef;
	/**
	 * "typed" marks tasks whose completion is delivered as a typed
	 * terminal-result message (bg_start). Persisted in meta.json so ownership
	 * survives reload/rebind recovery and failed kills — a process-local set
	 * would drop both (PR #334 review).
	 */
	resultDelivery?: "typed";
}

export interface SpawnBackgroundTaskOptions {
	command: string;
	cwd: string;
	title?: string;
	visible?: boolean;
	direction?: SplitDirection;
	runner?: BackgroundTaskRunner;
	resultDelivery?: "typed";
}

export const BACKGROUND_TASK_META_SCHEMA_VERSION = 3;

export interface BackgroundTaskSnapshot {
	schemaVersion: number;
	id: string;
	pid?: number;
	command: string;
	cwd: string;
	title?: string;
	status: BackgroundTaskStatus;
	startedAt: number;
	updatedAt: number;
	exitCode?: number | null;
	logFile: string;
	exitFile?: string;
	metaFile?: string;
	markerFile?: string;
	promptFile?: string;
	responseFile?: string;
	diagFile?: string;
	processStartTime?: string;
	visible: boolean;
	runner: PersistedBackgroundTaskRunner;
	model?: string;
	thinking?: BackgroundTaskThinking;
	pane?: PaneRef;
	/** Legacy v2 field, accepted during recovery only. */
	cmux?: BackgroundTaskCmuxRefs;
	worktree?: BackgroundTaskWorktreeRef;
	resultDelivery?: "typed";
}

export function toBackgroundTaskSnapshot(task: BackgroundTask): BackgroundTaskSnapshot {
	return {
		schemaVersion: BACKGROUND_TASK_META_SCHEMA_VERSION,
		id: task.id,
		pid: task.pid,
		command: task.command,
		cwd: task.cwd,
		title: task.title,
		status: task.status,
		startedAt: task.startedAt,
		updatedAt: task.updatedAt,
		exitCode: task.exitCode,
		logFile: task.logFile,
		exitFile: task.exitFile,
		metaFile: task.metaFile,
		markerFile: task.markerFile,
		promptFile: task.promptFile,
		responseFile: task.responseFile,
		diagFile: task.diagFile,
		processStartTime: task.processStartTime,
		visible: task.visible,
		runner: task.runner,
		model: task.model,
		thinking: task.thinking,
		pane: task.pane,
		worktree: task.worktree,
		resultDelivery: task.resultDelivery,
	};
}

const WAKE_MESSAGE_PATTERN = /^background task bg-[\w-]+ \w[\w-]*: /;

/** True for legacy prose wake messages retained in old session transcripts. */
export function isBackgroundTaskWakeMessage(text: string): boolean {
	return WAKE_MESSAGE_PATTERN.test(text);
}
