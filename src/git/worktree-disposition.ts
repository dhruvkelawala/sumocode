import { execFile } from "node:child_process";
import { closeSync, existsSync, fstatSync, lstatSync, openSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual, promisify } from "node:util";
import type { CompletionManifest } from "../subagents/manifest.js";
import type { SubagentWorktreeRef } from "../subagents/domain.js";

const execAsync = promisify(execFile);
const OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;

export interface WorktreeResult {
	readonly id: string;
	readonly completionId: string;
	readonly worktree: SubagentWorktreeRef;
	readonly manifest: CompletionManifest;
}
export interface WorktreeInspection {
	readonly result: WorktreeResult;
	readonly base: string;
	readonly head: string;
	readonly branch: string;
	readonly commonDir: string;
	readonly dirty: boolean;
	readonly porcelain: string;
	readonly commits: readonly string[];
	readonly mergeCommits: readonly string[];
	readonly files: ReadonlyArray<{ status: string; path: string }>;
	readonly stat: string;
}

export type GitExecutor = (file: "git", args: readonly string[], options: {
	cwd: string; encoding: "utf8"; timeout: number; maxBuffer: number; env: NodeJS.ProcessEnv;
}) => Promise<string>;
export interface WorktreeDispositionOptions { readonly execute?: GitExecutor }

