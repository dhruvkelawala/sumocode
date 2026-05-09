import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	clearCachedMcpRoster,
	getCachedMcpRoster,
	loadConfiguredMcpServers,
	resolveMcpConfigCandidates,
	setMcpDiagnosticHandler,
	type McpDiagnosticHandler,
} from "./mcp-config-reader.js";

let tmpRoot: string;

beforeEach(() => {
	tmpRoot = mkdtempSync(join(tmpdir(), "sumocode-mcp-test-"));
	clearCachedMcpRoster();
});

afterEach(() => {
	rmSync(tmpRoot, { recursive: true, force: true });
	clearCachedMcpRoster();
	setMcpDiagnosticHandler(undefined);
});

function writeJson(path: string, value: unknown): void {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, JSON.stringify(value), "utf8");
}

describe("resolveMcpConfigCandidates", () => {
	it("returns the four candidate paths in pi-mcp-adapter precedence order", () => {
		const cwd = "/tmp/some-project";
		const piAgentDir = "/tmp/.pi/agent";
		const candidates = resolveMcpConfigCandidates({ cwd, piAgentDir });
		expect(candidates).toHaveLength(4);
		// User-global shared MCP config wins lowest precedence.
		expect(candidates[0]).toMatch(/\.config\/mcp\/mcp\.json$/);
		// Pi global override second.
		expect(candidates[1]).toBe("/tmp/.pi/agent/mcp.json");
		// Project-local shared third.
		expect(candidates[2]).toBe("/tmp/some-project/.mcp.json");
		// Pi project override last (highest precedence).
		expect(candidates[3]).toBe("/tmp/some-project/.pi/mcp.json");
	});
});

