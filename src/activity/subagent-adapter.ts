// oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type -- I/O boundary parser (subagent tool payload projection): inputs are untrusted producer JSON,
// so `unknown` parameters and open string-keyed records are this module's real input contract.
import type { SubagentSnapshot } from "../subagents/domain.js";
import {
	type ActivityBody,
	type ActivityKind,
	type ActivitySnapshot,
	type ActivityStatus,
} from "./domain.js";
import {
	boundedAdapterPreview,
	boundedAdapterText,
	boundedArray,
	boundedPriorityArray,
	boundedRecord,
	createAdapterTraversalBudget,
	firstBoundedAdapterString,
	type AdapterTraversalBudget,
} from "./adapter-bounds.js";
import { normalizePiActivityStatus } from "./pi-projector.js";

const TEXT_MAX = 16 * 1024;
const PROMPT_MAX = 8 * 1024;
const CHILD_PREVIEW_MAX = 1_024;
const MAX_CHILD_TOOLS = 16;
const MAX_OPERATION_ACTIVITIES = 64;
const MAX_ENVELOPE_DEPTH = 3;
const MAX_CONTENT_PARTS = 64;
const ADAPTER_MAX_NODES = 16_384;
const ADAPTER_MAX_CHARS = 1024 * 1024;
const OPERATION_CORE_MAX_NODES = 8;
const OPERATION_CORE_MAX_CHARS = 4 * 1024;
const OPERATION_OPTIONAL_MAX_NODES = 256;
const OPERATION_OPTIONAL_MAX_CHARS = 8 * 1024;
const OPERATION_SNAPSHOT_MAX_NODES = 512;
const OPERATION_SNAPSHOT_MAX_CHARS = 32 * 1024;
const ACTIVITY_ID_MAX = 512;
const ACTIVITY_TITLE_MAX = 1_024;
const ACTIVITY_KINDS = new Set<ActivityKind>(["tool", "task", "subagent", "terminal"]);
const ACTIVITY_STATUSES = new Set<ActivityStatus>(["queued", "running", "succeeded", "failed", "cancelled", "lost"]);

interface ResultSummary {
	summary?: string;
	error?: string;
}

/** Writable mirrors used to assemble snapshots field-by-field before returning them. */
type MutableActivitySnapshot = { -readonly [K in keyof ActivitySnapshot]: ActivitySnapshot[K] };
type MutableActivityMetrics = {
	-readonly [K in keyof NonNullable<ActivitySnapshot["metrics"]>]: NonNullable<ActivitySnapshot["metrics"]>[K];
};

function asRecord(value: unknown, budget: AdapterTraversalBudget): Record<string, unknown> | undefined {
	return boundedRecord(value, budget);
}

function boundedText(value: string, maxChars = TEXT_MAX): string {
	return value.length <= maxChars ? value : `${value.slice(0, Math.max(0, maxChars - 1))}…`;
}

function firstString(budget: AdapterTraversalBudget, ...values: unknown[]): string | undefined {
	return firstBoundedAdapterString(budget, TEXT_MAX, ...values);
}

function isStringValue(value: unknown): value is string {
	return typeof value === "string";
}

function isBooleanValue(value: unknown): value is boolean {
	return typeof value === "boolean";
}

function isNumberValue(value: unknown): value is number {
	return typeof value === "number";
}

function numberFrom(value: unknown): number | undefined {
	return isNumberValue(value) && Number.isFinite(value) ? value : undefined;
}

