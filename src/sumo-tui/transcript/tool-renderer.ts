import type { ActivitySnapshot, ActivityStatus } from "../../activity/domain.js";
import { projectPiToolActivity } from "../../activity/pi-projector.js";
import {
	activityNote,
	activityStatusColor,
	activityStatusGlyph,
	activityTarget,
	renderActivityBlockRows,
	renderActivityLedgerRows,
	renderCompactActivityPill,
} from "./activity-renderer.js";
import type { ToolCallViewModel, ToolStatus } from "./view-model.js";

const LEGACY_TOOL_IDS = new WeakMap<object, string>();
let nextLegacyToolId = 1;

const ACTIVITY_STATUS: Record<ToolStatus, ActivityStatus> = {
	pending: "queued",
	running: "running",
	success: "succeeded",
	error: "failed",
	cancelled: "cancelled",
};

function legacyToolId(tool: ToolCallViewModel): string {
	if (tool.id) return tool.id;
	const existing = LEGACY_TOOL_IDS.get(tool);
	if (existing) return existing;
	const id = `legacy-tool:${nextLegacyToolId}:${tool.name}`;
	nextLegacyToolId += 1;
	LEGACY_TOOL_IDS.set(tool, id);
	return id;
}

/** Compatibility projector for fixtures/importers that still construct ToolCallViewModel. */
export function activityFromToolViewModel(tool: ToolCallViewModel): ActivitySnapshot {
	const projected = projectPiToolActivity({
		id: legacyToolId(tool),
		name: tool.name,
		status: ACTIVITY_STATUS[tool.status],
		arguments: tool.input,
		output: tool.output,
		details: tool.details,
		error: tool.error,
		isError: tool.status === "error",
	}, { messageId: "legacy", blockIndex: 0, fallbackStatus: ACTIVITY_STATUS[tool.status] });
	if (!projected) throw new Error("Failed to project legacy tool view model");
	return projected;
}

export function toolStatusGlyph(status: ToolStatus): string {
	return activityStatusGlyph(ACTIVITY_STATUS[status]);
}

export function toolStatusColor(status: ToolStatus): string {
	return activityStatusColor(ACTIVITY_STATUS[status]);
}

export function toolTarget(tool: ToolCallViewModel): string {
	return activityTarget(activityFromToolViewModel(tool));
}

export function toolNote(tool: ToolCallViewModel): string | undefined {
	return activityNote(activityFromToolViewModel(tool));
}

export function renderCompactToolPill(tool: ToolCallViewModel): string {
	return renderCompactActivityPill(activityFromToolViewModel(tool));
}

export function renderToolLedgerRows(tool: ToolCallViewModel, width: number): string[] {
	return renderActivityLedgerRows(activityFromToolViewModel(tool), width);
}

export function renderToolBlockRows(tool: ToolCallViewModel, width: number): string[] {
	return renderActivityBlockRows(activityFromToolViewModel(tool), width, { expanded: tool.expanded !== false });
}
