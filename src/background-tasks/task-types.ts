export type BackgroundTaskStatus = "running" | "completed" | "failed" | "stopped";

export type SplitDirection = "right" | "down";
/**
 * - `shell`: managed bash command, output captured to log file.
 * - `sumocode`: handed-off agent pane via the `sumocode task` wrapper.
 *
 * A bare `pi` runner was considered and rejected: it would need a duplicate
 * code path for prompt passing (no `--prompt-file` flag), would require
 * bypassing `shouldNoopDuplicateInstalledExtension`'s launcher dedup, and
 * provides no unique value over the `sumocode` runner since every
 * orchestrator that uses `bg_task` is already running SumoCode.
 */
export type BackgroundTaskRunner = "shell" | "sumocode";

export interface BackgroundTaskCmuxRefs {
	workspaceRef: string;
	surfaceRef: string;
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
	promptFile?: string;
	responseFile?: string;
	diagFile?: string;
	visible: boolean;
	runner: BackgroundTaskRunner;
	model?: string;
	thinking?: BackgroundTaskThinking;
	cmux?: BackgroundTaskCmuxRefs;
	notifyOnExit: boolean;
}

export interface SpawnBackgroundTaskOptions {
	command: string;
	cwd: string;
	title?: string;
	visible?: boolean;
	direction?: SplitDirection;
	runner?: BackgroundTaskRunner;
	model?: string;
	thinking?: BackgroundTaskThinking;
	notifyOnExit?: boolean;
}

export interface BackgroundTaskSnapshot {
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
	metaFile?: string;
	promptFile?: string;
	responseFile?: string;
	diagFile?: string;
	visible: boolean;
	runner: BackgroundTaskRunner;
	model?: string;
	thinking?: BackgroundTaskThinking;
	cmux?: BackgroundTaskCmuxRefs;
}

export function toBackgroundTaskSnapshot(task: BackgroundTask): BackgroundTaskSnapshot {
	return {
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
		metaFile: task.metaFile,
		promptFile: task.promptFile,
		responseFile: task.responseFile,
		diagFile: task.diagFile,
		visible: task.visible,
		runner: task.runner,
		model: task.model,
		thinking: task.thinking,
		cmux: task.cmux,
	};
}
