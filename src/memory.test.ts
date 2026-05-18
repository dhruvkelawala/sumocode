import { describe, expect, it, vi } from "vitest";
import {
	MemoryClientError,
	createRemnicMemoryClient,
	type FetchLike,
} from "./memory.js";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "content-type": "application/json" },
		...init,
	});
}

function fetchMock(response: Response | Error): FetchLike {
	return vi.fn(async () => {
		if (response instanceof Error) throw response;
		return response;
	});
}

function client(fetch: FetchLike) {
	return createRemnicMemoryClient({
		baseUrl: "http://remnic.test",
		fetch,
		tokenProvider: () => "token-123",
		timeoutMs: 25,
	});
}

describe("RemnicMemoryClient.query", () => {
	it("returns top-N facts from Remnic recall results", async () => {
		const fetch = fetchMock(jsonResponse({
			results: [
				{ id: "a", content: "prefers pnpm", category: "preference", score: 0.9 },
				{ memoryId: "b", text: "uses Cathedral theme", score: 0.7 },
			],
		}));

		await expect(client(fetch).query("package manager", 2)).resolves.toEqual([
			{ id: "a", text: "prefers pnpm", category: "preference", score: 0.9 },
			{ id: "b", text: "uses Cathedral theme", score: 0.7 },
		]);

		expect(fetch).toHaveBeenCalledWith(
			"http://remnic.test/engram/v1/recall",
			expect.objectContaining({
				method: "POST",
				headers: expect.objectContaining({ authorization: "Bearer token-123" }),
				body: JSON.stringify({ query: "package manager", topK: 2, mode: "full" }),
			}),
		);
	});

	it("returns an empty list for an empty recall result", async () => {
		const fetch = fetchMock(jsonResponse({ results: [] }));

		await expect(client(fetch).query("nothing", 5)).resolves.toEqual([]);
	});

	it("throws daemon_down for 503 responses", async () => {
		const fetch = fetchMock(jsonResponse({ error: "unavailable" }, { status: 503 }));

		await expect(client(fetch).query("auth", 5)).rejects.toMatchObject({ code: "daemon_down" });
	});

	it("throws timeout for aborted network requests", async () => {
		const fetch = fetchMock(new DOMException("aborted", "AbortError"));

		await expect(client(fetch).query("slow", 5)).rejects.toMatchObject({ code: "timeout" });
	});

	it("throws malformed_response when recall JSON lacks a result array", async () => {
		const fetch = fetchMock(jsonResponse({ nope: true }));

		await expect(client(fetch).query("bad", 5)).rejects.toMatchObject({ code: "malformed_response" });
	});
});

describe("RemnicMemoryClient.add / forget", () => {
	it("adds a memory fact then soft-archives it", async () => {
		const fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
			if (String(url).endsWith("/engram/v1/memories") && init?.method === "POST") {
				expect(init.body).toBe(JSON.stringify({ content: "prefers TDD", category: "preference" }));
				return jsonResponse({
					schemaVersion: 1,
					operation: "memory_store",
					accepted: true,
					status: "stored",
				}, { status: 201 });
			}

			if (String(url).includes("/engram/v1/memories?q=prefers%20TDD&limit=1&sort=updated_desc")) {
				return jsonResponse({ memories: [{
					id: "mem_1",
					preview: "prefers TDD",
					category: "preference",
					created: "2026-04-26T14:17:09.617Z",
					updated: "2026-04-26T14:17:25.146Z",
				}] });
			}

			if (String(url).endsWith("/engram/v1/review-disposition")) {
				expect(init?.method).toBe("POST");
				expect(init?.body).toBe(JSON.stringify({
					memoryId: "mem_1",
					status: "archived",
					reasonCode: "sumocode_forget",
				}));
				return jsonResponse({ ok: true });
			}

			throw new Error(`unexpected url: ${String(url)}`);
		});

		const remnic = client(fetch);
		await expect(remnic.add("prefers TDD", "preference")).resolves.toEqual({
			id: "mem_1",
			text: "prefers TDD",
			category: "preference",
			createdAt: "2026-04-26T14:17:09.617Z",
			updatedAt: "2026-04-26T14:17:25.146Z",
		});
		await expect(remnic.forget("mem_1")).resolves.toBeUndefined();
		expect(fetch).toHaveBeenCalledTimes(3);
	});

	it("observes agent messages for Remnic extraction", async () => {
		const fetch = fetchMock(jsonResponse({ accepted: true }, { status: 202 }));

		await expect(client(fetch).observe("session-123", [
			{ role: "user", content: "remember I prefer pnpm" },
			{ role: "assistant", content: "noted" },
		])).resolves.toBeUndefined();

		expect(fetch).toHaveBeenCalledWith(
			"http://remnic.test/engram/v1/observe",
			expect.objectContaining({
				method: "POST",
				headers: expect.objectContaining({ authorization: "Bearer token-123" }),
				body: JSON.stringify({
					sessionKey: "session-123",
					messages: [
						{ role: "user", content: "remember I prefer pnpm" },
						{ role: "assistant", content: "noted" },
					],
				}),
			}),
		);
	});
});

describe("MemoryClientError", () => {
	it("preserves the machine-readable error code", () => {
		const err = new MemoryClientError("daemon_down", "memory unavailable");
		expect(err.code).toBe("daemon_down");
		expect(err.message).toBe("memory unavailable");
	});
});
