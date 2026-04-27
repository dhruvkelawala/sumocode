#!/usr/bin/env node
/**
 * Mouse-leak smoke test.
 *
 * Boots the real `bin/sumocode.sh` flow via node-pty, blasts a stream of
 * complete and intentionally-malformed SGR mouse sequences (including the
 * stale-prefix + complete-sequence chain pattern that triggered the issue
 * reported by the user with long chats), and verifies that:
 *
 *   1. None of the printable mouse bytes (`[<64;`, `[<65;`, etc.) appear in
 *      the rendered terminal output as visible characters.
 *   2. The sumo-tui bridge wrote diagnostic entries for the input.
 *
 * Usage:
 *   node scripts/smoke-mouse-leak.mjs
 */
import { spawn } from "node-pty";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = resolve(fileURLToPath(import.meta.url), "..", "..");
const SCRIPT = join(HERE, "bin", "sumocode.sh");
const SUMO_MODULE = pathToFileURL(join(HERE, "sumo-interactive-mode.js")).href;

// node-pty ships prebuilt binaries that lose their +x bit when extracted by
// pnpm. Mirror test/integration/spawn-pi-pty.ts's prep step.
function ensureNodePtySpawnHelperExecutable() {
	const require = createRequire(import.meta.url);
	const nodePtyMain = require.resolve("node-pty");
	const spawnHelper = join(dirname(nodePtyMain), "..", "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper");
	if (!existsSync(spawnHelper)) return;
	chmodSync(spawnHelper, 0o755);
}
ensureNodePtySpawnHelperExecutable();

if (!existsSync(SCRIPT)) {
	console.error(`smoke: missing ${SCRIPT}`);
	process.exit(1);
}

const agentDir = mkdtempSync(join(tmpdir(), "sumocode-smoke-mouse-"));
const diagFile = join(agentDir, "sumo-tui-diag.jsonl");
mkdirSync(agentDir, { recursive: true });

const longChat = process.argv.includes("--long-chat");
let sessionFile;
if (longChat) {
	sessionFile = synthesizeLongSession(agentDir, 60);
}

console.log(`smoke: agent dir   = ${agentDir}`);
console.log(`smoke: diag file   = ${diagFile}`);
if (sessionFile) console.log(`smoke: session     = ${sessionFile} (long-chat mode)`);

function synthesizeLongSession(baseDir, messagePairs) {
	const sessionsDir = join(baseDir, "sessions", "synthesized");
	mkdirSync(sessionsDir, { recursive: true });
	const sessionId = "019dd000-0000-7000-8000-000000000001";
	const filePath = join(sessionsDir, `synthesized_${sessionId}.jsonl`);
	const ts = "2026-04-27T15:00:00.000Z";
	const records = [];
	let parent = null;
	let counter = 0;
	const nextId = () => `e${(++counter).toString(16).padStart(7, "0")}`;
	records.push(JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: ts, cwd: baseDir }));
	const modelId = nextId();
	records.push(JSON.stringify({ type: "model_change", id: modelId, parentId: parent, timestamp: ts, provider: "faux", modelId: "faux-1" }));
	parent = modelId;
	const thinkingId = nextId();
	records.push(JSON.stringify({ type: "thinking_level_change", id: thinkingId, parentId: parent, timestamp: ts, thinkingLevel: "off" }));
	parent = thinkingId;
	for (let i = 0; i < messagePairs; i++) {
		const userId = nextId();
		records.push(
			JSON.stringify({
				type: "message",
				id: userId,
				parentId: parent,
				timestamp: ts,
				message: { role: "user", content: [{ type: "text", text: `user line ${i + 1}` }], timestamp: 0 },
			}),
		);
		parent = userId;
		const asstId = nextId();
		records.push(
			JSON.stringify({
				type: "message",
				id: asstId,
				parentId: parent,
				timestamp: ts,
				message: {
					role: "assistant",
					content: [{ type: "text", text: `assistant reply line ${i + 1} with enough text to take more than one row when wrapped at 100 columns of terminal width.` }],
					api: "faux:0:0",
					provider: "faux",
					model: "faux-1",
					usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
					stopReason: "stop",
					timestamp: 0,
				},
			}),
		);
		parent = asstId;
	}
	writeFileSync(filePath, `${records.join("\n")}\n`, "utf8");
	return filePath;
}

const localPi = join(HERE, "node_modules", ".bin", "pi");
const childArgs = [];
let childCommand = SCRIPT;
if (sessionFile) {
	if (!existsSync(localPi)) {
		console.error(`smoke: missing patched pi binary at ${localPi}`);
		process.exit(1);
	}
	childCommand = localPi;
	childArgs.push("--session", sessionFile, "--no-extensions", "-e", join(HERE, "src", "extension.ts"));
}

