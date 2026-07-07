import type { ChildProcess, ExecFileException, ExecFileOptions, execFile } from "node:child_process";
import { describe, expect, it } from "vitest";
import { readGitBranch } from "./git.js";

type ExecFileFn = typeof execFile;
type ExecFileCallback = (error: ExecFileException | null, stdout: string, stderr: string) => void;

type ExecFileCall = {
	readonly file: string;
	readonly args: string[];
	readonly options: ExecFileOptions;
};

function fakeExecFile(handler: (call: ExecFileCall, callback: ExecFileCallback) => void): ExecFileFn {
	return ((file: string, args: readonly string[], options: ExecFileOptions, callback: ExecFileCallback): ChildProcess => {
		handler({ file, args: [...args], options }, callback);
		return undefined as unknown as ChildProcess;
	}) as unknown as ExecFileFn;
}

describe("readGitBranch", () => {
	it("passes bounded git exec options and resolves the current branch", async () => {
		const calls: ExecFileCall[] = [];
		const execFileFn = fakeExecFile((call, callback) => {
			calls.push(call);
			callback(null, "feature/plan-053\n", "");
		});

		await expect(readGitBranch("/repo/worktree", execFileFn)).resolves.toBe("feature/plan-053");

		expect(calls).toHaveLength(1);
		expect(calls[0]).toEqual({
			file: "git",
			args: ["branch", "--show-current"],
			options: expect.objectContaining({ cwd: "/repo/worktree", timeout: 2000, killSignal: "SIGKILL" }),
		});
	});

	it("resolves undefined instead of throwing when git exec callbacks report errors", async () => {
		const calls: ExecFileCall[] = [];
		const execFileFn = fakeExecFile((call, callback) => {
			calls.push(call);
			callback(new Error("git failed") as ExecFileException, "", "fatal");
		});

		await expect(readGitBranch("/repo/worktree", execFileFn)).resolves.toBeUndefined();

		expect(calls.map((call) => call.args)).toEqual([
			["branch", "--show-current"],
			["rev-parse", "--short", "HEAD"],
		]);
		for (const call of calls) {
			expect(call.file).toBe("git");
			expect(call.options).toEqual(expect.objectContaining({ cwd: "/repo/worktree", timeout: 2000, killSignal: "SIGKILL" }));
		}
	});
});
