import { describe, expect, it, vi } from "vitest";
import sumocode, {
	findActiveSumoDevTree,
	isInstalledPiAgentGitModule,
	shouldNoopDuplicateInstalledExtension,
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
		expect(isInstalledPiAgentGitModule("file:///Users/dhruv/.pi/agent/git/github.com/dhruvkelawala/sumocode/src/extension.ts", "/Users/dhruv")).toBe(true);
		expect(isInstalledPiAgentGitModule("file:///repo/sumocode/src/extension.ts", "/Users/dhruv")).toBe(false);
	});

	it("finds an active SumoCode dev tree from nested cwd", () => {
		expect(findActiveSumoDevTree("/repo/sumocode/src", { exists, readFile })).toBe("/repo/sumocode");
		expect(findActiveSumoDevTree("/repo/other", { exists, readFile })).toBeUndefined();
	});

	it("noops only the installed copy when cwd is already a dev checkout", () => {
		expect(
			shouldNoopDuplicateInstalledExtension({
				moduleUrl: "file:///Users/dhruv/.pi/agent/git/github.com/dhruvkelawala/sumocode/src/extension.ts",
				homeDir: "/Users/dhruv",
				cwd: "/repo/sumocode",
				exists,
				readFile,
			}),
		).toBe(true);
		expect(
			shouldNoopDuplicateInstalledExtension({
				moduleUrl: "file:///repo/sumocode/src/extension.ts",
				homeDir: "/Users/dhruv",
				cwd: "/repo/sumocode",
				exists,
				readFile,
			}),
		).toBe(false);
	});
});

describe("sumocode extension", () => {
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
