import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PI_BOOT_SEQUENCE, spawnSumocodePty, waitForScreen, type SpawnedPiPty } from "./spawn-pi-pty.js";
import { createRpcChildFixture } from "./rpc-child-fixture.js";

const CSI_U_ENTER = "\x1b[13u";
const ALT_UP = "\x1b[1;3A";
const COLS = 100;
const ROWS = 30;

let app: SpawnedPiPty | undefined;

afterEach(() => {
	app?.cleanup();
	app = undefined;
});

async function readPromptCommands(path: string): Promise<Array<Record<string, unknown>>> {
	let text = "";
	try {
		text = await readFile(path, "utf8");
	} catch {
		return [];
	}
	return text
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Record<string, unknown>)
		.filter((command) => command.type === "prompt");
}

async function bootRpcHost(prefix: string, piBin: string, logPath: string): Promise<SpawnedPiPty> {
	const agentDir = await mkdtemp(join(tmpdir(), prefix));
	const spawned = spawnSumocodePty({
		env: {
			PI_CODING_AGENT_DIR: agentDir,
			PI_BIN: piBin,
			SUMOCODE_RPC_FIXTURE_LOG: logPath,
		},
		cols: COLS,
		rows: ROWS,
	});
	await spawned.waitForOutput(PI_BOOT_SEQUENCE, 15_000);
	await spawned.waitForOutput("DIVINE INVOCATION", 15_000);
	await spawned.waitForOutput(/CTRL\+\/[\s\S]*COMMANDS/, 15_000);
	return spawned;
}

describe("RPC queued message undo", () => {
	it("queues a busy submit in the host, restores it with Alt+Up, and never sends streamingBehavior", async () => {
		const dir = await mkdtemp(join(tmpdir(), "sumocode-rpc-queue-log-"));
		const logPath = join(dir, "commands.jsonl");
		const piBin = await createRpcChildFixture("sumocode-rpc-queue-child-", {
			promptDelayMs: 2_000,
			settleDelayMs: 100,
		});
		app = await bootRpcHost("sumocode-rpc-queue-agent-", piBin, logPath);

		app.sendInput(`prompt A${CSI_U_ENTER}`);
		await app.waitForOutput("MEDITATING", 5_000);
		app.sendInput(`prompt B${CSI_U_ENTER}`);
		await waitForScreen(
			app,
			(screen) => screen.text.includes("QUEUED (1)") && screen.text.includes("prompt B"),
			{ cols: COLS, rows: ROWS, timeoutMs: 5_000 },
		);

		let prompts = await readPromptCommands(logPath);
		expect(prompts.map((command) => command.message)).toEqual(["prompt A"]);
		expect(prompts.some((command) => "streamingBehavior" in command)).toBe(false);

		app.sendInput(ALT_UP);
		await waitForScreen(
			app,
			(screen) => screen.text.includes("prompt B") && !screen.text.includes("QUEUED (1)"),
			{ cols: COLS, rows: ROWS, timeoutMs: 5_000 },
		);

		app.sendInput(` edited${CSI_U_ENTER}`);
		await waitForScreen(
			app,
			(screen) => screen.text.includes("QUEUED (1)") && screen.text.includes("prompt B edited"),
			{ cols: COLS, rows: ROWS, timeoutMs: 5_000 },
		);
		await new Promise((resolve) => setTimeout(resolve, 300));
		prompts = await readPromptCommands(logPath);
		expect(prompts.map((command) => command.message)).toEqual(["prompt A"]);

		await app.waitForOutput("fixture response complete: prompt A", 5_000);
		await app.waitForOutput("fixture response complete: prompt B edited", 5_000);
		prompts = await readPromptCommands(logPath);
		expect(prompts.map((command) => command.message)).toEqual(["prompt A", "prompt B edited"]);
		expect(prompts.some((command) => "streamingBehavior" in command)).toBe(false);
	}, 30_000);

	it("drains one queued prompt per agent_settled and ignores agent_end alone", async () => {
		const dir = await mkdtemp(join(tmpdir(), "sumocode-rpc-drain-log-"));
		const logPath = join(dir, "commands.jsonl");
		const piBin = await createRpcChildFixture("sumocode-rpc-drain-child-", {
			promptDelayMs: 300,
			settleDelayMs: 700,
		});
		app = await bootRpcHost("sumocode-rpc-drain-agent-", piBin, logPath);

		app.sendInput(`prompt A${CSI_U_ENTER}`);
		await app.waitForOutput("MEDITATING", 5_000);
		app.sendInput(`prompt B${CSI_U_ENTER}`);
		app.sendInput(`prompt C${CSI_U_ENTER}`);
		await waitForScreen(
			app,
			(screen) => screen.text.includes("QUEUED (2)") && screen.text.includes("prompt B") && screen.text.includes("prompt C"),
			{ cols: COLS, rows: ROWS, timeoutMs: 5_000 },
		);

		await app.waitForOutput("fixture response complete: prompt A", 5_000);
		await new Promise((resolve) => setTimeout(resolve, 250));
		let prompts = await readPromptCommands(logPath);
		expect(prompts.map((command) => command.message)).toEqual(["prompt A"]);

		await app.waitForOutput("fixture response complete: prompt B", 5_000);
		prompts = await readPromptCommands(logPath);
		expect(prompts.map((command) => command.message)).toEqual(["prompt A", "prompt B"]);

		await app.waitForOutput("fixture response complete: prompt C", 5_000);
		prompts = await readPromptCommands(logPath);
		expect(prompts.map((command) => command.message)).toEqual(["prompt A", "prompt B", "prompt C"]);
		expect(prompts.some((command) => "streamingBehavior" in command)).toBe(false);
	}, 30_000);
});
