import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it } from "vitest";
import { spawnSumocodePty, waitForScreenText } from "../../../../test/integration/spawn-pi-pty.js";

const entries = [
	{ id: "palette-key", input: "\u001f", expected: "host controls" },
	{ id: "palette-slash", input: "/sumo:palette\x1b[13u", expected: "host controls" },
	{ id: "hotkeys-slash", input: "/hotkeys\x1b[13u", expected: "Open the command palette" },
	{ id: "theme-slash", input: "/theme\x1b[13u", expected: "CHOOSE SUMOCODE THEME" },
	{ id: "theme-sumo-slash", input: "/sumo:theme\x1b[13u", expected: "CHOOSE SUMOCODE THEME" },
	{ id: "settings-slash", input: "/settings\x1b[13u", expected: "RPC SETTINGS" },
];

it.each(entries)("drive $id", async ({ id, input, expected }) => {
	await mkdir(resolve(".evidence"), { recursive: true });
	const evidence = await mkdtemp(resolve(".evidence", `verify-sumocode-${id}-`));
	// Supplying our own agent directory keeps harness exit cleanup from deleting it.
	const scratch = await mkdtemp(join(tmpdir(), "verify-sumocode-"));
	const agentDir = join(scratch, "agent");
	await mkdir(agentDir, { mode: 0o700 });
	const revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
	const args = ["--offline", "--no-extensions", "--no-session", "--approve", "--skill", resolve(".agents/skills/verify-sumocode")];
	await writeFile(join(evidence, "action.json"), `${JSON.stringify({
		id, input, expected, revision, scratch, agentDir,
		launcher: resolve("bin/sumocode.sh"), pi: resolve("node_modules/.bin/pi"),
		args,
	}, null, 2)}\n`);
	const app = spawnSumocodePty({
		args,
		cwd: scratch,
		env: { PI_BIN: resolve("node_modules/.bin/pi"), PI_CODING_AGENT_DIR: agentDir, SUMOCODE_HOST_BUNDLE: "0", SUMOCODE_EXTENSION_BUNDLE: "0" },
		cols: 100,
		rows: 30,
	});
	const artifacts = ["action.json", "before.txt", "after.txt", "raw-output.txt", "diagnostics.jsonl", "argv.txt", "cleanup.json"];
	try {
		// Doctor checks this owned instance, not merely the launcher's dependencies.
		await app.waitForReady("app");
		assert.equal(app.getCurrentTerminalState().altscreenActive, true);
		const before = await waitForScreenText(app, "DIVINE INVOCATION", 15_000);
		await writeFile(join(evidence, "before.txt"), before.text);
		app.sendInput(input);
		const after = await waitForScreenText(app, expected, 15_000);
		await writeFile(join(evidence, "after.txt"), after.text);
	} finally {
		// Capture before cleanup: focused harness success normally discards its namespace.
		try {
			const captured = await app.captureEvidence();
			for (const file of ["raw-output.txt", "diagnostics.jsonl", "argv.txt", "final-screen.txt"]) {
				await copyFile(join(captured, file), join(evidence, file));
			}
		} finally {
			await app.cleanupAndWait();
			const terminal = app.getCurrentTerminalState();
			await writeFile(join(evidence, "cleanup.json"), `${JSON.stringify(terminal, null, 2)}\n`);
			assert.equal(terminal.altscreenActive, false);
			assert.equal(terminal.mouseSGRActive, false);
			assert.equal(terminal.cursorVisible, true);
			console.log(`Evidence retained: ${evidence}; scratch retained: ${scratch}`);
		}
	}
	for (const file of artifacts) assert.ok((await stat(join(evidence, file))).size > 0, `proof survived: ${file}`);
	assert.ok((await readFile(join(evidence, "after.txt"), "utf8")).includes(expected));
});
