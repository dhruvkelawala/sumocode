import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEFAULT_GIT_TIMEOUT_MS = 15_000;

export type WorktreeErrorCode =
	| "branch_already_exists"
	| "path_already_exists"
	| "git_failed"
	| "parse_failed";

export interface WorktreeFailure {
	readonly ok: false;
	readonly error: WorktreeErrorCode;
	readonly message: string;
	readonly stderr?: string;
	readonly stdout?: string;
}

export interface CreateWorktreeOptions {
	readonly repoRoot: string;
	readonly branch?: string;
	readonly baseRef?: string;
	readonly task?: string;
	readonly path?: string;
}

export type CreateWorktreeResult =
	| { readonly ok: true; readonly path: string; readonly branch: string; readonly baseRef: string }
	| WorktreeFailure;

export interface WorktreeInfo {
	readonly path: string;
	readonly head?: string;
	readonly branch?: string;
	readonly detached: boolean;
}

export type ListWorktreesResult = { readonly ok: true; readonly worktrees: readonly WorktreeInfo[] } | WorktreeFailure;

export interface RemoveWorktreeOptions {
	readonly path: string;
	readonly repoRoot?: string;
	readonly force?: boolean;
}

export type RemoveWorktreeResult = { readonly ok: true } | WorktreeFailure;
export type CleanResult = { readonly ok: true; readonly clean: boolean } | WorktreeFailure;
export type HeadAdvancedResult = { readonly ok: true; readonly advanced: boolean } | WorktreeFailure;

interface GitResult {
	readonly stdout: string;
	readonly stderr: string;
}

function failure(error: WorktreeErrorCode, message: string, output: Partial<GitResult> = {}): WorktreeFailure {
	return { ok: false, error, message, stdout: output.stdout, stderr: output.stderr };
}

async function git(repoRoot: string, args: readonly string[]): Promise<GitResult> {
	const { stdout, stderr } = await execFileAsync("git", ["-C", repoRoot, ...args], {
		encoding: "utf8",
		timeout: DEFAULT_GIT_TIMEOUT_MS,
		maxBuffer: 10 * 1024 * 1024,
	});
	return { stdout, stderr };
}

async function gitOk(repoRoot: string, args: readonly string[]): Promise<boolean> {
	try {
		await git(repoRoot, args);
		return true;
	} catch {
		return false;
	}
}

function gitSync(repoRoot: string, args: readonly string[]): GitResult {
	const stdout = execFileSync("git", ["-C", repoRoot, ...args], {
		encoding: "utf8",
		timeout: DEFAULT_GIT_TIMEOUT_MS,
		maxBuffer: 10 * 1024 * 1024,
	});
	return { stdout, stderr: "" };
}

function gitOkSync(repoRoot: string, args: readonly string[]): boolean {
	try {
		gitSync(repoRoot, args);
		return true;
	} catch {
		return false;
	}
}

function gitFailure(error: unknown): WorktreeFailure {
	const maybe = error as { message?: unknown; stdout?: unknown; stderr?: unknown };
	const stdout = typeof maybe.stdout === "string" ? maybe.stdout : undefined;
	const stderr = typeof maybe.stderr === "string" ? maybe.stderr : undefined;
	const message = stderr?.trim() || (typeof maybe.message === "string" ? maybe.message : "git command failed");
	return failure("git_failed", message, { stdout, stderr });
}

export function slugifyBranch(task: string): string {
	const slug = task
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 48)
		.replace(/-+$/g, "");
	return slug || "task";
}

export function worktreeRoot(repoRoot = process.cwd()): string {
	return join(dirname(repoRoot), `${basename(repoRoot)}.sumo-worktrees`);
}

function pathSegmentForBranch(branch: string): string {
	return branch.replace(/[^a-zA-Z0-9._-]+/g, "__");
}

