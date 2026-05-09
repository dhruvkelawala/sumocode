import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { McpServerSnapshot } from "./sumo-tui/cathedral/sidebar-rendering.js";

/**
 * Reads the configured MCP server roster from disk, following the precedence
 * order documented by `pi-mcp-adapter`:
 *
 *   1. `~/.config/mcp/mcp.json`        — user-global shared MCP config
 *   2. `<Pi agent dir>/mcp.json`       — Pi global override (default `~/.pi/agent/mcp.json`)
 *   3. `<cwd>/.mcp.json`               — project-local shared MCP config
 *   4. `<cwd>/.pi/mcp.json`            — Pi project override
 *
 * Files are read in that order; later sources merge over earlier ones by
 * server name. The result is a roster of configured servers, each with a
 * status of `"idle"`. Pi 0.74's `ExtensionAPI` does not expose runtime MCP
 * connection state \u2014 see `docs/research/pi-fork-upgrade.md` and the comment
 * in `src/sidebar.ts` for the longer reasoning. `"idle"` is honest: it
 * reflects the configured-but-unconnected default for `pi-mcp-adapter`'s
 * lazy lifecycle.
 *
 * The reader tolerates missing files, malformed JSON, and missing
 * `mcpServers` keys silently \u2014 a broken or absent config should never
 * crash sidebar rendering.
 */

interface McpConfigFile {
	readonly mcpServers?: Record<string, unknown>;
}

export interface LoadMcpServersOptions {
	readonly cwd: string;
	readonly piAgentDir: string;
}

/**
 * Resolve the four candidate config paths in precedence order.
 *
 * Exposed for tests; production callers should use `loadConfiguredMcpServers`.
 */
export function resolveMcpConfigCandidates(opts: LoadMcpServersOptions): readonly string[] {
	const home = homedir();
	return [
		join(home, ".config", "mcp", "mcp.json"),
		join(opts.piAgentDir, "mcp.json"),
		join(opts.cwd, ".mcp.json"),
		join(opts.cwd, ".pi", "mcp.json"),
	];
}

function readMcpConfig(path: string): McpConfigFile | undefined {
	try {
		if (!existsSync(path)) return undefined;
		const raw = readFileSync(path, "utf8");
		const parsed: unknown = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object") return undefined;
		return parsed as McpConfigFile;
	} catch {
		// Malformed JSON, permission denied, etc. \u2014 fail closed: no servers from this file.
		return undefined;
	}
}

/**
 * Load the merged MCP server roster from the precedence chain. Returns an
 * empty array when no config files exist. Each server appears at most once;
 * a higher-precedence file (project) overrides a lower-precedence one (user
 * global) for a given server name.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function loadConfiguredMcpServers(opts: LoadMcpServersOptions): readonly McpServerSnapshot[] {
	const merged = new Map<string, McpServerSnapshot>();
	for (const path of resolveMcpConfigCandidates(opts)) {
		const cfg = readMcpConfig(path);
		// Guard against `mcpServers` being any non-object shape (string, array, number).
		// `Object.keys("oops")` produces synthetic numeric keys; `Object.keys(["github"])`
		// produces `["0"]`. Either would corrupt the roster with bogus server names.
		if (!cfg || !isPlainObject(cfg.mcpServers)) continue;
		for (const name of Object.keys(cfg.mcpServers)) {
			merged.set(name, { name, status: "idle" });
		}
	}
	return [...merged.values()];
}

/**
 * Cache keyed by (cwd, piAgentDir). Different sessions can run against
 * different working directories — Pi's `session_before_switch` /
 * `session_start` events fire when switching, and `ctx.cwd` is
 * session-scoped. A single-slot cache would leak project A's roster into
 * project B after a session switch and break the precedence contract.
 */
const cachedRosters = new Map<string, readonly McpServerSnapshot[]>();

function cacheKey(opts: LoadMcpServersOptions): string {
	return `${opts.cwd}\u0000${opts.piAgentDir}`;
}

/**
 * Cached variant of `loadConfiguredMcpServers`. Reads once per
 * (cwd, piAgentDir) pair and memoizes. Sidebar snapshots are built on
 * every paint, so re-reading four JSON files per tick would be wasteful.
 * `/sumo:reload` respawns the process, so the cache flushes on its own
 * when Dhruv hot-reloads. Session switches inside the same process get a
 * fresh read because the cache key changes with `ctx.cwd`.
 *
 * Tests can call `clearCachedMcpRoster()` between cases.
 */
export function getCachedMcpRoster(opts: LoadMcpServersOptions): readonly McpServerSnapshot[] {
	const key = cacheKey(opts);
	let roster = cachedRosters.get(key);
	if (roster === undefined) {
		roster = loadConfiguredMcpServers(opts);
		cachedRosters.set(key, roster);
	}
	return roster;
}

export function clearCachedMcpRoster(): void {
	cachedRosters.clear();
}
