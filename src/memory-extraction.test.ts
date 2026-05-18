import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
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
		const pi = {
			on: vi.fn((eventName: string, next: typeof handler) => {
				if (eventName === "agent_end") handler = next;
			}),
		} as unknown as ExtensionAPI;

		installMemoryExtraction(pi, () => ({ observe }) as never);
		const ctx = {
			sessionManager: {
				getSessionId: () => "session-42",
				getSessionFile: () => "/tmp/session-42.jsonl",
			},
			cwd: "/tmp/project",
		} as unknown as ExtensionContext;

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
		const pi = {
			on: vi.fn((eventName: string, next: typeof handler) => {
				if (eventName === "agent_end") handler = next;
			}),
		} as unknown as ExtensionAPI;

		installMemoryExtraction(pi, () => ({ observe }) as never);
		handler?.({ messages: [{ role: "assistant", content: [{ type: "toolCall", name: "read" }] }] }, {
			sessionManager: { getSessionId: () => "session-42" },
			cwd: "/tmp/project",
		} as unknown as ExtensionContext);

		expect(observe).not.toHaveBeenCalled();
	});
});
