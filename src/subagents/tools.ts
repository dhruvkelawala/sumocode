import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { TRUNCATED_HEAD_MARKER, boundRetainedResult } from "../child-protocol.js";
import type { DeferredResultDelivery } from "./delivery.js";
import { activityFromSubagentSnapshot } from "../activity/subagent-adapter.js";
import { getTerminalHost } from "../terminal-host/index.js";
import type { TerminalHost } from "../terminal-host/types.js";
import { latestText, type SubagentSnapshot } from "./domain.js";
import { type AtCapacityDetails, SubagentManager } from "./manager.js";
import { formatCompletionManifestSummary, SUBAGENT_PROMPT_GUIDELINES, SUBAGENT_PROMPT_SNIPPET, SUBAGENT_TOOL_DESCRIPTIONS } from "./prompt.js";
import { loadRoles } from "./roles.js";

const StringEnum = <T extends readonly string[]>(values: T, options?: { description?: string }) => {
	const schema = { type: "string" as const, enum: [...values] };
	return Type.Unsafe<T[number]>(
		options?.description ? { ...schema, description: options.description } : schema,
	);
};

const makeToolResult = <T>(text: string, details?: T) => ({ content: [{ type: "text" as const, text }], details });

const activityEnvelope = (snapshot: SubagentSnapshot, sourceId?: string) => {
	const activity = activityFromSubagentSnapshot(snapshot);
	return sourceId ? { ...activity, sourceId } : activity;
};

const isAtCapacity = (value: SubagentSnapshot | AtCapacityDetails): value is AtCapacityDetails => "status" in value && value.status === "at_capacity";

const isSettledSnapshot = (snapshot: SubagentSnapshot): boolean => snapshot.status !== "running" && snapshot.status !== "queued";

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

/** Cancellation details expose bounded identity/status, never raw transcripts. */
interface CancellationMetadata {
	id: string;
	title: string;
	status: SubagentSnapshot["status"];
	createdAt: number;
	settledAt?: number;
}

const cancellationMetadata = (snapshot: SubagentSnapshot): CancellationMetadata => {
	const meta: CancellationMetadata = {
		id: snapshot.id,
		title: trimLines(snapshot.title, 256, 1),
		status: snapshot.status,
		createdAt: snapshot.createdAt,
	};
	if (snapshot.settledAt !== undefined) meta.settledAt = snapshot.settledAt;
	return meta;
};

const formatDuration = (ms: number): string => {
	const seconds = Math.max(0, Math.round(ms / 1000));
	const minutes = Math.floor(seconds / 60);
	const rest = seconds % 60;
	return minutes > 0 ? `${minutes}m${rest}s` : `${rest}s`;
};

const formatSnapshotLine = (snapshot: SubagentSnapshot, includeBranch = false): string => {
	const model = snapshot.modelLabel ?? "inherit";
	const identity = [snapshot.roleId, model].filter((part): part is string => part !== undefined).join(", ");
	const branch = includeBranch && snapshot.worktree ? ` · ${snapshot.worktree.branch}` : "";
	const pane = snapshot.pane ? ` · pane ${snapshot.pane.paneId ?? snapshot.pane.tabId ?? snapshot.pane.workspaceId ?? "unknown"} · agent ${snapshot.pane.agentName}` : "";
	return `${snapshot.id} [${snapshot.status}] "${snapshot.title}" (${identity}, ${formatDuration(Date.now() - snapshot.createdAt)}, ${snapshot.cwd})${branch}${pane}`;
};

const manifestSummary = (snapshot: SubagentSnapshot): string | undefined => snapshot.manifest
	? formatCompletionManifestSummary(snapshot.manifest)
	: undefined;

const WAIT_AGENT_MAX_BYTES = 16 * 1024;
const WAIT_TOTAL_MAX_BYTES = 48 * 1024;
const WAIT_SEPARATOR = "\n\n---\n\n";
const WAIT_MARKER_BYTES = Buffer.byteLength(TRUNCATED_HEAD_MARKER, "utf8");

const boundWaitChunk = (text: string, maxBytes: number): string => boundRetainedResult(text, maxBytes);

