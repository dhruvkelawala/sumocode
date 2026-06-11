import { describe, expect, it } from "vitest";
import {
	chatMessageViewModelFromPiMessage,
	chatMessageViewModelToPlainText,
	markdownAndCodeBlocksFromText,
	transcriptFromSessionContext,
} from "./view-model.js";

describe("structured transcript view model", () => {
	it("maps markdown text messages", () => {
		const message = chatMessageViewModelFromPiMessage({
			id: "u1",
			role: "user",
			content: "hello **sumo**",
			timestamp: 1_700_000_000_000,
		});

		expect(message).toMatchObject({
			id: "u1",
			role: "user",
			displayName: "YOU",
			blocks: [{ type: "markdown", text: "hello **sumo**" }],
		});
		expect(message?.timestamp?.getTime()).toBe(1_700_000_000_000);
	});

	it("splits fenced code blocks out of markdown", () => {
		const blocks = markdownAndCodeBlocksFromText("before\n```ts\nconst x = 1;\n```\nafter");

		expect(blocks).toEqual([
			{ type: "markdown", text: "before\n" },
			{ type: "code", lang: "ts", source: "const x = 1;" },
			{ type: "markdown", text: "\nafter" },
		]);
	});

	it("maps pi task tool calls to Cathedral scroll/scribe delegation blocks", () => {
		const message = chatMessageViewModelFromPiMessage({
			id: "a-task",
			role: "assistant",
			content: [
				{ type: "toolCall", id: "tc-task", name: "task", arguments: {
					type: "single",
					tasks: [{ prompt: "Implement Slice A: Yoga-flex outer chrome\nDetails follow...", model: "openai-codex/gpt-5.5", thinking: "high" }],
				} },
			],
		});

		const block = message?.blocks[0];
		expect(block?.type).toBe("delegation");
		if (block?.type !== "delegation") throw new Error("wrong block type");
		expect(block.delegation.title).toBe("Implement Slice A: Yoga-flex outer chrome");
		expect(block.delegation.model).toBe("openai-codex/gpt-5.5");
		expect(block.delegation.thinking).toBe("high");
		expect(block.delegation.agent).toBe("scribe");
		expect(block.delegation.status).toBe("running");

		const plainText = message ? chatMessageViewModelToPlainText(message) : "";
		expect(plainText).toContain("[scroll]");
		expect(plainText).toContain("Implement Slice A");
	});

	it("extracts pi task titles from markdown headings after the role preamble", () => {
		const message = chatMessageViewModelFromPiMessage({
			id: "a-task-preamble",
			role: "assistant",
			content: [
				{ type: "toolCall", id: "tc-task", name: "task", arguments: {
					type: "single",
					tasks: [{ prompt: "You are Zeus, a senior developer in the Temple of SumoDeus.\n\n## Implement Slice A: Yoga-flex outer chrome\n\nDetails follow...", model: "openai-codex/gpt-5.5", thinking: "high" }],
				} },
			],
		});

		const block = message?.blocks[0];
		expect(block?.type).toBe("delegation");
		if (block?.type !== "delegation") throw new Error("wrong block type");
		expect(block.delegation.title).toBe("Implement Slice A: Yoga-flex outer chrome");
		expect(block.delegation.model).toBe("openai-codex/gpt-5.5");
		expect(block.delegation.thinking).toBe("high");
		expect(block.delegation.prompt).toBe("Details follow...");
		expect(block.delegation.summary).toBeUndefined();
	});

	it("extracts pi task body from single task-shaped arguments while running", () => {
		const message = chatMessageViewModelFromPiMessage({
			id: "a-task-single",
			role: "assistant",
			content: [
				{ type: "toolCall", id: "tc-task", name: "task", arguments: {
					prompt: "You are Zeus.\n\n## Verify issue 194 live scroll result folding\n\nRespond with exactly this sentence:\nTask output visible inside scribe.",
					thinking: "minimal",
				} },
			],
		});

		const block = message?.blocks[0];
		expect(block?.type).toBe("delegation");
		if (block?.type !== "delegation") throw new Error("wrong block type");
		expect(block.delegation.title).toBe("Verify issue 194 live scroll result folding");
		expect(block.delegation.thinking).toBe("minimal");
		expect(block.delegation.prompt).toBe("Respond with exactly this sentence:\nTask output visible inside scribe.");
		expect(block.delegation.summary).toBeUndefined();
	});

	it("carries pi task metadata from tool calls into later tool results", () => {
		const transcript = transcriptFromSessionContext({
			messages: [
				{
					id: "a-task",
					role: "assistant",
					content: [
						{ type: "toolCall", id: "tc-task", name: "task", arguments: {
							type: "single",
							tasks: [{ prompt: "You are Zeus.\n\n## Fix the scroll header\n\nUse the task metadata.", model: "openai-codex/gpt-5.5", thinking: "high" }],
						} },
					],
				},
				{
					role: "toolResult",
					toolCallId: "tc-task",
					toolName: "task",
					name: "task",
					type: "toolResult",
					content: [{ type: "text", text: "Task completed." }],
				},
			],
		});

		const running = transcript.messages[0]?.blocks[0];
		const completed = transcript.messages[1]?.blocks[0];
		expect(running?.type).toBe("delegation");
		expect(completed?.type).toBe("delegation");
		if (running?.type !== "delegation" || completed?.type !== "delegation") throw new Error("wrong block type");
		expect(running.delegation.title).toBe("Fix the scroll header");
		expect(completed.delegation.title).toBe("Fix the scroll header");
		expect(completed.delegation.model).toBe("openai-codex/gpt-5.5");
		expect(completed.delegation.thinking).toBe("high");
		expect(completed.delegation.status).toBe("success");
	});

	it("aggregates native chain task details across all results", () => {
		const message = chatMessageViewModelFromPiMessage({
			role: "toolResult",
			toolCallId: "tc-task",
			toolName: "task",
			name: "task",
			type: "toolResult",
			details: {
				mode: "chain",
				results: [
					{
						index: 1,
						prompt: "## Inspect auth\n\nFind files.",
						exitCode: 0,
						messages: [],
						finalOutput: "Found auth.ts",
						usage: { input: 1000, output: 100 },
						model: "openai-codex/gpt-5.5",
						thinking: "high",
					},
					{
						index: 2,
						prompt: "## Verify auth\n\nRun tests.",
						exitCode: 1,
						messages: [],
						errorMessage: "Tests failed",
						toolEvents: [{ id: "bash-1", name: "bash", args: { command: "pnpm test" }, status: "error", output: "failed" }],
						usage: { input: 2000, output: 200 },
					},
				],
			},
			content: [{ type: "text", text: "Chain stopped at step 2" }],
		});

		const block = message?.blocks[0];
		expect(block?.type).toBe("delegation");
		if (block?.type !== "delegation") throw new Error("wrong block type");
		expect(block.delegation.status).toBe("error");
		expect(block.delegation.title).toBe("Inspect auth");
		expect(block.delegation.prompt).toBe("Task 1: Inspect auth\nTask 2: Verify auth");
		expect(block.delegation.summary).toContain("Task 1: Found auth.ts");
		expect(block.delegation.summary).toContain("Task 2: Tests failed");
		expect(block.delegation.nestedTools).toEqual([{ id: "bash-1", name: "bash", status: "error", input: { command: "pnpm test" }, output: "failed" }]);
		expect(block.delegation.tokensIn).toBe(3000);
		expect(block.delegation.tokensOut).toBe(300);
	});

	it("maps pi task tool results to completed scroll blocks", () => {
		const message = chatMessageViewModelFromPiMessage({
			role: "toolResult",
			toolCallId: "tc-task",
			toolName: "task",
			name: "task",
			type: "toolResult",
			arguments: { type: "single", tasks: [{ prompt: "Fix the bug", model: "openai-codex/gpt-5.5" }] },
			content: [{ type: "text", text: "Task completed. Committed a1b2c3d." }],
		});

		const block = message?.blocks[0];
		expect(block?.type).toBe("delegation");
		if (block?.type !== "delegation") throw new Error("wrong block type");
		expect(block.delegation.status).toBe("success");
		expect(block.delegation.title).toBe("Fix the bug");
		expect(block.delegation.summary).toBe("Task completed. Committed a1b2c3d.");
	});

	it("maps assistant thinking blocks in message order", () => {
		const message = chatMessageViewModelFromPiMessage({
			id: "a-thinking",
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "checking context" },
				{ type: "text", text: "Visible answer." },
				{ type: "thinking", hidden: true },
			],
		});

		expect(message?.blocks).toEqual([
			{ type: "thinking", text: "checking context" },
			{ type: "markdown", text: "Visible answer." },
			{ type: "thinking", text: "Thinking...", hidden: true },
		]);
		expect(message ? chatMessageViewModelToPlainText(message) : "").toBe("checking context\nVisible answer.\nThinking...");
	});

	it("maps assistant tool call blocks", () => {
		const message = chatMessageViewModelFromPiMessage({
			id: "a1",
			role: "assistant",
			content: [
				{ type: "text", text: "I will run the tests." },
				{ type: "toolCall", id: "tc1", name: "bash", arguments: { command: "pnpm test" } },
			],
		});

		expect(message?.role).toBe("sumo");
		expect(message?.blocks).toEqual([
			{ type: "markdown", text: "I will run the tests." },
			{ type: "tool", tool: { id: "tc1", name: "bash", status: "pending", input: { command: "pnpm test" }, output: undefined, details: undefined, error: undefined, expanded: true } },
		]);
	});

	it("maps tool result messages", () => {
		const message = chatMessageViewModelFromPiMessage({
			role: "toolResult",
			toolCallId: "tc1",
			toolName: "bash",
			content: [{ type: "text", text: "passed" }],
			isError: false,
		});

		expect(message).toMatchObject({
			id: "tc1",
			role: "system",
			blocks: [{ type: "tool", tool: { id: "tc1", name: "bash", status: "success", output: "passed" } }],
		});
	});

	it("maps image content parts instead of dropping them", () => {
		const message = chatMessageViewModelFromPiMessage({
			role: "assistant",
			content: [
				{ type: "text", text: "before" },
				{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png", filename: "one.png" },
			],
		});

		expect(message?.blocks).toContainEqual({ type: "image", data: "iVBORw0KGgo=", mime: "image/png", filename: "one.png" });
		expect(message ? chatMessageViewModelToPlainText(message) : "").toContain("[image] image/png");
	});

	it("maps skill blocks", () => {
		const message = chatMessageViewModelFromPiMessage({
			role: "assistant",
			content: [{ type: "skill", name: "frontend-design", expanded: true }],
		});

		expect(message?.blocks).toEqual([{ type: "skill", name: "frontend-design", expanded: true }]);
	});

	it("maps question blocks", () => {
		const message = chatMessageViewModelFromPiMessage({
			role: "assistant",
			content: [{ type: "question", id: "q1", prompt: "Proceed?", choices: ["yes", "no"], selected: "yes", required: true }],
		});

		expect(message?.blocks).toEqual([
			{ type: "question", question: { id: "q1", prompt: "Proceed?", choices: ["yes", "no"], selected: "yes", required: true } },
		]);
	});

	it("maps delegation blocks", () => {
		const message = chatMessageViewModelFromPiMessage({
			role: "assistant",
			content: [{ type: "delegation", id: "d1", agent: "scribe", status: "running", summary: "scrolling the long transcript" }],
		});

		expect(message?.blocks).toEqual([
			{ type: "delegation", delegation: { id: "d1", title: "scribe", agent: "scribe", status: "running", summary: "scrolling the long transcript", model: undefined, thinking: undefined, nestedTools: [], tokensIn: undefined, tokensOut: undefined, elapsedMs: undefined } },
		]);
	});

	it("converts session contexts into transcript view models and skips hidden custom messages", () => {
		const transcript = transcriptFromSessionContext({
			messages: [
				{ role: "custom", customType: "notification", display: false, content: "hidden" },
				{ role: "user", content: "visible" },
				{ role: "bashExecution", command: "pnpm test", output: "ok", exitCode: 0 },
			],
		});

		expect(transcript.messages).toHaveLength(2);
		expect(transcript.messages[0]?.blocks).toEqual([{ type: "markdown", text: "visible" }]);
		expect(transcript.messages[1]?.blocks[0]).toMatchObject({ type: "tool", tool: { name: "bash", status: "success", output: "ok" } });
	});

	it("can flatten structured blocks for the legacy ChatPager bridge", () => {
		const message = chatMessageViewModelFromPiMessage({
			role: "assistant",
			content: [
				{ type: "text", text: "Using a skill." },
				{ type: "skill", name: "tdd", expanded: false },
			],
		});

		expect(message ? chatMessageViewModelToPlainText(message) : "").toContain("[skill] tdd");
	});
});
