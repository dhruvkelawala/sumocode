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
	it("parses fresh, reopen, delegate, prune, and base-ref arguments", () => {
		expect(parseWorktreeArgs("")).toEqual({ mode: "fresh", value: "" });
		expect(parseWorktreeArgs("new")).toEqual({ mode: "fresh", value: "" });
		expect(parseWorktreeArgs("new fix-scroll")).toEqual({ mode: "fresh", value: "fix-scroll" });
		expect(parseWorktreeArgs("open sumo/fix-scroll")).toEqual({ mode: "reopen", value: "sumo/fix-scroll" });
		expect(parseWorktreeArgs("open /repo worktrees/fix-scroll")).toEqual({ mode: "reopen", value: "/repo worktrees/fix-scroll" });
		expect(parseWorktreeArgs("build the thing")).toEqual({ mode: "delegate", value: "build the thing" });
		expect(parseWorktreeArgs("prune")).toEqual({ mode: "prune", value: "" });
		expect(parseWorktreeArgs("prune sumo/foo")).toEqual({ mode: "prune", value: "sumo/foo" });
		expect(parseWorktreeArgs("--base origin/main new x")).toEqual({ mode: "fresh", value: "x", baseRef: "origin/main" });
		expect(parseWorktreeArgs("new x --base origin/main")).toEqual({ mode: "fresh", value: "x", baseRef: "origin/main" });
		expect(parseWorktreeArgs("ship it --base origin/main")).toEqual({ mode: "delegate", value: "ship it", baseRef: "origin/main" });
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

	it("forwards a delegate base ref without changing the delegated command", async () => {
		const { pi, handler } = makePi();
		const create = vi.fn(async () => ({ ok: true as const, path: "/repo.wt/sumo__task", branch: "sumo/task", baseRef: "origin/main" }));
		const openSplit = vi.fn(async () => ({ ok: true as const }));
		registerWorktreeCommand(pi as never, { create, openSplit, isInCmux: () => true, setupAction: "" });

		await handler()?.("--base origin/main ship v0.4", { hasUI: true, cwd: "/repo", ui: { notify: vi.fn() } });

		expect(create).toHaveBeenCalledWith({ repoRoot: "/repo", task: "ship v0.4", baseRef: "origin/main" });
		const openedCommand = (openSplit.mock.calls[0] as unknown[] | undefined)?.[2] as string;
		expect(openedCommand).toContain("SUMOCODE_TASK_KEEP_OPEN=1 exec sumocode task");
		expect(openedCommand).toContain("ship v0.4");
	});

	it("opens a generated fresh worktree as a plain interactive session", async () => {
		const { pi, handler } = makePi();
		const create = vi.fn(async () => ({ ok: true as const, path: "/repo.wt/sumo__generated", branch: "sumo/wt-generated", baseRef: "HEAD" }));
		const openSplit = vi.fn(async () => ({ ok: true as const }));
		const notify = vi.fn();
		registerWorktreeCommand(pi as never, {
			create,
			openSplit,
			isInCmux: () => true,
			terminalSize: () => ({ columns: 160, rows: 50 }),
			setupAction: "pnpm install",
		});

		await handler()?.("", { hasUI: true, cwd: "/repo", ui: { notify } });

		expect(create).toHaveBeenCalledWith({ repoRoot: "/repo", task: expect.stringMatching(/^wt-[a-z0-9]+$/), baseRef: "HEAD" });
		const openedCommand = (openSplit.mock.calls[0] as unknown[] | undefined)?.[2] as string;
		expect(openedCommand).toContain("pnpm install && exec sumocode");
		expect(openedCommand).not.toContain("sumocode task");
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("opened sumo/wt-generated (fresh session) in right split"), "info");
	});

	it("opens a named fresh worktree from the requested base ref", async () => {
		const { pi, handler } = makePi();
		const create = vi.fn(async () => ({ ok: true as const, path: "/repo.wt/sumo__fix-scroll", branch: "sumo/fix-scroll", baseRef: "origin/main" }));
		registerWorktreeCommand(pi as never, {
			create,
			openSplit: vi.fn(async () => ({ ok: true as const })),
			isInCmux: () => true,
		});

		await handler()?.("new fix-scroll --base origin/main", { hasUI: true, cwd: "/repo", ui: { notify: vi.fn() } });

		expect(create).toHaveBeenCalledWith({ repoRoot: "/repo", task: "fix-scroll", baseRef: "origin/main" });
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

	it("guards fresh and reopen sessions before touching worktrees", async () => {
		const noUi = makePi();
		const create = vi.fn();
		registerWorktreeCommand(noUi.pi as never, { create: create as never, isInCmux: () => true });

		await noUi.handler()?.("", { hasUI: false, cwd: "/repo", ui: { notify: vi.fn() } });

		expect(create).not.toHaveBeenCalled();
		expect(noUi.sendMessage).not.toHaveBeenCalled();

		const outsideCmux = makePi();
		const list = vi.fn();
		const notify = vi.fn();
		registerWorktreeCommand(outsideCmux.pi as never, { list: list as never, isInCmux: () => false });

		await outsideCmux.handler()?.("open sumo/one", { hasUI: true, cwd: "/repo", ui: { notify } });

		expect(list).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledWith("/sumo:worktree requires a cmux surface", "warning");
	});

	it.each([
		["branch", "sumo/one"],
		["path", "/repo.wt/sumo__one"],
	])("reopens an existing sumo worktree by %s without creating", async (_label, target) => {
		const { pi, handler } = makePi();
		const create = vi.fn();
		const openSplit = vi.fn(async () => ({ ok: true as const }));
		const notify = vi.fn();
		registerWorktreeCommand(pi as never, {
			create: create as never,
			list: vi.fn(async () => ({
				ok: true as const,
				worktrees: [
					{ path: "/repo", branch: "main", head: "def", detached: false },
					{ path: "/repo.wt/sumo__one", branch: "sumo/one", head: "abc", detached: false },
				],
			})),
			openSplit,
			isInCmux: () => true,
			setupAction: "pnpm install",
		});

		await handler()?.(`open ${target}`, { hasUI: true, cwd: "/repo", ui: { notify } });

		expect(create).not.toHaveBeenCalled();
		expect(openSplit).toHaveBeenCalledWith(pi, expect.any(String), expect.stringContaining("cd '/repo.wt/sumo__one'"));
		expect((openSplit.mock.calls[0] as unknown[] | undefined)?.[2]).toContain("pnpm install && exec sumocode");
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("reopened sumo/one in"), "info");
	});

	it("warns with available branches when a reopen target is unknown", async () => {
		const { pi, handler } = makePi();
		const notify = vi.fn();
		registerWorktreeCommand(pi as never, {
			list: vi.fn(async () => ({
				ok: true as const,
				worktrees: [{ path: "/repo.wt/sumo__one", branch: "sumo/one", head: "abc", detached: false }],
			})),
			isInCmux: () => true,
		});

		await handler()?.("open sumo/missing", { hasUI: true, cwd: "/repo", ui: { notify } });

		expect(notify).toHaveBeenCalledWith(expect.stringContaining("no tracked sumo worktree matched sumo/missing"), "warning");
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("available: sumo/one"), "warning");
	});

	it.each(["open sumo/one --base origin/main", "prune sumo/one --base origin/main"])("rejects --base for %s", async (args) => {
		const { pi, handler } = makePi();
		const list = vi.fn();
		const notify = vi.fn();
		registerWorktreeCommand(pi as never, { list: list as never, isInCmux: () => true });

		await handler()?.(args, { hasUI: true, cwd: "/repo", ui: { notify } });

		expect(list).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledWith("/sumo:worktree: --base is only valid for fresh or delegated worktrees", "warning");
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
