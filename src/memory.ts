import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type MemoryFact = {
	id: string;
	text: string;
	category?: string;
	score?: number;
	createdAt?: string;
	updatedAt?: string;
	/** Remnic-native tags. Includes `sumocode:<panel>` routing tags. */
	tags?: readonly string[];
	/** Remnic-native entity reference (e.g. "alice"). */
	entityRef?: string;
	/** Memory lifecycle status ("active" | "archived" | "hidden" | etc). */
	status?: string;
};

export type MemoryBrowseParams = {
	status?: "active" | "archived" | "all";
	q?: string;
	limit?: number;
	offset?: number;
};

export type MemoryStatus = {
	ok: boolean;
	factCount: number;
	lastExtractionAt?: string;
	error?: string;
};

export type MemoryClientErrorCode =
	| "daemon_down"
	| "unauthorized"
	| "timeout"
	| "malformed_response"
	| "request_failed";

export class MemoryClientError extends Error {
	constructor(
		readonly code: MemoryClientErrorCode,
		message: string,
		readonly cause?: unknown,
	) {
		super(message);
		this.name = "MemoryClientError";
	}
}

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export type RemnicMemoryClientOptions = {
	baseUrl?: string;
	fetch?: FetchLike;
	tokenProvider?: () => string | undefined;
	timeoutMs?: number;
};

export type RemnicMemoryClient = {
	query(prompt: string, n?: number): Promise<MemoryFact[]>;
	status(): Promise<MemoryStatus>;
	add(text: string, category?: string): Promise<MemoryFact>;
	forget(factId: string): Promise<void>;
	/**
	 * List all memories (newest first by default) for the cathedral memory editor.
	 * Uses Remnic's GET /engram/v1/memories endpoint with status / q / limit / offset
	 * filters per the spike findings.
	 */
	browse(params?: MemoryBrowseParams): Promise<MemoryFact[]>;
};

export const DEFAULT_REMNIC_BASE_URL = "http://127.0.0.1:7749";
export const DEFAULT_REMNIC_TIMEOUT_MS = 3_000;
export const DEFAULT_REMNIC_TOKEN_PATH = join(homedir(), ".sumocode", "remnic-auth-token");

