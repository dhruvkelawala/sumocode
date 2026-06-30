import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createWorktree,
	headAdvanced,
	isClean,
	listWorktrees,
	parseWorktreePorcelain,
	removeWorktree,
	slugifyBranch,
	worktreeRoot,
} from "./worktree.js";

function git(cwd: string, args: readonly string[]): string {
	return execFileSync("git", [...args], { cwd, encoding: "utf8" });
}

describe("git/worktree", () => {
	let root: string;
	let repo: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "sumocode-worktree-test-"));
		repo = join(root, "repo with spaces");
		mkdirSync(repo, { recursive: true });
		git(repo, ["init"]);
		git(repo, ["config", "user.email", "sumocode@example.test"]);
		git(repo, ["config", "user.name", "SumoCode Test"]);
		writeFileSync(join(repo, "README.md"), "hello\n");
		git(repo, ["add", "README.md"]);
		git(repo, ["commit", "-m", "initial"]);
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("slugifies task text for named sumo branches", () => {
		expect(slugifyBranch("Add bg_task worktree fan-out!")).toBe("add-bg-task-worktree-fan-out");
		expect(slugifyBranch("---")).toBe("task");
	});

	it("uses a sibling worktree root so the repo stays clean", () => {
		expect(worktreeRoot(repo)).toBe(join(dirname(repo), `${basename(repo)}.sumo-worktrees`));
	});

	it("parses git worktree porcelain output", () => {
		expect(parseWorktreePorcelain("worktree /repo\nHEAD abc123\nbranch refs/heads/main\n\nworktree /tmp/wt\nHEAD def456\ndetached\n")).toEqual([
			{ path: "/repo", head: "abc123", branch: "main", detached: false },
			{ path: "/tmp/wt", head: "def456", detached: true },
		]);
	});

	it("creates, lists, checks, advances, and removes a named-branch worktree", async () => {
		const created = await createWorktree({ repoRoot: repo, task: "Implement worktree fanout", baseRef: "HEAD" });
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		expect(created.branch).toBe("sumo/implement-worktree-fanout");
		expect(existsSync(created.path)).toBe(true);

		const listed = await listWorktrees(repo);
		expect(listed.ok).toBe(true);
		if (!listed.ok) return;
		expect(listed.worktrees.some((worktree) => realpathSync(worktree.path) === realpathSync(created.path) && worktree.branch === created.branch)).toBe(true);

		expect(await isClean(created.path)).toMatchObject({ ok: true, clean: true });
		expect(await headAdvanced(created.path, "HEAD~0")).toMatchObject({ ok: true, advanced: false });
		const baseBranch = git(repo, ["branch", "--show-current"]).trim();

		writeFileSync(join(created.path, "feature.txt"), "feature\n");
		expect(await isClean(created.path)).toMatchObject({ ok: true, clean: false });
		git(created.path, ["add", "feature.txt"]);
		git(created.path, ["commit", "-m", "feature"]);
		expect(await headAdvanced(created.path, baseBranch)).toMatchObject({ ok: true, advanced: true });

		const removed = await removeWorktree({ repoRoot: repo, path: created.path, force: true });
		expect(removed).toEqual({ ok: true });
		expect(existsSync(created.path)).toBe(false);
	});

	it("surfaces branch and path collisions as typed errors", async () => {
		git(repo, ["branch", "sumo/existing"]);
		expect(await createWorktree({ repoRoot: repo, branch: "sumo/existing" })).toMatchObject({
			ok: false,
			error: "branch_already_exists",
		});

		const collisionPath = join(root, "already here");
		mkdirSync(collisionPath);
		expect(await createWorktree({ repoRoot: repo, branch: "sumo/new", path: collisionPath })).toMatchObject({
			ok: false,
			error: "path_already_exists",
		});
	});
});
