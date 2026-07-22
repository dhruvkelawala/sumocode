import type { ActivitySnapshot, ActivityStatus } from "./domain.js";
import { safeValuePreview, sanitizeActivityText } from "./domain.js";
import { normalizePiActivityStatus, projectPiToolActivity } from "./pi-projector.js";

const TEXT_MAX = 16 * 1024;
const PROMPT_MAX = 4 * 1024;
const CHILD_OUTPUT_MAX = 4 * 1024;
const TOOL_PREVIEW_MAX = 1_024;
const MAX_RESULTS = 16;
const MAX_TOOLS_PER_RESULT = 16;

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

function booleanFrom(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function boundedUnknown(value: unknown): unknown {
	const preview = safeValuePreview(value, { maxChars: 2_000, maxDepth: 4, maxEntries: 24, maxStringChars: 500 });
	try {
		return JSON.parse(preview) as unknown;
	} catch {
		return { preview };
	}
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

function assistantTextFromMessages(messages: unknown): string | undefined {
	if (!Array.isArray(messages)) return undefined;
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = asRecord(messages[index]);
		if (message?.role !== "assistant") continue;
		const text = textFromContent(message.content) ?? firstString(message.text);
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

function taskStatus(result: Record<string, unknown>, fallback: ActivityStatus): ActivityStatus {
	const stopReason = firstString(result.stopReason)?.toLowerCase();
	if (stopReason === "aborted" || stopReason === "cancelled" || stopReason === "canceled" || result.cancelled === true) return "cancelled";
	const exitCode = numberFrom(result.exitCode);
	if ((exitCode !== undefined && exitCode > 0) || stopReason === "error" || result.isError === true) return "failed";
	if (exitCode === -1) return "running";
	if (exitCode === -2) return "queued";
	if (exitCode !== undefined && exitCode >= 0) return "succeeded";
	return normalizePiActivityStatus(result.status, fallback);
}

function aggregateStatus(statuses: readonly ActivityStatus[], fallback: ActivityStatus): ActivityStatus {
	if (statuses.includes("failed")) return "failed";
	if (statuses.includes("cancelled")) return "cancelled";
	if (statuses.includes("running")) return "running";
	if (statuses.includes("queued")) return "queued";
	if (statuses.length > 0 && statuses.every((status) => status === "succeeded")) return "succeeded";
	return fallback;
}

function resultOutput(result: Record<string, unknown>): string | undefined {
	const output = firstString(
		result.finalOutput,
		assistantTextFromMessages(result.messages),
		result.streamingText,
	);
	return output ? boundedText(output, CHILD_OUTPUT_MAX) : undefined;
}

function resultError(result: Record<string, unknown>): string | undefined {
	const error = firstString(result.errorMessage, result.stderr, result.error);
	return error ? boundedText(error, CHILD_OUTPUT_MAX) : undefined;
}

function projectedInvocationItem(result: Record<string, unknown>, source?: Record<string, unknown>): Record<string, unknown> {
	const prompt = firstString(result.prompt, source?.prompt, source?.task) ?? "task";
	const item: Record<string, unknown> = { prompt: boundedText(prompt, PROMPT_MAX) };
	const skill = firstString(result.skill, source?.skill);
	const model = firstString(result.model, source?.model);
	const thinking = firstString(result.thinking, source?.thinking);
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
): Record<string, unknown> | undefined {
	const args = asRecord(record.arguments ?? record.input);
	const argumentTasks = Array.isArray(args?.tasks)
		? args.tasks.map(asRecord).filter((task): task is Record<string, unknown> => task !== undefined).slice(0, MAX_RESULTS)
		: [];
	const count = Math.max(results.length, argumentTasks.length, args ? 1 : 0);
	if (count === 0) return undefined;
	const tasks = Array.from({ length: Math.min(count, MAX_RESULTS) }, (_, index) => {
		const result = results[index] ?? {};
		const source = argumentTasks[index] ?? (index === 0 ? args : undefined);
		return projectedInvocationItem(result, source);
	});
	return { type: mode, tasks };
}

function nestedToolStatus(value: unknown): ActivityStatus {
	return normalizePiActivityStatus(value, "queued");
}

function nestedToolsFromMessages(
	messages: unknown,
	parentId: string,
	resultIndex: number,
): ActivitySnapshot[] {
	if (!Array.isArray(messages)) return [];
	const tools = new Map<string, ActivitySnapshot>();
	let fallbackIndex = 0;
	for (const messageValue of messages) {
		const message = asRecord(messageValue);
		if (!message) continue;
		if (message.role === "assistant" && Array.isArray(message.content)) {
			for (const part of message.content) {
				const call = asRecord(part);
				if (call?.type !== "toolCall") continue;
				const name = firstString(call.name, call.toolName) ?? "tool";
				const id = firstString(call.id, call.toolCallId) ?? `${parentId}:result:${resultIndex}:tool:${name}:${fallbackIndex++}`;
				const activity = projectPiToolActivity({
					toolCallId: id,
					name,
					status: "running",
					arguments: boundedUnknown(call.arguments ?? call.input),
				}, { messageId: parentId, blockIndex: resultIndex, requireToolCallId: true });
				if (activity) tools.set(id, activity);
			}
		}
		if (message.role === "toolResult") {
			const name = firstString(message.toolName, message.name) ?? "tool";
			const id = firstString(message.toolCallId, message.id) ?? `${parentId}:result:${resultIndex}:tool:${name}:${fallbackIndex++}`;
			const existing = tools.get(id);
			const activity = projectPiToolActivity({
				toolCallId: id,
				name,
				status: message.isError === true ? "error" : "success",
				arguments: existing?.invocation,
				content: message.content,
				isError: message.isError,
			}, { messageId: parentId, blockIndex: resultIndex, requireToolCallId: true });
			if (activity) tools.set(id, activity);
		}
	}
	return [...tools.values()].slice(0, MAX_TOOLS_PER_RESULT);
}

function nestedToolsFromResult(result: Record<string, unknown>, parentId: string, resultIndex: number): ActivitySnapshot[] {
	const events = Array.isArray(result.toolEvents)
		? result.toolEvents.map(asRecord).filter((event): event is Record<string, unknown> => event !== undefined).slice(0, MAX_TOOLS_PER_RESULT)
		: [];
	if (events.length === 0) return nestedToolsFromMessages(result.messages, parentId, resultIndex);
	return events.flatMap((event, toolIndex): ActivitySnapshot[] => {
		const name = firstString(event.name, event.toolName) ?? "tool";
		const id = firstString(event.id, event.toolCallId) ?? `${parentId}:result:${resultIndex}:tool:${name}:${toolIndex}`;
		const rawOutput = firstString(event.output, event.text);
		const output = rawOutput ? boundedText(rawOutput, TOOL_PREVIEW_MAX) : undefined;
		const activity = projectPiToolActivity({
			toolCallId: id,
			name,
			status: nestedToolStatus(event.status),
			arguments: boundedUnknown(event.args ?? event.input ?? event.arguments),
			content: output ? [{ type: "text", text: output }] : [],
			isError: nestedToolStatus(event.status) === "failed",
		}, { messageId: parentId, blockIndex: resultIndex, requireToolCallId: true });
		return activity ? [activity] : [];
	});
}

function metricsFromResult(result: Record<string, unknown>): ActivitySnapshot["metrics"] | undefined {
	const usage = asRecord(result.usage);
	const tokensIn = numberFrom(usage?.input);
	const tokensOut = numberFrom(usage?.output);
	const usageCost = usage?.cost;
	const costUsd = numberFrom(usageCost) ?? numberFrom(asRecord(usageCost)?.total);
	const turns = numberFrom(usage?.turns);
	const explicitElapsed = numberFrom(result.elapsedMs ?? result.durationMs);
	const startedAt = numberFrom(result.startedAt ?? result.createdAt);
	const settledAt = numberFrom(result.settledAt ?? result.endedAt);
	const elapsedMs = explicitElapsed ?? (startedAt !== undefined && settledAt !== undefined ? Math.max(0, settledAt - startedAt) : undefined);
	if (![tokensIn, tokensOut, costUsd, turns, elapsedMs].some((value) => value !== undefined && value > 0)) return undefined;
	return {
		...(tokensIn !== undefined && tokensIn > 0 ? { tokensIn } : {}),
		...(tokensOut !== undefined && tokensOut > 0 ? { tokensOut } : {}),
		...(costUsd !== undefined && costUsd > 0 ? { costUsd } : {}),
		...(turns !== undefined && turns > 0 ? { turns } : {}),
		...(elapsedMs !== undefined && elapsedMs > 0 ? { elapsedMs } : {}),
	};
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
	return {
		...(tokensIn === undefined ? {} : { tokensIn }),
		...(tokensOut === undefined ? {} : { tokensOut }),
		...(costUsd === undefined ? {} : { costUsd }),
		...(turns === undefined ? {} : { turns }),
		...(elapsedMs === undefined ? {} : { elapsedMs }),
	};
}

function childActivity(
	result: Record<string, unknown>,
	parentId: string,
	index: number,
	fallbackStatus: ActivityStatus,
): ActivitySnapshot {
	const prompt = firstString(result.prompt) ?? "task";
	const status = taskStatus(result, fallbackStatus);
	const output = resultOutput(result);
	const error = resultError(result);
	const activeTools = nestedToolsFromResult(result, parentId, index);
	const metrics = metricsFromResult(result);
	return {
		id: `${parentId}:result:${index}`,
		kind: "task",
		title: taskTitle(prompt),
		status,
		invocation: projectedInvocationItem(result),
		subject: `task ${numberFrom(result.index) ?? index + 1}`,
		...(status === "running" ? { currentStep: taskTitle(prompt) } : {}),
		...(output ? { outputTail: output } : {}),
		...(activeTools.length > 0 ? { activeTools } : {}),
		...(status === "failed" || status === "cancelled" || status === "succeeded"
			? { result: { ...(output ? { summary: output } : {}), ...(error ? { error } : {}) } }
			: {}),
		...(firstString(result.model) ? { model: firstString(result.model) } : {}),
		...(firstString(result.thinking) ? { thinking: firstString(result.thinking) } : {}),
		...(metrics ? { metrics } : {}),
	};
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
	const record = asRecord(recordValue) ?? {};
	const details = asRecord(record.details);
	const args = asRecord(record.arguments ?? record.input);
	const mode = firstString(details?.mode, args?.type) ?? "single";
	const resultRecords = (Array.isArray(details?.results) ? details.results : [])
		.map(asRecord)
		.filter((result): result is Record<string, unknown> => result !== undefined)
		.slice(0, MAX_RESULTS);
	const id = context.toolCallId ?? firstString(record.toolCallId, record.id) ?? "native-task";
	const invocation = invocationFromRecord(record, mode, resultRecords);
	const argumentTasks = Array.isArray(args?.tasks) ? args.tasks.map(asRecord).filter(Boolean) as Record<string, unknown>[] : [];
	const fallbackPrompt = firstString(argumentTasks[0]?.prompt, args?.prompt, args?.task, record.prompt, record.task) ?? "task";
	const children = resultRecords.map((result, index) => childActivity(result, id, index, context.fallbackStatus));
	const statuses = children.map((child) => child.status);
	const status = aggregateStatus(statuses, normalizePiActivityStatus(record.status, record.isError === true ? "failed" : context.fallbackStatus));
	const firstPrompt = firstString(resultRecords[0]?.prompt, fallbackPrompt) ?? "task";
	const outputFromRecord = textFromContent(record.content) ?? firstString(record.output);
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
	const metrics = childMetrics || parentElapsed !== undefined
		? { ...childMetrics, ...(parentElapsed !== undefined ? { elapsedMs: parentElapsed } : {}) }
		: undefined;
	const model = single?.model ?? firstString(details?.modelOverride, argumentTasks[0]?.model, args?.model, record.model);
	const thinking = single?.thinking ?? firstString(argumentTasks[0]?.thinking, args?.thinking, record.thinking);
	return {
		id,
		kind: "task",
		title: taskTitle(firstPrompt),
		status,
		...(invocation ? { invocation } : {}),
		...(mode === "single" ? {} : { subject: `${mode} · ${Math.max(children.length, argumentTasks.length)} tasks` }),
		...(progress ? { currentStep: progress } : {}),
		...(outputTail ? { outputTail: boundedText(outputTail) } : {}),
		...(activeTools && activeTools.length > 0 ? { activeTools } : {}),
		...(summary || error ? { result: { ...(summary ? { summary } : {}), ...(error ? { error } : {}) } } : {}),
		...(startedAt === undefined ? {} : { createdAt: startedAt }),
		...(updatedAt === undefined ? {} : { updatedAt }),
		...((status === "succeeded" || status === "failed" || status === "cancelled") && updatedAt !== undefined ? { settledAt: updatedAt } : {}),
		...(model ? { model } : {}),
		...(thinking ? { thinking } : {}),
		...(metrics ? { metrics } : {}),
	};
}
