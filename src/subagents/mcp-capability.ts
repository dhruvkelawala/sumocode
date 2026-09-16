import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { defaultActivityStateRoot, ensurePrivateSumocodeDirectory, writePrivateJsonExclusive } from "../activity/persistence.js";
import { inspectMcpConfigSources, mergeMcpServerDefinitions, type McpServerDefinition } from "../mcp-config-reader.js";
import { adapterEntryFromPackageDir, packageDirsFromSettings, resolveMcpChildBootstrapEntry } from "./backend-pi.js";

import { MCP_GATEWAY_TOOL, MAX_MCP_SERVERS } from "./task-config.js";

const MCP_ADAPTER_PACKAGE = "pi-mcp-adapter";
/** Servers a role may name in one delegation. Bounds the generated config. */
const MAX_SERVER_NAME_BYTES = 128;
const CAPABILITIES_DIR = ["subagents", "capabilities"] as const;

/**
 * Resolved grant handed to a child launcher. Paths, never secret values.
 *
 * An absent `configPath` is the ambient scope: the child loads the adapter and
 * resolves its own config chain for its cwd, exactly as the parent session
 * does, so delegation never grants more than the operator already has. A
 * non-empty `servers` list switches to the fenced scope below.
 */
export interface McpLaunchCapability {
	/** Empty means ambient (the whole roster configured for the child's cwd). */
	readonly servers: readonly string[];
	readonly adapterEntry: string;
	/** SumoCode-owned guard that exits a child whose gateway never registered. */
	readonly guardEntry: string;
	readonly configPath?: string;
	/**
	 * True when a role asked for the gateway by name. A required grant that does
	 * not register stops the child; an inherited one only warns.
	 */
	readonly required: boolean;
}

export type McpCapabilityResolution =
	| { readonly ok: true; readonly capability: McpLaunchCapability | undefined }
	| { readonly ok: false; readonly error: string };

