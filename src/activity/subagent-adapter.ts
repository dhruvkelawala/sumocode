import type { SubagentSnapshot } from "../subagents/domain.js";
import {
	safeValuePreview,
	sanitizeActivityText,
	type ActivityBody,
	type ActivityKind,
	type ActivitySnapshot,
	type ActivityStatus,
} from "./domain.js";
import { normalizePiActivityStatus } from "./pi-projector.js";

const TEXT_MAX = 16 * 1024;
const PROMPT_MAX = 8 * 1024;
const CHILD_PREVIEW_MAX = 1_024;
const MAX_CHILD_TOOLS = 16;
const MAX_ENVELOPE_DEPTH = 3;
const ACTIVITY_KINDS = new Set<ActivityKind>(["tool", "task", "subagent", "terminal"]);
const ACTIVITY_STATUSES = new Set<ActivityStatus>(["queued", "running", "succeeded", "failed", "cancelled", "lost"]);

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
}

function boundedText(value: string, maxChars = TEXT_MAX): string {
	const sanitized = sanitizeActivityText(value);
	return sanitized.length <= maxChars ? sanitized : `${sanitized.slice(0, Math.max(0, maxChars - 1))}…`;
}

function firstString(...values: unknown[]): string | undefined {
	for (const value of values) {
		if (typeof value !== "string") continue;
		const text = boundedText(value).trim();
		if (text.length > 0) return text;
	}
	return undefined;
}

