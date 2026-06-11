import { readFileSync, unlinkSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnPiPty, type SpawnedPiPty } from "./spawn-pi-pty.js";

function countOccurrences(text: string, needle: string): number {
	return text.split(needle).length - 1;
}

/**
 * Match `bin/sumocode.sh`: when SUMO_TUI is truthy, the launcher resolves
 * SUMO_TUI_MODULE to a file URL pointing at the local retained mode module.
 * Without both env vars, the patched Pi binary falls back to classic
 * `InteractiveMode` and this test would silently exercise the wrong path.
 */
function retainedModeEnv(): Record<string, string> {
	return {
		SUMO_TUI: "1",
		SUMO_TUI_MODULE: pathToFileURL(resolve(process.cwd(), "sumo-interactive-mode.js")).href,
		SUMO_TUI_DIAG_FILE: "/tmp/sumocode-session-switch-test.jsonl",
	};
}

describe("retained lifecycle across session switches", () => {
	let app: SpawnedPiPty | undefined;
	beforeEach(() => {
		try { unlinkSync(retainedModeEnv().SUMO_TUI_DIAG_FILE); } catch {}
	});
	afterEach(() => {
		app?.cleanup();
		app = undefined;
	});

	it("emits boot and app-ready diagnostics in order on startup", async () => {
		app = spawnPiPty({
			args: ["--offline", "--no-extensions", "-e", "./src/extension.ts", "--no-session"],
			env: retainedModeEnv(),
		});
		await app.waitForOutput(/DIVINE INVOCATION/, 12_000);
		await new Promise((resolve) => setTimeout(resolve, 300));

		const events = readFileSync(retainedModeEnv().SUMO_TUI_DIAG_FILE, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as { event?: string });
		const names = events.map((event) => event.event).filter((event): event is string => typeof event === "string");
		const bootIndex = names.indexOf("boot_screen_frame");
		const appReadyIndex = names.indexOf("app_ready");
		const stableChromeIndex = names.indexOf("stable_chrome_ready");
		const inputReadyIndex = names.indexOf("input_ready");

		expect(bootIndex).toBeGreaterThanOrEqual(0);
		expect(stableChromeIndex).toBeGreaterThan(bootIndex);
		expect(appReadyIndex).toBeGreaterThanOrEqual(stableChromeIndex);
		expect(inputReadyIndex).toBeGreaterThanOrEqual(appReadyIndex);
	});

	it("does not leave altscreen during /new", async () => {
		app = spawnPiPty({
			args: ["--offline", "--no-extensions", "-e", "./src/extension.ts", "--no-session"],
			env: retainedModeEnv(),
		});
		await app.waitForOutput(/DIVINE INVOCATION/, 12_000);

		// Confirm retained mode actually started — if Pi fell back to classic
		// InteractiveMode, the diagnostics file would not contain owned_shell
		// events. Read SUMO_TUI_DIAG_FILE to verify the retained runtime ran.
		await new Promise((resolve) => setTimeout(resolve, 200));
		const diagFile = retainedModeEnv().SUMO_TUI_DIAG_FILE;
		const diagContents = readFileSync(diagFile, "utf8");
		expect(diagContents, "retained SumoTUI runtime did not start").toMatch(/owned_shell_installed|sumo_runtime_top_chrome_publication|retainedTui/);

		app.sendInput("/new");
		app.sendInput("\x1b[13u");
		await app.waitForOutput(/Ask anything/, 12_000);
		await new Promise((resolve) => setTimeout(resolve, 300));

		const output = app.getOutput();
		expect(countOccurrences(output, "\x1b[?1049h")).toBe(1);
		expect(countOccurrences(output, "\x1b[?1049l")).toBe(0);
	});
});
