import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TERMINAL_CLEANUP_SEQUENCE } from "../../src/sumo-tui/runtime/terminal-controller.js";
import { createRpcChildFixture } from "./rpc-child-fixture.js";
import { PI_BOOT_SEQUENCE, spawnSumocodePty, waitForScreen, type SpawnedPiPty } from "./spawn-pi-pty.js";

const CSI_U_ENTER = "\x1b[13u";

let app: SpawnedPiPty | undefined;

afterEach(() => {
	app?.cleanup();
	app = undefined;
});

describe("sumocode RPC compaction UX", () => {
	it("shows manual compaction progress before the persistent summary pill", async () => {
		const cols = 100;
		const rows = 30;
		const piBin = await createRpcChildFixture("sumocode-rpc-compact-child-", {
			compactDelayMs: 750,
			compactReason: "manual",
			compactSummary: "Kept the current plan and runtime evidence.",
			compactTokensBefore: 42000,
		});
		const agentDir = await mkdtemp(join(tmpdir(), "sumocode-rpc-compact-agent-"));
		app = spawnSumocodePty({
			env: {
				PI_CODING_AGENT_DIR: agentDir,
				PI_BIN: piBin,
			},
			cols,
			rows,
		});

		await app.waitForOutput(PI_BOOT_SEQUENCE, 15_000);
		await app.waitForOutput("DIVINE INVOCATION", 15_000);
		await app.waitForOutput(/CTRL\+\/[\s\S]*COMMANDS/, 15_000);

		app.sendInput(`/compact keep runtime evidence${CSI_U_ENTER}`);

		const compactingScreen = await waitForScreen(
			app,
			(screen) => screen.text.includes("Compacting…") && !screen.text.includes("[compaction] Compacted"),
			{ cols, rows, timeoutMs: 2_000 },
		);
		expect(compactingScreen.text).toContain("Compacting…");

		const finalScreen = await waitForScreen(
			app,
			(screen) => screen.text.includes("[compaction] Compacted from 42,000 tokens"),
			{ cols, rows, timeoutMs: 5_000 },
		);
		expect(finalScreen.text).toContain("[compaction] Compacted from 42,000 tokens");

		const activeState = app.getCurrentTerminalState();
		expect(activeState.altscreenActive).toBe(true);
		expect(activeState.mouseSGRActive).toBe(true);
		expect(activeState.cleanupSequenceSeen).toBe(false);

		app.sendSignal("SIGTERM");
		await app.waitForOutput(TERMINAL_CLEANUP_SEQUENCE, 5_000);
		expect(app.getCurrentTerminalState().cleanupSequenceSeen).toBe(true);
	}, 30_000);
});
