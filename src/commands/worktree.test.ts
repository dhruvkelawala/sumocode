import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { SubagentRegistry, type SubagentRecord } from "../subagents/registry.js";
import { RetainedResults } from "../subagents/retained-results.js";
import type { GitExecutor } from "../git/worktree-disposition.js";
import type { showDivineQuery } from "../divine-query.js";
import { describe, expect, it, vi } from "vitest";
import { parseWorktreeArgs, registerWorktreeCommand as registerWorktreeCommandWithDefaults } from "./worktree.js";
import type {
	ExistingWorktreeWorkspaceOptions,
	WorktreeWorkspaceOptions,
	PiExecLike,
	SplitDirection,
	TerminalHost,
	TerminalHostKind,
} from "../terminal-host/types.js";
const registerWorktreeCommand: typeof registerWorktreeCommandWithDefaults = (pi, options = {}) =>
	registerWorktreeCommandWithDefaults(pi, { resolveLauncher: () => "sumocode", ...options });

type SplitResult = { ok: true } | { ok: false; error: string };
type NativePaneResult = { ok: true; pane: { host: "herdr"; paneId: string } } | { ok: false; error: string };

type SplitMock = ReturnType<typeof makeSplitMock>;
type ReplaceMock = ReturnType<typeof makeReplaceMock>;
type PaneOpenerMock = ReturnType<typeof makePaneOpenerMock>;

function makeSplitMock(impl?: () => SplitResult | Promise<SplitResult>) {
	return vi.fn(async (_pi: PiExecLike, _direction: SplitDirection, _command: string): Promise<SplitResult> =>
		impl ? await impl() : { ok: true });
}

function makeReplaceMock(impl?: () => SplitResult | Promise<SplitResult>) {
	return vi.fn(async (_pi: PiExecLike, _command: string): Promise<SplitResult> =>
		impl ? await impl() : { ok: true });
}

function makePaneOpenerMock(
	impl?: () => NativePaneResult | Promise<NativePaneResult>,
) {
	return vi.fn(async (_pi: PiExecLike, _options: WorktreeWorkspaceOptions | ExistingWorktreeWorkspaceOptions): Promise<NativePaneResult> =>
		impl ? await impl() : { ok: true, pane: { host: "herdr", paneId: "wA:p1" } });
}

function makeTerminalHost(
	openSplit: SplitMock = makeSplitMock(),
	openCurrent?: ReplaceMock,
	kind: TerminalHostKind = "herdr",
	openWorktree?: PaneOpenerMock,
	openExistingWorktree?: PaneOpenerMock,
): TerminalHost {
	const paneHost = "herdr" as const;
	return {
		kind,
		async openCommandInSplit(pi, direction, options) {
			const result = await openSplit(pi, direction, options.shellCommand);
			return result.ok ? { ok: true as const, pane: { host: paneHost, paneId: "legacy" } } : result;
		},
		openWorktreeWorkspace: openWorktree
			? async (pi, options) => openWorktree(pi, options)
			: undefined,
		openExistingWorktreeWorkspace: openExistingWorktree
			? async (pi, options) => openExistingWorktree(pi, options)
			: undefined,
		replaceCurrentPane: openCurrent
			? async (pi, options) => openCurrent(pi, options.shellCommand)
			: undefined,
		closePane: async () => ({ ok: true }),
		notify: async () => undefined,
	};
}

function asNever<T>(value: T): never {
	// SAFETY: tests exercise only the option members they pass in; the rest of the Pi API surface is irrelevant here.
	return value as never;
}

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

