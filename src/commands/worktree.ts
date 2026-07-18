import { existsSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildShellCommand, shellEscape } from "./cmux-split.js";
import { getTerminalHost, type SplitDirection, type TerminalHost } from "../terminal-host/index.js";
import { chooseDiffSplitDirection, type TerminalSize } from "./diff.js";
import { sessionHasMessages } from "../session-cache.js";
import {
	createWorktree,
	listWorktrees,
	removeWorktree,
	resolveCreateOptions,
	type CreateWorktreeResult,
	type ListWorktreesResult,
	type RemoveWorktreeResult,
	type WorktreeInfo,
} from "../git/worktree.js";

const DEFAULT_SETUP_ACTION = "pnpm install";

export interface WorktreeCommandOptions {
	readonly create?: typeof createWorktree;
	readonly list?: typeof listWorktrees;
	readonly remove?: typeof removeWorktree;
	readonly terminalHost?: TerminalHost;
	readonly pathExists?: (path: string) => boolean;
	readonly terminalSize?: () => TerminalSize;
	readonly setupAction?: string;
}

export interface ParsedWorktreeArgs {
	readonly mode: "fresh" | "reopen" | "delegate" | "prune";
	/** delegate: task prompt · fresh: optional name · reopen/prune: branch-or-path target */
	readonly value: string;
	readonly baseRef?: string;
}

function terminalSize(): TerminalSize {
	return { columns: process.stdout.columns, rows: process.stdout.rows };
}

