import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TERMINAL_CLEANUP_SEQUENCE } from "../../src/sumo-tui/runtime/terminal-controller.js";
import { PI_BOOT_SEQUENCE, spawnPiPty, spawnSumocodePty, type SpawnedPiPty } from "./spawn-pi-pty.js";
import { createRpcChildFixture } from "./rpc-child-fixture.js";

const CSI_U_ENTER = "\x1b[13u";

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
	for (let attempt = 0; attempt < 500; attempt += 1) {
		try {
			process.kill(pid, 0);
		} catch {
			return;
		}
		await delay(10);
	}
	throw new Error(`process ${pid} remained alive after early host signal`);
}

async function waitForFileText(path: string, expected: string, attempts = 200): Promise<void> {
	for (let attempt = 0; attempt < attempts; attempt += 1) {
		try {
			if ((await readFile(path, "utf8")) === expected) return;
		} catch {}
		await delay(10);
	}
	throw new Error(`timed out waiting for ${path} to contain ${expected}; output=${app?.getOutput()}`);
}

describe("sumocode RPC host shell integration", () => {
	it("dispatches a queued prompt only after a deferred model cycle applies", async () => {
		const logDir = await mkdtemp(join(tmpdir(), "sumocode-rpc-model-cycle-order-"));
		const logPath = join(logDir, "commands.jsonl");
		const piBin = await createRpcChildFixture("sumocode-rpc-model-cycle-child-", {
			initialHydrationRace: true,
			initialHydrationDelayMs: 2_500,
		});
		const agentDir = await mkdtemp(join(tmpdir(), "sumocode-rpc-model-cycle-agent-"));
		app = spawnSumocodePty({
			env: { PI_BIN: piBin, PI_CODING_AGENT_DIR: agentDir, SUMOCODE_RPC_FIXTURE_LOG: logPath },
			cols: 100,
			rows: 30,
		});

		// The splash editor accepts input before hydration completes; wait for it so
		// the child stdin is reading, then act inside the 2.5s hydration window.
		await app.waitForOutput(/CTRL\+\/[\s\S]*COMMANDS/, 15_000);
		// Cycle the model (Ctrl+P, kitty encoding) then submit a prompt. The submit
		// must wait for the deferred cycle's set_model to apply.
		app.sendInput("\x1b[112;5u");
		await delay(50);
		app.sendInput(`hello world${CSI_U_ENTER}`);
		await app.waitForOutput("fixture response complete: hello world", 15_000);

		const log = (await readFile(logPath, "utf8")).trim().split("\n")
			.map((line) => JSON.parse(line) as { type: string; provider?: string; modelId?: string; message?: string });
		const setModelIndex = log.findIndex((command) => command.type === "set_model");
		const promptIndex = log.findIndex((command) => command.type === "prompt" && command.message === "hello world");
		expect(setModelIndex).toBeGreaterThanOrEqual(0);
		expect(promptIndex).toBeGreaterThanOrEqual(0);
		expect(setModelIndex).toBeLessThan(promptIndex);
		expect(log[setModelIndex]).toMatchObject({ provider: "anthropic", modelId: "claude-opus-4" });
	}, 30_000);

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

	it("reaps the pre-spawned child across repeated signals before host adoption", async () => {
		const directory = await mkdtemp(join(tmpdir(), "sumocode-rpc-early-signal-"));
		const piBin = join(directory, "stalled-pi");
		const pidFile = join(directory, "pid");
		const exitCodeFile = join(directory, "exit-code");
		await writeFile(
			piBin,
			"#!/usr/bin/env node\nprocess.on('SIGTERM', () => {});\nrequire('node:fs').writeFileSync(process.env.PID_FILE, String(process.pid));\nprocess.stdin.resume();\nsetInterval(() => {}, 1000);\n",
			{ mode: 0o700 },
		);
		app = spawnPiPty({
			command: process.execPath,
			args: [join(process.cwd(), "sumo-rpc-host.js")],
			env: {
				PI_BIN: piBin,
				PID_FILE: pidFile,
				PI_CODING_AGENT_DIR: join(directory, "agent"),
				SUMOCODE_EXIT_CODE_FILE: exitCodeFile,
				SUMOCODE_TEST_PRE_ADOPTION_DELAY_MS: "5000",
				NODE_ENV: "test",
			},
			cols: 100,
			rows: 30,
		});

		const pid = await waitForPid(pidFile);
		app.sendSignal("SIGTERM");
		await delay(50);
		app.sendSignal("SIGTERM");
		await waitForProcessExit(pid);
		await waitForFileText(exitCodeFile, "0");
	}, 30_000);

	it("never adopts or enters altscreen when a signal lands in the import-tail window", async () => {
		const directory = await mkdtemp(join(tmpdir(), "sumocode-rpc-import-tail-signal-"));
		const piBin = join(directory, "stalled-pi");
		const pidFile = join(directory, "pid");
		const exitCodeFile = join(directory, "exit-code");
		// The child ignores SIGTERM, so early cleanup must escalate to SIGKILL while
		// the import-tail window is held open — the exact overlap with adoption.
		await writeFile(
			piBin,
			"#!/usr/bin/env node\nprocess.on('SIGTERM', () => {});\nrequire('node:fs').writeFileSync(process.env.PID_FILE, String(process.pid));\nprocess.stdin.resume();\nsetInterval(() => {}, 1000);\n",
			{ mode: 0o700 },
		);
		app = spawnPiPty({
			command: process.execPath,
			args: [join(process.cwd(), "sumo-rpc-host.js")],
			env: {
				PI_BIN: piBin,
				PID_FILE: pidFile,
				PI_CODING_AGENT_DIR: join(directory, "agent"),
				SUMOCODE_EXIT_CODE_FILE: exitCodeFile,
				SUMOCODE_TEST_PRE_MAIN_DELAY_MS: "5000",
				NODE_ENV: "test",
			},
			cols: 100,
			rows: 30,
		});

		const pid = await waitForPid(pidFile);
		app.sendSignal("SIGTERM");
		await waitForProcessExit(pid);
		await waitForFileText(exitCodeFile, "0");
		// Adoption never happened, so the retained runtime/altscreen never started.
		expect(app.getOutput()).not.toContain("\x1b[?1049h");
		expect(app.getCurrentTerminalState().altscreenActive).toBe(false);
	}, 30_000);

	it("reaps an adopted SIGTERM-ignoring child across repeated signals", async () => {
		const directory = await mkdtemp(join(tmpdir(), "sumocode-rpc-adopted-repeat-signal-"));
		const piBin = join(directory, "stalled-pi");
		const pidFile = join(directory, "pid");
		const exitCodeFile = join(directory, "exit-code");
		await writeFile(
			piBin,
			"#!/usr/bin/env node\nprocess.on('SIGTERM', () => {});\nrequire('node:fs').writeFileSync(process.env.PID_FILE, String(process.pid));\nprocess.stdin.resume();\nsetInterval(() => {}, 1000);\n",
			{ mode: 0o700 },
		);
		app = spawnPiPty({
			command: process.execPath,
			args: [join(process.cwd(), "sumo-rpc-host.js")],
			env: {
				PI_BIN: piBin,
				PID_FILE: pidFile,
				PI_CODING_AGENT_DIR: join(directory, "agent"),
				SUMOCODE_EXIT_CODE_FILE: exitCodeFile,
			},
			cols: 100,
			rows: 30,
		});

		await app.waitForOutput(PI_BOOT_SEQUENCE, 15_000);
		const pid = await waitForPid(pidFile);
		app.sendSignal("SIGTERM");
		await delay(50);
		app.sendSignal("SIGTERM");
		await waitForProcessExit(pid);
		await waitForFileText(exitCodeFile, "0");
	}, 30_000);

	it("restores altscreen when shutdown starts during adopted branch lookup", async () => {
		const directory = await mkdtemp(join(tmpdir(), "sumocode-rpc-adopted-branch-signal-"));
		const piBin = join(directory, "stalled-pi");
		const gitBin = join(directory, "git");
		const pidFile = join(directory, "pid");
		const gitStartedFile = join(directory, "git-started");
		const exitCodeFile = join(directory, "exit-code");
		await writeFile(
			piBin,
			"#!/usr/bin/env node\nprocess.on('SIGTERM', () => {});\nrequire('node:fs').writeFileSync(process.env.PID_FILE, String(process.pid));\nprocess.stdin.resume();\nsetInterval(() => {}, 1000);\n",
			{ mode: 0o700 },
		);
		await writeFile(
			gitBin,
			"#!/usr/bin/env node\nrequire('node:fs').writeFileSync(process.env.GIT_STARTED_FILE, 'started');\nsetTimeout(() => process.stdout.write('main\\n'), 1500);\n",
			{ mode: 0o700 },
		);
		app = spawnPiPty({
			command: process.execPath,
			args: [join(process.cwd(), "sumo-rpc-host.js")],
			env: {
				PI_BIN: piBin,
				PID_FILE: pidFile,
				GIT_STARTED_FILE: gitStartedFile,
				PI_CODING_AGENT_DIR: join(directory, "agent"),
				SUMOCODE_EXIT_CODE_FILE: exitCodeFile,
				PATH: `${directory}:${process.env.PATH ?? ""}`,
			},
			cols: 100,
			rows: 30,
		});

		const pid = await waitForPid(pidFile);
		await waitForFileText(gitStartedFile, "started", 1_000);
		await app.waitForOutput("\x1b[?1049h", 5_000);
		app.sendSignal("SIGTERM");
		await waitForProcessExit(pid);
		await waitForFileText(exitCodeFile, "0");
		const terminal = app.getCurrentTerminalState();
		expect(terminal.altscreenActive).toBe(false);
		expect(terminal.cleanupSequenceSeen).toBe(true);
	}, 30_000);

	it("hydrates before optional branch metadata resolves", async () => {
		const directory = await mkdtemp(join(tmpdir(), "sumocode-rpc-async-branch-hydration-"));
		const piBin = await createRpcChildFixture("sumocode-rpc-async-branch-child-", {
			initialHydrationRace: true,
			initialHydrationDelayMs: 50,
		});
		const gitBin = join(directory, "git");
		const gitStartedFile = join(directory, "git-started");
		const gitFinishedFile = join(directory, "git-finished");
		await writeFile(
			gitBin,
			"#!/usr/bin/env node\nconst fs = require('node:fs');\nif (process.argv.includes('--show-current')) {\n  fs.writeFileSync(process.env.GIT_STARTED_FILE, 'started');\n  setTimeout(() => { fs.writeFileSync(process.env.GIT_FINISHED_FILE, 'finished'); process.stdout.write('main\\n'); }, 1800);\n} else {\n  process.stdout.write('.git/HEAD\\n');\n}\n",
			{ mode: 0o700 },
		);
		app = spawnPiPty({
			command: process.execPath,
			args: [join(process.cwd(), "sumo-rpc-host.js")],
			env: {
				PI_BIN: piBin,
				GIT_STARTED_FILE: gitStartedFile,
				GIT_FINISHED_FILE: gitFinishedFile,
				PI_CODING_AGENT_DIR: join(directory, "agent"),
				PATH: `${directory}:${process.env.PATH ?? ""}`,
			},
			cols: 100,
			rows: 30,
		});

		await waitForFileText(gitStartedFile, "started", 1_000);
		await app.waitForOutput("initial race completed", 5_000);
		await expect(readFile(gitFinishedFile, "utf8")).rejects.toThrow();
		await waitForFileText(gitFinishedFile, "finished", 1_000);
		app.sendSignal("SIGTERM");
		await app.waitForOutput(TERMINAL_CLEANUP_SEQUENCE, 5_000);
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

	it("handles /quit while startup hydration is stalled", async () => {
		const directory = await mkdtemp(join(tmpdir(), "sumocode-rpc-stalled-quit-"));
		const piBin = join(directory, "stalled-pi");
		await writeFile(piBin, "#!/usr/bin/env node\nprocess.stdin.resume();\nsetInterval(() => {}, 1000);\n", { mode: 0o700 });
		app = spawnSumocodePty({
			env: { PI_BIN: piBin, PI_CODING_AGENT_DIR: join(directory, "agent") },
			cols: 100,
			rows: 30,
		});

		await app.waitForOutput(PI_BOOT_SEQUENCE, 15_000);
		app.sendInput(`/quit${CSI_U_ENTER}`);
		await app.waitForOutput(TERMINAL_CLEANUP_SEQUENCE, 3_000);
		expect(app.getCurrentTerminalState().altscreenActive).toBe(false);
	}, 30_000);

	it("replays only the latest mutually exclusive selector after hydration", async () => {
		const piBin = await createRpcChildFixture("sumocode-rpc-deferred-selector-", {
			initialHydrationRace: true,
			initialHydrationDelayMs: 750,
		});
		const agentDir = await mkdtemp(join(tmpdir(), "sumocode-rpc-deferred-selector-agent-"));
		app = spawnSumocodePty({ env: { PI_BIN: piBin, PI_CODING_AGENT_DIR: agentDir }, cols: 100, rows: 30 });

		await app.waitForOutput(PI_BOOT_SEQUENCE, 15_000);
		app.sendInput("\u001f");
		app.sendInput("\u000c");
		await app.waitForOutput("initial race completed", 5_000);
		await delay(250);
		expect(app.getOutput()).not.toContain("host controls");
		app.sendSignal("SIGTERM");
		await app.waitForOutput(TERMINAL_CLEANUP_SEQUENCE, 5_000);
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
