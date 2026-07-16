import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MOUSE_SGR_ENABLE_SEQUENCE } from "../../src/sumo-tui/runtime/terminal-controller.js";
import { createRpcChildFixture, transcriptMessages } from "./rpc-child-fixture.js";
import { spawnSumocodePty, waitForScreen, type SpawnedPiPty } from "./spawn-pi-pty.js";

const CSI_U_ENTER = "\x1b[13u";

let app: SpawnedPiPty | undefined;

afterEach(() => {
	app?.cleanup();
	app = undefined;
});

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
			// Each chunk also renames the session to "stream-chunk-<N>-landed",
			// giving this test an always-visible chrome sentinel for chunk
			// arrival while the streaming tail itself is scrolled off screen.
			streamChunkSentinels: true,
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

		// Scroll up while the response is still streaming. The scrolled-up
		// state is directly observable: history rows enter the chat viewport
		// and the streaming draft leaves it.
		app.sendInput(wheelUpEvents(30));
		await waitForScreen(
			app,
			(screen) => {
				const viewport = chatViewportRows(screen.rows).join("\n");
				return viewport.includes("history proof") && !viewport.includes("streaming chunk");
			},
			{ cols, rows, timeoutMs: 5_000 },
		);

		// Wait for chunk three's on-screen sentinel: the fixture renames the
		// session after each chunk and the session name renders in the
		// always-visible chrome, so this observes "chunks two and three landed
		// WHILE scrolled up" without wall-clock guessing. waitForOutput cannot
		// help here -- while scrolled away from the streaming tail the draft
		// rows are never painted, so chunk text never enters the byte stream.
		const midStream = await waitForScreen(
			app,
			(screen) => screen.text.includes("stream-chunk-3"),
			{ cols, rows, timeoutMs: 10_000 },
		);
		const midStreamViewport = chatViewportRows(midStream.rows).join("\n");

		// The viewport must REMAIN scrolled up: top-of-transcript content is
		// still visible and the streaming draft is NOT -- if the pager had
		// done a full replaceViewModels per delta (the pre-B9 behavior), each
		// chunk would have reset scrollBox.manualScroll and jumped back to the
		// bottom, and this would fail.
		expect(midStreamViewport).toContain("history proof");
		expect(midStreamViewport).not.toContain("streaming chunk");
		// The scrolled-up banner must be visible while manually scrolled away
		// from the streaming tail.
		expect(midStream.text).toContain("new message");

		// Scroll back to the bottom and let the stream finish. Back at the
		// bottom, following resumes: the final chunk becomes visible in the
		// viewport and the scrolled-up banner clears.
		app.sendInput(wheelDownEvents(60));
		await waitForScreen(
			app,
			(screen) => {
				const viewport = chatViewportRows(screen.rows).join("\n");
				return viewport.includes("streaming chunk four") && !screen.text.includes("new message");
			},
			{ cols, rows, timeoutMs: 10_000 },
		);
	}, 30_000);
});
