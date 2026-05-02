import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MOUSE_SGR_ENABLE_SEQUENCE } from "../../src/sumo-tui/runtime/terminal-controller.js";
import { spawnPiPty, type SpawnedPiPty } from "./spawn-pi-pty.js";

let app: SpawnedPiPty | undefined;

afterEach(() => {
	app?.cleanup();
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
		await app.waitForOutput("draft-before-clear", 5_000);

		// cmux/Ghostty sends Ctrl+C through Kitty keyboard protocol while Pi enables
		// disambiguate mode; raw ETX may be treated by the PTY as SIGINT in tests.
		app.sendInput("\x1b[99;5u");
		await delay(300);

		app.sendInput("after-ctrl-c\r");
		await app.waitForOutput("after-ctrl-c", 5_000);
		await delay(300);

		const output = app.getOutput();
		expect(output).toContain("after-ctrl-c");
		expect(output).not.toContain("draft-before-clearafter-ctrl-c");
	}, 15_000);
});
