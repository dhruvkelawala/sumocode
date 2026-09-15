import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { loadConfiguredMcpServerDefinitions } from "../mcp-config-reader.js";
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
			mcpServers: {
				fixture: { command: "node", args: ["./fixture-server.mjs"] },
				other: { command: "node", args: ["./other-server.mjs"] },
			},
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

it("refuses a gateway grant that does not name its servers", () => {
	const f = fixture();
	for (const servers of [undefined, [], ["   "]]) {
		const result = resolve(f, servers);
		expect(result.ok).toBe(false);
		expect(result.ok === false && result.error).toContain("explicit mcpServers list");
	}
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

it("fails clearly when the adapter is not installed in the trusted global scope", () => {
	const f = fixture({ withAdapter: false });
	const result = resolve(f, ["fixture"]);
	expect(result.ok).toBe(false);
	expect(result.ok === false && result.error).toContain("pi-mcp-adapter");
});

it("writes a private config that enables exactly the selected servers and fences the rest", () => {
	const f = fixture();
	const result = resolve(f, ["fixture"]);
	if (!result.ok || !result.capability) throw new Error("expected a granted capability");
	expect(result.capability.servers).toEqual(["fixture"]);
	expect(result.capability.adapterEntry).toBe(f.adapterEntry);
	// The artifact is owner-only and confined to the private capability root.
	expect(statSync(result.capability.configPath).mode & 0o777).toBe(0o600);
	const written = JSON.parse(readFileSync(result.capability.configPath, "utf8")) as { mcpServers: Record<string, unknown> };
	expect(written.mcpServers.fixture).toEqual({ command: "node", args: ["./fixture-server.mjs"] });
	expect(written.mcpServers.other).toEqual({ disabled: true });
});

it("resolves project-local configuration from the child cwd, including an isolated worktree", () => {
	const f = fixture();
	const worktree = join(f.root, "worktree");
	mkdirSync(worktree, { mode: 0o700 });
	writeFileSync(join(worktree, ".mcp.json"), JSON.stringify({ mcpServers: { "worktree-only": { command: "node" } } }), { mode: 0o600 });
	const result = resolveMcpLaunchCapability({ gatewayRequested: true, servers: ["worktree-only"], cwd: worktree, key: "sa-worktree" });
	if (!result.ok || !result.capability) throw new Error(`expected a granted capability: ${result.ok === false ? result.error : ""}`);
	const written = JSON.parse(readFileSync(result.capability.configPath, "utf8")) as { mcpServers: Record<string, unknown> };
	expect(written.mcpServers["worktree-only"]).toEqual({ command: "node" });
});

it("prefers a higher-precedence project file over the user-global one", () => {
	const f = fixture();
	writeFileSync(join(f.agentDir, "mcp.json"), JSON.stringify({ mcpServers: { fixture: { command: "global" } } }), { mode: 0o600 });
	const definitions = loadConfiguredMcpServerDefinitions({ cwd: f.cwd, piAgentDir: f.agentDir });
	expect(definitions.find((server) => server.name === "fixture")?.definition).toEqual({ command: "node", args: ["./fixture-server.mjs"] });
});

it("never reuses a capability filename for a second child", () => {
	const f = fixture();
	expect(resolve(f, ["fixture"], "sa-once").ok).toBe(true);
	const second = resolve(f, ["fixture"], "sa-once");
	expect(second.ok).toBe(false);
	expect(second.ok === false && second.error).toContain("already exists");
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
