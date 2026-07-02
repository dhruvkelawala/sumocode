import { describe, expect, it, vi } from "vitest";
import sumocode, {
	findActiveSumoDevTree,
	isInstalledPiAgentGitModule,
	isRpcChildProfile,
	isTaskMode,
	shouldInstallNativeTaskTool,
	shouldNoopDuplicateInstalledExtension,
	shouldNoopHelperSubprocess,
} from "./extension.js";

type Handler = (...args: unknown[]) => unknown;

function buildPiStub() {
	const handlers = new Map<string, Handler[]>();

	const pi = {
		on: vi.fn((event: string, handler: Handler) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		}),
		registerCommand: vi.fn(),
		registerShortcut: vi.fn(),
		registerTool: vi.fn(),
		registerProvider: vi.fn(),
		registerMessageRenderer: vi.fn(),
		sendMessage: vi.fn(),
	};

	return { pi, handlers };
}

function buildCtxStub() {
	return {
		hasUI: true,
		cwd: "/tmp",
		sessionManager: { getBranch: () => [] },
		getContextUsage: () => undefined,
		model: undefined,
		ui: {
			notify: vi.fn(),
			custom: vi.fn(() => Promise.resolve()),
			setFooter: vi.fn(),
			setHeader: vi.fn(),
			setWidget: vi.fn(),
			setEditorComponent: vi.fn(),
			setWorkingIndicator: vi.fn(),
		},
	};
}

describe("duplicate installed extension guard", () => {
	const files = new Set([
		"/repo/sumocode/package.json",
		"/repo/sumocode/src/extension.ts",
		"/repo/sumocode/.git",
	]);
	const exists = (path: string): boolean => files.has(path);
	const readFile = (path: string): string => {
		if (path === "/repo/sumocode/package.json") return JSON.stringify({ name: "@dhruvkelawala/sumocode" });
		throw new Error(`unexpected read ${path}`);
	};

	it("detects Pi-installed copies under ~/.pi/agent/git", () => {
		expect(isInstalledPiAgentGitModule("file:///Users/dev/.pi/agent/git/github.com/dhruvkelawala/sumocode/src/extension.ts", "/Users/dev")).toBe(true);
		expect(isInstalledPiAgentGitModule("file:///repo/sumocode/src/extension.ts", "/Users/dev")).toBe(false);
	});

	it("finds an active SumoCode dev tree from nested cwd", () => {
		expect(findActiveSumoDevTree("/repo/sumocode/src", { exists, readFile })).toBe("/repo/sumocode");
		expect(findActiveSumoDevTree("/repo/other", { exists, readFile })).toBeUndefined();
	});

	it("noops only the installed copy when cwd is already a dev checkout", () => {
		expect(
			shouldNoopDuplicateInstalledExtension({
				moduleUrl: "file:///Users/dev/.pi/agent/git/github.com/dhruvkelawala/sumocode/src/extension.ts",
				homeDir: "/Users/dev",
				cwd: "/repo/sumocode",
				exists,
				readFile,
			}),
		).toBe(true);
		expect(
			shouldNoopDuplicateInstalledExtension({
				moduleUrl: "file:///repo/sumocode/src/extension.ts",
				homeDir: "/Users/dev",
				cwd: "/repo/sumocode",
				exists,
				readFile,
			}),
		).toBe(false);
	});

	it("noops the installed copy when SUMOCODE_LAUNCHER is set even if cwd is not the dev tree", () => {
		const prev = process.env.SUMOCODE_LAUNCHER;
		process.env.SUMOCODE_LAUNCHER = "/Users/dev/development/sumocode/bin/sumocode.sh";
		try {
			expect(
				shouldNoopDuplicateInstalledExtension({
					moduleUrl: "file:///Users/dev/.pi/agent/git/github.com/dhruvkelawala/sumocode/src/extension.ts",
					homeDir: "/Users/dev",
					cwd: "/some/other/project",
					exists: () => false,
					readFile: () => "",
				}),
			).toBe(true);
		} finally {
			if (prev === undefined) delete process.env.SUMOCODE_LAUNCHER;
			else process.env.SUMOCODE_LAUNCHER = prev;
		}
	});
});

describe("task mode", () => {
	it("detects SUMOCODE_TASK_MODE=1 as task mode", () => {
		expect(isTaskMode({ env: { SUMOCODE_TASK_MODE: "1" } })).toBe(true);
	});

	it("is false when SUMOCODE_TASK_MODE is unset or any other value", () => {
		expect(isTaskMode({ env: {} })).toBe(false);
		expect(isTaskMode({ env: { SUMOCODE_TASK_MODE: "0" } })).toBe(false);
		expect(isTaskMode({ env: { SUMOCODE_TASK_MODE: "true" } })).toBe(false);
	});
});

