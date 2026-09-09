#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn as spawnPty } from "node-pty";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const OUT_PATH = join(ROOT, "docs", "perf", "startup.json");
const SUMMARY_PATH = join(ROOT, "docs", "perf", "startup.md");
const STARTUP_PRELOAD = join(ROOT, "scripts", "startup-diagnostics-preload.cjs");
const RUNS = Math.max(1, Number.parseInt(process.env.SUMOCODE_STARTUP_PERF_RUNS ?? "5", 10));
const TIMEOUT_MS = Math.max(1000, Number.parseInt(process.env.SUMOCODE_STARTUP_PERF_TIMEOUT_MS ?? "15000", 10));
const STARTUP_EVENT_POLL_MS = 25;

function nowMs() {
	return Number(process.hrtime.bigint()) / 1_000_000;
}

function middleAverage(values) {
	if (values.length <= 2) return values.reduce((sum, value) => sum + value, 0) / values.length;
	const sorted = [...values].sort((a, b) => a - b);
	const middle = sorted.slice(1, -1);
	return middle.reduce((sum, value) => sum + value, 0) / middle.length;
}

function round(value) {
	return Math.round(value * 10) / 10;
}

function buildNodeOptions() {
	const existing = process.env.NODE_OPTIONS?.trim() ?? "";
	if (!STARTUP_PRELOAD) return existing;
	if (existing.includes(STARTUP_PRELOAD)) return existing;
	const preloadFlag = `--require "${STARTUP_PRELOAD}"`;
	return `${existing} ${preloadFlag}`.trim();
}

async function readDiagnosticEvents(path) {
	try {
		const raw = await readFile(path, "utf8");
		return raw
			.split("\n")
			.filter(Boolean)
			.map((line) => {
				try {
					return JSON.parse(line);
				} catch {
					return undefined;
				}
			})
			// oxlint-disable-next-line anti-slop/no-runtime-typeof -- guard on parsed diagnostics JSONL events
			.filter((event) => event && typeof event === "object");
	} catch {
		return [];
	}
}

function eventElapsedMs(events, eventName, startWallMs) {
	const event = events.find((entry) => entry?.event === eventName);
	// oxlint-disable-next-line anti-slop/no-runtime-typeof -- timestamp check on parsed diagnostics event
	return typeof event?.ts === "number" ? Math.max(0, event.ts - startWallMs) : undefined;
}

export function readinessTimeline(events, startWallMs) {
	const hasTruthfulReadiness = events.some((entry) => entry?.event === "editor_ready");
	const editorReadyMs = eventElapsedMs(events, hasTruthfulReadiness ? "editor_ready" : "input_ready", startWallMs);
	const commandReadyMs = eventElapsedMs(events, hasTruthfulReadiness ? "command_ready" : "app_ready", startWallMs);
	return {
		editorReadyMs,
		commandReadyMs,
		editorToCommandGapMs: editorReadyMs === undefined || commandReadyMs === undefined
			? undefined
			: Math.max(0, commandReadyMs - editorReadyMs),
	};
}

export function startupTimelineComplete(snapshot) {
	return snapshot.bootScreenFrameMs !== undefined
		&& snapshot.editorReadyMs !== undefined
		&& snapshot.commandReadyMs !== undefined
		&& snapshot.editorToCommandGapMs !== undefined
		&& snapshot.stableChromeMs !== undefined;
}

export function classifyRpcProbeLine(line) {
	try {
		const response = JSON.parse(line);
		if (response?.type !== "response" || response.id !== "probe-1" || response.command !== "get_state") return undefined;
		return response.success === true ? "success" : "failure";
	} catch {
		return undefined;
	}
}

