import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IDisposable, IEvent, IPty } from "node-pty";
import { describe, expect, it } from "vitest";
import { buildSpawnEnv, spawnPiPty, type SpawnPiPtyOptions } from "./spawn-pi-pty.js";

type PtySpawn = NonNullable<SpawnPiPtyOptions["spawn"]>;
type PtySpawnOptions = Parameters<PtySpawn>[2];
type PtyExitListener = Parameters<IEvent<{ exitCode: number; signal?: number }>>[0];

interface SpawnCall {
	readonly options: PtySpawnOptions;
}

class FakePty implements IPty {
	public readonly pid = 123;
	public readonly cols = 100;
	public readonly rows = 30;
	public readonly process = "synthetic-pty";
	public handleFlowControl = false;
	public readonly killSignals: Array<string | undefined> = [];
	private readonly disposable: IDisposable = { dispose(): void {} };
	private exitListener: PtyExitListener | undefined;

	public readonly onData: IEvent<string> = () => this.disposable;
	public readonly onExit: IEvent<{ exitCode: number; signal?: number }> = (listener) => {
		this.exitListener = listener;
		return this.disposable;
	};

	public resize(_columns: number, _rows: number): void {}
	public clear(): void {}
	public write(_data: string | Buffer): void {}
	public kill(signal?: string): void {
		this.killSignals.push(signal);
	}
	public pause(): void {}
	public resume(): void {}

	public exit(): void {
		this.exitListener?.({ exitCode: 0, signal: 0 });
	}
}

class FakePtySpawner {
	public readonly calls: SpawnCall[] = [];
	public readonly ptys: FakePty[] = [];
	public error: Error | undefined;

	public readonly spawn: PtySpawn = (_file, _args, options) => {
		this.calls.push({ options });
		if (this.error !== undefined) throw this.error;
		const pty = new FakePty();
		this.ptys.push(pty);
		return pty;
	};

	public call(index: number): SpawnCall {
		const call = this.calls[index];
		if (call === undefined) throw new Error(`missing fake spawn call ${index}`);
		return call;
	}

	public pty(index: number): FakePty {
		const pty = this.ptys[index];
		if (pty === undefined) throw new Error(`missing fake pty ${index}`);
		return pty;
	}
}

