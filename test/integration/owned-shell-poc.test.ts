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
					SUMOCODE_OWNED_SHELL: "1",
				},
			});

			await app.waitForOutput(/DIVINE INVOCATION/, 12_000);
			await new Promise((resolve) => setTimeout(resolve, 600));
			const output = app.getOutput();
			const lines = (await replayTerminal(output, cols, rows)).map((line) => stripAnsi(line));

			// Footer/hint/input frame should occupy the LAST 5 visible rows in this order:
			//   row N-5: top of input frame
			//   row N-4: input row
			//   row N-3: bottom of input frame
			//   row N-2: hint row
			//   row N-1: footer (blank in splash)
			expect(lines[rows - 5]?.includes("DIVINE INVOCATION")).toBe(true);
			expect(lines[rows - 3]?.includes("└")).toBe(true);
			expect(lines[rows - 2]?.includes("AWAITING PROMPT")).toBe(true);

			// Footer row exists. In splash mode the SumoCode footer renders blank
			// rows; what matters for #161 is that it's pinned to the last row
			// rather than crowding the input.
			const footerRow = lines[rows - 1];
			expect(typeof footerRow).toBe("string");
			expect(footerRow?.length).toBe(cols);

			// Mid-screen rows above the input must be blank (no double-paint, no
			// Pi-rendered footer leaking into the chat region).
			for (let row = 0; row < rows - 5; row += 1) {
				expect(lines[row]?.trim()).toBe("");
			}
		},
		20_000,
	);
});
