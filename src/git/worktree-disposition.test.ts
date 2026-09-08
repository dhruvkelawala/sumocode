import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { prepareWorktreeApply, applyWorktreeResult, prepareWorktreePrune, pruneWorktreeResult, inspectWorktreeResult, type WorktreeResult, type GitExecutor } from "./worktree-disposition.js";

const execAsync = promisify(execFile);
function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
function fixture() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "sumocode-result-")));
	const parent = join(root, "parent with spaces");
	const child = join(root, "child 'quoted' $(literal)");
	mkdirSync(parent);
	git(parent, "init", "-b", "parent");
	git(parent, "config", "user.name", "fixture");
	git(parent, "config", "user.email", "fixture@example.test");
	writeFileSync(join(parent, "shared.txt"), "base\n");
	git(parent, "add", ".");
	git(parent, "commit", "-m", "base");
	const base = git(parent, "rev-parse", "HEAD").trim();
	git(parent, "worktree", "add", "-b", "sumo/child", child, base);
	const commit = (path: string, text: string, cwd = child): string => {
		writeFileSync(join(cwd, path), text);
		git(cwd, "add", "--", path);
		git(cwd, "commit", "-m", "change");
		return git(cwd, "rev-parse", "HEAD").trim();
	};
	const result = (): WorktreeResult => ({ id: "sa-result", completionId: "completed-once",
		worktree: { path: child, repoRoot: parent, branch: "sumo/child", baseRef: base },
		manifest: { baseRef: base, headRef: git(child, "rev-parse", "HEAD").trim(), branch: "sumo/child", worktreePath: child,
			changedPaths: [], dirty: false, commits: 0, exit: "completed", durationMs: 1 },
	});
	const execute = vi.fn<GitExecutor>(async (file, args, options) => (await execAsync(file, [...args], options)).stdout);
	return { root, parent, child, base, commit, result, execute };
}

describe("read-only result inspection", () => {
	it("inspects result: committed changes use the captured base and literal paths with spaces", async () => {
		const f = fixture();
		const head = f.commit("file with spaces.txt", "new\n");
		const before = git(f.parent, "status", "--porcelain=v1", "-z");
		const result = await inspectWorktreeResult(f.result(), { execute: f.execute });
		expect(result).toMatchObject({ base: f.base, head, branch: "sumo/child", dirty: false, commits: [head],
			files: [{ status: "A", path: "file with spaces.txt" }] });
		expect(result.stat).toContain("1 file changed");
		expect(git(f.parent, "status", "--porcelain=v1", "-z")).toBe(before);
		expect(f.execute.mock.calls.every(([file, , options]) => file === "git" && options.timeout > 0 && options.maxBuffer <= 1024 * 1024)).toBe(true);
		expect(f.execute.mock.calls.some(([, args, options]) => args.includes("--name-status") && args.includes("-z") && options.cwd === f.child)).toBe(true);
		expect(f.execute.mock.calls.some(([, args]) => args.some((arg) => ["cherry-pick", "remove", "commit", "reset", "clean"].includes(arg)))).toBe(false);
	});
	it("inspects result: dirty and empty worktrees report fresh Git truth", async () => {
		const f = fixture();
		const captured = f.result();
		expect(await inspectWorktreeResult(captured)).toMatchObject({ commits: [], files: [], dirty: false });
		writeFileSync(join(f.child, "untracked.txt"), "unsaved\n");
		expect(await inspectWorktreeResult(captured)).toMatchObject({ commits: [], dirty: true });
	});
	it("inspects result: later linear child commits are inspected instead of trusting the old manifest head", async () => {
		const f = fixture();
		const first = f.commit("one.txt", "one");
		const captured = f.result();
		const second = f.commit("two.txt", "two");
		expect(await inspectWorktreeResult(captured)).toMatchObject({ commits: [first, second], head: second });
	});
	it("inspects result: refuses missing and detached worktrees", async () => {
		const f = fixture();
		const captured = f.result();
		await expect(inspectWorktreeResult({ ...captured, worktree: { ...captured.worktree, path: join(f.root, "missing") } })).rejects.toThrow();
		git(f.child, "checkout", "--detach");
		await expect(inspectWorktreeResult(captured)).rejects.toThrow();
	});
	it("inspects result: refuses mutable base refs and rewritten completion history", async () => {
		const f = fixture();
		f.commit("one.txt", "one");
		const captured = f.result();
		await expect(inspectWorktreeResult({ ...captured, worktree: { ...captured.worktree, baseRef: "parent" } })).rejects.toThrow();
		git(f.child, "revert", "--no-edit", "HEAD");
		git(f.child, "commit", "--amend", "-m", "rewritten");
		// The completed commit is still an ancestor of this ordinary revert.
		expect((await inspectWorktreeResult(captured)).commits).toHaveLength(2);
		const unrelated = git(f.child, "commit-tree", "HEAD^{tree}", "-m", "unrelated").trim();
		git(f.child, "update-ref", "refs/heads/sumo/child", unrelated);
		expect(git(f.child, "symbolic-ref", "--short", "HEAD").trim()).toBe(captured.worktree.branch);
		await expect(inspectWorktreeResult(captured)).rejects.toThrow();
	});
	it.each(["status", "diff"])("inspects result: timeout or buffer refusal from %s never becomes clean evidence", async (command) => {
		const f = fixture();
		const execute: GitExecutor = (file, args, options) => args.includes(command)
			? Promise.reject(new Error("bounded Git read failed")) : f.execute(file, args, options);
		await expect(inspectWorktreeResult(f.result(), { execute })).rejects.toThrow();
	});
});

