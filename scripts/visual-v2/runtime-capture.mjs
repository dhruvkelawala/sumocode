import { chmodSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { spawn } from "node-pty";
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

	const child = spawn(command, args, {
		name: "xterm-256color",
		cols: dimensions.cols,
		rows: dimensions.rows,
		cwd: repoRoot,
		env: deterministicEnv(runtime.env),
	});

	const startedAt = Date.now();
	let output = "";
	let exited = false;
	let exitInfo = null;
	let firstByteAt = null;
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
		if (input.type === "text") child.write(input.value ?? "");
		else if (input.type === "key") child.write(input.value ?? "");
		else throw new Error(`Unsupported runtime input type in ${scenario.id}: ${input.type}`);
	}

	const settleMs = Math.max(0, Number(runtime.settleMs ?? 500));
	await sleep(settleMs);

	const emptyOutputGraceMs = Math.max(0, Number(runtime.emptyOutputGraceMs ?? 5000));
	if (!exited && output.trim().length === 0 && emptyOutputGraceMs > 0) {
		// CI runners can be slow to reach the first retained-frame write,
		// especially for no-input splash captures. Poll for non-whitespace
		// output so we settle as soon as the first frame byte lands but never
		// short-circuit on stray `\r\n` keepalive chunks that would still trip
		// the empty-output check below.
		await waitForFirstByte(() => output.trim().length > 0 || exited, emptyOutputGraceMs);
	}

	const captured = output;
	const plain = stripAnsi(captured);
	const rejection = findRejection(plain, scenario.rejectIfOutputMatches ?? []);

	try {
		child.kill("SIGTERM");
	} catch {
		// process may already be gone
	}
	// Block until the child actually exits before this attempt resolves so
	// retries cannot run concurrently with a still-shutting-down `sumocode`
	// process. SIGTERM-then-SIGKILL escalates so we never hang the harness on
	// a wedged child.
	await awaitChildExit(child, () => exited, 1000);

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
		},
	};
}

async function waitForFirstByte(isReady, timeoutMs) {
	const pollMs = 50;
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		if (isReady()) return;
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
