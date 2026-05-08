import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import xterm from "@xterm/headless";
import { afterEach, describe, expect, it } from "vitest";
import { spawnPiPty, type SpawnedPiPty } from "./spawn-pi-pty.js";

let app: SpawnedPiPty | undefined;

afterEach(() => {
	app?.cleanup();
	app = undefined;
});

const ANSI_PATTERN = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)|_[^\x07]*(?:\x07|\x1b\\))/g;

function stripAnsi(text: string): string {
	return text.replace(ANSI_PATTERN, "");
}

async function replayTerminal(output: string, cols: number, rows: number): Promise<string[]> {
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

describe("owned-shell POC (issue #195 / #161 Slice A)", () => {
	it(
		"renders Cathedral splash with footer pinned to terminal-bottom via Yoga flex",
		async () => {
			const cols = 80;
			const rows = 30;
			const agentDir = await mkdtemp(join(tmpdir(), "sumocode-owned-shell-"));
			app = spawnPiPty({
				cols,
				rows,
				args: ["--offline", "--no-extensions", "-e", "./src/extension.ts", "--no-session"],
				env: {
					PI_CODING_AGENT_DIR: agentDir,
					SUMO_TUI: "1",
					SUMO_TUI_HIDE_PI_NOISE: "1",
					SUMO_TUI_MODULE: pathToFileURL(join(process.cwd(), "sumo-interactive-mode.js")).href,
				},
			});

			await app.waitForOutput(/DIVINE INVOCATION/, 12_000);
			await new Promise((resolve) => setTimeout(resolve, 600));
			const output = app.getOutput();
			const lines = (await replayTerminal(output, cols, rows)).map((line) => stripAnsi(line));

			// Footer/hint/input frame should occupy the bottom chrome band in this order:
			//   row N-8: top of input frame
			//   row N-7: input row
			//   row N-6: bottom of input frame
			//   row N-5: breathing row
			//   row N-4: hint row
			//   row N-3: breathing row
			//   row N-2: footer (blank in splash)
			//   row N-1: terminal-bottom safe row
			//
			// Pi 0.74 added the extra breathing row between input frame and hint;
			// previous layout had `└` at N-5 and DIVINE INVOCATION at N-7.
			expect(lines[rows - 8]?.includes("DIVINE INVOCATION")).toBe(true);
			expect(lines[rows - 6]?.includes("└")).toBe(true);
			expect(lines[rows - 4]?.includes("AWAITING PROMPT")).toBe(true);

			const footerRow = lines[rows - 2];
			expect(typeof footerRow).toBe("string");
			expect(footerRow?.length).toBe(cols);

			// Splash now mounts inside the chat-row of the owned-shell tree, so
			// mid-screen rows show the SUMOCODE pixel-letter art rather than
			// being blank. The asserts below pin the splash signature without
			// allowing the Pi-built-in footer ("READY", "sumocode (...)") to leak.
			const chatRegion = lines.slice(0, rows - 6).join("\n");
			expect(chatRegion).toMatch(/█████ █   █ █   █ █████/);
			expect(chatRegion).not.toMatch(/READY/);
			expect(chatRegion).not.toMatch(/MEDITATING/);
		},
		20_000,
	);
});
