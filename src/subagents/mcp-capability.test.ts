import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { loadConfiguredMcpServerDefinitions, type McpServerDefinition } from "../mcp-config-reader.js";
import { resolveMcpAdapterEntry, resolveMcpLaunchCapability } from "./mcp-capability.js";

afterEach(() => { vi.unstubAllEnvs(); });

interface Fixture {
	readonly root: string;
	readonly cwd: string;
	readonly agentDir: string;
	readonly adapterEntry: string;
}

/**
 * Hermetic HOME/agent-dir/state-dir so the precedence chain, the private
 * artifact directory and the adapter lookup are all inside one temp root.
 */
function fixture(options: { readonly withAdapter?: boolean; readonly withServer?: boolean } = {}): Fixture {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "sumocode-mcp-capability-")));
	const cwd = join(root, "project");
	const agentDir = join(root, ".pi", "agent");
	const stateDir = join(root, "state");
	for (const dir of [cwd, agentDir, stateDir]) mkdirSync(dir, { recursive: true, mode: 0o700 });
	vi.stubEnv("HOME", root);
	vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
	vi.stubEnv("SUMOCODE_STATE_DIR", stateDir);
	const adapterDir = join(root, "adapter");
	const adapterEntry = join(adapterDir, "index.ts");
	if (options.withAdapter !== false) {
		mkdirSync(adapterDir, { recursive: true, mode: 0o700 });
		writeFileSync(join(adapterDir, "package.json"), JSON.stringify({ name: "pi-mcp-adapter", pi: { extensions: ["./index.ts"] } }), { mode: 0o600 });
		writeFileSync(adapterEntry, "export default () => undefined;\n", { mode: 0o600 });
		vi.stubEnv("SUMOCODE_MCP_ADAPTER", adapterDir);
	}
	if (options.withServer !== false) {
		writeFileSync(join(cwd, ".mcp.json"), JSON.stringify({
			mcpServers: { fixture: { command: "node", args: ["./fixture-server.mjs"] } },
		}), { mode: 0o600 });
		// Ambient global roster, which a scoped grant must fence off.
		writeFileSync(join(agentDir, "mcp.json"), JSON.stringify({
			mcpServers: { other: { command: "node", args: ["./other-server.mjs"] } },
		}), { mode: 0o600 });
	}
	return { root, cwd, agentDir, adapterEntry };
}

const resolve = (f: Fixture, servers: readonly string[] | undefined, key = "sa-test") => resolveMcpLaunchCapability({
	gatewayRequested: true, servers, cwd: f.cwd, key, env: process.env,
});

it("grants nothing and writes nothing when the gateway was not requested", () => {
	const f = fixture();
	const result = resolveMcpLaunchCapability({ gatewayRequested: false, servers: undefined, cwd: f.cwd, key: "sa-none" });
	expect(result).toEqual({ ok: true, capability: undefined });
	expect(existsSync(join(f.root, "state", "sumocode", "subagents", "capabilities"))).toBe(false);
});

it("grants the ambient scope when no servers are named", () => {
	const f = fixture();
	for (const servers of [undefined, []]) {
		const result = resolve(f, servers, "sa-ambient");
		if (!result.ok || !result.capability) throw new Error(`expected an ambient grant: ${result.ok === false ? result.error : ""}`);
		// Ambient reads nothing, fences nothing, and writes nothing: the child
		// resolves the same chain its parent resolves for that cwd.
		expect(result.capability.servers).toEqual([]);
		expect(result.capability.configPath).toBeUndefined();
	}
	// Nothing was created: ambient grants touch no state.
	expect(existsSync(join(f.root, "state", "sumocode", "subagents", "capabilities"))).toBe(false);
});

it("keeps the ambient grant free of the scoped path's refusals", () => {
	const f = fixture();
	// Sources the scoped path refuses (imports, unselected project servers)
	// cannot widen an ambient child: it never reads them to begin with.
	writeFileSync(join(f.agentDir, "mcp.json"), JSON.stringify({ mcpServers: {}, imports: ["claude-code"] }), { mode: 0o600 });
	writeFileSync(join(f.cwd, ".mcp.json"), JSON.stringify({ mcpServers: { sneaky: { command: "node" } } }), { mode: 0o600 });
	const result = resolve(f, undefined, "sa-ambient-2");
	expect(result.ok).toBe(true);
});

