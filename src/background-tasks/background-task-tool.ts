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
		description: [
			"Spawn long-running work in the background. Two distinct modes:",
			"• runner=shell (default): MANAGED — the command is wrapped, output is tee'd to a log file, exit code is tracked, and completion wakes the orchestrator via a follow-up message plus a cmux notification.",
			"• runner=sumocode | runner=pi (visible required): HANDED OFF — launches a clean native command in a cmux split. NO output capture, NO exit polling, NO result harvest. The pane IS the deliverable.",
			"Use list/log/stop/clear to manage shell tasks. Agent panes appear in list at launch time and stay 'running' until manually stopped — their actual session is owned by the child agent.",
			"For programmatic agent result harvest, use a subagent tool (separate from this), not bg_task.",
		].join("\n"),
		promptSnippet: "Spawn managed shell tasks or hand off work to a visible pi/sumocode agent pane.",
		promptGuidelines: [
			"Use bg_task when the user wants long-running work to continue while the conversation stays usable.",
			"For shell commands (build, test, deploy, watchers), use runner=shell (the default) — output is logged and the orchestrator is notified on exit.",
			"For 'spin up sumocode/pi to work on X in a split', use runner=sumocode (or pi) with visible=true — the cmux pane is the UI, no result is captured.",
			"Do not call bg_task expecting to read the agent's final response — visible agent panes are hand-offs, not subagents.",
			"Use bg_task list/log/stop to inspect or terminate tracked shell tasks; stopping an agent pane closes its cmux surface.",
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
