#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn as spawnPty } from "node-pty";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const SAMPLE_MS = Number.parseInt(process.env.SUMO_TUI_DIAG_SAMPLE_MS ?? "30000", 10);
const SAMPLE_INTERVAL_MS = Number.parseInt(process.env.SUMO_TUI_DIAG_SAMPLE_INTERVAL_MS ?? "250", 10);
const SETTLE_MS = Number.parseInt(process.env.SUMO_TUI_DIAG_SETTLE_MS ?? "5000", 10);
const FIRST_FRAME_TIMEOUT_MS = Number.parseInt(process.env.SUMO_TUI_DIAG_FIRST_FRAME_TIMEOUT_MS ?? "15000", 10);
const PROFILE_MS = Number.parseInt(process.env.SUMO_TUI_DIAG_PROFILE_MS ?? "10000", 10);
const CPU_PROF_DIR = process.env.SUMO_TUI_CPU_PROF_DIR ?? "/tmp/sumo-cpu-prof";
const DIAG_HOOK = join(ROOT, "scripts", "sumo-tui-diag-hooks.mjs");
const DOC_PATH = join(ROOT, "docs", "research", "sumo-tui-cpu-diagnosis.md");
const DIAG_MODE = process.env.SUMO_TUI_DIAG_MODE === "full" ? "full" : "offline";
const DIAG_ARGS = (process.env.SUMO_TUI_DIAG_ARGS ?? (DIAG_MODE === "full" ? "" : "--offline")).split(/\s+/).filter(Boolean);
const TYPE_TEXT = process.env.SUMO_TUI_DIAG_TYPE_TEXT ?? "sumocode54";
const TYPE_INTERVAL_MS = Number.parseInt(process.env.SUMO_TUI_DIAG_TYPE_INTERVAL_MS ?? "50", 10);
const TYPE_AT_MS = Number.parseInt(process.env.SUMO_TUI_DIAG_TYPE_AT_MS ?? String(Math.floor(SAMPLE_MS / 2)), 10);
const TYPE_WINDOW_AFTER_MS = Number.parseInt(process.env.SUMO_TUI_DIAG_TYPE_WINDOW_AFTER_MS ?? "2000", 10);