const boundedWaitText = (snapshots: readonly SubagentSnapshot[]): string => {
	const chunks: string[] = [];
	let bytes = 0;
	for (const snapshot of snapshots) {
		// A failed child with partial text must still surface WHY it failed —
		// partial output alone is easy to misread as a successful result.
		const errorLine = snapshot.status === "error" && snapshot.errorText ? `error: ${snapshot.errorText}\n` : "";
		const body = `${errorLine}${latestText(snapshot) || (errorLine ? "" : snapshot.errorText || "(no output)")}`;
		const raw = [`${snapshot.id} [${snapshot.status}] ${snapshot.title}`, manifestSummary(snapshot), body].filter((line): line is string => line !== undefined).join("\n");
		const chunk = boundWaitChunk(raw, WAIT_AGENT_MAX_BYTES);
		const separatorBytes = chunks.length === 0 ? 0 : Buffer.byteLength(WAIT_SEPARATOR, "utf8");
		const remaining = WAIT_TOTAL_MAX_BYTES - bytes - separatorBytes;
		if (remaining <= WAIT_MARKER_BYTES) {
			return boundWaitChunk(`${chunks.join(WAIT_SEPARATOR)}${TRUNCATED_HEAD_MARKER}`, WAIT_TOTAL_MAX_BYTES);
		}
		const retained = Buffer.byteLength(chunk, "utf8") <= remaining ? chunk : boundWaitChunk(chunk, remaining);
		chunks.push(retained);
		bytes += separatorBytes + Buffer.byteLength(retained, "utf8");
		if (bytes >= WAIT_TOTAL_MAX_BYTES) break;
	}
	return chunks.join(WAIT_SEPARATOR);
};

