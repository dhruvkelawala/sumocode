import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { spawnPiPty, type SpawnedPiPty } from "./spawn-pi-pty.js";

let app: SpawnedPiPty | undefined;

afterEach(() => {
	app?.cleanup();
	app = undefined;
});

describe("owned-shell bash command POC", () => {
	it("renders bang-command bash output in owned-shell chat", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "sumocode-bash-owned-shell-"));
		app = spawnPiPty({
			cols: 100,
			rows: 40,
			args: ["--offline", "--no-extensions", "-e", "./src/extension.ts", "--no-session"],
			env: {
				PI_CODING_AGENT_DIR: agentDir,
				SUMO_TUI: "1",
				SUMO_TUI_HIDE_PI_NOISE: "1",
				SUMO_TUI_MODULE: pathToFileURL(join(process.cwd(), "sumo-interactive-mode.js")).href,
			},
		});

		await app.waitForOutput(/DIVINE INVOCATION/, 12_000);
		app.sendInput("!echo POC_BASH_VISIBLE\r");
		await app.waitForOutput(/POC_BASH_VISIBLE/, 12_000);
		expect(app.getOutput()).toContain("POC_BASH_VISIBLE");
	}, 20_000);
});
