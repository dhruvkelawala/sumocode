import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import xterm from "@xterm/headless";
import { afterEach, describe, expect, it } from "vitest";
import { PI_BOOT_SEQUENCE, spawnSumocodePty, type SpawnedPiPty } from "./spawn-pi-pty.js";
import { createRpcChildFixture, transcriptMessages } from "./rpc-child-fixture.js";

const CSI_U_ENTER = "\x1b[13u";

let app: SpawnedPiPty | undefined;

afterEach(() => {
	app?.cleanup();
	app = undefined;
});

async function replayTerminalRows(output: string, cols: number, rows: number): Promise<string[]> {
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

describe("sumocode RPC session switching", () => {
	it("/new stays in altscreen and updates chrome to the new session", async () => {
		const cols = 100;
		const rows = 30;
		const piBin = await createRpcChildFixture("sumocode-rpc-new-session-child-", {
			sessionName: "Original Session",
			messages: transcriptMessages(2, "old session"),
		});
		const agentDir = await mkdtemp(join(tmpdir(), "sumocode-rpc-new-session-agent-"));
		app = spawnSumocodePty({
			env: {
				PI_CODING_AGENT_DIR: agentDir,
				PI_BIN: piBin,
			},
			cols,
			rows,
		});

		await app.waitForOutput(PI_BOOT_SEQUENCE, 15_000);
		await app.waitForOutput("Original Session", 15_000);

		app.sendInput(`/new${CSI_U_ENTER}`);
		await app.waitForOutput("new session", 5_000);

		const finalScreen = (await replayTerminalRows(app.getOutput(), cols, rows)).join("\n");

		const state = app.getCurrentTerminalState();
		expect(state.altscreenActive).toBe(true);
		expect(state.mouseSGRActive).toBe(true);
		expect(state.cleanupSequenceSeen).toBe(false);
		expect(finalScreen).toContain("new session");
		expect(finalScreen).not.toContain("Original Session");
		expect(finalScreen).not.toContain("old session anchor");
	}, 30_000);
});
