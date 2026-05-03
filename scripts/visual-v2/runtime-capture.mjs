import { chmodSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { spawn } from "node-pty";
import { repoRoot } from "./paths.mjs";

export async function captureRuntimeScenario(scenario) {
	const runtime = scenario.runtime ?? {};
	const command = runtime.command ?? "./bin/sumocode.sh";
	const args = runtime.args ?? ["--offline", "--no-session"];
	const dimensions = scenario.dimensions;
	ensureNodePtySpawnHelperExecutable();

	const child = spawn(command, args, {
		name: "xterm-256color",
		cols: dimensions.cols,
		rows: dimensions.rows,
		cwd: repoRoot,
		env: deterministicEnv(runtime.env),
	});

	let output = "";
	let exited = false;
	let exitInfo = null;
	child.onData((data) => {
		output += data;
	});
	child.onExit((event) => {
		exited = true;
		exitInfo = event;
	});

	const inputs = runtime.inputs ?? [];
	let elapsed = 0;
	for (const input of inputs) {
		const wait = Math.max(0, Number(input.afterMs ?? 0));
		await sleep(wait);
		elapsed += wait;
		if (exited) break;
		if (input.type === "text") child.write(input.value ?? "");
		else if (input.type === "key") child.write(input.value ?? "");
		else throw new Error(`Unsupported runtime input type in ${scenario.id}: ${input.type}`);
	}

	const settleMs = Math.max(0, Number(runtime.settleMs ?? 500));
	await sleep(settleMs);
	const emptyOutputGraceMs = Math.max(0, Number(runtime.emptyOutputGraceMs ?? 5000));
	if (!exited && output.trim().length === 0 && emptyOutputGraceMs > 0) {
		// CI runners can be slow to reach the first retained-frame write, especially
		// for no-input splash captures. Do not fail immediately at settleMs just
		// because startup has not emitted bytes yet; wait a short grace window for
		// first output while keeping genuinely silent captures diagnosable.
		await sleep(emptyOutputGraceMs);
	}
	const captured = output;
	const plain = stripAnsi(captured);
	const rejection = findRejection(plain, scenario.rejectIfOutputMatches ?? []);

	try {
		child.kill("SIGTERM");
	} catch {
		// process may already be gone
	}

	if (rejection) {
		throw new Error(`Runtime capture ${scenario.id} matched rejection pattern ${JSON.stringify(rejection.pattern)}. Snippet: ${JSON.stringify(rejection.snippet)}`);
	}
	if (captured.trim().length === 0) {
		throw new Error(`Runtime capture ${scenario.id} produced no terminal output after settleMs=${settleMs} and emptyOutputGraceMs=${emptyOutputGraceMs}`);
	}
	if (exited && exitInfo?.exitCode && exitInfo.exitCode !== 0) {
		throw new Error(`Runtime capture ${scenario.id} exited early with code ${exitInfo.exitCode}`);
	}

	return {
		kind: "runtime",
		bytes: captured,
		plainText: plain,
		metadata: {
			command,
			args,
			cols: dimensions.cols,
			rows: dimensions.rows,
			settleMs,
			emptyOutputGraceMs,
			inputCount: inputs.length,
			exited,
			exitInfo,
		},
	};
}

function deterministicEnv(extra = {}) {
	const env = {
		...process.env,
		TERM: "xterm-256color",
		COLORTERM: "truecolor",
		FORCE_COLOR: "3",
		PI_OFFLINE: "1",
		SUMO_TUI: "1",
		SUMOCODE_HARNESS: "1",
		...extra,
	};
	delete env.NO_COLOR;
	return env;
}

function findRejection(text, patterns) {
	for (const pattern of patterns) {
		const regex = new RegExp(pattern, "m");
		const match = text.match(regex);
		if (match) {
			const index = match.index ?? 0;
			return { pattern, snippet: text.slice(Math.max(0, index - 160), index + 240) };
		}
	}
	return null;
}

function stripAnsi(value) {
	return String(value)
		.replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
		.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/\u001b[()][A-Za-z0-9]/g, "")
		.replace(/\r/g, "");
}

function sleep(ms) {
	return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function ensureNodePtySpawnHelperExecutable() {
	try {
		const require = createRequire(import.meta.url);
		const nodePtyMain = require.resolve("node-pty");
		const spawnHelper = resolve(dirname(nodePtyMain), "..", "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper");
		if (!existsSync(spawnHelper)) return;
		chmodSync(spawnHelper, 0o755);
	} catch {
		// node-pty can still work when the helper path is absent or already executable.
	}
}