function defaultTokenProvider(): string | undefined {
	try {
		return readFileSync(DEFAULT_REMNIC_TOKEN_PATH, "utf8").trim() || undefined;
	} catch {
		return undefined;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asStringArray(value: unknown): readonly string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const strings = value.filter((item): item is string => typeof item === "string");
	return strings.length === 0 ? undefined : strings;
}

function factFromUnknown(value: unknown): MemoryFact | undefined {
	const raw = isRecord(value) && isRecord(value.memory) ? value.memory : value;
	if (!isRecord(raw)) return undefined;

	const id = asString(raw.id) ?? asString(raw.memoryId) ?? (isRecord(value) ? asString(value.memoryId) : undefined);
	const text = asString(raw.content) ?? asString(raw.text) ?? asString(raw.summary) ?? asString(raw.preview);
	if (!id || !text) return undefined;

	return {
		id,
		text,
		category: asString(raw.category),
		score: asNumber(raw.score) ?? (isRecord(value) ? asNumber(value.score) : undefined),
		createdAt: asString(raw.createdAt) ?? asString(raw.created_at) ?? asString(raw.created),
		updatedAt: asString(raw.updatedAt) ?? asString(raw.updated_at) ?? asString(raw.updated),
		tags: asStringArray(raw.tags),
		entityRef: asString(raw.entityRef) ?? asString(raw.entity_ref),
		status: asString(raw.status),
	};
}

function errorCodeForStatus(status: number): MemoryClientErrorCode {
	if (status === 401 || status === 403) return "unauthorized";
	if (status === 502 || status === 503 || status === 504) return "daemon_down";
	return "request_failed";
}

function jsonHeaders(token?: string): Record<string, string> {
	return {
		"content-type": "application/json",
		...(token ? { authorization: `Bearer ${token}` } : {}),
	};
}

function withTimeout(timeoutMs: number): AbortController {
	const controller = new AbortController();
	setTimeout(() => controller.abort(), timeoutMs).unref?.();
	return controller;
}

export function createRemnicMemoryClient(options: RemnicMemoryClientOptions = {}): RemnicMemoryClient {
	const baseUrl = (options.baseUrl ?? DEFAULT_REMNIC_BASE_URL).replace(/\/$/, "");
	const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
	const tokenProvider = options.tokenProvider ?? defaultTokenProvider;
	const timeoutMs = options.timeoutMs ?? DEFAULT_REMNIC_TIMEOUT_MS;

	async function requestJson(path: string, init: RequestInit = {}): Promise<unknown> {
		const controller = withTimeout(timeoutMs);
		const token = tokenProvider();
		try {
			const response = await fetchImpl(`${baseUrl}${path}`, {
				...init,
				signal: controller.signal,
				headers: {
					...jsonHeaders(token),
					...(init.headers ?? {}),
				},
			});

			if (!response.ok) {
				const code = errorCodeForStatus(response.status);
				throw new MemoryClientError(code, `Remnic request failed with ${response.status}`);
			}

			try {
				return await response.json();
			} catch (err) {
				throw new MemoryClientError("malformed_response", "Remnic returned invalid JSON", err);
			}
		} catch (err) {
			if (err instanceof MemoryClientError) throw err;
			if (err instanceof DOMException && err.name === "AbortError") {
				throw new MemoryClientError("timeout", "Remnic request timed out", err);
			}
			throw new MemoryClientError("daemon_down", "memory unavailable", err);
		}
	}

	return {
		async query(prompt: string, n = 5): Promise<MemoryFact[]> {
			const body = JSON.stringify({ query: prompt.trim() || " ", topK: n, mode: "full" });
			const payload = await requestJson("/engram/v1/recall", { method: "POST", body });
			if (!isRecord(payload)) {
				throw new MemoryClientError("malformed_response", "Remnic recall response was not an object");
			}

			const rawResults = Array.isArray(payload.results)
				? payload.results
				: Array.isArray(payload.memories)
					? payload.memories
					: undefined;
			if (!rawResults) {
				throw new MemoryClientError("malformed_response", "Remnic recall response had no results array");
			}

			return rawResults.map(factFromUnknown).filter((fact): fact is MemoryFact => fact !== undefined).slice(0, n);
		},

		async status(): Promise<MemoryStatus> {
			try {
				await requestJson("/engram/v1/health", { method: "GET" });
				const browse = await requestJson("/engram/v1/memories?limit=1&sort=updated_desc", { method: "GET" });
				if (!isRecord(browse)) return { ok: true, factCount: 0 };
				const memories = Array.isArray(browse.memories) ? browse.memories : [];
				const latest = factFromUnknown(memories[0]);
				return {
					ok: true,
					factCount: asNumber(browse.total) ?? asNumber(browse.count) ?? memories.length,
					lastExtractionAt: latest?.updatedAt ?? latest?.createdAt,
				};
			} catch (err) {
				return { ok: false, factCount: 0, error: err instanceof Error ? err.message : String(err) };
			}
		},

		async add(text: string, category?: string): Promise<MemoryFact> {
			const payload = await requestJson("/engram/v1/memories", {
				method: "POST",
				body: JSON.stringify({ content: text, ...(category ? { category } : {}) }),
			});
			const immediate = factFromUnknown(payload);
			if (immediate) return immediate;

			// Remnic v1.0.5 returns an operation receipt for memory_store rather than
			// the created memory. Follow up with a browse-by-query to return the public
			// MemoryFact shape promised by SumoCode's client API.
			const lookup = await requestJson(
				`/engram/v1/memories?q=${encodeURIComponent(text)}&limit=1&sort=updated_desc`,
				{ method: "GET" },
			);
			if (isRecord(lookup) && Array.isArray(lookup.memories)) {
				const fact = factFromUnknown(lookup.memories[0]);
				if (fact) return fact;
			}

			throw new MemoryClientError("malformed_response", "Remnic add response did not contain a memory fact");
		},

		async forget(factId: string): Promise<void> {
			await requestJson("/engram/v1/review-disposition", {
				method: "POST",
				body: JSON.stringify({
					memoryId: factId,
					status: "archived",
					reasonCode: "sumocode_forget",
				}),
			});
		},

		async browse(params: MemoryBrowseParams = {}): Promise<MemoryFact[]> {
			const search = new URLSearchParams();
			if (params.status && params.status !== "all") search.set("status", params.status);
			else if (!params.status) search.set("status", "active");
			if (params.q) search.set("q", params.q);
			search.set("limit", String(params.limit ?? 200));
			search.set("offset", String(params.offset ?? 0));
			search.set("sort", "updated_desc");

			const payload = await requestJson(`/engram/v1/memories?${search.toString()}`, { method: "GET" });
			if (!isRecord(payload)) {
				throw new MemoryClientError("malformed_response", "Remnic browse response was not an object");
			}
			const memories = Array.isArray(payload.memories) ? payload.memories : [];
			return memories.map(factFromUnknown).filter((fact): fact is MemoryFact => fact !== undefined);
		},
	};
}