export function summariseMeasurement(label, samples) {
	const safeSamples = samples.map((sample) => {
		// Every probe can emit operator-specific provider/extension diagnostics,
		// including on success. Keep only structured timings/status in the
		// tracked public report; raw stderr/stdout/PTY/diagnostic tails remain
		// process-local and must never be serialized.
		const {
			stderr: _stderr,
			stdout: _stdout,
			output: _output,
			diagEvents: _diagEvents,
			...publicSample
		} = sample;
		if (sample.ok !== false) return publicSample;
		// Node spawn errors include absolute executable paths. Never preserve a
		// caller-provided error string in a tracked report.
		return { ...publicSample, error: "process failed" };
	});
	const successfulSamples = safeSamples.filter((sample) => sample.ok !== false);
	const durations = successfulSamples.map((sample) => sample.durationMs);
	return {
		label,
		samples: safeSamples,
		failedRuns: safeSamples.length - successfulSamples.length,
		avgMiddleMs: durations.length > 0 ? round(middleAverage(durations)) : null,
		minMs: durations.length > 0 ? round(Math.min(...durations)) : null,
		maxMs: durations.length > 0 ? round(Math.max(...durations)) : null,
	};
}

function metricSamples(rawSamples, key) {
	return rawSamples.map((sample) => ({
		...sample,
		durationMs: sample[key] ?? sample.durationMs,
	}));
}

async function measureProcess(label, command, args) {
	const samples = [];
	for (let index = 0; index < RUNS; index += 1) {
		const start = nowMs();
		const result = await new Promise((resolveSample) => {
			const child = spawn(command, args, {
				cwd: ROOT,
				env: { ...process.env, SUMO_TUI: "1" },
				stdio: ["ignore", "ignore", "pipe"],
			});
			let stderr = "";
			const timer = setTimeout(() => {
				child.kill("SIGTERM");
				resolveSample({ ok: false, durationMs: nowMs() - start, error: `${label} timed out`, stderr });
			}, TIMEOUT_MS);
			child.stderr?.on("data", (chunk) => {
				stderr += chunk.toString("utf8");
				if (stderr.length > 4000) stderr = stderr.slice(-4000);
			});
			child.on("exit", (code, signal) => {
				clearTimeout(timer);
				resolveSample({ ok: code === 0, durationMs: nowMs() - start, code, signal, stderr });
			});
		});
		samples.push(result);
	}
	return summariseMeasurement(label, samples);
}

async function measureChildFirstResponse(label, extraArgs = []) {
	const samples = [];
	for (let index = 0; index < RUNS; index += 1) {
		const start = nowMs();
		const child = spawn(
			join(ROOT, "node_modules", ".bin", "pi"),
			["--mode", "rpc", "-e", join(ROOT, "src", "extension.ts"), "--offline", "--no-session", ...extraArgs],
			{
				cwd: ROOT,
				env: {
					...process.env,
					SUMO_TUI: "0",
					SUMOCODE_RPC_CHILD: "1",
					SUMOCODE_ROOT_DIR: ROOT,
					SUMOCODE_LAUNCHER: join(ROOT, "bin", "sumocode.sh"),
				},
				stdio: ["pipe", "pipe", "pipe"],
			},
		);
		let output = "";
		let responseBuffer = "";
		let stderr = "";
		let settled = false;
		const sample = await new Promise((resolveSample) => {
			const settle = (result) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				resolveSample(result);
			};
			const terminate = () => {
				try {
					child.kill("SIGTERM");
				} catch {}
				setTimeout(() => {
					try {
						child.kill("SIGKILL");
					} catch {}
				}, 250).unref?.();
			};
			const timer = setTimeout(() => {
				terminate();
				settle({ ok: false, durationMs: nowMs() - start, error: `${label} timed out`, stderr });
			}, TIMEOUT_MS);
			child.stdout?.on("data", (chunk) => {
				const text = chunk.toString("utf8");
				output += text;
				responseBuffer += text;
				let newline = responseBuffer.indexOf("\n");
				while (newline >= 0) {
					const line = responseBuffer.slice(0, newline);
					responseBuffer = responseBuffer.slice(newline + 1);
					const classification = classifyRpcProbeLine(line);
					if (classification !== undefined) {
						const durationMs = nowMs() - start;
						terminate();
						settle(classification === "success"
							? { ok: true, durationMs }
							: { ok: false, durationMs, error: `${label} get_state failed` });
						return;
					}
					newline = responseBuffer.indexOf("\n");
				}
			});
			child.stderr?.on("data", (chunk) => {
				stderr += chunk.toString("utf8");
				if (stderr.length > 4000) stderr = stderr.slice(-4000);
			});
			child.on("error", (error) => {
				settle({ ok: false, durationMs: nowMs() - start, error: error.message, stderr });
			});
			child.on("exit", (code, signal) => {
				settle({ ok: false, durationMs: nowMs() - start, code, signal, output: output.slice(-1200), stderr });
			});
			child.stdin?.write(`${JSON.stringify({ type: "get_state", id: "probe-1" })}\n`);
		});
		samples.push(sample);
		await new Promise((resolveSleep) => setTimeout(resolveSleep, 100));
	}
	return summariseMeasurement(label, samples);
}