export function registerSubagentTools(
	pi: ExtensionAPI,
	manager: SubagentManager,
	delivery?: Pick<DeferredResultDelivery, "consume">,
	host: TerminalHost = getTerminalHost(),
	roleLoader: typeof loadRoles = loadRoles,
): void {
	const registeredRoles = roleLoader().roles;
	const roleDescription = [
		"Optional role preset. Explicit spawn parameters override role defaults. Known roles:",
		...registeredRoles.map((role) => `${role.id} — ${role.description}${role.defaultWorktree ? " (isolated worktree by default)" : ""}`),
	].join("\n");
	pi.registerTool({
		name: "subagent_spawn",
		label: "Subagent Spawn",
		description: SUBAGENT_TOOL_DESCRIPTIONS.spawn,
		promptSnippet: SUBAGENT_PROMPT_SNIPPET,
		promptGuidelines: SUBAGENT_PROMPT_GUIDELINES,
		parameters: Type.Object({
			prompt: Type.String({ description: "Self-contained child subagent prompt." }),
			name: Type.String({ description: "Short human-readable title for this subagent." }),
			role: Type.Optional(Type.String({ description: roleDescription })),
			model: Type.Optional(Type.String({ description: "Optional model override as provider/modelId." })),
			thinking: Type.Optional(StringEnum(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const, { description: "Optional thinking level override." })),
			working_dir: Type.Optional(Type.String({ description: "Working directory for the child. Defaults to the current project cwd." })),
			worktree: Type.Optional(Type.Boolean({ description: "Run the child in an isolated git worktree on a new sumo/<slug> branch from HEAD by default. Its edits never touch your checkout. The worktree is preserved after completion; it is never auto-removed." })),
			branch: Type.Optional(Type.String({ description: "Optional branch override for an isolated worktree spawn." })),
			baseRef: Type.Optional(Type.String({ description: "Base git ref for the isolated worktree (only with worktree: true); defaults to HEAD. Use origin/main to branch from the pushed tip rather than your local checkout." })),
			visible: Type.Optional(Type.Boolean({ description: "Open the child as an interactive pane in the terminal host — watchable and steerable; requires a running terminal host." })),
		}),
		async execute(toolCallId, params, _signal, _onUpdate, ctx) {
			const loaded = roleLoader();
			const loadedRoles = loaded.roles;
			if (params.role && loaded.warnings.length > 0) {
				return makeToolResult(`Unable to spawn role ${params.role}: roles.json has invalid configuration:\n${loaded.warnings.map((warning) => `- ${warning}`).join("\n")}`, {
					action: "spawn",
					status: "invalid_role_config",
					role: params.role,
					warnings: loaded.warnings,
				});
			}
			const role = params.role ? loadedRoles.find((candidate) => candidate.id === params.role) : undefined;
			if (params.role && !role) {
				const knownRoles = loadedRoles.map((candidate) => candidate.id);
				return makeToolResult(`Unknown subagent role: ${params.role}. Known roles: ${knownRoles.join(", ") || "(none)"}.`, {
					action: "spawn",
					status: "unknown_role",
					role: params.role,
					knownRoles,
				});
			}
			const visible = params.visible ?? role?.defaultVisible;
			if (visible === true && host.kind === "none") {
				throw new Error("visible subagents require a running herdr terminal host");
			}
			const activeTools = pi.getActiveTools();
			const builtInTools = role?.tools
				? role.tools.filter((tool) => activeTools.includes(tool))
				: activeTools;
			const spawned = await manager.spawn({
				sourceId: toolCallId,
				prompt: params.prompt,
				title: params.name,
				cwd: params.working_dir ?? ctx.cwd,
				roleId: role?.id,
				appendSystemPrompt: role?.systemPrompt,
				visible,
				worktree: params.worktree ?? role?.defaultWorktree,
				branch: params.branch,
				baseRef: params.baseRef,
				model: params.model ?? role?.model,
				thinking: params.thinking ?? role?.thinking,
				inherited: {
					model: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined,
					// Mirror native-task-tool.ts (`pi.getThinkingLevel()` at spawn time):
					// children inherit the parent session's thinking level unless the
					// call overrides it, instead of silently defaulting to "low".
					thinking: pi.getThinkingLevel(),
				},
				builtInTools,
			});
			if (isAtCapacity(spawned)) return formatAtCapacity(spawned);
			if (spawned.status === "queued") {
				const position = manager.list().filter((snapshot) => snapshot.status === "queued").findIndex((snapshot) => snapshot.id === spawned.id) + 1;
				return makeToolResult(`Queued ${spawned.id} (${spawned.title}) at position ${position} — starts automatically when a slot frees. Do not retry or wait.`, {
					action: "spawn",
					subagent: spawned,
					activity: activityEnvelope(spawned, toolCallId),
				});
			}
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
			return makeToolResult(`Started ${spawned.id} (${spawned.title}). No polling needed — continue other work or END YOUR TURN; the result will be delivered to you and wake you automatically when it settles. Only call subagent_wait if you cannot take a single further step without this result.`, {
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
			text: Type.String({ minLength: 1, description: "Non-blank steering text to submit to the child runtime." }),
		}),
		async execute(_toolCallId, params) {
			// Schema minLength plus an explicit trim guard: blank steering would be
			// consumed by the child without ever reaching Pi while the tool still
			// reported success.
			if (!params.text.trim()) {
				throw new Error("subagent_send text is required: blank or whitespace-only steering is rejected before submission");
			}
			const snapshot = await manager.sendTo(params.id, params.text);
			return makeToolResult(`Steering submitted to the child runtime for ${params.id} (${snapshot.title}); Pi exposes no post-acceptance acknowledgement.`, { action: "send", id: params.id, pane: snapshot.pane });
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
				subagents: snapshots.map(cancellationMetadata),
				activity: snapshots.map((snapshot) => activityEnvelope(snapshot)),
			});
		},
	});

	pi.registerTool({
		name: "subagent_close",
		label: "Subagent Close",
		description: SUBAGENT_TOOL_DESCRIPTIONS.close,
		promptSnippet: SUBAGENT_PROMPT_SNIPPET,
		promptGuidelines: SUBAGENT_PROMPT_GUIDELINES,
		parameters: Type.Object({
			ids: Type.Array(Type.String(), { maxItems: 64, description: "Visible subagent ids to close gracefully." }),
		}),
		async execute(_toolCallId, params) {
			const lines = await manager.close(params.ids);
			// Ids that settled during the close return their result inline —
			// consume them so the deferred delivery does not ALSO report them
			// on the next agent_end. Still-running ids keep their deferred result.
			const snapshots = params.ids.map((id) => manager.get(id)).filter((snapshot): snapshot is SubagentSnapshot => snapshot !== undefined);
			const settled = snapshots.filter(isSettledSnapshot);
			for (const snapshot of settled) delivery?.consume(snapshot.id);
			const text = settled.length > 0 ? `${lines.join("\n")}\n\n${boundedWaitText(settled)}` : lines.join("\n");
			return makeToolResult(text, {
				action: "close",
				ids: params.ids,
				subagents: settled.map(cancellationMetadata),
				activity: settled.map((snapshot) => activityEnvelope(snapshot)),
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
