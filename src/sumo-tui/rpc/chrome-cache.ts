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
const MAX_CACHED_MODELS = 256;
const MAX_CACHED_THINKING_LEVELS = 16;

/** Model identity only: the cycle ring derives its label from provider/id. */
export interface CachedModelRef {
	readonly provider: string;
	readonly id: string;
}

export interface CachedChrome {
	modelLabel?: string;
	thinkingLevel?: string;
	/**
	 * Enabled-model ring from the last hydrate. Initial hydration owns the
	 * authoritative chrome, so before it settles the cycle keys step through
	 * this last-known ring instead (issue 448); the choice reconciles against
	 * the live list once hydration commits.
	 */
	models?: readonly CachedModelRef[];
	/** Available thinking levels from the last hydrate; same pre-hydration seam. */
	thinkingLevels?: readonly string[];
}

interface CachedChromeEntry {
	readonly savedAt: number;
	modelLabel?: string;
	thinkingLevel?: string;
}

interface ChromeCacheFile {
	readonly version: typeof CACHE_VERSION;
	readonly byCwd: Record<string, CachedChromeEntry>;
	// The child reports one model list per process, not per project, so the
	// cycle rings are stored once instead of duplicated into every cwd entry.
	readonly models?: readonly CachedModelRef[];
	readonly thinkingLevels?: readonly string[];
	/** Model label the stored thinking ring was reported for. */
	readonly thinkingLevelsFor?: string;
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

function cachedModelRefs(value: JsonValue | undefined): CachedModelRef[] | undefined {
	if (!Array.isArray(value) || value.length === 0 || value.length > MAX_CACHED_MODELS) return undefined;
	const models: CachedModelRef[] = [];
	for (const entry of value) {
		if (!isJsonObject(entry) || !isString(entry["provider"]) || !isString(entry["id"])) return undefined;
		models.push({ provider: entry["provider"], id: entry["id"] });
	}
	return models;
}

function cachedThinkingLevels(value: JsonValue | undefined): string[] | undefined {
	if (!Array.isArray(value) || value.length === 0 || value.length > MAX_CACHED_THINKING_LEVELS) return undefined;
	return value.every(isString) ? [...value] : undefined;
}

/** Drops an oversized ring: one huge entry would push the whole file past MAX_CACHE_BYTES and disable the cache. */
function cappedRing<T>(values: readonly T[] | undefined, max: number): readonly T[] | undefined {
	return values !== undefined && values.length > 0 && values.length <= max ? values : undefined;
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
		const models = cachedModelRefs(parsed["models"]);
		const thinkingLevels = cachedThinkingLevels(parsed["thinkingLevels"]);
		const thinkingLevelsFor = isString(parsed["thinkingLevelsFor"]) ? parsed["thinkingLevelsFor"] : undefined;
		return {
			version: CACHE_VERSION,
			byCwd,
			models,
			// An unstamped ring cannot be tied to a model, so it is unusable.
			thinkingLevels: thinkingLevels !== undefined && thinkingLevelsFor !== undefined ? thinkingLevels : undefined,
			thinkingLevelsFor,
		};
	} catch {
		return undefined;
	}
}

/** Reads only the last hydrate-derived chrome for this project, never throwing. */
export function readCachedChrome(cwd: string, options: ChromeCacheOptions = {}): CachedChrome | undefined {
	const file = readCacheFile(options);
	const entry = file?.byCwd[cwd];
	if (!file || !entry) return undefined;
	const result: CachedChrome = {};
	if (entry.modelLabel !== undefined) result.modelLabel = entry.modelLabel;
	if (entry.thinkingLevel !== undefined) result.thinkingLevel = entry.thinkingLevel;
	if (file.models !== undefined) result.models = file.models;
	// The thinking ring is only usable beside the model it was reported for.
	if (file.thinkingLevels !== undefined && file.thinkingLevelsFor !== undefined && file.thinkingLevelsFor === entry.modelLabel) {
		result.thinkingLevels = file.thinkingLevels;
	}
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
			// A write that carries no model ring (an optimistic chrome paint before
			// the child list is known) keeps the stored one: the list is stable across
			// model switches. Project to identity refs at this boundary -- callers hand
			// over the child's full model records, whose extra fields would bloat the
			// file past its read cap and persist data this cache never needed.
			const models = cappedRing(chrome.models, MAX_CACHED_MODELS)
				?.map((model) => ({ provider: model.provider, id: model.id }))
				?? existing?.models;
			// The thinking ring is coupled to the active model: a fresh ring is
			// stamped with the label it was fetched under, and a write with no fresh
			// ring keeps the stored one only while that label still matches, so a
			// model switch drops it instead of pairing the new label with levels it
			// may not support.
			const freshLevels = cappedRing(chrome.thinkingLevels, MAX_CACHED_THINKING_LEVELS);
			const thinkingLevels = freshLevels
				?? (existing?.thinkingLevelsFor === chrome.modelLabel ? existing?.thinkingLevels : undefined);
			const cache: ChromeCacheFile = {
				version: CACHE_VERSION,
				byCwd: Object.fromEntries(retained),
				models,
				thinkingLevels,
				thinkingLevelsFor: thinkingLevels !== undefined ? chrome.modelLabel : undefined,
			};
			atomicWritePrivateJson(path, cache);
		});
	} catch {
		// Cache persistence is deliberately advisory; startup must remain resilient.
	}
}
