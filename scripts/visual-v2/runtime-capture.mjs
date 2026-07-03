import { chmodSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { spawn } from "node-pty";
import { replayAnsi } from "./ansi-replay.mjs";
import { repoRoot } from "./paths.mjs";

const DEFAULT_MAX_ATTEMPTS = 2;

function clampPositiveInt(value, fallback) {
	const parsed = Math.floor(Number(value));
	if (!Number.isFinite(parsed) || parsed < 1) return fallback;
	return parsed;
}

export async function captureRuntimeScenario(scenario) {
	const runtime = scenario.runtime ?? {};
	const maxAttempts = clampPositiveInt(runtime.maxAttempts ?? DEFAULT_MAX_ATTEMPTS, DEFAULT_MAX_ATTEMPTS);
	let lastError;
	const attemptDiagnostics = [];
	for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
		try {
			const result = await runOneAttempt(scenario, runtime, attempt);
			if (attemptDiagnostics.length > 0) {
				result.metadata = {
					...result.metadata,
					earlierAttempts: attemptDiagnostics,
				};
			}
			return result;
		} catch (error) {
			attemptDiagnostics.push({ attempt, message: error.message, ...(error.diagnostics ?? {}) });
			lastError = error;
			if (!error.retryable || attempt === maxAttempts) break;
		}
	}
	if (lastError && attemptDiagnostics.length > 0) {
		lastError.message = `${lastError.message} | attempts: ${JSON.stringify(attemptDiagnostics)}`;
	}
	throw lastError ?? new Error(`Runtime capture ${scenario.id} failed without a recorded error`);
}

async function runOneAttempt(scenario, runtime, attempt) {
	const command = runtime.command ?? "./bin/sumocode.sh";
	const args = runtime.args ?? ["--offline", "--no-session"];
	const dimensions = scenario.dimensions;
	ensureNodePtySpawnHelperExecutable();
	const runtimeEnv = isolatedRuntimeEnv(runtime.env);
	let child = null;
	let output = "";
	let exited = false;
	let exitInfo = null;
	let firstByteAt = null;

	try {
		child = spawn(command, args, {
			name: "xterm-256color",
			cols: dimensions.cols,
			rows: dimensions.rows,
			cwd: repoRoot,
			env: runtimeEnv.env,
		});

		const startedAt = Date.now();
		child.onData((data) => {
			if (firstByteAt === null) firstByteAt = Date.now();
			output += data;
		});
		child.onExit((event) => {
			exited = true;
			exitInfo = event;
		});

		const inputs = runtime.inputs ?? [];
		for (const input of inputs) {
			const wait = Math.max(0, Number(input.afterMs ?? 0));
			await sleep(wait);
			if (exited) break;
			await applyRuntimeInput({
				scenario,
				input,
				child,
				dimensions,
				getOutput: () => output,
				hasExited: () => exited,
			});
		}

		const settleMs = Math.max(0, Number(runtime.settleMs ?? 500));
		await sleep(settleMs);

		const emptyOutputGraceMs = Math.max(0, Number(runtime.emptyOutputGraceMs ?? 5000));
		const stabilizeMs = Math.max(0, Number(runtime.outputStabilizeMs ?? 200));
		if (!exited && emptyOutputGraceMs > 0) {
			// CI runners can be slow to reach the first retained-frame write and
			// the frame itself can stream across multiple PTY chunks. Poll within
			// the grace window until the output buffer has been stable for
			// `stabilizeMs` (or until the child exits / the grace expires) so we
			// neither short-circuit on whitespace-only chunks nor capture a
			// half-streamed frame.
			await waitForStableOutput(
				() => output.length,
				() => output.trim().length > 0,
				() => exited,
				emptyOutputGraceMs,
				stabilizeMs,
			);
		}

		const captured = output;
		const plain = stripAnsi(captured);
		const rejection = findRejection(plain, scenario.rejectIfOutputMatches ?? []);

		await terminateChild(child, () => exited);

		const durationMs = Date.now() - startedAt;
		const diagnostics = {
			attempt,
			durationMs,
			outputBytes: captured.length,
			outputTrimmedLength: captured.trim().length,
			firstByteMs: firstByteAt === null ? null : firstByteAt - startedAt,
			exited,
			exitCode: exitInfo?.exitCode ?? null,
			exitSignal: exitInfo?.signal ?? null,
			outputTail: captured.length > 0 ? captured.slice(-512) : null,
		};

		if (rejection) {
			const error = new Error(`Runtime capture ${scenario.id} matched rejection pattern ${JSON.stringify(rejection.pattern)}. Snippet: ${JSON.stringify(rejection.snippet)}`);
			error.retryable = false;
			error.diagnostics = diagnostics;
			throw error;
		}
		if (captured.trim().length === 0) {
			const error = new Error(`Runtime capture ${scenario.id} produced no terminal output after settleMs=${settleMs} and emptyOutputGraceMs=${emptyOutputGraceMs} (exited=${exited}, exitCode=${exitInfo?.exitCode ?? "none"}, exitSignal=${exitInfo?.signal ?? "none"})`);
			error.retryable = true;
			error.diagnostics = diagnostics;
			throw error;
		}
		if (exited && exitInfo?.exitCode && exitInfo.exitCode !== 0) {
			const error = new Error(`Runtime capture ${scenario.id} exited early with code ${exitInfo.exitCode} (signal=${exitInfo.signal ?? "none"}, outputBytes=${captured.length})`);
			error.retryable = true;
			error.diagnostics = diagnostics;
			throw error;
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
				attempt,
				firstByteMs: diagnostics.firstByteMs,
				durationMs,
				piCodingAgentDir: runtimeEnv.piCodingAgentDir,
				piCodingAgentDirSource: runtimeEnv.piCodingAgentDirSource,
			},
		};
	} finally {
		if (child !== null && !exited) {
			await terminateChild(child, () => exited);
		}
		runtimeEnv.cleanup();
	}
}

