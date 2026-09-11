import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PI_BOOT_SEQUENCE, spawnSumocodePty, waitForScreen, waitForScreenText, type SpawnedPiPty } from "./spawn-pi-pty.js";
import { createRpcChildFixture, transcriptMessages } from "./rpc-child-fixture.js";

const CSI_U_ENTER = "\x1b[13u";

let app: SpawnedPiPty | undefined;

afterEach(async () => {
	await app?.cleanupAndWait();
	app = undefined;
});

async function waitForChromeCacheWrite(path: string, after = -1): Promise<number> {
	for (let attempt = 0; attempt < 200; attempt += 1) {
		try {
			// SAFETY: the cache file is written by this extension's chrome-cache
			// JSON writer; a malformed file is caught below and retried.
			const cache = JSON.parse(await readFile(path, "utf8")) as { byCwd?: Record<string, { savedAt?: number }> };
			const savedAt = Object.values(cache.byCwd ?? {})[0]?.savedAt;
			if (isSavedAtNumber(savedAt) && savedAt > after) return savedAt;
		} catch {}
		// WAIT-CLASS: poll-interval — gap between bounded re-reads of the chrome
		// cache file; the loop exits on the observed savedAt, not on elapsed time.
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error(`timed out waiting for chrome cache write after ${after}`);
}

function isSavedAtNumber(savedAt: number | undefined): savedAt is number {
	return typeof savedAt === "number";
}

describe("sumocode RPC session switching", () => {
	it("drains the latest destination chrome when shutdown follows replacement", async () => {
		const piBin = await createRpcChildFixture("sumocode-rpc-cache-drain-child-", {
			sessionName: "Original Session",
			messages: transcriptMessages(2, "old session"),
		});
		const agentDir = await mkdtemp(join(tmpdir(), "sumocode-rpc-cache-drain-agent-"));
		app = spawnSumocodePty({
			env: {
				PI_CODING_AGENT_DIR: agentDir,
				PI_BIN: piBin,
				NODE_ENV: "test",
				SUMOCODE_TEST_CHROME_CACHE_DELAY_MS: "1000",
			},
			cols: 100,
			rows: 30,
		});

		await app.waitForOutput(PI_BOOT_SEQUENCE, 15_000);
		await waitForScreenText(app, "Original Session", 15_000);
		const cachePath = join(agentDir, "state", "sumocode", "chrome", "v1", "chrome-cache.json");
		const initialCacheWrite = await waitForChromeCacheWrite(cachePath);

		app.sendInput(`/new${CSI_U_ENTER}`);
		await waitForScreenText(app, "new session", 5_000);
		app.sendSignal("SIGTERM");
		await waitForChromeCacheWrite(cachePath, initialCacheWrite);
	}, 30_000);

	it("/new stays in altscreen and updates chrome to the new session", async () => {
		const cols = 100;
		const rows = 30;
		const piBin = await createRpcChildFixture("sumocode-rpc-new-session-child-", {
			sessionName: "Original Session",
			messages: transcriptMessages(2, "old session"),
		});
		const agentDir = await mkdtemp(join(tmpdir(), "sumocode-rpc-new-session-agent-"));
		app = spawnSumocodePty({
			env: {
				PI_CODING_AGENT_DIR: agentDir,
				PI_BIN: piBin,
			},
			cols,
			rows,
		});

		await app.waitForOutput(PI_BOOT_SEQUENCE, 15_000);
		await waitForScreenText(app, "Original Session", 15_000);
		const cachePath = join(agentDir, "state", "sumocode", "chrome", "v1", "chrome-cache.json");
		const initialCacheWrite = await waitForChromeCacheWrite(cachePath);

		app.sendInput(`/new${CSI_U_ENTER}`);
		await waitForChromeCacheWrite(cachePath, initialCacheWrite);

		// The chrome flip alone does not prove the old session is gone: wait for a
		// frame where the new name is present and the old transcript is not, so the
		// negatives below cannot read a mid-transition repaint.
		const finalScreen = await waitForScreen(
			app,
			({ text }) => text.includes("new session") && !text.includes("Original Session") && !text.includes("old session anchor"),
			{ cols, rows, timeoutMs: 5_000 },
		);

		const state = app.getCurrentTerminalState();
		expect(state.altscreenActive).toBe(true);
		expect(state.mouseSGRActive).toBe(true);
		expect(state.cleanupSequenceSeen).toBe(false);
		expect(finalScreen.text).toContain("new session");
		expect(finalScreen.text).not.toContain("Original Session");
		expect(finalScreen.text).not.toContain("old session anchor");
	}, 30_000);
});