function agentDir(call: SpawnCall): string {
	const value = call.options.env?.PI_CODING_AGENT_DIR;
	if (value === undefined) throw new Error("spawn call has no Pi agent root");
	return value;
}

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
				SUMOCODE_HOST_BUNDLE: "1",
				SUMOCODE_ROOT_DIR: "/tmp/untrusted-root",
				SUMOCODE_PROJECT_CWD: "/tmp/stale-project",
				SUMOCODE_LAUNCHER: "/tmp/stale-launcher",
				SUMOCODE_REDUCED_MOTION: "1",
				SUMOCODE_DEBUG_BRANCH: "feature/x",
				SUMOCODE_DEBUG_COMMIT: "abc123",
				SUMOCODE_TEST_PRE_ADOPTION_DELAY_MS: "5000",
				SUMOCODE_TEST_PRE_MAIN_DELAY_MS: "5000",
				SUMOCODE_TEST_PRE_ADOPTION_MAIN_DELAY_MS: "5000",
				SUMOCODE_TEST_CHROME_CACHE_DELAY_MS: "500",
				SUMOCODE_TEST_BUNDLE_SCAN_DELAY_MS: "500",
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
		expect(env.SUMOCODE_HOST_BUNDLE).toBeUndefined();
		expect(env.SUMOCODE_ROOT_DIR).toBeUndefined();
		expect(env.SUMOCODE_PROJECT_CWD).toBeUndefined();
		expect(env.SUMOCODE_LAUNCHER).toBeUndefined();
		expect(env.SUMOCODE_REDUCED_MOTION).toBeUndefined();
		expect(env.SUMOCODE_DEBUG_BRANCH).toBeUndefined();
		expect(env.SUMOCODE_DEBUG_COMMIT).toBeUndefined();
		expect(env.SUMOCODE_TEST_PRE_ADOPTION_DELAY_MS).toBeUndefined();
		expect(env.SUMOCODE_TEST_PRE_MAIN_DELAY_MS).toBeUndefined();
		expect(env.SUMOCODE_TEST_PRE_ADOPTION_MAIN_DELAY_MS).toBeUndefined();
		expect(env.SUMOCODE_TEST_CHROME_CACHE_DELAY_MS).toBeUndefined();
		expect(env.SUMOCODE_TEST_BUNDLE_SCAN_DELAY_MS).toBeUndefined();
		expect(env.PATH).toBe("/usr/bin");
		expect(env.HOME).toBe("/Users/test");
	});

	it("scrubs inherited credential-shaped keys while preserving benign keys", () => {
		const env = buildSpawnEnv(
			{
				OPENAI_TEST_CREDENTIAL: "provider-sentinel",
				INTERNAL_ACCESS_TOKEN: "suffix-sentinel",
				GITHUB_TOKEN: "github-sentinel",
				GH_TOKEN: "gh-sentinel",
				NPM_TOKEN: "npm-sentinel",
				HF_TOKEN: "hf-sentinel",
				DATABASE_SECRET: "secret-sentinel",
				PATH: "/usr/bin",
				HOME: "/Users/test",
				EDITOR: "vi",
				TERM: "vt100",
			},
			undefined,
		);

		expect(env.OPENAI_TEST_CREDENTIAL).toBeUndefined();
		expect(env.INTERNAL_ACCESS_TOKEN).toBeUndefined();
		expect(env.GITHUB_TOKEN).toBeUndefined();
		expect(env.GH_TOKEN).toBeUndefined();
		expect(env.NPM_TOKEN).toBeUndefined();
		expect(env.HF_TOKEN).toBeUndefined();
		expect(env.DATABASE_SECRET).toBeUndefined();
		expect(env.PATH).toBe("/usr/bin");
		expect(env.HOME).toBe("/Users/test");
		expect(env.EDITOR).toBe("vi");
		expect(env.TERM).toBe("xterm-256color");
	});

	it("applies pi-friendly defaults", () => {
		const env = buildSpawnEnv({}, undefined);
		expect(env.PI_OFFLINE).toBe("1");
		expect(env.TERM).toBe("xterm-256color");
	});

	it("lets per-test overrides reintroduce scrubbed keys", () => {
		const env = buildSpawnEnv(
			{ SUMO_TUI: "1", SUMOCODE_HOST_BUNDLE: "1" },
			{ SUMO_TUI: "1", SUMO_TUI_DEBUG: "0", SUMOCODE_HOST_BUNDLE: "1" },
		);
		expect(env.SUMO_TUI).toBe("1");
		expect(env.SUMO_TUI_DEBUG).toBe("0");
		expect(env.SUMOCODE_HOST_BUNDLE).toBe("1");
	});

	it("lets overrides win over scrub when intentionally setting the same key", () => {
		const env = buildSpawnEnv(
			{ SUMO_TUI_DEBUG: "1", ANTHROPIC_TEST_CREDENTIAL: "parent-sentinel" },
			{ SUMO_TUI_DEBUG: "0", ANTHROPIC_TEST_CREDENTIAL: "synthetic-test-value" },
		);
		expect(env.SUMO_TUI_DEBUG).toBe("0");
		expect(env.ANTHROPIC_TEST_CREDENTIAL).toBe("synthetic-test-value");
	});

	it("preserves overrides for unrelated env vars", () => {
		const env = buildSpawnEnv({ HOME: "/Users/parent" }, { PI_CODING_AGENT_DIR: "/tmp/foo" });
		expect(env.HOME).toBe("/Users/parent");
		expect(env.PI_CODING_AGENT_DIR).toBe("/tmp/foo");
	});
});

