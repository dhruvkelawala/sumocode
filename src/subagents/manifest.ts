import { execFile, spawn } from "node:child_process";
import { systemProcessTree, type ProcessTreeMemberAnchor } from "../background-tasks/process-tree.js";
import { resolvePsBinary } from "../background-tasks/ps-binary.js";
import type { RunOutcome } from "./domain.js";

const GIT_TIMEOUT_MS = 4_500;
const GIT_CLEANUP_MS = 500;

export interface CompletionManifest {
	readonly baseRef: string;
	readonly headRef?: string;
	readonly branch?: string;
	readonly worktreePath?: string;
	readonly changedPaths: readonly string[];
	/** undefined when git status could not be read — "unknown", never assume clean. */
	readonly dirty?: boolean;
	readonly commits: number;
	readonly exit: "completed" | "failed" | "interrupted";
	readonly durationMs: number;
}

export interface PartialCompletionManifest {
	readonly exit: CompletionManifest["exit"];
	readonly durationMs: number;
	/** Snapshot at publication; late drain must never upgrade this claim. */
	readonly cleanup?: "unproven";
}

export type CompletionManifestEvidence = CompletionManifest | PartialCompletionManifest;

export interface CompletionManifestWorktree {
	readonly path: string;
	readonly branch: string;
}

export interface BuildCompletionManifestOptions {
	readonly signal?: AbortSignal;
	/** Collector-owned receipts: true proves both group emptiness and pipe close. */
	readonly onGitRead?: (drained: Promise<boolean>) => void;
	readonly cwd: string;
	readonly baseRef: string;
	readonly outcome: RunOutcome;
	readonly startedAt: number;
	readonly worktree?: CompletionManifestWorktree;
}

/** Bounded, PATH-independent probes keep ps latency outside the public finalizer. */
function gitGroupMembers(pgid: number): Promise<readonly ProcessTreeMemberAnchor[] | undefined> {
	return new Promise<readonly ProcessTreeMemberAnchor[] | undefined>((resolve) => {
		execFile(resolvePsBinary(), ["-axo", "pid=,pgid=,lstart="], { encoding: "utf8", timeout: 75, killSignal: "SIGKILL", maxBuffer: 10 * 1024 * 1024 }, (error, output) => {
			if (error) { resolve(undefined); return; }
			const members: ProcessTreeMemberAnchor[] = [];
			let currentGroup: number | undefined;
			for (const row of output.split("\n")) {
				const match = row.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
				if (!match) continue;
				const pid = Number(match[1]);
				const group = Number(match[2]);
				if (pid === process.pid) currentGroup = group;
				if (group === pgid) members.push({ pid, processStartTime: match[3]!.trim() });
			}
			resolve(currentGroup === undefined || currentGroup === pgid ? undefined : members);
		});
	}).catch(() => undefined);
}

interface GitRead {
	readonly output?: string;
	readonly cleanupProven: boolean;
}

