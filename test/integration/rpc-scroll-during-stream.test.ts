import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import xterm from "@xterm/headless";
import { afterEach, describe, expect, it } from "vitest";
import { MOUSE_SGR_ENABLE_SEQUENCE } from "../../src/sumo-tui/runtime/terminal-controller.js";
import { createRpcChildFixture, transcriptMessages } from "./rpc-child-fixture.js";
import { spawnSumocodePty, type SpawnedPiPty } from "./spawn-pi-pty.js";

const ANSI_PATTERN = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)|_[^\x07]*(?:\x07|\x1b\\))/g;
const CSI_U_ENTER = "\x1b[13u";

let app: SpawnedPiPty | undefined;

afterEach(() => {
	app?.cleanup();
	app = undefined;
});

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

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
		let text = "";
		for (let col = 0; col < cols; col += 1) text += line?.getCell(col)?.getChars() ?? " ";
		lines.push(text);
	}
	return lines;
}

async function currentScreen(app: SpawnedPiPty, cols: number, rows: number): Promise<string> {
	return (await replayTerminalRows(app.getOutput(), cols, rows)).map(stripAnsi).join("\n");
}

function chatViewportRows(lines: readonly string[]): readonly string[] {
	return lines.slice(3, 23);
}

function wheelUpEvents(count: number): string {
	return Array.from({ length: count }, () => "\x1b[<64;10;10M").join("");
}

function wheelDownEvents(count: number): string {
	return Array.from({ length: count }, () => "\x1b[<65;10;10M").join("");
}

describe("sumocode RPC scroll-during-stream integration", () => {
	it("keeps the viewport scrolled up while a response streams, and resumes following once scrolled back to bottom", async () => {
		const cols = 100;
		const rows = 30;
		// Enough pre-existing history that scrolling up reveals the top anchor
		// while the live streaming draft (appended after all of this) stays
		// below the viewport -- the scenario the diffing chat sink (B9) must
		// preserve scroll state through: replaceLastWithViewModel/addViewModel
		// must never reset scrollBox.manualScroll/unreadCount while streaming.
		const piBin = await createRpcChildFixture("sumocode-rpc-scroll-stream-child-", {
			sessionName: "Stream Scroll Fixture",
			messages: transcriptMessages(48, "history proof"),
			// Each chunk lands 500ms apart, matching
			// scripts/visual-v2/runtime-faux-provider.mjs's real-stream pacing --
			// slow enough to reliably observe an intermediate streaming state
			// between chunks instead of racing straight to completion.
			streamChunks: ["streaming chunk one ", "streaming chunk two ", "streaming chunk three ", "streaming chunk four "],
			chunkDelayMs: 500,
		});
		const agentDir = await mkdtemp(join(tmpdir(), "sumocode-rpc-scroll-stream-agent-"));
		app = spawnSumocodePty({
			env: {
				PI_CODING_AGENT_DIR: agentDir,
				PI_BIN: piBin,
			},
			cols,
			rows,
		});

		await app.waitForOutput(MOUSE_SGR_ENABLE_SEQUENCE, 15_000);
		await app.waitForOutput("history proof anchor 47", 15_000);

		// Submit a prompt and wait for the first streamed chunk to land.
		app.sendInput(`ask about the anchors${CSI_U_ENTER}`);
		await app.waitForOutput("streaming chunk one", 10_000);

		// Scroll up while the response is still streaming.
		app.sendInput(wheelUpEvents(30));
		await delay(200);

		const scrolledUpAfterFirstChunk = chatViewportRows(await replayTerminalRows(app.getOutput(), cols, rows)).map(stripAnsi).join("\n");
		expect(scrolledUpAfterFirstChunk).toContain("history proof");
		expect(scrolledUpAfterFirstChunk).not.toContain("streaming chunk");

		// Wait through at least two more streamed chunks (each ~500ms apart)
		// while staying scrolled up. Note: while scrolled away from the
		// streaming tail, the draft rows are off-screen and never get painted
		// to the terminal at all -- waitForOutput's raw-byte-stream matching
		// would never see "streaming chunk N" text in that state, so this
		// waits on wall-clock time instead and asserts on the CURRENT
		// (xterm-replayed) terminal state, not on when specific text first
		// appears in the byte stream.
		await delay(1_200);

		const midStreamScreen = await currentScreen(app, cols, rows);
		const midStreamViewport = chatViewportRows((await replayTerminalRows(app.getOutput(), cols, rows))).map(stripAnsi).join("\n");

		// The viewport must REMAIN scrolled up: top-of-transcript content is
		// still visible and the streaming draft is NOT -- if the pager had
		// done a full replaceViewModels per delta (the pre-B9 behavior), each
		// chunk would have reset scrollBox.manualScroll and jumped back to the
		// bottom, and this would fail.
		expect(midStreamViewport).toContain("history proof");
		expect(midStreamViewport).not.toContain("streaming chunk");
		// The scrolled-up banner must be visible while manually scrolled away
		// from the streaming tail.
		expect(midStreamScreen).toContain("new message");

		// Scroll back to the bottom and let the stream finish.
		app.sendInput(wheelDownEvents(60));
		await app.waitForOutput("streaming chunk four", 10_000);
		await delay(300);

		const finalScreen = await currentScreen(app, cols, rows);
		const finalViewport = chatViewportRows((await replayTerminalRows(app.getOutput(), cols, rows))).map(stripAnsi).join("\n");

		// Back at the bottom, following resumes: the final chunk is visible and
		// the scrolled-up banner is gone.
		expect(finalViewport).toContain("streaming chunk four");
		expect(finalScreen).not.toContain("new message");
	}, 30_000);
});