async function branchExists(repoRoot: string, branch: string): Promise<boolean> {
	return gitOk(repoRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
}

function branchExistsSync(repoRoot: string, branch: string): boolean {
	return gitOkSync(repoRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
}

function resolveCreateOptions(options: CreateWorktreeOptions): { branch: string; baseRef: string; path: string } {
	const baseRef = options.baseRef ?? "HEAD";
	const branch = options.branch ?? `sumo/${slugifyBranch(options.task ?? "task")}`;
	const path = options.path ?? join(worktreeRoot(options.repoRoot), pathSegmentForBranch(branch));
	return { branch, baseRef, path };
}

export function createWorktreeSync(options: CreateWorktreeOptions): CreateWorktreeResult {
	const { branch, baseRef, path } = resolveCreateOptions(options);
	if (branchExistsSync(options.repoRoot, branch)) {
		return failure("branch_already_exists", `branch already exists: ${branch}`);
	}
	if (existsSync(path)) {
		return failure("path_already_exists", `worktree path already exists: ${path}`);
	}
	try {
		mkdirSync(dirname(path), { recursive: true });
		gitSync(options.repoRoot, ["worktree", "add", "-b", branch, path, baseRef]);
		return { ok: true, path, branch, baseRef };
	} catch (error) {
		return gitFailure(error);
	}
}

export async function createWorktree(options: CreateWorktreeOptions): Promise<CreateWorktreeResult> {
	const { branch, baseRef, path } = resolveCreateOptions(options);

	if (await branchExists(options.repoRoot, branch)) {
		return failure("branch_already_exists", `branch already exists: ${branch}`);
	}
	if (existsSync(path)) {
		return failure("path_already_exists", `worktree path already exists: ${path}`);
	}

	try {
		mkdirSync(dirname(path), { recursive: true });
		await git(options.repoRoot, ["worktree", "add", "-b", branch, path, baseRef]);
		return { ok: true, path, branch, baseRef };
	} catch (error) {
		return gitFailure(error);
	}
}

export function parseWorktreePorcelain(output: string): WorktreeInfo[] {
	const records = output.trim().split(/\n\s*\n/).filter(Boolean);
	return records.map((record) => {
		const info: { path?: string; head?: string; branch?: string; detached?: boolean } = {};
		for (const line of record.split("\n")) {
			const [key, ...rest] = line.split(" ");
			const value = rest.join(" ");
			if (key === "worktree") info.path = value;
			else if (key === "HEAD") info.head = value;
			else if (key === "branch") info.branch = value.replace(/^refs\/heads\//, "");
			else if (key === "detached") info.detached = true;
		}
		if (!info.path) {
			throw new Error(`missing worktree path in porcelain record: ${record}`);
		}
		return {
			path: info.path,
			head: info.head,
			branch: info.branch,
			detached: info.detached ?? !info.branch,
		};
	});
}

export async function listWorktrees(repoRoot: string): Promise<ListWorktreesResult> {
	try {
		const { stdout } = await git(repoRoot, ["worktree", "list", "--porcelain"]);
		return { ok: true, worktrees: parseWorktreePorcelain(stdout) };
	} catch (error) {
		if (error instanceof Error && error.message.includes("missing worktree path")) {
			return failure("parse_failed", error.message);
		}
		return gitFailure(error);
	}
}

export function removeWorktreeSync(options: RemoveWorktreeOptions): RemoveWorktreeResult {
	const repoRoot = options.repoRoot ?? options.path;
	const args = ["worktree", "remove", ...(options.force ? ["--force"] : []), options.path];
	try {
		gitSync(repoRoot, args);
		return { ok: true };
	} catch (error) {
		return gitFailure(error);
	}
}

export async function removeWorktree(options: RemoveWorktreeOptions): Promise<RemoveWorktreeResult> {
	const repoRoot = options.repoRoot ?? options.path;
	const args = ["worktree", "remove", ...(options.force ? ["--force"] : []), options.path];
	try {
		await git(repoRoot, args);
		return { ok: true };
	} catch (error) {
		return gitFailure(error);
	}
}

export async function isClean(path: string): Promise<CleanResult> {
	try {
		const { stdout } = await git(path, ["status", "--porcelain"]);
		return { ok: true, clean: stdout.trim().length === 0 };
	} catch (error) {
		return gitFailure(error);
	}
}

export async function headAdvanced(path: string, baseRef: string): Promise<HeadAdvancedResult> {
	try {
		const head = (await git(path, ["rev-parse", "HEAD"])).stdout.trim();
		const base = (await git(path, ["rev-parse", baseRef])).stdout.trim();
		if (head === base) return { ok: true, advanced: false };
		const isAncestor = await gitOk(path, ["merge-base", "--is-ancestor", baseRef, "HEAD"]);
		return { ok: true, advanced: isAncestor };
	} catch (error) {
		return gitFailure(error);
	}
}
