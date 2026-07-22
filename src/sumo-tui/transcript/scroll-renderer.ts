/**
 * Compatibility forwarding wrapper for legacy delegation fixtures/records.
 * Native tasks and subagents project directly to ActivitySnapshot; this bridge
 * keeps the old import surface without maintaining a second renderer.
 */
import type { ActivitySnapshot, ActivityStatus } from "../../activity/domain.js";
import { renderActivityBlockRows } from "./activity-renderer.js";
import type { DelegationStatus, DelegationViewModel, ToolCallViewModel } from "./view-model.js";

const STATUS: Record<DelegationStatus, ActivityStatus> = {
	queued: "queued",
	running: "running",
	success: "succeeded",
	error: "failed",
	cancelled: "cancelled",
};

function toolStatus(status: ToolCallViewModel["status"]): ActivityStatus {
	if (status === "pending") return "queued";
	if (status === "success") return "succeeded";
	if (status === "error") return "failed";
	return status;
}

function childActivity(tool: ToolCallViewModel, parentId: string, index: number): ActivitySnapshot {
	const output = typeof tool.output === "string" ? tool.output : undefined;
	const status = toolStatus(tool.status);
	return {
		id: tool.id ?? `${parentId}:tool:${tool.name}:${index}`,
		kind: "tool",
		title: tool.name,
		status,
		...(tool.input === undefined ? {} : { invocation: tool.input }),
		...(output ? { outputTail: output } : {}),
		...(output && status === "failed" ? { result: { error: output } } : {}),
	};
}

export function activityFromDelegationViewModel(delegation: DelegationViewModel): ActivitySnapshot {
	const id = delegation.id ?? `legacy-delegation:${delegation.title}`;
	const status = STATUS[delegation.status];
	const summary = delegation.summary?.trim();
	return {
		id,
		kind: "task",
		title: delegation.title,
		status,
		...(delegation.prompt ? { invocation: { prompt: delegation.prompt } } : {}),
		...(delegation.agent ? { subject: delegation.agent } : {}),
		...(status === "running" && summary ? { currentStep: summary.split("\n").find((line) => line.trim().length > 0) } : {}),
		...(summary ? { outputTail: summary } : {}),
		...(delegation.nestedTools && delegation.nestedTools.length > 0
			? { activeTools: delegation.nestedTools.map((tool, index) => childActivity(tool, id, index)) }
			: {}),
		...(summary && status === "succeeded" ? { result: { summary } } : {}),
		...(summary && status === "failed" ? { result: { error: summary } } : {}),
		...(delegation.model ? { model: delegation.model } : {}),
		...(delegation.thinking ? { thinking: delegation.thinking } : {}),
		...(delegation.tokensIn !== undefined || delegation.tokensOut !== undefined || delegation.elapsedMs !== undefined
			? {
				metrics: {
					...(delegation.tokensIn === undefined ? {} : { tokensIn: delegation.tokensIn }),
					...(delegation.tokensOut === undefined ? {} : { tokensOut: delegation.tokensOut }),
					...(delegation.elapsedMs === undefined ? {} : { elapsedMs: delegation.elapsedMs }),
				},
			}
			: {}),
	};
}

export function renderScrollBlock(delegation: DelegationViewModel, width: number): string[] {
	return renderActivityBlockRows(activityFromDelegationViewModel(delegation), width, { expanded: true });
}
