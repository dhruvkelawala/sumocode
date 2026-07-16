import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { buildSpawnEnv } from "./spawn-pi-pty.js";

describe("buildSpawnEnv", () => {
	const retiredModuleKey = ["SUMO", "TUI", "MODULE"].join("_");
	const retiredLegacyKey = ["SUMO", "LEGACY"].join("_");

	it("scrubs inherited SumoCode debug env vars", () => {
		const env = buildSpawnEnv(
			{
				PATH: "/usr/bin",
				HOME: "/Users/test",
				SUMO_TUI: "1",
				SUMO_TUI_DEBUG: "1",
				SUMO_TUI_DIAG_FILE: "/tmp/sumocode-manual.jsonl",
				[retiredModuleKey]: "file:///tmp/fake.js",
				SUMO_TUI_HIDE_PI_NOISE: "1",
				[retiredLegacyKey]: "1",
				SUMO_RPC: "1",
				SUMOCODE_RPC_CHILD: "1",
				SUMOCODE_REDUCED_MOTION: "1",
				SUMOCODE_DEBUG_BRANCH: "feature/x",
				SUMOCODE_DEBUG_COMMIT: "abc123",
			},
			undefined,
		);

		expect(env.SUMO_TUI).toBeUndefined();
		expect(env.SUMO_TUI_DEBUG).toBeUndefined();
		expect(env.SUMO_TUI_DIAG_FILE).toBeUndefined();
		expect(env[retiredModuleKey]).toBeUndefined();
		expect(env.SUMO_TUI_HIDE_PI_NOISE).toBeUndefined();
		expect(env[retiredLegacyKey]).toBeUndefined();
		expect(env.SUMO_RPC).toBeUndefined();
		expect(env.SUMOCODE_RPC_CHILD).toBeUndefined();
		expect(env.SUMOCODE_REDUCED_MOTION).toBeUndefined();
		expect(env.SUMOCODE_DEBUG_BRANCH).toBeUndefined();
		expect(env.SUMOCODE_DEBUG_COMMIT).toBeUndefined();
		expect(env.PATH).toBe("/usr/bin");
		expect(env.HOME).toBe("/Users/test");
	});

	it("applies pi-friendly defaults", () => {
		const env = buildSpawnEnv({}, undefined);
		expect(env.PI_OFFLINE).toBe("1");
		expect(env.TERM).toBe("xterm-256color");
	});

	it("lets per-test overrides reintroduce scrubbed keys", () => {
		const env = buildSpawnEnv(
			{ SUMO_TUI: "1" },
			{ SUMO_TUI: "1", SUMO_TUI_DEBUG: "0" },
		);
		expect(env.SUMO_TUI).toBe("1");
		expect(env.SUMO_TUI_DEBUG).toBe("0");
	});

	it("lets overrides win over scrub when intentionally setting the same key", () => {
		const env = buildSpawnEnv(
			{ SUMO_TUI_DEBUG: "1" },
			{ SUMO_TUI_DEBUG: "0" },
		);
		expect(env.SUMO_TUI_DEBUG).toBe("0");
	});

	it("preserves overrides for unrelated env vars", () => {
		const env = buildSpawnEnv({ HOME: "/Users/parent" }, { PI_CODING_AGENT_DIR: "/tmp/foo" });
		expect(env.HOME).toBe("/Users/parent");
		expect(env.PI_CODING_AGENT_DIR).toBe("/tmp/foo");
	});
});

describe("sumocode launcher mode decision", () => {
	function dryRun(args: string[]): string {
		return execFileSync("bin/sumocode.sh", ["--dry-run", ...args], {
			cwd: process.cwd(),
			env: buildSpawnEnv(process.env, { PI_BIN: "/bin/echo" }),
			encoding: "utf8",
		});
	}

	it("bypasses the RPC host for non-TTY dry-runs without requiring the retained patch", () => {
		const output = dryRun([]);
		expect(output).toContain("SUMO_TUI=0");
		expect(output).toContain("SUMO_RPC=");
		expect(output).toContain("exec /bin/echo -e ");
		expect(output).not.toContain("sumo-rpc-host.js");
		expect(output).not.toContain("missing the Sumo retained-TUI patch");
	});

	it("bypasses the RPC host for Pi print mode", () => {
		const output = dryRun(["--offline", "--no-extensions", "--no-session", "--print", "hello"]);
		expect(output).toContain("SUMO_TUI=0");
		expect(output).toContain("SUMO_RPC=");
		expect(output).toContain("--print hello");
		expect(output).not.toContain("sumo-rpc-host.js");
	});

	it("bypasses the RPC host for explicit Pi mode", () => {
		const output = dryRun(["--mode", "rpc", "--offline", "--no-extensions", "--no-session"]);
		expect(output).toContain("SUMO_TUI=0");
		expect(output).toContain("SUMO_RPC=");
		expect(output).toContain("--mode rpc");
		expect(output).not.toContain("sumo-rpc-host.js");
	});

	it("bypasses the RPC host when the diagnostic direct-Pi flag is set", () => {
		const output = dryRun(["--no-sumo-tui", "--offline", "--no-extensions", "--no-session"]);
		expect(output).toContain("SUMO_TUI=0");
		expect(output).toContain("SUMO_RPC=");
		expect(output).toContain("exec /bin/echo -e ");
		expect(output).not.toContain("sumo-rpc-host.js");
	});
});
