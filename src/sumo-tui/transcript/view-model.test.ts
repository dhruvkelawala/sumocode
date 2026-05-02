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
