import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRpcChildFixture } from "./rpc-child-fixture.js";
import { spawnSumocodePty, type SpawnedPiPty } from "./spawn-pi-pty.js";

const LAUNCHER = resolve(process.env.SUMOCODE_INTEGRATION_PACKAGE_ROOT ?? process.cwd(), "bin/sumocode.sh");
// The launcher resolves ROOT_DIR from its own location, so under the
// integration harness (which may point SUMOCODE_INTEGRATION_PACKAGE_ROOT at
// a staged package) the extension entry path must be derived from LAUNCHER.
const EXTENSION_ENTRY = resolve(dirname(LAUNCHER), "..", "src/extension-entry.ts");
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

interface PiStub {
	readonly piBin: string;
	readonly stubOut: string;
}

function makePiStub(dir: string): PiStub {
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
' "${stubOut}" "$@"
`,
	);
	chmodSync(piBin, 0o755);
	return { piBin, stubOut };
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
		const { piBin, stubOut } = makePiStub(dir);
		try {
			const result = spawnSync("bash", [LAUNCHER, "--no-sumo-tui", "--no-session", PROMPT], {
				input: "",
				encoding: "utf8",
				env: { ...process.env, PI_BIN: piBin },
				timeout: 30_000,
			});
			expect(result.status).toBe(0);

			// SAFETY: the stub writes exactly one JSON document with argv+stdin
			// keys (see makePiStub above).
			const observed = JSON.parse(readFileSync(stubOut, "utf8")) as { argv: string[]; stdin: string };
			for (const arg of observed.argv) expect(arg).not.toContain("SENTINEL");
			expect(observed.stdin).toBe(PROMPT);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("preserves caller-piped stdin ahead of the headless kickoff prompt", () => {
		const dir = mkdtempSync(join(tmpdir(), "sumocode-headless-piped-"));
		const { piBin, stubOut } = makePiStub(dir);
		try {
			// Pi composes the initial message as stdinContent + messages[0] with
			// no separator, so the launcher must stream the caller's pipe BEFORE
			// the prompt bytes — pre-stdin behavior, byte for byte.
			const result = spawnSync("bash", [LAUNCHER, "--no-sumo-tui", "--no-session", "review this"], {
				input: "DIFF BYTES\n",
				encoding: "utf8",
				env: { ...process.env, PI_BIN: piBin },
				timeout: 30_000,
			});
			expect(result.status).toBe(0);

			// SAFETY: the stub writes exactly one JSON document with argv+stdin
			// keys (see makePiStub above).
			const observed = JSON.parse(readFileSync(stubOut, "utf8")) as { argv: string[]; stdin: string };
			expect(observed.stdin).toBe("DIFF BYTES\nreview this");
			for (const arg of observed.argv) expect(arg).not.toContain("review this");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("keeps sole-positional headless kickoffs on stdin even with no other flags", () => {
		const dir = mkdtempSync(join(tmpdir(), "sumocode-headless-sole-"));
		const { piBin, stubOut } = makePiStub(dir);
		try {
			// Extraction empties SUMOCODE_ARGS here; the stdin branch must still
			// win over the bare no-args launch branch or the prompt vanishes.
			const result = spawnSync("bash", [LAUNCHER, "--no-sumo-tui", "solo prompt"], {
				input: "",
				encoding: "utf8",
				env: { ...process.env, PI_BIN: piBin },
				timeout: 30_000,
			});
			expect(result.status).toBe(0);

			// SAFETY: the stub writes exactly one JSON document with argv+stdin
			// keys (see makePiStub above).
			const observed = JSON.parse(readFileSync(stubOut, "utf8")) as { argv: string[]; stdin: string };
			expect(observed.argv).toEqual(["-e", EXTENSION_ENTRY]);
			expect(observed.stdin).toBe("solo prompt");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("keeps argv and stdin untouched for explicit --mode headless launches", () => {
		const dir = mkdtempSync(join(tmpdir(), "sumocode-headless-mode-"));
		const { piBin, stubOut } = makePiStub(dir);
		try {
			// rpc/json mode reads stdin as a protocol channel; piping prompt text
			// there would corrupt it. Argv transport, exactly as typed.
			const result = spawnSync("bash", [LAUNCHER, "--no-sumo-tui", "--mode", "rpc", "--offline", "mode prompt"], {
				input: "",
				encoding: "utf8",
				env: { ...process.env, PI_BIN: piBin },
				timeout: 30_000,
			});
			expect(result.status).toBe(0);

			// SAFETY: the stub writes exactly one JSON document with argv+stdin
			// keys (see makePiStub above).
			const observed = JSON.parse(readFileSync(stubOut, "utf8")) as { argv: string[]; stdin: string };
			expect(observed.argv).toEqual(["-e", EXTENSION_ENTRY, "--mode", "rpc", "--offline", "mode prompt"]);
			expect(observed.stdin).toBe("");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("keeps argv transport for multi-positional headless launches so Pi's multi-message semantics survive", () => {
		const dir = mkdtempSync(join(tmpdir(), "sumocode-headless-multipos-"));
		const { piBin, stubOut } = makePiStub(dir);
		try {
			// Pi print mode prompts the -p value first, then every positional.
			// The -p value (the sole print message) moves to stdin; the
			// positional stays in argv — sequence preserved, one message fewer
			// in argv.
			const result = spawnSync("bash", [LAUNCHER, "--no-sumo-tui", "-p", "first message", "second message"], {
				input: "",
				encoding: "utf8",
				env: { ...process.env, PI_BIN: piBin },
				timeout: 30_000,
			});
			expect(result.status).toBe(0);

			// SAFETY: the stub writes exactly one JSON document with argv+stdin
			// keys (see makePiStub above).
			const observed = JSON.parse(readFileSync(stubOut, "utf8")) as { argv: string[]; stdin: string };
			expect(observed.argv).toEqual([
				"-e",
				EXTENSION_ENTRY,
				"-p",
				"second message",
			]);
			expect(observed.stdin).toBe("first message");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