export function parseWorktreeArgs(args: string): ParsedWorktreeArgs {
	const trimmed = args.trim();
	const baseMatch = /(^|\s)--base(?:\s+(\S+))?(?=\s|$)/.exec(trimmed);
	const baseRef = baseMatch ? (baseMatch[2] ?? "") : undefined;
	const withoutBase = baseMatch
		? [trimmed.slice(0, baseMatch.index).trimEnd(), trimmed.slice(baseMatch.index + baseMatch[0].length).trimStart()].filter(Boolean).join(" ")
		: trimmed;
	const parsedBase = baseRef === undefined ? {} : { baseRef };

	if (!withoutBase || withoutBase === "new" || withoutBase.startsWith("new ")) {
		return { mode: "fresh", value: withoutBase.slice("new".length).trim(), ...parsedBase };
	}
	if (withoutBase === "open" || withoutBase.startsWith("open ")) {
		return { mode: "reopen", value: withoutBase.slice("open".length).trim(), ...parsedBase };
	}
	if (withoutBase === "prune" || withoutBase.startsWith("prune ")) {
		return { mode: "prune", value: withoutBase.slice("prune".length).trim(), ...parsedBase };
	}
	return { mode: "delegate", value: withoutBase, ...parsedBase };
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

function commandForFreshWorktree(setupAction: string): string {
	const setup = setupAction.trim();
	const setupPrefix = setup ? `${setup} && ` : "";
	return `${setupPrefix}exec sumocode`;
}

function worktreeWorkspaceLabel(branch: string): string {
	return branch.replace(/^sumo\//, "sumo · ");
}

function listSumoWorktrees(worktrees: readonly WorktreeInfo[]): readonly WorktreeInfo[] {
	return worktrees.filter((worktree) => worktree.branch?.startsWith("sumo/"));
}

function findSumoWorktree(worktrees: readonly WorktreeInfo[], target: string): WorktreeInfo | undefined {
	return listSumoWorktrees(worktrees).find((worktree) => worktree.path === target || worktree.branch === target);
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
	const sumoWorktrees = listSumoWorktrees(listed.worktrees);
	if (!target) {
		if (sumoWorktrees.length === 0) {
			notify(pi, ctx, "no sumo worktrees found");
			return;
		}
		const lines = sumoWorktrees.map((worktree) => `${worktree.branch ?? "detached"} · ${worktree.path}`);
		notify(pi, ctx, `sumo worktrees:\n${lines.join("\n")}\nrun /sumo:worktree prune <branch-or-path> to remove one`);
		return;
	}
	const match = findSumoWorktree(listed.worktrees, target);
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
	const configuredTerminalHost = options.terminalHost;
	const pathExists = options.pathExists ?? existsSync;
	const getTerminalSize = options.terminalSize ?? terminalSize;
	const setupAction = options.setupAction ?? process.env.SUMOCODE_WORKTREE_SETUP ?? DEFAULT_SETUP_ACTION;

	pi.registerCommand("sumo:worktree", {
		description: "Open a fresh worktree session, reopen one with open <target>, delegate <task>, or prune [target]; fresh/delegate accept --base <ref>",
		handler: async (args, ctx) => {
			try {
				const parsed = parseWorktreeArgs(args ?? "");
				if (parsed.baseRef === "") {
					notify(pi, ctx, "Usage: /sumo:worktree [new [name] | open <branch-or-path> | <task> | prune [branch-or-path]] [--base <ref>]", "warning");
					return;
				}
				if (parsed.baseRef !== undefined && (parsed.mode === "reopen" || parsed.mode === "prune")) {
					notify(pi, ctx, "/sumo:worktree: --base is only valid for fresh or delegated worktrees", "warning");
					return;
				}
				if (parsed.mode === "prune") {
					await handlePrune(pi, ctx, parsed.value, list, remove);
					return;
				}
				if (!ctx.hasUI) {
					notify(pi, ctx, "/sumo:worktree requires interactive UI", "warning");
					return;
				}
				const terminalHost = configuredTerminalHost ?? getTerminalHost();
				if (terminalHost.kind === "none") {
					notify(pi, ctx, "/sumo:worktree requires a terminal host (cmux or herdr)", "warning");
					return;
				}
				if (parsed.mode === "reopen") {
					if (!parsed.value) {
						notify(pi, ctx, "Usage: /sumo:worktree open <branch-or-path>", "warning");
						return;
					}
					const listed = await list(ctx.cwd);
					if (!listed.ok) {
						notify(pi, ctx, `/sumo:worktree open: ${listed.message}`, "warning");
						return;
					}
					const match = findSumoWorktree(listed.worktrees, parsed.value);
					if (!match) {
						const available = listSumoWorktrees(listed.worktrees).map((worktree) => worktree.branch ?? worktree.path);
						notify(
							pi,
							ctx,
							`/sumo:worktree open: no tracked sumo worktree matched ${parsed.value} · available: ${available.join(", ") || "none"}`,
							"warning",
						);
						return;
					}
					const paneCommand = commandForFreshWorktree(setupAction);
					const label = worktreeWorkspaceLabel(match.branch ?? match.path);
					if (terminalHost.openExistingWorktreeWorkspace) {
						const opened = await terminalHost.openExistingWorktreeWorkspace(pi, { path: match.path, label, shellCommand: paneCommand });
						if (opened.ok) {
							notify(pi, ctx, `opened ${match.branch ?? match.path} as herdr workspace "${label}" · setup: ${setupAction || "none"}`);
							return;
						}
						notify(pi, ctx, `/sumo:worktree: herdr workspace open failed (${opened.error}); falling back to split`, "warning");
					}
					const direction: SplitDirection = chooseDiffSplitDirection(getTerminalSize());
					const command = buildShellCommand(match.path, paneCommand);
					const opened = await terminalHost.openCommandInSplit(pi, direction, { cwd: match.path, shellCommand: command });
					if (!opened.ok) {
						notify(pi, ctx, `/sumo:worktree: ${opened.error}`, "warning");
						return;
					}
					notify(pi, ctx, `reopened ${match.branch ?? match.path} in ${direction} split`);
					return;
				}

				const task = parsed.mode === "fresh" ? (parsed.value || `wt-${Date.now().toString(36)}`) : parsed.value;
				const resolved = resolveCreateOptions({ repoRoot: ctx.cwd, task, baseRef: parsed.baseRef ?? "HEAD" });
				const paneCommand = parsed.mode === "fresh" ? commandForFreshWorktree(setupAction) : commandForWorktree(parsed.value, setupAction);
				const label = worktreeWorkspaceLabel(resolved.branch);
				let created: CreateWorktreeResult | undefined;
				if (terminalHost.openWorktreeWorkspace) {
					const opened = await terminalHost.openWorktreeWorkspace(pi, { ...resolved, label, shellCommand: paneCommand });
					if (opened.ok) {
						const freshLabel = parsed.mode === "fresh" ? " (fresh session)" : "";
						notify(pi, ctx, `opened ${resolved.branch}${freshLabel} as herdr workspace "${label}" · setup: ${setupAction || "none"}`);
						return;
					}
					// Partial-failure reconciliation: `herdr worktree create` may have
					// already created the branch + worktree on disk before the pane
					// list/run step failed. Falling through to createWorktree would then
					// hit branch_already_exists/path_already_exists on the identical
					// resolved branch/path — a second confusing error and no session.
					// Detect the half-created state and hand the user a working next
					// step instead of a doomed fallback.
					if (pathExists(resolved.path)) {
						// Reopen always starts a plain fresh session, so a DELEGATED
						// task's instructions cannot be re-delivered through it — tell
						// the user explicitly instead of silently dropping their task.
						const recovery = parsed.mode === "fresh"
							? `Open it with /sumo:worktree open ${resolved.branch}`
							: `Open it with /sumo:worktree open ${resolved.branch} (opens a fresh session — re-issue your task there; the delegated prompt was not delivered)`;
						notify(
							pi,
							ctx,
							`/sumo:worktree: herdr created workspace "${label}" but launching the session failed (${opened.error}). ${recovery}`,
							"warning",
						);
						return;
					}
					notify(pi, ctx, `/sumo:worktree: herdr workspace create failed (${opened.error}); falling back to split`, "warning");
				}
				created = await create({ repoRoot: ctx.cwd, task, baseRef: parsed.baseRef ?? "HEAD" });
				if (!created.ok) {
					notify(pi, ctx, `/sumo:worktree: ${created.message}`, "warning");
					return;
				}

				const command = buildShellCommand(created.path, paneCommand);
				if (parsed.mode === "fresh" && !sessionHasMessages(ctx) && terminalHost.replaceCurrentPane) {
					const opened = await terminalHost.replaceCurrentPane(pi, { cwd: created.path, shellCommand: command });
					if (!opened.ok) notify(pi, ctx, `/sumo:worktree: ${opened.error}`, "warning");
					return;
				}

				const direction: SplitDirection = chooseDiffSplitDirection(getTerminalSize());
				const opened = await terminalHost.openCommandInSplit(pi, direction, { cwd: created.path, shellCommand: command });
				if (!opened.ok) {
					notify(pi, ctx, `/sumo:worktree: ${opened.error}`, "warning");
					return;
				}
				const freshLabel = parsed.mode === "fresh" ? " (fresh session)" : "";
				notify(pi, ctx, `opened ${created.branch}${freshLabel} in ${direction} split · setup: ${setupAction || "none"}`);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				notify(pi, ctx, `/sumo:worktree: ${message}`, "warning");
			}
		},
	});
}

export type { ListWorktreesResult, RemoveWorktreeResult };
