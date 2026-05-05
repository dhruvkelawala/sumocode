/**
 * Per-session memo for values that footer/sidebar/top-chrome would otherwise
 * recompute on every keystroke.
 *
 * Pi triggers a re-render for every input event. Without caching:
 *   - footer + sidebar each iterate `sessionManager.getBranch()` to sum tokens
 *     (O(N) on every keystroke)
 *   - sidebar runs `git symbolic-ref` via `execFileSync` (a fork+exec —
 *     measured 0–60 ms each on macOS) on every keystroke
 *   - footer/sidebar/top-chrome each call `getBranch().some(...)` for
 *     `sessionHasMessages` (another O(N))
 *
 * That's 4–5 full branch walks plus a synchronous `git` exec per keypress
 * on long sessions — visible typing lag.
 *
 * This module caches those results behind a WeakMap keyed on the
 * ExtensionContext, and `installSessionCache(pi)` invalidates entries on
 * lifecycle events that can change them.
 */

import { execFile, execFileSync } from "node:child_process";
import type { ExtensionAPI, ExtensionContext, ReadonlyFooterDataProvider } from "@mariozechner/pi-coding-agent";
import { logDiagnostic } from "./sumo-tui/runtime/diagnostics.js";
import { renderDiagnosticsCounters } from "./render-diagnostics.js";

export type SessionUsage = {
	readonly input: number;
	readonly output: number;
	readonly cost: number;
	readonly hasMessages: boolean;
};

export type GitRunner = (args: string[], cwd: string) => string;
export type AsyncGitRunner = (args: string[], cwd: string) => Promise<string>;

export type GitBranchProvider = Pick<ReadonlyFooterDataProvider, "getGitBranch" | "onBranchChange">;

type Entry = {
	usage: SessionUsage | undefined;
	branch: string | null | undefined;
	asyncRefreshInFlight: boolean;
};

/**
 * Module-level flag: once ANY message_start fires in the current process,
 * `sessionHasMessages` returns true without needing the session branch.
 *
 * Why module-level instead of WeakMap-keyed-on-ctx:
 *   Pi creates a NEW ExtensionContext object per event handler invocation.
 *   The ctx from message_start differs from the ctx captured in the editor
 *   or top-chrome closure (session_start ctx), so WeakMap entries never match.
 *   A module-level flag works correctly because Pi runs one interactive
 *   session at a time.
 *
 * Reset on session_start so new sessions start clean.
 */
let liveSessionHasMessages = false;

const cache = new WeakMap<ExtensionContext, Entry>();

function entryFor(ctx: ExtensionContext): Entry {
	let entry = cache.get(ctx);
	if (!entry) {
		entry = { usage: undefined, branch: undefined, asyncRefreshInFlight: false };
		cache.set(ctx, entry);
	}
	return entry;
}

export function invalidateSessionUsage(ctx: ExtensionContext): void {
	const e = cache.get(ctx);
	if (e) e.usage = undefined;
	logDiagnostic("session_cache_invalidate", { liveSessionHasMessages });
}

export function noteSessionMessage(): void {
	liveSessionHasMessages = true;
	logDiagnostic("session_cache_note_message", { liveSessionHasMessages: true });
}

/** Reset the live-session flag. For use in tests and session_start only. */
export function resetLiveSessionHasMessages(): void {
	liveSessionHasMessages = false;
}

export function invalidateGitBranch(ctx: ExtensionContext): void {
	const e = cache.get(ctx);
	if (e) e.branch = undefined;
}

/**
 * Compute or return the cached session usage tally. Includes a `hasMessages`
 * flag so callers don't have to walk the branch a second time just to ask
 * "is there any message yet?".
 */
export function getSessionUsage(ctx: ExtensionContext): SessionUsage {
	const entry = entryFor(ctx);
	if (entry.usage) {
		renderDiagnosticsCounters.noteCacheHit();
		return entry.usage;
	}
	renderDiagnosticsCounters.noteCacheMiss();

	let input = 0;
	let output = 0;
	let cost = 0;
	let hasMessages = false;
	let branchLen = 0;
	for (const e of ctx.sessionManager.getBranch()) {
		branchLen += 1;
		if (e.type !== "message") continue;
		hasMessages = true;
		// Defensive: tests and edge sessions may carry partial message shapes.
		// Skip usage tally when fields are missing rather than throwing — the
		// `hasMessages` flag is the only thing several call sites depend on.
		const message = e.message as { role?: string; usage?: { input?: number; output?: number; cost?: { total?: number } } } | undefined;
		if (!message || message.role !== "assistant" || !message.usage) continue;
		input += message.usage.input ?? 0;
		output += message.usage.output ?? 0;
		cost += message.usage.cost?.total ?? 0;
	}
	const result = { input, output, cost, hasMessages: hasMessages || liveSessionHasMessages };
	logDiagnostic("session_cache_walk", { branchLen, hasMessagesFromWalk: hasMessages, liveSessionHasMessages, result: result.hasMessages });
	entry.usage = result;
	return entry.usage;
}

export function sessionHasMessages(ctx: ExtensionContext): boolean {
	// Fast path: if we've already seen a message_start, no need to walk the branch.
	if (liveSessionHasMessages) return true;
	return getSessionUsage(ctx).hasMessages;
}

/**
 * Module-level live branch provider, set by {@link linkGitBranchProvider}.
 * When linked, `getGitBranch()` returns this provider's live value directly —
 * file-watcher-driven — bypassing the ctx-keyed cache entirely.
 */
let linkedBranchProvider: GitBranchProvider | null = null;
let linkedProviderUnsubscribe: (() => void) | null = null;

