import { execFileSync, type ChildProcess, type ExecFileException, type ExecFileOptions, type execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { readGitBranch, watchGitBranch } from "./git.js";
import { RpcHostStateStore } from "./state.js";

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

describe("watchGitBranch", () => {
	it("updates RPC chrome state when the checkout branch changes outside SumoCode", async () => {
		let branch = "advisor/073-herdr-terminal-theme";
		let notifyHeadChanged: (() => void) | undefined;
		const stopWatching = vi.fn();
		const stateStore = new RpcHostStateStore();
		stateStore.setGitBranch(branch);

		const dispose = await watchGitBranch(
			"/repo/worktree",
			branch,
			(nextBranch) => stateStore.setGitBranch(nextBranch),
			{
				resolveHeadPath: async () => "/repo/.git/worktrees/feature/HEAD",
				readBranch: async () => branch,
				watchHead: (_path, onChange) => {
					notifyHeadChanged = onChange;
					return stopWatching;
				},
			},
		);

		branch = "main";
		notifyHeadChanged?.();
		await vi.waitFor(() => expect(stateStore.getSnapshot().gitBranch).toBe("main"));

		dispose();
		expect(stopWatching).toHaveBeenCalledOnce();
	});

	it("preserves the last valid branch across transient Git read failures", async () => {
		let branch: string | undefined = "feature/live-branch";
		let notifyHeadChanged: (() => void) | undefined;
		const onChange = vi.fn();
		const readBranch = vi.fn(async () => branch);
		const dispose = await watchGitBranch("/repo", branch, onChange, {
			resolveHeadPath: async () => "/repo/.git/HEAD",
			readBranch,
			watchHead: (_path, onHeadChange) => {
				notifyHeadChanged = onHeadChange;
				return () => undefined;
			},
		});
		await vi.waitFor(() => expect(readBranch).toHaveBeenCalledOnce());

		branch = undefined;
		notifyHeadChanged?.();
		await vi.waitFor(() => expect(readBranch).toHaveBeenCalledTimes(2));
		expect(onChange).not.toHaveBeenCalled();

		branch = "main";
		notifyHeadChanged?.();
		await vi.waitFor(() => expect(onChange).toHaveBeenCalledWith("main"));
		dispose();
	});

	it("degrades to a no-op when Git HEAD cannot be watched", async () => {
		await expect(watchGitBranch("/repo", "main", vi.fn(), {
			resolveHeadPath: async () => "/repo/.git/HEAD",
			watchHead: () => { throw new Error("watch unavailable"); },
		})).resolves.toEqual(expect.any(Function));
	});

	it("observes a real external git switch without restarting the host", async () => {
		const repo = mkdtempSync(join(tmpdir(), "sumocode-rpc-git-"));
		let dispose = (): void => undefined;
		try {
			execFileSync("git", ["init", "-b", "main"], { cwd: repo, stdio: "ignore" });
			execFileSync("git", ["config", "user.email", "sumocode@example.com"], { cwd: repo });
			execFileSync("git", ["config", "user.name", "SumoCode Test"], { cwd: repo });
			writeFileSync(join(repo, "README.md"), "fixture\n");
			execFileSync("git", ["add", "README.md"], { cwd: repo });
			execFileSync("git", ["commit", "-m", "fixture"], { cwd: repo, stdio: "ignore" });
			execFileSync("git", ["switch", "-c", "feature/live-branch"], { cwd: repo, stdio: "ignore" });

			let visibleBranch = "feature/live-branch";
			dispose = await watchGitBranch(repo, visibleBranch, (branch) => { visibleBranch = branch; });
			execFileSync("git", ["switch", "main"], { cwd: repo, stdio: "ignore" });

			await vi.waitFor(() => expect(visibleBranch).toBe("main"), { timeout: 3_000, interval: 50 });
		} finally {
			dispose();
			rmSync(repo, { recursive: true, force: true });
		}
	});
});

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
