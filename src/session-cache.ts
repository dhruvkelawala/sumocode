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
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { renderDiagnosticsCounters } from "./render-diagnostics.js";

export type SessionUsage = {
	readonly input: number;
	readonly output: number;
	readonly cost: number;
	readonly hasMessages: boolean;
};

export type GitRunner = (args: string[], cwd: string) => string;
export type AsyncGitRunner = (args: string[], cwd: string) => Promise<string>;

type Entry = {
	usage: SessionUsage | undefined;
	branch: string | null | undefined;
	asyncRefreshInFlight: boolean;
};

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
	for (const e of ctx.sessionManager.getBranch()) {
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
	entry.usage = { input, output, cost, hasMessages };
	return entry.usage;
}

export function sessionHasMessages(ctx: ExtensionContext): boolean {
	return getSessionUsage(ctx).hasMessages;
}

/**
 * Read-only cached git branch lookup. NEVER invokes `git` — always returns the
 * value most recently resolved by `refreshGitBranchSync` (called once on
 * `session_start`) or `refreshGitBranchAsync` (called on `agent_end`).
 *
 * Render-path callers (footer, sidebar, input-hints) use this so a `git`
 * fork+exec can never block a keystroke. Worst case while a refresh is in
 * flight: callers see the previous value, or `null` if the cache hasn't been
 * primed yet.
 */
export function getGitBranch(ctx: ExtensionContext): string | null {
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
		invalidateSessionUsage(ctx);
		// Pre-warm the branch synchronously here — we're outside the render path
		// so the fork+exec is fine, and it means the first keystroke already sees
		// a real value instead of `null` while the async resolver kicks in.
		refreshGitBranchSync(ctx);
	});
	pi.on("message_start", drop);
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