describe("loadConfiguredMcpServers", () => {
	it("returns an empty array when no config files exist", () => {
		const cwd = join(tmpRoot, "project");
		const piAgentDir = join(tmpRoot, ".pi", "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(piAgentDir, { recursive: true });
		expect(loadConfiguredMcpServers({ cwd, piAgentDir })).toEqual([]);
	});

	it("reads a single Pi global config", () => {
		const cwd = join(tmpRoot, "project");
		const piAgentDir = join(tmpRoot, ".pi", "agent");
		mkdirSync(cwd, { recursive: true });
		writeJson(join(piAgentDir, "mcp.json"), {
			mcpServers: {
				github: { command: "npx" },
				stitch: { url: "https://stitch.googleapis.com/mcp" },
			},
		});
		const servers = loadConfiguredMcpServers({ cwd, piAgentDir });
		expect(servers.map((s) => s.name)).toEqual(["github", "stitch"]);
		// Status reflects pi-mcp-adapter's lazy default.
		expect(servers.every((s) => s.status === "idle")).toBe(true);
	});

	it("project .mcp.json overrides Pi global by name; both names appear when distinct", () => {
		const cwd = join(tmpRoot, "project");
		const piAgentDir = join(tmpRoot, ".pi", "agent");
		mkdirSync(cwd, { recursive: true });
		writeJson(join(piAgentDir, "mcp.json"), {
			mcpServers: {
				github: { command: "npx" },
				railway: { command: "railway" },
			},
		});
		writeJson(join(cwd, ".mcp.json"), {
			mcpServers: {
				github: { command: "npx -y newer-github" },
				stitch: { url: "https://stitch.googleapis.com/mcp" },
			},
		});
		const servers = loadConfiguredMcpServers({ cwd, piAgentDir });
		const names = servers.map((s) => s.name);
		// All three distinct names appear; project does not delete user-global entries it does not name.
		expect(names).toEqual(expect.arrayContaining(["github", "railway", "stitch"]));
		expect(names).toHaveLength(3);
	});

	it("Pi project override .pi/mcp.json wins over project .mcp.json for same name", () => {
		const cwd = join(tmpRoot, "project");
		const piAgentDir = join(tmpRoot, ".pi", "agent");
		mkdirSync(cwd, { recursive: true });
		writeJson(join(cwd, ".mcp.json"), { mcpServers: { github: {} } });
		writeJson(join(cwd, ".pi", "mcp.json"), { mcpServers: { github: {}, custom: {} } });
		const servers = loadConfiguredMcpServers({ cwd, piAgentDir });
		expect(servers.map((s) => s.name).sort()).toEqual(["custom", "github"]);
	});

	it("malformed JSON in any source does not crash; that source is silently skipped", () => {
		const cwd = join(tmpRoot, "project");
		const piAgentDir = join(tmpRoot, ".pi", "agent");
		mkdirSync(cwd, { recursive: true });
		writeJson(join(piAgentDir, "mcp.json"), { mcpServers: { github: {} } });
		// Write a junk JSON file as the project-local source.
		mkdirSync(cwd, { recursive: true });
		writeFileSync(join(cwd, ".mcp.json"), "{ this is not json", "utf8");
		const servers = loadConfiguredMcpServers({ cwd, piAgentDir });
		expect(servers.map((s) => s.name)).toEqual(["github"]);
	});

	it("missing mcpServers key returns no entries from that file", () => {
		const cwd = join(tmpRoot, "project");
		const piAgentDir = join(tmpRoot, ".pi", "agent");
		mkdirSync(cwd, { recursive: true });
		writeJson(join(piAgentDir, "mcp.json"), { settings: { toolPrefix: "server" } });
		expect(loadConfiguredMcpServers({ cwd, piAgentDir })).toEqual([]);
	});

	it("emits an mcp_imports_unresolved diagnostic when imports are present but stays non-fatal", () => {
		// pi-mcp-adapter's `imports` field pulls server configs from host-specific files
		// (cursor, claude-code, vscode, etc.). This reader doesn't resolve those, so when
		// imports are present we emit a diagnostic so the gap is traceable in
		// SUMO_TUI_DIAG_FILE traces. Workaround for users: run `pi-mcp-adapter init` to
		// expand imports into mcpServers in-place.
		const cwd = join(tmpRoot, "project");
		const piAgentDir = join(tmpRoot, ".pi", "agent");
		mkdirSync(cwd, { recursive: true });
		writeJson(join(piAgentDir, "mcp.json"), {
			imports: ["cursor", "claude-code"],
			mcpServers: { github: {} },
		});

		const events: Parameters<McpDiagnosticHandler>[0][] = [];
		setMcpDiagnosticHandler((event) => {
			events.push(event);
		});

		const roster = loadConfiguredMcpServers({ cwd, piAgentDir });
		// Explicit servers still load.
		expect(roster.map((s) => s.name)).toEqual(["github"]);
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			type: "mcp_imports_unresolved",
			importsCount: 2,
		});
		expect(events[0]?.path).toContain("mcp.json");
	});

	it("empty imports array does NOT emit a diagnostic", () => {
		const cwd = join(tmpRoot, "project");
		const piAgentDir = join(tmpRoot, ".pi", "agent");
		mkdirSync(cwd, { recursive: true });
		writeJson(join(piAgentDir, "mcp.json"), { imports: [], mcpServers: { github: {} } });

		const events: Parameters<McpDiagnosticHandler>[0][] = [];
		setMcpDiagnosticHandler((event) => events.push(event));

		const roster = loadConfiguredMcpServers({ cwd, piAgentDir });
		expect(roster.map((s) => s.name)).toEqual(["github"]);
		expect(events).toHaveLength(0);
	});

	it("non-object mcpServers (string, array) is skipped instead of producing bogus synthetic keys", () => {
		// `Object.keys("oops")` returns `["0","1","2","3"]` and `Object.keys(["github"])` returns
		// `["0"]`. Without the type guard we'd register servers named "0", "1", "2", "3" —
		// codex caught this on PR #250 as a real edge case for hand-edited config files.
		const cwd = join(tmpRoot, "project");
		const piAgentDir = join(tmpRoot, ".pi", "agent");
		mkdirSync(cwd, { recursive: true });

		writeJson(join(piAgentDir, "mcp.json"), { mcpServers: "oops" });
		expect(loadConfiguredMcpServers({ cwd, piAgentDir })).toEqual([]);

		writeJson(join(piAgentDir, "mcp.json"), { mcpServers: ["github", "railway"] });
		expect(loadConfiguredMcpServers({ cwd, piAgentDir })).toEqual([]);

		writeJson(join(piAgentDir, "mcp.json"), { mcpServers: 42 });
		expect(loadConfiguredMcpServers({ cwd, piAgentDir })).toEqual([]);

		writeJson(join(piAgentDir, "mcp.json"), { mcpServers: null });
		expect(loadConfiguredMcpServers({ cwd, piAgentDir })).toEqual([]);
	});
});

