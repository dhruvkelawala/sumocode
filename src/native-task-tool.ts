// oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type, anti-slop/require-safety-comment-for-type-assertion -- task tool boundary parser: subprocess JSONL events, Pi tool args, and skill frontmatter arrive
// as untrusted data, so runtime typeof decoding guards, open arg records, unknown-typed
// parse predicates, and parse-site assertions are this module's decoding contract.
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import {
	type ExtensionAPI,
	getAgentDir,
	loadSkills,
	SettingsManager,
	type Skill,
	type Theme,
	type ThemeColor,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	BoundedUtf8Head,
	BoundedUtf8Tail,
	CHILD_RETAINED_RESULT_MAX_BYTES,
	JsonLineDecoder,
	TRUNCATED_HEAD_MARKER,
	boundRetainedResult,
	boundStableIdentifier,
} from "./child-protocol.js";
import { type BuiltInToolName, getBuiltInToolsFromActiveTools, resolveTaskConfig } from "./native-task-config.js";
import {
	isRecord,
	MAX_PARALLEL_TASKS,
	normalizeTaskParams,
	type TaskThinking,
	type TaskWorkItem,
	VALID_THINKING_OPTIONS,
	type ThinkingLevel,
} from "./native-task-params.js";

export type PromptPatch = { match: RegExp; replace: string };

export type TaskToolOptions = {
	name: string;
	label: string;
	description: string;
	maxParallelTasks: number;
	maxConcurrency: number;
	collapsedItemCount: number;
	skillListLimit: number;
	systemPromptPatches: PromptPatch[];
};

const DEFAULT_OPTIONS: TaskToolOptions = {
	name: "task",
	label: "Task",
	description: [
		"Run isolated pi subprocess tasks (single, chain, or parallel).",
		"Supports optional skill wrapper (matches /skill: behavior) and optional model override (provider/modelId).",
	].join(" "),
	maxParallelTasks: MAX_PARALLEL_TASKS,
	maxConcurrency: 4,
	collapsedItemCount: 10,
	skillListLimit: 30,
	systemPromptPatches: [
		{
			match: /\n\s*\n\s*in addition to the tools above, you may have access to other custom tools depending on the project\./i,
			replace: "\n- task: Run isolated pi subprocess tasks (single, chain, or parallel).",
		},
		{
			match: /Use the read tool to load a skill's file when the task matches its description\./i,
			replace:
				"Use skill directly: Use the read tool to load a skill's file when the task matches its description. Use skill in task: Pass the skill to the task tool and the task context will load it.",
		},
	],
};

const loadSkillDiscovery = (cwd: string) => {
	const settingsManager = SettingsManager.create(cwd);
	const agentDir = getAgentDir();
	const skillPaths = settingsManager.getSkillPaths();
	return loadSkills({ cwd, agentDir, skillPaths, includeDefaults: true });
};

const applyPromptPatches = (prompt: string, patches: PromptPatch[]): string => {
	return patches.reduce((value, patch) => value.replace(patch.match, patch.replace), prompt);
};

type UsageStats = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
};

type SingleResult = {
	prompt: string;
	skill?: string;
	exitCode: number;
	messages: Message[];
	toolEvents: ToolCallItem[];
	streamingText?: string;
	stderr: string;
	usage: UsageStats;
	model?: string;
	thinking?: ThinkingLevel;
	fork?: boolean;
	stopReason?: string;
	errorMessage?: string;
	payloadTruncated?: boolean;
	index?: number;
};

/** Owns durable and provisional human-readable text for one child run. */
class RunPayloadBudget {
	private retainedBytes = 0;
	private liveBytes = 0;
	private markerRetained = false;
	private markerOwner: string | undefined;
	private liveMarker = false;
	private liveTruncated = false;
	private readonly markerBytes = Buffer.byteLength(TRUNCATED_HEAD_MARKER, "utf8");

	public get truncated(): boolean {
		return this.markerRetained || this.liveMarker;
	}

	public get full(): boolean {
		const markerReserve = this.truncated ? 0 : this.markerBytes;
		return this.retainedBytes + this.liveBytes >= CHILD_RETAINED_RESULT_MAX_BYTES - markerReserve;
	}

	public wouldOverflow(bytes: number): boolean {
		const markerReserve = this.truncated ? 0 : this.markerBytes;
		return bytes > CHILD_RETAINED_RESULT_MAX_BYTES - markerReserve - this.retainedBytes - this.liveBytes;
	}

	public retain(text: string, requiresMarker = false, owner?: string): string {
		if (text.length === 0) return "";
		const textBytes = Buffer.byteLength(text, "utf8");
		const markerPresent = this.truncated;
		const markerReserve = markerPresent ? 0 : this.markerBytes;
		const contentBytesLeft = Math.max(0, CHILD_RETAINED_RESULT_MAX_BYTES - markerReserve - this.retainedBytes - this.liveBytes);
		if (!requiresMarker && textBytes <= contentBytesLeft) {
			this.retainedBytes += textBytes;
			return text;
		}

		const retained = markerPresent
			? this.unmarkedHead(text, contentBytesLeft)
			: this.markedHead(text, contentBytesLeft);
		this.retainedBytes += Buffer.byteLength(retained, "utf8");
		if (!markerPresent) {
			this.markerRetained = true;
			this.markerOwner = owner;
		}
		return retained;
	}

	public replaceMany(
		owners: readonly string[],
		previous: readonly (string | undefined)[],
		next: readonly (string | undefined)[],
		reusesPrevious: readonly boolean[],
	): Array<string | undefined> {
		const ownedMarkerIndex = owners.findIndex((owner) => owner === this.markerOwner);
		for (let index = 0; index < previous.length; index += 1) {
			const text = previous[index];
			if (text !== undefined) this.release(text, owners[index]);
		}
		const normalized = next.map((text, index) => {
			if (text === undefined || index !== ownedMarkerIndex || !reusesPrevious[index] || !text.endsWith(TRUNCATED_HEAD_MARKER)) return text;
			return text.slice(0, -TRUNCATED_HEAD_MARKER.length);
		});
		let markerIndex = -1;
		if (ownedMarkerIndex !== -1) {
			for (let index = normalized.length - 1; index >= 0; index -= 1) {
				if (normalized[index] !== undefined) {
					markerIndex = index;
					break;
				}
			}
		}
		return normalized.map((text, index) => {
			if (text === undefined) return undefined;
			return this.retain(text, index === markerIndex && !this.truncated, owners[index]);
		});
	}

	public appendLive(delta: string): string {
		if (delta.length === 0 || this.liveTruncated) return "";
		const deltaBytes = Buffer.byteLength(delta, "utf8");
		const markerPresent = this.truncated;
		const markerReserve = markerPresent ? 0 : this.markerBytes;
		const contentBytesLeft = Math.max(0, CHILD_RETAINED_RESULT_MAX_BYTES - markerReserve - this.retainedBytes - this.liveBytes);
		if (deltaBytes <= contentBytesLeft) {
			this.liveBytes += deltaBytes;
			return delta;
		}
		const retained = markerPresent
			? this.unmarkedHead(delta, contentBytesLeft)
			: this.markedHead(delta, contentBytesLeft);
		this.liveBytes += Buffer.byteLength(retained, "utf8");
		this.liveMarker = !markerPresent;
		this.liveTruncated = true;
		return retained;
	}