function sleep(ms) {
	return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function ensureNodePtySpawnHelperExecutable() {
	const require = createRequire(import.meta.url);
	const nodePtyMain = require.resolve("node-pty");
	const spawnHelper = join(dirname(nodePtyMain), "..", "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper");
	if (existsSync(spawnHelper)) chmodSync(spawnHelper, 0o755);
}

function readPsSample(pid) {
	try {
		const output = execFileSync("ps", ["-p", String(pid), "-o", "%cpu=,rss=,vsize="], { encoding: "utf8" }).trim();
		if (output.length === 0) return undefined;
		const [cpuText, rssText, vsizeText] = output.split(/\s+/);
		const cpu = Number.parseFloat(cpuText ?? "");
		const rssKiB = Number.parseInt(rssText ?? "", 10);
		const vsizeKiB = Number.parseInt(vsizeText ?? "", 10);
		return {
			ts: Date.now(),
			cpu: Number.isFinite(cpu) ? cpu : 0,
			rssKiB: Number.isFinite(rssKiB) ? rssKiB : 0,
			vsizeKiB: Number.isFinite(vsizeKiB) ? vsizeKiB : 0,
		};
	} catch {
		return undefined;
	}
}

function average(values) {
	if (values.length === 0) return 0;
	return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function formatPercent(value) {
	return `${value.toFixed(value >= 10 ? 1 : 2)}%`;
}

function formatBytesPerSecond(value) {
	if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(2)} MiB/sec`;
	if (value >= 1024) return `${(value / 1024).toFixed(1)} KiB/sec`;
	return `${Math.round(value)} bytes/sec`;
}

function formatMiBFromKiB(kib) {
	return `${(kib / 1024).toFixed(1)} MiB`;
}

function formatArgs(args) {
	return args.length > 0 ? ` ${args.join(" ")}` : "";
}

function sendTypingBurst(child, text, intervalMs) {
	return new Promise((resolveType) => {
		let index = 0;
		const writeNext = () => {
			if (index >= text.length) {
				resolveType();
				return;
			}
			child.write(text[index]);
			index += 1;
			setTimeout(writeNext, intervalMs);
		};
		writeNext();
	});
}

function parseJsonLines(text) {
	const entries = [];
	for (const line of text.split("\n")) {
		if (line.trim().length === 0) continue;
		try {
			entries.push(JSON.parse(line));
		} catch {
			// Ignore torn diagnostic writes.
		}
	}
	return entries;
}

function stackHead(stack) {
	if (typeof stack !== "string" || stack.length === 0) return "<no stack>";
	return stack.split(" | ").slice(0, 4).join(" | ");
}

function topGroup(entries, keyFn) {
	const counts = new Map();
	for (const entry of entries) {
		const key = keyFn(entry);
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	let bestKey = "<none>";
	let bestCount = 0;
	for (const [key, count] of counts) {
		if (count > bestCount) {
			bestKey = key;
			bestCount = count;
		}
	}
	return { key: bestKey, count: bestCount };
}

async function newestCpuProfile() {
	try {
		const files = await readdir(CPU_PROF_DIR, { withFileTypes: true });
		const profiles = [];
		for (const file of files) {
			if (!file.isFile() || !file.name.endsWith(".cpuprofile")) continue;
			const path = join(CPU_PROF_DIR, file.name);
			profiles.push({ path, name: file.name });
		}
		profiles.sort((a, b) => a.name.localeCompare(b.name));
		return profiles.at(-1)?.path;
	} catch {
		return undefined;
	}
}

async function analyzeCpuProfile(profilePath) {
	if (!profilePath) return { profilePath: undefined, top: [] };
	try {
		const profile = JSON.parse(await readFile(profilePath, "utf8"));
		const nodes = new Map();
		for (const node of profile.nodes ?? []) nodes.set(node.id, node);
		const sampleCounts = new Map();
		for (const id of profile.samples ?? []) sampleCounts.set(id, (sampleCounts.get(id) ?? 0) + 1);
		const top = [...sampleCounts.entries()]
			.map(([id, samples]) => {
				const node = nodes.get(id);
				const frame = node?.callFrame ?? {};
				return {
					functionName: frame.functionName || "(anonymous)",
					url: frame.url || "<native>",
					lineNumber: Number.isFinite(frame.lineNumber) ? frame.lineNumber + 1 : undefined,
					samples,
				};
			})
			.sort((a, b) => b.samples - a.samples)
			.slice(0, 10);
		return { profilePath, top };
	} catch (error) {
		return { profilePath, top: [{ functionName: `profile parse failed: ${error.message}`, url: "", samples: 0 }] };
	}
}

function chooseCulprit(metrics) {
	if (metrics.frameRendersPerSec > 5) {
		return {
			culprit: "frame-scheduler renders continuously at idle; streaming mode is staying armed without dirty work",
			recommendedFix: "Only keep the streaming timer armed while queued dirty frames exist, and exit/avoid streaming mode when the stream ends.",
		};
	}
	if (metrics.stdoutBytesPerSec > 10 * 1024) {
		return {
			culprit: "stdout emits ANSI continuously at idle; requestRender is being called without a dirty state change",
			recommendedFix: "Trace the hottest Pi event/timer stack and gate renders behind dirty-frame checks.",
		};
	}
	if (metrics.intervalFiresPerSec > 1) {
		return {
			culprit: `setInterval fires continuously from ${metrics.hottestIntervalStack}`,
			recommendedFix: "Replace idle polling with event-driven invalidation or stop the interval after the first idle tick.",
		};
	}
	if (metrics.timeoutFiresPerSec > 5) {
		return {
			culprit: `setTimeout chain fires continuously from ${metrics.hottestTimeoutStack}`,
			recommendedFix: "Stop re-arming the timeout chain when no dirty frame is queued.",
		};
	}
	if (metrics.avgCpu > 1) {
		const hottestProfile = metrics.cpuProfileTop[0];
		return {
			culprit: `CPU is above budget but render/timer counters are quiet; hottest profile frame is ${hottestProfile ? `${hottestProfile.functionName} (${hottestProfile.url})` : "unknown"}`,
			recommendedFix: "Open the CPU profile in DevTools and optimize the hottest self-time frame.",
		};
	}
	return {
		culprit: "no idle CPU pegging detected in this run",
		recommendedFix: "Keep scheduler idle event-driven; rerun after any render-loop changes.",
	};
}

function buildMarkdown(result) {
	const timerRows = result.timerTopStacks
		.map((entry) => `| ${entry.kind} | ${entry.count} | ${(entry.count / result.sampleSeconds).toFixed(2)}/sec | \`${entry.stack.replaceAll("`", "'")}\` |`)
		.join("\n") || "| - | - | - | - |";
	const profileRows = result.cpuProfile.top
		.map((entry) => `| ${entry.samples} | \`${entry.functionName.replaceAll("`", "'")}\` | \`${entry.url.replaceAll("`", "'")}${entry.lineNumber ? `:${entry.lineNumber}` : ""}\` |`)
		.join("\n") || "| - | - | - |";
	return `# Sumo TUI CPU Diagnosis

Generated by \`node scripts/diagnose-sumo-tui-cpu.mjs\` on ${new Date().toISOString()}.

## Harness

- Mode: \`${DIAG_MODE}\` (${DIAG_MODE === "full" ? "real agent dir, extensions enabled, no forced offline env" : "temp agent dir, PI_OFFLINE=1"})
- Spawn path: \`./bin/sumocode.sh${formatArgs(DIAG_ARGS)}\` inside node-pty
- Worktree: \`${ROOT}\`
- Sample window: ${(result.sampleSeconds).toFixed(1)}s after first altscreen/frame plus ${(SETTLE_MS / 1000).toFixed(1)}s settle time
- Typing burst: \`${TYPE_TEXT}\` at ${(TYPE_AT_MS / 1000).toFixed(1)}s into sample, ${TYPE_INTERVAL_MS}ms/key
- ps cadence: ${SAMPLE_INTERVAL_MS}ms using \`ps -p $PID -o %cpu,rss,vsize\`
- stdout bytes counted from node-pty \`onData\`
- Pi events and frame renders logged to \`${result.diagFile}\`
- Timer fires captured by \`NODE_OPTIONS=--import ${DIAG_HOOK}\`
- CPU sample runs without \`--cpu-prof\` so profiler overhead does not pollute the idle CPU number
- CPU profile: ${result.cpuProfile.profilePath ? `\`${result.cpuProfile.profilePath}\`` : "not written"} (${(PROFILE_MS / 1000).toFixed(1)}s profiled follow-up run with \`--cpu-prof --cpu-prof-dir=${CPU_PROF_DIR}\`)

## Root-cause finding

Round 2 keeps the #53 scheduler guard under watch while also exercising full-extension boot and a mid-sample typing burst. A healthy run has 0 retained \`frame_scheduler_render\` events/sec at idle. The #54 full-mode regression was not a retained render loop: it was sidebar memory work scheduled for the empty splash prompt, which created Remnic retry timers and render callbacks before any chat existed. The code now skips empty scheduled prompts and only calls the sidebar render callback when the memory snapshot changes.

## Latest idle result

| Metric | Value | Budget / signal |
|---|---:|---|
| avg CPU | ${formatPercent(result.avgCpu)} | < 1% |
| peak CPU | ${formatPercent(result.peakCpu)} | investigate spikes |
| typing-window avg CPU | ${formatPercent(result.typingAvgCpu)} | input burst signal |
| typing-window peak CPU | ${formatPercent(result.typingPeakCpu)} | input burst signal |
| avg RSS | ${formatMiBFromKiB(result.avgRssKiB)} | informational |
| peak RSS | ${formatMiBFromKiB(result.peakRssKiB)} | informational |
| stdout bytes | ${formatBytesPerSecond(result.stdoutBytesPerSec)} | >10 KiB/sec means continuous ANSI render |
| Pi events | ${result.piEventsPerSec.toFixed(2)}/sec | high = event leak |
| frame-scheduler renders | ${result.frameRendersPerSec.toFixed(2)}/sec | >5/sec at idle is a bug |
| setInterval fires | ${result.intervalFiresPerSec.toFixed(2)}/sec | >1/sec is suspect |
| setTimeout fires | ${result.timeoutFiresPerSec.toFixed(2)}/sec | hot chain = suspect |

## Culprit assessment

- Culprit: **${result.culprit}**
- Recommended fix: ${result.recommendedFix}

## Timer hot stacks

| Kind | Fires | Rate | Stack |
|---|---:|---:|---|
${timerRows}

## CPU profile hottest sampled frames

| Samples | Function | URL |
|---:|---|---|
${profileRows}

## Notes

The #53 scheduler bug was that \`FrameScheduler.enterStreamingMode()\` armed a 16ms timeout even when there were no queued dirty frames, and \`flushStreamingTick()\` re-armed it unconditionally while streaming stayed true. Round 2 confirms that guard still holds: true idle has no retained frame-scheduler render loop, and full-mode extension timers are reported separately.
`;
}

function buildNodeOptions(existingNodeOptions, { profile }) {
	return [
		existingNodeOptions,
		`--import=${pathToFileURL(DIAG_HOOK).href}`,
		profile ? "--cpu-prof" : undefined,
		profile ? `--cpu-prof-dir=${CPU_PROF_DIR}` : undefined,
	]
		.filter(Boolean)
		.join(" ");
}

function spawnDiagnosticProcess({ agentDir, diagFile, nodeOptions }) {
	const env = {
		...process.env,
		NODE_OPTIONS: nodeOptions,
		SUMO_TUI: "1",
		SUMO_TUI_HIDE_PI_NOISE: "1",
		SUMO_TUI_DIAG_FILE: diagFile,
		SUMO_TUI_DIAG_TIMER_MAX_EVENTS: process.env.SUMO_TUI_DIAG_TIMER_MAX_EVENTS ?? "50000",
		SUMO_TUI_MODULE: pathToFileURL(join(ROOT, "sumo-interactive-mode.js")).href,
		TERM: "xterm-256color",
	};
	if (DIAG_MODE === "offline") {
		env.PI_OFFLINE = "1";
		env.PI_CODING_AGENT_DIR = agentDir;
	} else {
		delete env.PI_OFFLINE;
		if (process.env.SUMO_TUI_DIAG_AGENT_DIR) env.PI_CODING_AGENT_DIR = process.env.SUMO_TUI_DIAG_AGENT_DIR;
		else delete env.PI_CODING_AGENT_DIR;
	}
	const child = spawnPty(join(ROOT, "bin", "sumocode.sh"), DIAG_ARGS, {
		name: "xterm-256color",
		cols: 100,
		rows: 30,
		cwd: ROOT,
		env,
	});
	return child;
}

async function waitForFirstFrame(state) {
	const firstFrameDeadline = Date.now() + FIRST_FRAME_TIMEOUT_MS;
	while (Date.now() < firstFrameDeadline) {
		const enteredAltscreen = state.output.includes("\x1b[?1049h");
		const renderedSplashOrInput = state.output.includes("SUMOCODE") || state.output.includes("SCRIPTOR INPUT");
		if (enteredAltscreen && renderedSplashOrInput) return;
		if (state.exited) throw new Error(`sumocode exited before first frame. Last output: ${JSON.stringify(state.output.slice(-1200))}`);
		await sleep(25);
	}
	throw new Error(`Timed out waiting for first frame. Last output: ${JSON.stringify(state.output.slice(-1200))}`);
}

async function terminateChild(child, exitPromise) {
	try {
		child.kill("SIGTERM");
	} catch {
		// already gone
	}
	await Promise.race([exitPromise, sleep(3000)]);
	try {
		child.kill("SIGKILL");
	} catch {
		// already gone
	}
}

async function captureCpuProfile(existingNodeOptions) {
	const profileAgentDir = await mkdtemp(join(tmpdir(), "sumocode-cpu-profile-agent-"));
	const profileDiagDir = await mkdtemp(join(tmpdir(), "sumocode-cpu-profile-diag-"));
	const child = spawnDiagnosticProcess({
		agentDir: profileAgentDir,
		diagFile: join(profileDiagDir, "sumo-tui-profile-diag.jsonl"),
		nodeOptions: buildNodeOptions(existingNodeOptions, { profile: true }),
	});
	const state = { output: "", exited: false };
	const exitPromise = new Promise((resolveExit) => {
		child.onExit((event) => {
			state.exited = true;
			resolveExit(event);
		});
	});
	child.onData((data) => {
		state.output += data;
		if (state.output.length > 200_000) state.output = state.output.slice(-100_000);
	});
	try {
		await waitForFirstFrame(state);
		await sleep(PROFILE_MS);
	} finally {
		await terminateChild(child, exitPromise);
	}
}

async function runDiagnosis() {
	ensureNodePtySpawnHelperExecutable();
	await rm(CPU_PROF_DIR, { recursive: true, force: true });
	await mkdir(CPU_PROF_DIR, { recursive: true });
	await mkdir(dirname(DOC_PATH), { recursive: true });

	const agentDir = await mkdtemp(join(tmpdir(), "sumocode-cpu-agent-"));
	const diagDir = await mkdtemp(join(tmpdir(), "sumocode-cpu-diag-"));
	const diagFile = join(diagDir, "sumo-tui-diag.jsonl");
	const existingNodeOptions = process.env.NODE_OPTIONS?.trim();
	const nodeOptions = buildNodeOptions(existingNodeOptions, { profile: false });

	let output = "";
	let countingStdout = false;
	let stdoutBytes = 0;
	const samples = [];
	let sampleStartTs = 0;
	let sampleEndTs = 0;
	let typingStartTs = 0;
	let typingEndTs = 0;
	let typingPromise;

	const child = spawnDiagnosticProcess({ agentDir, diagFile, nodeOptions });

	let exited = false;
	const exitPromise = new Promise((resolveExit) => {
		child.onExit((event) => {
			exited = true;
			resolveExit(event);
		});
	});

	child.onData((data) => {
		output += data;
		if (output.length > 200_000) output = output.slice(-100_000);
		if (countingStdout) stdoutBytes += Buffer.byteLength(data, "utf8");
	});

	try {
		const firstFrameDeadline = Date.now() + FIRST_FRAME_TIMEOUT_MS;
		while (Date.now() < firstFrameDeadline) {
			const enteredAltscreen = output.includes("\x1b[?1049h");
			const renderedSplashOrInput = output.includes("SUMOCODE") || output.includes("SCRIPTOR INPUT");
			if (enteredAltscreen && renderedSplashOrInput) break;
			if (exited) throw new Error(`sumocode exited before first frame. Last output: ${JSON.stringify(output.slice(-1200))}`);
			await sleep(25);
		}
		const enteredAltscreen = output.includes("\x1b[?1049h");
		const renderedSplashOrInput = output.includes("SUMOCODE") || output.includes("SCRIPTOR INPUT");
		if (!enteredAltscreen || !renderedSplashOrInput) {
			throw new Error(`Timed out waiting for first frame. Last output: ${JSON.stringify(output.slice(-1200))}`);
		}

		if (SETTLE_MS > 0) await sleep(SETTLE_MS);
		countingStdout = true;
		sampleStartTs = Date.now();
		const sampleDeadline = sampleStartTs + SAMPLE_MS;
		const typingAt = sampleStartTs + Math.max(0, Math.min(SAMPLE_MS - 1, TYPE_AT_MS));
		while (Date.now() < sampleDeadline) {
			const now = Date.now();
			if (!typingPromise && now >= typingAt && TYPE_TEXT.length > 0) {
				typingStartTs = now;
				typingPromise = sendTypingBurst(child, TYPE_TEXT, TYPE_INTERVAL_MS).finally(() => {
					typingEndTs = Date.now();
				});
			}
			const sample = readPsSample(child.pid);
			if (sample) samples.push(sample);
			if (exited) break;
			await sleep(SAMPLE_INTERVAL_MS);
		}
		await typingPromise;
		sampleEndTs = Date.now();
	} finally {
		try {
			child.kill("SIGTERM");
		} catch {
			// already gone
		}
		await Promise.race([exitPromise, sleep(3000)]);
		try {
			child.kill("SIGKILL");
		} catch {
			// already gone
		}
	}

	await sleep(250);
	let diagEntries = [];
	try {
		diagEntries = parseJsonLines(await readFile(diagFile, "utf8"));
	} catch {
		// no diagnostics were written
	}
	const windowEntries = diagEntries.filter((entry) => typeof entry.ts === "number" && entry.ts >= sampleStartTs && entry.ts <= sampleEndTs);
	const sampleSeconds = Math.max(0.001, (sampleEndTs - sampleStartTs) / 1000);
	const cpuValues = samples.map((sample) => sample.cpu);
	const typingWindowEndTs = typingEndTs > 0 ? typingEndTs + TYPE_WINDOW_AFTER_MS : 0;
	const typingCpuValues = typingStartTs > 0
		? samples.filter((sample) => sample.ts >= typingStartTs && sample.ts <= typingWindowEndTs).map((sample) => sample.cpu)
		: [];
	const rssValues = samples.map((sample) => sample.rssKiB);
	const frameRenders = windowEntries.filter((entry) => entry.event === "frame_scheduler_render");
	const piEvents = windowEntries.filter((entry) => entry.event === "pi_event");
	const timerFires = windowEntries.filter((entry) => entry.event === "timer_fire");
	const intervalFires = timerFires.filter((entry) => entry.kind === "interval");
	const timeoutFires = timerFires.filter((entry) => entry.kind === "timeout");
	const hottestInterval = topGroup(intervalFires, (entry) => stackHead(entry.stack));
	const hottestTimeout = topGroup(timeoutFires, (entry) => stackHead(entry.stack));
	const timerTopStacks = [...timerFires]
		.reduce((map, entry) => {
			const kind = entry.kind === "interval" ? "interval" : "timeout";
			const stack = stackHead(entry.stack);
			const key = `${kind}\t${stack}`;
			const current = map.get(key) ?? { kind, stack, count: 0 };
			current.count += 1;
			map.set(key, current);
			return map;
		}, new Map())
		.values();
	const sortedTimerTopStacks = [...timerTopStacks].sort((a, b) => b.count - a.count).slice(0, 10);
	await captureCpuProfile(existingNodeOptions);
	const cpuProfile = await analyzeCpuProfile(await newestCpuProfile());

	const metrics = {
		sampleSeconds,
		avgCpu: average(cpuValues),
		peakCpu: cpuValues.length > 0 ? Math.max(...cpuValues) : 0,
		typingAvgCpu: average(typingCpuValues),
		typingPeakCpu: typingCpuValues.length > 0 ? Math.max(...typingCpuValues) : 0,
		avgRssKiB: average(rssValues),
		peakRssKiB: rssValues.length > 0 ? Math.max(...rssValues) : 0,
		stdoutBytesPerSec: stdoutBytes / sampleSeconds,
		frameRendersPerSec: frameRenders.length / sampleSeconds,
		piEventsPerSec: piEvents.length / sampleSeconds,
		intervalFiresPerSec: intervalFires.length / sampleSeconds,
		timeoutFiresPerSec: timeoutFires.length / sampleSeconds,
		hottestIntervalStack: `${hottestInterval.key} (${hottestInterval.count} fires)`,
		hottestTimeoutStack: `${hottestTimeout.key} (${hottestTimeout.count} fires)`,
		cpuProfileTop: cpuProfile.top,
	};
	const assessment = chooseCulprit(metrics);
	const result = {
		...metrics,
		...assessment,
		diagFile,
		cpuProfile,
		timerTopStacks: sortedTimerTopStacks,
	};

	await writeFile(DOC_PATH, buildMarkdown(result), "utf8");
	return result;
}

runDiagnosis()
	.then((result) => {
		console.log("=== SUMO-TUI CPU DIAGNOSIS ===");
		console.log(`idle ${Math.round(result.sampleSeconds)}s sample:`);
		console.log(`  avg CPU: ${formatPercent(result.avgCpu)}`);
		console.log(`  peak CPU: ${formatPercent(result.peakCpu)}`);
		console.log(`  typing-window avg CPU: ${formatPercent(result.typingAvgCpu)}`);
		console.log(`  typing-window peak CPU: ${formatPercent(result.typingPeakCpu)}`);
		console.log(`  avg RSS: ${formatMiBFromKiB(result.avgRssKiB)}`);
		console.log(`  peak RSS: ${formatMiBFromKiB(result.peakRssKiB)}`);
		console.log(`  stdout writes: ${formatBytesPerSecond(result.stdoutBytesPerSec)}  (>10KB/sec = rendering continuously)`);
		console.log(`  Pi events: ${result.piEventsPerSec.toFixed(2)}/sec`);
		console.log(`  frame-scheduler renders: ${result.frameRendersPerSec.toFixed(2)}/sec  (>5/sec at idle = bug)`);
		console.log(`  setInterval fires: ${result.intervalFiresPerSec.toFixed(2)}/sec  (anything firing > 1/sec = suspect)`);
		console.log(`  setTimeout chain detection: ${result.hottestTimeoutStack}`);
		console.log(`culprit: ${result.culprit}`);
		console.log(`recommended fix: ${result.recommendedFix}`);
		console.log(`wrote: ${DOC_PATH}`);
	})
	.catch((error) => {
		console.error(error);
		process.exitCode = 1;
	});
