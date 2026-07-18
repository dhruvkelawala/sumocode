import { execFile } from "node:child_process";
import { unwatchFile, watchFile } from "node:fs";
import { resolve } from "node:path";

type ExecFile = typeof execFile;
type GitBranchReader = (cwd: string) => Promise<string | undefined>;
type GitHeadWatcher = (path: string, onChange: () => void) => () => void;

export interface WatchGitBranchDependencies {
	readonly resolveHeadPath?: (cwd: string) => Promise<string | undefined>;
	readonly readBranch?: GitBranchReader;
	readonly watchHead?: GitHeadWatcher;
}
type PromiseResolvers<T> = {
	readonly promise: Promise<T>;
	readonly resolve: (value: T | PromiseLike<T>) => void;
	readonly reject: (reason?: unknown) => void;
};

type PromiseWithResolversConstructor = PromiseConstructor & {
	withResolvers<T>(): PromiseResolvers<T>;
};

function execFileText(execFileFn: ExecFile, file: string, args: readonly string[], cwd: string): Promise<string | undefined> {
	const { promise, resolve } = (Promise as PromiseWithResolversConstructor).withResolvers<string | undefined>();
	execFileFn(file, [...args], { cwd, timeout: 2_000, killSignal: "SIGKILL" }, (error, stdout) => {
		if (error) {
			resolve(undefined);
			return;
		}
		const text = String(stdout).trim();
		resolve(text.length > 0 ? text : undefined);
	});
	return promise;
}

export async function readGitBranch(cwd: string, execFileFn: ExecFile = execFile): Promise<string | undefined> {
	const branch = await execFileText(execFileFn, "git", ["branch", "--show-current"], cwd);
	if (branch) return branch;
	const commit = await execFileText(execFileFn, "git", ["rev-parse", "--short", "HEAD"], cwd);
	return commit ? `detached:${commit}` : undefined;
}

export async function resolveGitHeadPath(cwd: string, execFileFn: ExecFile = execFile): Promise<string | undefined> {
	const gitPath = await execFileText(execFileFn, "git", ["rev-parse", "--git-path", "HEAD"], cwd);
	return gitPath ? resolve(cwd, gitPath) : undefined;
}

function watchGitHead(path: string, onChange: () => void): () => void {
	const listener = (): void => onChange();
	// Git replaces HEAD atomically during checkout. watchFile follows the path
	// across inode replacement, unlike fs.watch(file), and only invokes Git when
	// the file metadata actually changes. persistent:false lets normal host
	// shutdown proceed even if disposal is interrupted.
	watchFile(path, { interval: 500, persistent: false }, listener);
	return () => unwatchFile(path, listener);
}

/**
 * Watch the checkout's real HEAD file and report live branch changes.
 *
 * `git rev-parse --git-path HEAD` is worktree-safe: linked worktrees resolve
 * to their own metadata directory rather than the primary checkout's HEAD.
 * Branch reads are coalesced and transient Git failures preserve the last
 * valid branch instead of blanking the sidebar.
 */
export async function watchGitBranch(
	cwd: string,
	initialBranch: string | undefined,
	onChange: (branch: string) => void,
	dependencies: WatchGitBranchDependencies = {},
): Promise<() => void> {
	const resolveHeadPath = dependencies.resolveHeadPath ?? resolveGitHeadPath;
	const readBranch = dependencies.readBranch ?? readGitBranch;
	const watchHead = dependencies.watchHead ?? watchGitHead;
	const headPath = await resolveHeadPath(cwd).catch(() => undefined);
	if (!headPath) return () => undefined;

	let active = true;
	let currentBranch = initialBranch;
	let refreshInFlight = false;
	let refreshPending = false;

	const refresh = async (): Promise<void> => {
		if (!active) return;
		if (refreshInFlight) {
			refreshPending = true;
			return;
		}

		refreshInFlight = true;
		try {
			do {
				refreshPending = false;
				const branch = await readBranch(cwd).catch(() => undefined);
				if (!active) return;
				if (branch && branch !== currentBranch) {
					currentBranch = branch;
					onChange(branch);
				}
			} while (refreshPending && active);
		} finally {
			refreshInFlight = false;
		}
	};

	let stopWatching: () => void;
	try {
		stopWatching = watchHead(headPath, () => { void refresh(); });
	} catch {
		// Branch metadata is optional chrome. A missing/unwatchable Git path must
		// never prevent the RPC host from booting.
		return () => undefined;
	}
	// Close the read-before-watch race without adding another branch lookup to
	// the critical startup path: HEAD may have changed after the host's initial
	// read but before this watcher was installed.
	void refresh();

	return () => {
		if (!active) return;
		active = false;
		stopWatching();
	};
}
