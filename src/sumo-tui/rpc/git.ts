import { execFile } from "node:child_process";

type ExecFile = typeof execFile;

function execFileText(execFileFn: ExecFile, file: string, args: readonly string[], cwd: string): Promise<string | undefined> {
	return new Promise((resolve) => {
		execFileFn(file, [...args], { cwd }, (error, stdout) => {
			if (error) {
				resolve(undefined);
				return;
			}
			const text = String(stdout).trim();
			resolve(text.length > 0 ? text : undefined);
		});
	});
}

export async function readGitBranch(cwd: string, execFileFn: ExecFile = execFile): Promise<string | undefined> {
	const branch = await execFileText(execFileFn, "git", ["branch", "--show-current"], cwd);
	if (branch) return branch;
	const commit = await execFileText(execFileFn, "git", ["rev-parse", "--short", "HEAD"], cwd);
	return commit ? `detached:${commit}` : undefined;
}
