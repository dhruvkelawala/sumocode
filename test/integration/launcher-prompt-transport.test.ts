import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRpcChildFixture } from "./rpc-child-fixture.js";
import { spawnSumocodePty, type SpawnedPiPty } from "./spawn-pi-pty.js";

const LAUNCHER = resolve(process.env.SUMOCODE_INTEGRATION_PACKAGE_ROOT ?? process.cwd(), "bin/sumocode.sh");
const PROMPT = "SENTINEL-kickoff\n第二行 — ünïcode ✓";

let app: SpawnedPiPty | undefined;
afterEach(async () => {
	await app?.cleanupAndWait();
	app = undefined;
});

interface FixtureLogEntry {
	readonly type: string;
	readonly message?: unknown;
	readonly argvSentinel?: boolean;
	readonly envSentinel?: boolean;
}

function readFixtureLog(path: string): FixtureLogEntry[] {
	return readFileSync(path, "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) =>
			// SAFETY: the fixture writes one JSON object per line with a `type`
			// field (see rpc-child-fixture.ts logCommand/_fixture_process).
			JSON.parse(line) as FixtureLogEntry,
		);
}

describe("launcher prompt transport (issue 391)", () => {
	it("keeps a task kickoff prompt out of the RPC child's argv and environment and delivers it exactly once", async () => {
		const dir = mkdtempSync(join(tmpdir(), "sumocode-kickoff-transport-"));
		const logPath = join(dir, "commands.jsonl");
		try {
			const piBin = await createRpcChildFixture("sumocode-kickoff-transport-child-", {
				sessionName: "Kickoff Transport",
			});
			const agentDir = mkdtempSync(join(tmpdir(), "sumocode-kickoff-transport-agent-"));
			app = spawnSumocodePty({
				args: ["--offline", "--no-extensions", "--no-session", "task", PROMPT],
				env: {
					PI_BIN: piBin,
					PI_CODING_AGENT_DIR: agentDir,
					SUMOCODE_RPC_FIXTURE_LOG: logPath,
				},
				cols: 100,
				rows: 30,
			});

			// The fixture finishes the kickoff prompt on its own (agent_end), and
			// task mode auto-exits after it — wait for the prompt command to have
			// been consumed, then let the process tree wind down.
			for (let attempt = 0; attempt < 200; attempt += 1) {
				if (existsSync(logPath) && readFixtureLog(logPath).some((entry) => entry.type === "prompt")) break;
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
			await app.cleanupAndWait();

			const entries = readFixtureLog(logPath);
			const meta = entries.filter((entry) => entry.type === "_fixture_process");
			expect(meta).toHaveLength(1);
			expect(meta[0]?.argvSentinel).toBe(false);
			expect(meta[0]?.envSentinel).toBe(false);

			const promptCommands = entries.filter((entry) => entry.type === "prompt");
			expect(promptCommands).toHaveLength(1);
			expect(promptCommands[0]?.message).toBe(PROMPT);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}, 60_000);

	it("pipes a headless kickoff prompt to direct-Pi stdin instead of argv", () => {
		const dir = mkdtempSync(join(tmpdir(), "sumocode-headless-stdin-"));
		const stubOut = join(dir, "stub.json");
		const piBin = join(dir, "pi-stub.sh");
		writeFileSync(
			piBin,
			`#!/usr/bin/env bash
node -e '
	const fs = require("node:fs");
	let stdin = "";
	process.stdin.setEncoding("utf8");
	process.stdin.on("data", (chunk) => { stdin += chunk; });
	process.stdin.on("end", () => {
		fs.writeFileSync(process.argv[1], JSON.stringify({ argv: process.argv.slice(2), stdin }));
	});
' "${stubOut}"
`,
		);
		chmodSync(piBin, 0o755);
		try {
			const result = spawnSync("bash", [LAUNCHER, "--no-sumo-tui", "-p", "--no-session", PROMPT], {
				input: "",
				encoding: "utf8",
				env: { ...process.env, PI_BIN: piBin },
				timeout: 30_000,
			});
			expect(result.status).toBe(0);

			// SAFETY: the stub writes exactly one JSON document with argv+stdin
			// keys (see the pi-stub.sh script above).
			const observed = JSON.parse(readFileSync(stubOut, "utf8")) as { argv: string[]; stdin: string };
			for (const arg of observed.argv) expect(arg).not.toContain("SENTINEL");
			expect(observed.stdin).toBe(PROMPT);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