	public releaseLive(): boolean {
		const omitted = this.liveTruncated;
		this.liveBytes = 0;
		this.liveMarker = false;
		this.liveTruncated = false;
		return omitted;
	}

	public reclaimForAssistant(): void {
		this.retainedBytes = 0;
		this.liveBytes = 0;
		this.markerRetained = false;
		this.markerOwner = undefined;
		this.liveMarker = false;
		this.liveTruncated = false;
	}

	private release(text: string, owner?: string): void {
		this.retainedBytes = Math.max(0, this.retainedBytes - Buffer.byteLength(text, "utf8"));
		if (owner === this.markerOwner) {
			this.markerRetained = false;
			this.markerOwner = undefined;
		}
	}

	private markedHead(text: string, contentBytes: number): string {
		return boundRetainedResult(`${text}${TRUNCATED_HEAD_MARKER}`, contentBytes + this.markerBytes);
	}

	private unmarkedHead(text: string, contentBytes: number): string {
		return this.markedHead(text, contentBytes).slice(0, -TRUNCATED_HEAD_MARKER.length);
	}
}

const runPayloadBudgets = new WeakMap<SingleResult, RunPayloadBudget>();

const getRunPayloadBudget = (result: SingleResult): RunPayloadBudget => {
	let budget = runPayloadBudgets.get(result);
	if (!budget) {
		budget = new RunPayloadBudget();
		runPayloadBudgets.set(result, budget);
	}
	return budget;
};

type TaskToolDetails = {
	mode: "single" | "parallel" | "chain";
	modelOverride?: string;
	results: SingleResult[];
	startedAt?: number;
	updatedAt?: number;
};

type TaskStatus = "Running" | "Done" | "Failed" | "Pending";
type OverallStatus = "Running" | "Done" | "Failed";

type ToolCallItem = {
	id?: string;
	name: string;
	args: Record<string, unknown> | string;
	status: "pending" | "running" | "success" | "error" | "cancelled";
	output?: string;
};

type ToolCallUpdate = Omit<ToolCallItem, "args"> & { args?: Record<string, unknown> };

type PreparedTask = {
	item: TaskWorkItem;
	subprocessPrompt: string;
};

type PreparedExecution = {
	task: PreparedTask;
	config: { thinkingLevel: ThinkingLevel; subprocessArgs: string[]; modelLabel: string | undefined };
};

type ForkSession = { dir: string; seedPath: string };

const createForkSession = async (sessionFile: string): Promise<ForkSession> => {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-task-tool-"));
	const seedPath = path.join(tmpDir, "seed.jsonl");
	try {
		await fs.promises.copyFile(sessionFile, seedPath);
		return { dir: tmpDir, seedPath };
	} catch (error) {
		try {
			await fs.promises.rm(tmpDir, { recursive: true, force: true });
		} catch {}
		throw error;
	}
};

const cleanupForkSession = async (session?: ForkSession): Promise<void> => {
	if (!session) return;
	try {
		await fs.promises.rm(session.dir, { recursive: true, force: true });
	} catch {}
};

const applyForkSessionArgs = (baseArgs: string[], session?: ForkSession): string[] => {
	if (!session) return baseArgs;
	const filtered = baseArgs.filter((arg) => arg !== "--no-session");
	return [...filtered, "--session", session.seedPath, "--session-dir", session.dir];
};

const shortenPath = (filePath: string): string => {
	const home = os.homedir();
	return filePath.startsWith(home) ? `~${filePath.slice(home.length)}` : filePath;
};

const formatTokens = (count: number): string => {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
};

const formatUsageStats = (
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		contextTokens?: number;
		turns?: number;
	},
	model?: string,
	thinking?: ThinkingLevel,
): string => {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0) parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	if (model) parts.push(model);
	if (thinking) parts.push(`thinking:${thinking}`);
	return parts.join(" ");
};

const formatTaskConfig = (result: SingleResult): string | undefined => {
	const parts: string[] = [];
	if (result.model) parts.push(result.model);
	if (result.thinking) parts.push(`thinking:${result.thinking}`);
	const contextLabel = getTaskContextLabel(result);
	if (contextLabel) parts.push(`context:${contextLabel}`);
	return parts.length > 0 ? parts.join(" ") : undefined;
};

const stripYamlFrontmatter = (content: string): string => {
	const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	return normalized.replace(/^---\n[\s\S]*?\n---\n/, "").trim();
};

const formatToolCall = (
	toolName: string,
	args: Record<string, unknown> | string,
	themeFg: (color: ThemeColor, text: string) => string,
): string => {
	if (typeof args === "string") {
		const preview = args.length > 60 ? `${args.slice(0, 60)}...` : args;
		return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
	}
	if (toolName === "bash") {
		const command = typeof args.command === "string" ? args.command : "...";
		const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
		return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
	}

	if (toolName === "read") {
		const rawPath =
			typeof args.file_path === "string" ? args.file_path : typeof args.path === "string" ? args.path : "...";
		const offset = typeof args.offset === "number" ? args.offset : undefined;
		const limit = typeof args.limit === "number" ? args.limit : undefined;
		let text = themeFg("accent", shortenPath(rawPath));
		if (offset !== undefined || limit !== undefined) {
			const startLine = offset ?? 1;
			const endLine = limit !== undefined ? startLine + limit - 1 : "";
			text += themeFg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
		}
		return themeFg("muted", "read ") + text;
	}

	if (toolName === "write") {
		const rawPath =
			typeof args.file_path === "string" ? args.file_path : typeof args.path === "string" ? args.path : "...";
		const content = typeof args.content === "string" ? args.content : "";
		const lines = content.split("\n").length;
		let text = themeFg("muted", "write ") + themeFg("accent", shortenPath(rawPath));
		if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
		return text;
	}

	if (toolName === "edit") {
		const rawPath =
			typeof args.file_path === "string" ? args.file_path : typeof args.path === "string" ? args.path : "...";
		return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
	}

	if (toolName === "ls") {
		const rawPath = typeof args.path === "string" ? args.path : ".";
		return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
	}

	if (toolName === "find") {
		const pattern = typeof args.pattern === "string" ? args.pattern : "*";
		const rawPath = typeof args.path === "string" ? args.path : ".";
		return themeFg("muted", "find ") + themeFg("accent", pattern) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
	}

	if (toolName === "grep") {
		const pattern = typeof args.pattern === "string" ? args.pattern : "";
		const rawPath = typeof args.path === "string" ? args.path : ".";
		return (
			themeFg("muted", "grep ") + themeFg("accent", `/${pattern}/`) + themeFg("dim", ` in ${shortenPath(rawPath)}`)
		);
	}

	const argsStr = JSON.stringify(args);
	const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
	return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
};

const getFinalOutput = (messages: Message[]): string => {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role !== "assistant") continue;
		const text = message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("");
		if (text) return text;
	}
	return "";
};

const getFinalResultOutput = (result: SingleResult): string => {
	const output = getFinalOutput(result.messages);
	if (!output) return "";
	return result.payloadTruncated && !output.includes(TRUNCATED_HEAD_MARKER)
		? `${output}${TRUNCATED_HEAD_MARKER}`
		: output;
};

const indentLine = (text: string, indent: number): string => `${" ".repeat(indent)}${text}`;

const indentText = (text: string, indent: number): string => {
	return text.split("\n").map((line) => indentLine(line, indent)).join("\n");
};

