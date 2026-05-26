export type BackgroundTaskStatus = "running" | "completed" | "failed" | "stopped";

export type SplitDirection = "right" | "down";
export type BackgroundTaskRunner = "shell" | "pi" | "sumocode";

export interface BackgroundTaskCmuxRefs {
	workspaceRef: string;
	surfaceRef: string;
}

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
	visible: boolean;
	runner: BackgroundTaskRunner;
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
	visible: boolean;
	runner: BackgroundTaskRunner;
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
		visible: task.visible,
		runner: task.runner,
		cmux: task.cmux,
	};
}
