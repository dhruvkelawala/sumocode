import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TERMINAL_CLEANUP_SEQUENCE } from "../../src/sumo-tui/runtime/terminal-controller.js";
import { PI_BOOT_SEQUENCE, spawnSumocodePty, type SpawnedPiPty } from "./spawn-pi-pty.js";

let app: SpawnedPiPty | undefined;

afterEach(() => {
	app?.cleanup();
	app = undefined;
});

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForPid(path: string): Promise<number> {
	for (let attempt = 0; attempt < 200; attempt += 1) {
		try {
			const pid = Number.parseInt(await readFile(path, "utf8"), 10);
			if (Number.isFinite(pid)) return pid;
		} catch {}
		await delay(10);
	}
	throw new Error(`timed out waiting for child pid file: ${path}`);
}

async function waitForProcessExit(pid: number): Promise<void> {
	for (let attempt = 0; attempt < 200; attempt += 1) {
		try {
			process.kill(pid, 0);
		} catch {
			return;
		}
		await delay(10);
	}
	throw new Error(`process ${pid} remained alive after early host signal`);
}

describe("sumocode RPC host shell integration", () => {
	it.each(["SIGINT", "SIGTERM"] as const)("renders a retained Cathedral empty state and cleans up after %s", async (signal) => {
		const agentDir = await mkdtemp(join(tmpdir(), "sumocode-rpc-agent-"));
		app = spawnSumocodePty({ env: { PI_CODING_AGENT_DIR: agentDir }, cols: 100, rows: 30 });

		await app.waitForOutput(PI_BOOT_SEQUENCE, 15_000);
		await app.waitForOutput("DIVINE INVOCATION", 15_000);
		await app.waitForOutput(/CTRL\+\/[\s\S]*COMMANDS/, 15_000);
		await delay(250);

		const output = app.getOutput();
		expect(output).not.toContain("SUMOCODE RPC");
		expect(output).not.toContain("empty transcript");
		expect(output).not.toContain("rpc host");

		const activeState = app.getCurrentTerminalState();
		expect(activeState.altscreenActive).toBe(true);
		expect(activeState.mouseSGRActive).toBe(true);
		expect(activeState.cleanupSequenceSeen).toBe(false);

		app.sendSignal(signal);
		await app.waitForOutput(TERMINAL_CLEANUP_SEQUENCE, 5_000);

		const cleanState = app.getCurrentTerminalState();
		expect(cleanState.cleanupSequenceSeen).toBe(true);
		expect(cleanState.altscreenActive).toBe(false);
		expect(cleanState.mouseSGRActive).toBe(false);
		expect(cleanState.cursorVisible).toBe(true);
	}, 30_000);

	it("ignores stale legacy environment and still boots the RPC host", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "sumocode-stale-env-agent-"));
		const staleLegacyKey = ["SUMO", "LEGACY"].join("_");
		app = spawnSumocodePty({
			env: { PI_CODING_AGENT_DIR: agentDir, [staleLegacyKey]: "1" },
			cols: 100,
			rows: 30,
		});

		await app.waitForOutput(PI_BOOT_SEQUENCE, 15_000);
		await app.waitForOutput("DIVINE INVOCATION", 15_000);
		await app.waitForOutput(/CTRL\+\/[\s\S]*COMMANDS/, 15_000);
		await delay(250);

		const output = app.getOutput();
		expect(output).not.toContain("SUMOCODE RPC");
		expect(output).not.toContain("empty transcript");
		expect(output).not.toContain("rpc host");

		const activeState = app.getCurrentTerminalState();
		expect(activeState.altscreenActive).toBe(true);
		expect(activeState.mouseSGRActive).toBe(true);
		expect(activeState.cleanupSequenceSeen).toBe(false);
	}, 30_000);

	it("reaps the pre-spawned child when signalled before host adoption", async () => {
		const directory = await mkdtemp(join(tmpdir(), "sumocode-rpc-early-signal-"));
		const piBin = join(directory, "stalled-pi");
		const pidFile = join(directory, "pid");
		await writeFile(
			piBin,
			"#!/usr/bin/env node\nrequire('node:fs').writeFileSync(process.env.PID_FILE, String(process.pid));\nprocess.on('SIGTERM', () => {});\nprocess.stdin.resume();\nsetInterval(() => {}, 1000);\n",
			{ mode: 0o700 },
		);
		app = spawnSumocodePty({
			env: { PI_BIN: piBin, PID_FILE: pidFile, PI_CODING_AGENT_DIR: join(directory, "agent") },
			cols: 100,
			rows: 30,
		});

		const pid = await waitForPid(pidFile);
		app.sendSignal("SIGTERM");
		await waitForProcessExit(pid);
	}, 30_000);

	it("exits promptly when startup hydration is stalled", async () => {
		const directory = await mkdtemp(join(tmpdir(), "sumocode-rpc-stalled-hydration-"));
		const piBin = join(directory, "stalled-pi");
		await writeFile(piBin, "#!/usr/bin/env node\nprocess.stdin.resume();\nsetInterval(() => {}, 1000);\n", { mode: 0o700 });
		app = spawnSumocodePty({
			env: { PI_BIN: piBin, PI_CODING_AGENT_DIR: join(directory, "agent") },
			cols: 100,
			rows: 30,
		});

		await app.waitForOutput(PI_BOOT_SEQUENCE, 15_000);
		app.sendInput("\u001f");
		await delay(100);
		expect(app.getOutput()).not.toContain("host controls");
		app.sendInput("\u0004");
		await app.waitForOutput(TERMINAL_CLEANUP_SEQUENCE, 2_000);
		expect(app.getCurrentTerminalState().altscreenActive).toBe(false);
	}, 30_000);

	it("accepts editor input while startup hydration is pending", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "sumocode-rpc-early-input-agent-"));
		app = spawnSumocodePty({ env: { PI_CODING_AGENT_DIR: agentDir }, cols: 100, rows: 30 });

		await app.waitForOutput(PI_BOOT_SEQUENCE, 15_000);
		app.sendInput("hello");
		await app.waitForOutput("hello", 2_000);

		// This test owns only the early-input contract. Ctrl-C has separate
		// draft-clearing semantics (first press clears non-empty input), so using
		// it for cleanup made the test race hydration and assert the wrong owner.
		app.sendSignal("SIGTERM");
		await app.waitForOutput(TERMINAL_CLEANUP_SEQUENCE, 5_000);
		expect(app.getCurrentTerminalState().altscreenActive).toBe(false);
	}, 30_000);

	it("opens the host command palette from Ctrl+/", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "sumocode-rpc-palette-agent-"));
		app = spawnSumocodePty({ env: { PI_CODING_AGENT_DIR: agentDir }, cols: 100, rows: 30 });

		await app.waitForOutput(PI_BOOT_SEQUENCE, 15_000);
		await app.waitForOutput("DIVINE INVOCATION", 15_000);
		await app.waitForOutput(/CTRL\+\/[\s\S]*COMMANDS/, 15_000);
		app.sendInput("\u001f");

		await app.waitForOutput("host controls", 10_000);
	}, 30_000);
});
