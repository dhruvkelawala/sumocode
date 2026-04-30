import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
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

function visibleOutputLines(output: string): string[] {
	return stripAnsi(output)
		.replaceAll("\r", "")
		.split("\n")
		.filter((line) => line.length > 0);
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
	const overflowing = visibleOutputLines(output).filter((line) => line.length > cols);
	expect(overflowing).toEqual([]);

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
