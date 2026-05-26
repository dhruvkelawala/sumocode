import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { BackgroundTaskManager } from "./task-manager.js";
import { type BackgroundTaskThinking, toBackgroundTaskSnapshot } from "./task-types.js";

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

	// `session_shutdown` fires not only on process exit but also during
	// /reload, /new, /resume, /fork (Pi tears down and rebinds the extension
	// runtime). If we killed every running task on those events, a user
	// reloading SumoCode would lose every long-running `bg_task spawn` job
	// they had in flight. Only kill on a real process-quit shutdown; on
	// session replacement, leave the child processes running (they're already
	// detached / cmux-owned) and let the new manager start with an empty
	// in-memory map. Recovery from disk-stored meta.json is a future feature.
	pi.on("session_shutdown", (event) => {
		const reason = (event as { reason?: string } | null | undefined)?.reason;
		if (reason === "quit" || reason === undefined) {
			manager.shutdown();
		}
	});

	pi.registerTool({
		name: "bg_task",
		label: "Background Task",
		description: [
			"Spawn long-running work in a background process or a visible cmux pane. Two modes:",
			"",
			"• SHELL (runner='shell', default) — spawn a managed shell command. Output is tee'd to a log file, exit code is captured, and completion wakes the orchestrator via a follow-up message and cmux notification. Use for builds, tests, deploys, watchers, anything you want to fire-and-forget.",
			"",
			"• AGENT (runner='sumocode' or 'pi', visible=true required) — spawn a child agent in a new cmux split. The prompt is delivered as the kickoff message, the child opens straight into the agent loop (no splash). Optional model/thinking flags override the child's defaults. The child writes its FINAL assistant message to response.md; the orchestrator reads it via bg_task log. Task transitions to status='completed' as soon as response.md appears. After 10s idle, the pane auto-closes via cmux close-surface.",
			"",
			"Actions:",
			"  spawn  — start a task. Returns task id + paths.",
			"  list   — list tracked tasks with status, runner, cmux refs.",
			"  log    — read the task's output. For shell, returns output.log tail. For agent, returns response.md (the harvested final assistant message) when present, or a 'still working' marker if the agent hasn't responded yet. Poll until ready.",
			"  stop   — SIGTERM a shell task, or cmux close-surface for an agent pane.",
			"  clear  — remove finished/stopped tasks from the in-memory list.",
		].join("\n"),
		promptSnippet:
			"Spawn managed shell tasks or hand off prompts to a visible pi/sumocode agent pane (with model/thinking override and harvestable response).",
		promptGuidelines: [
			"Use bg_task when the user wants long-running work to continue while the conversation stays usable.",
			"For shell commands (build, test, deploy, watchers), use bg_task with runner='shell' (the default) — output is logged and the orchestrator is notified on exit.",
			"To delegate a prompt to a child agent, use bg_task with runner='sumocode' and visible=true. The child opens in a cmux split, runs the prompt, and writes its response back. Read it with bg_task action='log' once status='completed'.",
			"Pass model and thinking to bg_task when delegating an agent task to override the child's defaults (e.g. model='openai/gpt-4o-mini' thinking='low' for a cheap quick task, or model='anthropic/claude-opus-4-6' thinking='xhigh' for deep work).",
			"To read a delegated agent's response, call bg_task with action='log' and id='bg-N'. If the response isn't ready yet, the result will indicate 'still working' — poll again. List with bg_task action='list' to see which tasks have status='completed'.",
			"Use bg_task action='stop' to cancel a task. For agent panes this closes the cmux surface, preserving any response that was already written.",
		],
		parameters: Type.Object({
			action: StringEnum(["spawn", "list", "log", "stop", "clear"] as const, {
				description:
					"spawn = start a task. list = show tracked tasks. log = read output (response.md for agents, output.log for shell). stop = terminate. clear = drop finished tasks.",
			}),
			command: Type.Optional(
				Type.String({
					description:
						"Required for action=spawn. For runner='shell' this is the bash command (e.g. 'pnpm test'). For runner='sumocode' or 'pi' this is the prompt the child agent will receive as its kickoff message.",
				}),
			),
			cwd: Type.Optional(
				Type.String({
					description:
						"Working directory for the spawned task. Defaults to the orchestrator's cwd. For agent runners this is the project the child opens in.",
				}),
			),
			id: Type.Optional(Type.String({ description: "Task id (e.g. 'bg-1') for action=log or action=stop." })),
			pid: Type.Optional(Type.Number({ description: "Alternative to id: lookup by spawned pid." })),
			visible: Type.Optional(
				Type.Boolean({
					description:
						"Open in a new cmux split. REQUIRED when runner='sumocode' or runner='pi'. Defaults to false for shell tasks (invisible managed child).",
				}),
			),
			runner: Type.Optional(
				StringEnum(["shell", "pi", "sumocode"] as const, {
					description:
						"'shell' (default) = managed bash command. 'sumocode' = visible delegated agent pane with response harvest. 'pi' = visible bare pi pane with response harvest.",
				}),
			),
			model: Type.Optional(
				Type.String({
					description:
						"Pi model pattern for agent runners. Examples: 'openai/gpt-4o-mini', 'anthropic/claude-sonnet-4-5', 'cursor/composer-2.5'. Forwarded as --model to the child. Ignored for runner='shell'.",
				}),
			),
			thinking: Type.Optional(
				StringEnum(["off", "minimal", "low", "medium", "high", "xhigh"] as const, {
					description:
						"Pi thinking level for agent runners. Forwarded as --thinking to the child. Ignored for runner='shell'.",
				}),
			),
			direction: Type.Optional(
				StringEnum(["right", "down"] as const, {
					description: "Cmux split direction when visible=true. Default: right.",
				}),
			),
			title: Type.Optional(
				Type.String({ description: "Optional human-readable label shown in bg_task list and notifications." }),
			),
			notifyOnExit: Type.Optional(
				Type.Boolean({
					description:
						"For runner='shell': wake the orchestrator with a follow-up message + cmux notification on exit. Defaults to true. Has no effect for agent runners (they always set status='completed' when response.md is harvested).",
				}),
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
					model: params.model,
					thinking: params.thinking as BackgroundTaskThinking | undefined,
					notifyOnExit: params.notifyOnExit,
				});

				const snapshot = toBackgroundTaskSnapshot(task);
				const cmuxLine = task.cmux
					? `\nCmux: ${task.cmux.surfaceRef} (${task.cmux.workspaceRef})`
					: "";
				const pidLine = task.pid != null ? `\nPid: ${task.pid}` : "";
				const harvestHint =
					task.runner !== "shell"
						? `\nHarvest: bg_task action=log id=${task.id} (returns response.md when ready)`
						: "";
				const modelLine = task.model || task.thinking
					? `\nModel: ${task.model ?? "(inherit)"}${task.thinking ? ` thinking=${task.thinking}` : ""}`
					: "";

				return makeToolResult(
					`Started ${task.id} in the background.\nCommand: ${task.command}\nCwd: ${task.cwd}\nRunner: ${task.runner}${modelLine}\nLog: ${task.logFile}${pidLine}${cmuxLine}${harvestHint}`,
					{ action: "spawn", task: snapshot },
				);
			}

			const task = manager.findTask(params.id, params.pid);
			if (!task) {
				throw new Error("No background task matched that id or pid.");
			}

			if (params.action === "log") {
				const harvest = manager.getTaskHarvest(task);
				const snapshot = toBackgroundTaskSnapshot(task);
				if (harvest.kind === "response") {
					if (!harvest.ready) {
						const paneHint = task.cmux
							? ` (cmux pane ${task.cmux.surfaceRef})`
							: "";
						return makeToolResult(
							`Agent ${task.id} is still working${paneHint}. response.md not written yet — poll bg_task action=log again, or check bg_task action=list for status.`,
							{ action: "log", task: snapshot, kind: "response", ready: false },
						);
					}
					return makeToolResult(harvest.content || "(empty response)", {
						action: "log",
						task: snapshot,
						kind: "response",
						ready: true,
					});
				}
				return makeToolResult(harvest.content || "(no output yet)", {
					action: "log",
					task: snapshot,
					kind: "log",
					ready: true,
				});
			}

			const stopped = await manager.stopTask(task);
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
