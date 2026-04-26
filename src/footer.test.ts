import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { SUMOCODE_STATES, type SumoCodeState } from "./tokens.js";
import { formatContextGauge, formatCwd, formatFooterLine, resolveGitBranch, type FooterSnapshot } from "./footer.js";
import { VOICE } from "./voice.js";

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
	it.each(SUMOCODE_STATES)("formats the %s state with its voice label", (state: SumoCodeState) => {
		const line = formatFooterLine(snapshot({ state }));
		const plain = withoutAnsi(line);

		expect(plain).toContain("~/argent-x (main)");
		expect(plain).toContain("↑12k ↓8.0k");
		expect(plain).toContain("$0.42");
		expect(plain).toContain("42%/200k");
		expect(plain).toContain(`● ${VOICE.status[state]}`);
		expect(plain).toContain("claude-opus-4-7");
	});

	it("omits git branch parentheses outside a repository", () => {
		const line = withoutAnsi(formatFooterLine(snapshot({ branch: null })));

		expect(line).toContain("~/argent-x · ↑12k ↓8.0k");
		expect(line).not.toContain("~/argent-x (");
	});
});

describe("formatFooterLine — cathedral coloring", () => {
	it("renders · separators in the divider color", () => {
		const line = formatFooterLine(snapshot());
		// #3A2F25 -> 58;47;37
		expect(line).toContain("\u001b[38;2;58;47;37m");
	});

	it("renders tokens, cost, gauge and model in foreground-dim", () => {
		const line = formatFooterLine(snapshot());
		// #8B7A63 -> 139;122;99
		expect(line).toContain("\u001b[38;2;139;122;99m");
	});

	it("keeps the path in vellum foreground", () => {
		const line = formatFooterLine(snapshot());
		// #F5E6C8 -> 245;230;200
		expect(line).toContain("\u001b[38;2;245;230;200m");
	});
});

describe("formatCwd", () => {
	it("replaces $HOME with ~", () => {
		const home = process.env.HOME ?? "/Users/sumo-deus";
		expect(formatCwd(`${home}/argent-x`)).toBe("~/argent-x");
	});

	it("returns just the basename for paths outside $HOME", () => {
		expect(formatCwd("/Volumes/SumoDeus NVMe/openclaw/workspace/sumocode")).toBe("sumocode");
		expect(formatCwd("/opt/homebrew/etc")).toBe("etc");
	});

	it("keeps a single ~ for HOME itself", () => {
		const home = process.env.HOME ?? "/Users/sumo-deus";
		expect(formatCwd(home)).toBe("~");
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