describe("getCachedMcpRoster", () => {
	it("memoizes the first read and ignores subsequent disk changes within a process", () => {
		const cwd = join(tmpRoot, "project");
		const piAgentDir = join(tmpRoot, ".pi", "agent");
		mkdirSync(cwd, { recursive: true });
		writeJson(join(piAgentDir, "mcp.json"), { mcpServers: { github: {} } });

		const first = getCachedMcpRoster({ cwd, piAgentDir });
		expect(first.map((s) => s.name)).toEqual(["github"]);

		// Mutate the file. The cached read should NOT pick this up \u2014 cache flushes only on
		// process restart (e.g. /sumo:reload).
		writeJson(join(piAgentDir, "mcp.json"), { mcpServers: { github: {}, stitch: {} } });
		const second = getCachedMcpRoster({ cwd, piAgentDir });
		expect(second).toBe(first);
	});

	it("clearCachedMcpRoster forces a fresh read", () => {
		const cwd = join(tmpRoot, "project");
		const piAgentDir = join(tmpRoot, ".pi", "agent");
		mkdirSync(cwd, { recursive: true });
		writeJson(join(piAgentDir, "mcp.json"), { mcpServers: { github: {} } });

		const before = getCachedMcpRoster({ cwd, piAgentDir });
		expect(before.map((s) => s.name)).toEqual(["github"]);

		writeJson(join(piAgentDir, "mcp.json"), { mcpServers: { github: {}, railway: {} } });
		clearCachedMcpRoster();
		const after = getCachedMcpRoster({ cwd, piAgentDir });
		expect(after.map((s) => s.name).sort()).toEqual(["github", "railway"]);
	});

	it("keys the cache by (cwd, piAgentDir) so session switches don't leak rosters", () => {
		// Project A and project B coexist in the same process. Pi's session_before_switch
		// event can change ctx.cwd within a single Pi run, so a global single-slot cache
		// would leak A's roster into B and break the precedence contract.
		const cwdA = join(tmpRoot, "project-a");
		const cwdB = join(tmpRoot, "project-b");
		const piAgentDir = join(tmpRoot, ".pi", "agent");
		mkdirSync(cwdA, { recursive: true });
		mkdirSync(cwdB, { recursive: true });
		writeJson(join(cwdA, ".mcp.json"), { mcpServers: { github: {}, railway: {} } });
		writeJson(join(cwdB, ".mcp.json"), { mcpServers: { stitch: {}, context7: {} } });

		const rosterA = getCachedMcpRoster({ cwd: cwdA, piAgentDir });
		const rosterB = getCachedMcpRoster({ cwd: cwdB, piAgentDir });

		expect(rosterA.map((s) => s.name).sort()).toEqual(["github", "railway"]);
		expect(rosterB.map((s) => s.name).sort()).toEqual(["context7", "stitch"]);

		// And the second access for each cwd is still memoized (returns the same array reference).
		expect(getCachedMcpRoster({ cwd: cwdA, piAgentDir })).toBe(rosterA);
		expect(getCachedMcpRoster({ cwd: cwdB, piAgentDir })).toBe(rosterB);
	});
});
