import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { defaultActivityStateRoot, ensurePrivateSumocodeDirectory, writePrivateJsonExclusive } from "../activity/persistence.js";
import { inspectMcpConfigSources, loadConfiguredMcpServerDefinitions, type ConfiguredMcpServer } from "../mcp-config-reader.js";
import { adapterEntryFromPackageDir, packageDirsFromSettings, resolveMcpChildBootstrapEntry } from "./backend-pi.js";

/**
 * The MCP gateway tool registered by `pi-mcp-adapter`. MCP is not a Pi
 * built-in: without that extension loaded and this name in `--tools`, a child
 * has no MCP surface at all.
 */
export const MCP_GATEWAY_TOOL = "mcp";
const MCP_ADAPTER_PACKAGE = "pi-mcp-adapter";
/** Servers a role may name in one delegation. Bounds the generated config. */
const MAX_MCP_SERVERS = 256;
const MAX_SERVER_NAME_BYTES = 128;
const CAPABILITIES_DIR = ["subagents", "capabilities"] as const;

/** Resolved grant handed to a child launcher. Paths, never secret values. */
export interface McpLaunchCapability {
	readonly servers: readonly string[];
	readonly adapterEntry: string;
	/** SumoCode-owned guard that exits a child whose gateway never registered. */
	readonly guardEntry: string;
	readonly configPath: string;
}

export type McpCapabilityResolution =
	| { readonly ok: true; readonly capability: McpLaunchCapability | undefined }
	| { readonly ok: false; readonly error: string };

export interface McpCapabilityRequest {
	/** Whether the resolved child tool surface includes the MCP gateway. */
	readonly gatewayRequested: boolean;
	/** Servers the role explicitly selected; `undefined` when the role named none. */
	readonly servers: readonly string[] | undefined;
	/** The child's final cwd (after any worktree remap), which selects project config. */
	readonly cwd: string;
	/** Subagent id, used as the exclusive filename of the generated config. */
	readonly key: string;
	readonly env?: NodeJS.ProcessEnv;
}

/**
 * Locate `pi-mcp-adapter`'s extension entry using trusted-scope candidates only.
 *
 * Project-scoped candidates (`<cwd>/.pi/...`) are deliberately excluded for the
 * same reason `resolveClaudeOauthAdapterEntry` excludes them: a hostile
 * repository could otherwise name repository-controlled code that children
 * boot-load through `-e`, which is the boundary `--no-extensions` protects.
 * `SUMOCODE_MCP_ADAPTER` is the escape hatch for a project-local install.
 */
export function resolveMcpAdapterEntry(env: NodeJS.ProcessEnv = process.env): string | undefined {
	const override = env.SUMOCODE_MCP_ADAPTER?.trim();
	if (override) {
		try {
			const stat = statSync(override);
			if (stat.isFile()) return override;
			if (stat.isDirectory()) return adapterEntryFromPackageDir(override);
		} catch {
			// Unreadable override falls through to configured candidates.
		}
		return undefined;
	}
	const agentDir = env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	const candidateDirs = [
		...packageDirsFromSettings(join(agentDir, "settings.json"), agentDir, MCP_ADAPTER_PACKAGE),
		join(agentDir, "npm", "node_modules", MCP_ADAPTER_PACKAGE),
	];
	for (const dir of candidateDirs) {
		const entry = adapterEntryFromPackageDir(dir);
		if (entry) return entry;
	}
	return undefined;
}

const validServerName = (name: string): boolean =>
	name.length > 0 && name === name.trim() && Buffer.byteLength(name, "utf8") <= MAX_SERVER_NAME_BYTES
		// oxlint-disable-next-line no-control-regex -- config keys stay single-line and printable.
		&& !/[\x00-\x1f\x7f]/u.test(name);

/**
 * Build the private, per-child MCP config from the servers a role selected.
 *
 * The generated file becomes the child's Pi-global MCP layer, so it must
 * (a) carry the selected servers' definitions verbatim, because their original
 * source may have been the Pi-global file this replaces, and (b) carry every
 * other server this resolver could see as `disabled: true` — the adapter's
 * per-server fence — so ambient global configuration cannot reach the child
 * through the gateway proxy. Lower-precedence ambient sources still merge
 * underneath, and a higher-precedence project file may redefine a disabled
 * server's transport, but `disabled` is inherited by those partial overrides.
 *
 * Two ambient sources cannot be bounded from here and are REFUSED instead of
 * fenced, because a silently wider child is worse than a refused spawn:
 *   - `imports`: the adapter expands host configs (`~/.claude.json`, cursor,
 *     codex, …) per source, which this reader deliberately does not parse.
 *   - any project-scoped file (`<cwd>/.mcp.json`, `<cwd>/.pi/mcp.json`)
 *     naming a server that was not selected: project files merge ABOVE this
 *     one, so they can drop the `disabled` fence.
 * The generated file also pins `hostConfigDiscovery` off and clears
 * `agentPluginPaths`, which are the two settings that could otherwise add
 * servers after the file chain is merged.
 *
 * Known residual, documented in the PR: servers contributed by package
 * manifests (`pi.mcp`) and settings from higher-precedence project files are
 * outside this resolver's chain.
 *
 * The file repeats whatever the source config held, including inline
 * credentials (`bearerToken`, `headers`, `env`). That is deliberate — the
 * adapter needs usable definitions, not references — and it stays inside the
 * same owner-only artifact boundary as the original config. The descriptor that
 * crosses into task metadata carries only the path and the server names, never
 * a definition. These artifacts are retained alongside their task evidence and
 * are not garbage-collected yet.
 */