export interface McpCapabilityRequest {
	/** Whether the resolved child tool surface includes the MCP gateway. */
	readonly gatewayRequested: boolean;
	/**
	 * True when somebody asked for the gateway by name: a role's `tools` listed
	 * `mcp`, or a non-empty `mcpServers` selection fenced its scope. Only an
	 * explicit grant refuses the spawn when it cannot be honoured; the inherited
	 * one degrades to a child without MCP, which is the pre-#569 status quo.
	 */
	readonly explicit?: boolean;
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
			// An explicit override that cannot be read fails closed: silently
			// falling back to a different adapter would mount something the
			// operator did not name.
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
 * The fenced scope bounds which servers a child can reach AND which definitions
 * reach it: project-local MCP is the intended source for a checkout's own
 * servers (issue #568), so a project may introduce names, but it may neither
 * name a server the grant does not select nor redefine a name this session
 * defines globally. Both are refused, because project files merge above the
 * generated one and would win at runtime.
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
	const normalized = normalizeServers(request.servers);
	if (!normalized.ok) return { ok: false, error: normalized.error };
	const servers = normalized.names;
	if (!request.gatewayRequested) {
		return servers.length > 0
			? { ok: false, error: `MCP servers ${servers.join(", ")} were selected, but this session has no active ${MCP_GATEWAY_TOOL} tool to scope them to` }
			: { ok: true, capability: undefined };
	}
	const env = request.env ?? process.env;
	const adapterEntry = resolveMcpAdapterEntry(env);
	const guardEntry = resolveMcpChildBootstrapEntry(env);
	if (!adapterEntry || !guardEntry) {
		const reason = !adapterEntry
			? `the ${MCP_ADAPTER_PACKAGE} extension could not be located in the trusted global scope (set SUMOCODE_MCP_ADAPTER to its package directory to name it explicitly)`
			: "the child-side capability guard could not be located";
		if (request.explicit !== true) {
			// Inherited, not asked for: a child without MCP is the status quo
			// this delegation always had, not a failure worth refusing over.
			return { ok: true, capability: undefined };
		}
		return { ok: false, error: `MCP was requested explicitly but ${reason}` };
	}
	const chain = { cwd: request.cwd, piAgentDir: env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent") };
	// Scoped grants only: the ambient path deliberately reads nothing, because
	// it fences nothing.
	const sources = servers.length > 0 ? inspectMcpConfigSources(chain) : [];
	const unsupportedImports = sources.filter((source) => source.imports.length > 0);
	if (unsupportedImports.length > 0) {
		const paths = unsupportedImports.map((source) => source.path).sort().join(", ");
		return { ok: false, error: `MCP cannot be scoped while ${paths} uses \`imports\`; run \`pi-mcp-adapter init\` to expand them into mcpServers first` };
	}
	// Project files merge ABOVE the generated one, so they are outside the fence:
	// they can disable:false a fenced name, and they override a selected name's
	// definition outright — including one this session already defines globally,
	// whose credentials a partial override would then inherit. Refuse both,
	// because a name a repository can repoint is not the server the operator
	// selected.
	const globalNames = new Set(mergeMcpServerDefinitions(sources.filter((source) => source.scope === "global")).map((server) => server.name));
	const projectNames = sources.filter((source) => source.scope === "project");
	const unbounded = projectNames.flatMap((source) => source.servers
		.filter((name) => !servers.includes(name) || globalNames.has(name))
		.map((name) => ({ name, path: source.path, repoints: globalNames.has(name) && servers.includes(name) })));
	if (unbounded.length > 0) {
		const detail = unbounded.map((entry) => `${entry.name} (${entry.path})`).join(", ");
		return { ok: false, error: `MCP cannot be scoped while project configuration defines ${detail}. Project files name servers this grant does not select, or redefine one this session already defines; select them explicitly or remove them` };
	}
	// One read feeds both the refusals above and the file below: a second read
	// could hand the child definitions the validation never saw.
	//
	// A project file may INTRODUCE a server the operator does not define —
	// project-local MCP is the intended source for a checkout's own servers —
	// but a name it redefines was already refused above, so nothing here can
	// hand the child a repository-authored definition of a trusted name.
	const available = new Map(mergeMcpServerDefinitions(sources).map((server) => [server.name, server.definition]));
	const missing = servers.filter((name) => !available.has(name));
	if (missing.length > 0) {
		const known = [...available.keys()].sort().join(", ") || "(none)";
		return { ok: false, error: `MCP server(s) not configured for ${request.cwd}: ${missing.join(", ")}. Configured servers: ${known}` };
	}
	if (servers.length === 0) {
		// Ambient scope: the child resolves the same chain a session in its own
		// cwd resolves, so it reaches nothing the operator could not reach there.
		// No file is written and nothing is fenced.
		//
		// ACCEPTED RISK (owner decision, #569): the child's cwd is chosen by the
		// delegating model (`working_dir`) or by a worktree remap, so a project
		// `<cwd>/.mcp.json` becomes a command line the child starts without an
		// approval gate — while `resolveMcpAdapterEntry` below refuses
		// project-scoped candidates for `-e`. The asymmetry is deliberate:
		//   - an extension runs arbitrary code inside the child process, before
		//     any tool gate, so it stays trusted-scope only;
		//   - a server command is a subprocess, and every role already holds
		//     `bash`, so ambient MCP grants the child no authority it lacked.
		// A caller who wants the project config fenced names servers in the
		// role's `mcpServers`, which takes the strict branch below.
		return { ok: true, capability: { servers: [], adapterEntry, guardEntry, required: request.explicit === true } };
	}
	try {
		const configPath = writeScopedMcpConfig(request.key, available, servers, env);
		return { ok: true, capability: { servers, adapterEntry, guardEntry, configPath, required: request.explicit === true } };
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
	available: ReadonlyMap<string, McpServerDefinition>,
	selected: readonly string[],
	env: NodeJS.ProcessEnv,
): string {
	const mcpServers: Record<string, McpServerDefinition | { readonly disabled: true }> = Object.create(null);
	for (const name of selected) {
		const definition = available.get(name);
		if (definition !== undefined) mcpServers[name] = definition;
	}
	for (const name of available.keys()) {
		if (!selected.includes(name)) mcpServers[name] = { disabled: true };
	}
	const directory = ensurePrivateSumocodeDirectory([...CAPABILITIES_DIR], defaultActivityStateRoot(env));
	// A nonce, not just the subagent id: ids restart their counter per process,
	// so an id-only filename would collide the second session that spawns the
	// same title against an artifact nothing deletes.
	const configPath = join(directory, `${key}-${randomUUID()}.json`);
	writePrivateJsonExclusive(configPath, { mcpServers, settings: { hostConfigDiscovery: "off", agentPluginPaths: [] } });
	return configPath;
}

/**
 * A role's server list is a grant, so a name the resolver cannot honour is a
 * refusal, never a quiet narrowing: an operator who mistypes a server must not
 * receive a child with a different capability than they asked for.
 */
function normalizeServers(servers: readonly string[] | undefined): { ok: true; names: string[] } | { ok: false; error: string } {
	if (!servers) return { ok: true, names: [] };
	const names: string[] = [];
	const invalid: string[] = [];
	for (const raw of servers) {
		const name = raw.trim();
		if (!validServerName(name)) {
			invalid.push(JSON.stringify(raw));
			continue;
		}
		if (!names.includes(name)) names.push(name);
	}
	if (invalid.length > 0) return { ok: false, error: `invalid MCP server name(s): ${invalid.join(", ")}` };
	if (names.length > MAX_MCP_SERVERS) return { ok: false, error: `too many MCP servers selected: ${names.length} exceeds the ${MAX_MCP_SERVERS} limit` };
	return { ok: true, names };
}
