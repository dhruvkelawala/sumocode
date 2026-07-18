import { describe, expect, it, vi } from "vitest";
import { parseWorktreeArgs, registerWorktreeCommand } from "./worktree.js";
import type { TerminalHost, TerminalHostKind } from "../terminal-host/index.js";

type OpenSplitMock = ReturnType<typeof vi.fn>;
type OpenCurrentMock = ReturnType<typeof vi.fn>;
type OpenWorktreeMock = ReturnType<typeof vi.fn>;

function makeTerminalHost(openSplit: OpenSplitMock = vi.fn(async () => ({ ok: true as const })), openCurrent?: OpenCurrentMock, kind: TerminalHostKind = "cmux", openWorktree?: OpenWorktreeMock, openExistingWorktree?: OpenWorktreeMock): TerminalHost {
	return {
		kind,
		openCommandInSplit: async (pi: never, direction: "right" | "down", options: { shellCommand: string }) => {
			const result = await (openSplit as unknown as (pi: never, direction: "right" | "down", command: string) => Promise<{ ok: true } | { ok: false; error: string }>)(pi, direction, options.shellCommand);
			const paneHost = kind === "herdr" ? "herdr" as const : "cmux" as const;
			return result.ok ? { ok: true as const, pane: { host: paneHost, paneId: "legacy" } } : result;
		},
		openWorktreeWorkspace: openWorktree ? async (pi: never, options: unknown) => (openWorktree as unknown as (pi: never, options: unknown) => Promise<{ ok: true; pane: { host: "herdr"; paneId: string } } | { ok: false; error: string }>)(pi, options) : undefined,
		openExistingWorktreeWorkspace: openExistingWorktree ? async (pi: never, options: unknown) => (openExistingWorktree as unknown as (pi: never, options: unknown) => Promise<{ ok: true; pane: { host: "herdr"; paneId: string } } | { ok: false; error: string }>)(pi, options) : undefined,
		replaceCurrentPane: openCurrent ? async (pi: never, options: { shellCommand: string }) => (openCurrent as unknown as (pi: never, command: string) => Promise<{ ok: true } | { ok: false; error: string }>)(pi, options.shellCommand) : undefined,
		closePane: vi.fn(async () => ({ ok: true as const })),
		notify: vi.fn(async () => undefined),
	};
}

const noneHost = {
	kind: "none" as const,
	openCommandInSplit: vi.fn(async () => ({ ok: false as const, error: "requires a terminal host (cmux or herdr)" })),
	closePane: vi.fn(async () => ({ ok: false as const, error: "requires a terminal host (cmux or herdr)" })),
	notify: vi.fn(async () => undefined),
};

