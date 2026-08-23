import { describe, expect, it, vi } from "vitest";
import type { TerminalHost } from "../terminal-host/index.js";
import { openWorktree } from "./open-worktree.js";

function output() {
	let stdout = "";
	let stderr = "";
	return {
		stdout: { write: (value: string | Uint8Array) => { stdout += String(value); return true; } },
		stderr: { write: (value: string | Uint8Array) => { stderr += String(value); return true; } },
		read: () => ({ stdout, stderr }),
	};
}

function baseHost(overrides: Partial<TerminalHost>): TerminalHost {
	return {
		kind: "herdr",
		openCommandInSplit: vi.fn(async () => ({ ok: true as const, pane: { host: "herdr" as const, paneId: "p1" } })),
		closePane: vi.fn(async () => ({ ok: true as const })),
		notify: vi.fn(async () => undefined),
		...overrides,
	};
}

describe("openWorktree", () => {
	it("uses a native worktree workspace and starts SumoCode after setup", async () => {
		const opened = vi.fn(async () => ({ ok: true as const, pane: { host: "herdr" as const, paneId: "p1" } }));
		const create = vi.fn();
		const stream = output();
		// SAFETY: the stdout/stderr/pi options accept minimal test doubles that
		// only implement the write/exec surface openWorktree touches.
		const code = await openWorktree("new-worktree", {
			cwd: "/repo",
			env: { SHELL: "/bin/zsh", SUMOCODE_LAUNCHER: "/repo/bin/sumocode.sh" },
			terminalHost: baseHost({ kind: "herdr", openWorktreeWorkspace: opened }),
			create,
			pi: { exec: vi.fn() } as never,
			stdout: stream.stdout as never,
			stderr: stream.stderr as never,
		});

		expect(code).toBe(0);
		expect(create).not.toHaveBeenCalled();
		expect(opened).toHaveBeenCalledWith(expect.anything(), {
			branch: "sumo/new-worktree",
			baseRef: "HEAD",
			path: "/repo.sumo-worktrees/sumo__new-worktree",
			label: "sumo · new-worktree",
			shellCommand: "pnpm install && exec '/repo/bin/sumocode.sh'",
			sourceCwd: "/repo",
		});
	});

	it("creates a worktree and starts SumoCode in a split on hosts without native workspaces", async () => {
		const openCommandInSplit = vi.fn(async () => ({ ok: true as const, pane: { host: "herdr" as const, paneId: "p1" } }));
		const create = vi.fn(async () => ({ ok: true as const, path: "/repo.sumo-worktrees/sumo__feature", branch: "sumo/feature", baseRef: "HEAD" }));
		const stream = output();
		// SAFETY: the stdout/stderr/pi options accept minimal test doubles that
		// only implement the write/exec surface openWorktree touches.
		const code = await openWorktree("feature", {
			cwd: "/repo",
			env: { SHELL: "/bin/bash", SUMOCODE_LAUNCHER: "/repo/bin/sumocode.sh", SUMOCODE_WORKTREE_SETUP: "" },
			terminalHost: baseHost({ openCommandInSplit }),
			create,
			pi: { exec: vi.fn() } as never,
			stdout: stream.stdout as never,
			stderr: stream.stderr as never,
		});

		expect(code).toBe(0);
		expect(create).toHaveBeenCalledWith({ repoRoot: "/repo", task: "feature", baseRef: "HEAD" });
		expect(openCommandInSplit).toHaveBeenCalledWith(expect.anything(), expect.stringMatching(/right|down/), {
			cwd: "/repo.sumo-worktrees/sumo__feature",
			shellCommand: expect.stringMatching(/cd '\\''\/repo\.sumo-worktrees\/sumo__feature'\\'' && exec '\\''\/repo\/bin\/sumocode\.sh'\\''/),
		});
	});

	it("fails before creating anything when no terminal host is available", async () => {
		const create = vi.fn();
		const stream = output();
		// SAFETY: the stdout/stderr options accept minimal test doubles that
		// only implement the write surface openWorktree touches.
		const code = await openWorktree(undefined, {
			terminalHost: baseHost({ kind: "none" }),
			create,
			stdout: stream.stdout as never,
			stderr: stream.stderr as never,
		});

		expect(code).toBe(1);
		expect(create).not.toHaveBeenCalled();
		expect(stream.read().stderr).toContain("requires a running herdr terminal host");
	});
});
