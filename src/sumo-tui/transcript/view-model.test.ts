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

	it("parses a skill envelope into a collapsed skill block", () => {
		const message = chatMessageViewModelFromPiMessage({
			id: "u-skill",
			role: "user",
			content: '<skill name="deep-research" location="/skills/dr/SKILL.md">\nfull body line 1\nfull body line 2\n</skill>\n\nplease research foxes',
		});

		expect(message?.blocks).toEqual([
			{ type: "skill", name: "deep-research", expanded: false, content: "full body line 1\nfull body line 2" },
			{ type: "markdown", text: "please research foxes" },
		]);
	});

	it("leaves a non-envelope skill-looking user message as markdown", () => {
		const message = chatMessageViewModelFromPiMessage({
			id: "u-skill-literal",
			role: "user",
			content: 'pasted code with <skill name="demo"> inside it',
		});

		expect(message?.blocks).toEqual([{ type: "markdown", text: 'pasted code with <skill name="demo"> inside it' }]);
	});

	it("maps a compactionSummary message to a summary pill", () => {
		const message = chatMessageViewModelFromPiMessage({
			id: "c1",
			role: "compactionSummary",
			summary: "did stuff",
			tokensBefore: 120000,
		});

		expect(message?.blocks).toEqual([
			{ type: "summary", kind: "compaction", label: "[compaction] Compacted from 120,000 tokens", content: "did stuff", expanded: false },
		]);
		expect(message ? chatMessageViewModelToPlainText(message) : "").toBe("[compaction] Compacted from 120,000 tokens");
	});

	it("maps a branchSummary message to a summary pill", () => {
		const message = chatMessageViewModelFromPiMessage({
			id: "b1",
			role: "branchSummary",
			summary: "branch did stuff",
		});

		expect(message?.blocks).toEqual([
			{ type: "summary", kind: "branch", label: "[branch] Branch summary", content: "branch did stuff", expanded: false },
		]);
		expect(message ? chatMessageViewModelToPlainText(message) : "").toBe("[branch] Branch summary");
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
			{
				type: "activity",
				activity: {
					id: "tc1",
					kind: "tool",
					title: "bash",
					status: "queued",
					invocation: { command: "pnpm test" },
					subject: "pnpm test",
					body: { kind: "terminal", command: "pnpm test", text: "" },
				},
			},
		]);
	});

	it("uses deterministic message-and-block fallback IDs for historical tools", () => {
		const message = chatMessageViewModelFromPiMessage({
			id: "historical-tools",
			role: "assistant",
			content: [
				{ type: "toolCall", name: "read", arguments: { path: "a.ts" } },
				{ type: "toolCall", name: "read", arguments: { path: "b.ts" } },
			],
		});
		const activities = message?.blocks.filter((block) => block.type === "activity") ?? [];

		expect(activities.map((block) => block.activity.id)).toEqual([
			"pi-tool:historical-tools:0",
			"pi-tool:historical-tools:1",
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
			blocks: [{ type: "activity", activity: { id: "tc1", title: "bash", status: "succeeded", outputTail: "passed", body: { kind: "terminal", text: "passed" } } }],
		});
	});

	it("collapses image paths in user-message display to [Image: name] tags", () => {
		const quoted = chatMessageViewModelFromPiMessage({
			role: "user",
			content: 'check this "/Users/me/Desktop/Screenshot 2026-07-08 at 12.10.57.png" please',
		});
		expect(quoted?.blocks).toEqual([
			{ type: "markdown", text: "check this [Image: Screenshot 2026-07-08 at 12.10.57.png] please" },
		]);

		const bare = chatMessageViewModelFromPiMessage({
			role: "user",
			content: "/tmp/pi-clipboard-9f.png what is this?",
		});
		expect(bare?.blocks).toEqual([
			{ type: "markdown", text: "[Image: pi-clipboard-9f.png] what is this?" },
		]);

		// Non-image user text is untouched, and assistant text is NEVER rewritten.
		const assistant = chatMessageViewModelFromPiMessage({
			role: "assistant",
			content: [{ type: "text", text: "run rm /tmp/pi-clipboard-9f.png now" }],
		});
		expect(assistant?.blocks).toEqual([
			{ type: "markdown", text: "run rm /tmp/pi-clipboard-9f.png now" },
		]);
	});

	it("keeps image parts from tool results as sibling image blocks (Read on a PNG)", () => {
		const message = chatMessageViewModelFromPiMessage({
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "read",
			content: [
				{ type: "text", text: "Read image file [image/png]" },
				{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png", filename: "shot.png" },
			],
			isError: false,
		});
		expect(message?.blocks.some((block) => block.type === "activity")).toBe(true);
		expect(message?.blocks).toContainEqual({ type: "image", data: "iVBORw0KGgo=", mime: "image/png", filename: "shot.png" });
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

	it("maps a subagent result custom message to a collapsed summary block", () => {
		const message = chatMessageViewModelFromPiMessage({
			id: "result-1",
			role: "custom",
			customType: "subagent-result",
			display: true,
			content: 'Subagent sa-3 "review" finished.\n\nNo findings.',
			details: { id: "sa-3", title: "review", status: "done" },
		});

		expect(message?.blocks).toEqual([{
			type: "summary",
			kind: "subagent",
			label: "[subagent] sa-3 · review · finished",
			content: 'Subagent sa-3 "review" finished.\n\nNo findings.',
			expanded: false,
		}]);
	});

	it("maps a terminal result custom message to a collapsed summary block", () => {
		const message = chatMessageViewModelFromPiMessage({
			id: "result-2",
			role: "custom",
			customType: "terminal-result",
			display: true,
			content: 'Background terminal bg-7 "dev server" exited (0).\n\nready',
			details: {
				id: "bg-7",
				title: "dev server",
				command: "pnpm dev",
				status: "completed",
				exitCode: 0,
			},
		});

		expect(message?.blocks).toEqual([{
			type: "summary",
			kind: "terminal",
			label: "[terminal] bg-7 · dev server · exited (0)",
			content: 'Background terminal bg-7 "dev server" exited (0).\n\nready',
			expanded: false,
		}]);
	});

	it("maps a v2 terminal result Activity through the universal retained renderer", () => {
		const activity = {
			id: "term-7",
			kind: "terminal" as const,
			title: "dev server",
			status: "succeeded" as const,
			ownerSessionId: "session-a",
			body: { kind: "terminal" as const, command: "pnpm dev", text: "ready" },
		};
		const message = chatMessageViewModelFromPiMessage({
			id: "result-v2",
			role: "custom",
			customType: "terminal-result",
			display: true,
			content: "Terminal term-7 completed.",
			details: { completionId: "completion-7", ownerSessionId: "session-a", activity },
		});

		expect(message?.blocks).toEqual([{ type: "activity", activity }]);
	});

	it("labels an unrecognized custom message with its customType", () => {
		const message = chatMessageViewModelFromPiMessage({ id: "x1", role: "custom", customType: "sumocode-theme-result", display: true, content: "switched to obsidian" });

		expect(message?.blocks).toEqual([
			{ type: "markdown", text: "[sumocode-theme-result]" },
			{ type: "markdown", text: "switched to obsidian" },
		]);
	});

	it("rescues a renderer-only custom message (empty content) via the label", () => {
		const message = chatMessageViewModelFromPiMessage({ id: "x2", role: "custom", customType: "answers", display: true, content: "" });

		expect(message?.blocks).toEqual([{ type: "markdown", text: "[answers]" }]);
		expect(chatMessageViewModelToPlainText(message!)).toContain("[answers]");
	});

	it("still hides display:false custom messages", () => {
		const message = chatMessageViewModelFromPiMessage({ id: "x3", role: "custom", customType: "answers", display: false, content: "secret" });

		expect(message).toBeUndefined();
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
		expect(transcript.messages[1]?.blocks[0]).toMatchObject({ type: "activity", activity: { title: "bash", status: "succeeded", outputTail: "ok" } });
	});

	it("can flatten structured blocks for the legacy ChatPager bridge", () => {
		const message = chatMessageViewModelFromPiMessage({
			role: "assistant",
			content: [
				{ type: "text", text: "Using a skill." },
				{ type: "skill", name: "tdd", expanded: false },
			],
		});

		expect(message ? chatMessageViewModelToPlainText(message) : "").toContain("[skill] tdd (ctrl+o to expand)");
	});
});
