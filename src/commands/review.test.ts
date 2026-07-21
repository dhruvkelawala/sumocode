import { describe, expect, it, vi } from "vitest";
import { buildReviewPrompt, DEFAULT_REVIEW_MODEL, extractModelAlias, MODEL_ALIASES, parseReviewScope, registerReviewCommand, resolveReviewModel, reviewScopeLabel } from "./review.js";

describe("/sumo:review", () => {
	describe("resolveReviewModel", () => {
		it("uses gpt-5.3-codex by default", () => {
			expect(resolveReviewModel({})).toBe(DEFAULT_REVIEW_MODEL);
			expect(DEFAULT_REVIEW_MODEL).toBe("openai-codex/gpt-5.3-codex");
		});

		it("allows model override via SUMOCODE_REVIEW_MODEL", () => {
			expect(resolveReviewModel({ SUMOCODE_REVIEW_MODEL: "openai-codex/gpt-5.5" })).toBe("openai-codex/gpt-5.5");
		});
	});

	describe("extractModelAlias", () => {
		it("recognises codex alias", () => {
			expect(extractModelAlias("codex #42")).toEqual({ model: "openai-codex/gpt-5.3-codex", scopeArgs: "#42" });
		});

		it("recognises opus alias", () => {
			expect(extractModelAlias("opus")).toEqual({ model: "anthropic/claude-opus-4.6", scopeArgs: "" });
		});

		it("recognises sonnet alias", () => {
			expect(extractModelAlias("sonnet src/foo.ts")).toEqual({ model: "anthropic/claude-sonnet-4.6", scopeArgs: "src/foo.ts" });
		});

		it("is case-insensitive", () => {
			expect(extractModelAlias("OPUS #10")).toEqual({ model: "anthropic/claude-opus-4.6", scopeArgs: "#10" });
		});

		it("returns undefined model for non-alias first word", () => {
			expect(extractModelAlias("#42")).toEqual({ model: undefined, scopeArgs: "#42" });
			expect(extractModelAlias("")).toEqual({ model: undefined, scopeArgs: "" });
			expect(extractModelAlias("src/foo.ts")).toEqual({ model: undefined, scopeArgs: "src/foo.ts" });
		});

		it("deepseek alias resolves to default", () => {
			expect(extractModelAlias("deepseek")).toEqual({ model: MODEL_ALIASES.deepseek, scopeArgs: "" });
		});
	});

	describe("parseReviewScope", () => {
		it("returns working-tree for empty args", () => {
			expect(parseReviewScope("")).toEqual({ kind: "working-tree" });
			expect(parseReviewScope("   ")).toEqual({ kind: "working-tree" });
		});

		it("parses PR numbers with or without #", () => {
			expect(parseReviewScope("#51")).toEqual({ kind: "pr", number: "51" });
			expect(parseReviewScope("51")).toEqual({ kind: "pr", number: "51" });
			expect(parseReviewScope(" #209 ")).toEqual({ kind: "pr", number: "209" });
		});

		it("returns explicit for git ranges and paths", () => {
			expect(parseReviewScope("main...HEAD")).toEqual({ kind: "explicit", raw: "main...HEAD" });
			expect(parseReviewScope("origin/main...HEAD")).toEqual({ kind: "explicit", raw: "origin/main...HEAD" });
			expect(parseReviewScope("src/foo.ts")).toEqual({ kind: "explicit", raw: "src/foo.ts" });
		});
	});

	describe("reviewScopeLabel", () => {
		it("formats user-facing scope labels", () => {
			expect(reviewScopeLabel({ kind: "working-tree" })).toBe("branch diff");
			expect(reviewScopeLabel({ kind: "pr", number: "42" })).toBe("PR #42");
			expect(reviewScopeLabel({ kind: "explicit", raw: "src/foo.ts" })).toBe("src/foo.ts");
		});
	});

	describe("buildReviewPrompt", () => {
		it("working-tree: instructs scribe to fall back to branch diff when working tree is empty", () => {
			const prompt = buildReviewPrompt("", "deepseek/deepseek-v4-pro");
			expect(prompt).toContain("git diff origin/main...HEAD");
			expect(prompt).toContain("if `git diff HEAD` is empty");
			expect(prompt).toContain("do NOT return GREEN");
			expect(prompt).toContain("EMPTY");
		});

		it("pr: uses gh pr diff and gh pr view", () => {
			const prompt = buildReviewPrompt("#42", "deepseek/deepseek-v4-pro");
			expect(prompt).toContain("gh pr diff 42");
			expect(prompt).toContain("gh pr view 42");
			expect(prompt).toContain("PR #42");
		});

		it("explicit range: uses git diff with the raw range", () => {
			const prompt = buildReviewPrompt("main...HEAD", "deepseek/deepseek-v4-pro");
			expect(prompt).toContain("git diff main...HEAD");
		});

		it("is direct reviewer guidance for a tracked subagent", () => {
			const prompt = buildReviewPrompt("", "deepseek/deepseek-v4-pro");
			expect(prompt).toContain("tracked SumoCode subagent with model deepseek/deepseek-v4-pro");
			expect(prompt).toContain("Review only");
			expect(prompt).not.toContain("Main-agent protocol");
			expect(prompt).not.toContain("Use task type");
			expect(prompt).not.toContain("Relentlessly repeat review -> fix -> review");
		});

		it("includes P0/P1/P2 severity rubric", () => {
			const prompt = buildReviewPrompt("", "deepseek/deepseek-v4-pro");
			expect(prompt).toContain("P0: release blocker");
			expect(prompt).toContain("P1: must fix before merge");
			expect(prompt).toContain("P2: should fix before merge");
		});

		it("prohibits delegation and no longer instructs task-tool use", () => {
			const prompt = buildReviewPrompt("", "deepseek/deepseek-v4-pro");
			expect(prompt).toContain("Do NOT use the task tool");
			expect(prompt).toContain("Perform the entire review yourself");
			expect(prompt).not.toContain("Invoke the task tool");
			expect(prompt).not.toContain("Use task type=\"single\"");
		});

		it("includes DO NOT flag list to suppress noise", () => {
			const prompt = buildReviewPrompt("", "deepseek/deepseek-v4-pro");
			expect(prompt).toContain("DO NOT flag");
			expect(prompt).toContain("formatting");
			expect(prompt).toContain("Speculative");
		});

		it("requires per-finding reasoning trace", () => {
			const prompt = buildReviewPrompt("", "deepseek/deepseek-v4-pro");
			expect(prompt).toContain("Premise");
			expect(prompt).toContain("Execution path");
			expect(prompt).toContain("concrete execution path");
		});

		it("requires regression-contract checks for failure paths and state boundaries", () => {
			const prompt = buildReviewPrompt("", "deepseek/deepseek-v4-pro");
			expect(prompt).toContain("Regression-contract discipline");
			expect(prompt).toContain("compare the old and new success, failure, and no-op paths");
			expect(prompt).toContain("returns a result object such as `{ success, error }`");
			expect(prompt).toContain("internal state must not advance if the external operation failed");
			expect(prompt).toContain("known-input failure from a mocked dependency");
		});

		it("injects project context with build and test commands", () => {
			const prompt = buildReviewPrompt("", "deepseek/deepseek-v4-pro");
			expect(prompt).toContain("pnpm exec tsc --noEmit");
			expect(prompt).toContain("pnpm vitest run");
			expect(prompt).toContain("pnpm build");
			expect(prompt).toContain("TypeScript");
		});

		it("instructs scribe to read enclosing functions, not just diff hunks", () => {
			const prompt = buildReviewPrompt("", "deepseek/deepseek-v4-pro");
			expect(prompt).toContain("full enclosing function body");
		});

		it("omit-empty-sections rule prevents filler", () => {
			const prompt = buildReviewPrompt("", "deepseek/deepseek-v4-pro");
			expect(prompt).toContain("Omit any severity level you have no finding for");
		});
	});

	describe("registerReviewCommand", () => {
		const snapshot = (overrides: Record<string, unknown> = {}) => ({
			id: "sa-42",
			title: "review: branch diff",
			prompt: "review",
			cwd: "/tmp/sumo-fixture",
			baseRef: "HEAD",
			visible: true,
			pane: { agentName: "review", paneId: "pane:2", workspaceId: "workspace:1" },
			status: "running",
			createdAt: 1,
			usage: { turns: 0 },
			transcript: [],
			liveText: "",
			liveTools: [],
			finalText: "",
			...overrides,
		});

		function setup(subagentSpawner = { spawn: vi.fn().mockResolvedValue(snapshot()) }) {
			let handler: ((args: string, ctx: { hasUI: boolean; cwd: string; ui: { notify: ReturnType<typeof vi.fn> } }) => Promise<void>) | undefined;
			const sendUserMessage = vi.fn();
			const registerCommand = vi.fn((_name: string, options: { handler: typeof handler }) => {
				handler = options.handler;
			});
			const notify = vi.fn();
			const getActiveTools = vi.fn(() => ["read", "bash", "edit", "write", "grep", "find", "ls"]);
			registerReviewCommand({ registerCommand, sendUserMessage, getActiveTools } as never, { subagentSpawner: subagentSpawner as never });
			const ctx = { hasUI: true, cwd: "/tmp/sumo-fixture", ui: { notify } };
			return { handler, registerCommand, sendUserMessage, notify, subagentSpawner, ctx };
		}

		it("registers a command that spawns a tracked visible subagent review", async () => {
			const { handler, registerCommand, sendUserMessage, notify, subagentSpawner, ctx } = setup();

			await handler?.("src/foo.ts", ctx);

			expect(registerCommand).toHaveBeenCalledWith("sumo:review", expect.objectContaining({ description: expect.stringContaining("subagent") }));
			expect(sendUserMessage).not.toHaveBeenCalled();
			expect(subagentSpawner.spawn).toHaveBeenCalledWith({
				prompt: expect.stringContaining("git diff src/foo.ts"),
				cwd: "/tmp/sumo-fixture",
				title: "review: src/foo.ts · openai-codex/gpt-5.3-codex",
				visible: true,
				model: "openai-codex/gpt-5.3-codex",
				thinking: "xhigh",
				// Parent tool allowlist forwarded so a narrowed session narrows the reviewer.
				builtInTools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
			});
			expect(notify).toHaveBeenCalledWith(expect.stringContaining("review started: sa-42"), "info");
			expect(notify).toHaveBeenCalledWith(expect.stringContaining("watchable herdr pane"), "info");
			expect(notify).toHaveBeenCalledWith(expect.stringContaining("result will arrive as a card automatically"), "info");
			expect(notify.mock.calls.flat().join(" ")).not.toContain(["bg", "task"].join("_"));
		});

		it("forwards a narrowed parent tool allowlist to the reviewer", async () => {
			const subagentSpawner = { spawn: vi.fn().mockResolvedValue(snapshot()) };
			let handler: ((args: string, ctx: { hasUI: boolean; cwd: string; ui: { notify: ReturnType<typeof vi.fn> } }) => Promise<void>) | undefined;
			const registerCommand = vi.fn((_name: string, options: { handler: typeof handler }) => { handler = options.handler; });
			const getActiveTools = vi.fn(() => ["read", "grep"]);
			registerReviewCommand({ registerCommand, sendUserMessage: vi.fn(), getActiveTools } as never, { subagentSpawner: subagentSpawner as never });
			await handler?.("src/foo.ts", { hasUI: true, cwd: "/tmp/sumo-fixture", ui: { notify: vi.fn() } });
			expect(subagentSpawner.spawn).toHaveBeenCalledWith(expect.objectContaining({ builtInTools: ["read", "grep"] }));
		});

		it("includes scope label in the subagent title and notice for PR args", async () => {
			const { handler, notify, subagentSpawner, ctx } = setup();

			await handler?.("#42", ctx);

			expect(subagentSpawner.spawn).toHaveBeenCalledWith(expect.objectContaining({
				prompt: expect.stringContaining("gh pr diff 42"),
				title: "review: PR #42 · openai-codex/gpt-5.3-codex",
			}));
			expect(notify).toHaveBeenCalledWith(expect.stringContaining("PR #42"), "info");
		});

		it("uses alias model when provided as first arg", async () => {
			const { handler, notify, subagentSpawner, ctx } = setup();

			await handler?.("opus #42", ctx);

			expect(subagentSpawner.spawn).toHaveBeenCalledWith(expect.objectContaining({
				prompt: expect.stringContaining("anthropic/claude-opus-4.6"),
				model: "anthropic/claude-opus-4.6",
				title: "review: PR #42 · anthropic/claude-opus-4.6",
			}));
			expect(notify).toHaveBeenCalledWith(expect.stringContaining("anthropic/claude-opus-4.6"), "info");
		});

		it("reports cooperative backpressure when the subagent manager is at capacity", async () => {
			const atCapacitySpawner = { spawn: vi.fn().mockResolvedValue({
				status: "at_capacity",
				capacity: 4,
				runningCount: 4,
				running: [],
				retryHint: "wait for a running subagent to settle, then retry subagent_spawn",
			}) };
			const { handler, notify, ctx } = setup(atCapacitySpawner);

			await handler?.("", ctx);

			expect(notify).toHaveBeenCalledWith(expect.stringContaining("at capacity (4/4)"), "warning");
			expect(notify).toHaveBeenCalledWith(expect.stringContaining("retry subagent_spawn"), "warning");
		});

		it("reports a clear warning when the subagent fails to start", async () => {
			const failingSpawner = { spawn: vi.fn().mockResolvedValue(snapshot({ status: "error", errorText: "herdr unavailable" })) };
			const { handler, notify, ctx } = setup(failingSpawner);

			await handler?.("", ctx);

			expect(notify).toHaveBeenCalledWith("/sumo:review failed to start subagent: herdr unavailable", "warning");
		});

		it("does not fall back to queuing a main-agent prompt when the subagent manager is unavailable", async () => {
			let handler: ((args: string, ctx: { hasUI: boolean; cwd: string; ui: { notify: ReturnType<typeof vi.fn> } }) => Promise<void>) | undefined;
			const sendUserMessage = vi.fn();
			const registerCommand = vi.fn((_name: string, options: { handler: typeof handler }) => {
				handler = options.handler;
			});
			const notify = vi.fn();
			registerReviewCommand({ registerCommand, sendUserMessage } as never);

			await handler?.("", { hasUI: true, cwd: "/tmp/sumo-fixture", ui: { notify } });

			expect(sendUserMessage).not.toHaveBeenCalled();
			expect(notify).toHaveBeenCalledWith("/sumo:review cannot start: subagent manager is not available", "warning");
		});
	});
});