describe("confirmed committed apply", () => {
	it.each([1, 2])("applies linear commits: %i commits stage a patch without moving either HEAD", async (count) => {
		const f = fixture();
		const hashes = Array.from({ length: count }, (_, index) => f.commit(`file-${index}.txt`, `change ${index}\n`));
		const parentHead = git(f.parent, "rev-parse", "HEAD");
		const childHead = git(f.child, "rev-parse", "HEAD");
		const preview = await prepareWorktreeApply(f.result(), f.parent, { execute: f.execute });
		expect(preview.inspection.commits).toEqual(hashes);
		expect(await applyWorktreeResult(preview, true, { execute: f.execute })).toMatchObject({ kind: "applied" });
		expect(git(f.parent, "rev-parse", "HEAD")).toBe(parentHead);
		expect(git(f.child, "rev-parse", "HEAD")).toBe(childHead);
		expect(git(f.child, "status", "--porcelain=v1", "-z")).toBe("");
		expect(git(f.parent, "diff", "--cached", "--name-only").trim().split("\n")).toHaveLength(count);
		const mutations = f.execute.mock.calls.filter(([, args]) => args.includes("cherry-pick"));
		expect(mutations.map(([, args]) => args.slice(args.indexOf("cherry-pick")))).toEqual([["cherry-pick", "--no-commit", ...hashes]]);
	});
	it.each(["parent", "child"])("applies linear commits: refuses dirty %s before mutation", async (which) => {
		const f = fixture();
		f.commit("one.txt", "one");
		writeFileSync(join(which === "parent" ? f.parent : f.child, "unsaved.txt"), "private unsaved work");
		await expect(prepareWorktreeApply(f.result(), f.parent, { execute: f.execute })).rejects.toThrow(/clean/);
		expect(f.execute.mock.calls.some(([, args]) => args.includes("cherry-pick"))).toBe(false);
	});
	it("applies linear commits: refuses an empty result, a merge range, and a different repository", async () => {
		const f = fixture();
		await expect(prepareWorktreeApply(f.result(), f.parent)).rejects.toThrow(/commit/);
		git(f.child, "checkout", "-b", "side", f.base);
		f.commit("side.txt", "side");
		git(f.child, "checkout", "sumo/child");
		f.commit("main.txt", "main");
		git(f.child, "merge", "--no-ff", "side", "-m", "merge");
		await expect(prepareWorktreeApply(f.result(), f.parent)).rejects.toThrow(/merge/);
		const other = fixture();
		other.commit("other.txt", "other");
		await expect(prepareWorktreeApply(other.result(), f.parent)).rejects.toThrow(/repository/);
	});
	it.each(["file", "directory"])("applies linear commits: discloses intermediate paths and refuses ignored parent %s overlap", async (kind) => {
		const f = fixture();
		f.commit("local-cache", "temporary child data");
		git(f.child, "rm", "--", "local-cache");
		git(f.child, "commit", "-m", "remove temporary data");
		f.commit("one.txt", "final result");
		const inspection = await inspectWorktreeResult(f.result());
		expect(inspection.files).toEqual([{ status: "A", path: "one.txt" }]);
		writeFileSync(join(f.parent, ".git", "info", "exclude"), "local-cache\n");
		if (kind === "directory") mkdirSync(join(f.parent, "local-cache"));
		const privatePath = join(f.parent, "local-cache", ...(kind === "directory" ? ["private.txt"] : []));
		writeFileSync(privatePath, "private parent data");
		await expect(prepareWorktreeApply(f.result(), f.parent, { execute: f.execute })).rejects.toThrow(/ignored/);
		expect(inspection.touchedPaths).toEqual(["local-cache", "one.txt"]);
		expect(readFileSync(privatePath, "utf8")).toBe("private parent data");
		expect(f.execute.mock.calls.some(([, args]) => args.includes("cherry-pick"))).toBe(false);
	});
	it("applies linear commits: cancellation has no Git effects", async () => {
		const f = fixture();
		f.commit("one.txt", "one");
		const preview = await prepareWorktreeApply(f.result(), f.parent);
		expect(await applyWorktreeResult(preview, false, { execute: f.execute })).toEqual({ kind: "cancelled" });
		expect(f.execute).not.toHaveBeenCalled();
		expect(git(f.parent, "status", "--porcelain=v1", "-z")).toBe("");
	});
	it.each(["parent", "child"])("applies linear commits: revalidates %s changes after confirmation", async (which) => {
		const f = fixture();
		f.commit("one.txt", "one");
		const preview = await prepareWorktreeApply(f.result(), f.parent);
		f.commit("changed.txt", "changed after preview", which === "parent" ? f.parent : f.child);
		await expect(applyWorktreeResult(preview, true, { execute: f.execute })).rejects.toThrow(/changed/);
		expect(f.execute.mock.calls.some(([, args]) => args.includes("cherry-pick"))).toBe(false);
	});
	it("applies linear commits: refuses pre-existing cherry-pick state", async () => {
		const f = fixture();
		f.commit("one.txt", "one");
		writeFileSync(join(f.parent, ".git", "CHERRY_PICK_HEAD"), `${f.base}\n`);
		await expect(prepareWorktreeApply(f.result(), f.parent, { execute: f.execute })).rejects.toThrow(/cherry-pick/);
		expect(f.execute.mock.calls.some(([, args]) => args.includes("cherry-pick"))).toBe(false);
	});
	it.each(["single", "later"])("restores failed cherry-pick: %s conflict restores exact parent state and clears its sequencer", async (kind) => {
		const f = fixture();
		if (kind === "later") f.commit("added.txt", "added by first commit");
		else writeFileSync(join(f.child, "added.txt"), "added by conflicting commit");
		writeFileSync(join(f.child, "shared.txt"), "child change\n");
		git(f.child, "add", ".");
		git(f.child, "commit", "-m", "conflicting child change");
		f.commit("shared.txt", "parent change\n", f.parent);
		const before = git(f.parent, "rev-parse", "HEAD").trim();
		const childBefore = git(f.child, "rev-parse", "HEAD");
		const preview = await prepareWorktreeApply(f.result(), f.parent);
		expect(await applyWorktreeResult(preview, true, { execute: f.execute })).toMatchObject({ kind: "restored" });
		expect(git(f.parent, "rev-parse", "HEAD").trim()).toBe(before);
		expect(git(f.parent, "status", "--porcelain=v1", "-z")).toBe("");
		expect(existsSync(join(f.parent, "added.txt"))).toBe(false);
		expect(existsSync(join(f.parent, ".git", "CHERRY_PICK_HEAD"))).toBe(false);
		expect(existsSync(join(f.parent, ".git", "sequencer"))).toBe(false);
		expect(git(f.child, "rev-parse", "HEAD")).toBe(childBefore);
		expect(git(f.child, "status", "--porcelain=v1", "-z")).toBe("");
		const actions = f.execute.mock.calls.flatMap(([, args]) => {
			const index = args.findIndex((arg) => ["restore", "cherry-pick", "reset", "clean", "merge"].includes(arg));
			return index === -1 ? [] : [args.slice(index)];
		});
		expect(actions).toEqual([
			["cherry-pick", "--no-commit", ...preview.inspection.commits],
			["restore", `--source=${before}`, "--staged", "--worktree", "--", "."],
			["cherry-pick", "--quit"],
		]);
		// A second independent result proves the first operation left no Git sequencer behind.
		const nextPath = join(f.root, "next child");
		git(f.parent, "worktree", "add", "-b", "sumo/next", nextPath, before);
		const nextHead = f.commit("next.txt", "next", nextPath);
		const nextResult: WorktreeResult = { ...f.result(), id: "sa-next", completionId: "next-completion",
			worktree: { path: nextPath, repoRoot: f.parent, branch: "sumo/next", baseRef: before },
			manifest: { ...f.result().manifest, baseRef: before, headRef: nextHead, branch: "sumo/next", worktreePath: nextPath } };
		expect(await applyWorktreeResult(await prepareWorktreeApply(nextResult, f.parent), true)).toMatchObject({ kind: "applied" });
	});
	it("restores failed cherry-pick: failed restoration preserves evidence and requires manual recovery", async () => {
		const f = fixture();
		f.commit("shared.txt", "child\n");
		f.commit("shared.txt", "parent\n", f.parent);
		const preview = await prepareWorktreeApply(f.result(), f.parent);
		const execute: GitExecutor = (file, args, options) => args.includes("restore")
			? Promise.reject(new Error("restore unavailable")) : f.execute(file, args, options);
		const outcome = await applyWorktreeResult(preview, true, { execute });
		expect(outcome).toMatchObject({ kind: "manual-recovery" });
		if (outcome.kind !== "manual-recovery") throw new Error("missing manual recovery evidence");
		expect(existsSync(outcome.evidencePath)).toBe(true);
		expect(outcome.commands).toEqual(expect.arrayContaining([
			["restore", `--source=${preview.parent.head}`, "--staged", "--worktree", "--", "."], ["cherry-pick", "--quit"],
		]));
		expect(existsSync(f.child)).toBe(true);
		await expect(applyWorktreeResult(preview, true)).rejects.toThrow(/operation|recovery/);
	});
});

