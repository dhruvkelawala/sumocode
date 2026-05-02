import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	getGitBranch,
	getSessionUsage,
	invalidateGitBranch,
	invalidateSessionUsage,
	noteSessionMessage,
	resetLiveSessionHasMessages,
	refreshGitBranchAsync,
	refreshGitBranchSync,
	sessionHasMessages,
} from "./session-cache.js";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

type Branch = ReturnType<ExtensionContext["sessionManager"]["getBranch"]>;

function makeCtx(branch: ReadonlyArray<unknown> = [], cwd = "/tmp"): ExtensionContext {
	return {
		cwd,
		sessionManager: {
			getBranch: vi.fn(() => branch as Branch),
		} as unknown as ExtensionContext["sessionManager"],
	} as unknown as ExtensionContext;
}

function assistantEntry(input: number, output: number, costTotal: number) {
	return {
		type: "message",
		message: {
			role: "assistant",
			usage: { input, output, cost: { total: costTotal } },
		},
	};
}

describe("session-cache.getSessionUsage", () => {
	beforeEach(() => { resetLiveSessionHasMessages(); });

	it("sums tokens across assistant entries and reports hasMessages", () => {
		const ctx = makeCtx([
			assistantEntry(100, 50, 0.01),
			{ type: "message", message: { role: "user" } },
			assistantEntry(200, 25, 0.02),
		]);

		expect(getSessionUsage(ctx)).toEqual({ input: 300, output: 75, cost: 0.03, hasMessages: true });
	});

	it("returns zeros and hasMessages=false on empty branches", () => {
		const ctx = makeCtx([]);
		expect(getSessionUsage(ctx)).toEqual({ input: 0, output: 0, cost: 0, hasMessages: false });
		expect(sessionHasMessages(ctx)).toBe(false);
	});

	it("does not re-walk the branch on subsequent calls within the same context", () => {
		const branch = [assistantEntry(10, 5, 0.001)];
		const ctx = makeCtx(branch);
		const spy = ctx.sessionManager.getBranch as unknown as ReturnType<typeof vi.fn>;

		getSessionUsage(ctx);
		getSessionUsage(ctx);
		getSessionUsage(ctx);
		sessionHasMessages(ctx);

		expect(spy).toHaveBeenCalledTimes(1);
	});

	it("re-walks after invalidateSessionUsage", () => {
		const ctx = makeCtx([assistantEntry(10, 5, 0.001)]);
		const spy = ctx.sessionManager.getBranch as unknown as ReturnType<typeof vi.fn>;

		getSessionUsage(ctx);
		invalidateSessionUsage(ctx);
		getSessionUsage(ctx);

		expect(spy).toHaveBeenCalledTimes(2);
	});

	it("optimistically marks live sessions as having messages via module-level flag", () => {
		const ctx = makeCtx([]);

		// Reset: simulate a fresh session_start resetting the flag
		noteSessionMessage(); // call without ctx — module-level
		expect(sessionHasMessages(ctx)).toBe(true);
	});

	it("module-level flag survives subsequent invalidateSessionUsage calls", () => {
		const ctx = makeCtx([]);

		noteSessionMessage();
		// Simulate message_end / agent_end invalidating usage cache
		invalidateSessionUsage(ctx);
		invalidateSessionUsage(ctx);

		// Even though getBranch() is empty, hasMessages stays true
		expect(sessionHasMessages(ctx)).toBe(true);
	});
});

describe("session-cache git branch", () => {
	it("getGitBranch returns null until refreshed", () => {
		const ctx = makeCtx([], "/tmp/proj");
		expect(getGitBranch(ctx)).toBeNull();
	});

	it("refreshGitBranchSync writes the value into the cache", () => {
		const ctx = makeCtx([], "/tmp/proj");
		const runner = vi.fn(() => "main\n");

		expect(refreshGitBranchSync(ctx, runner)).toBe("main");
		expect(getGitBranch(ctx)).toBe("main");
		expect(runner).toHaveBeenCalledTimes(1);
		expect(runner).toHaveBeenCalledWith(["symbolic-ref", "--quiet", "--short", "HEAD"], "/tmp/proj");
	});

	it("falls back to detached on symbolic-ref failure (sync)", () => {
		const ctx = makeCtx([], "/tmp/proj");
		const runner = vi.fn((args: string[]) => {
			if (args[0] === "symbolic-ref") throw new Error("not on a branch");
			return "abc1234\n";
		});

		expect(refreshGitBranchSync(ctx, runner)).toBe("detached");
	});

	it("returns null when both git invocations fail (sync)", () => {
		const ctx = makeCtx([], "/tmp/proj");
		const runner = vi.fn(() => {
			throw new Error("not a git repo");
		});

		expect(refreshGitBranchSync(ctx, runner)).toBeNull();
	});

	it("invalidateGitBranch clears the cached value", () => {
		const ctx = makeCtx([], "/tmp/proj");
		const runner = vi.fn(() => "feat/x\n");

		refreshGitBranchSync(ctx, runner);
		expect(getGitBranch(ctx)).toBe("feat/x");

		invalidateGitBranch(ctx);
		expect(getGitBranch(ctx)).toBeNull();
	});

	it("refreshGitBranchAsync updates the cache without blocking the read path", async () => {
		const ctx = makeCtx([], "/tmp/proj");
		refreshGitBranchSync(ctx, () => "main\n");
		expect(getGitBranch(ctx)).toBe("main");

		let resolveAsync: ((value: string) => void) | undefined;
		const asyncRunner = vi.fn(() => new Promise<string>((res) => {
			resolveAsync = res;
		}));

		const pending = refreshGitBranchAsync(ctx, asyncRunner);

		// While the async runner is still pending, getGitBranch must return the
		// previously cached value — not block, not return null.
		expect(getGitBranch(ctx)).toBe("main");
		expect(asyncRunner).toHaveBeenCalledTimes(1);

		resolveAsync?.("feat/y\n");
		await pending;

		expect(getGitBranch(ctx)).toBe("feat/y");
	});

	it("refreshGitBranchAsync coalesces concurrent calls", async () => {
		const ctx = makeCtx([], "/tmp/proj");
		const asyncRunner = vi.fn(() => Promise.resolve("main\n"));

		const a = refreshGitBranchAsync(ctx, asyncRunner);
		const b = refreshGitBranchAsync(ctx, asyncRunner);
		await Promise.all([a, b]);

		expect(asyncRunner).toHaveBeenCalledTimes(1);
	});
});