describe("spawnPiPty agent state isolation", () => {
	it("creates private unique roots and removes them only after child exit", () => {
		const spawner = new FakePtySpawner();
		const first = spawnPiPty({ spawn: spawner.spawn });
		spawnPiPty({ spawn: spawner.spawn });
		const roots = [agentDir(spawner.call(0)), agentDir(spawner.call(1))];
		const firstPty = spawner.pty(0);
		const secondPty = spawner.pty(1);
		try {
			expect(roots[0]).not.toBe(roots[1]);
			for (const root of roots) {
				expect(root.startsWith(tmpdir())).toBe(true);
				expect(existsSync(root)).toBe(true);
				expect(statSync(root).mode & 0o077).toBe(0);
			}

			first.cleanup();
			expect(firstPty.killSignals).toEqual(["SIGTERM"]);
			expect(existsSync(roots[0])).toBe(true);

			firstPty.exit();
			expect(existsSync(roots[0])).toBe(false);
			expect(existsSync(roots[1])).toBe(true);

			secondPty.exit();
			expect(existsSync(roots[1])).toBe(false);
		} finally {
			for (const pty of spawner.ptys) pty.exit();
			for (const root of roots) rmSync(root, { recursive: true, force: true });
		}
	});

	it("preserves a caller-owned root after child exit", () => {
		const callerRoot = mkdtempSync(join(tmpdir(), "sumocode-caller-agent-"));
		const spawner = new FakePtySpawner();
		try {
			const child = spawnPiPty({ env: { PI_CODING_AGENT_DIR: callerRoot }, spawn: spawner.spawn });
			expect(agentDir(spawner.call(0))).toBe(callerRoot);
			child.cleanup();
			expect(existsSync(callerRoot)).toBe(true);
			spawner.pty(0).exit();
			expect(existsSync(callerRoot)).toBe(true);
		} finally {
			rmSync(callerRoot, { recursive: true, force: true });
		}
	});

	it("removes a helper-owned root when spawning throws", () => {
		const spawner = new FakePtySpawner();
		spawner.error = new Error("synthetic spawn failure");

		expect(() => spawnPiPty({ spawn: spawner.spawn })).toThrow("synthetic spawn failure");
		const generatedRoot = agentDir(spawner.call(0));
		try {
			expect(existsSync(generatedRoot)).toBe(false);
		} finally {
			rmSync(generatedRoot, { recursive: true, force: true });
		}
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
		expect(output).toContain("/src/extension-entry.ts");
		expect(output).not.toContain("sumo-rpc-host.js");
		expect(output).not.toContain("missing the Sumo retained-TUI patch");
	});

	it("bypasses the RPC host for Pi print mode", () => {
		const output = dryRun(["--offline", "--no-extensions", "--no-session", "--print", "hello"]);
		expect(output).toContain("SUMO_TUI=0");
		expect(output).toContain("SUMO_RPC=");
		expect(output).toContain("--print hello");
		expect(output).toContain("/src/extension-entry.ts");
		expect(output).not.toContain("sumo-rpc-host.js");
	});

	it("bypasses the RPC host for explicit Pi mode", () => {
		const output = dryRun(["--mode", "rpc", "--offline", "--no-extensions", "--no-session"]);
		expect(output).toContain("SUMO_TUI=0");
		expect(output).toContain("SUMO_RPC=");
		expect(output).toContain("--mode rpc");
		expect(output).toContain("/src/extension-entry.ts");
		expect(output).not.toContain("sumo-rpc-host.js");
	});

	it("bypasses the RPC host when the diagnostic direct-Pi flag is set", () => {
		const output = dryRun(["--no-sumo-tui", "--offline", "--no-extensions", "--no-session"]);
		expect(output).toContain("SUMO_TUI=0");
		expect(output).toContain("SUMO_RPC=");
		expect(output).toContain("exec /bin/echo -e ");
		expect(output).toContain("/src/extension-entry.ts");
		expect(output).not.toContain("sumo-rpc-host.js");
	});

	it("routes -w with an optional name to the standalone worktree opener", () => {
		const output = dryRun(["-w", "new-worktree"]);
		expect(output).toContain("sumocode worktree dry run");
		expect(output).toContain("NAME=new-worktree");
		expect(output).toContain("scripts/open-worktree.mjs new-worktree");
		expect(output).not.toContain("sumo-rpc-host.js");
	});

	it("allows -w without a name", () => {
		const output = dryRun(["-w"]);
		expect(output).toContain("NAME=\n");
		expect(output).toContain("scripts/open-worktree.mjs");
	});
});
