import { join } from "node:path";
import {
	atomicWritePrivateJson,
	defaultActivityStateRoot,
	ensurePrivateSumocodeDirectory,
	readPrivateJson,
	withPrivateFileLock,
} from "../../activity/persistence.js";

const CACHE_VERSION = 1 as const;
const MAX_CACHED_CWDS = 20;
const MAX_CACHE_BYTES = 64 * 1024;

export interface CachedChrome {
	modelLabel?: string;
	thinkingLevel?: string;
}

interface CachedChromeEntry extends CachedChrome {
	readonly savedAt: number;
}

interface ChromeCacheFile {
	readonly version: typeof CACHE_VERSION;
	readonly byCwd: Record<string, CachedChromeEntry>;
}

export interface ChromeCacheOptions {
	/** Test seam; production resolves SUMOCODE_STATE_DIR / PI_CODING_AGENT_DIR. */
	readonly stateRoot?: string;
	readonly env?: NodeJS.ProcessEnv;
	/** Test seam for deterministic eviction ordering. */
	readonly now?: () => number;
}

function cachePath(options: ChromeCacheOptions): string {
	const stateRoot = options.stateRoot ?? defaultActivityStateRoot(options.env);
	return join(ensurePrivateSumocodeDirectory(["chrome", "v1"], stateRoot), "chrome-cache.json");
}

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

function isJsonObject(value: JsonValue | undefined): value is { [key: string]: JsonValue } {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNumber(value: JsonValue | undefined): value is number {
	return typeof value === "number";
}

function isString(value: JsonValue | undefined): value is string {
	return typeof value === "string";
}

function readCacheFile(options: ChromeCacheOptions): ChromeCacheFile | undefined {
	try {
		// SAFETY: readPrivateJson returns untyped file contents; every field is
		// validated by the guards below before being copied into the cache.
		const parsed = readPrivateJson(cachePath(options), MAX_CACHE_BYTES) as JsonValue;
		if (!isJsonObject(parsed) || parsed["version"] !== CACHE_VERSION || !isJsonObject(parsed["byCwd"])) return undefined;
		const byCwd: Record<string, CachedChromeEntry> = {};
		for (const [cwd, value] of Object.entries(parsed["byCwd"])) {
			if (!isJsonObject(value) || !isNumber(value["savedAt"]) || !Number.isFinite(value["savedAt"])) continue;
			const entry: CachedChromeEntry = { savedAt: value["savedAt"] };
			if (isString(value["modelLabel"])) entry.modelLabel = value["modelLabel"];
			if (isString(value["thinkingLevel"])) entry.thinkingLevel = value["thinkingLevel"];
			byCwd[cwd] = entry;
		}
		return { version: CACHE_VERSION, byCwd };
	} catch {
		return undefined;
	}
}

/** Reads only the last hydrate-derived chrome for this project, never throwing. */
export function readCachedChrome(cwd: string, options: ChromeCacheOptions = {}): CachedChrome | undefined {
	const entry = readCacheFile(options)?.byCwd[cwd];
	if (!entry) return undefined;
	const result: CachedChrome = {};
	if (entry.modelLabel !== undefined) result.modelLabel = entry.modelLabel;
	if (entry.thinkingLevel !== undefined) result.thinkingLevel = entry.thinkingLevel;
	return result;
}

/**
 * Persists hydrate-derived startup chrome as a best-effort hint. A broken or
 * inaccessible cache must never delay or fail the host's interactive boot.
 */
export function writeCachedChrome(cwd: string, chrome: CachedChrome, options: ChromeCacheOptions = {}): void {
	try {
		const path = cachePath(options);
		withPrivateFileLock(`${path}.lock`, () => {
			const existing = readCacheFile(options);
			const byCwd = { ...existing?.byCwd };
			const entry: CachedChromeEntry = { savedAt: (options.now ?? Date.now)() };
			if (chrome.modelLabel !== undefined) entry.modelLabel = chrome.modelLabel;
			if (chrome.thinkingLevel !== undefined) entry.thinkingLevel = chrome.thinkingLevel;
			byCwd[cwd] = entry;

			const retained = Object.entries(byCwd)
				.sort(([, left], [, right]) => left.savedAt - right.savedAt)
				.slice(-MAX_CACHED_CWDS);
			const cache: ChromeCacheFile = {
				version: CACHE_VERSION,
				byCwd: Object.fromEntries(retained),
			};
			atomicWritePrivateJson(path, cache);
		});
	} catch {
		// Cache persistence is deliberately advisory; startup must remain resilient.
	}
}
