export const SUBAGENT_PROMPT_GUIDELINES = [
	"Use subagent_spawn for independent research, review, or implementation slices that can proceed while you keep working.",
	"Children are headless: they have their own context, cannot see this conversation, cannot ask the user, and cannot spawn subagents.",
	"Prompts must be self-contained: include objective, relevant paths, constraints, expected output, and any stop conditions.",
	"After spawning, keep working; call subagent_wait only when the result is required to proceed.",
	"At most 4 subagents can run concurrently. If spawn returns status=at_capacity, wait/cancel/list before retrying.",
];

export const SUBAGENT_PROMPT_SNIPPET = "Spawn, check, wait for, cancel, and list headless subagents with self-contained prompts.";

export const SUBAGENT_TOOL_DESCRIPTIONS = {
	spawn: "Start one headless child subagent and return immediately with its id. Use subagent_wait or subagent_check to retrieve results in this release.",
	check: "Peek at one subagent without consuming its eventual result.",
	wait: "Block until one or more subagents settle, then return their bounded results and mark them consumed.",
	cancel: "Interrupt running subagents and mark their results consumed.",
	list: "List all tracked subagents and their current status.",
} as const;
