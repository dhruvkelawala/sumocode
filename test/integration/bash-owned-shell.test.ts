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

async function startOwnedShell(): Promise<SpawnedPiPty> {
	const agentDir = await mkdtemp(join(tmpdir(), "sumocode-bash-owned-shell-"));
	const pty = spawnPiPty({
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
	await pty.waitForOutput(/DIVINE INVOCATION/, 12_000);
	return pty;
}

describe("owned-shell bash command mirroring", () => {
	it("renders bang-command bash output in retained chat", async () => {
		app = await startOwnedShell();
		app.sendInput("!echo POC_BASH_VISIBLE\r");
		await app.waitForOutput(/POC_BASH_VISIBLE/, 12_000);
		const output = app.getOutput();
		expect(output).toContain("POC_BASH_VISIBLE");
		expect(output).toContain("echo POC_BASH_VISIBLE");
		expect(output).toContain("BASH");
	}, 20_000);

	it("renders excluded-from-context bash output", async () => {
		app = await startOwnedShell();
		app.sendInput("!!echo HIDDEN_FROM_CONTEXT\r");
		await app.waitForOutput(/HIDDEN_FROM_CONTEXT/, 12_000);
		expect(app.getOutput()).toContain("HIDDEN_FROM_CONTEXT");
	}, 20_000);
});
