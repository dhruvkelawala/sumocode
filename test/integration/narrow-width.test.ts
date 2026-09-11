import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { replayScreenRows, spawnSumocodePty, waitForScreenText, type SpawnedPiPty } from "./spawn-pi-pty.js";

let app: SpawnedPiPty | undefined;

afterEach(async () => {
	await app?.cleanupAndWait();
	app = undefined;
});

async function expectNarrowBoot(cols: number, rows: number): Promise<void> {
	const agentDir = await mkdtemp(join(tmpdir(), "sumocode-pi-agent-"));
	app = spawnSumocodePty({
		cols,
		rows,
		env: {
			PI_CODING_AGENT_DIR: agentDir,
		},
	});

	await waitForScreenText(app, "DIVINE INVOCATION", 10_000);
	await new Promise((resolve) => setTimeout(resolve, 250));

	const output = app.getOutput();
	expect(output).not.toMatch(/Rendered line \d+ exceeds terminal width/);

	// Narrow boot validity: every cell-grid row that xterm replays must fit
	// within `cols`. The previous \n-split heuristic broke when SumoTUI's
	// owned-shell renderer started writing positioned patches without
	// newlines between rows; xterm replay is the right ground truth.
	const replayedRows = await replayScreenRows(output, cols, rows);
	for (const row of replayedRows) expect(row.length).toBeLessThanOrEqual(cols);

	await app.cleanupAndWait();
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