async function executeGit(file: "git", args: readonly string[], options: Parameters<GitExecutor>[2]): Promise<string> {
	return (await execAsync(file, [...args], options)).stdout;
}
async function git(options: WorktreeDispositionOptions, cwd: string, args: readonly string[]): Promise<string> {
	return (options.execute ?? executeGit)("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args], {
		cwd, encoding: "utf8", timeout: 15_000, maxBuffer: 1024 * 1024,
		env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat", GIT_OPTIONAL_LOCKS: "0" },
	});
}
const statusArgs = ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none"];
async function object(options: WorktreeDispositionOptions, cwd: string, ref: string): Promise<string> {
	const value = (await git(options, cwd, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`])).trim();
	if (!OBJECT_ID.test(value)) throw new Error("commit identity unavailable");
	return value;
}
async function commonDirectory(options: WorktreeDispositionOptions, cwd: string): Promise<string> {
	return realpathSync((await git(options, cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim());
}
function commits(output: string): string[] {
	const values = output.trim() ? output.trim().split("\n") : [];
	if (!values.every((value) => OBJECT_ID.test(value))) throw new Error("commit list unavailable");
	return values;
}
function changedFiles(output: string): Array<{ status: string; path: string }> {
	if (!output) return [];
	const fields = output.split("\0");
	if (fields.pop() !== "" || fields.length % 2 !== 0) throw new Error("changed file list unavailable");
	const files: Array<{ status: string; path: string }> = [];
	for (let index = 0; index < fields.length; index += 2) {
		if (!/^[ACDMRTUXB]$/u.test(fields[index]) || !fields[index + 1]) throw new Error("changed file evidence unavailable");
		files.push({ status: fields[index], path: fields[index + 1] });
	}
	return files;
}

/** Fresh, bounded Git evidence; the completion manifest is never a cleanliness claim. */
export async function inspectWorktreeResult(result: WorktreeResult, options: WorktreeDispositionOptions = {}): Promise<WorktreeInspection> {
	const { worktree, manifest } = result;
	if (!OBJECT_ID.test(worktree.baseRef) || manifest.baseRef !== worktree.baseRef || !manifest.headRef || !OBJECT_ID.test(manifest.headRef)
		|| manifest.worktreePath !== worktree.path || manifest.branch !== worktree.branch) throw new Error("captured worktree result identity unavailable");
	const cwd = realpathSync(worktree.path);
	if (cwd !== worktree.path || realpathSync((await git(options, cwd, ["rev-parse", "--show-toplevel"])).trim()) !== cwd) throw new Error("captured worktree path changed");
	const branch = (await git(options, cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"])).trim();
	if (!branch || branch !== worktree.branch) throw new Error("captured worktree branch changed");
	const commonDir = await commonDirectory(options, cwd);
	if (commonDir !== await commonDirectory(options, worktree.repoRoot)) throw new Error("worktree repository changed");
	const head = await object(options, cwd, "HEAD");
	const base = await object(options, cwd, worktree.baseRef);
	const registered = (await git(options, cwd, ["worktree", "list", "--porcelain", "-z"])).split("\0\0")
		.some((block) => { const fields = block.split("\0"); return fields.includes(`worktree ${cwd}`) && fields.includes(`branch refs/heads/${branch}`); });
	if (!registered) throw new Error("worktree registration unavailable");
	for (const captured of [base, manifest.headRef]) {
		if ((await git(options, cwd, ["merge-base", captured, head])).trim() !== captured) throw new Error("worktree history was rewritten");
	}
	const porcelain = await git(options, cwd, statusArgs);
	const range = `${base}..${head}`;
	const ordered = commits(await git(options, cwd, ["rev-list", "--reverse", range]));
	const merges = commits(await git(options, cwd, ["rev-list", "--min-parents=2", range]));
	const diff = ["diff", "--color=never", "--no-ext-diff", "--no-textconv", "--no-renames"];
	const files = changedFiles(await git(options, cwd, [...diff, "--name-status", "-z", base, head, "--"]));
	const stat = await git(options, cwd, [...diff, "--stat", base, head, "--"]);
	if (head !== await object(options, cwd, "HEAD") || porcelain !== await git(options, cwd, statusArgs)
		|| branch !== (await git(options, cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"])).trim()
		|| realpathSync(worktree.path) !== cwd) throw new Error("worktree changed during inspection");
	return { result: structuredClone({ id: result.id, completionId: result.completionId, worktree, manifest }), base, head, branch, commonDir, porcelain, dirty: porcelain.length > 0,
		commits: ordered, mergeCommits: merges, files, stat };
}

interface ParentCheckout {
	readonly root: string;
	readonly commonDir: string;
	readonly head: string;
	readonly branch: string;
	readonly porcelain: string;
}
export interface WorktreeApplyPreview { readonly inspection: WorktreeInspection; readonly parent: ParentCheckout }
export interface WorktreePrunePreview { readonly inspection: WorktreeInspection }
export type WorktreeApplyOutcome =
	| { readonly kind: "cancelled" | "applied" | "restored" }
	| { readonly kind: "manual-recovery"; readonly evidencePath: string; readonly commands: readonly (readonly string[])[]; readonly reason: string };

async function assertNoSequencer(options: WorktreeDispositionOptions, root: string): Promise<void> {
	for (const name of ["CHERRY_PICK_HEAD", "sequencer", "MERGE_HEAD", "rebase-merge", "rebase-apply"]) {
		const path = (await git(options, root, ["rev-parse", "--path-format=absolute", "--git-path", name])).trim();
		if (existsSync(path)) throw new Error("finish the existing cherry-pick, merge, or rebase before applying a result");
	}
}
async function parentCheckout(options: WorktreeDispositionOptions, cwd: string): Promise<ParentCheckout> {
	const root = realpathSync((await git(options, cwd, ["rev-parse", "--show-toplevel"])).trim());
	const branch = (await git(options, root, ["symbolic-ref", "--quiet", "--short", "HEAD"])).trim();
	if (!branch) throw new Error("parent branch unavailable");
	await assertNoSequencer(options, root);
	return { root, branch, head: await object(options, root, "HEAD"), commonDir: await commonDirectory(options, root),
		porcelain: await git(options, root, statusArgs) };
}
async function ignoredPaths(options: WorktreeDispositionOptions, cwd: string): Promise<string[]> {
	return (await git(options, cwd, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"])).split("\0").filter(Boolean);
}

export async function prepareWorktreeApply(result: WorktreeResult, parentCwd: string, options: WorktreeDispositionOptions = {}): Promise<WorktreeApplyPreview> {
	const inspection = await inspectWorktreeResult(result, options);
	if (inspection.dirty) throw new Error("child worktree must be clean before apply");
	if (inspection.commits.length === 0) throw new Error("no committed changes to apply");
	if (inspection.mergeCommits.length !== 0) throw new Error("merge commits require manual review; this result cannot be applied");
	const parent = await parentCheckout(options, parentCwd);
	if (parent.root === result.worktree.path || parent.commonDir !== inspection.commonDir) throw new Error("parent must be a separate checkout of the same repository");
	if (parent.porcelain !== "") throw new Error("parent checkout must be clean before apply");
	const ignored = await ignoredPaths(options, parent.root);
	if (inspection.files.some(({ path }) => ignored.some((other) => path === other || path.startsWith(`${other}/`) || other.startsWith(`${path}/`)))) {
		throw new Error("committed changes overlap ignored parent files");
	}
	return { inspection, parent };
}

/** One explicit result operation per repository; abandoned operations require human recovery. */
class ResultOperation {
	public readonly commands: string[][] = [];
	public readonly evidencePath: string;
	private readonly descriptor: number;
	private readonly identity: { dev: number; ino: number };
	private preserve = false;
	public constructor(commonDir: string, result: WorktreeResult) {
		this.evidencePath = join(commonDir, "sumocode-result-operation.jsonl");
		try { this.descriptor = openSync(this.evidencePath, "wx", 0o600); }
		catch { throw new Error(`another result operation or manual recovery is pending: ${this.evidencePath}`); }
		this.identity = fstatSync(this.descriptor);
		try { writeFileSync(this.descriptor, `${JSON.stringify({ id: result.id, completionId: result.completionId, worktree: result.worktree })}\n`); }
		catch (error) { closeSync(this.descriptor); throw error; }
	}
	public record(args: readonly string[]): void {
		this.commands.push([...args]);
		writeFileSync(this.descriptor, `${JSON.stringify({ command: args })}\n`);
	}
	public manual(reason: string): Extract<WorktreeApplyOutcome, { kind: "manual-recovery" }> {
		this.preserve = true;
		writeFileSync(this.descriptor, `${JSON.stringify({ manualRecovery: reason })}\n`);
		return { kind: "manual-recovery", reason, evidencePath: this.evidencePath, commands: this.commands };
	}
	public close(): void {
		closeSync(this.descriptor);
		if (this.preserve) return;
		const current = lstatSync(this.evidencePath);
		if (current.dev !== this.identity.dev || current.ino !== this.identity.ino) throw new Error("result operation evidence changed; manual recovery required");
		unlinkSync(this.evidencePath);
	}
}

/** Confirmation applies only this preview; changed Git evidence always requires a new review. */
export async function applyWorktreeResult(preview: WorktreeApplyPreview, confirmed: boolean, options: WorktreeDispositionOptions = {}): Promise<WorktreeApplyOutcome> {
	if (!confirmed) return { kind: "cancelled" };
	const operation = new ResultOperation(preview.parent.commonDir, preview.inspection.result);
	try {
		const current = await prepareWorktreeApply(preview.inspection.result, preview.parent.root, options);
		if (!isDeepStrictEqual(current, preview)) throw new Error("result or parent changed since confirmation");
		const pick = ["cherry-pick", "--no-commit", ...preview.inspection.commits];
		operation.record(pick);
		try { await git(options, preview.parent.root, pick); }
		catch {
			// Never overwrite an unrelated commit made outside this operation's lock.
			try {
				if (await object(options, preview.parent.root, "HEAD") !== preview.parent.head) return operation.manual("parent HEAD changed during apply");
			} catch { return operation.manual("parent HEAD unavailable after failed apply"); }
			const restore = ["restore", `--source=${preview.parent.head}`, "--staged", "--worktree", "--", "."];
			const quit = ["cherry-pick", "--quit"];
			let restored = true;
			for (const args of [restore, quit]) {
				operation.record(args);
				try { await git(options, preview.parent.root, args); } catch { restored = false; }
			}
			try { const matches = isDeepStrictEqual(await parentCheckout(options, preview.parent.root), preview.parent); restored = restored && matches; }
			catch { restored = false; }
			return restored ? { kind: "restored" } : operation.manual("parent restoration or sequencer cleanup could not be proved");
		}
		try {
			const after = await parentCheckout(options, preview.parent.root);
			if (after.head !== preview.parent.head || after.branch !== preview.parent.branch || after.commonDir !== preview.parent.commonDir) {
				return operation.manual("parent identity changed during apply");
			}
		} catch { return operation.manual("applied state could not be verified"); }
		return { kind: "applied" };
	} finally { operation.close(); }
}

export async function prepareWorktreePrune(result: WorktreeResult, options: WorktreeDispositionOptions = {}): Promise<WorktreePrunePreview> {
	const inspection = await inspectWorktreeResult(result, options);
	if (inspection.dirty || (await ignoredPaths(options, result.worktree.path)).length > 0) throw new Error("prune requires a clean worktree with no ignored files");
	if (realpathSync(result.worktree.repoRoot) === result.worktree.path) throw new Error("cannot prune the parent checkout");
	return { inspection };
}

export async function pruneWorktreeResult(preview: WorktreePrunePreview, confirmed: boolean, options: WorktreeDispositionOptions = {}): Promise<{ kind: "cancelled" | "pruned" }> {
	if (!confirmed) return { kind: "cancelled" };
	const { result } = preview.inspection;
	const operation = new ResultOperation(preview.inspection.commonDir, result);
	try {
		if (!isDeepStrictEqual(await prepareWorktreePrune(result, options), preview)) throw new Error("worktree changed since prune confirmation");
		const args = ["worktree", "remove", "--", result.worktree.path];
		operation.record(args);
		await git(options, result.worktree.repoRoot, args);
		return { kind: "pruned" };
	} finally { operation.close(); }
}