const formatLabeledLine = (label: string, value: string, indent: number): string => {
	const lines = value.split("\n");
	const header = indentLine(`${label}: ${lines[0] ?? ""}`, indent);
	if (lines.length === 1) return header;
	const rest = lines.slice(1).map((line) => indentLine(line, indent + 2));
	return [header, ...rest].join("\n");
};

const formatSection = (label: string, body: string, indent: number): string => {
	return `${indentLine(`${label}:`, indent)}\n${indentText(body, indent + 2)}`;
};

const isTaskRunning = (result: SingleResult): boolean => result.exitCode === -1;
const isTaskPending = (result: SingleResult): boolean => result.exitCode === -2;

const getTaskStatus = (result: SingleResult): TaskStatus => {
	if (isTaskPending(result)) return "Pending";
	if (isTaskRunning(result)) return "Running";
	return isTaskError(result) ? "Failed" : "Done";
};

const getParallelStatus = (results: SingleResult[]): OverallStatus => {
	const hasInProgress = results.some((result) => isTaskRunning(result) || isTaskPending(result));
	if (hasInProgress) return "Running";
	return results.some(isTaskError) ? "Failed" : "Done";
};

const getChainStatus = (results: SingleResult[]): OverallStatus => {
	const hasError = results.some(isTaskError);
	if (hasError) return "Failed";
	const hasInProgress = results.some((result) => isTaskRunning(result) || isTaskPending(result));
	return hasInProgress ? "Running" : "Done";
};

const getStatusIcon = (status: TaskStatus | OverallStatus, theme: Theme): string => {
	if (status === "Done") return theme.fg("success", "✓");
	if (status === "Failed") return theme.fg("error", "✗");
	return theme.fg("warning", "⏳");
};

const getToolCallItems = (result: SingleResult): ToolCallItem[] => {
	if (result.toolEvents.length > 0) return result.toolEvents;
	const items: ToolCallItem[] = [];
	for (const message of result.messages) {
		if (message.role === "assistant") {
			for (const part of message.content) {
				if (part.type === "toolCall") items.push({ id: part.id, name: part.name, args: part.arguments, status: "running" });
			}
		}
	}
	return items;
};

const getToolCallLines = (result: SingleResult, theme: Theme): string[] => {
	const items = getToolCallItems(result);
	const themeFg = theme.fg.bind(theme);
	return items.map((item) => {
		const icon = item.status === "success" ? themeFg("success", "✓ ") : item.status === "error" ? themeFg("error", "✗ ") : themeFg("warning", "→ ");
		const output = item.output ? themeFg("dim", ` — ${item.output.slice(0, 80)}`) : "";
		return `${icon}${formatToolCall(item.name, item.args, themeFg)}${output}`;
	});
};

const getTaskOutputText = (result: SingleResult): string => {
	if (isTaskError(result)) return getTaskErrorText(result);
	return getFinalResultOutput(result);
};

const formatFinalOutputText = (result: SingleResult): string => {
	const output = getTaskOutputText(result).trim();
	return output ? output : "(no output)";
};

const formatStatusLine = (status: TaskStatus | OverallStatus, indent: number, detail?: string): string => {
	const base = `Status: ${status}`;
	return indentLine(detail ? `${base} — ${detail}` : base, indent);
};

const buildTaskBlockLines = (options: { label: string; result: SingleResult; theme: Theme; indent: number }): string[] => {
	const { label, result, theme, indent } = options;
	const status = getTaskStatus(result);
	const lines = [indentLine(`${theme.fg("toolTitle", label)} ${getStatusIcon(status, theme)}`, indent)];
	lines.push(formatStatusLine(status, indent + 2));
	const skillLabel = getTaskSkillLabel(result);
	if (skillLabel) lines.push(formatLabeledLine("Skill", skillLabel, indent + 2));
	const configLine = formatTaskConfig(result);
	if (configLine) lines.push(formatLabeledLine("Subprocess", configLine, indent + 2));
	lines.push(formatLabeledLine("Prompt", result.prompt.trim(), indent + 2));
	const logLines = status === "Pending" ? [] : getToolCallLines(result, theme);
	if (status !== "Pending") {
		if (logLines.length > 0) lines.push(formatSection("Logs", logLines.join("\n"), indent + 2));
		else lines.push(indentLine("Logs:", indent + 2));
	}
	if (status === "Done" || status === "Failed") {
		lines.push(formatSection("Final output", formatFinalOutputText(result), indent + 2));
		const usageStr = formatUsageStats(result.usage, result.model, result.thinking);
		if (usageStr) lines.push(indentLine(`Usage: ${usageStr}`, indent + 2));
	}
	return lines;
};

const buildChainPrompt = (prompt: string, previousOutput: string): string => {
	return prompt.replace(/\{previous\}/g, previousOutput);
};

const buildPendingPrompt = (prompt: string): string => {
	return buildChainPrompt(prompt, "…");
};

const countCompletedTasks = (results: SingleResult[]): number => {
	let count = 0;
	for (const result of results) {
		if (!isTaskRunning(result) && !isTaskPending(result)) count += 1;
	}
	return count;
};

const aggregateUsage = (results: SingleResult[]): UsageStats => {
	const total: UsageStats = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
	for (const result of results) {
		total.input += result.usage.input;
		total.output += result.usage.output;
		total.cacheRead += result.usage.cacheRead;
		total.cacheWrite += result.usage.cacheWrite;
		total.cost += result.usage.cost;
		total.turns += result.usage.turns;
	}
	return total;
};

type SkillSummary = { text: string; remaining: number };

const formatAvailableSkills = (skills: Skill[], maxItems: number): SkillSummary => {
	if (skills.length === 0) return { text: "none", remaining: 0 };
	const listed = skills.slice(0, maxItems);
	const remaining = skills.length - listed.length;
	return {
		text: listed.map((skill) => skill.name).join(", "),
		remaining,
	};
};

const buildSkillMessageBase = (skill: Skill): string => {
	const content = fs.readFileSync(skill.filePath, "utf-8");
	const body = stripYamlFrontmatter(content);
	const header = `Skill location: ${skill.filePath}\nReferences are relative to ${skill.baseDir}.`;
	return `${header}\n\n${body}`;
};

type SkillPromptState = {
	skills: Skill[];
	skillByName: Map<string, Skill>;
	baseCache: Map<string, string>;
};

const createSkillPromptState = (skills: Skill[]): SkillPromptState => {
	const skillByName = new Map<string, Skill>();
	for (const skill of skills) skillByName.set(skill.name, skill);
	return { skills, skillByName, baseCache: new Map<string, string>() };
};

const buildSubprocessPrompt = (
	item: TaskWorkItem,
	state: SkillPromptState,
	skillListLimit: number,
): { ok: true; prompt: string } | { ok: false; error: string } => {
	if (!item.skill) return { ok: true, prompt: item.prompt };

	const skill = state.skillByName.get(item.skill);
	if (!skill) {
		const available = formatAvailableSkills(state.skills, skillListLimit);
		const suffix = available.remaining > 0 ? `, ... +${available.remaining} more` : "";
		return {
			ok: false,
			error: `Unknown skill: ${item.skill}\nAvailable skills: ${available.text}${suffix}`,
		};
	}

	let base = state.baseCache.get(skill.name);
	if (!base) {
		try {
			base = buildSkillMessageBase(skill);
			state.baseCache.set(skill.name, base);
		} catch (err) {
			return {
				ok: false,
				error: `Failed to load skill "${skill.name}": ${err instanceof Error ? err.message : String(err)}`,
			};
		}
	}

	return { ok: true, prompt: `${base}\n\n---\n\nUser: ${item.prompt}` };
};

