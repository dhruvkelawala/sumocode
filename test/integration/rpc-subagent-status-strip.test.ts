import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRpcChildFixture } from "./rpc-child-fixture.js";
import { PI_BOOT_SEQUENCE, spawnSumocodePty, waitForScreen, type SpawnedPiPty } from "./spawn-pi-pty.js";

const COLS = 100;
const ROWS = 30;
const CSI_U_ENTER = "\x1b[13u";
let app: SpawnedPiPty | undefined;
let agentDir: string | undefined;

afterEach(async () => {
	app?.cleanup();
	app = undefined;
	if (agentDir) await rm(agentDir, { recursive: true, force: true });
	agentDir = undefined;
});

describe("RPC subagent status strip", () => {
	it("paints pre-rendered extension widget lines above the editor", async () => {
		agentDir = await mkdtemp(join(tmpdir(), "sumocode-subagent-strip-agent-"));
		const piBin = await createRpcChildFixture("sumocode-subagent-strip-child-", {
			extensionUiRequests: [{
				type: "extension_ui_request",
				id: "subagent-strip-1",
				method: "setWidget",
				widgetKey: "sumocode-subagents",
				widgetLines: ["◈ subagents · 1 running · sa-1 research 3s"],
				widgetPlacement: "aboveEditor",
			}],
		});
		app = spawnSumocodePty({
			env: { PI_BIN: piBin, PI_CODING_AGENT_DIR: agentDir },
			cols: COLS,
			rows: ROWS,
		});

		await app.waitForOutput(PI_BOOT_SEQUENCE, 10_000);
		await app.waitForOutput("DIVINE INVOCATION", 10_000);
		await app.waitForOutput(/CTRL\+\/[\s\S]*COMMANDS/, 10_000);
		app.sendInput("show active shell");
		await app.waitForOutput("show active shell", 5_000);
		app.sendInput(CSI_U_ENTER);
		const screen = await waitForScreen(
			app,
			({ text }) => text.includes("◈ subagents · 1 running · sa-1 research 3s"),
			{ cols: COLS, rows: ROWS, timeoutMs: 10_000 },
		);
		expect(screen.text.indexOf("◈ subagents")).toBeLessThan(screen.text.indexOf("CTRL+/ · COMMANDS"));
	}, 30_000);
});
