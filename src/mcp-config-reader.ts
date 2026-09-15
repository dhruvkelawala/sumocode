import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { McpServerSnapshot } from "./sumo-tui/cathedral/sidebar-rendering.js";

/**
 * Reads the configured MCP server roster from disk, following the precedence
 * order documented by `pi-mcp-adapter`:
 *
 *   1. `~/.config/mcp/mcp.json`        — user-global shared MCP config
 *   2. `~/.agents/mcp.json`            — user-global `.agents` MCP config
 *   3. `~/.agents/mcp/mcp.json`        — user-global nested `.agents` MCP config
 *   4. `<Pi agent dir>/mcp.json`       — Pi global override (default `~/.pi/agent/mcp.json`)
 *   5. `<cwd>/.mcp.json`               — project-local shared MCP config
 *   6. `<cwd>/.pi/mcp.json`            — Pi project override
 *
 * Files are read in that order; later sources merge over earlier ones by
 * server name. The result is a roster of configured servers, each with a
 * status of `"idle"`. Pi 0.74's `ExtensionAPI` does not expose runtime MCP
 * connection state — see `docs/research/pi-fork-upgrade.md` and the comment
 * in `src/sidebar.ts` for the longer reasoning. `"idle"` is honest: it
 * reflects the configured-but-unconnected default for `pi-mcp-adapter`'s
 * lazy lifecycle.
 *
 * The reader tolerates missing files, malformed JSON, and missing
 * `mcpServers` keys silently — a broken or absent config should never
 * crash sidebar rendering.
 *
 * Known limitation: pi-mcp-adapter's `imports` field (which pulls server
 * configs from host-specific files like `cursor`, `claude-code`,
 * `claude-desktop`, `vscode`, `windsurf`, `codex`) is NOT resolved here.
 * Each host has its own config path layout per platform; replicating that
 * resolution is several hundred lines of host-aware code that v0.3 doesn't
 * carry. Users with `imports` in their config will see only the explicitly
 * listed `mcpServers`. The workaround is to run `pi-mcp-adapter init`,
 * which expands imports into `mcpServers` in `<piAgentDir>/mcp.json`
 * directly — once expanded, this reader picks them up. When `imports` is
 * present, `loadConfiguredMcpServers` emits a diagnostic event
 * (`mcp_imports_unresolved`) so the gap is visible in `SUMO_TUI_DIAG_FILE`
 * traces.
 */

interface McpServerConfig {
	readonly command?: string;
	readonly args?: readonly string[];
}

interface McpConfigFile {
	readonly mcpServers?: Record<string, McpServerConfig>;
	readonly "mcp-servers"?: Record<string, McpServerConfig>;
	readonly imports?: unknown;
}

export interface LoadMcpServersOptions {
	readonly cwd: string;
	readonly piAgentDir: string;
}

/** A configured MCP server definition exactly as written in a config file. */
export type McpServerDefinition = Readonly<Record<string, unknown>>;

export interface ConfiguredMcpServer {
	readonly name: string;
	readonly definition: McpServerDefinition;
}

/** `~/.agents` global config paths, mirroring `pi-mcp-adapter`'s own candidate list. */
function agentsGlobalConfigPaths(): readonly string[] {
	const home = homedir();
	return [join(home, ".agents", "mcp.json"), join(home, ".agents", "mcp", "mcp.json")];
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
		...agentsGlobalConfigPaths().filter((path) => path !== opts.piAgentDir),
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
		if (!parsed || !isObjectValue(parsed)) return undefined;
		// SAFETY: JSON.parse produced an object shape; only the mcpServers/imports
		// fields are read, and both are guarded before use below.
		return parsed as McpConfigFile;
	} catch {
		// Malformed JSON, permission denied, etc. \u2014 fail closed: no servers from this file.
		return undefined;
	}
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- predicate over parsed JSON; the typeof check is the sanctioned parse.
function isObjectValue(value: unknown): value is object {
	return typeof value === "object";
}

