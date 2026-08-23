import { afterEach, describe, expect, it, vi } from "vitest";

import { buildHunkCommand, chooseDiffSplitDirection, parseDiffArgs, registerDiffCommand } from "./diff.js";
import type { SplitDirection, TerminalHost } from "../terminal-host/index.js";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("buildHunkCommand", () => {
	it("defaults to `hunk diff` on empty args", () => {
		expect(buildHunkCommand("")).toBe("hunk diff");
		expect(buildHunkCommand("   ")).toBe("hunk diff");
	});

	it("passes through known subcommands verbatim", () => {
		expect(buildHunkCommand("diff")).toBe("hunk diff");
		expect(buildHunkCommand("show HEAD~1")).toBe("hunk show HEAD~1");
		expect(buildHunkCommand("patch -")).toBe("hunk patch -");
		expect(buildHunkCommand("pager")).toBe("hunk pager");
	});

	it("wraps unknown leading tokens as `hunk diff <args>`", () => {
		expect(buildHunkCommand("--watch")).toBe("hunk diff --watch");
		expect(buildHunkCommand("HEAD~1")).toBe("hunk diff HEAD~1");
		expect(buildHunkCommand("before.ts after.ts")).toBe("hunk diff before.ts after.ts");
	});

	it("preserves internal whitespace", () => {
		expect(buildHunkCommand("show  HEAD~1")).toBe("hunk show  HEAD~1");
	});
});

describe("parseDiffArgs", () => {
	it("extracts split override flags without treating them as hunk args", () => {
		expect(parseDiffArgs("--down")).toEqual({ hunkArgs: "", forcedDirection: "down" });
		expect(parseDiffArgs("--right show HEAD~1")).toEqual({ hunkArgs: "show HEAD~1", forcedDirection: "right" });
		expect(parseDiffArgs("show --down HEAD~1")).toEqual({ hunkArgs: "show  HEAD~1", forcedDirection: "down" });
	});

	it("uses the last split override when both are present", () => {
		expect(parseDiffArgs("--down --right HEAD~1")).toEqual({ hunkArgs: "HEAD~1", forcedDirection: "right" });
	});
});

describe("chooseDiffSplitDirection", () => {
	it("uses down for portrait terminals and right for landscape or square terminals", () => {
		expect(chooseDiffSplitDirection({ columns: 80, rows: 120 })).toBe("down");
		expect(chooseDiffSplitDirection({ columns: 160, rows: 45 })).toBe("right");
		expect(chooseDiffSplitDirection({ columns: 80, rows: 80 })).toBe("right");
	});

	it("lets explicit flags override terminal orientation", () => {
		expect(chooseDiffSplitDirection({ columns: 80, rows: 120 }, "right")).toBe("right");
		expect(chooseDiffSplitDirection({ columns: 160, rows: 45 }, "down")).toBe("down");
	});
});

