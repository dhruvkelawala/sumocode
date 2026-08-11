import { join } from "node:path";
import {
	atomicWritePrivateJson,
	defaultActivityStateRoot,
	ensurePrivateSumocodeDirectory,
	readPrivateJson,
} from "../../activity/persistence.js";

const CACHE_VERSION = 1 as const;
const MAX_CACHED_CWDS = 20;
const MAX_CACHE_BYTES = 64 * 1024;

export interface CachedChrome {
	readonly modelLabel?: string;
	readonly thinkingLevel?: string;
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function readCacheFile(options: ChromeCacheOptions): ChromeCacheFile | undefined {
	try {
		const parsed = readPrivateJson(cachePath(options), MAX_CACHE_BYTES);
		if (!isRecord(parsed) || parsed.version !== CACHE_VERSION || !isRecord(parsed.byCwd)) return undefined;
		const byCwd: Record<string, CachedChromeEntry> = {};
		for (const [cwd, value] of Object.entries(parsed.byCwd)) {
			if (!isRecord(value) || typeof value.savedAt !== "number" || !Number.isFinite(value.savedAt)) continue;
			const entry: CachedChromeEntry = {
				savedAt: value.savedAt,
				...(typeof value.modelLabel === "string" ? { modelLabel: value.modelLabel } : {}),
				...(typeof value.thinkingLevel === "string" ? { thinkingLevel: value.thinkingLevel } : {}),
			};
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
	return {
		...(entry.modelLabel !== undefined ? { modelLabel: entry.modelLabel } : {}),
		...(entry.thinkingLevel !== undefined ? { thinkingLevel: entry.thinkingLevel } : {}),
	};
}

/**
 * Persists hydrate-derived startup chrome as a best-effort hint. A broken or
 * inaccessible cache must never delay or fail the host's interactive boot.
 */
export function writeCachedChrome(cwd: string, chrome: CachedChrome, options: ChromeCacheOptions = {}): void {
	try {
		const existing = readCacheFile(options);
		const byCwd = { ...(existing?.byCwd ?? {}) };
		const entry: CachedChromeEntry = {
			savedAt: (options.now ?? Date.now)(),
			...(typeof chrome.modelLabel === "string" ? { modelLabel: chrome.modelLabel } : {}),
			...(typeof chrome.thinkingLevel === "string" ? { thinkingLevel: chrome.thinkingLevel } : {}),
		};
		byCwd[cwd] = entry;

		const retained = Object.entries(byCwd)
			.sort(([, left], [, right]) => left.savedAt - right.savedAt)
			.slice(-MAX_CACHED_CWDS);
		const cache: ChromeCacheFile = {
			version: CACHE_VERSION,
			byCwd: Object.fromEntries(retained),
		};
		atomicWritePrivateJson(cachePath(options), cache);
	} catch {
		// Cache persistence is deliberately advisory; startup must remain resilient.
	}
}
