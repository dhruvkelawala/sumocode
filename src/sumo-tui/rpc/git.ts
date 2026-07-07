import { execFile } from "node:child_process";

type ExecFile = typeof execFile;
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