const createPlaceholderResult = (
	item: TaskWorkItem,
	index: number | undefined,
	thinking?: ThinkingLevel,
	model?: string,
	exitCode = -1,
): SingleResult => {
	return {
		prompt: item.prompt,
		skill: item.skill,
		index,
		exitCode,
		messages: [],
		toolEvents: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		model,
		thinking,
		fork: item.fork,
	};
};

const getTaskSkillLabel = (result: { skill?: string } | undefined): string | undefined => {
	const skill = result?.skill?.trim();
	return skill ? skill : undefined;
};

const getTaskSummaryLabel = (result: SingleResult): string => {
	const skillLabel = getTaskSkillLabel(result);
	if (skillLabel) return skillLabel;
	if (result.index) return `task ${result.index}`;
	return "task";
};

const getTaskContextLabel = (result: SingleResult): string | undefined => {
	if (result.fork === undefined) return undefined;
	return result.fork ? "fork" : "fresh";
};

const isTaskError = (result: SingleResult): boolean => {
	return result.exitCode > 0 || result.stopReason === "error" || result.stopReason === "aborted";
};

const getTaskErrorText = (result: SingleResult): string => {
	return result.errorMessage || result.stderr || getFinalResultOutput(result) || "(no output)";
};

type AbortGuard = {
	isAborted: () => boolean;
	terminate: () => void;
	dispose: () => void;
};

const attachAbortSignal = (
	proc: ChildProcessWithoutNullStreams,
	signal: AbortSignal | undefined,
): AbortGuard => {
	let aborted = false;
	let closed = false;
	let forceKill: ReturnType<typeof setTimeout> | undefined;
	const onClose = () => {
		closed = true;
		if (forceKill) clearTimeout(forceKill);
		forceKill = undefined;
	};
	proc.once("close", onClose);
	const terminate = () => {
		if (closed || forceKill) return;
		proc.kill("SIGTERM");
		forceKill = setTimeout(() => {
			if (!closed) proc.kill("SIGKILL");
		}, 5000);
		forceKill.unref?.();
	};
	const interrupt = () => {
		aborted = true;
		terminate();
	};
	if (signal?.aborted) interrupt();
	else signal?.addEventListener("abort", interrupt, { once: true });
	return {
		isAborted: () => aborted,
		terminate,
		dispose: () => {
			signal?.removeEventListener("abort", interrupt);
			proc.removeListener("close", onClose);
			if (forceKill) clearTimeout(forceKill);
			forceKill = undefined;
		},
	};
};

