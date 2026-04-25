import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { SUMOCODE_STATES, type SumoCodeState } from "./tokens.js";
import { formatContextGauge, formatFooterLine, resolveGitBranch, type FooterSnapshot } from "./footer.js";

const ANSI = /\u001b\[[0-9;]*m/g;
const tempDirs: string[] = [];

function withoutAnsi(value: string): string {
	return value.replace(ANSI, "");
}

function snapshot(overrides: Partial<FooterSnapshot> = {}): FooterSnapshot {
	return {
		cwd: join(process.env.HOME ?? "/Users/sumo-deus", "argent-x"),
		branch: "main",
		inputTokens: 12_000,
		outputTokens: 8_000,
		costUsd: 0.42,
		contextPercent: 42,
		contextWindow: 200_000,
		state: "idle",
		modelId: "claude-opus-4-7",
		...overrides,
	};
}

function tmpGitRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), "sumocode-footer-"));
	tempDirs.push(dir);
	execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
	execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
	execFileSync("git", ["config", "user.name", "SumoCode Test"], { cwd: dir });
	execFileSync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: dir, stdio: "ignore" });
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("formatFooterLine", () => {
	it.each(SUMOCODE_STATES)("formats the %s state", (state: SumoCodeState) => {
		const line = formatFooterLine(snapshot({ state }));
		const plain = withoutAnsi(line);

		expect(plain).toContain("~/argent-x (main)");
		expect(plain).toContain("↑12k ↓8.0k");
		expect(plain).toContain("$0.42");
		expect(plain).toContain("42%/200k");
		expect(plain).toContain(`● ${state}`);
		expect(plain).toContain("claude-opus-4-7");
	});

	it("omits git branch parentheses outside a repository", () => {
		const line = withoutAnsi(formatFooterLine(snapshot({ branch: null })));

		expect(line).toContain("~/argent-x · ↑12k ↓8.0k");
		expect(line).not.toContain("~/argent-x (");
	});
});

describe("formatContextGauge", () => {
	it("rounds percent and formats context window", () => {
		expect(formatContextGauge(41.6, 200_000)).toBe("42%/200k");
	});

	it("uses an unknown marker when context usage is unavailable", () => {
		expect(formatContextGauge(null, 200_000)).toBe("?/200k");
	});
});

describe("resolveGitBranch", () => {
	it("detects the current branch", () => {
		const repo = tmpGitRepo();

		expect(resolveGitBranch(repo)).toBe("main");
	});

	it("reports detached HEAD as detached", () => {
		const repo = tmpGitRepo();
		const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
		execFileSync("git", ["checkout", "--detach", sha], { cwd: repo, stdio: "ignore" });

		expect(resolveGitBranch(repo)).toBe("detached");
	});

	it("returns null outside a git repository", () => {
		const dir = mkdtempSync(join(tmpdir(), "sumocode-no-git-"));
		tempDirs.push(dir);

		expect(resolveGitBranch(dir)).toBeNull();
	});
});