it("refuses rather than silently narrowing a malformed or oversized selection", () => {
	const f = fixture();
	for (const servers of [["   "], ["fixture", "bad\nname"], ["fixture", ""]]) {
		const result = resolve(f, servers);
		expect(result.ok).toBe(false);
		expect(result.ok === false && result.error).toContain("invalid MCP server name");
	}
	const oversized = Array.from({ length: 257 }, (_value, index) => `server-${index}`);
	const result = resolve(f, oversized);
	expect(result.ok).toBe(false);
	expect(result.ok === false && result.error).toContain("too many MCP servers selected");
});

it("refuses server names that were selected without granting the gateway", () => {
	const f = fixture();
	const result = resolveMcpLaunchCapability({ gatewayRequested: false, servers: ["fixture"], cwd: f.cwd, key: "sa-mismatch" });
	expect(result.ok).toBe(false);
	expect(result.ok === false && result.error).toContain("without granting the mcp tool");
});

it("fails with the configured roster when a selected server is not configured for the child cwd", () => {
	const f = fixture();
	const result = resolve(f, ["fixture", "missing"]);
	expect(result.ok).toBe(false);
	expect(result.ok === false && result.error).toContain("MCP server(s) not configured");
	expect(result.ok === false && result.error).toContain("missing");
	expect(result.ok === false && result.error).toContain("Configured servers: fixture, other");
});

it("degrades an inherited grant but refuses an explicit one when the adapter is missing", () => {
	const f = fixture({ withAdapter: false });
	// Inherited: no role named the gateway, so a child without MCP is the
	// status quo, not a failure — and definitely not a failed spawn.
	const inherited = resolveMcpLaunchCapability({ gatewayRequested: true, servers: undefined, cwd: f.cwd, key: "sa-degraded" });
	expect(inherited).toEqual({ ok: true, capability: undefined });
	// Explicit: the operator asked, so the refusal names the escape hatch.
	for (const servers of [["fixture"], undefined]) {
		const explicit = resolveMcpLaunchCapability({ gatewayRequested: true, servers, cwd: f.cwd, key: "sa-explicit", explicit: true });
		expect(explicit.ok).toBe(false);
		expect(explicit.ok === false && explicit.error).toContain("pi-mcp-adapter");
		expect(explicit.ok === false && explicit.error).toContain("SUMOCODE_MCP_ADAPTER");
	}
});

it("writes a private config that enables exactly the selected servers and fences the rest", () => {
	const f = fixture();
	const result = resolve(f, ["fixture"]);
	if (!result.ok || !result.capability?.configPath) throw new Error("expected a scoped grant");
	expect(result.capability.servers).toEqual(["fixture"]);
	expect(result.capability.adapterEntry).toBe(f.adapterEntry);
	// The artifact is owner-only and confined to the private capability root.
	expect(statSync(result.capability.configPath).mode & 0o777).toBe(0o600);
	// SAFETY: the generated config is the JSON this resolver just wrote.
	const written = JSON.parse(readFileSync(result.capability.configPath, "utf8")) as { mcpServers: Record<string, McpServerDefinition> };
	expect(written.mcpServers.fixture).toEqual({ command: "node", args: ["./fixture-server.mjs"] });
	expect(written.mcpServers.other).toEqual({ disabled: true });
});

it("resolves project-local configuration from the child cwd, including an isolated worktree", () => {
	const f = fixture();
	const worktree = join(f.root, "worktree");
	mkdirSync(worktree, { mode: 0o700 });
	writeFileSync(join(worktree, ".mcp.json"), JSON.stringify({ mcpServers: { "worktree-only": { command: "node" } } }), { mode: 0o600 });
	const result = resolveMcpLaunchCapability({ gatewayRequested: true, servers: ["worktree-only"], cwd: worktree, key: "sa-worktree" });
	if (!result.ok || !result.capability?.configPath) throw new Error(`expected a scoped grant: ${result.ok === false ? result.error : ""}`);
	// SAFETY: the generated config is the JSON this resolver just wrote.
	const written = JSON.parse(readFileSync(result.capability.configPath, "utf8")) as { mcpServers: Record<string, McpServerDefinition> };
	expect(written.mcpServers["worktree-only"]).toEqual({ command: "node" });
});

it("refuses a grant while a project config defines an unselected server", () => {
	// Project files merge ABOVE the generated one, so they can clear the
	// `disabled` fence; a repo must not be able to widen an operator's grant.
	const f = fixture();
	writeFileSync(join(f.cwd, ".mcp.json"), JSON.stringify({
		mcpServers: { fixture: { command: "node" }, sneaky: { command: "node" } },
	}), { mode: 0o600 });
	const result = resolve(f, ["fixture"]);
	expect(result.ok).toBe(false);
	expect(result.ok === false && result.error).toContain("unselected server(s)");
	expect(result.ok === false && result.error).toContain("sneaky");
});