const noneHost = {
	kind: "none" as const,
	openCommandInSplit: async () => ({ ok: false as const, error: "requires a running herdr terminal host" }),
	closePane: async () => ({ ok: false as const, error: "requires a running herdr terminal host" }),
	notify: async () => undefined,
};

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
		const openSplit = makeSplitMock();
		const notify = vi.fn();
		registerWorktreeCommand(asNever(pi), {
			create,
			terminalHost: makeTerminalHost(openSplit),
			terminalSize: () => ({ columns: 80, rows: 120 }),
			setupAction: "pnpm install",
			resolveLauncher: () => "/parent tools/sumocode",
		});

		await handler()?.("ship v0.4", { hasUI: true, cwd: "/repo", ui: { notify } });

		expect(registerCommand).toHaveBeenCalledWith("sumo:worktree", expect.objectContaining({ description: expect.any(String) }));
		expect(create).toHaveBeenCalledWith({ repoRoot: "/repo", task: "ship v0.4", baseRef: "HEAD" });
		expect(openSplit).toHaveBeenCalledWith(pi, "down", expect.stringMatching(/^bash -lc /));
		const openedCommand = openSplit.mock.calls[0]?.[2];
		expect(openedCommand).toContain("/repo.wt/sumo__task");
		expect(openedCommand).toContain("pnpm install && SUMOCODE_TASK_KEEP_OPEN=1 exec '\\''/parent tools/sumocode'\\'' task");
		expect(openedCommand).toContain("ship v0.4");
		expect(sendMessage).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("opened sumo/task in down split"), "info");
	});

	it("forwards a delegate base ref without changing the delegated command", async () => {
		const { pi, handler } = makePi();
		const create = vi.fn(async () => ({ ok: true as const, path: "/repo.wt/sumo__task", branch: "sumo/task", baseRef: "origin/main" }));
		const openSplit = makeSplitMock();
		registerWorktreeCommand(asNever(pi), { create, terminalHost: makeTerminalHost(openSplit), setupAction: "" });

		await handler()?.("--base origin/main ship v0.4", { hasUI: true, cwd: "/repo", ui: { notify: vi.fn() } });

		expect(create).toHaveBeenCalledWith({ repoRoot: "/repo", task: "ship v0.4", baseRef: "origin/main" });
		const openedCommand = openSplit.mock.calls[0]?.[2];
		expect(openedCommand).toContain("SUMOCODE_TASK_KEEP_OPEN=1 exec sumocode task");
		expect(openedCommand).toContain("ship v0.4");
	});

	it("opens a generated fresh worktree as a plain interactive session", async () => {
		const { pi, handler } = makePi();
		const create = vi.fn(async () => ({ ok: true as const, path: "/repo.wt/sumo__generated", branch: "sumo/wt-generated", baseRef: "HEAD" }));
		const openSplit = makeSplitMock();
		const notify = vi.fn();
		registerWorktreeCommand(asNever(pi), {
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
		const openedCommand = openSplit.mock.calls[0]?.[2];
		expect(openedCommand).toContain("pnpm install && exec sumocode");
		expect(openedCommand).not.toContain("sumocode task");
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("opened sumo/wt-generated (fresh session) in right split"), "info");
	});

	it("replaces the current pane for a fresh worktree launched from the splash", async () => {
		const { pi, handler } = makePi();
		const create = vi.fn(async () => ({ ok: true as const, path: "/repo.wt/sumo__fresh", branch: "sumo/fresh", baseRef: "HEAD" }));
		const openCurrent = makeReplaceMock();
		const openSplit = makeSplitMock();
		registerWorktreeCommand(asNever(pi), {
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
		expect(openCurrent.mock.calls[0]?.[1]).toContain("/repo.wt/sumo__fresh");
		expect(openSplit).not.toHaveBeenCalled();
	});

	it("falls back to opening a herdr split for a fresh worktree launched from the splash", async () => {
		const { pi, handler } = makePi();
		const create = vi.fn(async () => ({ ok: true as const, path: "/repo.wt/sumo__fresh", branch: "sumo/fresh", baseRef: "HEAD" }));
		const openSplit = makeSplitMock();
		registerWorktreeCommand(asNever(pi), {
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
		expect(openSplit.mock.calls[0]?.[2]).toContain("/repo.wt/sumo__fresh");
	});

	it("uses herdr native worktree workspace for fresh sessions without calling createWorktree", async () => {
		const { pi, handler } = makePi();
		const create = vi.fn();
		const openSplit = makeSplitMock();
		const openWorktree = makePaneOpenerMock(() => ({ ok: true, pane: { host: "herdr", paneId: "wA:p1" } }));
		const notify = vi.fn();
		registerWorktreeCommand(asNever(pi), {
			create: asNever(create),
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
		const openSplit = makeSplitMock();
		const openWorktree = makePaneOpenerMock(() => ({ ok: false, error: "native failed" }));
		const notify = vi.fn();
		registerWorktreeCommand(asNever(pi), {
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
		const openSplit = makeSplitMock();
		const openWorktree = makePaneOpenerMock(() => ({ ok: false, error: "herdr pane run exited 1" }));
		const notify = vi.fn();
		registerWorktreeCommand(asNever(pi), {
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
		const openSplit = makeSplitMock();
		const openWorktree = makePaneOpenerMock(() => ({ ok: false, error: "herdr pane run exited 1" }));
		const notify = vi.fn();
		registerWorktreeCommand(asNever(pi), {
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

	it("falls back to a split when herdr native workspace reopen fails", async () => {
		const { pi, handler } = makePi();
		const openSplit = makeSplitMock();
		const openExisting = makePaneOpenerMock(() => ({ ok: false, error: "native reopen failed" }));
		const notify = vi.fn();
		registerWorktreeCommand(asNever(pi), {
			list: vi.fn(async () => ({
				ok: true as const,
				worktrees: [{ path: "/repo.wt/sumo__one", branch: "sumo/one", head: "abc", detached: false }],
			})),
			terminalHost: makeTerminalHost(openSplit, undefined, "herdr", undefined, openExisting),
			setupAction: "pnpm install",
		});

		await handler()?.("open sumo/one", {
			hasUI: true,
			cwd: "/repo",
			ui: { notify },
			sessionManager: { getBranch: () => [] },
		});

		expect(openExisting).toHaveBeenCalled();
		expect(openSplit).toHaveBeenCalledWith(pi, expect.stringMatching(/right|down/), expect.stringMatching(/^bash -lc /));
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("herdr workspace open failed (native reopen failed); falling back to split"), "warning");
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("reopened sumo/one in"), "info");
	});

	it("uses herdr native workspace open for reopen", async () => {
		const { pi, handler } = makePi();
		const openSplit = makeSplitMock();
		const openExisting = makePaneOpenerMock(() => ({ ok: true, pane: { host: "herdr", paneId: "wA:p1" } }));
		const notify = vi.fn();
		registerWorktreeCommand(asNever(pi), {
			list: vi.fn(async () => ({ ok: true as const, worktrees: [{ path: "/repo.sumo-worktrees/sumo__one", branch: "sumo/one", head: "abc", detached: false }] })),
			terminalHost: makeTerminalHost(openSplit, undefined, "herdr", undefined, openExisting),
			setupAction: "pnpm install",
		});

		await handler()?.("open sumo/one", { hasUI: true, cwd: "/repo", ui: { notify } });

		expect(openExisting).toHaveBeenCalledWith(pi, { path: "/repo.sumo-worktrees/sumo__one", label: "sumo · one", shellCommand: "pnpm install && exec sumocode", sourceCwd: "/repo" });
		expect(openSplit).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("opened sumo/one as herdr workspace \"sumo · one\""), "info");
	});

	it("warns without falling back to a split when current-pane replacement fails", async () => {
		const { pi, handler } = makePi();
		const openSplit = makeSplitMock();
		const notify = vi.fn();
		const openCurrent = makeReplaceMock(() => ({ ok: false, error: "respawn failed" }));
		registerWorktreeCommand(asNever(pi), {
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
		registerWorktreeCommand(asNever(pi), {
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

	it("guards missing terminal host before creating worktrees", async () => {
		const { pi, handler } = makePi();
		const create = vi.fn();
		const notify = vi.fn();
		registerWorktreeCommand(asNever(pi), { create: asNever(create), terminalHost: noneHost });

		await handler()?.("do work", { hasUI: true, cwd: "/repo", ui: { notify } });

		expect(create).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledWith("/sumo:worktree requires a running herdr terminal host", "warning");
	});

	it("guards fresh and reopen sessions before touching worktrees", async () => {
		const noUi = makePi();
		const create = vi.fn();
		registerWorktreeCommand(asNever(noUi.pi), { create: asNever(create), terminalHost: makeTerminalHost() });

		await noUi.handler()?.("", { hasUI: false, cwd: "/repo", ui: { notify: vi.fn() } });

		expect(create).not.toHaveBeenCalled();
		expect(noUi.sendMessage).not.toHaveBeenCalled();

		const outsideHost = makePi();
		const list = vi.fn();
		const notify = vi.fn();
		registerWorktreeCommand(asNever(outsideHost.pi), { list: asNever(list), terminalHost: noneHost });

		await outsideHost.handler()?.("open sumo/one", { hasUI: true, cwd: "/repo", ui: { notify } });

		expect(list).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledWith("/sumo:worktree requires a running herdr terminal host", "warning");
	});

	it.each([
		["branch", "sumo/one"],
		["path", "/repo.wt/sumo__one"],
	])("reopens an existing sumo worktree by %s without creating", async (_label, target) => {
		const { pi, handler } = makePi();
		const create = vi.fn();
		const openSplit = makeSplitMock();
		const notify = vi.fn();
		registerWorktreeCommand(asNever(pi), {
			create: asNever(create),
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
		expect(openSplit.mock.calls[0]?.[2]).toContain("/repo.wt/sumo__one");
		expect(openSplit.mock.calls[0]?.[2]).toContain("pnpm install && exec sumocode");
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("reopened sumo/one in"), "info");
	});

	it("warns with available branches when a reopen target is unknown", async () => {
		const { pi, handler } = makePi();
		const notify = vi.fn();
		registerWorktreeCommand(asNever(pi), {
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
		registerWorktreeCommand(asNever(pi), { list: asNever(list), terminalHost: makeTerminalHost() });

		await handler()?.(args, { hasUI: true, cwd: "/repo", ui: { notify } });

		expect(list).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledWith("/sumo:worktree: --base is only valid for fresh or delegated worktrees", "warning");
	});

	it("lists sumo worktrees when prune has no target", async () => {
		const { pi, handler } = makePi();
		const notify = vi.fn();
		registerWorktreeCommand(asNever(pi), {
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
		registerWorktreeCommand(asNever(pi), {
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


describe("result command parsing", () => {
	it("parses result ids before the delegate fallback", () => {
		expect(parseWorktreeArgs("result sa-one")).toEqual({ mode: "result", value: "sa-one" });
		expect(parseWorktreeArgs("result")).toEqual({ mode: "result", value: "" });
		expect(parseWorktreeArgs("fix the result renderer")).toEqual({ mode: "delegate", value: "fix the result renderer" });
	});
});

function resultFixture() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "sumocode-result-command-")));
	const parent = join(root, "parent");
	const child = join(root, "child with spaces");
	mkdirSync(parent);
	const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
	git(parent, "init", "-b", "parent");
	git(parent, "config", "user.name", "fixture");
	git(parent, "config", "user.email", "fixture@example.test");
	writeFileSync(join(parent, "base.txt"), "base\n");
	git(parent, "add", ".");
	git(parent, "commit", "-m", "base");
	const base = git(parent, "rev-parse", "HEAD").trim();
	git(parent, "worktree", "add", "-b", "sumo/child", child, base);
	writeFileSync(join(child, "file.txt"), "child\n");
	git(child, "add", ".");
	git(child, "commit", "-m", "child");
	const head = git(child, "rev-parse", "HEAD").trim();
	const taskDir = join(root, "task");
	mkdirSync(taskDir, { mode: 0o700 });
	const registry = new SubagentRegistry(join(root, "registry"), "origin", { writerIdentity: { token: "fixture", pid: 101, processStartTime: "birth" }, inspectWriter: () => "alive" });
	const initial: SubagentRecord = { schemaVersion: 2, revision: 1, id: "sa-result", ownerSessionId: "origin", backend: "headless", status: "starting", taskDir,
		child: null, supervisor: null, pane: null, worktree: { path: child, repoRoot: parent, branch: "sumo/child", baseRef: base },
		sessionFilePath: null, modelLabel: null, roleId: null, createdAt: Date.now(), updatedAt: Date.now(), settledAt: null,
		completionId: null, outcome: null, delivery: { state: "none", claim: null }, result: null, manifest: null, writerLease: null, controlLease: null, controlHead: 0 };
	registry.create(initial);
	const held = registry.acquireWriter(initial.id, 1, 60_000);
	const artifacts = new RetainedResults(taskDir);
	artifacts.append({ kind: "run-started" });
	const result = artifacts.writeResult({ kind: "completed", finalText: "answer" });
	const manifest = artifacts.writeManifest({ baseRef: base, headRef: head, branch: "sumo/child", worktreePath: child,
		changedPaths: ["file.txt"], dirty: false, commits: 1, exit: "completed", durationMs: 1 });
	registry.transition(initial.id, held.revision, 1, (record) => ({ ...record, status: "settled", outcome: "completed", completionId: "completed-once",
		settledAt: Date.now(), result: result.pointer, manifest, delivery: { state: "undelivered" } }));
	const execute = vi.fn<GitExecutor>(async (file, args, options) => (await promisify(execFile)(file, [...args], options)).stdout);
	const { pi, handler } = makePi();
	const create = vi.fn();
	const query = vi.fn<typeof showDivineQuery>();
	const openSplit = makeSplitMock();
	const notify = vi.fn();
	registerWorktreeCommand(asNever(pi), { create, resolveResultRegistry: () => registry, query,
		dispositionOptions: { execute }, terminalHost: makeTerminalHost(openSplit), terminalSize: () => ({ columns: 160, rows: 45 }) });
	const run = (args = "result sa-result") => handler()!(args, { hasUI: true, cwd: parent, ui: { notify } });
	return { registry, root, parent, child, base, head, git, create, query, execute, openSplit, notify, run };
}

describe("worktree result actions", () => {
	it("result without an id or with an unknown id never delegates", async () => {
		const f = resultFixture();
		await f.run("result");
		await f.run("result sa-missing");
		expect(f.create).not.toHaveBeenCalled();
		expect(f.query).not.toHaveBeenCalled();
		expect(f.notify).toHaveBeenCalledWith(expect.stringContaining("result <id>"), "warning");
	});
	it("result menu cancellation has no Git mutation or review-state transition", async () => {
		const f = resultFixture();
		f.query.mockResolvedValue(undefined);
		await f.run();
		expect(f.create).not.toHaveBeenCalled();
		expect(f.registry.worktreeResult("sa-result")?.disposition).toBe("unreviewed");
		expect(f.execute.mock.calls.some(([, args]) => args.includes("cherry-pick") || args.includes("remove"))).toBe(false);
	});
	it("result inspect presents exact fresh commits and files and records inspection", async () => {
		const f = resultFixture();
		f.query.mockImplementation(async (_ctx, _title, options) => options.includes("inspect") ? "inspect" : "continue");
		await f.run();
		const shown = f.query.mock.calls.map(([, title]) => title).join("\n");
		expect(shown).toContain(f.head);
		expect(shown).toContain('touched "file.txt"');
		expect(f.registry.worktreeResult("sa-result")?.disposition).toBe("inspected");
		expect(f.execute.mock.calls.some(([, args]) => args.includes("cherry-pick") || args.includes("remove"))).toBe(false);
	});
	it.each([false, true])("result apply requires a separate confirmation (%s)", async (approved) => {
		const f = resultFixture();
		f.query.mockImplementation(async (_ctx, _title, options) => options.includes("apply") ? "apply"
			: options.includes("apply these commits") ? approved ? "apply these commits" : undefined : "continue");
		await f.run();
		const pick = f.execute.mock.calls.filter(([, args]) => args.includes("cherry-pick"));
		expect(pick).toHaveLength(approved ? 1 : 0);
		expect(f.git(f.parent, "rev-parse", "HEAD").trim()).toBe(f.base);
		expect(f.registry.worktreeResult("sa-result")?.disposition).toBe(approved ? "applied" : "inspected");
		const shown = f.query.mock.calls.map(([, title]) => title).join("\n");
		expect(shown).toContain(f.head);
		expect(shown).toContain('touched "file.txt"');
	});
	it("dismiss marks handled without touching the worktree", async () => {
		const f = resultFixture();
		f.query.mockResolvedValue("dismiss");
		await f.run();
		expect(f.registry.worktreeResult("sa-result")?.disposition).toBe("dismissed");
		expect(f.execute).not.toHaveBeenCalled();
		expect(existsSync(f.child)).toBe(true);
	});
	it.each([false, true])("result prune separately names and confirms the path and preserved branch (%s)", async (approved) => {
		const f = resultFixture();
		f.query.mockImplementation(async (_ctx, _title, options) => options.includes("prune") ? "prune"
			: options.includes("prune worktree") ? approved ? "prune worktree" : undefined : "continue");
		await f.run();
		expect(existsSync(f.child)).toBe(!approved);
		expect(f.git(f.parent, "show-ref", "--verify", "refs/heads/sumo/child")).toContain("sumo/child");
		const shown = f.query.mock.calls.map(([, title]) => title).join("\n");
		expect(shown).toContain(f.child);
		expect(shown).toContain("sumo/child");
		expect(f.registry.worktreeResult("sa-result")?.disposition).toBe(approved ? "pruned" : "inspected");
	});
	it("result open diff uses the terminal host only after the open choice", async () => {
		const f = resultFixture();
		f.query.mockResolvedValue("open diff");
		await f.run();
		expect(f.openSplit).toHaveBeenCalledOnce();
		expect(f.openSplit.mock.calls[0]?.[2]).toContain(f.base);
		expect(f.openSplit.mock.calls[0]?.[2]).toContain(f.head);
		expect(f.create).not.toHaveBeenCalled();
	});
});