function isRecordLike(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isActivityKind(value: unknown): value is ActivityKind {
	if (!isStringValue(value)) return false;
	// SAFETY: membership in ACTIVITY_KINDS proves this string is an ActivityKind.
	return ACTIVITY_KINDS.has(value as ActivityKind);
}

function isActivityStatus(value: unknown): value is ActivityStatus {
	if (!isStringValue(value)) return false;
	// SAFETY: membership in ACTIVITY_STATUSES proves this string is an ActivityStatus.
	return ACTIVITY_STATUSES.has(value as ActivityStatus);
}

function textFromContent(content: unknown, budget: AdapterTraversalBudget): string | undefined {
	if (isStringValue(content)) return boundedAdapterText(content, TEXT_MAX, budget);
	const parts = boundedArray(content, MAX_CONTENT_PARTS, budget);
	if (parts.length === 0) return undefined;
	let text = "";
	for (const part of parts) {
		const record = asRecord(part, budget);
		if (record?.type !== "text") continue;
		if (text.length >= TEXT_MAX) break;
		const chunk = boundedAdapterText(record.text, TEXT_MAX - text.length, budget);
		if (chunk) text += chunk;
	}
	return text.trim().length > 0 ? boundedText(text) : undefined;
}

/** Producer-shaped invocation snapshot recovered from the bounded preview. */
type InvocationSnapshotPayload =
	| string
	| number
	| boolean
	| null
	| readonly InvocationSnapshotPayload[]
	| { readonly [key: string]: InvocationSnapshotPayload };

function boundedUnknown(value: unknown, budget: AdapterTraversalBudget): InvocationSnapshotPayload {
	const preview = boundedAdapterPreview(value, budget, {
		maxChars: 4_000,
		maxDepth: 5,
		maxEntries: 32,
		maxStringChars: 1_000,
		maxNodes: 64,
	});
	try {
		return JSON.parse(preview);
	} catch {
		return { preview };
	}
}

type MutableSourceBody = {
	-readonly [K in keyof Extract<ActivityBody, { kind: "source" }>]: Extract<ActivityBody, { kind: "source" }>[K];
};

function bodyFromEnvelope(value: unknown, budget: AdapterTraversalBudget): ActivityBody | undefined {
	const body = asRecord(value, budget);
	if (!body || !isStringValue(body.kind) || !isStringValue(body.text)) return undefined;
	const text = boundedAdapterText(body.text, TEXT_MAX, budget);
	if (text === undefined) return undefined;
	if (body.kind === "text" || body.kind === "diff") return { kind: body.kind, text };
	if (body.kind === "source") {
		const source: MutableSourceBody = { kind: "source", text };
		const startLine = numberFrom(body.startLine);
		const totalLines = numberFrom(body.totalLines);
		if (startLine !== undefined) source.startLine = startLine;
		if (totalLines !== undefined) source.totalLines = totalLines;
		return source;
	}
	if (body.kind === "terminal") {
		const command = firstString(budget, body.command);
		return command ? { kind: "terminal", command, text } : { kind: "terminal", text };
	}
	return undefined;
}

function boundedEnvelope(
	value: unknown,
	budget: AdapterTraversalBudget,
	depth = 0,
	coreBudget: AdapterTraversalBudget = budget,
): ActivitySnapshot | undefined {
	const record = asRecord(value, coreBudget);
	const id = firstBoundedAdapterString(coreBudget, ACTIVITY_ID_MAX, record?.id);
	const title = firstBoundedAdapterString(coreBudget, ACTIVITY_TITLE_MAX, record?.title);
	const kind = record?.kind;
	const status = record?.status;
	if (!record || !id || !title || !isActivityKind(kind) || !isActivityStatus(status)) return undefined;
	// Correlation identity shares the reserved core budget. Optional tails below
	// may exhaust their per-item budget without dropping this Activity or making
	// a later one in the same 64-item operation disappear.
	const sourceId = firstBoundedAdapterString(coreBudget, ACTIVITY_ID_MAX, record.sourceId);
	const subject = firstString(budget, record.subject);
	const currentStep = firstString(budget, record.currentStep);
	const outputTail = boundedAdapterText(record.outputTail, depth === 0 ? TEXT_MAX : CHILD_PREVIEW_MAX, budget);
	const body = bodyFromEnvelope(record.body, budget);
	const resultRecord = asRecord(record.result, budget);
	const rawSummary = firstString(budget, resultRecord?.summary);
	const rawError = firstString(budget, resultRecord?.error);
	const summary = rawSummary ? boundedText(rawSummary, depth === 0 ? TEXT_MAX : CHILD_PREVIEW_MAX) : undefined;
	const error = rawError ? boundedText(rawError, depth === 0 ? TEXT_MAX : CHILD_PREVIEW_MAX) : undefined;
	const metricsRecord = asRecord(record.metrics, budget);
	let metrics: MutableActivityMetrics | undefined;
	if (metricsRecord) {
		const parsedMetrics: MutableActivityMetrics = {};
		const tokens = numberFrom(metricsRecord.tokens);
		const tokensIn = numberFrom(metricsRecord.tokensIn);
		const tokensOut = numberFrom(metricsRecord.tokensOut);
		const contextWindow = numberFrom(metricsRecord.contextWindow);
		const costUsd = numberFrom(metricsRecord.costUsd);
		const turns = numberFrom(metricsRecord.turns);
		const elapsedMs = numberFrom(metricsRecord.elapsedMs);
		if (tokens !== undefined) parsedMetrics.tokens = tokens;
		if (tokensIn !== undefined) parsedMetrics.tokensIn = tokensIn;
		if (tokensOut !== undefined) parsedMetrics.tokensOut = tokensOut;
		if (contextWindow !== undefined) parsedMetrics.contextWindow = contextWindow;
		if (costUsd !== undefined) parsedMetrics.costUsd = costUsd;
		if (turns !== undefined) parsedMetrics.turns = turns;
		if (elapsedMs !== undefined) parsedMetrics.elapsedMs = elapsedMs;
		metrics = parsedMetrics;
	}
	const activeTools = depth < MAX_ENVELOPE_DEPTH
		? boundedArray(record.activeTools, MAX_CHILD_TOOLS, budget)
			.map((child) => boundedEnvelope(child, budget, depth + 1))
			.filter((child): child is ActivitySnapshot => child !== undefined)
		: undefined;
	const ownerSessionId = firstString(budget, record.ownerSessionId);
	const model = firstString(budget, record.model);
	const thinking = firstString(budget, record.thinking);
	const leadingOptionals: Partial<MutableActivitySnapshot> = {};
	if (sourceId) leadingOptionals.sourceId = sourceId;
	const activity: MutableActivitySnapshot = { id, ...leadingOptionals, kind, title, status };
	if (record.invocation !== undefined) activity.invocation = boundedUnknown(record.invocation, budget);
	if (subject) activity.subject = subject;
	if (currentStep) activity.currentStep = currentStep;
	if (outputTail) activity.outputTail = outputTail;
	if (body) activity.body = body;
	if (activeTools && activeTools.length > 0) activity.activeTools = activeTools;
	if (summary || error) {
		const resultSummary: ResultSummary = {};
		if (summary) resultSummary.summary = summary;
		if (error) resultSummary.error = error;
		activity.result = resultSummary;
	}
	if (ownerSessionId) activity.ownerSessionId = ownerSessionId;
	const createdAt = numberFrom(record.createdAt);
	const updatedAt = numberFrom(record.updatedAt);
	const settledAt = numberFrom(record.settledAt);
	if (createdAt !== undefined) activity.createdAt = createdAt;
	if (updatedAt !== undefined) activity.updatedAt = updatedAt;
	if (settledAt !== undefined) activity.settledAt = settledAt;
	if (model) activity.model = model;
	if (thinking) activity.thinking = thinking;
	if (metrics && Object.keys(metrics).length > 0) activity.metrics = metrics;
	return activity;
}

function paneId(pane: Record<string, unknown> | undefined, budget: AdapterTraversalBudget): string | undefined {
	return firstString(budget, pane?.paneId, pane?.tabId, pane?.workspaceId);
}

function isUnfinishedToolValue(value: unknown): value is Record<string, unknown> {
	return isRecordLike(value) && value.done !== true;
}

function subagentStatus(record: Record<string, unknown>, budget: AdapterTraversalBudget): ActivityStatus {
	const status = firstString(budget, record.status)?.toLowerCase();
	const manifestExit = firstString(budget, asRecord(record.manifest, budget)?.exit)?.toLowerCase();
	const error = firstString(budget, record.errorText)?.toLowerCase();
	if (manifestExit === "interrupted" || error === "interrupted" || status === "cancelled" || status === "canceled") return "cancelled";
	if (status === "queued") return "queued";
	if (status === "done" || status === "completed" || status === "success" || status === "succeeded") return "succeeded";
	if (status === "error" || status === "failed" || manifestExit === "failed") return "failed";
	return "running";
}

function toolActivity(
	toolValue: unknown,
	budget: AdapterTraversalBudget,
	parentId: string,
	originalIndex: number,
): ActivitySnapshot | undefined {
	const tool = asRecord(toolValue, budget);
	if (!tool) return undefined;
	const name = firstString(budget, tool.name) ?? "tool";
	const id = firstString(budget, tool.id) ?? `${parentId}:tool:${name}:${originalIndex}`;
	const done = tool.done === true;
	const isError = tool.isError === true;
	const rawOutput = firstString(budget, tool.outputPreview);
	const rawArgs = firstString(budget, tool.argsPreview);
	const output = rawOutput ? boundedText(rawOutput, CHILD_PREVIEW_MAX) : undefined;
	const args = rawArgs ? boundedText(rawArgs, CHILD_PREVIEW_MAX) : undefined;
	const projected: MutableActivitySnapshot = {
		id,
		kind: "tool",
		title: name,
		status: done ? (isError ? "failed" : "succeeded") : "running",
	};
	if (args) projected.invocation = args;
	if (output) projected.outputTail = output;
	if (done && (output || isError)) {
		const resultSummary: ResultSummary = {};
		if (output) resultSummary.summary = output;
		if (isError) resultSummary.error = output ?? `${name} failed`;
		projected.result = resultSummary;
	}
	return projected;
}

interface SubagentPaneInvocation {
	agentName?: string;
	workspaceId?: string;
	tabId?: string;
	paneId?: string;
}

interface SubagentWorktreeInvocation {
	path?: string;
	branch?: string;
	baseRef?: string;
}

interface SubagentInvocation {
	prompt: string;
	cwd?: string;
	baseRef?: string;
	visible?: boolean;
	pane?: SubagentPaneInvocation;
	worktree?: SubagentWorktreeInvocation;
}

function invocationFromSubagent(record: Record<string, unknown>, budget: AdapterTraversalBudget): SubagentInvocation {
	const pane = asRecord(record.pane, budget);
	const worktree = asRecord(record.worktree, budget);
	const prompt = firstString(budget, record.prompt) ?? "subagent";
	const cwd = firstString(budget, record.cwd);
	const baseRef = firstString(budget, record.baseRef);
	const agentName = firstString(budget, pane?.agentName);
	const workspaceId = firstString(budget, pane?.workspaceId);
	const tabId = firstString(budget, pane?.tabId);
	const paneRef = firstString(budget, pane?.paneId);
	const worktreePath = firstString(budget, worktree?.path);
	const worktreeBranch = firstString(budget, worktree?.branch);
	const worktreeBaseRef = firstString(budget, worktree?.baseRef);
	const invocation: SubagentInvocation = { prompt: boundedText(prompt, PROMPT_MAX) };
	if (cwd) invocation.cwd = cwd;
	if (baseRef) invocation.baseRef = baseRef;
	if (record.visible === true) invocation.visible = true;
	if (pane) {
		const projectedPane: SubagentPaneInvocation = {};
		if (agentName) projectedPane.agentName = agentName;
		if (workspaceId) projectedPane.workspaceId = workspaceId;
		if (tabId) projectedPane.tabId = tabId;
		if (paneRef) projectedPane.paneId = paneRef;
		invocation.pane = projectedPane;
	}
	if (worktree) {
		const projectedWorktree: SubagentWorktreeInvocation = {};
		if (worktreePath) projectedWorktree.path = worktreePath;
		if (worktreeBranch) projectedWorktree.branch = worktreeBranch;
		if (worktreeBaseRef) projectedWorktree.baseRef = worktreeBaseRef;
		invocation.worktree = projectedWorktree;
	}
	return invocation;
}

function activityFromSubagentRecord(record: Record<string, unknown>, budget: AdapterTraversalBudget): ActivitySnapshot {
	const id = firstString(budget, record.id) ?? "unknown";
	const pane = asRecord(record.pane, budget);
	const worktree = asRecord(record.worktree, budget);
	const status = subagentStatus(record, budget);
	const liveText = firstString(budget, record.liveText);
	const finalText = firstString(budget, record.finalText);
	// Queued children have not produced output or a current step yet.
	const output = status === "running" ? liveText ?? finalText : undefined;
	const error = status === "failed" || status === "cancelled" ? firstString(budget, record.errorText) : undefined;
	const summary = status === "succeeded" || status === "failed" || status === "cancelled" ? finalText : undefined;
	const liveTools = boundedPriorityArray(record.liveTools, MAX_CHILD_TOOLS, budget, isUnfinishedToolValue)
		.map(({ value, originalIndex }) => toolActivity(value, budget, `subagent:${id}`, originalIndex))
		.filter((tool): tool is ActivitySnapshot => tool !== undefined);
	const usage = asRecord(record.usage, budget);
	const manifest = asRecord(record.manifest, budget);
	const createdAt = numberFrom(record.createdAt);
	const settledAt = numberFrom(record.settledAt);
	const explicitElapsed = numberFrom(manifest?.durationMs);
	const elapsedMs = explicitElapsed ?? (createdAt !== undefined && settledAt !== undefined ? Math.max(0, settledAt - createdAt) : undefined);
	const tokens = numberFrom(usage?.tokens);
	const contextWindow = numberFrom(usage?.contextWindow);
	const costUsd = numberFrom(usage?.costUsd);
	const turns = numberFrom(usage?.turns);
	let metrics: MutableActivityMetrics | undefined;
	if ([tokens, contextWindow, costUsd, turns, elapsedMs].some((value) => value !== undefined && value > 0)) {
		const parsedMetrics: MutableActivityMetrics = {};
		if (tokens !== undefined && tokens > 0) parsedMetrics.tokens = tokens;
		if (contextWindow !== undefined && contextWindow > 0) parsedMetrics.contextWindow = contextWindow;
		if (costUsd !== undefined && costUsd > 0) parsedMetrics.costUsd = costUsd;
		if (turns !== undefined && turns > 0) parsedMetrics.turns = turns;
		if (elapsedMs !== undefined && elapsedMs > 0) parsedMetrics.elapsedMs = elapsedMs;
		metrics = parsedMetrics;
	}
	const paneLabel = paneId(pane, budget);
	const branch = firstString(budget, worktree?.branch);
	const subject = [id, paneLabel ? `pane ${paneLabel}` : undefined, branch].filter((part): part is string => !!part).join(" · ");
	const outputLastLine = output?.split("\n").filter((line) => line.trim().length > 0).at(-1);
	// Keep queued cards structural until their backend actually starts.
	const currentStep = status === "running"
		? outputLastLine ? boundedText(outputLastLine.trim(), 256) : paneLabel ? `pane ${paneLabel} · running` : undefined
		: undefined;
	const title = firstString(budget, record.title) ?? "subagent";
	const sourceId = firstString(budget, record.sourceId);
	const model = firstString(budget, record.modelLabel);
	const thinking = firstString(budget, record.thinkingLabel);
	const leadingOptionals: Partial<MutableActivitySnapshot> = {};
	if (sourceId) leadingOptionals.sourceId = sourceId;
	const activity: MutableActivitySnapshot = {
		// Plan 082's canonical manager identity remains subagent:<sa-id>;
		// sourceId carries the spawn-call correlation through manager/feed updates.
		id: `subagent:${id}`,
		...leadingOptionals,
		kind: "subagent",
		title,
		status,
		invocation: invocationFromSubagent(record, budget),
		subject,
	};
	if (currentStep) activity.currentStep = currentStep;
	if (output) activity.outputTail = boundedText(output);
	if (liveTools.length > 0) activity.activeTools = liveTools;
	if (summary || error) {
		const resultSummary: ResultSummary = {};
		if (summary) resultSummary.summary = boundedText(summary);
		if (error) resultSummary.error = boundedText(error);
		activity.result = resultSummary;
	}
	if (createdAt !== undefined) activity.createdAt = createdAt;
	if (settledAt !== undefined) activity.settledAt = settledAt;
	if (model) activity.model = model;
	if (thinking) activity.thinking = thinking;
	if (metrics) activity.metrics = metrics;
	return activity;
}

/** Project a manager snapshot into a bounded renderer-neutral Activity. */
export function activityFromSubagentSnapshot(snapshot: SubagentSnapshot): ActivitySnapshot {
	const budget = createAdapterTraversalBudget({ maxNodes: ADAPTER_MAX_NODES, maxChars: ADAPTER_MAX_CHARS });
	// SAFETY: SubagentSnapshot is a plain producer-owned object, so its runtime shape is a string-keyed record.
	const loose: unknown = snapshot;
	// SAFETY: the adapter only reads and sanitizes the record's fields; no mutation occurs.
	return activityFromSubagentRecord(loose as Record<string, unknown>, budget);
}

function activityEnvelopes(
	details: Record<string, unknown> | undefined,
	budget: AdapterTraversalBudget,
): ActivitySnapshot[] {
	const value = details?.activity;
	const values = Array.isArray(value) ? boundedArray(value, MAX_OPERATION_ACTIVITIES, budget) : value === undefined ? [] : [value];
	return values.map((item) => {
		const coreBudget = createAdapterTraversalBudget({ maxNodes: OPERATION_CORE_MAX_NODES, maxChars: OPERATION_CORE_MAX_CHARS });
		const optionalBudget = createAdapterTraversalBudget({ maxNodes: OPERATION_OPTIONAL_MAX_NODES, maxChars: OPERATION_OPTIONAL_MAX_CHARS });
		return boundedEnvelope(item, optionalBudget, 0, coreBudget);
	}).filter((activity): activity is ActivitySnapshot => activity !== undefined);
}

function subagentRecordValues(details: Record<string, unknown> | undefined, budget: AdapterTraversalBudget): unknown[] {
	const records: unknown[] = [];
	if (details?.subagent !== undefined) records.push(details.subagent);
	records.push(...boundedArray(details?.subagents, MAX_OPERATION_ACTIVITIES, budget));
	return records.slice(0, MAX_OPERATION_ACTIVITIES);
}

function activityFromOperationSubagent(value: unknown): ActivitySnapshot | undefined {
	const budget = createAdapterTraversalBudget({ maxNodes: OPERATION_SNAPSHOT_MAX_NODES, maxChars: OPERATION_SNAPSHOT_MAX_CHARS });
	const record = asRecord(value, budget);
	return record ? activityFromSubagentRecord(record, budget) : undefined;
}

interface SpawnInvocationArguments {
	readonly [key: string]: string | boolean | undefined;
}

function spawnInvocation(record: Record<string, unknown>, budget: AdapterTraversalBudget): SpawnInvocationArguments {
	const args = asRecord(record.arguments ?? record.input, budget) ?? {};
	const projected: Record<string, string | boolean | undefined> = {};
	for (const key of ["prompt", "name", "model", "thinking", "working_dir", "worktree", "branch", "baseRef", "visible"] as const) {
		const value = args[key];
		if (isStringValue(value)) projected[key] = boundedAdapterText(value, key === "prompt" ? PROMPT_MAX : 1_000, budget);
		else if (isBooleanValue(value)) projected[key] = value;
	}
	return projected;
}

function spawnToolActivity(record: Record<string, unknown>, toolCallId: string, budget: AdapterTraversalBudget): ActivitySnapshot {
	const isError = record.isError === true;
	const status = normalizePiActivityStatus(record.status, record.type === "toolResult" || record.role === "toolResult" ? (isError ? "failed" : "succeeded") : "queued");
	const output = textFromContent(record.content, budget);
	const spawn: MutableActivitySnapshot = {
		id: toolCallId,
		kind: "tool",
		title: "subagent_spawn",
		status,
		invocation: spawnInvocation(record, budget),
	};
	if (output) spawn.outputTail = output;
	if (isError && output) spawn.result = { error: output };
	return spawn;
}

/** Project subagent tool details; wait/cancel may yield several canonical updates. */
export function activitiesFromSubagentToolRecord(
	recordValue: unknown,
	context: { readonly toolCallId?: string },
): readonly ActivitySnapshot[] {
	const budget = createAdapterTraversalBudget({ maxNodes: ADAPTER_MAX_NODES, maxChars: ADAPTER_MAX_CHARS });
	const record = asRecord(recordValue, budget);
	if (!record) return [];
	const toolName = firstString(budget, record.name, record.toolName);
	if (!toolName?.startsWith("subagent_")) return [];
	if (toolName === "subagent_send" || toolName === "subagent_list") return [];
	const details = asRecord(record.details, budget);
	const enveloped = activityEnvelopes(details, budget);
	const snapshots = enveloped.length > 0
		? enveloped
		: subagentRecordValues(details, budget)
			.map(activityFromOperationSubagent)
			.filter((activity): activity is ActivitySnapshot => activity !== undefined);
	if (snapshots.length > 0) {
		return snapshots.map((activity) => toolName === "subagent_spawn" && context.toolCallId && !activity.sourceId
			? { ...activity, sourceId: context.toolCallId }
			: activity);
	}
	if (toolName !== "subagent_spawn" || !context.toolCallId) return [];
	return [spawnToolActivity(record, context.toolCallId, budget)];
}

/** Map passive completion messages, including historical payloads without an envelope. */
export function activityFromSubagentResultRecord(recordValue: unknown): ActivitySnapshot {
	const budget = createAdapterTraversalBudget({ maxNodes: ADAPTER_MAX_NODES, maxChars: ADAPTER_MAX_CHARS });
	const record = asRecord(recordValue, budget) ?? {};
	const details = asRecord(record.details, budget);
	const enveloped = activityEnvelopes(details, budget)[0];
	if (enveloped) return enveloped;
	const id = firstString(budget, details?.id, record.subagentId) ?? "unknown";
	const title = firstString(budget, details?.title, record.title) ?? "subagent";
	const status = subagentStatus({
		status: details?.status ?? record.status,
		manifest: details?.manifest ?? record.manifest,
		errorText: details?.errorText ?? record.errorText,
	}, budget);
	const content = textFromContent(record.content, budget);
	const activity: MutableActivitySnapshot = {
		id: `subagent:${id}`,
		kind: "subagent",
		title,
		status,
		subject: id,
	};
	if (content) {
		activity.result = status === "failed" || status === "cancelled"
			? { error: content }
			: { summary: content };
	}
	return activity;
}
