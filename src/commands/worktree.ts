import { existsSync } from "node:fs";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { showDivineQuery } from "../divine-query.js";
import type { SubagentRegistry, RegisteredWorktreeResult, ResultDisposition } from "../subagents/registry.js";
import { inspectWorktreeResult, prepareWorktreeApply, applyWorktreeResult, prepareWorktreePrune, pruneWorktreeResult, type WorktreeInspection, type WorktreeDispositionOptions } from "../git/worktree-disposition.js";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveExecutableProvenance } from "../executable-provenance.js";
import { getTerminalHost, type SplitDirection, type TerminalHost } from "../terminal-host/index.js";
import { buildShellCommand, shellEscape } from "../terminal-host/shell-command.js";
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
	readonly resolveLauncher?: () => string;
	readonly resolveResultRegistry?: (id: string, ctx: ExtensionContext) => SubagentRegistry | undefined;
	readonly query?: typeof showDivineQuery;
	readonly dispositionOptions?: WorktreeDispositionOptions;
}

export interface ParsedWorktreeArgs {
	readonly mode: "fresh" | "reopen" | "delegate" | "prune" | "result";
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
	if (withoutBase === "result" || withoutBase.startsWith("result ")) {
		return { mode: "result", value: withoutBase.slice("result".length).trim(), ...parsedBase };
	}
	return { mode: "delegate", value: withoutBase, ...parsedBase };
}

function notify(_pi: Pick<ExtensionAPI, "sendMessage">, ctx: ExtensionContext, message: string, type: "info" | "warning" = "info"): void {
	if (ctx.hasUI) {
		ctx.ui.notify(message, type);
		return;
	}
	process.stdout.write(`${message}\n`);
}

function launcherCommand(launcher: string): string {
	return launcher === "sumocode" ? launcher : shellEscape(launcher);
}

function commandForWorktree(task: string, setupAction: string, launcher: string): string {
	const setup = setupAction.trim();
	const setupPrefix = setup ? `${setup} && ` : "";
	return `${setupPrefix}SUMOCODE_TASK_KEEP_OPEN=1 exec ${launcherCommand(launcher)} task ${shellEscape(task)}`;
}

