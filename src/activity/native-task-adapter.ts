// oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type -- I/O boundary parser (native task payload parsing boundary): inputs are untrusted producer JSON,
// so `unknown` parameters and open string-keyed records are this module's real input contract.
import type { ActivitySnapshot, ActivityStatus } from "./domain.js";
import {
	boundedAdapterPreview,
	boundedAdapterText,
	boundedArray,
	boundedArrayTail,
	boundedArrayTailWithIndices,
	boundedPriorityArray,
	boundedRecord,
	createAdapterTraversalBudget,
	firstBoundedAdapterString,
	type AdapterTraversalBudget,
} from "./adapter-bounds.js";
import { normalizePiActivityStatus, projectPiToolActivity } from "./pi-projector.js";

const TEXT_MAX = 16 * 1024;
const PROMPT_MAX = 4 * 1024;
const CHILD_OUTPUT_MAX = 4 * 1024;
const TOOL_PREVIEW_MAX = 1_024;
const MAX_RESULTS = 16;
const MAX_TOOLS_PER_RESULT = 16;
const MAX_MESSAGES_PER_RESULT = 128;
const MAX_CONTENT_PARTS = 64;
const ADAPTER_MAX_NODES = 32_768;
const ADAPTER_MAX_CHARS = 768 * 1024;

function asRecord(value: unknown, budget: AdapterTraversalBudget): Record<string, unknown> | undefined {
	return boundedRecord(value, budget);
}

function boundedText(value: string, maxChars = TEXT_MAX): string {
	return value.length <= maxChars ? value : `${value.slice(0, Math.max(0, maxChars - 1))}…`;
}

function firstString(budget: AdapterTraversalBudget, ...values: unknown[]): string | undefined {
	return firstBoundedAdapterString(budget, TEXT_MAX, ...values);
}

function isNumberValue(value: unknown): value is number {
	return typeof value === "number";
}

function isBooleanValue(value: unknown): value is boolean {
	return typeof value === "boolean";
}

function isStringValue(value: unknown): value is string {
	return typeof value === "string";
}

