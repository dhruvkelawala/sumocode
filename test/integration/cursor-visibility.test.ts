import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { PI_BOOT_SEQUENCE, spawnPiPty, type SpawnedPiPty } from "./spawn-pi-pty.js";

let app: SpawnedPiPty | undefined;

afterEach(() => {
	app?.cleanup();
	app = undefined;
});

function latestVisibleCursorColumn(output: string): number | undefined {
	const pattern = /\x1b\[(\d+)G\x1b\[\?25h/g;
	let latest: number | undefined;
	for (let match = pattern.exec(output); match !== null; match = pattern.exec(output)) {
		latest = Number.parseInt(match[1]!, 10);
	}
	return latest;
}

async function waitForCursorVisible(pty: SpawnedPiPty): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		if (pty.getCurrentTerminalState().cursorVisible) return;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error(`Timed out waiting for hardware cursor to become visible. Last output: ${JSON.stringify(pty.getOutput().slice(-1200))}`);
}

async function waitForCursorAdvance(pty: SpawnedPiPty, previousColumn: number, text: string): Promise<number> {
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		const output = pty.getOutput();
		const column = latestVisibleCursorColumn(output);
		if (output.includes(text) && column !== undefined && column > previousColumn) return column;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error(`Timed out waiting for visible cursor after ${JSON.stringify(text)}. Last output: ${JSON.stringify(pty.getOutput().slice(-1200))}`);
}

describe("sumo-tui cursor visibility integration", () => {
	it("shows the hardware cursor and advances it with each typed character", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "sumocode-pi-agent-"));
		app = spawnPiPty({
			env: {
				PI_CODING_AGENT_DIR: agentDir,
				PI_HARDWARE_CURSOR: "1",
				SUMO_TUI: "1",
				SUMO_TUI_HIDE_PI_NOISE: "1",
				SUMO_TUI_MODULE: pathToFileURL(join(process.cwd(), "sumo-interactive-mode.js")).href,
			},
		});

		await app.waitForOutput(PI_BOOT_SEQUENCE, 10_000);
		await app.waitForOutput("DIVINE INVOCATION", 10_000);
		await waitForCursorVisible(app);
		expect(app.getCurrentTerminalState().cursorVisible).toBe(true);

		let typed = "";
		let previousColumn = 0;
		for (const char of "ZQXJW") {
			typed += char;
			app.sendInput(char);
			const nextColumn = await waitForCursorAdvance(app, previousColumn, typed);
			expect(nextColumn).toBeGreaterThan(previousColumn);
			previousColumn = nextColumn;
			expect(app.getCurrentTerminalState().cursorVisible).toBe(true);
		}
	}, 30_000);
});
