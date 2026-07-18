import type { SubagentStatus } from "./domain.js";

const RESULT_OUTPUT_MAX_CHARS = 24 * 1024;
const RESULT_OUTPUT_MAX_LINES = 600;

export interface SubagentResultMessageInput {
	readonly id: string;
	readonly title: string;
	readonly status: Exclude<SubagentStatus, "running">;
	readonly errorText?: string;
	readonly output: string;
	readonly sessionFilePath?: string;
}

function boundedResultOutput(output: string): string {
	const lineBounded = output.split("\n").slice(0, RESULT_OUTPUT_MAX_LINES).join("\n");
	return lineBounded.slice(0, RESULT_OUTPUT_MAX_CHARS);
}

export function buildSubagentResultMessage(input: SubagentResultMessageInput): string {
	const lines = [`Subagent ${input.id} "${input.title}" ${input.status === "done" ? "finished" : "failed"}.`];
	if (input.errorText) lines.push(`Error: ${input.errorText}`);
	const output = boundedResultOutput(input.output);
	if (output) lines.push(output);
	if (input.sessionFilePath) lines.push(`Full transcript: ${input.sessionFilePath}`);
	return lines.join("\n\n");
}

export const SUBAGENT_PROMPT_GUIDELINES = [
	"Use subagent_spawn for independent research, review, or implementation slices that can proceed while you keep working.",
	"Children are headless: they have their own context, cannot see this conversation, cannot ask the user, and cannot spawn subagents.",
	"Prompts must be self-contained: include objective, relevant paths, constraints, expected output, and any stop conditions.",
	"After spawning, keep working; call subagent_wait only when the result is required to proceed.",
	"At most 4 subagents can run concurrently. If spawn returns status=at_capacity, wait/cancel/list before retrying.",
	"Children run headless WITHOUT the dangerous-command approval gate (same trust model as the native task tool): they cannot prompt the user, so their bash executes directly. Do not delegate work expected to run destructive commands against the user's checkout; use worktree-isolated children for write-heavy work.",
];

export const SUBAGENT_PROMPT_SNIPPET = "Spawn, check, wait for, cancel, and list headless subagents with self-contained prompts.";

export const SUBAGENT_TOOL_DESCRIPTIONS = {
	spawn: "Start one headless child subagent and return immediately with its id. Its result is delivered automatically when it settles; use subagent_wait to block for it.",
	check: "Peek at one subagent without consuming its eventual result.",
	wait: "Block until one or more subagents settle, then return their bounded results and mark them consumed.",
	cancel: "Interrupt running subagents and mark their results consumed.",
	list: "List all tracked subagents and their current status.",
} as const;