const child = spawn(childCommand, childArgs, {
	name: "xterm-256color",
	cols: 100,
	rows: 30,
	cwd: HERE,
	env: {
		...process.env,
		PI_CODING_AGENT_DIR: agentDir,
		SUMO_TUI: "1",
		SUMO_TUI_HIDE_PI_NOISE: "1",
		SUMO_TUI_MODULE: SUMO_MODULE,
		SUMO_TUI_DIAG_FILE: diagFile,
		PI_OFFLINE: "1",
		TERM: "xterm-256color",
	},
});

let output = "";
child.onData((chunk) => {
	output += chunk;
	if (output.length > 400_000) output = output.slice(-200_000);
});

const exitPromise = new Promise((resolveExit) => {
	child.onExit((code) => resolveExit(code));
});

function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

async function waitForBoot() {
	const deadline = Date.now() + 15_000;
	const expectedAfterAlt = sessionFile ? "INPUT" : "SCRIPTOR INPUT";
	while (Date.now() < deadline) {
		if (output.includes("\x1b[?1049h") && output.includes(expectedAfterAlt)) return;
		await sleep(50);
	}
	throw new Error(`smoke: timed out waiting for boot. Last output: ${JSON.stringify(output.slice(-2000))}`);
}

const WHEEL_UP = "\x1b[<64;33;19M";
const WHEEL_DOWN = "\x1b[<65;33;19M";
const STALE_PREFIX = "\x1b[<64;33;19";
const ORPHAN_FRAGMENT = "\x1b[<64";

async function blastMouseBytes() {
	for (let i = 0; i < 5; i++) {
		child.write(WHEEL_UP.repeat(8));
		await sleep(40);
		child.write(WHEEL_DOWN.repeat(8));
		await sleep(40);
	}
	// The reported pathological pattern: stale partial + complete sequences chained.
	child.write(STALE_PREFIX + WHEEL_UP + WHEEL_UP + WHEEL_UP);
	await sleep(60);
	// Orphan/garbage fragments that are clearly mouse-shaped but truncated.
	child.write(ORPHAN_FRAGMENT);
	await sleep(80);
	child.write(WHEEL_UP.repeat(20));
	await sleep(120);
}

function leakReport(buffer) {
	// Scan for visible mouse bytes that show up as printable characters.
	// We only flag occurrences that are NOT part of an actual escape sequence
	// (i.e. preceded by literal `[` instead of `\x1b[`).
	const matches = [];
	const visiblePattern = /(?<!\x1b)\[<\d+;\d+;\d+[Mm]/g;
	for (const m of buffer.matchAll(visiblePattern)) {
		matches.push({ index: m.index, text: m[0] });
		if (matches.length >= 20) break;
	}
	return matches;
}

(async () => {
	let exitCode = 0;
	try {
		await waitForBoot();
		console.log("smoke: boot ok");
		await blastMouseBytes();
		console.log("smoke: mouse bytes sent");

		// Type something so we'd visually see corruption if any leaked.
		child.write("hello-from-smoke");
		await sleep(250);

		const leaks = leakReport(output);
		const stripAnsi = (s) => s.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
		const visibleTail = stripAnsi(output.slice(-1500));

		if (leaks.length > 0) {
			console.error(`smoke: FAIL — found ${leaks.length} leaked mouse byte fragments:`);
			for (const leak of leaks) console.error(`  @${leak.index}: ${JSON.stringify(leak.text)}`);
			console.error(`smoke: visible tail = ${JSON.stringify(visibleTail)}`);
			exitCode = 2;
		} else {
			console.log("smoke: no leaked mouse bytes in output");
		}

		const diagText = existsSync(diagFile) ? readFileSync(diagFile, "utf8") : "";
		const diagEvents = diagText.split("\n").filter(Boolean).map((line) => {
			try {
				return JSON.parse(line);
			} catch {
				return undefined;
			}
		}).filter((entry) => entry?.event === "sumo_mouse_input");
		if (diagEvents.length === 0) {
			console.error("smoke: WARNING — bridge wrote no sumo_mouse_input diagnostics; was bridge wired up?");
			exitCode = exitCode || 3;
		} else {
			const totalEvents = diagEvents.reduce((sum, entry) => sum + (entry.events ?? 0), 0);
			const consumedCount = diagEvents.filter((entry) => entry.consumed).length;
			console.log(`smoke: diag entries = ${diagEvents.length}, parsed events = ${totalEvents}, consumed-true = ${consumedCount}`);
		}
	} catch (error) {
		console.error(`smoke: error — ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
		exitCode = 1;
	} finally {
		try {
			child.write("\x04");
			await Promise.race([exitPromise, sleep(1_000)]);
		} finally {
			try {
				child.kill("SIGTERM");
			} catch {
				/* ignore */
			}
		}
	}
	process.exit(exitCode);
})();