/**
 * Load the merged MCP server roster from the precedence chain. Returns an
 * empty array when no config files exist. Each server appears at most once;
 * a higher-precedence file (project) overrides a lower-precedence one (user
 * global) for a given server name.
 */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- predicate over parsed JSON values; the typeof check is the sanctioned parse.
function isPlainObject(value: unknown): value is object {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasNonEmptyImports(cfg: McpConfigFile): boolean {
	return Array.isArray(cfg.imports) && cfg.imports.length > 0;
}

/**
 * Hook for emitting a diagnostic when `imports` are present but unresolved.
 * Imported by tests via `setMcpDiagnosticHandler`; production wiring goes
 * through `src/sumo-tui/runtime/diagnostics.ts` via `setMcpDiagnosticHandler`
 * called once at extension boot. Keeping the dependency injected here
 * avoids a hard import cycle between this module and the runtime layer.
 */
export type McpDiagnosticHandler = (event: {
	readonly type: "mcp_imports_unresolved";
	readonly path: string;
	readonly importsCount: number;
}) => void;

let mcpDiagnosticHandler: McpDiagnosticHandler | undefined;

export function setMcpDiagnosticHandler(handler: McpDiagnosticHandler | undefined): void {
	mcpDiagnosticHandler = handler;
}

/**
 * Merge configured server definitions across the precedence chain, later
 * sources overriding earlier ones by server name.
 *
 * Unlike the sidebar roster this keeps the definitions: the subagent
 * capability hand-off must reproduce a selected server's definition verbatim,
 * because the child's generated config REPLACES its Pi-global layer rather
 * than adding to it.
 */
export function loadConfiguredMcpServerDefinitions(opts: LoadMcpServersOptions): readonly ConfiguredMcpServer[] {
	const merged = new Map<string, McpServerDefinition>();
	for (const path of resolveMcpConfigCandidates(opts)) {
		const servers = mcpServersOf(readMcpConfig(path));
		if (!servers) continue;
		for (const [name, definition] of Object.entries(servers)) {
			if (!isPlainObject(definition)) continue;
			// SAFETY: isPlainObject verified a non-array object; definitions are
			// re-serialized verbatim and never interpreted by this module.
			merged.set(name, definition as McpServerDefinition);
		}
	}
	return [...merged].map(([name, definition]) => ({ name, definition }));
}

function mcpServersOf(cfg: McpConfigFile | undefined): Record<string, McpServerConfig> | undefined {
	if (!cfg) return undefined;
	if (isPlainObject(cfg.mcpServers)) return cfg.mcpServers;
	const alias = cfg["mcp-servers"];
	return isPlainObject(alias) ? alias : undefined;
}

export function loadConfiguredMcpServers(opts: LoadMcpServersOptions): readonly McpServerSnapshot[] {
	const merged = new Map<string, McpServerSnapshot>();
	for (const path of resolveMcpConfigCandidates(opts)) {
		const cfg = readMcpConfig(path);
		if (!cfg) continue;
		if (hasNonEmptyImports(cfg)) {
			// pi-mcp-adapter would expand these at runtime; this reader doesn't.
			// Emit a diagnostic so the gap is traceable.
			mcpDiagnosticHandler?.({
				type: "mcp_imports_unresolved",
				path,
				// SAFETY: guarded by hasNonEmptyImports, which checks Array.isArray.
				importsCount: (cfg.imports as readonly unknown[]).length,
			});
		}
		// Guard against `mcpServers` being any non-object shape (string, array, number).
		// `Object.keys("oops")` produces synthetic numeric keys; `Object.keys(["github"])`
		// produces `["0"]`. Either would corrupt the roster with bogus server names.
		const servers = mcpServersOf(cfg);
		if (!servers) continue;
		for (const name of Object.keys(servers)) {
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
 * `/reload` respawns the process, so the cache flushes on its own
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