async function applyRuntimeInput({ scenario, input, child, dimensions, getOutput, hasExited }) {
	if (input.type === "text") {
		child.write(input.value ?? "");
		return;
	}
	if (input.type === "key") {
		child.write(runtimeKeyBytes(input.value ?? ""));
		return;
	}
	if (input.type === "waitForOutput") {
		await waitForOutputMatch(scenario, input, getOutput, hasExited);
		return;
	}
	if (input.type === "waitForFinalScreenMatches") {
		await waitForFinalScreenMatches(scenario, input, dimensions, getOutput, hasExited);
		return;
	}
	throw new Error(`Unsupported runtime input type in ${scenario.id}: ${input.type}`);
}

function runtimeKeyBytes(value) {
	if (value === "Enter") return "\r";
	return value;
}

async function waitForOutputMatch(scenario, input, getOutput, hasExited) {
	const timeoutMs = Math.max(1, Number(input.timeoutMs ?? 5000));
	const pattern = input.pattern ?? input.value;
	if (typeof pattern !== "string" || pattern.length === 0) {
		throw new Error(`Runtime waitForOutput input in ${scenario.id} needs a non-empty pattern`);
	}
	const regex = new RegExp(pattern, "m");
	const started = Date.now();
	let lastPlain = "";
	while (Date.now() - started < timeoutMs) {
		if (hasExited()) break;
		lastPlain = stripAnsi(getOutput());
		if (regex.test(lastPlain)) return;
		await sleep(50);
	}
	const error = new Error(`Runtime capture ${scenario.id} timed out waiting for output pattern ${JSON.stringify(pattern)}`);
	error.retryable = true;
	error.diagnostics = { pattern, outputTail: lastPlain.slice(-512) };
	throw error;
}

async function waitForFinalScreenMatches(scenario, input, dimensions, getOutput, hasExited) {
	const timeoutMs = Math.max(1, Number(input.timeoutMs ?? 5000));
	const include = compilePatternList(scenario, input.include ?? input.patterns ?? [], "include");
	const exclude = compilePatternList(scenario, input.exclude ?? [], "exclude");
	if (include.length === 0) {
		throw new Error(`Runtime waitForFinalScreenMatches input in ${scenario.id} needs at least one include pattern`);
	}
	const started = Date.now();
	let lastText = "";
	let lastMissing = include.map((entry) => entry.source);
	let lastUnexpected = [];
	while (Date.now() - started < timeoutMs) {
		if (hasExited()) break;
		const snapshot = await replayAnsi(getOutput(), dimensions);
		lastText = snapshot.plainText;
		lastMissing = include.filter((entry) => !entry.regex.test(lastText)).map((entry) => entry.source);
		lastUnexpected = exclude.filter((entry) => entry.regex.test(lastText)).map((entry) => entry.source);
		if (lastMissing.length === 0 && lastUnexpected.length === 0) return;
		if (lastMissing.length === 0 && lastUnexpected.length > 0) {
			const error = new Error(`Runtime capture ${scenario.id} reached active screen with rejected marker(s): ${lastUnexpected.map((entry) => JSON.stringify(entry)).join(", ")}`);
			error.retryable = false;
			error.diagnostics = { unexpected: lastUnexpected, finalScreenTail: lastText.slice(-512) };
			throw error;
		}
		await sleep(50);
	}
	const error = new Error(`Runtime capture ${scenario.id} timed out waiting for final screen patterns. Missing: ${lastMissing.map((entry) => JSON.stringify(entry)).join(", ") || "(none)"}; unexpected: ${lastUnexpected.map((entry) => JSON.stringify(entry)).join(", ") || "(none)"}`);
	error.retryable = true;
	error.diagnostics = { missing: lastMissing, unexpected: lastUnexpected, finalScreenTail: lastText.slice(-512) };
	throw error;
}

