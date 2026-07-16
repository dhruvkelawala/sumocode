import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import xterm from "@xterm/headless";
import { afterEach, describe, expect, it } from "vitest";
import { PI_BOOT_SEQUENCE, spawnSumocodePty, type SpawnedPiPty } from "./spawn-pi-pty.js";

let app: SpawnedPiPty | undefined;

afterEach(() => {
	app?.cleanup();
	app = undefined;
});

async function replayRows(output: string, cols = 100, rows = 30): Promise<string[]> {
	const term = new xterm.Terminal({ cols, rows, allowProposedApi: true, scrollback: 0 });
	await new Promise<void>((resolve) => term.write(output, () => resolve()));
	const buffer = term.buffer.active;
	const lines: string[] = [];
	for (let row = 0; row < rows; row += 1) {
		const line = buffer.getLine(row);
		let text = "";
		for (let col = 0; col < cols; col += 1) text += line?.getCell(col)?.getChars() ?? " ";
		lines.push(text);
	}
	return lines;
}

async function waitForEditorText(pty: SpawnedPiPty, text: string): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		const rows = await replayRows(pty.getOutput());
		if (rows.some((row) => row.includes(text))) return;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error(`Timed out waiting for editor text ${JSON.stringify(text)}. Last output: ${JSON.stringify(pty.getOutput().slice(-1200))}`);
}

describe("sumo-tui editor cursor integration", () => {
	it("renders typed RPC editor text with the shell-owned cursor active", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "sumocode-pi-agent-"));
		app = spawnSumocodePty({
			env: {
				PI_CODING_AGENT_DIR: agentDir,
			},
		});

		await app.waitForOutput(PI_BOOT_SEQUENCE, 10_000);
		await app.waitForOutput("DIVINE INVOCATION", 10_000);

		const typed = "_ZQXJW";
		app.sendInput(typed);
		await waitForEditorText(app, typed);

		const activeState = app.getCurrentTerminalState();
		expect(activeState.altscreenActive).toBe(true);
		expect(activeState.cursorVisible).toBe(true);
	}, 30_000);
});