function isRecordLike(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function numberFrom(value: unknown): number | undefined {
	return isNumberValue(value) && Number.isFinite(value) ? value : undefined;
}

function booleanFrom(value: unknown): boolean | undefined {
	return isBooleanValue(value) ? value : undefined;
}

/** Bounded producer-shaped arguments payload handed to the projector. */
type ToolArgumentsPayload =
	| string
	| number
	| boolean
	| null
	| readonly ToolArgumentsPayload[]
	| { readonly [key: string]: ToolArgumentsPayload };

function boundedUnknown(value: unknown, budget: AdapterTraversalBudget): ToolArgumentsPayload {
	const preview = boundedAdapterPreview(value, budget, {
		maxChars: 2_000,
		maxDepth: 4,
		maxEntries: 24,
		maxStringChars: 500,
		maxNodes: 64,
	});
	try {
		return JSON.parse(preview);
	} catch {
		return { preview };
	}
}

function textFromContent(content: unknown, budget: AdapterTraversalBudget): string | undefined {
	if (isStringValue(content)) return boundedAdapterText(content, TEXT_MAX, budget);
	const parts = boundedArray(content, MAX_CONTENT_PARTS, budget);
	if (parts.length === 0) return undefined;
	let text = "";
	for (const part of parts) {
		const record = asRecord(part, budget);
		if (record?.type !== "text") continue;
		const chunk = boundedAdapterText(record.text, TEXT_MAX - text.length, budget);
		if (chunk) text += chunk;
		if (text.length >= TEXT_MAX) break;
	}
	return text.trim().length > 0 ? boundedText(text) : undefined;
}

function assistantTextFromMessages(messages: unknown, budget: AdapterTraversalBudget): string | undefined {
	const values = boundedArrayTail(messages, MAX_MESSAGES_PER_RESULT, budget);
	for (let index = values.length - 1; index >= 0; index -= 1) {
		const message = asRecord(values[index], budget);
		if (message?.role !== "assistant") continue;
		const text = textFromContent(message.content, budget) ?? firstString(budget, message.text);
		if (text) return text;
	}
	return undefined;
}

function taskPromptLines(prompt: string): string[] {
	return prompt
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && !/^you(?: are|'re)\b/i.test(line));
}

function headingFromLine(line: string): string | undefined {
	return line.match(/^#{2,6}\s+(.+?)\s*#*$/)?.[1]?.trim();
}

function taskTitle(prompt: string): string {
	const lines = taskPromptLines(prompt);
	const heading = lines.map(headingFromLine).find((line): line is string => !!line);
	const title = heading ?? lines[0] ?? prompt.trim() ?? "task";
	return boundedText(title || "task", 80);
}

function taskStatus(result: Record<string, unknown>, fallback: ActivityStatus, budget: AdapterTraversalBudget): ActivityStatus {
	const stopReason = firstString(budget, result.stopReason)?.toLowerCase();
	if (stopReason === "aborted" || stopReason === "cancelled" || stopReason === "canceled" || result.cancelled === true) return "cancelled";
	const exitCode = numberFrom(result.exitCode);
	if ((exitCode !== undefined && exitCode > 0) || stopReason === "error" || result.isError === true) return "failed";
	if (exitCode === -1) return "running";
	if (exitCode === -2) return "queued";
	if (exitCode !== undefined && exitCode >= 0) return "succeeded";
	return normalizePiActivityStatus(result.status, fallback);
}

function aggregateStatus(statuses: readonly ActivityStatus[], fallback: ActivityStatus): ActivityStatus {
	// Plan 082 deliberately defines one mode-independent precedence: any known
	// failure is immediately visible even while sibling parallel work winds down.
	if (statuses.includes("failed")) return "failed";
	if (statuses.includes("cancelled")) return "cancelled";
	if (statuses.includes("running")) return "running";
	if (statuses.includes("queued")) return "queued";
	if (statuses.length > 0 && statuses.every((status) => status === "succeeded")) return "succeeded";
	return fallback;
}

function resultOutput(result: Record<string, unknown>, budget: AdapterTraversalBudget): string | undefined {
	const output = firstString(budget, result.finalOutput)
		?? assistantTextFromMessages(result.messages, budget)
		?? firstString(budget, result.streamingText);
	return output ? boundedText(output, CHILD_OUTPUT_MAX) : undefined;
}

function resultError(result: Record<string, unknown>, budget: AdapterTraversalBudget): string | undefined {
	const error = firstString(budget, result.errorMessage, result.stderr, result.error);
	return error ? boundedText(error, CHILD_OUTPUT_MAX) : undefined;
}

interface ActivityResultSummary {
	summary?: string;
	error?: string;
}

/** Writable mirrors used to assemble snapshots field-by-field before returning them. */
type MutableActivitySnapshot = { -readonly [K in keyof ActivitySnapshot]: ActivitySnapshot[K] };
type MutableActivityMetrics = {
	-readonly [K in keyof NonNullable<ActivitySnapshot["metrics"]>]: NonNullable<ActivitySnapshot["metrics"]>[K];
};

interface ProjectedInvocation {
	prompt: string;
	skill?: string;
	model?: string;
	thinking?: string;
	fork?: boolean;
}

interface ProjectedInvocationRecord {
	type: string;
	tasks: readonly ProjectedInvocation[];
}

function projectedInvocationItem(
	result: Record<string, unknown>,
	source: Record<string, unknown> | undefined,
	budget: AdapterTraversalBudget,
): ProjectedInvocation {
	const prompt = firstString(budget, result.prompt, source?.prompt, source?.task) ?? "task";
	const item: ProjectedInvocation = { prompt: boundedText(prompt, PROMPT_MAX) };
	const skill = firstString(budget, result.skill, source?.skill);
	const model = firstString(budget, result.model, source?.model);
	const thinking = firstString(budget, result.thinking, source?.thinking);
	const fork = booleanFrom(result.fork ?? source?.fork);
	if (skill) item.skill = boundedText(skill, 256);
	if (model) item.model = boundedText(model, 256);
	if (thinking) item.thinking = boundedText(thinking, 64);
	if (fork !== undefined) item.fork = fork;
	return item;
}

function invocationFromRecord(
	record: Record<string, unknown>,
	mode: string,
	results: readonly Record<string, unknown>[],
	budget: AdapterTraversalBudget,
): ProjectedInvocationRecord | undefined {
	const args = asRecord(record.arguments ?? record.input, budget);
	const argumentTasks = boundedArray(args?.tasks, MAX_RESULTS, budget)
		.map((value) => asRecord(value, budget))
		.filter((task): task is Record<string, unknown> => task !== undefined);
	const count = Math.max(results.length, argumentTasks.length, args ? 1 : 0);
	if (count === 0) return undefined;
	const tasks = Array.from({ length: Math.min(count, MAX_RESULTS) }, (_, index) => {
		const result = results[index] ?? {};
		const source = argumentTasks[index] ?? (index === 0 ? args : undefined);
		return projectedInvocationItem(result, source, budget);
	});
	return { type: mode, tasks };
}

function nestedToolStatus(value: unknown): ActivityStatus {
	return normalizePiActivityStatus(value, "queued");
}

function isRunningToolValue(value: unknown): boolean {
	if (!isRecordLike(value)) return false;
	const status = value.status;
	return status === "pending" || status === "queued" || status === "running";
}

function isActiveSnapshot(value: unknown): value is ActivitySnapshot {
	if (!isRecordLike(value)) return false;
	return value.status === "queued" || value.status === "running";
}

function boundedToolActivities(
	activities: readonly ActivitySnapshot[],
	budget: AdapterTraversalBudget,
): ActivitySnapshot[] {
	// SAFETY: activities arrives as ActivitySnapshot[] and boundedPriorityArray only filters/reorders entries.
	return boundedPriorityArray(activities, MAX_TOOLS_PER_RESULT, budget, isActiveSnapshot)
		.map((entry) => entry.value as ActivitySnapshot);
}

function nestedToolsFromMessages(
	messages: unknown,
	parentId: string,
	resultIndex: number,
	budget: AdapterTraversalBudget,
): ActivitySnapshot[] {
	const tools = new Map<string, ActivitySnapshot>();
	const unresolvedByName = new Map<string, string[]>();
	const rememberUnresolved = (name: string, id: string): void => {
		unresolvedByName.set(name, [...(unresolvedByName.get(name) ?? []), id]);
	};
	const resolveByName = (name: string, fallbackId: string, explicitId?: string): string => {
		const unresolved = unresolvedByName.get(name) ?? [];
		if (explicitId) {
			const index = unresolved.indexOf(explicitId);
			if (index !== -1) unresolved.splice(index, 1);
			return explicitId;
		}
		return unresolved.shift() ?? fallbackId;
	};
	for (const { value: messageValue, originalIndex: messageIndex } of boundedArrayTailWithIndices(messages, MAX_MESSAGES_PER_RESULT, budget)) {
		const message = asRecord(messageValue, budget);
		if (!message) continue;
		if (message.role === "assistant") {
			for (const [partIndex, part] of boundedArray(message.content, MAX_CONTENT_PARTS, budget).entries()) {
				const call = asRecord(part, budget);
				if (call?.type !== "toolCall") continue;
				const name = firstString(budget, call.name, call.toolName) ?? "tool";
				const id = firstString(budget, call.id, call.toolCallId)
					?? `${parentId}:result:${resultIndex}:tool:${name}:message:${messageIndex}:part:${partIndex}`;
				const activity = projectPiToolActivity({
					toolCallId: id,
					name,
					status: "running",
					arguments: boundedUnknown(call.arguments ?? call.input, budget),
				}, { messageId: parentId, blockIndex: resultIndex, requireToolCallId: true });
				if (activity) {
					tools.set(id, activity);
					rememberUnresolved(name, id);
				}
			}
		}
		if (message.role === "toolResult") {
			const name = firstString(budget, message.toolName, message.name) ?? "tool";
			const id = resolveByName(
				name,
				`${parentId}:result:${resultIndex}:tool:${name}:message:${messageIndex}:result`,
				firstString(budget, message.toolCallId, message.id),
			);
			const existing = tools.get(id);
			const output = textFromContent(message.content, budget);
			const activity = projectPiToolActivity({
				toolCallId: id,
				name,
				status: message.isError === true ? "error" : "success",
				arguments: existing?.invocation,
				content: output ? [{ type: "text", text: output }] : [],
				isError: message.isError,
			}, { messageId: parentId, blockIndex: resultIndex, requireToolCallId: true });
			if (activity) tools.set(id, activity);
		}
	}
	return boundedToolActivities([...tools.values()], budget);
}

function nestedToolsFromResult(
	result: Record<string, unknown>,
	parentId: string,
	resultIndex: number,
	budget: AdapterTraversalBudget,
): ActivitySnapshot[] {
	const events = boundedPriorityArray(result.toolEvents, MAX_TOOLS_PER_RESULT, budget, isRunningToolValue)
		.map(({ value, originalIndex }) => ({ event: asRecord(value, budget), originalIndex }))
		.filter((entry): entry is { event: Record<string, unknown>; originalIndex: number } => entry.event !== undefined);
	if (events.length === 0) return nestedToolsFromMessages(result.messages, parentId, resultIndex, budget);
	return events.flatMap(({ event, originalIndex }): ActivitySnapshot[] => {
		const name = firstString(budget, event.name, event.toolName) ?? "tool";
		const id = firstString(budget, event.id, event.toolCallId) ?? `${parentId}:result:${resultIndex}:tool:${name}:${originalIndex}`;
		const rawOutput = firstString(budget, event.output, event.text);
		const output = rawOutput ? boundedText(rawOutput, TOOL_PREVIEW_MAX) : undefined;
		const activity = projectPiToolActivity({
			toolCallId: id,
			name,
			status: nestedToolStatus(event.status),
			arguments: boundedUnknown(event.args ?? event.input ?? event.arguments, budget),
			content: output ? [{ type: "text", text: output }] : [],
			isError: nestedToolStatus(event.status) === "failed",
		}, { messageId: parentId, blockIndex: resultIndex, requireToolCallId: true });
		return activity ? [activity] : [];
	});
}

function metricsFromResult(result: Record<string, unknown>, budget: AdapterTraversalBudget): ActivitySnapshot["metrics"] | undefined {
	const usage = asRecord(result.usage, budget);
	const tokensIn = numberFrom(usage?.input);
	const tokensOut = numberFrom(usage?.output);
	const usageCost = usage?.cost;
	const costUsd = numberFrom(usageCost) ?? numberFrom(asRecord(usageCost, budget)?.total);
	const turns = numberFrom(usage?.turns);
	const explicitElapsed = numberFrom(result.elapsedMs ?? result.durationMs);
	const startedAt = numberFrom(result.startedAt ?? result.createdAt);
	const settledAt = numberFrom(result.settledAt ?? result.endedAt);
	const elapsedMs = explicitElapsed ?? (startedAt !== undefined && settledAt !== undefined ? Math.max(0, settledAt - startedAt) : undefined);
	if (![tokensIn, tokensOut, costUsd, turns, elapsedMs].some((value) => value !== undefined && value > 0)) return undefined;
	const metrics: MutableActivityMetrics = {};
	if (tokensIn !== undefined && tokensIn > 0) metrics.tokensIn = tokensIn;
	if (tokensOut !== undefined && tokensOut > 0) metrics.tokensOut = tokensOut;
	if (costUsd !== undefined && costUsd > 0) metrics.costUsd = costUsd;
	if (turns !== undefined && turns > 0) metrics.turns = turns;
	if (elapsedMs !== undefined && elapsedMs > 0) metrics.elapsedMs = elapsedMs;
	return metrics;
}

function sumMetric(results: readonly ActivitySnapshot[], key: keyof NonNullable<ActivitySnapshot["metrics"]>): number | undefined {
	const values = results.map((result) => result.metrics?.[key]).filter((value): value is number => value !== undefined);
	return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) : undefined;
}

function aggregateMetrics(results: readonly ActivitySnapshot[]): ActivitySnapshot["metrics"] | undefined {
	const tokensIn = sumMetric(results, "tokensIn");
	const tokensOut = sumMetric(results, "tokensOut");
	const costUsd = sumMetric(results, "costUsd");
	const turns = sumMetric(results, "turns");
	const elapsedMs = sumMetric(results, "elapsedMs");
	if ([tokensIn, tokensOut, costUsd, turns, elapsedMs].every((value) => value === undefined)) return undefined;
	const metrics: MutableActivityMetrics = {};
	if (tokensIn !== undefined) metrics.tokensIn = tokensIn;
	if (tokensOut !== undefined) metrics.tokensOut = tokensOut;
	if (costUsd !== undefined) metrics.costUsd = costUsd;
	if (turns !== undefined) metrics.turns = turns;
	if (elapsedMs !== undefined) metrics.elapsedMs = elapsedMs;
	return metrics;
}

function childActivity(
	result: Record<string, unknown>,
	parentId: string,
	index: number,
	fallbackStatus: ActivityStatus,
	budget: AdapterTraversalBudget,
): ActivitySnapshot {
	const prompt = firstString(budget, result.prompt) ?? "task";
	const status = taskStatus(result, fallbackStatus, budget);
	const output = resultOutput(result, budget);
	const error = resultError(result, budget);
	const activeTools = nestedToolsFromResult(result, parentId, index, budget);
	const metrics = metricsFromResult(result, budget);
	const model = firstString(budget, result.model);
	const thinking = firstString(budget, result.thinking);
	const child: MutableActivitySnapshot = {
		id: `${parentId}:result:${index}`,
		kind: "task",
		title: taskTitle(prompt),
		status,
		invocation: projectedInvocationItem(result, undefined, budget),
		subject: `task ${numberFrom(result.index) ?? index + 1}`,
	};
	if (status === "running") child.currentStep = taskTitle(prompt);
	if (output) child.outputTail = output;
	if (activeTools.length > 0) child.activeTools = activeTools;
	if (status === "failed" || status === "cancelled" || status === "succeeded") {
		const resultSummary: ActivityResultSummary = {};
		if (output) resultSummary.summary = output;
		if (error) resultSummary.error = error;
		child.result = resultSummary;
	}
	if (model) child.model = model;
	if (thinking) child.thinking = thinking;
	if (metrics) child.metrics = metrics;
	return child;
}

function labeledOutput(child: ActivitySnapshot, index: number, total: number): string | undefined {
	const text = child.result?.summary ?? child.outputTail;
	if (!text) return undefined;
	return total === 1 ? text : `Task ${index + 1}: ${text}`;
}

function labeledError(child: ActivitySnapshot, index: number, total: number): string | undefined {
	if (child.status !== "failed" && child.status !== "cancelled") return undefined;
	const text = child.result?.error ?? (child.status === "cancelled" ? "cancelled" : undefined);
	if (!text) return undefined;
	return total === 1 ? text : `Task ${index + 1}: ${text}`;
}

/** Parse native task tool details without importing its private execution types. */
export function activityFromNativeTaskRecord(
	recordValue: unknown,
	context: { readonly toolCallId?: string; readonly fallbackStatus: ActivityStatus },
): ActivitySnapshot {
	const budget = createAdapterTraversalBudget({ maxNodes: ADAPTER_MAX_NODES, maxChars: ADAPTER_MAX_CHARS });
	const record = asRecord(recordValue, budget) ?? {};
	const details = asRecord(record.details, budget);
	const args = asRecord(record.arguments ?? record.input, budget);
	const mode = firstString(budget, details?.mode, args?.type) ?? "single";
	const resultRecords = boundedArray(details?.results, MAX_RESULTS, budget)
		.map((value) => asRecord(value, budget))
		.filter((result): result is Record<string, unknown> => result !== undefined);
	const id = context.toolCallId ?? firstString(budget, record.toolCallId, record.id) ?? "native-task";
	const invocation = invocationFromRecord(record, mode, resultRecords, budget);
	const argumentTasks = boundedArray(args?.tasks, MAX_RESULTS, budget)
		.map((value) => asRecord(value, budget))
		.filter((task): task is Record<string, unknown> => task !== undefined);
	const fallbackPrompt = firstString(budget, argumentTasks[0]?.prompt, args?.prompt, args?.task, record.prompt, record.task) ?? "task";
	const children = resultRecords.map((result, index) => childActivity(result, id, index, context.fallbackStatus, budget));
	const statuses = children.map((child) => child.status);
	const status = record.isError === true
		? "failed"
		: aggregateStatus(statuses, normalizePiActivityStatus(record.status, context.fallbackStatus));
	const firstPrompt = firstString(budget, resultRecords[0]?.prompt, fallbackPrompt) ?? "task";
	const outputFromRecord = textFromContent(record.content, budget) ?? firstString(budget, record.output);
	const summaries = children.map((child, index) => labeledOutput(child, index, children.length)).filter((text): text is string => !!text);
	const errors = children.map((child, index) => labeledError(child, index, children.length)).filter((text): text is string => !!text);
	const completed = children.filter((child) => child.status === "succeeded" || child.status === "failed" || child.status === "cancelled").length;
	const current = children.find((child) => child.status === "running")
		?? children.find((child) => child.status === "failed" || child.status === "cancelled")
		?? children.find((child) => child.status === "queued")
		?? children.at(-1);
	const progress = children.length > 1
		? `${completed}/${children.length}${current ? ` · ${current.title}` : ""}`
		: status === "running" ? taskTitle(firstPrompt) : undefined;
	const single = children[0];
	const outputTail = children.length === 1
		? single?.outputTail ?? outputFromRecord
		: children.some((child) => child.status === "running") ? summaries.at(-1) : undefined;
	const summary = summaries.length > 0 ? boundedText(summaries.join("\n")) : status === "succeeded" ? outputFromRecord : undefined;
	const error = errors.length > 0 ? boundedText(errors.join("\n")) : record.isError === true ? outputFromRecord : undefined;
	const activeTools = children.length > 1 ? children : single?.activeTools;
	const childMetrics = children.length > 0 ? aggregateMetrics(children) : undefined;
	const startedAt = numberFrom(details?.startedAt ?? record.startedAt ?? record.createdAt);
	const updatedAt = numberFrom(details?.updatedAt ?? record.updatedAt);
	const parentElapsed = numberFrom(details?.elapsedMs ?? details?.durationMs)
		?? (startedAt !== undefined && updatedAt !== undefined ? Math.max(0, updatedAt - startedAt) : undefined);
	let metrics: ActivitySnapshot["metrics"];
	if (childMetrics || parentElapsed !== undefined) {
		const merged: MutableActivityMetrics = { ...childMetrics };
		if (parentElapsed !== undefined) merged.elapsedMs = parentElapsed;
		metrics = merged;
	}
	const model = single?.model ?? firstString(budget, details?.modelOverride, argumentTasks[0]?.model, args?.model, record.model);
	const thinking = single?.thinking ?? firstString(budget, argumentTasks[0]?.thinking, args?.thinking, record.thinking);
	const snapshot: MutableActivitySnapshot = { id, kind: "task", title: taskTitle(firstPrompt), status };
	if (invocation) snapshot.invocation = invocation;
	if (mode !== "single") snapshot.subject = `${mode} · ${Math.max(children.length, argumentTasks.length)} tasks`;
	if (progress) snapshot.currentStep = progress;
	if (outputTail) snapshot.outputTail = boundedText(outputTail);
	if (activeTools && activeTools.length > 0) snapshot.activeTools = activeTools;
	if (summary || error) {
		const resultSummary: ActivityResultSummary = {};
		if (summary) resultSummary.summary = summary;
		if (error) resultSummary.error = error;
		snapshot.result = resultSummary;
	}
	if (startedAt !== undefined) snapshot.createdAt = startedAt;
	if (updatedAt !== undefined) {
		snapshot.updatedAt = updatedAt;
		if (status === "succeeded" || status === "failed" || status === "cancelled") snapshot.settledAt = updatedAt;
	}
	if (model) snapshot.model = model;
	if (thinking) snapshot.thinking = thinking;
	if (metrics) snapshot.metrics = metrics;
	return snapshot;
}