function git(cwd: string, args: readonly string[], signal?: AbortSignal): Promise<GitRead> {
	if (signal?.aborted) return Promise.resolve({ cleanupProven: true });
	let child;
	try { child = spawn("git", ["-C", cwd, ...args], { detached: true, stdio: ["ignore", "pipe", "pipe"] }); }
	catch { return Promise.resolve({ cleanupProven: true }); }
	return new Promise<GitRead>((resolve) => {
		let output: string | undefined = "";
		let outputBytes = 0;
		let closed = false;
		let stopping = false;
		let finished = false;
		let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			outputBytes += Buffer.byteLength(chunk);
			if (outputBytes > 10 * 1024 * 1024) { output = undefined; stop(); }
			else if (output !== undefined) output += chunk;
		});
		child.stderr.resume();
		child.once("error", () => { output = undefined; });
		const pid = child.pid;
		// Only the dedicated group from this spawn is eligible; never a positive PID fallback on POSIX.
		const identity = pid && pid > 1 && pid !== process.pid ? { pid, processGroupId: pid, processStartTime: "" } : undefined;
		const initial = identity && process.platform !== "win32" ? gitGroupMembers(identity.pid).then((members) =>
			child.exitCode === null && child.signalCode === null ? members : undefined) : Promise.resolve(undefined);
		const finish = (cleanupProven: boolean): void => {
			if (finished) return;
			finished = true;
			clearTimeout(watchdog);
			clearTimeout(cleanupTimer);
			signal?.removeEventListener("abort", stop);
			resolve({ output: stopping || signal?.aborted || !cleanupProven ? undefined : output, cleanupProven });
		};
		const empty = (): boolean => identity !== undefined && process.platform !== "win32" && systemProcessTree.isTreeEmpty(identity);
		const stop = (): void => {
			if (stopping || finished) return;
			stopping = true;
			// Referenced and bounded: disposal must not let Node exit between TERM and KILL.
			cleanupTimer = setTimeout(() => { finish(false); }, GIT_CLEANUP_MS);
			void (async () => {
				if (!identity || process.platform === "win32") { child.kill("SIGKILL"); finish(false); return; }
				let anchors = await initial;
				for (const signalName of ["SIGTERM", "SIGKILL"] as const) {
					if (finished) return;
					if (empty()) { if (closed) finish(true); return; }
					const members = await gitGroupMembers(identity.pid);
					if (finished) return;
					// Bracket the census with live spawn-handle/previous birth anchors. Leader close alone is not authority.
					const owned = members?.some((member) =>
						(member.pid === identity.pid && child.exitCode === null && child.signalCode === null) ||
						anchors?.some((anchor) => anchor.pid === member.pid && anchor.processStartTime === member.processStartTime));
					if (!owned || !members) { finish(empty() && closed); return; }
					anchors = members;
					const sent = await (systemProcessTree.signalFreshTree ?? systemProcessTree.signalTree.bind(systemProcessTree))(identity, signalName);
					if (!sent.ok) { finish(false); return; }
					if (await systemProcessTree.waitForTreeEmpty(identity, 100)) { if (closed) finish(true); return; }
				}
				finish(false);
			})().catch(() => { finish(false); });
		};
		const watchdog = setTimeout(stop, GIT_TIMEOUT_MS);
		signal?.addEventListener("abort", stop, { once: true });
		child.once("close", (code) => {
			closed = true;
			if (code !== 0) output = undefined;
			if (!identity || empty()) finish(true);
			else stop();
		});
		if (signal?.aborted) stop();
	}).catch(() => ({ cleanupProven: false }));
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

/** Shared bounded settlement seam; Effect stays cold until evidence is requested. */
export async function collectCompletionManifest(
	options: BuildCompletionManifestOptions,
	build: typeof buildCompletionManifest = buildCompletionManifest,
	onFailure: () => void = () => undefined,
): Promise<CompletionManifestEvidence> {
	const fallback = { exit: options.outcome.kind, durationMs: Math.max(0, Date.now() - options.startedAt) };
	if (options.signal?.aborted) return fallback;
	const started = performance.now();
	try {
		const { collectManifestWithin } = await import("./manifest-effect.js");
		return await collectManifestWithin({ options, build, fallback, onFailure, timeoutMs: Math.max(0, 5000 - (performance.now() - started)) });
	} catch {
		try { onFailure(); } catch { /* Load diagnostics cannot prevent settlement. */ }
		return fallback;
	}
}

/**
 * Build host-observed completion evidence using git reads only.
 *
 * Shared-checkout spawns intentionally report `changedPaths: []`: status can
 * prove whether the checkout is dirty, but attributing those paths to one
 * child would blame it for concurrent parent or sibling edits. Head and commit
 * count remain host-observed checkout facts, not claims of child authorship.
 * Untracked files are listed individually (--untracked-files=all) rather
 * than collapsed to their parent directory, so a child's newly-created files
 * appear as distinct changed paths.
 * Isolated worktrees can safely union uncommitted status paths with committed
 * paths changed since the captured base commit.
 */
export async function buildCompletionManifest(options: BuildCompletionManifestOptions): Promise<CompletionManifest> {
	const read = (args: readonly string[]): Promise<string | undefined> => {
		const drained = git(options.cwd, args, options.signal);
		options.onGitRead?.(drained.then((result) => result.cleanupProven));
		return drained.then((result) => result.output);
	};
	const [headOutput, statusOutput, diffOutput, commitsOutput] = await Promise.all([
		read(["rev-parse", "HEAD"]),
		read(["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
		options.worktree ? read(["diff", "--name-only", "-z", `${options.baseRef}..HEAD`]) : undefined,
		read(["rev-list", "--count", `${options.baseRef}..HEAD`]),
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
		// A failed/timed-out status read is NOT evidence of cleanliness — leave
		// dirty undefined ("unknown") rather than rendering "checkout clean".
		dirty: statusOutput === undefined ? undefined : statusOutput.length > 0,
		commits: Number.isFinite(commits) ? commits : 0,
		exit: outcomeExit(options.outcome),
		durationMs: Math.max(0, Date.now() - options.startedAt),
	};
}
