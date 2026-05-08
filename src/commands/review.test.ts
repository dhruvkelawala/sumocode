import { describe, expect, it, vi } from "vitest";
import { buildReviewPrompt, DEFAULT_REVIEW_MODEL, extractModelAlias, MODEL_ALIASES, parseReviewScope, registerReviewCommand, resolveReviewModel } from "./review.js";

describe("/sumo:review", () => {
	describe("resolveReviewModel", () => {
		it("uses deepseek v4 pro by default", () => {
			expect(resolveReviewModel({})).toBe(DEFAULT_REVIEW_MODEL);
			expect(DEFAULT_REVIEW_MODEL).toBe("deepseek/deepseek-v4-pro");
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

		it("includes relentless review loop and model", () => {
			const prompt = buildReviewPrompt("", "deepseek/deepseek-v4-pro");
			expect(prompt).toContain("model deepseek/deepseek-v4-pro");
			expect(prompt).toContain("Relentlessly repeat review -> fix -> review until the scribe returns a GREEN signal");
		});

		it("includes P0/P1/P2 severity rubric", () => {
			const prompt = buildReviewPrompt("", "deepseek/deepseek-v4-pro");
			expect(prompt).toContain("P0: release blocker");
			expect(prompt).toContain("P1: must fix before merge");
			expect(prompt).toContain("P2: should fix before merge");
		});

		it("prohibits the scribe from delegating via task tool", () => {
			const prompt = buildReviewPrompt("", "deepseek/deepseek-v4-pro");
			expect(prompt).toContain("Do NOT use the task tool");
			expect(prompt).toContain("Perform the entire review yourself");
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
		it("registers a command that queues the review prompt as a follow-up", async () => {
			let handler: ((args: string, ctx: { hasUI: boolean; ui: { notify: ReturnType<typeof vi.fn> } }) => Promise<void>) | undefined;
			const sendUserMessage = vi.fn();
			const registerCommand = vi.fn((_name: string, options: { handler: typeof handler }) => {
				handler = options.handler;
			});
			const notify = vi.fn();

			registerReviewCommand({ registerCommand, sendUserMessage } as never);
			await handler?.("src/foo.ts", { hasUI: true, ui: { notify } });

			expect(registerCommand).toHaveBeenCalledWith("sumo:review", expect.objectContaining({ description: expect.any(String) }));
			expect(sendUserMessage).toHaveBeenCalledWith(expect.stringContaining("git diff src/foo.ts"), { deliverAs: "followUp" });
			expect(notify).toHaveBeenCalledWith(expect.stringContaining("deepseek/deepseek-v4-pro"), "info");
		});

		it("includes scope label in notify for PR args", async () => {
			let handler: ((args: string, ctx: { hasUI: boolean; ui: { notify: ReturnType<typeof vi.fn> } }) => Promise<void>) | undefined;
			const sendUserMessage = vi.fn();
			const registerCommand = vi.fn((_name: string, options: { handler: typeof handler }) => {
				handler = options.handler;
			});
			const notify = vi.fn();

			registerReviewCommand({ registerCommand, sendUserMessage } as never);
			await handler?.("#42", { hasUI: true, ui: { notify } });

			expect(sendUserMessage).toHaveBeenCalledWith(expect.stringContaining("gh pr diff 42"), { deliverAs: "followUp" });
			expect(notify).toHaveBeenCalledWith(expect.stringContaining("PR #42"), "info");
		});

		it("uses alias model when provided as first arg", async () => {
			let handler: ((args: string, ctx: { hasUI: boolean; ui: { notify: ReturnType<typeof vi.fn> } }) => Promise<void>) | undefined;
			const sendUserMessage = vi.fn();
			const registerCommand = vi.fn((_name: string, options: { handler: typeof handler }) => {
				handler = options.handler;
			});
			const notify = vi.fn();

			registerReviewCommand({ registerCommand, sendUserMessage } as never);
			await handler?.("opus #42", { hasUI: true, ui: { notify } });

			expect(sendUserMessage).toHaveBeenCalledWith(expect.stringContaining("anthropic/claude-opus-4.6"), { deliverAs: "followUp" });
			expect(sendUserMessage).toHaveBeenCalledWith(expect.stringContaining("gh pr diff 42"), { deliverAs: "followUp" });
			expect(notify).toHaveBeenCalledWith(expect.stringContaining("anthropic/claude-opus-4.6"), "info");
		});
	});
});