/**
 * Link a live git branch provider so all `getGitBranch()` callers receive
 * file-watcher-driven updates instead of the ctx-keyed snapshot cache.
 *
 * Call from `installFooter` when Pi creates its `FooterDataProvider`.
 * Pass `null` to unlink (cleanup).
 */
export function linkGitBranchProvider(provider: GitBranchProvider | null): () => void {
	linkedProviderUnsubscribe?.();
	linkedProviderUnsubscribe = null;
	linkedBranchProvider = provider;
	if (!provider) return () => undefined;

	let active = true;
	linkedProviderUnsubscribe = provider.onBranchChange(() => {
		// When the branch changes live, notify render diagnostics so the next
		// render picks up the new value. The branch value itself is returned
		// directly from provider.getGitBranch() — no cache invalidation needed.
		renderDiagnosticsCounters.noteBranchChange();
	});

	return () => {
		if (!active) return;
		active = false;
		// Avoid an old footer/session disposal unlinking a newer provider.
		if (linkedBranchProvider !== provider) return;
		linkedProviderUnsubscribe?.();
		linkedProviderUnsubscribe = null;
		linkedBranchProvider = null;
	};
}

/**
 * Read-only git branch lookup.
 *
 * When a live {@link GitBranchProvider} is linked via {@link linkGitBranchProvider},
 * returns its current value directly — always fresh, file-watcher-driven.
 *
 * Otherwise falls back to the ctx-keyed cache populated by
 * `refreshGitBranchSync` (called once on `session_start`) or
 * `refreshGitBranchAsync` (called on `agent_end`).
 *
 * NEVER invokes `git` directly — a fork+exec can never block a keystroke.
 */
export function getGitBranch(ctx: ExtensionContext): string | null {
	if (linkedBranchProvider) return linkedBranchProvider.getGitBranch();

	const entry = entryFor(ctx);
	if (entry.branch === undefined) {
		renderDiagnosticsCounters.noteBranchCacheMiss();
		return null;
	}
	renderDiagnosticsCounters.noteBranchCacheHit();
	return entry.branch;
}

function resolveBranchSync(cwd: string, runGit: GitRunner): string | null {
	try {
		return runGit(["symbolic-ref", "--quiet", "--short", "HEAD"], cwd).trim() || null;
	} catch {
		try {
			const detached = runGit(["rev-parse", "--short", "HEAD"], cwd).trim();
			return detached ? "detached" : null;
		} catch {
			return null;
		}
	}
}

async function resolveBranchAsync(cwd: string, runGit: AsyncGitRunner): Promise<string | null> {
	try {
		const out = await runGit(["symbolic-ref", "--quiet", "--short", "HEAD"], cwd);
		return out.trim() || null;
	} catch {
		try {
			const out = await runGit(["rev-parse", "--short", "HEAD"], cwd);
			const detached = out.trim();
			return detached ? "detached" : null;
		} catch {
			return null;
		}
	}
}

/**
 * Resolve the git branch synchronously and cache it. Called once on
 * `session_start` so the first render already sees a value. Acceptable to
 * block here — we are NOT on the input/render path.
 */
export function refreshGitBranchSync(ctx: ExtensionContext, runGit: GitRunner = defaultSyncGitRunner): string | null {
	const entry = entryFor(ctx);
	const result = resolveBranchSync(ctx.cwd, runGit);
	entry.branch = result;
	return result;
}

/**
 * Resolve the git branch off the render thread and update the cache when it
 * lands. Multiple concurrent calls are coalesced via `asyncRefreshInFlight`.
 * Called on `agent_end` so any tool-driven `git checkout` is reflected
 * shortly after the turn completes.
 */
export function refreshGitBranchAsync(ctx: ExtensionContext, runGit: AsyncGitRunner = defaultAsyncGitRunner): Promise<string | null> {
	const entry = entryFor(ctx);
	if (entry.asyncRefreshInFlight) return Promise.resolve(entry.branch ?? null);
	entry.asyncRefreshInFlight = true;
	return resolveBranchAsync(ctx.cwd, runGit)
		.then((result) => {
			entry.branch = result;
			return result;
		})
		.finally(() => {
			entry.asyncRefreshInFlight = false;
		});
}

function defaultSyncGitRunner(args: string[], cwd: string): string {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	});
}

function defaultAsyncGitRunner(args: string[], cwd: string): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile("git", args, { cwd, encoding: "utf8" }, (error, stdout) => {
			if (error) reject(error);
			else resolve(stdout);
		});
	});
}

/**
 * Subscribe the cache to lifecycle events that mutate token usage or
 * `hasMessages`. Mount this once from `extension.ts`, ideally before any
 * consumer (footer/sidebar/top-chrome) installs.
 */
export function installSessionCache(pi: ExtensionAPI): void {
	const drop = (_event: unknown, ctx: ExtensionContext): void => {
		invalidateSessionUsage(ctx);
	};
	pi.on("session_start", (_event, ctx) => {
		// Reset module-level flag for the new session.
		liveSessionHasMessages = false;
		invalidateSessionUsage(ctx);
		// Resolve git branch off the startup path. Consumers tolerate `null` for
		// the first frame and update when the async resolver lands.
		void refreshGitBranchAsync(ctx).catch(() => undefined);
	});
	pi.on("message_start", () => {
		noteSessionMessage();
	});
	pi.on("message_end", drop);
	pi.on("agent_end", (_event, ctx) => {
		invalidateSessionUsage(ctx);
		// Refresh the branch off-thread — a turn may have included `git checkout`
		// via the bash tool. Errors are swallowed; the previous cached value
		// stays in place if `git` is absent or the cwd is no longer a repo.
		void refreshGitBranchAsync(ctx).catch(() => undefined);
	});
	pi.on("tool_result", drop);
	pi.on("session_compact", drop);
}
