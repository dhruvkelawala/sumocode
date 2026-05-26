import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { BackgroundTaskManager } from "./task-manager.js";
import { toBackgroundTaskSnapshot } from "./task-types.js";

const StringEnum = <T extends readonly string[]>(values: T, options?: { description?: string }) =>
	Type.Unsafe<T[number]>({
		type: "string",
		enum: [...values],
		...(options?.description ? { description: options.description } : {}),
	});

function makeToolResult(text: string, details?: unknown) {
	return {
		content: [{ type: "text" as const, text }],
		details,
	};
}

export function installBackgroundTasks(pi: ExtensionAPI): BackgroundTaskManager {
	const manager = new BackgroundTaskManager(pi);

	pi.on("session_shutdown", () => {
		manager.shutdown();
	});

	pi.registerTool({
		name: "bg_task",
		label: "Background Task",
		description:
			"Spawn, inspect, and stop non-blocking shell tasks. Use visible=true inside cmux to open a live split pane. Tasks write persistent logs and can wake the agent on exit.",
		promptSnippet: "Spawn and manage non-blocking background shell tasks.",
		promptGuidelines: [
			"Use bg_task instead of bash backgrounding when the user wants long-running work to continue while the conversation stays usable.",
			"Pass visible=true when the user wants to watch output in a cmux split.",
			"Use runner=sumocode or runner=pi for visible agent tasks so the pane shows the native agent UI instead of a shell wrapper.",
			"Use bg_task list/log/stop to inspect or terminate tracked tasks.",
		],
		parameters: Type.Object({
			action: StringEnum(["spawn", "list", "log", "stop", "clear"] as const, {
				description: "spawn=start, list=show tasks, log=tail output, stop=terminate, clear=remove finished",
			}),
			command: Type.Optional(Type.String({ description: "Shell command for action=spawn" })),
			cwd: Type.Optional(Type.String({ description: "Working directory for action=spawn" })),
			id: Type.Optional(Type.String({ description: "Task id for action=log or action=stop" })),
			pid: Type.Optional(Type.Number({ description: "PID for action=log or action=stop" })),
			visible: Type.Optional(
				Type.Boolean({ description: "When true, run in a new cmux split (requires cmux surface)." }),
			),
			runner: Type.Optional(
				StringEnum(["shell", "pi", "sumocode"] as const, {
					description: "How to run the task: shell command, pi prompt, or sumocode prompt. Default: shell.",
				}),
			),
			direction: Type.Optional(
				StringEnum(["right", "down"] as const, {
					description: "Cmux split direction when visible=true (default: right).",
				}),
			),
			title: Type.Optional(Type.String({ description: "Optional display label for action=spawn" })),
			notifyOnExit: Type.Optional(
				Type.Boolean({ description: "Wake the agent when the task exits. Defaults to true." }),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionContext) {
			if (params.action === "list") {
				return makeToolResult(manager.formatTaskListText(), {
					action: "list",
					tasks: manager.listTasks(),
				});
			}

			if (params.action === "clear") {
				const removed = manager.clearFinishedTasks();
				return makeToolResult(`Removed ${removed} finished background task(s).`, { action: "clear", removed });
			}

			if (params.action === "spawn") {
				const task = manager.spawnTask({
					command: params.command ?? "",
					cwd: params.cwd ?? ctx.cwd,
					title: params.title,
					visible: params.visible,
					direction: params.direction,
					runner: params.runner,
					notifyOnExit: params.notifyOnExit,
				});

				const snapshot = toBackgroundTaskSnapshot(task);
				const cmuxLine = task.cmux
					? `\nCmux: ${task.cmux.surfaceRef} (${task.cmux.workspaceRef})`
					: "";
				const pidLine = task.pid != null ? `\nPid: ${task.pid}` : "";

				return makeToolResult(
					`Started ${task.id} in the background.\nCommand: ${task.command}\nCwd: ${task.cwd}\nLog: ${task.logFile}${pidLine}${cmuxLine}`,
					{ action: "spawn", task: snapshot },
				);
			}

			const task = manager.findTask(params.id, params.pid);
			if (!task) {
				throw new Error("No background task matched that id or pid.");
			}

			if (params.action === "log") {
				const output = manager.getTaskOutput(task);
				return makeToolResult(output || "(no output yet)", {
					action: "log",
					task: toBackgroundTaskSnapshot(task),
				});
			}

			const stopped = manager.stopTask(task);
			if (!stopped.ok) {
				throw new Error(stopped.message);
			}
			return makeToolResult(stopped.message, {
				action: "stop",
				task: toBackgroundTaskSnapshot(task),
			});
		},
	});

	pi.registerCommand("bg", {
		description: "List tracked background tasks",
		handler: async (_args, ctx) => {
			const text = manager.formatTaskListText();
			ctx.ui.notify(text, "info");
		},
	});

	pi.registerCommand("bg-run", {
		description: "Spawn a background shell task (/bg-run <command>)",
		handler: async (args, ctx) => {
			const command = args.trim();
			if (!command) {
				ctx.ui.notify("Usage: /bg-run <command>", "warning");
				return;
			}
			try {
				const task = manager.spawnTask({ command, cwd: ctx.cwd });
				ctx.ui.notify(`started ${task.id} · log ${task.logFile}`, "info");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(message, "error");
			}
		},
	});

	return manager;
}
