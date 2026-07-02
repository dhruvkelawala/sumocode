import { describe, expect, it } from "vitest";
import { buildSpawnEnv } from "./spawn-pi-pty.js";

describe("buildSpawnEnv", () => {
	it("scrubs inherited SumoCode debug env vars", () => {
		const env = buildSpawnEnv(
			{
				PATH: "/usr/bin",
				HOME: "/Users/test",
				SUMO_TUI: "1",
				SUMO_TUI_DEBUG: "1",
				SUMO_TUI_DIAG_FILE: "/tmp/sumocode-manual.jsonl",
				SUMO_TUI_MODULE: "file:///tmp/fake.js",
				SUMO_TUI_HIDE_PI_NOISE: "1",
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
		expect(env.SUMO_TUI_MODULE).toBeUndefined();
		expect(env.SUMO_TUI_HIDE_PI_NOISE).toBeUndefined();
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
			{ SUMO_TUI: "1", SUMO_TUI_MODULE: "file:///opt/explicit.js" },
		);
		expect(env.SUMO_TUI).toBe("1");
		expect(env.SUMO_TUI_MODULE).toBe("file:///opt/explicit.js");
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