it("refuses a grant while any source pulls servers in through imports", () => {
	// `imports` expands host configs the reader deliberately does not parse, so
	// those servers could not be fenced either.
	const f = fixture();
	writeFileSync(join(f.agentDir, "mcp.json"), JSON.stringify({
		mcpServers: {}, imports: ["claude-code"],
	}), { mode: 0o600 });
	const result = resolve(f, ["fixture"]);
	expect(result.ok).toBe(false);
	expect(result.ok === false && result.error).toContain("imports");
	expect(result.ok === false && result.error).toContain("pi-mcp-adapter init");
});

it("pins the settings that could re-add servers after the file chain merges", () => {
	const f = fixture();
	const result = resolve(f, ["fixture"]);
	if (!result.ok || !result.capability) throw new Error("expected a granted capability");
	if (!result.capability.configPath) throw new Error("scoped grant must carry a config path");
	// SAFETY: the generated config is the JSON this resolver just wrote.
	const written = JSON.parse(readFileSync(result.capability.configPath, "utf8")) as { settings: unknown };
	expect(written.settings).toEqual({ hostConfigDiscovery: "off", agentPluginPaths: [] });
});

it("prefers a higher-precedence project file over the user-global one", () => {
	const f = fixture();
	writeFileSync(join(f.agentDir, "mcp.json"), JSON.stringify({ mcpServers: { fixture: { command: "global" } } }), { mode: 0o600 });
	const definitions = loadConfiguredMcpServerDefinitions({ cwd: f.cwd, piAgentDir: f.agentDir });
	expect(definitions.find((server) => server.name === "fixture")?.definition).toEqual({ command: "node", args: ["./fixture-server.mjs"] });
});

it("gives every grant its own config file even when the caller key repeats", () => {
	// Subagent ids restart their counter per process, so an id-only filename
	// would hard-fail the second session that spawns the same title.
	const f = fixture();
	const first = resolve(f, ["fixture"], "sa-once");
	const second = resolve(f, ["fixture"], "sa-once");
	if (!first.ok || !first.capability?.configPath || !second.ok || !second.capability?.configPath) throw new Error("expected two scoped grants");
	expect(first.capability.configPath).not.toBe(second.capability.configPath);
	expect(existsSync(first.capability.configPath)).toBe(true);
	expect(existsSync(second.capability.configPath)).toBe(true);
});

it("resolves the adapter entry from global settings packages and rejects project-scoped candidates", () => {
	const f = fixture({ withAdapter: false });
	const packageDir = join(f.root, "checkout", "pi-mcp-adapter");
	mkdirSync(packageDir, { recursive: true, mode: 0o700 });
	writeFileSync(join(packageDir, "package.json"), JSON.stringify({ name: "pi-mcp-adapter", pi: { extensions: ["./entry.ts"] } }), { mode: 0o600 });
	writeFileSync(join(packageDir, "entry.ts"), "export default () => undefined;\n", { mode: 0o600 });
	writeFileSync(join(f.agentDir, "settings.json"), JSON.stringify({ packages: [packageDir] }), { mode: 0o600 });
	// A project-local install must not be reachable implicitly: the same name in
	// the child's cwd is exactly the hostile-repository case `--no-extensions` fences.
	const projectScoped = join(f.cwd, "node_modules", "pi-mcp-adapter");
	mkdirSync(projectScoped, { recursive: true, mode: 0o700 });
	writeFileSync(join(projectScoped, "package.json"), JSON.stringify({ name: "pi-mcp-adapter", pi: { extensions: ["./evil.ts"] } }), { mode: 0o600 });
	writeFileSync(join(projectScoped, "evil.ts"), "throw new Error('hostile');\n", { mode: 0o600 });

	expect(resolveMcpAdapterEntry(process.env)).toBe(join(packageDir, "entry.ts"));
	vi.stubEnv("SUMOCODE_MCP_ADAPTER", projectScoped);
	expect(resolveMcpAdapterEntry(process.env)).toBe(join(projectScoped, "evil.ts"));
	// …but only because an operator named it explicitly.
	vi.stubEnv("SUMOCODE_MCP_ADAPTER", "");
	expect(resolveMcpAdapterEntry(process.env)).toBe(join(packageDir, "entry.ts"));
});
