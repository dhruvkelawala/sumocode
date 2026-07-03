import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import xterm from "@xterm/headless";
import { afterEach, describe, expect, it } from "vitest";
import { MOUSE_SGR_ENABLE_SEQUENCE } from "../../src/sumo-tui/runtime/terminal-controller.js";
import { createRpcChildFixture, transcriptMessages } from "./rpc-child-fixture.js";
import { spawnSumocodePty, type SpawnedPiPty } from "./spawn-pi-pty.js";

const ANSI_PATTERN = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)|_[^\x07]*(?:\x07|\x1b\\))/g;

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

async function finalScreen(app: SpawnedPiPty, cols: number, rows: number): Promise<string> {
	return (await replayTerminalRows(app.getOutput(), cols, rows)).map(stripAnsi).join("\n");
}

function chatViewportRows(lines: readonly string[]): readonly string[] {
	return lines.slice(3, 23);
}

function visibleScrollAnchors(lines: readonly string[]): number[] {
	return chatViewportRows(lines).flatMap((line) => {
		const match = line.match(/scroll proof anchor (\d+)/);
		return match ? [Number.parseInt(match[1] ?? "", 10)] : [];
	}).filter(Number.isFinite);
}

function wheelUpEvents(count: number): string {
	return Array.from({ length: count }, () => "\x1b[<64;10;10M").join("");
}

describe("sumocode RPC mouse scroll integration", () => {
	it("scrolls transcript with SGR wheel events without leaking bytes into the editor draft", async () => {
		const cols = 100;
		const rows = 30;
		const piBin = await createRpcChildFixture("sumocode-rpc-scroll-child-", {
			sessionName: "Scroll Fixture",
			messages: transcriptMessages(48, "scroll proof"),
		});
		const agentDir = await mkdtemp(join(tmpdir(), "sumocode-rpc-scroll-agent-"));
		app = spawnSumocodePty({
			env: {
				PI_CODING_AGENT_DIR: agentDir,
				PI_BIN: piBin,
			},
			cols,
			rows,
		});

		await app.waitForOutput(MOUSE_SGR_ENABLE_SEQUENCE, 15_000);
		await app.waitForOutput("scroll proof anchor 47", 15_000);
		app.sendInput("draft-after-scroll");
		await app.waitForOutput("draft-after-scroll", 5_000);

		const beforeRows = await replayTerminalRows(app.getOutput(), cols, rows);
		const beforeAnchors = visibleScrollAnchors(beforeRows);
		const beforeBottomAnchor = Math.max(...beforeAnchors);
		expect(beforeAnchors).toContain(47);

		app.sendInput(wheelUpEvents(20));
		await delay(300);

		const afterRows = await replayTerminalRows(app.getOutput(), cols, rows);
		const afterAnchors = visibleScrollAnchors(afterRows);
		const afterBottomAnchor = Math.max(...afterAnchors);
		const afterTopAnchor = Math.min(...afterAnchors);
		const after = await finalScreen(app, cols, rows);
		expect(after).toContain("draft-after-scroll");
		expect(after).not.toContain("[<64;10;10M");
		expect(afterAnchors.length).toBeGreaterThan(0);
		expect(afterTopAnchor).toBeLessThan(Math.min(...beforeAnchors));
		expect(afterBottomAnchor).toBeLessThan(beforeBottomAnchor);
		expect(afterAnchors).not.toContain(47);
		expect(app.getCurrentTerminalState().mouseSGRActive).toBe(true);
	});
});