const HOST_IMPORT_SNIPPET = `
const t = performance.now();
const { createJiti } = await import(process.env.PERF_ROOT + "/node_modules/jiti/lib/jiti.mjs");
const jiti = createJiti("file://" + process.env.PERF_ROOT + "/sumo-rpc-host.js", { moduleCache: true, tryNative: false });
await jiti.import(process.env.PERF_ROOT + "/src/sumo-tui/rpc/host.ts");
console.log(Math.round(performance.now() - t));
`;

async function measureHostImport() {
	const samples = [];
	for (let index = 0; index < RUNS; index += 1) {
		const start = nowMs();
		const child = spawn(process.execPath, ["--input-type=module", "-e", HOST_IMPORT_SNIPPET], {
			cwd: ROOT,
			env: { ...process.env, PERF_ROOT: ROOT },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		let settled = false;
		const sample = await new Promise((resolveSample) => {
			const settle = (result) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				resolveSample(result);
			};
			const terminate = () => {
				try {
					child.kill("SIGTERM");
				} catch {}
				setTimeout(() => {
					try {
						child.kill("SIGKILL");
					} catch {}
				}, 250).unref?.();
			};
			const timer = setTimeout(() => {
				terminate();
				settle({ ok: false, durationMs: nowMs() - start, error: "host-import timed out", stderr });
			}, TIMEOUT_MS);
			child.stdout?.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
			child.stderr?.on("data", (chunk) => {
				stderr += chunk.toString("utf8");
				if (stderr.length > 4000) stderr = stderr.slice(-4000);
			});
			child.on("error", (error) => {
				settle({ ok: false, durationMs: nowMs() - start, error: error.message, stderr });
			});
			child.on("exit", (code, signal) => {
				const parsed = stdout.trim();
				const durationMs = Number.parseInt(parsed, 10);
				if (code === 0 && /^\d+$/.test(parsed) && Number.isFinite(durationMs)) {
					settle({ ok: true, durationMs });
					return;
				}
				settle({ ok: false, durationMs: nowMs() - start, code, signal, error: "host-import returned an invalid duration", stdout, stderr });
			});
		});
		samples.push(sample);
		await new Promise((resolveSleep) => setTimeout(resolveSleep, 100));
	}
	return summariseMeasurement("host-import", samples);
}

async function measureFirstFrame() {
	const samples = [];
	for (let index = 0; index < RUNS; index += 1) {
		const start = nowMs();
		const child = spawnPty(join(ROOT, "bin", "sumocode.sh"), ["--offline", "--no-extensions", "--no-session"], {
			name: "xterm-256color",
			cols: 100,
			rows: 30,
			cwd: ROOT,
			env: { ...process.env, TERM: "xterm-256color", SUMO_TUI: "1" },
		});
		let output = "";
		let settled = false;
		const sample = await new Promise((resolveSample) => {
			const settle = (result) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				resolveSample(result);
			};
			const timer = setTimeout(() => {
				child.kill("SIGTERM");
				settle({ ok: false, durationMs: nowMs() - start, error: "first frame timed out", output: output.slice(-1200) });
			}, TIMEOUT_MS);
			child.onData((data) => {
				output += data;
				if (output.length > 20_000) output = output.slice(-10_000);
				if (data.includes("\x1b[?1049h") || data.includes("\x1b[?2026h") || output.includes("DIVINE INVOCATION")) {
					const durationMs = nowMs() - start;
					child.kill("SIGINT");
					setTimeout(() => child.kill("SIGTERM"), 250).unref?.();
					settle({ ok: true, durationMs });
				}
			});
			child.onExit(({ exitCode, signal }) => {
				settle({ ok: false, durationMs: nowMs() - start, exitCode, signal, output: output.slice(-1200) });
			});
		});
		samples.push(sample);
		await new Promise((resolveSleep) => setTimeout(resolveSleep, 100));
	}
	return summariseMeasurement("first-frame", samples);
}