export function resolveMcpLaunchCapability(request: McpCapabilityRequest): McpCapabilityResolution {
	const servers = normalizeServers(request.servers);
	if (!request.gatewayRequested) {
		return servers.length > 0
			? { ok: false, error: `MCP servers ${servers.join(", ")} were selected without granting the ${MCP_GATEWAY_TOOL} tool` }
			: { ok: true, capability: undefined };
	}
	if (servers.length === 0) {
		// Fail closed: granting the gateway without naming servers would expose
		// every configured server through the proxy, which is the exact
		// "unrestricted proxy over ambient configuration" this capability exists
		// to prevent.
		return { ok: false, error: `the ${MCP_GATEWAY_TOOL} tool requires an explicit mcpServers list naming the servers this child may use` };
	}
	const env = request.env ?? process.env;
	const adapterEntry = resolveMcpAdapterEntry(env);
	if (!adapterEntry) {
		return { ok: false, error: `MCP was granted but the ${MCP_ADAPTER_PACKAGE} extension could not be located in the trusted global scope` };
	}
	const guardEntry = resolveMcpChildBootstrapEntry(env);
	if (!guardEntry) {
		// Fail closed rather than launch a child that would silently keep the
		// gateway scope nobody validated at startup.
		return { ok: false, error: "MCP was granted but the child-side capability guard could not be located" };
	}
	const chain = { cwd: request.cwd, piAgentDir: env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent") };
	const unsupportedImports = inspectMcpConfigSources(chain).filter((source) => source.imports.length > 0);
	if (unsupportedImports.length > 0) {
		const paths = unsupportedImports.map((source) => source.path).sort().join(", ");
		return { ok: false, error: `MCP cannot be scoped while ${paths} uses \`imports\`; run \`pi-mcp-adapter init\` to expand them into mcpServers first` };
	}
	const unbounded = inspectMcpConfigSources(chain)
		.filter((source) => source.scope === "project")
		.flatMap((source) => source.servers.filter((name) => !servers.includes(name)).map((name) => ({ name, path: source.path })));
	if (unbounded.length > 0) {
		// Project files merge above the generated one, so they can clear a
		// `disabled` fence; a repo could otherwise reach the gateway this grant
		// was supposed to bound.
		const detail = unbounded.map((entry) => `${entry.name} (${entry.path})`).join(", ");
		return { ok: false, error: `MCP cannot be scoped while project configuration defines unselected server(s): ${detail}. Select them explicitly or remove them` };
	}
	const configured = loadConfiguredMcpServerDefinitions(chain);
	const available = new Map(configured.map((server) => [server.name, server.definition]));
	const missing = servers.filter((name) => !available.has(name));
	if (missing.length > 0) {
		const known = configured.map((server) => server.name).sort().join(", ") || "(none)";
		return { ok: false, error: `MCP server(s) not configured for ${request.cwd}: ${missing.join(", ")}. Configured servers: ${known}` };
	}
	try {
		const configPath = writeScopedMcpConfig(request.key, configured, servers, env);
		return { ok: true, capability: { servers, adapterEntry, guardEntry, configPath } };
	} catch (error) {
		return { ok: false, error: `unable to write the MCP capability config: ${error instanceof Error ? error.message : String(error)}` };
	}
}

/**
 * Publish the per-child config: the selected servers verbatim, every other
 * server this resolver saw explicitly disabled, and the two settings that
 * could re-add servers after the file chain merges.
 *
 * A null-prototype map keeps a server literally named `__proto__` a real key
 * instead of an assignment to the object's prototype (which would silently
 * drop it from the file).
 */
function writeScopedMcpConfig(
	key: string,
	configured: readonly ConfiguredMcpServer[],
	selected: readonly string[],
	env: NodeJS.ProcessEnv,
): string {
	const mcpServers = Object.create(null) as Record<string, unknown>;
	for (const name of selected) mcpServers[name] = configured.find((server) => server.name === name)?.definition;
	for (const server of configured) {
		if (!selected.includes(server.name)) mcpServers[server.name] = { disabled: true };
	}
	const directory = ensurePrivateSumocodeDirectory([...CAPABILITIES_DIR], defaultActivityStateRoot(env));
	// A nonce keeps the exclusive create honest across processes: subagent ids
	// restart their counter, and nothing reuses a task directory.
	const configPath = join(directory, `${key}-${randomUUID()}.json`);
	if (existsSync(configPath)) throw new Error(`capability config already exists for ${key}`);
	writePrivateJsonExclusive(configPath, { mcpServers, settings: { hostConfigDiscovery: "off", agentPluginPaths: [] } });
	return configPath;
}

function normalizeServers(servers: readonly string[] | undefined): string[] {
	if (!servers) return [];
	const names: string[] = [];
	for (const raw of servers) {
		const name = raw.trim();
		if (!validServerName(name) || names.includes(name)) continue;
		names.push(name);
		if (names.length >= MAX_MCP_SERVERS) break;
	}
	return names;
}
