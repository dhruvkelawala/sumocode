import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildCompletionManifest } from "./manifest.js";

function git(cwd: string, args: readonly string[]): string {
	return execFileSync("git", [...args], { cwd, encoding: "utf8" }).trim();
}

describe("buildCompletionManifest", () => {
	let root: string;
	let repo: string;
	let baseRef: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "sumocode-manifest-test-"));
		repo = join(root, "repo with spaces");
		mkdirSync(repo, { recursive: true });
		git(repo, ["init"]);
		git(repo, ["config", "user.email", "sumocode@example.test"]);
		git(repo, ["config", "user.name", "SumoCode Test"]);
		writeFileSync(join(repo, "README.md"), "hello\n");
		git(repo, ["add", "README.md"]);
		git(repo, ["commit", "-m", "initial"]);
		baseRef = git(repo, ["rev-parse", "HEAD"]);
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("reports a clean shared-checkout completion from host git reads", async () => {
		const manifest = await buildCompletionManifest({
			cwd: repo,
			baseRef,
			outcome: { kind: "completed", finalText: "model prose is irrelevant" },
			startedAt: Date.now() - 25,
		});

		expect(manifest).toMatchObject({
			baseRef,
			headRef: baseRef,
			changedPaths: [],
			dirty: false,
			commits: 0,
			exit: "completed",
		});
		expect(manifest.durationMs).toBeGreaterThanOrEqual(0);
	});

	it("reports committed paths and commits ahead for an isolated worktree", async () => {
		writeFileSync(join(repo, "feature.ts"), "export const feature = true;\n");
		git(repo, ["add", "feature.ts"]);
		git(repo, ["commit", "-m", "feature"]);
		const headRef = git(repo, ["rev-parse", "HEAD"]);

		const manifest = await buildCompletionManifest({
			cwd: repo,
			baseRef,
			outcome: { kind: "completed", finalText: "done" },
			startedAt: Date.now(),
			worktree: { path: repo, branch: "sumo/feature" },
		});

		expect(manifest).toMatchObject({
			headRef,
			branch: "sumo/feature",
			worktreePath: repo,
			changedPaths: ["feature.ts"],
			dirty: false,
			commits: 1,
		});
	});

	it("unions dirty and committed paths for an isolated worktree", async () => {
		writeFileSync(join(repo, "README.md"), "changed\n");
		writeFileSync(join(repo, "untracked file.ts"), "dirty\n");

		const manifest = await buildCompletionManifest({
			cwd: repo,
			baseRef,
			outcome: { kind: "failed", errorText: "child failed" },
			startedAt: Date.now(),
			worktree: { path: repo, branch: "sumo/dirty" },
		});

		expect(manifest).toMatchObject({
			changedPaths: ["README.md", "untracked file.ts"],
			dirty: true,
			commits: 0,
			exit: "failed",
		});
	});

	it("reports only a rename destination from porcelain status", async () => {
		git(repo, ["mv", "README.md", "renamed.md"]);

		const manifest = await buildCompletionManifest({
			cwd: repo,
			baseRef,
			outcome: { kind: "completed", finalText: "done" },
			startedAt: Date.now(),
			worktree: { path: repo, branch: "sumo/rename" },
		});

		expect(manifest.changedPaths).toEqual(["renamed.md"]);
		expect(manifest.dirty).toBe(true);
	});

	it("does not attribute shared-checkout dirty paths to the child", async () => {
		writeFileSync(join(repo, "parent-edit.ts"), "not attributable\n");

		const manifest = await buildCompletionManifest({
			cwd: repo,
			baseRef,
			outcome: { kind: "interrupted" },
			startedAt: Date.now(),
		});

		expect(manifest.changedPaths).toEqual([]);
		expect(manifest.dirty).toBe(true);
		expect(manifest.exit).toBe("interrupted");
	});

	it("reports shared-checkout commits as host facts without attributing paths", async () => {
		writeFileSync(join(repo, "parent-commit.ts"), "host-observed\n");
		git(repo, ["add", "parent-commit.ts"]);
		git(repo, ["commit", "-m", "concurrent parent commit"]);

		const manifest = await buildCompletionManifest({
			cwd: repo,
			baseRef,
			outcome: { kind: "completed", finalText: "done" },
			startedAt: Date.now(),
		});

		expect(manifest.commits).toBe(1);
		expect(manifest.changedPaths).toEqual([]);
	});

	it("degrades every git failure to a partial manifest", async () => {
		const missingRepo = join(root, "missing");
		await expect(buildCompletionManifest({
			cwd: missingRepo,
			baseRef: "deadbeef",
			outcome: { kind: "failed", errorText: "spawn failed" },
			startedAt: Date.now(),
			worktree: { path: missingRepo, branch: "sumo/missing" },
		})).resolves.toMatchObject({
			baseRef: "deadbeef",
			branch: "sumo/missing",
			worktreePath: missingRepo,
			changedPaths: [],
			dirty: false,
			commits: 0,
			exit: "failed",
		});
	});
});
