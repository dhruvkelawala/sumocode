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

	it("maps pi task tool calls to shared Activity blocks", () => {
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
		expect(block?.type).toBe("activity");
		if (block?.type !== "activity") throw new Error("wrong block type");
		expect(block.activity).toMatchObject({
			id: "tc-task",
			kind: "task",
			title: "Implement Slice A: Yoga-flex outer chrome",
			model: "openai-codex/gpt-5.5",
			thinking: "high",
			status: "running",
		});

		const plainText = message ? chatMessageViewModelToPlainText(message) : "";
		expect(plainText).toContain("[Implement Slice A: Yoga-flex outer chrome]");
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
		expect(block?.type).toBe("activity");
		if (block?.type !== "activity") throw new Error("wrong block type");
		expect(block.activity).toMatchObject({
			title: "Implement Slice A: Yoga-flex outer chrome",
			model: "openai-codex/gpt-5.5",
			thinking: "high",
			invocation: { tasks: [{ prompt: "You are Zeus, a senior developer in the Temple of SumoDeus.\n\n## Implement Slice A: Yoga-flex outer chrome\n\nDetails follow..." }] },
		});
		expect(block.activity.result).toBeUndefined();
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
		expect(block?.type).toBe("activity");
		if (block?.type !== "activity") throw new Error("wrong block type");
		expect(block.activity).toMatchObject({
			title: "Verify issue 194 live scroll result folding",
			thinking: "minimal",
			invocation: { tasks: [{ prompt: "You are Zeus.\n\n## Verify issue 194 live scroll result folding\n\nRespond with exactly this sentence:\nTask output visible inside scribe." }] },
		});
		expect(block.activity.result).toBeUndefined();
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

		expect(transcript.messages).toHaveLength(1);
		const completed = transcript.messages[0]?.blocks[0];
		expect(completed?.type).toBe("activity");
		if (completed?.type !== "activity") throw new Error("wrong block type");
		expect(completed.activity).toMatchObject({
			id: "tc-task",
			title: "Fix the scroll header",
			model: "openai-codex/gpt-5.5",
			thinking: "high",
			status: "succeeded",
			result: { summary: "Task completed." },
		});
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
		expect(block?.type).toBe("activity");
		if (block?.type !== "activity") throw new Error("wrong block type");
		expect(block.activity).toMatchObject({
			status: "failed",
			title: "Inspect auth",
			subject: "chain · 2 tasks",
			result: { summary: "Task 1: Found auth.ts", error: "Task 2: Tests failed" },
			metrics: { tokensIn: 3000, tokensOut: 300 },
		});
		expect(block.activity.activeTools?.[1]).toMatchObject({
			id: "tc-task:result:1",
			activeTools: [{ id: "bash-1", title: "bash", status: "failed", invocation: { command: "pnpm test" }, outputTail: "failed" }],
		});
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
		expect(block?.type).toBe("activity");
		if (block?.type !== "activity") throw new Error("wrong block type");
		expect(block.activity).toMatchObject({
			status: "succeeded",
			title: "Fix the bug",
			result: { summary: "Task completed. Committed a1b2c3d." },
		});
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

	it("folds replayed subagent spawn queued, canonical running, and final records into one Activity", () => {
		const running = {
			id: "subagent:sa-1",
			sourceId: "spawn-call-1",
			kind: "subagent",
			title: "review auth",
			status: "running",
			invocation: { prompt: "Review auth" },
		};
		const transcript = transcriptFromSessionContext({
			messages: [
				{
					id: "assistant-spawn",
					role: "assistant",
					content: [{ type: "toolCall", id: "spawn-call-1", name: "subagent_spawn", arguments: { prompt: "Review auth", name: "review auth" } }],
				},
				{
					role: "toolResult",
					toolCallId: "spawn-call-1",
					toolName: "subagent_spawn",
					content: [{ type: "text", text: "Started sa-1" }],
					details: { activity: running },
				},
				{
					role: "custom",
					customType: "subagent-result",
					display: true,
					content: "No findings",
					details: { activity: { ...running, status: "succeeded", result: { summary: "No findings" } } },
				},
			],
		});

		expect(transcript.messages).toHaveLength(1);
		expect(transcript.messages[0]?.blocks).toEqual([expect.objectContaining({
			type: "activity",
			activity: expect.objectContaining({
				id: "subagent:sa-1",
				sourceId: "spawn-call-1",
				kind: "subagent",
				status: "succeeded",
				result: { summary: "No findings" },
			}),
		})]);
	});

	it("maps a historical subagent result custom message to a standalone Activity", () => {
		const message = chatMessageViewModelFromPiMessage({
			id: "result-1",
			role: "custom",
			customType: "subagent-result",
			display: true,
			content: 'Subagent sa-3 "review" finished.\n\nNo findings.',
			details: { id: "sa-3", title: "review", status: "done" },
		});

		expect(message?.blocks).toEqual([{
			type: "activity",
			activity: {
				id: "subagent:sa-3",
				kind: "subagent",
				title: "review",
				status: "succeeded",
				subject: "sa-3",
				result: { summary: 'Subagent sa-3 "review" finished.\n\nNo findings.' },
			},
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

	it("uses terminal_start details.activity as the canonical running transcript card", () => {
		const activity = {
			id: "term-live",
			sourceId: "terminal-call-1",
			kind: "terminal" as const,
			title: "auth watcher",
			status: "running" as const,
			ownerSessionId: "session-a",
			outputTail: "phase one",
			body: { kind: "terminal" as const, text: "phase one" },
		};
		const message = chatMessageViewModelFromPiMessage({
			role: "toolResult",
			toolCallId: "terminal-call-1",
			toolName: "terminal_start",
			content: [{ type: "text", text: "Started terminal term-live." }],
			details: { activity, task: { id: "term-live" } },
		});

		expect(message?.blocks).toEqual([{ type: "activity", activity }]);
	});

	it("folds explicit terminal_wait observation into the canonical start card", () => {
		const running = {
			id: "term-observed",
			sourceId: "terminal-start-call",
			kind: "terminal" as const,
			title: "auth watcher",
			status: "running" as const,
			ownerSessionId: "session-a",
			body: { kind: "terminal" as const, text: "working" },
		};
		const settled = {
			...running,
			status: "succeeded" as const,
			body: { kind: "terminal" as const, text: "done" },
			result: { summary: "exit 0" },
		};
		const transcript = transcriptFromSessionContext({ messages: [
			{ id: "start-message", role: "assistant", content: [{ type: "toolCall", id: "terminal-start-call", name: "terminal_start", arguments: { command: "pnpm test", title: "auth watcher" } }] },
			{ role: "toolResult", toolCallId: "terminal-start-call", toolName: "terminal_start", content: [{ type: "text", text: "started" }], details: { activity: running } },
			{ id: "wait-message", role: "assistant", content: [{ type: "toolCall", id: "terminal-wait-call", name: "terminal_wait", arguments: { ids: ["term-observed"] } }] },
			{ role: "toolResult", toolCallId: "terminal-wait-call", toolName: "terminal_wait", content: [{ type: "text", text: "settled" }], details: { activities: [settled] } },
		] });

		expect(transcript.messages).toHaveLength(2);
		expect(transcript.messages[0]?.blocks).toEqual([
			expect.objectContaining({ type: "activity", activity: expect.objectContaining({ id: "term-observed", status: "succeeded", body: expect.objectContaining({ text: "done" }) }) }),
		]);
		expect(transcript.messages[1]?.blocks).toEqual([
			expect.objectContaining({ type: "activity", activity: expect.objectContaining({ id: "terminal-wait-call", title: "terminal_wait", status: "succeeded" }) }),
		]);
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

	it("falls back safely when persisted terminal Activity details are malformed", () => {
		const message = chatMessageViewModelFromPiMessage({
			id: "result-malformed",
			role: "custom",
			customType: "terminal-result",
			display: true,
			content: "Terminal term-bad completed.",
			details: {
				id: "term-bad",
				title: "malformed",
				exitCode: 0,
				activity: {
					id: "term-bad",
					kind: "terminal",
					title: "malformed",
					status: "succeeded",
					body: { kind: "terminal", text: {} },
				},
			},
		});

		expect(message?.blocks).toEqual([{
			type: "summary",
			kind: "terminal",
			label: "[terminal] term-bad · malformed · exited (0)",
			content: "Terminal term-bad completed.",
			expanded: false,
		}]);
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