async function measureStartupTimeline() {
	const rawSamples = [];
	for (let index = 0; index < RUNS; index += 1) {
		const diagDir = await mkdtemp(join(tmpdir(), "sumocode-startup-diag-"));
		const diagFile = join(diagDir, "startup.jsonl");
		const start = nowMs();
		const startWallMs = Date.now();
		const child = spawnPty(join(ROOT, "bin", "sumocode.sh"), ["--offline", "--no-extensions", "--no-session"], {
			name: "xterm-256color",
			cols: 100,
			rows: 30,
			cwd: ROOT,
			env: {
				...process.env,
				TERM: "xterm-256color",
				SUMO_TUI: "1",
				SUMO_TUI_DIAG_FILE: diagFile,
				SUMO_TUI_DEBUG: process.env.SUMO_TUI_DEBUG ?? "1",
				NODE_OPTIONS: buildNodeOptions(),
			},
		});
		let output = "";
		let settled = false;
		let resolveChildExit;
		const childExit = new Promise((resolveExit) => { resolveChildExit = resolveExit; });
		const sample = await new Promise((resolveSample) => {
			let pollHandle;
			const settle = async (result) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				if (pollHandle !== undefined) clearInterval(pollHandle);
				try {
					child.kill("SIGINT");
				} catch {}
				setTimeout(() => {
					try {
						child.kill("SIGTERM");
					} catch {}
				}, 250).unref?.();
				resolveSample(result);
			};
			const collect = async () => {
				const events = await readDiagnosticEvents(diagFile);
				return {
					events,
					bootScreenFrameMs: eventElapsedMs(events, "boot_screen_frame", startWallMs),
					...readinessTimeline(events, startWallMs),
					appReadyMs: eventElapsedMs(events, "app_ready", startWallMs),
					stableChromeMs: eventElapsedMs(events, "stable_chrome_ready", startWallMs),
					inputReadyMs: eventElapsedMs(events, "input_ready", startWallMs),
				};
			};
			pollHandle = setInterval(async () => {
				const snapshot = await collect();
				if (startupTimelineComplete(snapshot)) {
					const { events: _events, ...timings } = snapshot;
					await settle({ ok: true, durationMs: nowMs() - start, ...timings });
				}
			}, STARTUP_EVENT_POLL_MS);
			const timer = setTimeout(async () => {
				const snapshot = await collect();
				const { events, ...timings } = snapshot;
				await settle({ ok: false, durationMs: nowMs() - start, error: "startup timeline timed out", output: output.slice(-1200), diagEvents: events.slice(-25), ...timings });
			}, TIMEOUT_MS);
			child.onData((data) => {
				output += data;
				if (output.length > 20_000) output = output.slice(-10_000);
			});
			child.onExit(async ({ exitCode, signal }) => {
				resolveChildExit();
				if (settled) return;
				const snapshot = await collect();
				const { events, ...timings } = snapshot;
				await settle({ ok: false, durationMs: nowMs() - start, exitCode, signal, output: output.slice(-1200), diagEvents: events.slice(-25), ...timings });
			});
		});
		rawSamples.push(sample);
		const exitedAfterTerm = await Promise.race([
			childExit.then(() => true),
			new Promise((resolveWait) => setTimeout(() => resolveWait(false), 750)),
		]);
		if (!exitedAfterTerm) {
			try { child.kill("SIGKILL"); } catch {}
			await Promise.race([childExit, new Promise((resolveWait) => setTimeout(resolveWait, 250))]);
		}
		await rm(diagDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
		await new Promise((resolveSleep) => setTimeout(resolveSleep, 100));
	}
	return [
		summariseMeasurement("boot-screen-frame", metricSamples(rawSamples, "bootScreenFrameMs")),
		summariseMeasurement("editor-ready", metricSamples(rawSamples, "editorReadyMs")),
		summariseMeasurement("command-ready", metricSamples(rawSamples, "commandReadyMs")),
		summariseMeasurement("editor-to-command-gap", metricSamples(rawSamples, "editorToCommandGapMs")),
		summariseMeasurement("app-ready-deprecated", metricSamples(rawSamples, "appReadyMs")),
		summariseMeasurement("stable-chrome", metricSamples(rawSamples, "stableChromeMs")),
		summariseMeasurement("input-ready-deprecated", metricSamples(rawSamples, "inputReadyMs")),
	];
}

