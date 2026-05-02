import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import xterm from "@xterm/headless";
import { afterEach, describe, expect, it } from "vitest";
import { spawnPiPty, type SpawnedPiPty } from "./spawn-pi-pty.js";

const ANSI_PATTERN = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)|_[^\x07]*(?:\x07|\x1b\\))/g;

let app: SpawnedPiPty | undefined;

afterEach(() => {
	app?.cleanup();
	app = undefined;
});

function stripAnsi(text: string): string {
	return text.replace(ANSI_PATTERN, "");
}

async function replayTerminalRows(output: string, cols: number, rows: number): Promise<string[]> {
	const term = new xterm.Terminal({ cols, rows, allowProposedApi: true, scrollback: 0 });
	await new Promise<void>((resolve) => term.write(output, () => resolve()));
	const buffer = term.buffer.active;
	const lines: string[] = [];
	for (let row = 0; row < rows; row += 1) {
		const line = buffer.getLine(row);
		let s = "";
		for (let col = 0; col < cols; col += 1) s += line?.getCell(col)?.getChars() ?? " ";
		lines.push(s);
	}
	return lines;
}

async function expectNarrowBoot(cols: number, rows: number): Promise<void> {
	const agentDir = await mkdtemp(join(tmpdir(), "sumocode-pi-agent-"));
	app = spawnPiPty({
		cols,
		rows,
		env: {
			PI_CODING_AGENT_DIR: agentDir,
			SUMO_TUI: "1",
			SUMO_TUI_HIDE_PI_NOISE: "1",
			SUMO_TUI_MODULE: pathToFileURL(join(process.cwd(), "sumo-interactive-mode.js")).href,
		},
	});

	await app.waitForOutput("DIVINE INVOCATION", 10_000);
	await new Promise((resolve) => setTimeout(resolve, 250));

	const output = app.getOutput();
	expect(output).not.toMatch(/Rendered line \d+ exceeds terminal width/);

	// Narrow boot validity: every cell-grid row that xterm replays must fit
	// within `cols`. The previous \n-split heuristic broke when SumoTUI's
	// owned-shell renderer started writing positioned patches without
	// newlines between rows; xterm replay is the right ground truth.
	const replayedRows = (await replayTerminalRows(output, cols, rows)).map((line) => stripAnsi(line));
	for (const row of replayedRows) expect(row.length).toBeLessThanOrEqual(cols);

	app.cleanup();
	app = undefined;
}

describe("sumo-tui narrow-width boot integration", () => {
	it("renders cleanly at Mac mini portrait width (40×100)", async () => {
		await expectNarrowBoot(40, 100);
	}, 20_000);

	it("renders cleanly at extreme narrow width (30×24)", async () => {
		await expectNarrowBoot(30, 24);
	}, 20_000);
});
