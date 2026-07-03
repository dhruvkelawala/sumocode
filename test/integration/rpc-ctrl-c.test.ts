import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TERMINAL_CLEANUP_SEQUENCE } from "../../src/sumo-tui/runtime/terminal-controller.js";
import { PI_BOOT_SEQUENCE, spawnSumocodePty, type SpawnedPiPty } from "./spawn-pi-pty.js";
import { createRpcChildFixture } from "./rpc-child-fixture.js";

const CTRL_C = "\x1b[99;5u";
const CSI_U_ENTER = "\x1b[13u";

let app: SpawnedPiPty | undefined;

afterEach(() => {
	app?.cleanup();
	app = undefined;
});

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function bootRpcHost(prefix: string): Promise<SpawnedPiPty> {
	const agentDir = await mkdtemp(join(tmpdir(), prefix));
	const spawned = spawnSumocodePty({ env: { PI_CODING_AGENT_DIR: agentDir }, cols: 100, rows: 30 });
	await spawned.waitForOutput(PI_BOOT_SEQUENCE, 15_000);
	await spawned.waitForOutput("DIVINE INVOCATION", 15_000);
	await spawned.waitForOutput("AWAITING PROMPT", 15_000);
	return spawned;
}

async function bootRpcHostWithPiFixture(prefix: string, piBin: string): Promise<SpawnedPiPty> {
	const agentDir = await mkdtemp(join(tmpdir(), prefix));
	const spawned = spawnSumocodePty({
		env: {
			PI_CODING_AGENT_DIR: agentDir,
			PI_BIN: piBin,
		},
		cols: 100,
		rows: 30,
	});
	await spawned.waitForOutput(PI_BOOT_SEQUENCE, 15_000);
	await spawned.waitForOutput("DIVINE INVOCATION", 15_000);
	await spawned.waitForOutput("AWAITING PROMPT", 15_000);
	return spawned;
}

describe("sumocode RPC Ctrl-C semantics", () => {
	it("clears a typed draft and keeps the process alive", async () => {
		app = await bootRpcHost("sumocode-rpc-ctrl-c-agent-");

		app.sendInput("draft-before-clear");
		await app.waitForOutput("draft-before-clear", 5_000);

		app.sendInput(CTRL_C);
		await app.waitForOutput("draft cleared", 5_000);

		app.sendInput("after-ctrl-c\r");
		await app.waitForOutput("after-ctrl-c", 5_000);
		await delay(300);

		const output = app.getOutput();
		expect(output).toContain("after-ctrl-c");
		expect(output).not.toContain("draft-before-clearafter-ctrl-c");
	}, 30_000);

	it("exits cleanly on double Ctrl-C with no draft", async () => {
		app = await bootRpcHost("sumocode-rpc-double-ctrl-c-agent-");

		app.sendInput(CTRL_C);
		await app.waitForOutput("press ctrl-c again to quit", 5_000);
		app.sendInput(CTRL_C);
		await app.waitForOutput(TERMINAL_CLEANUP_SEQUENCE, 5_000);

		const state = app.getCurrentTerminalState();
		expect(state.cleanupSequenceSeen).toBe(true);
		expect(state.altscreenActive).toBe(false);
		expect(state.mouseSGRActive).toBe(false);
		expect(state.cursorVisible).toBe(true);
	}, 30_000);

	it("aborts a streaming turn and keeps the session alive", async () => {
		const piBin = await createRpcChildFixture("sumocode-rpc-streaming-child-", {
			holdPromptUntilAbort: true,
		});
		app = await bootRpcHostWithPiFixture("sumocode-rpc-streaming-agent-", piBin);

		app.sendInput(`hold this streaming response${CSI_U_ENTER}`);
		await app.waitForOutput("MEDITATING", 5_000);
		await app.waitForOutput("streaming fixture response", 5_000);

		app.sendInput(CTRL_C);
		await app.waitForOutput("abort requested", 5_000);
		await app.waitForOutput("aborted by fixture", 5_000);

		app.sendInput(`second prompt after abort${CSI_U_ENTER}`);
		await app.waitForOutput("fixture response complete: second prompt after abort", 5_000);

		const state = app.getCurrentTerminalState();
		expect(state.altscreenActive).toBe(true);
		expect(state.mouseSGRActive).toBe(true);
		expect(state.cleanupSequenceSeen).toBe(false);
		expect(app.getOutput()).toContain("fixture response complete: second prompt after abort");
	}, 30_000);
});
