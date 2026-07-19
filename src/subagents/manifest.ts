import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { RunOutcome } from "./domain.js";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 4_500;

export interface CompletionManifest {
	readonly baseRef: string;
	readonly headRef?: string;
	readonly branch?: string;
	readonly worktreePath?: string;
	readonly changedPaths: readonly string[];
	readonly dirty: boolean;
	readonly commits: number;
	readonly exit: "completed" | "failed" | "interrupted";
	readonly durationMs: number;
}

export interface CompletionManifestWorktree {
	readonly path: string;
	readonly branch: string;
}

export interface BuildCompletionManifestOptions {
	readonly cwd: string;
	readonly baseRef: string;
	readonly outcome: RunOutcome;
	readonly startedAt: number;
	readonly worktree?: CompletionManifestWorktree;
}

async function git(cwd: string, args: readonly string[]): Promise<string | undefined> {
	try {
		const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
			encoding: "utf8",
			timeout: GIT_TIMEOUT_MS,
			maxBuffer: 10 * 1024 * 1024,
		});
		return stdout;
	} catch {
		// Manifest collection is best-effort evidence. A missing repository,
		// invalid ref, or timed-out git read must never break child settlement.
		return undefined;
	}
}

function statusPaths(output: string): string[] {
	const records = output.split("\0");
	const paths: string[] = [];
	for (let index = 0; index < records.length; index += 1) {
		const record = records[index];
		if (!record || record.length < 4) continue;
		const status = record.slice(0, 2);
		paths.push(record.slice(3));
		// In porcelain -z output, rename/copy records carry the original path as
		// the following NUL-delimited field. The first path is the destination.
		if (status.includes("R") || status.includes("C")) index += 1;
	}
	return paths;
}

const outcomeExit = (outcome: RunOutcome): CompletionManifest["exit"] => outcome.kind;

/**
 * Build host-observed completion evidence using git reads only.
 *
 * Shared-checkout spawns intentionally report `changedPaths: []`: status can
 * prove whether the checkout is dirty, but attributing those paths to one
 * child would blame it for concurrent parent or sibling edits. Head and commit
 * count remain host-observed checkout facts, not claims of child authorship.
 * Isolated worktrees can safely union uncommitted status paths with committed
 * paths changed since the captured base commit.
 */
export async function buildCompletionManifest(options: BuildCompletionManifestOptions): Promise<CompletionManifest> {
	const [headOutput, statusOutput, diffOutput, commitsOutput] = await Promise.all([
		git(options.cwd, ["rev-parse", "HEAD"]),
		git(options.cwd, ["status", "--porcelain=v1", "-z"]),
		options.worktree ? git(options.cwd, ["diff", "--name-only", "-z", `${options.baseRef}..HEAD`]) : undefined,
		git(options.cwd, ["rev-list", "--count", `${options.baseRef}..HEAD`]),
	]);

	const statusChangedPaths = statusOutput === undefined ? [] : statusPaths(statusOutput);
	const committedChangedPaths = diffOutput === undefined ? [] : diffOutput.split("\0").filter(Boolean);
	const commits = commitsOutput === undefined ? 0 : Number.parseInt(commitsOutput.trim(), 10);
	const changedPaths = options.worktree
		? [...new Set([...statusChangedPaths, ...committedChangedPaths])].sort()
		: [];

	return {
		baseRef: options.baseRef,
		headRef: headOutput?.trim() || undefined,
		branch: options.worktree?.branch,
		worktreePath: options.worktree?.path,
		changedPaths,
		dirty: statusOutput !== undefined && statusOutput.length > 0,
		commits: Number.isFinite(commits) ? commits : 0,
		exit: outcomeExit(options.outcome),
		durationMs: Math.max(0, Date.now() - options.startedAt),
	};
}
