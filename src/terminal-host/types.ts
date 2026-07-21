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

export type AgentPanePlacement =
	| { kind: "workspace"; workspaceId: string }
	| { kind: "tab"; tabId: string; direction: SplitDirection }
	| { kind: "new-tab"; label: string };

export interface StartAgentPaneOptions {
	name: string;
	cwd: string;
	shellCommand: string;
	placement: AgentPanePlacement;
}

export interface StartedAgentPane {
	pane: PaneRef;
	agentName: string;
	workspaceId?: string;
	tabId?: string;
	paneId?: string;
}

export interface WorktreeWorkspaceOptions {
	branch: string;
	baseRef: string;
	path: string;
	label: string;
	shellCommand: string;
	/**
	 * Repo checkout that owns the worktree. herdr resolves worktree commands
	 * against the FOCUSED workspace when no --cwd/--workspace is given — which
	 * may be a different project entirely (observed live: worktree_not_found
	 * because the human was focused on another repo). Always required.
	 */
	sourceCwd: string;
	/**
	 * Whether the new workspace should take focus. Defaults to true (human
	 * `/worktree` flows land in the workspace); programmatic spawns (visible
	 * subagents) pass false so panes never steal the user's focus.
	 */
	focus?: boolean;
}

export interface ExistingWorktreeWorkspaceOptions {
	path: string;
	label: string;
	shellCommand?: string;
	/** See {@link WorktreeWorkspaceOptions.sourceCwd}. Always required. */
	sourceCwd: string;
	/** See {@link WorktreeWorkspaceOptions.focus}. Defaults to true. */
	focus?: boolean;
}

export interface TerminalHost {
	readonly kind: TerminalHostKind;
	startAgentPane?(pi: PiExecLike, options: StartAgentPaneOptions): Promise<HostResult<StartedAgentPane>>;
	sendPaneText?(pi: PiExecLike, pane: PaneRef, text: string): Promise<HostResult<{}>>;
	openCommandInSplit(pi: PiExecLike, direction: SplitDirection, options: { cwd: string; shellCommand: string }): Promise<HostResult<{ pane: PaneRef }>>;
	openWorktreeWorkspace?(pi: PiExecLike, options: WorktreeWorkspaceOptions): Promise<HostResult<{ pane: PaneRef }>>;
	openExistingWorktreeWorkspace?(pi: PiExecLike, options: ExistingWorktreeWorkspaceOptions): Promise<HostResult<{ pane: PaneRef }>>;
	replaceCurrentPane?(pi: PiExecLike, options: { cwd: string; shellCommand: string }): Promise<HostResult<object>>;
	closePane(pi: PiExecLike, pane: PaneRef): Promise<HostResult<object>>;
	notify(pi: PiExecLike, title: string, body: string, pane?: PaneRef): Promise<void>;
	focusPane?(pi: PiExecLike, pane: PaneRef): Promise<HostResult<object>>;
}
