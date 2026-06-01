import { existsSync, readFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	BackgroundTaskManager,
	DEFAULT_SUMOCODE_AGENT_MODEL,
	DEFAULT_SUMOCODE_AGENT_THINKING,
} from "./task-manager.js";
import { type BackgroundTask, type BackgroundTaskThinking, toBackgroundTaskSnapshot } from "./task-types.js";

/**
 * Read the last ~2KB of an agent task's output.log when surfacing a terminal
 * state without response.md. The log captures the watchdog-timeout message
 * (and any other bg-task instrumentation) so the caller can see WHY harvest
 * never completed instead of just "ended without response.md".
 */
function readLogTailForAgent(task: BackgroundTask, maxChars = 2048): string {
	if (!task.logFile || !existsSync(task.logFile)) return "";
	try {
		const content = readFileSync(task.logFile, "utf8");
		return content.length <= maxChars ? content : content.slice(-maxChars);
	} catch {
		return "";
	}
}

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
	// detached / cmux-owned) and let the new manager recover from disk-stored
	// meta.json on startup.
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
			`• AGENT (runner='sumocode', visible=true required) — spawn a child SumoCode agent in a new cmux split. The prompt is delivered as the kickoff message, the child opens straight into the agent loop (no splash). If model/thinking are omitted, SumoCode uses ${DEFAULT_SUMOCODE_AGENT_MODEL} with ${DEFAULT_SUMOCODE_AGENT_THINKING} thinking (override process-wide with SUMOCODE_BG_AGENT_MODEL / SUMOCODE_BG_AGENT_THINKING). Explicit model/thinking params override those defaults. The child writes its FINAL assistant message to response.md; the orchestrator reads it via bg_task log. Task transitions to status='completed' as soon as response.md appears. After 10s idle, the pane auto-closes via cmux close-surface.`,
			"",
			"Actions:",
			"  spawn  — start a task. Returns task id + paths.",
			"  list   — list tracked tasks with status, runner, cmux refs.",
			"  log    — read the task's output. For shell, returns output.log tail. For agent, returns response.md (the harvested final assistant message) when present, or a 'still working' marker if the agent hasn't responded yet. Poll until ready.",
			"  stop   — SIGTERM a shell task, or cmux close-surface for an agent pane.",
			"  clear  — remove finished/stopped tasks from the in-memory list.",
		].join("\n"),
		promptSnippet:
			"Spawn managed shell tasks or hand off prompts to a visible SumoCode agent pane (with model/thinking override and harvestable response).",
		promptGuidelines: [
			"Use bg_task when the user wants long-running work to continue while the conversation stays usable.",
			"For shell commands (build, test, deploy, watchers), use bg_task with runner='shell' (the default) — output is logged and the orchestrator is notified on exit.",
			`To delegate a prompt to a child SumoCode agent, use bg_task with runner='sumocode' and visible=true. If the user does not specify a model, omit model/thinking and let the child default to ${DEFAULT_SUMOCODE_AGENT_MODEL} with ${DEFAULT_SUMOCODE_AGENT_THINKING} thinking. The child opens in a cmux split, runs the prompt, and writes its response back. Read it with bg_task action='log' once status='completed'.`,
			`Pass model and thinking to bg_task only when the user explicitly wants to override the agent defaults (${DEFAULT_SUMOCODE_AGENT_MODEL}, thinking=${DEFAULT_SUMOCODE_AGENT_THINKING}); process-wide defaults can be set with SUMOCODE_BG_AGENT_MODEL and SUMOCODE_BG_AGENT_THINKING.`,
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
						"Required for action=spawn. For runner='shell' this is the bash command (e.g. 'pnpm test'). For runner='sumocode' this is the prompt the child agent will receive as its kickoff message.",
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
						"Open in a new cmux split. REQUIRED when runner='sumocode'. Defaults to false for shell tasks (invisible managed child).",
				}),
			),
			runner: Type.Optional(
				StringEnum(["shell", "sumocode"] as const, {
					description:
						"'shell' (default) = managed bash command. 'sumocode' = visible delegated SumoCode agent pane with response harvest.",
				}),
			),
			model: Type.Optional(
				Type.String({
					description:
						`Pi model pattern for runner='sumocode'. Defaults to ${DEFAULT_SUMOCODE_AGENT_MODEL} when omitted (or SUMOCODE_BG_AGENT_MODEL if set). Forwarded as --model to the child. Ignored for runner='shell'.`,
				}),
			),
			thinking: Type.Optional(
				StringEnum(["off", "minimal", "low", "medium", "high", "xhigh"] as const, {
					description:
						`Pi thinking level for runner='sumocode'. Defaults to ${DEFAULT_SUMOCODE_AGENT_THINKING} when omitted (or SUMOCODE_BG_AGENT_THINKING if set). Forwarded as --thinking to the child. Ignored for runner='shell'.`,
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
						"Wake the orchestrator with a follow-up message + cmux notification when the task reaches a terminal state. Defaults to true. For agent runners, this fires when response.md is harvested or the watchdog fails.",
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
					task.runner === "sumocode"
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
					if (harvest.ready && harvest.content) {
						return makeToolResult(harvest.content, {
							action: "log",
							task: snapshot,
							kind: "response",
							ready: true,
						});
					}
					// No response.md content. Either the task is still running (poll
					// again) or it reached a terminal state without writing response.md
					// (watchdog, stop, crash). Surface the actual state so callers don't
					// poll forever.
					if (task.status === "running") {
						const paneHint = task.cmux ? ` (cmux pane ${task.cmux.surfaceRef})` : "";
						return makeToolResult(
							`Agent ${task.id} is still working${paneHint}. response.md not written yet — poll bg_task action=log again, or check bg_task action=list for status.`,
							{ action: "log", task: snapshot, kind: "response", ready: false },
						);
					}
					const exitDetail = task.exitCode != null ? ` (exitCode=${task.exitCode})` : "";
					const logTail = readLogTailForAgent(task);
					const logFooter = logTail ? `\n\n--- output.log tail ---\n${logTail}` : "";
					return makeToolResult(
						`Agent ${task.id} ended without writing response.md (status=${task.status}${exitDetail}). The agent may have crashed, been stopped, or hit the harvest watchdog before its first agent_end fired.${logFooter}`,
						{
							action: "log",
							task: snapshot,
							kind: "response",
							ready: true,
							terminal: true,
						},
					);
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
