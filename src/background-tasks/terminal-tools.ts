import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { DeferredResultDelivery } from "../subagents/delivery.js";
import { flushDeferredResultDelivery } from "../subagents/index.js";
import type { BackgroundTaskManager } from "./task-manager.js";
import {
	BG_KILL_DESCRIPTION,
	BG_LIST_DESCRIPTION,
	BG_START_DESCRIPTION,
	BG_STATUS_DESCRIPTION,
	buildStartResult,
	buildStatusResult,
	buildTerminalResultMessage,
	describeTerminal,
	TERMINAL_TOOL_GUIDELINES,
} from "./terminal-prompt.js";
import { type BackgroundTaskSnapshot, toBackgroundTaskSnapshot } from "./task-types.js";

export type TerminalTaskFinalizedHandler = (task: BackgroundTaskSnapshot) => void;

function makeToolResult(text: string, details?: unknown) {
	return {
		content: [{ type: "text" as const, text }],
		details,
	};
}

function shellTasks(manager: BackgroundTaskManager) {
	return manager.listTasks().filter((task) => task.runner === "shell");
}

function knownTerminalIds(manager: BackgroundTaskManager): string {
	const ids = shellTasks(manager).map((task) => task.id);
	return ids.length > 0 ? ids.join(", ") : "none";
}

export function installTerminalTools(
	pi: ExtensionAPI,
	manager: BackgroundTaskManager,
	delivery: DeferredResultDelivery,
): TerminalTaskFinalizedHandler {
	const typedTerminalIds = new Set<string>();

	pi.registerTool({
		name: "bg_start",
		label: "Background Terminal Start",
		description: BG_START_DESCRIPTION,
		promptSnippet: "Start a non-interactive shell command in a managed background terminal.",
		promptGuidelines: [...TERMINAL_TOOL_GUIDELINES],
		parameters: Type.Object({
			command: Type.String({ description: "Shell command to run without stdin." }),
			title: Type.String({ description: "Short human-readable label for the terminal." }),
			working_dir: Type.Optional(Type.String({ description: "Working directory. Defaults to the current project directory." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionContext) {
			const task = manager.spawnTask({
				command: params.command,
				cwd: params.working_dir ?? ctx.cwd,
				title: params.title,
				runner: "shell",
				visible: false,
				notifyOnExit: false,
			});
			typedTerminalIds.add(task.id);
			const snapshot = toBackgroundTaskSnapshot(task);
			return makeToolResult(buildStartResult(snapshot), { task: snapshot });
		},
	});

	pi.registerTool({
		name: "bg_status",
		label: "Background Terminal Status",
		description: BG_STATUS_DESCRIPTION,
		promptSnippet: "Peek at one background terminal without waiting for it to finish.",
		promptGuidelines: [...TERMINAL_TOOL_GUIDELINES],
		parameters: Type.Object({
			id: Type.String({ description: "Background terminal id returned by bg_start." }),
		}),
		async execute(_toolCallId, params) {
			const task = manager.findTask(params.id);
			if (!task || task.runner !== "shell") {
				return makeToolResult(
					`Unknown background terminal ${params.id}. Known terminal ids: ${knownTerminalIds(manager)}.`,
					{ id: params.id, status: "unknown" },
				);
			}
			const snapshot = toBackgroundTaskSnapshot(task);
			return makeToolResult(buildStatusResult(snapshot, manager.getTaskOutput(task, 16 * 1024)), { task: snapshot });
		},
	});

	pi.registerTool({
		name: "bg_kill",
		label: "Background Terminal Kill",
		description: BG_KILL_DESCRIPTION,
		promptSnippet: "Stop one or more managed background terminals.",
		promptGuidelines: [...TERMINAL_TOOL_GUIDELINES],
		parameters: Type.Object({
			ids: Type.Array(Type.String(), { minItems: 1, description: "Background terminal ids to stop." }),
		}),
		async execute(_toolCallId, params) {
			const lines: string[] = [];
			for (const id of params.ids) {
				const task = manager.findTask(id);
				if (!task || task.runner !== "shell") {
					lines.push(`Unknown background terminal ${id}.`);
					continue;
				}
				if (task.status !== "running") {
					typedTerminalIds.delete(id);
					lines.push(`Background terminal ${id} was already ${task.status}.`);
					continue;
				}
				const stopped = await manager.stopTask(task);
				typedTerminalIds.delete(id);
				lines.push(stopped.ok ? `Killed background terminal ${id}.` : `Failed to kill background terminal ${id}: ${stopped.message}`);
			}
			return makeToolResult(lines.join("\n"), { ids: [...params.ids] });
		},
	});

	pi.registerTool({
		name: "bg_list",
		label: "Background Terminal List",
		description: BG_LIST_DESCRIPTION,
		promptSnippet: "List managed shell background terminals.",
		promptGuidelines: [...TERMINAL_TOOL_GUIDELINES],
		parameters: Type.Object({}),
		async execute() {
			const tasks = shellTasks(manager);
			return makeToolResult(
				tasks.length > 0 ? tasks.map(describeTerminal).join("\n") : "No background terminals tracked.",
				{ tasks },
			);
		},
	});

	return (snapshot): void => {
		if (!typedTerminalIds.has(snapshot.id)) return;
		const task = manager.findTask(snapshot.id);
		// Never consume or otherwise poison delivery state for an id the manager
		// no longer knows (for example after a clear or process recovery boundary).
		if (!task || task.runner !== "shell") return;
		typedTerminalIds.delete(snapshot.id);
		const finalized = toBackgroundTaskSnapshot(task);
		delivery.defer(finalized.id, () => ({
			id: finalized.id,
			customType: "terminal-result",
			title: finalized.title ?? finalized.command,
			status: finalized.status,
			content: buildTerminalResultMessage(finalized, manager.getTaskOutput(task, 8 * 1024)),
			details: finalized,
		}));
		flushDeferredResultDelivery(delivery);
	};
}
