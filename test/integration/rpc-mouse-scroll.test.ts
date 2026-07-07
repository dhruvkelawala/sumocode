import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MOUSE_SGR_ENABLE_SEQUENCE } from "../../src/sumo-tui/runtime/terminal-controller.js";
import { createRpcChildFixture, transcriptMessages } from "./rpc-child-fixture.js";
import { replayScreenRows, spawnSumocodePty, waitForScreen, type SpawnedPiPty } from "./spawn-pi-pty.js";

let app: SpawnedPiPty | undefined;

afterEach(() => {
	app?.cleanup();
	app = undefined;
});

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

		const beforeRows = await replayScreenRows(app.getOutput(), cols, rows);
		const beforeAnchors = visibleScrollAnchors(beforeRows);
		const beforeBottomAnchor = Math.max(...beforeAnchors);
		expect(beforeAnchors).toContain(47);

		app.sendInput(wheelUpEvents(20));
		// The scrolled state is directly observable: the bottom-most message
		// (anchor 47) leaves the chat viewport once the wheel events take
		// effect, so wait for that instead of sleeping.
		const scrolled = await waitForScreen(
			app,
			(screen) => {
				const anchors = visibleScrollAnchors(screen.rows);
				return anchors.length > 0 && !anchors.includes(47);
			},
			{ cols, rows, timeoutMs: 5_000 },
		);

		const afterAnchors = visibleScrollAnchors(scrolled.rows);
		const afterBottomAnchor = Math.max(...afterAnchors);
		const afterTopAnchor = Math.min(...afterAnchors);
		expect(scrolled.text).toContain("draft-after-scroll");
		expect(scrolled.text).not.toContain("[<64;10;10M");
		expect(afterTopAnchor).toBeLessThan(Math.min(...beforeAnchors));
		expect(afterBottomAnchor).toBeLessThan(beforeBottomAnchor);
		expect(app.getCurrentTerminalState().mouseSGRActive).toBe(true);
	});
});