function commandForFreshWorktree(setupAction: string, launcher: string): string {
	const setup = setupAction.trim();
	const setupPrefix = setup ? `${setup} && ` : "";
	return `${setupPrefix}exec ${launcherCommand(launcher)}`;
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

function resultEvidence(inspection: WorktreeInspection): string[] {
	return [
		`base ${inspection.base}`, `head ${inspection.head}`, `branch ${JSON.stringify(inspection.branch)}`,
		`worktree ${JSON.stringify(inspection.result.worktree.path)}`, inspection.dirty ? "child worktree dirty" : "child worktree clean",
		`${inspection.commits.length} commits · ${inspection.files.length} changed paths`,
		...inspection.commits.map((commit) => `commit ${commit}`),
		...inspection.files.map(({ status, path }) => `${status} ${JSON.stringify(path)}`),
		...inspection.stat.trimEnd().split("\n"),
	];
}

async function reviewResultEvidence(ctx: ExtensionContext, label: string, evidence: readonly string[], query: typeof showDivineQuery): Promise<boolean> {
	const lines = evidence.flatMap((text) => wrapTextWithAnsi(text, 50));
	const pages = Math.ceil(lines.length / 4);
	for (let index = 0; index < pages; index++) {
		const title = `${label} · ${index + 1}/${pages}\n${lines.slice(index * 4, index * 4 + 4).join("\n")}`;
		if (await query(ctx, title, ["continue", "return"]) !== "continue") return false;
	}
	return true;
}

function saveResultDisposition(registry: SubagentRegistry, result: RegisteredWorktreeResult, next: ResultDisposition): RegisteredWorktreeResult {
	return registry.setWorktreeDisposition(result.id, result.completionId, result.dispositionRevision, next);
}

export function worktreeResultQuery(result: RegisteredWorktreeResult) {
	const choices = ["inspect", ...(result.disposition === "unreviewed" || result.disposition === "inspected" ? ["apply"] : []),
		...(result.disposition !== "dismissed" ? ["dismiss"] : []), "prune", "open diff"];
	const m = result.manifest;
	return { title: `${result.id} · ${result.disposition}\n${result.worktree.branch}\nrecorded: ${m.commits} commits · ${m.changedPaths.length} files · ${m.dirty === undefined ? "cleanliness unknown" : m.dirty ? "dirty" : "clean"}`, options: choices };
}

async function handleResult(pi: ExtensionAPI, ctx: ExtensionContext, id: string, options: WorktreeCommandOptions): Promise<void> {
	if (!/^sa-[A-Za-z0-9_-]{1,128}$/u.test(id)) {
		notify(pi, ctx, "usage: /sumo:worktree result <id>", "warning");
		return;
	}
	if (!ctx.hasUI) { notify(pi, ctx, "worktree result actions require interactive UI", "warning"); return; }
	const registry = options.resolveResultRegistry?.(id, ctx);
	const initial = registry?.worktreeResult(id);
	if (!registry || !initial) { notify(pi, ctx, `settled worktree result ${id} unavailable`, "warning"); return; }
	let result = initial;
	if (result.disposition === "pruned") { notify(pi, ctx, `${id} pruned · branch ${result.worktree.branch} preserved`); return; }
	const query = options.query ?? showDivineQuery;
	const menu = worktreeResultQuery(result);
	const choices = menu.options;
	const choice = await query(ctx, menu.title, choices);
	if (!choice || !choices.includes(choice)) return;
	if (choice === "dismiss") {
		saveResultDisposition(registry, result, "dismissed");
		notify(pi, ctx, `${id} dismissed`);
		return;
	}
	const markInspected = (): void => {
		if (result.disposition === "unreviewed") result = saveResultDisposition(registry, result, "inspected");
	};
	const requireCurrentReview = (): void => {
		const current = registry.worktreeResult(id);
		if (!current || current.completionId !== result.completionId || current.dispositionRevision !== result.dispositionRevision) throw new Error("result disposition changed; review it again");
	};
	if (choice === "apply") {
		const preview = await prepareWorktreeApply(result, ctx.cwd, options.dispositionOptions);
		markInspected();
		if (!await reviewResultEvidence(ctx, `apply ${id}`, [`parent ${JSON.stringify(preview.parent.root)}`, `branch ${JSON.stringify(preview.parent.branch)}`,
			`parent head ${preview.parent.head}`, ...resultEvidence(preview.inspection)], query)) return;
		if (await query(ctx, `apply ${preview.inspection.commits.length} commits to ${preview.parent.branch}?\nchanges will be staged; parent HEAD stays unchanged`, ["cancel", "apply these commits"]) !== "apply these commits") return;
		requireCurrentReview();
		const outcome = await applyWorktreeResult(preview, true, options.dispositionOptions);
		if (outcome.kind === "manual-recovery") {
			notify(pi, ctx, `manual recovery required: ${outcome.reason}\nevidence: ${outcome.evidencePath}\ncommands attempted:\n${outcome.commands.map((args) => args.map(shellEscape).join(" ")).join("\n")}`, "warning");
		} else if (outcome.kind === "restored") notify(pi, ctx, "apply failed; parent restored and child preserved", "warning");
		else if (outcome.kind === "applied") {
			try { saveResultDisposition(registry, result, "applied"); }
			catch { throw new Error("changes staged, but disposition could not be saved; inspect the result before continuing"); }
			notify(pi, ctx, `${id} applied · changes staged`);
		}
		return;
	}
	if (choice === "prune") {
		const preview = await prepareWorktreePrune(result, options.dispositionOptions);
		markInspected();
		if (await query(ctx, `prune worktree ${JSON.stringify(result.worktree.path)}?\nbranch ${JSON.stringify(result.worktree.branch)} will be preserved`, ["keep worktree", "prune worktree"]) !== "prune worktree") return;
		requireCurrentReview();
		await pruneWorktreeResult(preview, true, options.dispositionOptions);
		try { saveResultDisposition(registry, result, "pruned"); }
		catch { throw new Error("worktree removed and branch preserved, but disposition could not be saved"); }
		notify(pi, ctx, `${id} pruned · branch preserved`);
		return;
	}
	const inspection = await inspectWorktreeResult(result, options.dispositionOptions);
	markInspected();
	if (choice === "inspect") {
		if (await reviewResultEvidence(ctx, `inspect ${id}`, resultEvidence(inspection), query)) notify(pi, ctx, `${id} inspected`);
		return;
	}
	const host = options.terminalHost ?? getTerminalHost();
	const command = `git -c core.hooksPath=/dev/null -c core.fsmonitor=false --paginate diff --no-ext-diff --no-textconv ${shellEscape(inspection.base)} ${shellEscape(inspection.head)} --`;
	const opened = await host.openCommandInSplit(pi, chooseDiffSplitDirection((options.terminalSize ?? terminalSize)()), {
		cwd: result.worktree.path, shellCommand: buildShellCommand(result.worktree.path, command),
	});
	notify(pi, ctx, opened.ok ? `opened diff for ${id}` : `result diff unavailable: ${opened.error}`, opened.ok ? "info" : "warning");
}

export function registerWorktreeCommand(pi: ExtensionAPI, options: WorktreeCommandOptions = {}): void {
	const create = options.create ?? createWorktree;
	const list = options.list ?? listWorktrees;
	const remove = options.remove ?? removeWorktree;
	const configuredTerminalHost = options.terminalHost;
	const pathExists = options.pathExists ?? existsSync;
	const getTerminalSize = options.terminalSize ?? terminalSize;
	const setupAction = options.setupAction ?? process.env.SUMOCODE_WORKTREE_SETUP ?? DEFAULT_SETUP_ACTION;
	const resolveLauncher = options.resolveLauncher ?? (() => resolveExecutableProvenance().sumocode);

	pi.registerCommand("sumo:worktree", {
		description: "Open a fresh worktree session, reopen one with open <target>, delegate <task>, prune [target], or review result <id>; fresh/delegate accept --base <ref>",
		handler: async (args, ctx) => {
			try {
				const parsed = parseWorktreeArgs(args ?? "");
				if (parsed.baseRef === "") {
					notify(pi, ctx, "Usage: /sumo:worktree [new [name] | open <branch-or-path> | <task> | prune [branch-or-path]] [--base <ref>]", "warning");
					return;
				}
				if (parsed.baseRef !== undefined && (parsed.mode === "reopen" || parsed.mode === "prune" || parsed.mode === "result")) {
					notify(pi, ctx, "/sumo:worktree: --base is only valid for fresh or delegated worktrees", "warning");
					return;
				}
				if (parsed.mode === "result") {
					await handleResult(pi, ctx, parsed.value, options);
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
					notify(pi, ctx, "/sumo:worktree requires a running herdr terminal host", "warning");
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
					const paneCommand = commandForFreshWorktree(setupAction, resolveLauncher());
					const label = worktreeWorkspaceLabel(match.branch ?? match.path);
					if (terminalHost.openExistingWorktreeWorkspace) {
						const opened = await terminalHost.openExistingWorktreeWorkspace(pi, { path: match.path, label, shellCommand: paneCommand, sourceCwd: ctx.cwd });
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
				const launcher = resolveLauncher();
				const paneCommand = parsed.mode === "fresh" ? commandForFreshWorktree(setupAction, launcher) : commandForWorktree(parsed.value, setupAction, launcher);
				const label = worktreeWorkspaceLabel(resolved.branch);
				let created: CreateWorktreeResult | undefined;
				if (terminalHost.openWorktreeWorkspace) {
					const opened = await terminalHost.openWorktreeWorkspace(pi, { ...resolved, label, shellCommand: paneCommand, sourceCwd: ctx.cwd });
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
