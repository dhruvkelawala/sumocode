import type { CompletionManifestEvidence } from "./manifest.js";
import type { SubagentBudget, SubagentBudgetState } from "./budget-policy.js";

/** Concurrent running-children ceiling. Queue absorbs bursts beyond it (plan 083). */
export const SUBAGENT_MAX_RUNNING = 10;
/** Bounded FIFO depth for spawns accepted past the running ceiling. */
export const SUBAGENT_MAX_QUEUED = 16;

export type SubagentStatus = "queued" | "running" | "done" | "error";

export type SubagentEvent =
	| { kind: "run-started" }
	| { kind: "heartbeat"; at: number }
	| { kind: "progress" }
	| { kind: "pane-attached"; pane: SubagentPaneRef }
	| { kind: "assistant-delta"; delta: string }
	| { kind: "tool-start"; toolId: string; name: string; argsPreview?: string }
	| { kind: "tool-update"; toolId: string; outputPreview?: string }
	| { kind: "tool-end"; toolId: string; name: string; isError: boolean; outputPreview?: string }
	// A bounded backend may reclaim prior transcript text so the final assistant
	// result survives; the replacement text carries the run's sole marker.
	| { kind: "message-end"; role: "user" | "assistant" | "toolResult"; text: string; replacesRetainedText?: true }
	| { kind: "usage"; tokens?: number; contextWindow?: number; costUsd?: number }
	| { kind: "run-settled"; outcome: RunOutcome };

export type RunOutcome =
	| { kind: "completed"; finalText: string }
	| { kind: "failed"; errorText: string; partialText?: string; errorCode?: string; errorReason?: string }
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
	readonly startedAt?: number;
}

export interface SubagentWorktreeRef {
	readonly path: string;
	readonly branch: string;
	readonly baseRef: string;
	readonly repoRoot: string;
}

export interface SubagentPaneRef {
	readonly agentName: string;
	readonly workspaceId?: string;
	readonly tabId?: string;
	readonly paneId?: string;
}

export type SubagentRecoveryReason =
	| { readonly code: "visible-pane-reference"; readonly expected: "pane-id"; readonly observed: "missing" }
	| { readonly code: "visible-pane-host"; readonly expected: "available" | "pane-capable"; readonly observed: "missing" | "none" }
	| { readonly code: "visible-pane-inspector" | "visible-pane-executor"; readonly expected: "available"; readonly observed: "missing" }
	| { readonly code: "visible-pane-inspection"; readonly expected: "verified"; readonly observed: "error" | "refused" }
	| { readonly code: "visible-pane-foreground-process-group"; readonly expected: "same"; readonly observed: "missing" | "different" }
	| { readonly code: "visible-pane-shell-process"; readonly expected: "same"; readonly observed: "missing" | "different" }
	| { readonly code: "visible-pane-foreground-processes" | "visible-pane-child-root-recheck"; readonly expected: "present"; readonly observed: "missing" }
	| { readonly code: "visible-pane-child-verifier-recheck"; readonly expected: "available"; readonly observed: "missing" }
	| { readonly code: "visible-pane-child-identity-recheck" | "visible-pane-child-verification-recheck"; readonly expected: "same"; readonly observed: "different" | "unknown" };

export interface SubagentSnapshot extends Partial<SubagentBudgetState> {
	readonly recovery?: "adopted" | "persist-only" | "unsupported" | "lost" | "ambiguous";
	readonly recoveryReason?: SubagentRecoveryReason;
	readonly budget?: SubagentBudget;
	readonly startedAt?: number;
	readonly id: string;
	readonly sourceId?: string;
	readonly title: string;
	readonly prompt: string;
	readonly roleId?: string;
	readonly cwd: string;
	readonly baseRef: string;
	readonly worktree?: SubagentWorktreeRef;
	readonly visible?: boolean;
	readonly pane?: SubagentPaneRef;
	readonly status: SubagentStatus;
	readonly createdAt: number;
	readonly settledAt?: number;
	readonly errorText?: string;
	readonly errorCode?: string;
	readonly errorReason?: string;
	readonly modelLabel?: string;
	readonly thinkingLabel?: string;
	readonly sessionFilePath?: string;
	readonly manifest?: CompletionManifestEvidence;
	readonly usage: { tokens?: number; contextWindow?: number; costUsd?: number; turns: number; reportedTokens?: number; reportedCostUsd?: number };
	readonly transcript: readonly TranscriptItem[];
	readonly liveText: string;
	readonly liveTools: readonly LiveToolState[];
	readonly finalText: string;
}

export const latestText = (snap: SubagentSnapshot): string => snap.liveText || snap.finalText;
