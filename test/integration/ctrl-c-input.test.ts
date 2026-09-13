import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MOUSE_SGR_ENABLE_SEQUENCE } from "../../src/sumo-tui/runtime/terminal-controller.js";
import { spawnPiPty, waitForScreenText, type SpawnedPiPty } from "./spawn-pi-pty.js";

let app: SpawnedPiPty | undefined;

afterEach(async () => {
	await app?.cleanupAndWait();
	app = undefined;
});

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("sumo-tui Ctrl+C input semantics", () => {
	it("clears a draft and keeps the process alive", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "sumocode-pi-agent-"));
		app = spawnPiPty({ env: { PI_CODING_AGENT_DIR: agentDir } });

		await app.waitForOutput(MOUSE_SGR_ENABLE_SEQUENCE, 10_000);
		app.sendInput("draft-before-clear");
		await waitForScreenText(app, "draft-before-clear", 5_000);

		// Ghostty sends Ctrl+C through Kitty keyboard protocol while Pi enables
		// disambiguate mode; raw ETX may be treated by the PTY as SIGINT in tests.
		app.sendInput("\x1b[99;5u");
		await delay(300);

		app.sendInput("after-ctrl-c\r");
		// If Ctrl+C had not cleared the draft, the editor would hold the merged
		// "draft-before-clearafter-ctrl-c", so any stable frame showing the new text
		// also shows the merge. Asserting absence on that same frame is race-free.
		const screen = await waitForScreenText(app, "after-ctrl-c", 5_000);

		expect(screen.text).toContain("after-ctrl-c");
		expect(screen.text).not.toContain("draft-before-clearafter-ctrl-c");
	}, 15_000);
});
