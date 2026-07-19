export type SubagentStatus = "running" | "done" | "error";

export type SubagentEvent =
	| { kind: "run-started" }
	| { kind: "assistant-delta"; delta: string }
	| { kind: "tool-start"; toolId: string; name: string; argsPreview?: string }
	| { kind: "tool-update"; toolId: string; outputPreview?: string }
	| { kind: "tool-end"; toolId: string; name: string; isError: boolean; outputPreview?: string }
	| { kind: "message-end"; role: "user" | "assistant" | "toolResult"; text: string }
	| { kind: "usage"; tokens?: number; contextWindow?: number; costUsd?: number }
	| { kind: "run-settled"; outcome: RunOutcome };

export type RunOutcome =
	| { kind: "completed"; finalText: string }
	| { kind: "failed"; errorText: string; partialText?: string }
	| { kind: "interrupted"; partialText?: string };

export interface TranscriptItem {
	readonly role: "user" | "assistant" | "toolResult";
	readonly text: string;
	readonly createdAt: number;
}

export interface LiveToolState {
	readonly id: string;
	readonly name: string;
	readonly argsPreview?: string;
	readonly outputPreview?: string;
	readonly done: boolean;
	readonly isError: boolean;
}

export interface SubagentWorktreeRef {
	readonly path: string;
	readonly branch: string;
	readonly baseRef: string;
	readonly repoRoot: string;
}

export interface SubagentSnapshot {
	readonly id: string;
	readonly title: string;
	readonly prompt: string;
	readonly cwd: string;
	readonly baseRef: string;
	readonly worktree?: SubagentWorktreeRef;
	readonly status: SubagentStatus;
	readonly createdAt: number;
	readonly settledAt?: number;
	readonly errorText?: string;
	readonly modelLabel?: string;
	readonly sessionFilePath?: string;
	readonly usage: { tokens?: number; contextWindow?: number; costUsd?: number; turns: number };
	readonly transcript: readonly TranscriptItem[];
	readonly liveText: string;
	readonly liveTools: readonly LiveToolState[];
	readonly finalText: string;
}

export const latestText = (snap: SubagentSnapshot): string => snap.liveText || snap.finalText;