describe("registerDiffCommand", () => {
	function makeFakeHost(kind: TerminalHost["kind"], openCommandInSplit?: TerminalHost["openCommandInSplit"]): TerminalHost {
		const defaultOpenCommandInSplit: TerminalHost["openCommandInSplit"] = vi.fn(async () => ({
			ok: true as const,
			pane: { host: "herdr" as const, paneId: "pane:fake" },
		}));
		return {
			kind,
			openCommandInSplit: openCommandInSplit ?? defaultOpenCommandInSplit,
			closePane: vi.fn(async () => ({ ok: true as const })),
			notify: vi.fn(async () => undefined),
		};
	}

	function makePi(execImpl: (cmd: string, args: string[]) => Promise<{ code: number; killed: boolean; stdout: string; stderr: string }>) {
		const handlers = new Map<string, (args: string | undefined, ctx: { hasUI: boolean; cwd?: string; ui?: { notify?: (...args: unknown[]) => void } }) => Promise<void> | void>();
		const pi = {
			registerCommand: vi.fn((name: string, opts: { handler: typeof handlers extends Map<string, infer V> ? V : never }) => {
				handlers.set(name, opts.handler);
			}),
			exec: vi.fn(async (cmd: string, args: string[]) => execImpl(cmd, args)),
		};
		return { pi, handlers };
	}

	function makeCtx(notifyMock = vi.fn()) {
		return {
			ctx: { hasUI: true, cwd: "/tmp/sumo-fixture", ui: { notify: notifyMock } },
			notifyMock,
		};
	}

	it("registers the sumo:diff slash command on Pi", () => {
		const { pi } = makePi(async () => ({ code: 0, killed: false, stdout: "", stderr: "" }));
		// SAFETY: test double only exercises the members this test asserts on.
		registerDiffCommand(pi as never);
		expect(pi.registerCommand).toHaveBeenCalledWith("sumo:diff", expect.objectContaining({ description: expect.stringContaining("hunk diff") }));
	});

	it("notifies and exits when ctx.hasUI is false", async () => {
		const { pi, handlers } = makePi(async () => ({ code: 0, killed: false, stdout: "", stderr: "" }));
		// SAFETY: test double only exercises the members this test asserts on.
		registerDiffCommand(pi as never);
		const notifyMock = vi.fn();
		await handlers.get("sumo:diff")?.(undefined, { hasUI: false, cwd: "/tmp", ui: { notify: notifyMock } });

		expect(notifyMock).toHaveBeenCalledWith("/sumo:diff requires interactive UI", "warning");
		expect(pi.exec).not.toHaveBeenCalled();
	});

	it("notifies with install hint when hunkdiff is not on PATH", async () => {
		// `command -v hunk` returns non-zero when hunk is missing.
		const { pi, handlers } = makePi(async (cmd, args) => {
			if (cmd === "sh" && args.join(" ").includes("command -v hunk")) {
				return { code: 1, killed: false, stdout: "", stderr: "" };
			}
			return { code: 0, killed: false, stdout: "", stderr: "" };
		});
		// SAFETY: test double only exercises the members this test asserts on.
		registerDiffCommand(pi as never);
		const { ctx, notifyMock } = makeCtx();
		await handlers.get("sumo:diff")?.("", ctx);

		expect(notifyMock).toHaveBeenCalledWith(expect.stringContaining("npm i -g hunkdiff"), "warning");
		expect(pi.exec).toHaveBeenCalledTimes(1);
	});

	it("surfaces unexpected terminal-host exceptions", async () => {
		const { pi, handlers } = makePi(async () => ({ code: 0, killed: false, stdout: "", stderr: "" }));
		const openCommandInSplit: TerminalHost["openCommandInSplit"] = vi.fn(async () => { throw new Error("terminal host failed"); });
		// SAFETY: test double only exercises the members this test asserts on.
		registerDiffCommand(pi as never, { terminalHost: makeFakeHost("herdr", openCommandInSplit) });
		const { ctx, notifyMock } = makeCtx();

		await expect(handlers.get("sumo:diff")?.("", ctx)).resolves.toBeUndefined();
		expect(notifyMock).toHaveBeenCalledWith("/sumo:diff: terminal host failed", "warning");
	});

	it("opens a herdr split with the chosen direction and filtered arguments", async () => {
		const openCommandInSplit = vi.fn<TerminalHost["openCommandInSplit"]>(async () => ({ ok: true as const, pane: { host: "herdr" as const, paneId: "pane:1" } }));
		const { pi, handlers } = makePi(async () => ({ code: 0, killed: false, stdout: "", stderr: "" }));
		// SAFETY: test double only exercises the members this test asserts on.
		registerDiffCommand(pi as never, {
			terminalHost: makeFakeHost("herdr", openCommandInSplit),
			terminalSize: () => ({ columns: 80, rows: 120 }),
		});
		const { ctx, notifyMock } = makeCtx();

		await handlers.get("sumo:diff")?.("--right --watch", ctx);

		expect(openCommandInSplit).toHaveBeenCalledWith(pi, "right" satisfies SplitDirection, expect.objectContaining({ cwd: "/tmp/sumo-fixture" }));
		expect(openCommandInSplit.mock.calls[0]?.[2]?.shellCommand).toContain("hunk diff --watch");
		expect(openCommandInSplit.mock.calls[0]?.[2]?.shellCommand).not.toContain("--right");
		expect(notifyMock).toHaveBeenCalledWith("opened hunk diff --watch in a new herdr pane", "info");
	});

	it("reports the no-host requirement", async () => {
		const { pi, handlers } = makePi(async () => ({ code: 0, killed: false, stdout: "", stderr: "" }));
		// SAFETY: test double only exercises the members this test asserts on.
		registerDiffCommand(pi as never, {
			terminalHost: makeFakeHost("none", vi.fn<TerminalHost["openCommandInSplit"]>(async () => ({ ok: false as const, error: "requires a running herdr terminal host" }))),
		});
		const { ctx, notifyMock } = makeCtx();

		await handlers.get("sumo:diff")?.("", ctx);

		expect(notifyMock).toHaveBeenCalledWith("/sumo:diff: requires a running herdr terminal host", "warning");
		expect(pi.exec).toHaveBeenCalledTimes(1);
	});
});
