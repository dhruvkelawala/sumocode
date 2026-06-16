import { describe, expect, it, vi } from "vitest";
import { parseWorktreeArgs, registerWorktreeCommand } from "./worktree.js";

function makePi() {
	let handler: ((args: string | undefined, ctx: { hasUI: boolean; cwd: string; ui: { notify: ReturnType<typeof vi.fn> } }) => Promise<void>) | undefined;
	const registerCommand = vi.fn((_name: string, options: { handler: typeof handler }) => {
		handler = options.handler;
	});
	const sendMessage = vi.fn();
	return { pi: { registerCommand, sendMessage }, handler: () => handler, registerCommand, sendMessage };
}

describe("/sumo:worktree", () => {
	it("parses open and prune modes", () => {
		expect(parseWorktreeArgs("build the thing")).toEqual({ mode: "open", task: "build the thing" });
		expect(parseWorktreeArgs("prune")).toEqual({ mode: "prune", task: "" });
		expect(parseWorktreeArgs("prune sumo/foo")).toEqual({ mode: "prune", task: "sumo/foo" });
	});

	it("creates a named worktree and opens an interactive sumocode pane with setup", async () => {
		const { pi, handler, registerCommand, sendMessage } = makePi();
		const create = vi.fn(async () => ({ ok: true as const, path: "/repo.wt/sumo__task", branch: "sumo/task", baseRef: "HEAD" }));
		const openSplit = vi.fn(async () => ({ ok: true as const }));
		const notify = vi.fn();
		registerWorktreeCommand(pi as never, {
			create,
			openSplit,
			isInCmux: () => true,
			terminalSize: () => ({ columns: 80, rows: 120 }),
			setupAction: "pnpm install",
		});

		await handler()?.("ship v0.4", { hasUI: true, cwd: "/repo", ui: { notify } });

		expect(registerCommand).toHaveBeenCalledWith("sumo:worktree", expect.objectContaining({ description: expect.any(String) }));
		expect(create).toHaveBeenCalledWith({ repoRoot: "/repo", task: "ship v0.4", baseRef: "HEAD" });
		expect(openSplit).toHaveBeenCalledWith(pi, "down", expect.stringContaining("cd '/repo.wt/sumo__task'"));
		const openedCommand = (openSplit.mock.calls[0] as unknown[] | undefined)?.[2] as string;
		expect(openedCommand).toContain("pnpm install && SUMOCODE_TASK_KEEP_OPEN=1 exec sumocode task");
		expect(openedCommand).toContain("ship v0.4");
		expect(sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({ customType: "sumo:worktree", content: expect.stringContaining("opened sumo/task in down split"), display: true }),
			{ triggerTurn: false },
		);
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("opened sumo/task in down split"), "info");
	});

	it("guards non-cmux and missing task before creating worktrees", async () => {
		const { pi, handler } = makePi();
		const create = vi.fn();
		const notify = vi.fn();
		registerWorktreeCommand(pi as never, { create: create as never, isInCmux: () => false });

		await handler()?.("do work", { hasUI: true, cwd: "/repo", ui: { notify } });

		expect(create).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledWith("/sumo:worktree requires a cmux surface", "warning");
	});

	it("lists sumo worktrees when prune has no target", async () => {
		const { pi, handler } = makePi();
		const notify = vi.fn();
		registerWorktreeCommand(pi as never, {
			list: vi.fn(async () => ({
				ok: true as const,
				worktrees: [{ path: "/repo.wt/sumo__one", branch: "sumo/one", head: "abc", detached: false }],
			})),
		});

		await handler()?.("prune", { hasUI: true, cwd: "/repo", ui: { notify } });

		expect(notify).toHaveBeenCalledWith(expect.stringContaining("sumo/one"), "info");
	});

	it("removes an explicit sumo worktree on prune", async () => {
		const { pi, handler } = makePi();
		const remove = vi.fn(async () => ({ ok: true as const }));
		const notify = vi.fn();
		registerWorktreeCommand(pi as never, {
			list: vi.fn(async () => ({
				ok: true as const,
				worktrees: [{ path: "/repo.wt/sumo__one", branch: "sumo/one", head: "abc", detached: false }],
			})),
			remove,
		});

		await handler()?.("prune sumo/one", { hasUI: true, cwd: "/repo", ui: { notify } });

		expect(remove).toHaveBeenCalledWith({ repoRoot: "/repo", path: "/repo.wt/sumo__one" });
		expect(notify).toHaveBeenCalledWith("removed worktree sumo/one", "info");
	});
});