describe("rpc child profile", () => {
	it("detects SUMOCODE_RPC_CHILD=1 as the rpc child profile", () => {
		expect(isRpcChildProfile({ env: { SUMOCODE_RPC_CHILD: "1" } })).toBe(true);
		expect(isRpcChildProfile({ env: {} })).toBe(false);
		expect(isRpcChildProfile({ env: { SUMOCODE_RPC_CHILD: "0" } })).toBe(false);
	});

	it("keeps tools and commands but skips retained chrome and the custom approval gate", async () => {
		const previousRpc = process.env.SUMOCODE_RPC_CHILD;
		const previousTask = process.env.SUMOCODE_NATIVE_TASK;
		process.env.SUMOCODE_RPC_CHILD = "1";
		process.env.SUMOCODE_NATIVE_TASK = "1";
		try {
			const { pi, handlers } = buildPiStub();
			sumocode(pi as never);

			const commandNames = pi.registerCommand.mock.calls.map((call) => call[0]);
			const toolNames = pi.registerTool.mock.calls.map((call) => (call[0] as { name: string }).name);
			const eventNames = pi.on.mock.calls.map((call) => call[0]);
			expect(commandNames).toContain("sumo:review");
			expect(commandNames).toContain("sumo:ship");
			expect(toolNames).toContain("task");
			expect(toolNames).toContain("question");
			expect(eventNames).not.toContain("tool_call");

			const ctx = buildCtxStub();
			for (const handler of handlers.get("session_start") ?? []) {
				await handler({ type: "session_start" }, ctx as never);
			}

			expect(ctx.ui.setFooter).not.toHaveBeenCalled();
			expect(ctx.ui.setHeader).not.toHaveBeenCalled();
			expect(ctx.ui.setEditorComponent).not.toHaveBeenCalled();
			expect(ctx.ui.setWorkingIndicator).not.toHaveBeenCalled();
			expect(ctx.ui.setWidget).not.toHaveBeenCalled();
		} finally {
			if (previousRpc === undefined) delete process.env.SUMOCODE_RPC_CHILD;
			else process.env.SUMOCODE_RPC_CHILD = previousRpc;
			if (previousTask === undefined) delete process.env.SUMOCODE_NATIVE_TASK;
			else process.env.SUMOCODE_NATIVE_TASK = previousTask;
		}
	});
});

describe("helper subprocess guard", () => {
	it("bails when PI_CMUX_CHILD=1 (pi-cmux helper subprocess)", () => {
		expect(shouldNoopHelperSubprocess({ env: { PI_CMUX_CHILD: "1" } })).toBe(true);
	});

	it("bails when SUMOCODE_BG_CHILD=1 (nested under a SumoCode shell task)", () => {
		expect(shouldNoopHelperSubprocess({ env: { SUMOCODE_BG_CHILD: "1" } })).toBe(true);
	});

	it("does not bail when neither env var is set", () => {
		expect(shouldNoopHelperSubprocess({ env: {} })).toBe(false);
		expect(shouldNoopHelperSubprocess({ env: { PI_CMUX_CHILD: "0" } })).toBe(false);
	});

	it("skips installation entirely when PI_CMUX_CHILD is set", () => {
		const prev = process.env.PI_CMUX_CHILD;
		process.env.PI_CMUX_CHILD = "1";
		try {
			const { pi } = buildPiStub();
			sumocode(pi as never);
			expect(pi.registerTool).not.toHaveBeenCalled();
			expect(pi.registerCommand).not.toHaveBeenCalled();
			expect(pi.on).not.toHaveBeenCalled();
		} finally {
			if (prev === undefined) delete process.env.PI_CMUX_CHILD;
			else process.env.PI_CMUX_CHILD = prev;
		}
	});
});

describe("sumocode extension", () => {
	it("detects whether native task can install without conflicting with the legacy task extension", () => {
		expect(shouldInstallNativeTaskTool({ homeDir: "/home/user", exists: () => false })).toBe(true);
		expect(shouldInstallNativeTaskTool({ homeDir: "/home/user", exists: () => true })).toBe(false);
		expect(shouldInstallNativeTaskTool({ homeDir: "/home/user", exists: () => true, force: "1" })).toBe(true);
	});

	it("registers a native task tool when forced", () => {
		const previous = process.env.SUMOCODE_NATIVE_TASK;
		process.env.SUMOCODE_NATIVE_TASK = "1";
		try {
			const { pi } = buildPiStub();

			sumocode(pi as never);

			const toolNames = pi.registerTool.mock.calls.map((call) => (call[0] as { name: string }).name);
			expect(toolNames).toContain("task");
		} finally {
			if (previous === undefined) delete process.env.SUMOCODE_NATIVE_TASK;
			else process.env.SUMOCODE_NATIVE_TASK = previous;
		}
	});

	it("registers the v0.4 slash commands during full extension install", () => {
		const { pi } = buildPiStub();

		sumocode(pi as never);

		const commandNames = pi.registerCommand.mock.calls.map((call) => call[0]);
		expect(commandNames).toContain("sumo:review");
		expect(commandNames).toContain("sumo:ship");
		expect(commandNames).toContain("sumo:worktree");
	});

	it("does not push a 'SumoCode loaded' notification on session_start", () => {
		const { pi, handlers } = buildPiStub();

		sumocode(pi as never);

		const ctx = buildCtxStub();
		const sessionStart = handlers.get("session_start") ?? [];
		for (const handler of sessionStart) {
			handler({ type: "session_start" }, ctx as never);
		}

		expect(ctx.ui.notify).not.toHaveBeenCalled();
	});
});
