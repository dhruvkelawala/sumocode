import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildShellCommand, isInCmux, openCommandInNewSplit, shellEscape, type SplitDirection } from "./cmux-split.js";
import { chooseDiffSplitDirection, type TerminalSize } from "./diff.js";
import { createWorktree, listWorktrees, removeWorktree, type CreateWorktreeResult, type ListWorktreesResult, type RemoveWorktreeResult } from "../git/worktree.js";

const DEFAULT_SETUP_ACTION = "pnpm install";

export interface WorktreeCommandOptions {
	readonly create?: typeof createWorktree;
	readonly list?: typeof listWorktrees;
	readonly remove?: typeof removeWorktree;
	readonly openSplit?: typeof openCommandInNewSplit;
	readonly isInCmux?: typeof isInCmux;
	readonly terminalSize?: () => TerminalSize;
	readonly setupAction?: string;
}

export interface ParsedWorktreeArgs {
	readonly mode: "open" | "prune";
	readonly task: string;
}

function terminalSize(): TerminalSize {
	return { columns: process.stdout.columns, rows: process.stdout.rows };
}

export function parseWorktreeArgs(args: string): ParsedWorktreeArgs {
	const trimmed = args.trim();
	if (trimmed === "prune" || trimmed.startsWith("prune ")) {
		return { mode: "prune", task: trimmed.slice("prune".length).trim() };
	}
	return { mode: "open", task: trimmed };
}

function notify(pi: Pick<ExtensionAPI, "sendMessage">, ctx: ExtensionContext, message: string, type: "info" | "warning" = "info"): void {
	if (ctx.hasUI) {
		pi.sendMessage(
			{
				customType: "sumo:worktree",
				content: message,
				display: true,
				details: { type, message },
			},
			{ triggerTurn: false },
		);
		ctx.ui.notify(message, type);
		return;
	}
	process.stdout.write(`${message}\n`);
}

function commandForWorktree(task: string, setupAction: string): string {
	const setup = setupAction.trim();
	const setupPrefix = setup ? `${setup} && ` : "";
	return `${setupPrefix}SUMOCODE_TASK_KEEP_OPEN=1 exec sumocode task ${shellEscape(task)}`;
}

async function handlePrune(
	pi: Pick<ExtensionAPI, "sendMessage">,
	ctx: ExtensionContext,
	target: string,
	list: typeof listWorktrees,
	remove: typeof removeWorktree,
): Promise<void> {
	const listed = await list(ctx.cwd);
	if (!listed.ok) {
		notify(pi, ctx, `/sumo:worktree prune: ${listed.message}`, "warning");
		return;
	}
	const sumoWorktrees = listed.worktrees.filter((worktree) => worktree.branch?.startsWith("sumo/"));
	if (!target) {
		if (sumoWorktrees.length === 0) {
			notify(pi, ctx, "no sumo worktrees found");
			return;
		}
		const lines = sumoWorktrees.map((worktree) => `${worktree.branch ?? "detached"} · ${worktree.path}`);
		notify(pi, ctx, `sumo worktrees:\n${lines.join("\n")}\nrun /sumo:worktree prune <branch-or-path> to remove one`);
		return;
	}
	const match = sumoWorktrees.find((worktree) => worktree.path === target || worktree.branch === target);
	if (!match) {
		notify(pi, ctx, `/sumo:worktree prune: no tracked sumo worktree matched ${target}`, "warning");
		return;
	}
	const removed = await remove({ repoRoot: ctx.cwd, path: match.path });
	if (!removed.ok) {
		notify(pi, ctx, `/sumo:worktree prune: ${removed.message}`, "warning");
		return;
	}
	notify(pi, ctx, `removed worktree ${match.branch ?? match.path}`);
}

export function registerWorktreeCommand(pi: ExtensionAPI, options: WorktreeCommandOptions = {}): void {
	const create = options.create ?? createWorktree;
	const list = options.list ?? listWorktrees;
	const remove = options.remove ?? removeWorktree;
	const openSplit = options.openSplit ?? openCommandInNewSplit;
	const isInsideCmux = options.isInCmux ?? isInCmux;
	const getTerminalSize = options.terminalSize ?? terminalSize;
	const setupAction = options.setupAction ?? process.env.SUMOCODE_WORKTREE_SETUP ?? DEFAULT_SETUP_ACTION;

	pi.registerCommand("sumo:worktree", {
		description: "Create a named git worktree and open an interactive SumoCode pane, or prune explicit sumo worktrees",
		handler: async (args, ctx) => {
			try {
				const parsed = parseWorktreeArgs(args ?? "");
				if (parsed.mode === "prune") {
					await handlePrune(pi, ctx, parsed.task, list, remove);
					return;
				}
				if (!ctx.hasUI) {
					notify(pi, ctx, "/sumo:worktree requires interactive UI", "warning");
					return;
				}
				if (!isInsideCmux()) {
					notify(pi, ctx, "/sumo:worktree requires a cmux surface", "warning");
					return;
				}
				if (!parsed.task) {
					notify(pi, ctx, "Usage: /sumo:worktree <task> or /sumo:worktree prune <branch-or-path>", "warning");
					return;
				}

				const created: CreateWorktreeResult = await create({ repoRoot: ctx.cwd, task: parsed.task, baseRef: "HEAD" });
				if (!created.ok) {
					notify(pi, ctx, `/sumo:worktree: ${created.message}`, "warning");
					return;
				}

				const direction: SplitDirection = chooseDiffSplitDirection(getTerminalSize());
				const command = buildShellCommand(created.path, commandForWorktree(parsed.task, setupAction));
				const opened = await openSplit(pi, direction, command);
				if (!opened.ok) {
					notify(pi, ctx, `/sumo:worktree: ${opened.error}`, "warning");
					return;
				}
				notify(pi, ctx, `opened ${created.branch} in ${direction} split · setup: ${setupAction || "none"}`);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				notify(pi, ctx, `/sumo:worktree: ${message}`, "warning");
			}
		},
	});
}

export type { ListWorktreesResult, RemoveWorktreeResult };
