import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import { buildShellCommand, shellEscape } from "../commands/cmux-split.js";
import { chooseDiffSplitDirection } from "../commands/diff.js";
import { createWorktree, resolveCreateOptions, type CreateWorktreeResult } from "../git/worktree.js";
import { getTerminalHost, type PiExecLike, type TerminalHost } from "../terminal-host/index.js";

const execFileAsync = promisify(execFile);
const DEFAULT_SETUP_ACTION = "pnpm install";

export interface OpenWorktreeCliOptions {
	readonly cwd?: string;
	readonly env?: NodeJS.ProcessEnv;
	readonly create?: typeof createWorktree;
	readonly terminalHost?: TerminalHost;
	readonly pathExists?: (path: string) => boolean;
	readonly now?: () => number;
	readonly stdout?: Pick<NodeJS.WriteStream, "write">;
	readonly stderr?: Pick<NodeJS.WriteStream, "write">;
	readonly pi?: PiExecLike;
}

function commandForPlainShell(env: NodeJS.ProcessEnv): string {
	const setup = (env.SUMOCODE_WORKTREE_SETUP ?? DEFAULT_SETUP_ACTION).trim();
	const shell = env.SHELL || "/bin/bash";
	const openShell = `exec ${shellEscape(shell)} -l`;
	return setup ? `${setup} && ${openShell}` : openShell;
}

function worktreeWorkspaceLabel(branch: string): string {
	return branch.replace(/^sumo\//, "sumo · ");
}

function createExecAdapter(env: NodeJS.ProcessEnv): PiExecLike {
	return {
		exec: async (command, args, options = {}) => {
			try {
				const result = await execFileAsync(command, args, {
					encoding: "utf8",
					env,
					timeout: options.timeout,
					maxBuffer: 10 * 1024 * 1024,
				});
				return { stdout: result.stdout, stderr: result.stderr, code: 0, killed: false };
			} catch (error) {
				const failed = error as { stdout?: unknown; stderr?: unknown; code?: unknown; killed?: unknown };
				return {
					stdout: typeof failed.stdout === "string" ? failed.stdout : "",
					stderr: typeof failed.stderr === "string" ? failed.stderr : error instanceof Error ? error.message : String(error),
					code: typeof failed.code === "number" ? failed.code : 1,
					killed: failed.killed === true,
				};
			}
		},
	};
}

/** Create and open a worktree shell without starting SumoCode. */
export async function openWorktree(name: string | undefined, options: OpenWorktreeCliOptions = {}): Promise<number> {
	const cwd = options.cwd ?? process.cwd();
	const env = options.env ?? process.env;
	const stdout = options.stdout ?? process.stdout;
	const stderr = options.stderr ?? process.stderr;
	const terminalHost = options.terminalHost ?? getTerminalHost(env);
	const create = options.create ?? createWorktree;
	const pathExists = options.pathExists ?? existsSync;
	const pi = options.pi ?? createExecAdapter(env);

	if (terminalHost.kind === "none") {
		stderr.write("[sumocode] -w requires a terminal host (cmux or herdr).\n");
		return 1;
	}

	const task = name?.trim() || `wt-${(options.now ?? Date.now)().toString(36)}`;
	const resolved = resolveCreateOptions({ repoRoot: cwd, task, baseRef: "HEAD" });
	const shellCommand = commandForPlainShell(env);
	const label = worktreeWorkspaceLabel(resolved.branch);
	let created: CreateWorktreeResult | undefined;

	if (terminalHost.openWorktreeWorkspace) {
		const opened = await terminalHost.openWorktreeWorkspace(pi, {
			...resolved,
			label,
			shellCommand,
			sourceCwd: cwd,
		});
		if (opened.ok) {
			stdout.write(`opened ${resolved.branch} as workspace "${label}"\n`);
			return 0;
		}
		if (pathExists(resolved.path)) {
			stderr.write(`[sumocode] Worktree ${resolved.branch} was created at ${resolved.path}, but its shell failed to open: ${opened.error}\n`);
			return 1;
		}
		stderr.write(`[sumocode] Native worktree workspace failed (${opened.error}); falling back to a split.\n`);
	}

	created = await create({ repoRoot: cwd, task, baseRef: "HEAD" });
	if (!created.ok) {
		stderr.write(`[sumocode] Could not create worktree: ${created.message}\n`);
		return 1;
	}

	const direction = chooseDiffSplitDirection({ columns: process.stdout.columns, rows: process.stdout.rows });
	const opened = await terminalHost.openCommandInSplit(pi, direction, {
		cwd: created.path,
		shellCommand: buildShellCommand(created.path, shellCommand),
	});
	if (!opened.ok) {
		stderr.write(`[sumocode] Worktree ${created.branch} was created at ${created.path}, but its shell failed to open: ${opened.error}\n`);
		return 1;
	}
	stdout.write(`opened ${created.branch} in ${direction} split\n`);
	return 0;
}
