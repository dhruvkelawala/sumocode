import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PI_BOOT_SEQUENCE, spawnSumocodePty, waitForScreenText, type SpawnedPiPty } from "./spawn-pi-pty.js";

let app: SpawnedPiPty | undefined;

afterEach(async () => {
	await app?.cleanupAndWait();
	app = undefined;
});

describe("sumo-tui editor cursor integration", () => {
	it("renders typed RPC editor text with the shell-owned cursor active", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "sumocode-pi-agent-"));
		app = spawnSumocodePty({
			env: {
				PI_CODING_AGENT_DIR: agentDir,
			},
		});

		await app.waitForOutput(PI_BOOT_SEQUENCE, 10_000);
		await waitForScreenText(app, "DIVINE INVOCATION", 10_000);

		const typed = "_ZQXJW";
		app.sendInput(typed);
		await waitForScreenText(app, typed, 5_000);

		const activeState = app.getCurrentTerminalState();
		expect(activeState.altscreenActive).toBe(true);
		expect(activeState.cursorVisible).toBe(true);
	}, 30_000);
});
