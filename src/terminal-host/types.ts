import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type TerminalHostKind = "cmux" | "herdr" | "none";
export type SplitDirection = "right" | "down";

export interface PaneRef {
	host: Exclude<TerminalHostKind, "none">;
	paneId: string;
	workspaceId?: string;
}

export type HostResult<T> = ({ ok: true } & T) | { ok: false; error: string };
export type PiExecLike = Pick<ExtensionAPI, "exec">;

export interface WorktreeWorkspaceOptions {
	branch: string;
	baseRef: string;
	path: string;
	label: string;
	shellCommand: string;
}

export interface ExistingWorktreeWorkspaceOptions {
	path: string;
	label: string;
	shellCommand: string;
}

export interface TerminalHost {
	readonly kind: TerminalHostKind;
	openCommandInSplit(pi: PiExecLike, direction: SplitDirection, options: { cwd: string; shellCommand: string }): Promise<HostResult<{ pane: PaneRef }>>;
	openWorktreeWorkspace?(pi: PiExecLike, options: WorktreeWorkspaceOptions): Promise<HostResult<{ pane: PaneRef }>>;
	openExistingWorktreeWorkspace?(pi: PiExecLike, options: ExistingWorktreeWorkspaceOptions): Promise<HostResult<{ pane: PaneRef }>>;
	replaceCurrentPane?(pi: PiExecLike, options: { cwd: string; shellCommand: string }): Promise<HostResult<object>>;
	closePane(pi: PiExecLike, pane: PaneRef): Promise<HostResult<object>>;
	notify(pi: PiExecLike, title: string, body: string, pane?: PaneRef): Promise<void>;
	focusPane?(pi: PiExecLike, pane: PaneRef): Promise<HostResult<object>>;
}