const parseJsonLine = (line: string): Record<string, unknown> | undefined => {
	if (!line.trim()) return undefined;
	try {
		const parsed = JSON.parse(line) as unknown;
		return isRecord(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
};

const isMessage = (value: unknown): value is Message => {
	if (!isRecord(value)) return false;
	const role = value.role;
	return role === "assistant" || role === "user" || role === "toolResult";
};

const applyAssistantUsage = (result: SingleResult, message: AssistantMessage): void => {
	result.usage.turns += 1;
	const usage = message.usage;

	result.usage.input += usage.input ?? 0;
	result.usage.output += usage.output ?? 0;
	result.usage.cacheRead += usage.cacheRead ?? 0;
	result.usage.cacheWrite += usage.cacheWrite ?? 0;
	result.usage.cost += usage.cost?.total ?? 0;
	result.usage.contextTokens = usage.totalTokens ?? 0;
};

const RETAINED_PREVIEW_KEY = "__sumocodeRetainedPreview";
const RETAINED_METADATA_MAX_BYTES = 512;
const RETAINED_NAME_MAX_BYTES = 256;
const RETAINED_NAME_LIST_MAX = 64;

const serializeStructured = (value: unknown): string => {
	try {
		return JSON.stringify(value) ?? String(value);
	} catch {
		return String(value);
	}
};

const retainStructured = <T>(budget: RunPayloadBudget, value: T, requiresMarker = false): T | Record<string, string> => {
	const serialized = serializeStructured(value);
	const retained = budget.retain(serialized, requiresMarker);
	return retained === serialized ? value : retained ? { [RETAINED_PREVIEW_KEY]: retained } : {};
};

const boundedMetadataText = (value: unknown, maxBytes = RETAINED_METADATA_MAX_BYTES): string => {
	if (typeof value !== "string" || value.length === 0) return "";
	const head = new BoundedUtf8Head(maxBytes);
	return head.append(value);
};

const boundedIdentifierText = (value: unknown, maxBytes = RETAINED_NAME_MAX_BYTES): string => (
	typeof value === "string" && value.length > 0 ? boundStableIdentifier(value, maxBytes) : ""
);

const finiteNumber = (value: unknown): number => typeof value === "number" && Number.isFinite(value) ? value : 0;

const retainedUsage = (value: unknown): AssistantMessage["usage"] => {
	const usage = isRecord(value) ? value : {};
	const cost = isRecord(usage.cost) ? usage.cost : {};
	return {
		input: finiteNumber(usage.input),
		output: finiteNumber(usage.output),
		cacheRead: finiteNumber(usage.cacheRead),
		cacheWrite: finiteNumber(usage.cacheWrite),
		totalTokens: finiteNumber(usage.totalTokens),
		cost: {
			input: finiteNumber(cost.input),
			output: finiteNumber(cost.output),
			cacheRead: finiteNumber(cost.cacheRead),
			cacheWrite: finiteNumber(cost.cacheWrite),
			total: finiteNumber(cost.total),
		},
	};
};

const clearRetainedHumanText = (result: SingleResult): void => {
	result.messages = result.messages.map((message): Message => {
		if (message.role === "user") {
			return {
				...message,
				content: typeof message.content === "string"
					? ""
					: message.content.map((part) => part.type === "text" ? { ...part, text: "" } : { ...part, data: "" }),
			};
		}
		if (message.role === "toolResult") {
			return {
				...message,
				content: message.content.map((part) => part.type === "text" ? { ...part, text: "" } : { ...part, data: "" }),
				details: undefined,
			};
		}
		return {
			...message,
			content: message.content.map((part) => {
				if (part.type === "text") return { ...part, text: "", textSignature: undefined };
				if (part.type === "thinking") return { ...part, thinking: "", thinkingSignature: undefined };
				return { ...part, arguments: {}, thoughtSignature: undefined };
			}),
			diagnostics: undefined,
			deferred: undefined,
			errorMessage: undefined,
		};
	});
	result.toolEvents = result.toolEvents.map((event) => ({ ...event, args: {}, output: undefined }));
	result.errorMessage = undefined;
};

const retainMultimodalContent = (
	budget: RunPayloadBudget,
	rawContent: unknown,
): Extract<Message, { role: "toolResult" }>["content"] => {
	const content: Extract<Message, { role: "toolResult" }>["content"] = [];
	if (!Array.isArray(rawContent)) return content;
	for (const part of rawContent) {
		if (!isRecord(part)) continue;
		if (part.type === "text") content.push({ type: "text", text: budget.retain(typeof part.text === "string" ? part.text : "") });
		else if (part.type === "image") content.push({
			type: "image",
			data: budget.retain(typeof part.data === "string" ? part.data : ""),
			mimeType: boundedMetadataText(part.mimeType, RETAINED_NAME_MAX_BYTES),
		});
	}
	return content;
};

const handleEventMessage = (result: SingleResult, message: Message, liveOmitted = false): void => {
	const budget = getRunPayloadBudget(result);
	if (message.role === "user") {
		const rawContent: unknown = message.content;
		const content: Extract<Message, { role: "user" }>["content"] = typeof rawContent === "string"
			? budget.retain(rawContent)
			: retainMultimodalContent(budget, rawContent);
		result.messages.push({ role: "user", content, timestamp: finiteNumber(message.timestamp) });
		result.payloadTruncated = budget.truncated || undefined;
		return;
	}
	if (message.role === "toolResult") {
		const rawContent: unknown = message.content;
		const content = retainMultimodalContent(budget, rawContent);
		const retained: Extract<Message, { role: "toolResult" }> = {
			role: "toolResult",
			toolCallId: boundedIdentifierText(message.toolCallId),
			toolName: boundedMetadataText(message.toolName, RETAINED_NAME_MAX_BYTES),
			content,
			details: message.details === undefined ? undefined : retainStructured(budget, message.details),
			usage: message.usage === undefined ? undefined : retainedUsage(message.usage),
			addedToolNames: Array.isArray(message.addedToolNames)
				? message.addedToolNames.slice(0, RETAINED_NAME_LIST_MAX).map((name) => boundedMetadataText(name, RETAINED_NAME_MAX_BYTES))
				: undefined,
			isError: message.isError === true,
			timestamp: finiteNumber(message.timestamp),
		};
		result.messages.push(retained);
		result.payloadTruncated = budget.truncated || undefined;
		return;
	}
	const rawContent: unknown = message.content;
	const parts = Array.isArray(rawContent) ? rawContent.filter(isRecord) : [];
	const deliverableTextBytes = parts.reduce((bytes, part) => (
		part.type === "text" && typeof part.text === "string" ? bytes + Buffer.byteLength(part.text, "utf8") : bytes
	), typeof message.errorMessage === "string" ? Buffer.byteLength(message.errorMessage, "utf8") : 0);
	const assistantPayloadBytes = parts.reduce((bytes, part) => {
		if (part.type === "text" && typeof part.text === "string") return bytes + Buffer.byteLength(part.text, "utf8");
		if (part.type === "thinking" && typeof part.thinking === "string") return bytes + Buffer.byteLength(part.thinking, "utf8");
		if (part.type === "toolCall") return bytes + Buffer.byteLength(serializeStructured(isRecord(part.arguments) ? part.arguments : {}), "utf8");
		return bytes;
	}, typeof message.errorMessage === "string" ? Buffer.byteLength(message.errorMessage, "utf8") : 0);
	const hasDeliverableText = deliverableTextBytes > 0;
	const hasAssistantPayload = parts.some((part) => {
		if (part.type === "text") return typeof part.text === "string" && part.text.length > 0;
		if (part.type === "thinking") return typeof part.thinking === "string" && part.thinking.length > 0;
		return part.type === "toolCall";
	}) || hasDeliverableText;
	const hasPriorDeliverableText = getFinalOutput(result.messages).length > 0;
	const replaceForPayload = hasAssistantPayload
		&& (hasDeliverableText || !hasPriorDeliverableText)
		&& (budget.truncated || budget.full || liveOmitted || budget.wouldOverflow(assistantPayloadBytes));
	let requiresMarker = replaceForPayload || (hasAssistantPayload && liveOmitted && !budget.truncated);
	if (replaceForPayload) {
		clearRetainedHumanText(result);
		budget.reclaimForAssistant();
	}
	const retainAssistantText = (text: unknown): string => {
		if (typeof text !== "string" || text.length === 0) return "";
		const retained = budget.retain(text, requiresMarker);
		if (retained.length > 0) requiresMarker = false;
		return retained;
	};
	const retainAssistantRecord = (value: unknown): Record<string, unknown> => {
		const retained = retainStructured(budget, isRecord(value) ? value : {}, requiresMarker);
		if (Object.keys(retained).length > 0) requiresMarker = false;
		return retained;
	};
	const content: AssistantMessage["content"] = [];
	for (const part of parts) {
		if (part.type === "text") content.push({ type: "text", text: retainAssistantText(part.text) });
		else if (part.type === "thinking") content.push({ type: "thinking", thinking: retainAssistantText(part.thinking), redacted: part.redacted === true });
		else if (part.type === "toolCall") content.push({
			type: "toolCall",
			id: boundedIdentifierText(part.id),
			name: boundedMetadataText(part.name, RETAINED_NAME_MAX_BYTES),
			arguments: retainAssistantRecord(part.arguments),
			namespace: boundedMetadataText(part.namespace, RETAINED_NAME_MAX_BYTES) || undefined,
		});
	}
	const errorMessage = retainAssistantText(message.errorMessage) || undefined;
	const retained: AssistantMessage = {
		role: "assistant",
		content,
		api: boundedMetadataText(message.api, RETAINED_NAME_MAX_BYTES) as AssistantMessage["api"],
		provider: boundedMetadataText(message.provider, RETAINED_NAME_MAX_BYTES) as AssistantMessage["provider"],
		model: boundedMetadataText(message.model, RETAINED_NAME_MAX_BYTES),
		responseModel: boundedMetadataText(message.responseModel, RETAINED_NAME_MAX_BYTES) || undefined,
		responseId: boundedMetadataText(message.responseId) || undefined,
		usage: retainedUsage(message.usage),
		stopReason: boundedMetadataText(message.stopReason, RETAINED_NAME_MAX_BYTES) as AssistantMessage["stopReason"],
		errorMessage,
		rawStopReason: boundedMetadataText(message.rawStopReason, RETAINED_NAME_MAX_BYTES) || undefined,
		endTurn: typeof message.endTurn === "boolean" ? message.endTurn : undefined,
		timestamp: finiteNumber(message.timestamp),
	};
	result.messages.push(retained);
	result.payloadTruncated = budget.truncated || undefined;
	applyAssistantUsage(result, retained);
	if (!result.model && retained.model) result.model = retained.model;
	if (retained.stopReason) result.stopReason = retained.stopReason;
	if (retained.errorMessage) result.errorMessage = retained.errorMessage;
};

const prepareTaskExecutions = (options: {
	items: TaskWorkItem[];
	state: SkillPromptState;
	skillListLimit: number;
	defaultModel: string | undefined;
	defaultThinking: TaskThinking;
	inheritedThinking: ThinkingLevel;
	ctxModel: { provider: string; id: string } | undefined;
	builtInTools: BuiltInToolName[];
}): { ok: true; executions: PreparedExecution[] } | { ok: false; error: string } => {
	const executions: PreparedExecution[] = [];
	for (const item of options.items) {
		const prepared = buildSubprocessPrompt(item, options.state, options.skillListLimit);
		if (!prepared.ok) return prepared;
		const config = resolveTaskConfig({
			item,
			defaultModel: options.defaultModel,
			defaultThinking: options.defaultThinking,
			inheritedThinking: options.inheritedThinking,
			ctxModel: options.ctxModel,
			builtInTools: options.builtInTools,
		});
		if (!config.ok) return config;
		executions.push({
			task: { item, subprocessPrompt: prepared.prompt },
			config: {
				thinkingLevel: config.thinkingLevel,
				subprocessArgs: config.subprocessArgs,
				modelLabel: config.modelLabel,
			},
		});
	}
	return { ok: true, executions };
};

const stringifyToolOutput = (value: unknown): string | undefined => {
	if (value === undefined) return undefined;
	if (typeof value === "string") return value;
	if (isRecord(value)) {
		const content = value.content;
		if (Array.isArray(content)) {
			const text = content
				.map((part) => isRecord(part) && part.type === "text" && typeof part.text === "string" ? part.text : undefined)
				.filter((part): part is string => part !== undefined)
				.join("\n");
			if (text.trim().length > 0) return text;
		}
	}
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
};

const toolArgsText = (args: ToolCallItem["args"]): string => typeof args === "string" ? args : JSON.stringify(args);

const upsertToolEvent = (result: SingleResult, event: ToolCallUpdate): void => {
	const name = boundedMetadataText(event.name, RETAINED_NAME_MAX_BYTES) || "tool";
	const id = boundedIdentifierText(event.id)
		|| `h:${createHash("sha256").update(`${name}:${serializeStructured(event.args ?? {})}`, "utf8").digest("hex")}`;
	const key = id;
	const index = result.toolEvents.findIndex((item) => item.id === key);
	const previous = index === -1 ? undefined : result.toolEvents[index];
	const rawArgs = event.args ?? previous?.args ?? {};
	const nextArgsText = toolArgsText(rawArgs);
	const nextOutput = event.output === undefined ? previous?.output : event.output;
	const budget = getRunPayloadBudget(result);
	const [argsText = "", output] = budget.replaceMany(
		[`${key}:args`, `${key}:output`],
		[previous ? toolArgsText(previous.args) : undefined, previous?.output],
		[nextArgsText, nextOutput],
		[event.args === undefined && previous !== undefined, event.output === undefined && previous !== undefined],
	);
	const args = typeof rawArgs !== "string" && argsText === nextArgsText ? rawArgs : argsText;
	const retained: ToolCallItem = {
		id,
		name,
		args,
		status: event.status,
		output,
	};
	if (index === -1) result.toolEvents.push(retained);
	else result.toolEvents[index] = retained;
	result.payloadTruncated = budget.truncated || undefined;
};

const mapWithConcurrencyLimit = async <TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> => {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = Array.from({ length: items.length });
	let nextIndex = 0;

	const runWorker = async (): Promise<void> => {
		const currentIndex = nextIndex;
		nextIndex += 1;
		if (currentIndex >= items.length) return;
		results[currentIndex] = await fn(items[currentIndex], currentIndex);
		await runWorker();
	};

	await Promise.all(Array.from({ length: limit }, () => null).map(async () => runWorker()));
	return results;
};

const runSingleTask = async (options: {
	defaultCwd: string;
	item: TaskWorkItem;
	subprocessPrompt: string;
	index: number | undefined;
	subprocessArgs: string[];
	modelLabel: string | undefined;
	thinking: ThinkingLevel;
	fork: boolean;
	sessionFile: string | undefined;
	signal: AbortSignal | undefined;
	onResultUpdate: ((result: SingleResult) => void) | undefined;
	spawnImpl: typeof spawn;
}): Promise<SingleResult> => {
	const currentResult: SingleResult = {
		prompt: options.item.prompt,
		skill: options.item.skill,
		index: options.index,
		exitCode: -1,
		messages: [],
		toolEvents: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		model: options.modelLabel,
		thinking: options.thinking,
		fork: options.fork,
	};

	const stderr = new BoundedUtf8Tail();
	let stderrChanged = false;
	const emitUpdate = () => {
		if (!options.onResultUpdate) return;
		if (stderrChanged) {
			currentResult.stderr = stderr.toString();
			stderrChanged = false;
		}
		options.onResultUpdate(currentResult);
	};

	let forkSession: ForkSession | undefined;
	if (options.fork) {
		if (!options.sessionFile) {
			currentResult.exitCode = 1;
			currentResult.errorMessage = "Forked tasks require a persisted session file.";
			return currentResult;
		}
		try {
			forkSession = await createForkSession(options.sessionFile);
		} catch (error) {
			currentResult.exitCode = 1;
			currentResult.errorMessage = error instanceof Error ? error.message : String(error);
			return currentResult;
		}
	}

	try {
		const args = [...applyForkSessionArgs(options.subprocessArgs, forkSession), options.subprocessPrompt];

		const exitCode = await new Promise<number>((resolve) => {
			const proc = options.spawnImpl("pi", args, {
				cwd: options.defaultCwd,
				shell: false,
				stdio: ["pipe", "pipe", "pipe"],
			});

			proc.stdin.end();

			const abortState = attachAbortSignal(proc, options.signal);

			const processLine = (line: string) => {
				const event = parseJsonLine(line);
				if (!event) return;
				const typeValue = event.type;
				const typeText = typeof typeValue === "string" ? typeValue : "";
				if (typeText === "message_update") {
					const assistantEvent = isRecord(event.assistantMessageEvent) ? event.assistantMessageEvent : undefined;
					if (assistantEvent?.type === "text_delta" && typeof assistantEvent.delta === "string") {
						const budget = getRunPayloadBudget(currentResult);
						const retained = budget.appendLive(assistantEvent.delta);
						if (retained) currentResult.streamingText = `${currentResult.streamingText ?? ""}${retained}`;
						currentResult.payloadTruncated = budget.truncated || undefined;
						emitUpdate();
					}
				}
				if (typeText === "tool_execution_start") {
					upsertToolEvent(currentResult, {
						id: typeof event.toolCallId === "string" ? event.toolCallId : undefined,
						name: typeof event.toolName === "string" ? event.toolName : "tool",
						args: isRecord(event.args) ? event.args : undefined,
						status: "running",
					});
					emitUpdate();
				}
				if (typeText === "tool_execution_update") {
					upsertToolEvent(currentResult, {
						id: typeof event.toolCallId === "string" ? event.toolCallId : undefined,
						name: typeof event.toolName === "string" ? event.toolName : "tool",
						args: isRecord(event.args) ? event.args : undefined,
						status: "running",
						output: stringifyToolOutput(event.partialResult),
					});
					emitUpdate();
				}
				if (typeText === "tool_execution_end") {
					upsertToolEvent(currentResult, {
						id: typeof event.toolCallId === "string" ? event.toolCallId : undefined,
						name: typeof event.toolName === "string" ? event.toolName : "tool",
						args: isRecord(event.args) ? event.args : undefined,
						status: event.isError === true ? "error" : "success",
						output: stringifyToolOutput(event.result),
					});
					emitUpdate();
				}
				const messageValue = event.message;
				if ((typeText === "message_end" || typeText === "tool_result_end") && isMessage(messageValue)) {
					let liveOmitted = false;
					if (messageValue.role === "assistant") {
						liveOmitted = getRunPayloadBudget(currentResult).releaseLive();
						currentResult.streamingText = undefined;
					}
					handleEventMessage(currentResult, messageValue, liveOmitted);
					emitUpdate();
				}
			};

			let settled = false;
			let protocolFailed = false;
			const stdout = new JsonLineDecoder({
				onLine: processLine,
				onError: (error) => {
					protocolFailed = true;
					currentResult.errorMessage = error.message;
					// TERM starts shutdown; close remains the terminal boundary while the child exists.
					abortState.terminate();
				},
			});
			const onStdout = (data: string | Uint8Array) => stdout.write(data);
			const onStderr = (data: string | Uint8Array) => {
				stderr.append(data);
				stderrChanged = true;
			};
			const cleanup = () => {
				proc.stdout.removeListener("data", onStdout);
				proc.stderr.removeListener("data", onStderr);
				abortState.dispose();
			};
			const finish = (code: number) => {
				if (settled) return;
				settled = true;
				currentResult.exitCode = code;
				currentResult.stderr = stderr.toString();
				if (abortState.isAborted()) currentResult.stopReason = "aborted";
				cleanup();
				resolve(code);
			};
			proc.stdout.on("data", onStdout);
			proc.stderr.on("data", onStderr);
			proc.once("close", (code) => {
				stdout.end();
				finish(protocolFailed ? 1 : code ?? 0);
			});
			proc.once("error", (error) => {
				if (settled || protocolFailed || abortState.isAborted()) return;
				currentResult.errorMessage = boundRetainedResult(error.message);
				finish(1);
			});
		});

		currentResult.exitCode = exitCode;
		return currentResult;
	} finally {
		await cleanupForkSession(forkSession);
	}
};

const ModelOverrideSchema = Type.Optional(Type.String({ description: "Optional model override: provider/modelId" }));

const ThinkingOverrideSchema = Type.Optional(
	Type.String({
		enum: [...VALID_THINKING_OPTIONS],
		description: "Thinking level override: off, minimal, low, medium, high, xhigh, max, or inherit",
	}),
);

const TaskItemSchema = Type.Object({
	prompt: Type.String({ description: "Task prompt" }),
	skill: Type.Optional(Type.String({ description: "Optional skill name" })),
	model: ModelOverrideSchema,
	thinking: ThinkingOverrideSchema,
	fork: Type.Optional(Type.Boolean({ description: "Fork context from current session (default: true)" })),
});

const TaskParams = Type.Object({
	type: Type.String({
		enum: ["single", "chain", "parallel"],
		description: "Execution mode: single prompt, chain or parallel tasks",
	}),
	tasks: Type.Array(TaskItemSchema, {
		minItems: 1,
		description: "Tasks to run (single expects exactly one).",
	}),
	model: ModelOverrideSchema,
	thinking: ThinkingOverrideSchema,
});

const renderSingleResult = (result: SingleResult, _expanded: boolean, theme: Theme): Text => {
	const lines = buildTaskBlockLines({ label: "task", result, theme, indent: 0 });
	return new Text(lines.join("\n"), 0, 0);
};

const renderParallelResult = (results: SingleResult[], _expanded: boolean, theme: Theme): Text => {
	const status = getParallelStatus(results);
	const doneCount = countCompletedTasks(results);
	const lines = [
		indentLine(`${theme.fg("toolTitle", "task (parallel)")} ${getStatusIcon(status, theme)}`, 0),
		formatStatusLine(status, 2, status === "Running" ? `${doneCount}/${results.length} done` : undefined),
		indentLine("Tasks:", 2),
	];

	for (let index = 0; index < results.length; index++) {
		if (index > 0) lines.push("");
		lines.push(...buildTaskBlockLines({ label: "task", result: results[index], theme, indent: 4 }));
	}

	const usageStr = formatUsageStats(aggregateUsage(results));
	if (usageStr) {
		lines.push("");
		const totalLabel = status === "Running" ? "Total usage so far" : "Total usage";
		lines.push(indentLine(`${totalLabel}: ${usageStr}`, 2));
	}

	return new Text(lines.join("\n"), 0, 0);
};

const renderChainResult = (results: SingleResult[], _expanded: boolean, theme: Theme): Text => {
	const status = getChainStatus(results);
	const doneCount = countCompletedTasks(results);
	const lines = [
		indentLine(`${theme.fg("toolTitle", "task (chain)")} ${getStatusIcon(status, theme)}`, 0),
		formatStatusLine(status, 2, status === "Running" ? `${doneCount}/${results.length} done` : undefined),
		indentLine("Steps:", 2),
	];

	for (let index = 0; index < results.length; index++) {
		if (index > 0) lines.push("");
		const result = results[index];
		const stepNumber = result.index ?? index + 1;
		lines.push(...buildTaskBlockLines({ label: `Step ${stepNumber} (task)`, result, theme, indent: 4 }));
	}

	const usageStr = formatUsageStats(aggregateUsage(results));
	if (usageStr) {
		lines.push("");
		const totalLabel = status === "Running" ? "Total usage so far" : "Total usage";
		lines.push(indentLine(`${totalLabel}: ${usageStr}`, 2));
	}

	return new Text(lines.join("\n"), 0, 0);
};

export const taskTool = (options: TaskToolOptions = DEFAULT_OPTIONS, spawnImpl: typeof spawn = spawn) => (pi: ExtensionAPI) => {
	const merged = { ...DEFAULT_OPTIONS, ...options };

	pi.registerTool({
		name: merged.name,
		label: merged.label,
		description: merged.description,
		parameters: TaskParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const normalized = normalizeTaskParams(params as unknown, { maxParallelTasks: merged.maxParallelTasks });
			if (!normalized.ok) {
				const discovery = loadSkillDiscovery(ctx.cwd);
				const available = formatAvailableSkills(discovery.skills, merged.skillListLimit);
				const suffix = available.remaining > 0 ? `, ... +${available.remaining} more` : "";
				return {
					content: [{ type: "text", text: `${normalized.error}\nAvailable skills: ${available.text}${suffix}` }],
					details: { mode: "single", results: [] } as TaskToolDetails,
					isError: true,
				};
			}

			const discovery = loadSkillDiscovery(ctx.cwd);
			const skillState = createSkillPromptState(discovery.skills);

			const inheritedThinking = pi.getThinkingLevel();
			const builtInTools = getBuiltInToolsFromActiveTools(pi.getActiveTools());
			const ctxModel = ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined;

			const taskStartedAt = Date.now();
			const makeDetails = (results: SingleResult[]): TaskToolDetails => {
				return {
					mode: normalized.value.mode,
					modelOverride: normalized.value.model,
					results,
					startedAt: taskStartedAt,
					updatedAt: Date.now(),
				};
			};

			const requiresFork = normalized.value.items.some((item) => item.fork);
			const sessionFile = requiresFork ? ctx.sessionManager.getSessionFile() : undefined;
			if (requiresFork && !sessionFile) {
				return {
					content: [
						{
							type: "text",
							text: "Forked tasks require a persisted session file. Set fork: false or start pi with sessions enabled.",
						},
					],
					details: makeDetails([]),
					isError: true,
				};
			}

			if (normalized.value.mode === "single") {
				const prepared = prepareTaskExecutions({
					items: normalized.value.items,
					state: skillState,
					skillListLimit: merged.skillListLimit,
					defaultModel: normalized.value.model,
					defaultThinking: normalized.value.thinking,
					inheritedThinking,
					ctxModel,
					builtInTools,
				});
				if (!prepared.ok) {
					return {
						content: [{ type: "text", text: prepared.error }],
						details: makeDetails([]),
						isError: true,
					};
				}

				const execution = prepared.executions[0];
				const initial = createPlaceholderResult(
					execution.task.item,
					undefined,
					execution.config.thinkingLevel,
					execution.config.modelLabel,
				);
				const emitSingleUpdate = onUpdate
					? (result: SingleResult) => onUpdate({
							content: [{ type: "text", text: getFinalResultOutput(result) || "(running...)" }],
							details: makeDetails([result]),
						})
					: undefined;
				emitSingleUpdate?.(initial);

				const result = await runSingleTask({
					defaultCwd: ctx.cwd,
					item: execution.task.item,
					subprocessPrompt: execution.task.subprocessPrompt,
					index: undefined,
					subprocessArgs: execution.config.subprocessArgs,
					modelLabel: execution.config.modelLabel,
					thinking: execution.config.thinkingLevel,
					fork: execution.task.item.fork,
					sessionFile,
					signal,
					onResultUpdate: emitSingleUpdate,
					spawnImpl,
				});

				const error = isTaskError(result);
				if (error) {
					return {
						content: [{ type: "text", text: `Task failed: ${getTaskErrorText(result)}` }],
						details: makeDetails([result]),
						isError: true,
					};
				}

				return {
					content: [{ type: "text", text: getFinalResultOutput(result) || "(no output)" }],
					details: makeDetails([result]),
				};
			}

			if (normalized.value.mode === "chain") {
				const results = normalized.value.items.map((item, index) =>
					createPlaceholderResult(
						{ ...item, prompt: buildPendingPrompt(item.prompt) },
						index + 1,
						undefined,
						undefined,
						-2,
					),
				);
				let previousOutput = "";

				for (let index = 0; index < normalized.value.items.length; index++) {
					const item = normalized.value.items[index];
					const prompt = buildChainPrompt(item.prompt, previousOutput);
					const stepItem = { ...item, prompt };

					const config = resolveTaskConfig({
						item,
						defaultModel: normalized.value.model,
						defaultThinking: normalized.value.thinking,
						inheritedThinking,
						ctxModel,
						builtInTools,
					});
					if (!config.ok) {
						return {
							content: [{ type: "text", text: config.error }],
							details: makeDetails([...results]),
							isError: true,
						};
					}

					const preparedPrompt = buildSubprocessPrompt(stepItem, skillState, merged.skillListLimit);
					if (!preparedPrompt.ok) {
						return {
							content: [{ type: "text", text: preparedPrompt.error }],
							details: makeDetails([...results]),
							isError: true,
						};
					}

					results[index] = createPlaceholderResult(
						stepItem,
						index + 1,
						config.thinkingLevel,
						config.modelLabel,
					);
					if (onUpdate) {
						onUpdate({
							content: [{ type: "text", text: "(running...)" }],
							details: makeDetails([...results]),
						});
					}

					const chainUpdate = onUpdate
						? (partial: SingleResult) => {
								results[index] = partial;
								onUpdate({
									content: [{ type: "text", text: getFinalResultOutput(partial) || "(running...)" }],
									details: makeDetails([...results]),
								});
							}
						: undefined;

					const result = await runSingleTask({
						defaultCwd: ctx.cwd,
						item: stepItem,
						subprocessPrompt: preparedPrompt.prompt,
						index: index + 1,
						subprocessArgs: config.subprocessArgs,
						modelLabel: config.modelLabel,
						thinking: config.thinkingLevel,
						fork: stepItem.fork,
						sessionFile,
						signal,
						onResultUpdate: chainUpdate,
						spawnImpl,
					});
					results[index] = result;
					if (onUpdate) {
						onUpdate({
							content: [{ type: "text", text: getFinalResultOutput(result) || "(no output)" }],
							details: makeDetails([...results]),
						});
					}

					if (isTaskError(result)) {
						return {
							content: [
								{ type: "text", text: `Chain stopped at step ${index + 1}: ${getTaskErrorText(result)}` },
							],
							details: makeDetails([...results]),
							isError: true,
						};
					}

					previousOutput = getFinalResultOutput(result);
				}

				const last = results[results.length - 1];
				return {
					content: [{ type: "text", text: getFinalResultOutput(last) || "(no output)" }],
					details: makeDetails([...results]),
				};
			}

			const prepared = prepareTaskExecutions({
				items: normalized.value.items,
				state: skillState,
				skillListLimit: merged.skillListLimit,
				defaultModel: normalized.value.model,
				defaultThinking: normalized.value.thinking,
				inheritedThinking,
				ctxModel,
				builtInTools,
			});
			if (!prepared.ok) {
				return {
					content: [{ type: "text", text: prepared.error }],
					details: makeDetails([]),
					isError: true,
				};
			}

			const allResults = prepared.executions.map((execution, index) =>
				createPlaceholderResult(
					execution.task.item,
					index + 1,
					execution.config.thinkingLevel,
					execution.config.modelLabel,
					-2,
				),
			);

			const emitParallelUpdate = () => {
				if (!onUpdate) return;
				const running = allResults.filter((result) => result.exitCode === -1).length;
				const done = allResults.filter((result) => result.exitCode !== -1 && result.exitCode !== -2).length;
				onUpdate({
					content: [{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` }],
					details: makeDetails([...allResults]),
				});
			};

			emitParallelUpdate();

			const results = await mapWithConcurrencyLimit(
				prepared.executions,
				merged.maxConcurrency,
				async (execution, index) => {
					allResults[index] = createPlaceholderResult(
						execution.task.item,
						index + 1,
						execution.config.thinkingLevel,
						execution.config.modelLabel,
					);
					emitParallelUpdate();
					const result = await runSingleTask({
						defaultCwd: ctx.cwd,
						item: execution.task.item,
						subprocessPrompt: execution.task.subprocessPrompt,
						index: index + 1,
						subprocessArgs: execution.config.subprocessArgs,
						modelLabel: execution.config.modelLabel,
						thinking: execution.config.thinkingLevel,
						fork: execution.task.item.fork,
						sessionFile,
						signal,
						onResultUpdate: onUpdate
							? (partial) => {
									allResults[index] = partial;
									emitParallelUpdate();
								}
							: undefined,
						spawnImpl,
					});
					allResults[index] = result;
					emitParallelUpdate();
					return result;
				},
			);

			const successCount = results.filter((result) => !isTaskError(result)).length;
			const summaries = results.map((result) => {
				const output = getFinalResultOutput(result);
				const preview = output.slice(0, 100) + (output.length > 100 ? "..." : "");
				return `[${getTaskSummaryLabel(result)}] ${isTaskError(result) ? "failed" : "completed"}: ${preview || "(no output)"}`;
			});

			return {
				content: [
					{
						type: "text",
						text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n")}`,
					},
				],
				details: makeDetails(results),
			};
		},

		renderCall(_args, _theme) {
			return new Text("", 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as TaskToolDetails | undefined;
			if (!details || details.results.length === 0) {
				const textBlock = result.content[0];
				return new Text(textBlock?.type === "text" ? textBlock.text : "(no output)", 0, 0);
			}

			if (details.mode === "single" && details.results.length === 1) {
				return renderSingleResult(details.results[0], expanded, theme);
			}

			if (details.mode === "chain") {
				return renderChainResult(details.results, expanded, theme);
			}

			if (details.mode === "parallel") {
				return renderParallelResult(details.results, expanded, theme);
			}

			const textBlock = result.content[0];
			return new Text(textBlock?.type === "text" ? textBlock.text : "(no output)", 0, 0);
		},
	});

	pi.on("before_agent_start", async (event, _ctx) => {
		return {
			systemPrompt: applyPromptPatches(event.systemPrompt, merged.systemPromptPatches),
		};
	});
};