function makePi() {
	let handler: ((args: string | undefined, ctx: {
		hasUI: boolean;
		cwd: string;
		ui: { notify: ReturnType<typeof vi.fn> };
		sessionManager?: { getBranch(): Array<{ type: string }> };
	}) => Promise<void>) | undefined;
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
			terminalHost: makeTerminalHost(openSplit),
			terminalSize: () => ({ columns: 80, rows: 120 }),
			setupAction: "pnpm install",
		});

		await handler()?.("ship v0.4", { hasUI: true, cwd: "/repo", ui: { notify } });

		expect(registerCommand).toHaveBeenCalledWith("sumo:worktree", expect.objectContaining({ description: expect.any(String) }));
		expect(create).toHaveBeenCalledWith({ repoRoot: "/repo", task: "ship v0.4", baseRef: "HEAD" });
		expect(openSplit).toHaveBeenCalledWith(pi, "down", expect.stringMatching(/^bash -lc /));
		const openedCommand = (openSplit.mock.calls[0] as unknown[] | undefined)?.[2] as string;
		expect(openedCommand).toContain("/repo.wt/sumo__task");
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
		registerWorktreeCommand(pi as never, { create, terminalHost: makeTerminalHost(openSplit), setupAction: "" });

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
			terminalHost: makeTerminalHost(openSplit),
			terminalSize: () => ({ columns: 160, rows: 50 }),
			setupAction: "pnpm install",
		});

		await handler()?.("", {
			hasUI: true,
			cwd: "/repo",
			ui: { notify },
			sessionManager: { getBranch: () => [{ type: "message" }] },
		});

		expect(create).toHaveBeenCalledWith({ repoRoot: "/repo", task: expect.stringMatching(/^wt-[a-z0-9]+$/), baseRef: "HEAD" });
		const openedCommand = (openSplit.mock.calls[0] as unknown[] | undefined)?.[2] as string;
		expect(openedCommand).toContain("pnpm install && exec sumocode");
		expect(openedCommand).not.toContain("sumocode task");
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("opened sumo/wt-generated (fresh session) in right split"), "info");
	});

	it("replaces the current pane for a fresh worktree launched from the splash", async () => {
		const { pi, handler } = makePi();
		const create = vi.fn(async () => ({ ok: true as const, path: "/repo.wt/sumo__fresh", branch: "sumo/fresh", baseRef: "HEAD" }));
		const openCurrent = vi.fn(async () => ({ ok: true as const }));
		const openSplit = vi.fn(async () => ({ ok: true as const }));
		registerWorktreeCommand(pi as never, {
			create,
			terminalHost: makeTerminalHost(openSplit, openCurrent),
			setupAction: "pnpm install",
		});

		await handler()?.("new fresh", {
			hasUI: true,
			cwd: "/repo",
			ui: { notify: vi.fn() },
			sessionManager: { getBranch: () => [] },
		});

		expect(openCurrent).toHaveBeenCalledWith(pi, expect.stringMatching(/^bash -lc /));
		expect((openCurrent.mock.calls[0] as unknown[] | undefined)?.[1]).toContain("/repo.wt/sumo__fresh");
		expect(openSplit).not.toHaveBeenCalled();
	});

	it("falls back to opening a herdr split for a fresh worktree launched from the splash", async () => {
		const { pi, handler } = makePi();
		const create = vi.fn(async () => ({ ok: true as const, path: "/repo.wt/sumo__fresh", branch: "sumo/fresh", baseRef: "HEAD" }));
		const openSplit = vi.fn(async () => ({ ok: true as const }));
		registerWorktreeCommand(pi as never, {
			create,
			terminalHost: makeTerminalHost(openSplit, undefined, "herdr"),
			setupAction: "pnpm install",
		});

		await handler()?.("new fresh", {
			hasUI: true,
			cwd: "/repo",
			ui: { notify: vi.fn() },
			sessionManager: { getBranch: () => [] },
		});

		expect(create).toHaveBeenCalledWith({ repoRoot: "/repo", task: "fresh", baseRef: "HEAD" });
		expect(openSplit).toHaveBeenCalledWith(pi, "right", expect.stringMatching(/^bash -lc /));
		expect((openSplit.mock.calls[0] as unknown[] | undefined)?.[2]).toContain("/repo.wt/sumo__fresh");
	});

	it("uses herdr native worktree workspace for fresh sessions without calling createWorktree", async () => {
		const { pi, handler } = makePi();
		const create = vi.fn();
		const openSplit = vi.fn(async () => ({ ok: true as const }));
		const openWorktree = vi.fn(async () => ({ ok: true as const, pane: { host: "herdr" as const, paneId: "wA:p1" } }));
		const notify = vi.fn();
		registerWorktreeCommand(pi as never, {
			create: create as never,
			terminalHost: makeTerminalHost(openSplit, undefined, "herdr", openWorktree),
			setupAction: "pnpm install",
		});

		await handler()?.("new native", {
			hasUI: true,
			cwd: "/repo",
			ui: { notify },
			sessionManager: { getBranch: () => [] },
		});

		expect(create).not.toHaveBeenCalled();
		expect(openSplit).not.toHaveBeenCalled();
		expect(openWorktree).toHaveBeenCalledWith(pi, expect.objectContaining({ branch: "sumo/native", baseRef: "HEAD", path: "/repo.sumo-worktrees/sumo__native", label: "sumo · native", shellCommand: "pnpm install && exec sumocode" }));
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("opened sumo/native (fresh session) as herdr workspace \"sumo · native\""), "info");
	});

	it("falls back to generic split when herdr native worktree creation fails", async () => {
		const { pi, handler } = makePi();
		const create = vi.fn(async () => ({ ok: true as const, path: "/repo.sumo-worktrees/sumo__native", branch: "sumo/native", baseRef: "HEAD" }));
		const openSplit = vi.fn(async () => ({ ok: true as const }));
		const openWorktree = vi.fn(async () => ({ ok: false as const, error: "native failed" }));
		const notify = vi.fn();
		registerWorktreeCommand(pi as never, {
			create,
			terminalHost: makeTerminalHost(openSplit, undefined, "herdr", openWorktree),
			setupAction: "pnpm install",
			pathExists: () => false,
		});

		await handler()?.("new native", {
			hasUI: true,
			cwd: "/repo",
			ui: { notify },
			sessionManager: { getBranch: () => [] },
		});

		expect(openWorktree).toHaveBeenCalled();
		expect(create).toHaveBeenCalledWith({ repoRoot: "/repo", task: "native", baseRef: "HEAD" });
		expect(openSplit).toHaveBeenCalledWith(pi, "right", expect.stringMatching(/^bash -lc /));
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("herdr workspace create failed (native failed); falling back to split"), "warning");
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("opened sumo/native (fresh session) in right split"), "info");
	});

	it("does not retry createWorktree when herdr already created the worktree on disk", async () => {
		const { pi, handler } = makePi();
		const create = vi.fn(async () => ({ ok: false as const, error: "branch_already_exists" as const, message: "branch exists" }));
		const openSplit = vi.fn(async () => ({ ok: true as const }));
		const openWorktree = vi.fn(async () => ({ ok: false as const, error: "herdr pane run exited 1" }));
		const notify = vi.fn();
		registerWorktreeCommand(pi as never, {
			create,
			terminalHost: makeTerminalHost(openSplit, undefined, "herdr", openWorktree),
			setupAction: "pnpm install",
			pathExists: () => true,
		});

		await handler()?.("new native", {
			hasUI: true,
			cwd: "/repo",
			ui: { notify },
			sessionManager: { getBranch: () => [] },
		});

		expect(openWorktree).toHaveBeenCalled();
		expect(create).not.toHaveBeenCalled();
		expect(openSplit).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledWith(
			expect.stringContaining('herdr created workspace "sumo · native" but launching the session failed (herdr pane run exited 1). Open it with /sumo:worktree open sumo/native'),
			"warning",
		);
	});

	it("warns that a delegated task was not delivered when reconciling a half-created workspace", async () => {
		const { pi, handler } = makePi();
		const create = vi.fn(async () => ({ ok: false as const, error: "branch_already_exists" as const, message: "branch exists" }));
		const openSplit = vi.fn(async () => ({ ok: true as const }));
		const openWorktree = vi.fn(async () => ({ ok: false as const, error: "herdr pane run exited 1" }));
		const notify = vi.fn();
		registerWorktreeCommand(pi as never, {
			create,
			terminalHost: makeTerminalHost(openSplit, undefined, "herdr", openWorktree),
			setupAction: "pnpm install",
			pathExists: () => true,
		});

		await handler()?.("Review the diff for regressions", {
			hasUI: true,
			cwd: "/repo",
			ui: { notify },
			sessionManager: { getBranch: () => [] },
		});

		expect(create).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledWith(
			expect.stringContaining("re-issue your task there; the delegated prompt was not delivered"),
			"warning",
		);
	});

	it("uses herdr native workspace open for reopen", async () => {
		const { pi, handler } = makePi();
		const openSplit = vi.fn(async () => ({ ok: true as const }));
		const openExisting = vi.fn(async () => ({ ok: true as const, pane: { host: "herdr" as const, paneId: "wA:p1" } }));
		const notify = vi.fn();
		registerWorktreeCommand(pi as never, {
			list: vi.fn(async () => ({ ok: true as const, worktrees: [{ path: "/repo.sumo-worktrees/sumo__one", branch: "sumo/one", head: "abc", detached: false }] })),
			terminalHost: makeTerminalHost(openSplit, undefined, "herdr", undefined, openExisting),
			setupAction: "pnpm install",
		});

		await handler()?.("open sumo/one", { hasUI: true, cwd: "/repo", ui: { notify } });

		expect(openExisting).toHaveBeenCalledWith(pi, { path: "/repo.sumo-worktrees/sumo__one", label: "sumo · one", shellCommand: "pnpm install && exec sumocode" });
		expect(openSplit).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("opened sumo/one as herdr workspace \"sumo · one\""), "info");
	});

	it("warns without falling back to a split when current-pane replacement fails", async () => {
		const { pi, handler } = makePi();
		const openSplit = vi.fn(async () => ({ ok: true as const }));
		const notify = vi.fn();
		const openCurrent = vi.fn(async () => ({ ok: false as const, error: "respawn failed" }));
		registerWorktreeCommand(pi as never, {
			create: vi.fn(async () => ({ ok: true as const, path: "/repo.wt/sumo__fresh", branch: "sumo/fresh", baseRef: "HEAD" })),
			terminalHost: makeTerminalHost(openSplit, openCurrent),
		});

		await handler()?.("new fresh", {
			hasUI: true,
			cwd: "/repo",
			ui: { notify },
			sessionManager: { getBranch: () => [] },
		});

		expect(openSplit).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledWith("/sumo:worktree: respawn failed", "warning");
	});

	it("opens a named fresh worktree from the requested base ref", async () => {
		const { pi, handler } = makePi();
		const create = vi.fn(async () => ({ ok: true as const, path: "/repo.wt/sumo__fix-scroll", branch: "sumo/fix-scroll", baseRef: "origin/main" }));
		registerWorktreeCommand(pi as never, {
			create,
			terminalHost: makeTerminalHost(),
		});

		await handler()?.("new fix-scroll --base origin/main", {
			hasUI: true,
			cwd: "/repo",
			ui: { notify: vi.fn() },
			sessionManager: { getBranch: () => [{ type: "message" }] },
		});

		expect(create).toHaveBeenCalledWith({ repoRoot: "/repo", task: "fix-scroll", baseRef: "origin/main" });
	});

	it("guards non-cmux and missing task before creating worktrees", async () => {
		const { pi, handler } = makePi();
		const create = vi.fn();
		const notify = vi.fn();
		registerWorktreeCommand(pi as never, { create: create as never, terminalHost: noneHost });

		await handler()?.("do work", { hasUI: true, cwd: "/repo", ui: { notify } });

		expect(create).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledWith("/sumo:worktree requires a terminal host (cmux or herdr)", "warning");
	});

	it("guards fresh and reopen sessions before touching worktrees", async () => {
		const noUi = makePi();
		const create = vi.fn();
		registerWorktreeCommand(noUi.pi as never, { create: create as never, terminalHost: makeTerminalHost() });

		await noUi.handler()?.("", { hasUI: false, cwd: "/repo", ui: { notify: vi.fn() } });

		expect(create).not.toHaveBeenCalled();
		expect(noUi.sendMessage).not.toHaveBeenCalled();

		const outsideCmux = makePi();
		const list = vi.fn();
		const notify = vi.fn();
		registerWorktreeCommand(outsideCmux.pi as never, { list: list as never, terminalHost: noneHost });

		await outsideCmux.handler()?.("open sumo/one", { hasUI: true, cwd: "/repo", ui: { notify } });

		expect(list).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledWith("/sumo:worktree requires a terminal host (cmux or herdr)", "warning");
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
			terminalHost: makeTerminalHost(openSplit),
			setupAction: "pnpm install",
		});

		await handler()?.(`open ${target}`, { hasUI: true, cwd: "/repo", ui: { notify } });

		expect(create).not.toHaveBeenCalled();
		expect(openSplit).toHaveBeenCalledWith(pi, expect.any(String), expect.stringMatching(/^bash -lc /));
		expect((openSplit.mock.calls[0] as unknown[] | undefined)?.[2]).toContain("/repo.wt/sumo__one");
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
			terminalHost: makeTerminalHost(),
		});

		await handler()?.("open sumo/missing", { hasUI: true, cwd: "/repo", ui: { notify } });

		expect(notify).toHaveBeenCalledWith(expect.stringContaining("no tracked sumo worktree matched sumo/missing"), "warning");
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("available: sumo/one"), "warning");
	});

	it.each(["open sumo/one --base origin/main", "prune sumo/one --base origin/main"])("rejects --base for %s", async (args) => {
		const { pi, handler } = makePi();
		const list = vi.fn();
		const notify = vi.fn();
		registerWorktreeCommand(pi as never, { list: list as never, terminalHost: makeTerminalHost() });

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