function markdown(report) {
	const rows = report.measurements.map((measurement) => `| ${measurement.label} | ${measurement.avgMiddleMs === null ? "—" : `${measurement.avgMiddleMs}ms`} | ${measurement.minMs === null ? "—" : `${measurement.minMs}ms`} | ${measurement.maxMs === null ? "—" : `${measurement.maxMs}ms`} | ${measurement.samples.length} | ${measurement.failedRuns} |`);
	return `# SumoCode startup perf snapshot\n\nReport-only startup measurements for the current checkout. These numbers are intentionally not CI gates; use them to compare phase-by-phase deltas. The retained timeline runs \`sumocode.sh --offline --no-extensions --no-session\`; do not compare it directly with a normal configured-session workload. It reports editable first paint (\`editor_ready\`), hydrated command dispatch (\`command_ready\`), and their gap. The deprecated \`input_ready\` / \`app_ready\` aliases remain visible for one release. While startup is serial, first-frame is approximately host-import + child-first-response-noext + hydration round trips because the first-frame probe passes \`--no-extensions\`; plan 061 changes that relationship. Child-first-response minus child-first-response-noext estimates the installed-extension-corpus cost.\n\n- commit: \`${report.commit}\`\n- runs: ${report.runs}\n- generated: ${report.generatedAt}\n\n| Measurement | Avg middle runs | Min | Max | Runs | Failed |\n| --- | ---: | ---: | ---: | ---: | ---: |\n${rows.join("\n")}\n`;
}

async function main() {
	const commit = await new Promise((resolveCommit) => {
		const child = spawn("git", ["log", "--oneline", "-1"], { cwd: ROOT, stdio: ["ignore", "pipe", "ignore"] });
		let out = "";
		child.stdout.on("data", (chunk) => { out += chunk.toString("utf8"); });
		child.on("exit", () => resolveCommit(out.trim() || "unknown"));
	});
	const measurements = [
		await measureProcess("launcher-dry-run", join(ROOT, "bin", "sumocode.sh"), ["--dry-run"]),
		await measureHostImport(),
		await measureChildFirstResponse("child-first-response"),
		await measureChildFirstResponse("child-first-response-noext", ["--no-extensions"]),
		await measureProcess("print-mode", join(ROOT, "bin", "sumocode.sh"), ["--offline", "--no-extensions", "--no-session", "--print", "hello"]),
		await measureFirstFrame(),
		...(await measureStartupTimeline()),
	];
	const report = { generatedAt: new Date().toISOString(), commit, runs: RUNS, measurements };
	await mkdir(dirname(OUT_PATH), { recursive: true });
	await writeFile(OUT_PATH, `${JSON.stringify(report, null, 2)}\n`);
	await writeFile(SUMMARY_PATH, markdown(report));
	console.log(markdown(report));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch((error) => {
		console.error(error);
		process.exit(1);
	});
}
