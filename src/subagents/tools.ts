import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { DeferredResultDelivery } from "./delivery.js";
import { activityFromSubagentSnapshot } from "../activity/subagent-adapter.js";
import { getTerminalHost } from "../terminal-host/index.js";
import type { PaneRef, TerminalHost } from "../terminal-host/types.js";
import { latestText, type SubagentSnapshot } from "./domain.js";
import { type AtCapacityDetails, SubagentManager } from "./manager.js";
import { formatCompletionManifestSummary, SUBAGENT_PROMPT_GUIDELINES, SUBAGENT_PROMPT_SNIPPET, SUBAGENT_TOOL_DESCRIPTIONS } from "./prompt.js";

const StringEnum = <T extends readonly string[]>(values: T, options?: { description?: string }) =>
	Type.Unsafe<T[number]>({
		type: "string",
		enum: [...values],
		...(options?.description ? { description: options.description } : {}),
	});

const makeToolResult = (text: string, details?: unknown) => ({ content: [{ type: "text" as const, text }], details });

const activityEnvelope = (snapshot: SubagentSnapshot, sourceId?: string) => {
	const activity = activityFromSubagentSnapshot(snapshot);
	return sourceId ? { ...activity, sourceId } : activity;
};

const isAtCapacity = (value: SubagentSnapshot | AtCapacityDetails): value is AtCapacityDetails => "status" in value && value.status === "at_capacity";

const formatAtCapacity = (details: AtCapacityDetails) => {
	const runningLines = details.running.length > 0
		? details.running.map((task) => `- ${task.id}${task.title ? ` · ${task.title}` : ""} · ${task.status} · ${Math.round(task.ageMs / 1000)}s`).join("\n")
		: "- (no running subagents found)";
	return makeToolResult([
		`status=at_capacity — this is expected, not a failure. ${details.runningCount}/${details.capacity} subagent slots are in use.`,
		"Running subagents:",
		runningLines,
		`Next action: ${details.retryHint}.`,
	].join("\n"), { action: "spawn", ...details });
};

const trimLines = (text: string, maxChars: number, maxLines: number): string => {
	const lines = text.split("\n").slice(0, maxLines).join("\n");
	return lines.length > maxChars ? `${lines.slice(0, maxChars - 1)}…` : lines;
};

const formatDuration = (ms: number): string => {
	const seconds = Math.max(0, Math.round(ms / 1000));
	const minutes = Math.floor(seconds / 60);
	const rest = seconds % 60;
	return minutes > 0 ? `${minutes}m${rest}s` : `${rest}s`;
};

const formatSnapshotLine = (snapshot: SubagentSnapshot, includeBranch = false): string => {
	const model = snapshot.modelLabel ?? "inherit";
	const branch = includeBranch && snapshot.worktree ? ` · ${snapshot.worktree.branch}` : "";
	const pane = snapshot.pane ? ` · pane ${snapshot.pane.paneId ?? snapshot.pane.tabId ?? snapshot.pane.workspaceId ?? "unknown"} · agent ${snapshot.pane.agentName}` : "";
	return `${snapshot.id} [${snapshot.status}] "${snapshot.title}" (${model}, ${formatDuration(Date.now() - snapshot.createdAt)}, ${snapshot.cwd})${branch}${pane}`;
};

const manifestSummary = (snapshot: SubagentSnapshot): string | undefined => snapshot.manifest
	? formatCompletionManifestSummary(snapshot.manifest)
	: undefined;

const boundedWaitText = (snapshots: readonly SubagentSnapshot[]): string => {
	let remaining = 48 * 1024;
	const chunks: string[] = [];
	for (const snapshot of snapshots) {
		// A failed child with partial text must still surface WHY it failed —
		// partial output alone is easy to misread as a successful result.
		const errorLine = snapshot.status === "error" && snapshot.errorText ? `error: ${snapshot.errorText}\n` : "";
		const body = `${errorLine}${latestText(snapshot) || (errorLine ? "" : snapshot.errorText || "(no output)")}`;
		const perAgent = body.slice(0, 16 * 1024);
		const chunk = [`${snapshot.id} [${snapshot.status}] ${snapshot.title}`, manifestSummary(snapshot), perAgent].filter((line): line is string => line !== undefined).join("\n");
		const bounded = chunk.slice(0, remaining);
		chunks.push(bounded);
		remaining -= bounded.length;
		if (remaining <= 0) break;
	}
	return chunks.join("\n\n---\n\n");
};