function numberFrom(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function textFromContent(content: unknown): string | undefined {
	if (typeof content === "string") return boundedText(content);
	if (!Array.isArray(content)) return undefined;
	const text = content.flatMap((part): string[] => {
		const record = asRecord(part);
		return record?.type === "text" && typeof record.text === "string" ? [record.text] : [];
	}).join("");
	return text.trim().length > 0 ? boundedText(text) : undefined;
}

function boundedUnknown(value: unknown): unknown {
	const preview = safeValuePreview(value, {
		maxChars: 4_000,
		maxDepth: 5,
		maxEntries: 32,
		maxStringChars: 1_000,
	});
	try {
		return JSON.parse(preview) as unknown;
	} catch {
		return { preview };
	}
}

function bodyFromEnvelope(value: unknown): ActivityBody | undefined {
	const body = asRecord(value);
	if (!body || typeof body.kind !== "string" || typeof body.text !== "string") return undefined;
	const text = boundedText(body.text);
	if (body.kind === "text" || body.kind === "diff") return { kind: body.kind, text };
	if (body.kind === "source") {
		const startLine = numberFrom(body.startLine);
		const totalLines = numberFrom(body.totalLines);
		return {
			kind: "source",
			text,
			...(startLine === undefined ? {} : { startLine }),
			...(totalLines === undefined ? {} : { totalLines }),
		};
	}
	if (body.kind === "terminal") {
		const command = firstString(body.command);
		return { kind: "terminal", ...(command ? { command } : {}), text };
	}
	return undefined;
}

function boundedEnvelope(value: unknown, depth = 0): ActivitySnapshot | undefined {
	const record = asRecord(value);
	const id = firstString(record?.id);
	const title = firstString(record?.title);
	const kind = record?.kind;
	const status = record?.status;
	if (!record || !id || !title || !ACTIVITY_KINDS.has(kind as ActivityKind) || !ACTIVITY_STATUSES.has(status as ActivityStatus)) return undefined;
	const sourceId = firstString(record.sourceId);
	const subject = firstString(record.subject);
	const currentStep = firstString(record.currentStep);
	const outputTail = typeof record.outputTail === "string" ? boundedText(record.outputTail, depth === 0 ? TEXT_MAX : CHILD_PREVIEW_MAX) : undefined;
	const body = bodyFromEnvelope(record.body);
	const resultRecord = asRecord(record.result);
	const rawSummary = firstString(resultRecord?.summary);
	const rawError = firstString(resultRecord?.error);
	const summary = rawSummary ? boundedText(rawSummary, depth === 0 ? TEXT_MAX : CHILD_PREVIEW_MAX) : undefined;
	const error = rawError ? boundedText(rawError, depth === 0 ? TEXT_MAX : CHILD_PREVIEW_MAX) : undefined;
	const metricsRecord = asRecord(record.metrics);
	const metrics = metricsRecord ? {
		...(numberFrom(metricsRecord.tokens) === undefined ? {} : { tokens: numberFrom(metricsRecord.tokens) }),
		...(numberFrom(metricsRecord.tokensIn) === undefined ? {} : { tokensIn: numberFrom(metricsRecord.tokensIn) }),
		...(numberFrom(metricsRecord.tokensOut) === undefined ? {} : { tokensOut: numberFrom(metricsRecord.tokensOut) }),
		...(numberFrom(metricsRecord.contextWindow) === undefined ? {} : { contextWindow: numberFrom(metricsRecord.contextWindow) }),
		...(numberFrom(metricsRecord.costUsd) === undefined ? {} : { costUsd: numberFrom(metricsRecord.costUsd) }),
		...(numberFrom(metricsRecord.turns) === undefined ? {} : { turns: numberFrom(metricsRecord.turns) }),
		...(numberFrom(metricsRecord.elapsedMs) === undefined ? {} : { elapsedMs: numberFrom(metricsRecord.elapsedMs) }),
	} : undefined;
	const activeTools = depth < MAX_ENVELOPE_DEPTH && Array.isArray(record.activeTools)
		? record.activeTools.slice(0, MAX_CHILD_TOOLS).map((child) => boundedEnvelope(child, depth + 1)).filter((child): child is ActivitySnapshot => child !== undefined)
		: undefined;
	return {
		id,
		...(sourceId ? { sourceId } : {}),
		kind: kind as ActivityKind,
		title,
		status: status as ActivityStatus,
		...(record.invocation === undefined ? {} : { invocation: boundedUnknown(record.invocation) }),
		...(subject ? { subject } : {}),
		...(currentStep ? { currentStep } : {}),
		...(outputTail ? { outputTail } : {}),
		...(body ? { body } : {}),
		...(activeTools && activeTools.length > 0 ? { activeTools } : {}),
		...(summary || error ? { result: { ...(summary ? { summary } : {}), ...(error ? { error } : {}) } } : {}),
		...(firstString(record.ownerSessionId) ? { ownerSessionId: firstString(record.ownerSessionId) } : {}),
		...(numberFrom(record.createdAt) === undefined ? {} : { createdAt: numberFrom(record.createdAt) }),
		...(numberFrom(record.updatedAt) === undefined ? {} : { updatedAt: numberFrom(record.updatedAt) }),
		...(numberFrom(record.settledAt) === undefined ? {} : { settledAt: numberFrom(record.settledAt) }),
		...(firstString(record.model) ? { model: firstString(record.model) } : {}),
		...(firstString(record.thinking) ? { thinking: firstString(record.thinking) } : {}),
		...(metrics && Object.keys(metrics).length > 0 ? { metrics } : {}),
	};
}

function paneId(pane: Record<string, unknown> | undefined): string | undefined {
	return firstString(pane?.paneId, pane?.tabId, pane?.workspaceId);
}

function subagentStatus(record: Record<string, unknown>): ActivityStatus {
	const status = firstString(record.status)?.toLowerCase();
	const manifestExit = firstString(asRecord(record.manifest)?.exit)?.toLowerCase();
	const error = firstString(record.errorText)?.toLowerCase();
	if (manifestExit === "interrupted" || error === "interrupted" || status === "cancelled" || status === "canceled") return "cancelled";
	if (status === "done" || status === "completed" || status === "success" || status === "succeeded") return "succeeded";
	if (status === "error" || status === "failed" || manifestExit === "failed") return "failed";
	return "running";
}

function toolActivity(toolValue: unknown): ActivitySnapshot | undefined {
	const tool = asRecord(toolValue);
	const id = firstString(tool?.id);
	if (!tool || !id) return undefined;
	const name = firstString(tool.name) ?? "tool";
	const done = tool.done === true;
	const isError = tool.isError === true;
	const rawOutput = firstString(tool.outputPreview);
	const rawArgs = firstString(tool.argsPreview);
	const output = rawOutput ? boundedText(rawOutput, CHILD_PREVIEW_MAX) : undefined;
	const args = rawArgs ? boundedText(rawArgs, CHILD_PREVIEW_MAX) : undefined;
	return {
		id,
		kind: "tool",
		title: name,
		status: done ? (isError ? "failed" : "succeeded") : "running",
		...(args ? { invocation: args } : {}),
		...(output ? { outputTail: output } : {}),
		...(done && (output || isError) ? { result: { ...(output ? { summary: output } : {}), ...(isError ? { error: output ?? `${name} failed` } : {}) } } : {}),
	};
}

function invocationFromSubagent(record: Record<string, unknown>): Record<string, unknown> {
	const pane = asRecord(record.pane);
	const worktree = asRecord(record.worktree);
	const prompt = firstString(record.prompt) ?? "subagent";
	return {
		prompt: boundedText(prompt, PROMPT_MAX),
		...(firstString(record.cwd) ? { cwd: firstString(record.cwd) } : {}),
		...(firstString(record.baseRef) ? { baseRef: firstString(record.baseRef) } : {}),
		...(record.visible === true ? { visible: true } : {}),
		...(pane ? {
			pane: {
				...(firstString(pane.agentName) ? { agentName: firstString(pane.agentName) } : {}),
				...(firstString(pane.workspaceId) ? { workspaceId: firstString(pane.workspaceId) } : {}),
				...(firstString(pane.tabId) ? { tabId: firstString(pane.tabId) } : {}),
				...(firstString(pane.paneId) ? { paneId: firstString(pane.paneId) } : {}),
			},
		} : {}),
		...(worktree ? {
			worktree: {
				...(firstString(worktree.path) ? { path: firstString(worktree.path) } : {}),
				...(firstString(worktree.branch) ? { branch: firstString(worktree.branch) } : {}),
				...(firstString(worktree.baseRef) ? { baseRef: firstString(worktree.baseRef) } : {}),
			},
		} : {}),
	};
}

function activityFromSubagentRecord(record: Record<string, unknown>): ActivitySnapshot {
	const id = firstString(record.id) ?? "unknown";
	const pane = asRecord(record.pane);
	const worktree = asRecord(record.worktree);
	const status = subagentStatus(record);
	const liveText = firstString(record.liveText);
	const finalText = firstString(record.finalText);
	const output = status === "running" ? liveText ?? finalText : undefined;
	const error = status === "failed" || status === "cancelled" ? firstString(record.errorText) : undefined;
	const summary = status === "succeeded" || status === "failed" || status === "cancelled" ? finalText : undefined;
	const liveTools = Array.isArray(record.liveTools)
		? record.liveTools.slice(0, MAX_CHILD_TOOLS).map(toolActivity).filter((tool): tool is ActivitySnapshot => tool !== undefined)
		: [];
	const usage = asRecord(record.usage);
	const manifest = asRecord(record.manifest);
	const createdAt = numberFrom(record.createdAt);
	const settledAt = numberFrom(record.settledAt);
	const explicitElapsed = numberFrom(manifest?.durationMs);
	const elapsedMs = explicitElapsed ?? (createdAt !== undefined && settledAt !== undefined ? Math.max(0, settledAt - createdAt) : undefined);
	const tokens = numberFrom(usage?.tokens);
	const contextWindow = numberFrom(usage?.contextWindow);
	const costUsd = numberFrom(usage?.costUsd);
	const turns = numberFrom(usage?.turns);
	const metrics = [tokens, contextWindow, costUsd, turns, elapsedMs].some((value) => value !== undefined && value > 0) ? {
		...(tokens !== undefined && tokens > 0 ? { tokens } : {}),
		...(contextWindow !== undefined && contextWindow > 0 ? { contextWindow } : {}),
		...(costUsd !== undefined && costUsd > 0 ? { costUsd } : {}),
		...(turns !== undefined && turns > 0 ? { turns } : {}),
		...(elapsedMs !== undefined && elapsedMs > 0 ? { elapsedMs } : {}),
	} : undefined;
	const paneLabel = paneId(pane);
	const branch = firstString(worktree?.branch);
	const subject = [id, paneLabel ? `pane ${paneLabel}` : undefined, branch].filter((part): part is string => !!part).join(" · ");
	const outputLastLine = output?.split("\n").filter((line) => line.trim().length > 0).at(-1);
	const currentStep = status === "running"
		? outputLastLine ? boundedText(outputLastLine.trim(), 256) : paneLabel ? `pane ${paneLabel} · running` : undefined
		: undefined;
	return {
		id: `subagent:${id}`,
		kind: "subagent",
		title: firstString(record.title) ?? "subagent",
		status,
		invocation: invocationFromSubagent(record),
		subject,
		...(currentStep ? { currentStep } : {}),
		...(output ? { outputTail: boundedText(output) } : {}),
		...(liveTools.length > 0 ? { activeTools: liveTools } : {}),
		...(summary || error ? { result: { ...(summary ? { summary: boundedText(summary) } : {}), ...(error ? { error: boundedText(error) } : {}) } } : {}),
		...(createdAt === undefined ? {} : { createdAt }),
		...(settledAt === undefined ? {} : { settledAt }),
		...(firstString(record.modelLabel) ? { model: firstString(record.modelLabel) } : {}),
		...(firstString(record.thinkingLabel) ? { thinking: firstString(record.thinkingLabel) } : {}),
		...(metrics ? { metrics } : {}),
	};
}

/** Project a manager snapshot into a bounded renderer-neutral Activity. */
export function activityFromSubagentSnapshot(snapshot: SubagentSnapshot): ActivitySnapshot {
	return activityFromSubagentRecord(snapshot as unknown as Record<string, unknown>);
}

function activityEnvelopes(details: Record<string, unknown> | undefined): ActivitySnapshot[] {
	const value = details?.activity;
	const values = Array.isArray(value) ? value : value === undefined ? [] : [value];
	return values.slice(0, MAX_CHILD_TOOLS).map((item) => boundedEnvelope(item)).filter((activity): activity is ActivitySnapshot => activity !== undefined);
}

function subagentRecords(details: Record<string, unknown> | undefined): Record<string, unknown>[] {
	const records: Record<string, unknown>[] = [];
	const single = asRecord(details?.subagent);
	if (single) records.push(single);
	if (Array.isArray(details?.subagents)) {
		for (const value of details.subagents.slice(0, MAX_CHILD_TOOLS)) {
			const record = asRecord(value);
			if (record) records.push(record);
		}
	}
	return records;
}

function spawnInvocation(record: Record<string, unknown>): unknown {
	const args = asRecord(record.arguments ?? record.input) ?? {};
	const projected: Record<string, unknown> = {};
	for (const key of ["prompt", "name", "model", "thinking", "working_dir", "worktree", "branch", "baseRef", "visible"] as const) {
		const value = args[key];
		if (typeof value === "string") projected[key] = boundedText(value, key === "prompt" ? PROMPT_MAX : 1_000);
		else if (typeof value === "boolean") projected[key] = value;
	}
	return projected;
}

function spawnToolActivity(record: Record<string, unknown>, toolCallId: string): ActivitySnapshot {
	const isError = record.isError === true;
	const status = normalizePiActivityStatus(record.status, record.type === "toolResult" || record.role === "toolResult" ? (isError ? "failed" : "succeeded") : "queued");
	const output = textFromContent(record.content);
	return {
		id: toolCallId,
		kind: "tool",
		title: "subagent_spawn",
		status,
		invocation: spawnInvocation(record),
		...(output ? { outputTail: output } : {}),
		...(isError && output ? { result: { error: output } } : {}),
	};
}

/** Project subagent tool details; wait/cancel may yield several canonical updates. */
export function activitiesFromSubagentToolRecord(
	recordValue: unknown,
	context: { readonly toolCallId?: string },
): readonly ActivitySnapshot[] {
	const record = asRecord(recordValue);
	if (!record) return [];
	const toolName = firstString(record.name, record.toolName);
	if (!toolName?.startsWith("subagent_")) return [];
	if (toolName === "subagent_send" || toolName === "subagent_list") return [];
	const details = asRecord(record.details);
	const enveloped = activityEnvelopes(details);
	const snapshots = enveloped.length > 0
		? enveloped
		: subagentRecords(details).map(activityFromSubagentRecord);
	if (snapshots.length > 0) {
		return snapshots.map((activity) => toolName === "subagent_spawn" && context.toolCallId && !activity.sourceId
			? { ...activity, sourceId: context.toolCallId }
			: activity);
	}
	if (toolName !== "subagent_spawn" || !context.toolCallId) return [];
	return [spawnToolActivity(record, context.toolCallId)];
}

/** Map passive completion messages, including historical payloads without an envelope. */
export function activityFromSubagentResultRecord(recordValue: unknown): ActivitySnapshot {
	const record = asRecord(recordValue) ?? {};
	const details = asRecord(record.details);
	const enveloped = activityEnvelopes(details)[0];
	if (enveloped) return enveloped;
	const id = firstString(details?.id, record.subagentId) ?? "unknown";
	const title = firstString(details?.title, record.title) ?? "subagent";
	const status = subagentStatus({ ...record, ...details });
	const content = textFromContent(record.content);
	return {
		id: `subagent:${id}`,
		kind: "subagent",
		title,
		status,
		subject: id,
		...(content ? {
			result: status === "failed" || status === "cancelled"
				? { error: content }
				: { summary: content },
		} : {}),
	};
}
