import type { SubagentStatus } from "./domain.js";
import type { CompletionManifestEvidence } from "./manifest.js";

const RESULT_OUTPUT_MAX_CHARS = 24 * 1024;
const RESULT_OUTPUT_MAX_LINES = 600;

export interface SubagentResultMessageInput {
	readonly id: string;
	readonly title: string;
	readonly status: Exclude<SubagentStatus, "running">;
	readonly errorText?: string;
	readonly output: string;
	readonly sessionFilePath?: string;
	readonly manifest?: CompletionManifestEvidence;
}

function boundedResultOutput(output: string): string {
	const lineBounded = output.split("\n").slice(0, RESULT_OUTPUT_MAX_LINES).join("\n");
	return lineBounded.slice(0, RESULT_OUTPUT_MAX_CHARS);
}

const shortRef = (ref: string): string => ref.slice(0, 7);

function dirtyLabel(dirty: boolean | undefined): string {
	return dirty === undefined ? "dirty unknown" : dirty ? "dirty" : "clean";
}

export function formatCompletionManifestSummary(manifest: CompletionManifestEvidence): string {
	if (!("baseRef" in manifest)) return `manifest unavailable · ${manifest.exit} · ${manifest.durationMs}ms`;
	if (!manifest.branch) return `shared checkout · base ${shortRef(manifest.baseRef)} · +${manifest.commits} checkout commits · changed paths suppressed · checkout ${dirtyLabel(manifest.dirty)}`;
	const files = `${manifest.changedPaths.length} ${manifest.changedPaths.length === 1 ? "file" : "files"} changed`;
	return `branch: ${manifest.branch} · base ${shortRef(manifest.baseRef)} · +${manifest.commits} commits · ${files} · ${dirtyLabel(manifest.dirty)}`;
}

export function formatCompletionManifest(manifest: CompletionManifestEvidence): string {
	const lines = [formatCompletionManifestSummary(manifest)];
	if (!("baseRef" in manifest)) return lines[0];
	if (manifest.changedPaths.length > 0) lines.push(`files: ${manifest.changedPaths.join(", ")}`);
	if (manifest.worktreePath) lines.push(`worktree: ${manifest.worktreePath} (preserved)`);
	return lines.join("\n");
}

export function buildSubagentResultMessage(input: SubagentResultMessageInput): string {
	const lines = [`Subagent ${input.id} "${input.title}" ${input.status === "done" ? "finished" : "failed"}.`];
	if (input.errorText) lines.push(`Error: ${input.errorText}`);
	const output = boundedResultOutput(input.output);
	if (output) lines.push(output);
	if (input.sessionFilePath) lines.push(`Full transcript: ${input.sessionFilePath}`);
	if (input.manifest) lines.push(`\`\`\`text\n${formatCompletionManifest(input.manifest)}\n\`\`\``);
	return lines.join("\n\n");
}

export const SUBAGENT_PROMPT_GUIDELINES = [
	"Use subagent_spawn for independent research, review, or implementation slices that can proceed while you keep working.",
	"Use visible subagents for long or interactive work the human may want to watch or steer; use headless subagents for silent, bounded fan-out.",
	"All children have their own context, cannot see this conversation, and cannot spawn subagents; prompts must be self-contained with objective, paths, constraints, expected output, and stop conditions.",
	"Use subagent_send to steer a running visible child; it sends the text followed by Enter. Headless or settled children cannot receive input.",
	"Visible isolated children appear as herdr workspaces; non-isolated visible children tile into a subagents tab. cmux provides only a degraded single-split fallback.",
	"After spawning, keep working; call subagent_wait only when the result is required to proceed.",
	"At most 4 subagents can run concurrently. If spawn returns status=at_capacity, wait/cancel/list before retrying.",
	"To delegate a self-contained coding task, spawn an isolated, watchable child: `subagent_spawn { visible: true, worktree: true, model, baseRef: 'origin/main' }`. It branches `sumo/<slug>` from baseRef, opens a herdr workspace you can watch or steer, and returns a completion manifest to review before acting on the result.",
	"Headless children run WITHOUT the dangerous-command approval gate (same trust model as the native task tool): they cannot prompt the user, so their bash executes directly. Do not delegate destructive commands against the user's checkout; use worktree isolation for write-heavy work. Isolated worktrees are preserved after completion and never auto-removed.",
];

export const SUBAGENT_PROMPT_SNIPPET = "Spawn, steer, check, wait for, cancel, and list headless or visible subagents with self-contained prompts.";

export const SUBAGENT_TOOL_DESCRIPTIONS = {
	spawn: "Start one child subagent and return immediately with its id. Set visible=true for an interactive terminal-host pane, or omit it for silent headless execution. Optionally isolate it in a preserved git worktree. Its result is delivered automatically when it settles; use subagent_wait to block for it.",
	send: "Send prompt text followed by Enter to a running visible subagent pane.",
	check: "Peek at one subagent without consuming its eventual result.",
	wait: "Block until one or more subagents settle, then return their bounded results and mark them consumed.",
	cancel: "Interrupt running subagents and mark their results consumed.",
	list: "List all tracked subagents and their current status.",
} as const;
