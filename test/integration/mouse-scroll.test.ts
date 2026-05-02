import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MOUSE_SGR_ENABLE_SEQUENCE } from "../../src/sumo-tui/runtime/terminal-controller.js";
import { spawnPiPty, type SpawnedPiPty } from "./spawn-pi-pty.js";

let app: SpawnedPiPty | undefined;

afterEach(() => {
	app?.cleanup();
	app = undefined;
});

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("sumo-tui mouse SGR integration", () => {
	it("keeps SGR wheel events out of the editor input buffer (EC-8.3)", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "sumocode-pi-agent-"));
		app = spawnPiPty({ env: { PI_CODING_AGENT_DIR: agentDir } });

		await app.waitForOutput(MOUSE_SGR_ENABLE_SEQUENCE, 10_000);
		await app.waitForOutput("DIVINE INVOCATION", 10_000);
		await app.waitForOutput("\x1b[?2004h", 10_000);
		app.sendInput("phase1-scroll-proof");
		await app.waitForOutput("phase1-scroll-proof", 5_000);

		app.sendInput("\x1b[<64;10;10M\x1b[<65;10;10M\x1b[<64;10;10m\x1b[<65;10;10m");
		await delay(300);

		const output = app.getOutput();
		const state = app.getCurrentTerminalState();
		expect(state.mouseSGRActive).toBe(true);
		expect(output).toContain("phase1-scroll-proof");
		expect(output).not.toContain("[<64;10;10M");
		expect(output).not.toContain("[<65;10;10M");
	});
});
