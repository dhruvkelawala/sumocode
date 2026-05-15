import { afterEach, describe, expect, it, vi } from "vitest";

import { buildHunkCommand, registerDiffCommand } from "./diff.js";

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
		expect(buildHunkCommand("show")).toBe("hunk show");
		expect(buildHunkCommand("show HEAD~1")).toBe("hunk show HEAD~1");
		expect(buildHunkCommand("patch -")).toBe("hunk patch -");
		expect(buildHunkCommand("pager")).toBe("hunk pager");
	});

	it("wraps unknown leading tokens as `hunk diff <args>` so common idioms work", () => {
		expect(buildHunkCommand("--watch")).toBe("hunk diff --watch");
		expect(buildHunkCommand("HEAD~1")).toBe("hunk diff HEAD~1");
		expect(buildHunkCommand("before.ts after.ts")).toBe("hunk diff before.ts after.ts");
	});

	it("preserves internal whitespace exactly as the user typed it", () => {
		// We only trim the outer whitespace; multi-space arg separators stay intact
		// because hunk's own argv parser handles them.
		expect(buildHunkCommand("show  HEAD~1")).toBe("hunk show  HEAD~1");
	});
});

describe("registerDiffCommand", () => {
	function makePi(execImpl: (cmd: string, args: string[]) => Promise<{ code: number; killed: boolean; stdout: string; stderr: string }>) {
		const handlers = new Map<string, (args: string | undefined, ctx: unknown) => Promise<void> | void>();
		const pi = {
			registerCommand: vi.fn((name: string, opts: { handler: typeof handlers extends Map<string, infer V> ? V : never }) => {
				handlers.set(name, opts.handler);
			}),
			exec: vi.fn(async (cmd: string, args: string[]) => execImpl(cmd, args)),
		};
		return { pi, handlers };
	}

	function makeCtx(notifyMock = vi.fn()) {
		const ctx = {
			hasUI: true,
			cwd: "/tmp/sumo-fixture",
			ui: { notify: notifyMock },
		};
		return { ctx, notifyMock };
	}

	it("registers the sumo:diff slash command on Pi", () => {
		const { pi } = makePi(async () => ({ code: 0, killed: false, stdout: "", stderr: "" }));
		registerDiffCommand(pi as never);
		expect(pi.registerCommand).toHaveBeenCalledWith(
			"sumo:diff",
			expect.objectContaining({ description: expect.stringContaining("hunk diff") }),
		);
	});

	it("notifies and exits when ctx.hasUI is false (e.g. RPC/print mode)", async () => {
		const { pi, handlers } = makePi(async () => ({ code: 0, killed: false, stdout: "", stderr: "" }));
		registerDiffCommand(pi as never);
		const handler = handlers.get("sumo:diff");
		expect(handler).toBeDefined();

		const notifyMock = vi.fn();
		const ctx = { hasUI: false, cwd: "/tmp", ui: { notify: notifyMock } };
		await handler?.(undefined, ctx);

		expect(notifyMock).toHaveBeenCalledWith("/sumo:diff requires interactive UI", "warning");
		// pi.exec should NOT have been called — we exit before trying to detect hunk.
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
		registerDiffCommand(pi as never);

		const { ctx, notifyMock } = makeCtx();
		await handlers.get("sumo:diff")?.("", ctx);

		expect(notifyMock).toHaveBeenCalledTimes(1);
		const [message, level] = notifyMock.mock.calls[0] ?? [];
		expect(message).toContain("hunkdiff");
		expect(message).toContain("npm i -g hunkdiff");
		expect(level).toBe("warning");
		// Importantly: no cmux calls when hunk is missing — we fail fast.
		expect(pi.exec).toHaveBeenCalledTimes(1);
		expect(pi.exec).toHaveBeenCalledWith(
			"sh",
			["-lc", "command -v hunk >/dev/null 2>&1"],
			{ timeout: 2_000 },
		);
	});

	it("swallows unexpected exceptions from cmux helpers and notifies the user instead of rejecting", async () => {
		// Simulate a pathological cmux exec that throws synchronously after
		// the hunk pre-flight has already passed. (`isHunkInstalled` swallows
		// its own exceptions and returns false, which is a separate code
		// path — we want to exercise the *outer* try/catch around the cmux
		// helpers and result handling.) The handler must not let the
		// exception escape; it must surface via ctx.ui.notify.
		const { pi, handlers } = makePi(async (cmd) => {
			if (cmd === "sh") {
				// hunk pre-flight: pretend hunk IS installed so we get past it.
				return { code: 0, killed: false, stdout: "", stderr: "" };
			}
			throw new Error("boom: cmux blew up");
		});
		registerDiffCommand(pi as never);

		const { ctx, notifyMock } = makeCtx();
		// Should not throw.
		await expect(handlers.get("sumo:diff")?.("", ctx)).resolves.toBeUndefined();

		expect(notifyMock).toHaveBeenCalledTimes(1);
		const [message, level] = notifyMock.mock.calls[0] ?? [];
		expect(message).toContain("boom: cmux blew up");
		expect(level).toBe("warning");
	});

	it("notifies with cmux error when not inside a cmux surface", async () => {
		// hunk-detection succeeds; `cmux --json identify` returns caller: null.
		const { pi, handlers } = makePi(async (cmd, args) => {
			if (cmd === "sh") return { code: 0, killed: false, stdout: "", stderr: "" };
			if (cmd === "cmux" && args[1] === "identify") {
				return { code: 0, killed: false, stdout: JSON.stringify({ caller: null }), stderr: "" };
			}
			return { code: 0, killed: false, stdout: "", stderr: "" };
		});
		registerDiffCommand(pi as never);

		const { ctx, notifyMock } = makeCtx();
		await handlers.get("sumo:diff")?.("", ctx);

		expect(notifyMock).toHaveBeenCalledTimes(1);
		const [message, level] = notifyMock.mock.calls[0] ?? [];
		expect(message).toContain("must be run from inside a cmux surface");
		expect(level).toBe("warning");
	});
});