describe("separately confirmed prune", () => {
	it("prune removes one clean worktree without deleting its branch", async () => {
		const f = fixture();
		f.commit("one.txt", "one");
		const preview = await prepareWorktreePrune(f.result());
		expect(await pruneWorktreeResult(preview, true, { execute: f.execute })).toEqual({ kind: "pruned" });
		expect(existsSync(f.child)).toBe(false);
		expect(git(f.parent, "show-ref", "--verify", "refs/heads/sumo/child")).toContain("refs/heads/sumo/child");
		const calls = f.execute.mock.calls.filter(([, args]) => args.includes("remove"));
		expect(calls.map(([, args]) => args.slice(args.indexOf("worktree")))).toEqual([["worktree", "remove", "--", f.child]]);
		expect(f.execute.mock.calls.some(([, args]) => args.includes("--force") || args.includes("-D") || args.includes("-d"))).toBe(false);
	});
	it("prune cancellation does not remove anything", async () => {
		const f = fixture();
		const preview = await prepareWorktreePrune(f.result());
		expect(await pruneWorktreeResult(preview, false, { execute: f.execute })).toEqual({ kind: "cancelled" });
		expect(f.execute).not.toHaveBeenCalled();
		expect(existsSync(f.child)).toBe(true);
	});
	it("prune refuses dirty, ignored, and changed-since-confirmation worktrees", async () => {
		const f = fixture();
		const preview = await prepareWorktreePrune(f.result());
		writeFileSync(join(f.child, "unsaved.txt"), "unsaved");
		await expect(pruneWorktreeResult(preview, true, { execute: f.execute })).rejects.toThrow(/clean|changed/);
		expect(f.execute.mock.calls.some(([, args]) => args.includes("remove"))).toBe(false);
		const ignored = fixture();
		ignored.commit(".gitignore", "ignored.txt\n");
		writeFileSync(join(ignored.child, "ignored.txt"), "preserve ignored data");
		await expect(prepareWorktreePrune(ignored.result())).rejects.toThrow(/ignored|clean/);
	});
});
