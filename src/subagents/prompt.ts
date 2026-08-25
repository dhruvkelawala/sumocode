import { SUBAGENT_MAX_RUNNING, type SubagentStatus } from "./domain.js";
import type { CompletionManifestEvidence } from "./manifest.js";

const RESULT_OUTPUT_MAX_CHARS = 24 * 1024;
const RESULT_OUTPUT_MAX_LINES = 600;

export interface SubagentResultMessageInput {
	readonly id: string;
	readonly title: string;
	readonly status: Exclude<SubagentStatus, "running" | "queued">;
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
	"Visible Herdr children split beside the parent when its tab is available, including worktree-backed children; overflow falls back to subagent tabs/workspaces. cmux provides only a degraded single-split fallback.",
	"delegation is fire-and-forget: after spawning, continue other work or end your turn. settled results arrive as automatic follow-up messages that wake you. do NOT call subagent_wait right after subagent_spawn.",
	"spawn with a role for recurring shapes: research, review, documentor, designer, implement-cheap, implement-smart. the role sets the child's system prompt, tool limits, and defaults; your prompt supplies the concrete objective and stop conditions.",
	"if spawn returns status=queued, the child starts automatically when a slot frees — do not retry, do not wait.",
	`At most ${SUBAGENT_MAX_RUNNING} subagents can run concurrently. If spawn returns status=at_capacity, the queue is full; cancel something or end your turn and respawn later.`,
	"To delegate a self-contained coding task, spawn an isolated, watchable child: `subagent_spawn { visible: true, worktree: true, model, baseRef: 'origin/main' }`. It branches `sumo/<slug>` from baseRef, opens beside the parent when possible (otherwise in a Herdr workspace), and returns a completion manifest to review before acting on the result.",
	"Headless children run WITHOUT the dangerous-command approval gate (same trust model as the native task tool): they cannot prompt the user, so their bash executes directly. Do not delegate destructive commands against the user's checkout; use worktree isolation for write-heavy work. Isolated worktrees are preserved after completion and never auto-removed.",
];

export const SUBAGENT_PROMPT_SNIPPET = "Spawn, steer, check, wait for, cancel, and list headless or visible subagents with self-contained prompts.";

export const SUBAGENT_TOOL_DESCRIPTIONS = {
	spawn: "Start one child subagent and return immediately with its id. Set visible=true for an interactive terminal-host pane, or omit it for silent headless execution. Optionally isolate it in a preserved git worktree. Its result is delivered automatically when it settles; no polling is needed.",
	send: "Send prompt text followed by Enter to a running visible subagent pane.",
	check: "Peek at one subagent without consuming its eventual result.",
	wait: "Block until subagents settle. Last resort: results deliver automatically on settlement; prefer ending your turn. Use only when nothing can proceed without the result.",
	cancel: "Interrupt running subagents and mark their results consumed.",
	list: "List all tracked subagents and their current status.",
} as const;