export function registerSubagentTools(
	pi: ExtensionAPI,
	manager: SubagentManager,
	delivery?: Pick<DeferredResultDelivery, "consume">,
	host: TerminalHost = getTerminalHost(),
): void {
	pi.registerTool({
		name: "subagent_spawn",
		label: "Subagent Spawn",
		description: SUBAGENT_TOOL_DESCRIPTIONS.spawn,
		promptSnippet: SUBAGENT_PROMPT_SNIPPET,
		promptGuidelines: SUBAGENT_PROMPT_GUIDELINES,
		parameters: Type.Object({
			prompt: Type.String({ description: "Self-contained child subagent prompt." }),
			name: Type.String({ description: "Short human-readable title for this subagent." }),
			model: Type.Optional(Type.String({ description: "Optional model override as provider/modelId." })),
			thinking: Type.Optional(StringEnum(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const, { description: "Optional thinking level override." })),
			working_dir: Type.Optional(Type.String({ description: "Working directory for the child. Defaults to the current project cwd." })),
			worktree: Type.Optional(Type.Boolean({ description: "Run the child in an isolated git worktree on a new sumo/<slug> branch from HEAD by default. Its edits never touch your checkout. The worktree is preserved after completion; it is never auto-removed." })),
			branch: Type.Optional(Type.String({ description: "Optional branch override for an isolated worktree spawn." })),
			baseRef: Type.Optional(Type.String({ description: "Base git ref for the isolated worktree (only with worktree: true); defaults to HEAD. Use origin/main to branch from the pushed tip rather than your local checkout." })),
			visible: Type.Optional(Type.Boolean({ description: "Open the child as an interactive pane in the terminal host — watchable and steerable; requires a running terminal host." })),
		}),
		async execute(toolCallId, params, _signal, _onUpdate, ctx) {
			if (params.visible === true && host.kind === "none") {
				throw new Error("visible subagents require a running terminal host (herdr or cmux)");
			}
			const spawned = await manager.spawn({
				prompt: params.prompt,
				title: params.name,
				cwd: params.working_dir ?? ctx.cwd,
				visible: params.visible,
				worktree: params.worktree,
				branch: params.branch,
				baseRef: params.baseRef,
				model: params.model,
				thinking: params.thinking,
				inherited: {
					model: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined,
					// Mirror native-task-tool.ts (`pi.getThinkingLevel()` at spawn time):
					// children inherit the parent session's thinking level unless the
					// call overrides it, instead of silently defaulting to "low".
					thinking: pi.getThinkingLevel(),
				},
				builtInTools: pi.getActiveTools(),
			});
			if (isAtCapacity(spawned)) return formatAtCapacity(spawned);
			if (spawned.status !== "running") {
				// The failure is being returned INLINE — consume it so the change
				// listener's already-deferred payload is not ALSO auto-delivered
				// on the next agent_end (double report + pointless extra turn).
				delivery?.consume(spawned.id);
				return makeToolResult(`Subagent ${spawned.id} (${spawned.title}) failed to start: ${spawned.errorText ?? "unknown error"}`, {
					action: "spawn",
					subagent: spawned,
					activity: activityEnvelope(spawned, toolCallId),
				});
			}
			return makeToolResult(`Started ${spawned.id} (${spawned.title}). Its result will be delivered to you automatically when it settles, or use subagent_wait to block for it.`, {
				action: "spawn",
				subagent: spawned,
				activity: activityEnvelope(spawned, toolCallId),
			});
		},
	});

	pi.registerTool({
		name: "subagent_send",
		label: "Subagent Send",
		description: SUBAGENT_TOOL_DESCRIPTIONS.send,
		promptSnippet: SUBAGENT_PROMPT_SNIPPET,
		promptGuidelines: SUBAGENT_PROMPT_GUIDELINES,
		parameters: Type.Object({
			id: Type.String({ description: "Running visible subagent id, e.g. sa-1." }),
			text: Type.String({ description: "Prompt text to send followed by Enter." }),
		}),
		async execute(_toolCallId, params) {
			const snapshot = manager.get(params.id);
			if (!snapshot) throw new Error(`Unknown subagent id: ${params.id}`);
			if (snapshot.status !== "running") throw new Error(`Subagent ${params.id} is already settled (${snapshot.status}) and cannot receive input`);
			if (!snapshot.visible) throw new Error("headless children cannot receive input — respawn with visible: true");
			if (!snapshot.pane?.paneId) throw new Error(`Visible subagent ${params.id} does not have a ready pane`);
			if (host.kind === "none") throw new Error("visible subagent terminal host is unavailable");
			const sendPaneText = host.sendPaneText;
			if (!sendPaneText) throw new Error(`sending pane input is not supported on ${host.kind}`);
			const pane: PaneRef = { host: host.kind, paneId: snapshot.pane.paneId, workspaceId: snapshot.pane.workspaceId };
			const result = await sendPaneText.call(host, pi, pane, params.text);
			if (!result.ok) throw new Error(`Unable to send input to ${params.id}: ${result.error}`);
			return makeToolResult(`Sent input to ${params.id} (${snapshot.title}).`, { action: "send", id: params.id, pane: snapshot.pane });
		},
	});

	pi.registerTool({
		name: "subagent_check",
		label: "Subagent Check",
		description: SUBAGENT_TOOL_DESCRIPTIONS.check,
		promptSnippet: SUBAGENT_PROMPT_SNIPPET,
		promptGuidelines: SUBAGENT_PROMPT_GUIDELINES,
		parameters: Type.Object({ id: Type.String({ description: "Subagent id, e.g. sa-1." }) }),
		async execute(_toolCallId, params) {
			const snapshot = manager.get(params.id);
			if (!snapshot) throw new Error(`Unknown subagent id: ${params.id}`);
			const preview = trimLines(latestText(snapshot) || snapshot.errorText || "(no output yet)", 2048, 20);
			return makeToolResult([formatSnapshotLine(snapshot), manifestSummary(snapshot), preview].filter((line): line is string => line !== undefined).join("\n"), {
				action: "check",
				subagent: snapshot,
				activity: activityEnvelope(snapshot),
			});
		},
	});

	pi.registerTool({
		name: "subagent_wait",
		label: "Subagent Wait",
		description: SUBAGENT_TOOL_DESCRIPTIONS.wait,
		promptSnippet: SUBAGENT_PROMPT_SNIPPET,
		promptGuidelines: SUBAGENT_PROMPT_GUIDELINES,
		parameters: Type.Object({ ids: Type.Array(Type.String(), { maxItems: 64, description: "Subagent ids to wait for." }) }),
		async execute(_toolCallId, params, signal, onUpdate) {
			const snapshots = await manager.waitFor(params.ids, signal, (pending) => {
				onUpdate?.({
					content: [{ type: "text", text: `Waiting for ${pending.map((snapshot) => snapshot.id).join(", ")}…` }],
					details: {
						action: "wait",
						pending: pending.map((snapshot) => snapshot.id),
						activity: pending.map((snapshot) => activityEnvelope(snapshot)),
					},
				});
			});
			for (const snapshot of snapshots) delivery?.consume(snapshot.id);
			return makeToolResult(boundedWaitText(snapshots), {
				action: "wait",
				subagents: snapshots,
				activity: snapshots.map((snapshot) => activityEnvelope(snapshot)),
			});
		},
	});

	pi.registerTool({
		name: "subagent_cancel",
		label: "Subagent Cancel",
		description: SUBAGENT_TOOL_DESCRIPTIONS.cancel,
		promptSnippet: SUBAGENT_PROMPT_SNIPPET,
		promptGuidelines: SUBAGENT_PROMPT_GUIDELINES,
		parameters: Type.Object({ ids: Type.Array(Type.String(), { maxItems: 64, description: "Subagent ids to cancel." }) }),
		async execute(_toolCallId, params) {
			const lines = await manager.cancel(params.ids);
			// Only consume ids the manager actually knows. Consuming an unknown
			// id permanently poisons it in the delivery buffer, so the eventual
			// REAL child with that predictably-assigned id (e.g. a later sa-4)
			// would settle unconsumed yet be silently dropped by defer().
			const snapshots = params.ids.map((id) => manager.get(id)).filter((snapshot): snapshot is SubagentSnapshot => snapshot !== undefined);
			for (const snapshot of snapshots) delivery?.consume(snapshot.id);
			return makeToolResult(lines.join("\n"), {
				action: "cancel",
				ids: params.ids,
				subagents: snapshots,
				activity: snapshots.map((snapshot) => activityEnvelope(snapshot)),
			});
		},
	});

	pi.registerTool({
		name: "subagent_list",
		label: "Subagent List",
		description: SUBAGENT_TOOL_DESCRIPTIONS.list,
		promptSnippet: SUBAGENT_PROMPT_SNIPPET,
		promptGuidelines: SUBAGENT_PROMPT_GUIDELINES,
		parameters: Type.Object({}),
		async execute() {
			const snapshots = manager.list();
			const text = snapshots.length > 0 ? snapshots.map((snapshot) => formatSnapshotLine(snapshot, true)).join("\n") : "No subagents tracked.";
			return makeToolResult(text, { action: "list", subagents: snapshots });
		},
	});
}