function compilePatternList(scenario, patterns, field) {
	if (!Array.isArray(patterns)) {
		throw new Error(`Runtime final-screen wait in ${scenario.id} ${field} must be an array`);
	}
	return patterns.map((pattern) => {
		if (typeof pattern !== "string" || pattern.length === 0) {
			throw new Error(`Runtime final-screen wait in ${scenario.id} ${field} entries must be non-empty strings`);
		}
		return { source: pattern, regex: new RegExp(pattern, "m") };
	});
}

async function waitForStableOutput(getLength, hasMeaningfulOutput, hasExited, totalTimeoutMs, stabilizeMs) {
	const pollMs = 50;
	const started = Date.now();
	let lastLength = getLength();
	let lastChange = Date.now();
	while (Date.now() - started < totalTimeoutMs) {
		if (hasExited()) return;
		const length = getLength();
		if (length !== lastLength) {
			lastLength = length;
			lastChange = Date.now();
		}
		if (hasMeaningfulOutput() && Date.now() - lastChange >= stabilizeMs) return;
		await sleep(pollMs);
	}
}

async function awaitChildExit(child, hasExited, softTimeoutMs) {
	const pollMs = 25;
	const startedSoft = Date.now();
	while (!hasExited() && Date.now() - startedSoft < softTimeoutMs) {
		await sleep(pollMs);
	}
	if (hasExited()) return;
	try {
		child.kill("SIGKILL");
	} catch {
		// process may already be gone
	}
	const hardTimeoutMs = 1000;
	const startedHard = Date.now();
	while (!hasExited() && Date.now() - startedHard < hardTimeoutMs) {
		await sleep(pollMs);
	}
}

async function terminateChild(child, hasExited) {
	try {
		child.kill("SIGTERM");
	} catch {
		// process may already be gone
	}
	// Block until the child actually exits before this attempt resolves so
	// retries cannot run concurrently with a still-shutting-down `sumocode`
	// process. SIGTERM-then-SIGKILL escalates so we never hang the harness on
	// a wedged child.
	await awaitChildExit(child, hasExited, 1000);
}

function deterministicEnv(extra = {}) {
	const env = {
		...process.env,
		TERM: "xterm-256color",
		COLORTERM: "truecolor",
		FORCE_COLOR: "3",
		PI_OFFLINE: "1",
		SUMO_TUI: "1",
		...extra,
	};
	delete env.NO_COLOR;
	return env;
}

function isolatedRuntimeEnv(extra = {}) {
	const hasScenarioPiDir = Object.prototype.hasOwnProperty.call(extra, "PI_CODING_AGENT_DIR");
	const piCodingAgentDir = hasScenarioPiDir
		? extra.PI_CODING_AGENT_DIR
		: mkdtempSync(resolve(tmpdir(), "sumocode-visual-pi-"));
	const env = deterministicEnv({
		...extra,
		PI_CODING_AGENT_DIR: piCodingAgentDir,
	});
	return {
		env,
		piCodingAgentDir,
		piCodingAgentDirSource: hasScenarioPiDir ? "scenario" : "temporary",
		cleanup() {
			if (hasScenarioPiDir) return;
			try {
				rmSync(piCodingAgentDir, { recursive: true, force: true });
			} catch {
				// Best-effort cleanup only; capture evidence should not fail on tmpdir removal.
			}
		},
	};
}

export function findRejection(text, patterns) {
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
