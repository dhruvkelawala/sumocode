import { describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { installMemoryExtraction, observedMessagesFromAgentMessages } from "./memory-extraction.js";

describe("observedMessagesFromAgentMessages", () => {
	it("keeps only user and assistant text content", () => {
		expect(observedMessagesFromAgentMessages([
			{ role: "user", content: "remember pnpm" },
			{ role: "assistant", content: [{ type: "text", text: "noted" }, { type: "toolCall", name: "read" }] },
			{ role: "tool", content: "ignored" },
			{ role: "assistant", content: [{ type: "toolCall", name: "bash" }] },
		])).toEqual([
			{ role: "user", content: "remember pnpm" },
			{ role: "assistant", content: "noted" },
		]);
	});
});

describe("installMemoryExtraction", () => {
	it("registers agent_end extraction and forwards the active session id", async () => {
		let handler: ((event: { messages: unknown[] }, ctx: ExtensionContext) => void) | undefined;
		const observe = vi.fn(async () => undefined);
		// SAFETY: the on() double supplies the registrar surface installMemoryExtraction reads.
		const pi = {
			on: vi.fn((eventName: string, next: typeof handler) => {
				if (eventName === "agent_end") handler = next;
			}),
		} as never;
		// SAFETY: the client provider fake supplies the observe surface the extractor calls.
		installMemoryExtraction(pi, () => ({ observe }) as never);
		// SAFETY: the ctx double supplies the sessionManager/cwd surface the extractor reads.
		const ctx = {
			sessionManager: {
				getSessionId: () => "session-42",
				getSessionFile: () => "/tmp/session-42.jsonl",
			},
			cwd: "/tmp/project",
		} as never;

		handler?.({
			messages: [
				{ role: "user", content: "remember pnpm" },
				{ role: "assistant", content: [{ type: "text", text: "noted" }] },
			],
		}, ctx);

		await vi.waitFor(() => {
			expect(observe).toHaveBeenCalledWith("session-42", [
				{ role: "user", content: "remember pnpm" },
				{ role: "assistant", content: "noted" },
			]);
		});
	});

	it("skips observe calls when there is no usable text", () => {
		let handler: ((event: { messages: unknown[] }, ctx: ExtensionContext) => void) | undefined;
		const observe = vi.fn(async () => undefined);
		// SAFETY: the on() double supplies the registrar surface installMemoryExtraction reads.
		const pi = {
			on: vi.fn((eventName: string, next: typeof handler) => {
				if (eventName === "agent_end") handler = next;
			}),
		} as never;
		// SAFETY: the client provider fake supplies the observe surface the extractor calls.
		installMemoryExtraction(pi, () => ({ observe }) as never);
		// SAFETY: the ctx double supplies the sessionManager/cwd surface the extractor reads.
		handler?.({ messages: [{ role: "assistant", content: [{ type: "toolCall", name: "read" }] }] }, {
			sessionManager: { getSessionId: () => "session-42" },
			cwd: "/tmp/project",
		} as never);

		expect(observe).not.toHaveBeenCalled();
	});
});
