#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createJiti } from "@mariozechner/jiti";
import { spawn } from "node-pty";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const OUT_PATH = join(ROOT, "docs", "research", "sumo-tui-performance.md");
const FRAME_COUNT = Number.parseInt(process.env.SUMO_TUI_BENCH_FRAMES ?? "1000", 10);
const STREAM_CHUNKS = Number.parseInt(process.env.SUMO_TUI_BENCH_CHUNKS ?? "1000", 10);
const STREAM_SECONDS = Number.parseFloat(process.env.SUMO_TUI_BENCH_STREAM_SECONDS ?? "60");
const IDLE_STEADY_MS = Number.parseInt(process.env.SUMO_TUI_BENCH_IDLE_MS ?? "5000", 10);

const jiti = createJiti(import.meta.url, {
	moduleCache: false,
	tryNative: false,
});

function nowNs() {
	return process.hrtime.bigint();
}

function nsToMs(ns) {
	return Number(ns) / 1_000_000;
}

function sleep(ms) {
	return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function percentile(values, p) {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
	return sorted[index];
}

function formatMs(value) {
	return `${value.toFixed(value >= 100 ? 0 : 2)}ms`;
}

function formatMiB(bytes) {
	return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

function passFail(ok) {
	return ok ? "PASS" : "MISS";
}

function readRssBytes(pid) {
	try {
		const output = execFileSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" }).trim();
		const kib = Number.parseInt(output, 10);
		return Number.isFinite(kib) ? kib * 1024 : undefined;
	} catch {
		return undefined;
	}
}

function ensureNodePtySpawnHelperExecutable() {
	const require = createRequire(import.meta.url);
	const nodePtyMain = require.resolve("node-pty");
	const spawnHelper = join(dirname(nodePtyMain), "..", "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper");
	if (existsSync(spawnHelper)) chmodSync(spawnHelper, 0o755);
}

async function measureColdStartAndIdle() {
	ensureNodePtySpawnHelperExecutable();
	const agentDir = await mkdtemp(join(tmpdir(), "sumocode-bench-agent-"));
	const start = nowNs();
	const child = spawn(join(ROOT, "bin", "sumocode.sh"), ["--offline", "--no-session"], {
		name: "xterm-256color",
		cols: 100,
		rows: 30,
		cwd: ROOT,
		env: {
			...process.env,
			PI_OFFLINE: "1",
			PI_CODING_AGENT_DIR: agentDir,
			SUMO_TUI: "1",
			SUMO_TUI_HIDE_PI_NOISE: "1",
			SUMO_TUI_MODULE: pathToFileURL(join(ROOT, "sumo-interactive-mode.js")).href,
			TERM: "xterm-256color",
		},
	});

	let firstFrameNs;
	let output = "";
	const firstFrame = new Promise((resolveFirstFrame, rejectFirstFrame) => {
		const timer = setTimeout(() => rejectFirstFrame(new Error(`Timed out waiting for first ANSI frame. Last output: ${JSON.stringify(output.slice(-1200))}`)), 15_000);
		child.onData((data) => {
			output += data;
			if (output.length > 100_000) output = output.slice(-50_000);
			if (firstFrameNs !== undefined) return;
			if (data.includes("\x1b[?2026h") || data.includes("\x1b[?1049h")) {
				firstFrameNs = nowNs();
				clearTimeout(timer);
				resolveFirstFrame(undefined);
			}
		});
	});

	try {
		await firstFrame;
		await sleep(IDLE_STEADY_MS);
		const idleRssBytes = readRssBytes(child.pid);
		return {
			coldStartMs: nsToMs(firstFrameNs - start),
			idleRssBytes,
			pid: child.pid,
		};
	} finally {
		try {
			child.kill("SIGTERM");
		} catch {
			// already exited
		}
		await sleep(250);
	}
}

async function measureFrameScheduler() {
	const { FrameScheduler } = await jiti.import(join(ROOT, "src", "sumo-tui", "runtime", "frame-scheduler.ts"));
	const { CellBuffer } = await jiti.import(join(ROOT, "src", "sumo-tui", "render", "buffer.ts"));
	const { diffFrames } = await jiti.import(join(ROOT, "src", "sumo-tui", "render", "diff.ts"));

	const durations = [];
	let previousFrame;
	let frame = 0;
	let resolveRender;
	const scheduler = new FrameScheduler({
		render: () => {
			const start = nowNs();
			const next = new CellBuffer(30, 100);
			for (let row = 0; row < 30; row += 1) {
				next.paintRow(row, `frame ${frame.toString().padStart(4, "0")} row ${row.toString().padStart(2, "0")} ${"·".repeat((frame + row) % 60)}`);
			}
			diffFrames(previousFrame, next);
			previousFrame = next.clone();
			durations.push(nsToMs(nowNs() - start));
			frame += 1;
			resolveRender?.();
		},
	});

	for (let index = 0; index < FRAME_COUNT; index += 1) {
		await new Promise((resolveRenderPromise) => {
			resolveRender = resolveRenderPromise;
			scheduler.requestRender();
		});
	}
	scheduler.dispose();
	return {
		count: durations.length,
		p50Ms: percentile(durations, 50),
		p95Ms: percentile(durations, 95),
		maxMs: Math.max(...durations),
	};
}

async function measureStreamingRss() {
	const { SumoNode } = await jiti.import(join(ROOT, "src", "sumo-tui", "layout", "node.ts"));
	const { DIRECTION_LTR, FLEX_DIRECTION_COLUMN, loadYoga } = await jiti.import(join(ROOT, "src", "sumo-tui", "layout", "yoga.ts"));
	const { CellBuffer } = await jiti.import(join(ROOT, "src", "sumo-tui", "render", "buffer.ts"));
	const { composite } = await jiti.import(join(ROOT, "src", "sumo-tui", "render", "compositor.ts"));
	const { diffFrames } = await jiti.import(join(ROOT, "src", "sumo-tui", "render", "diff.ts"));
	const { FrameScheduler } = await jiti.import(join(ROOT, "src", "sumo-tui", "runtime", "frame-scheduler.ts"));
	const { ChatPager } = await jiti.import(join(ROOT, "src", "sumo-tui", "widgets", "chat-pager.ts"));

	const yoga = await loadYoga();
	const root = new SumoNode(yoga.Node.create());
	root.flexDirection = FLEX_DIRECTION_COLUMN;
	let previousFrame;
	const renderDurations = [];
	const scheduler = new FrameScheduler({
		frameIntervalMs: 16,
		render: () => {
			const start = nowNs();
			root.width = 100;
			root.height = 30;
			root.yogaNode.calculateLayout(100, 30, DIRECTION_LTR);
			const next = new CellBuffer(30, 100);
			composite(root, next);
			diffFrames(previousFrame, next);
			previousFrame = next.clone();
			renderDurations.push(nsToMs(nowNs() - start));
		},
	});
	const chat = ChatPager.create(yoga, root, {
		renderControls: {
			scheduleRender: () => scheduler.requestRender(),
			setStreamingMode: (enabled) => (enabled ? scheduler.enterStreamingMode() : scheduler.exitStreamingMode()),
		},
	});

	const samples = [];
	const sample = (label) => samples.push({ elapsedMs: Math.round(performance.now() - startMs), label, rssBytes: process.memoryUsage().rss });
	const startMs = performance.now();
	let sampleTimer;
	try {
		for (let index = 0; index < 5; index += 1) {
			chat.addMessage(index % 2 === 0 ? "user" : "sumo", index % 2 === 0 ? `Question ${index / 2 + 1}?` : `Answer ${Math.ceil(index / 2)} from the retained ChatPager.`);
		}
		chat.addMessage("sumo", "Streaming: ");
		sample("start");
		sampleTimer = setInterval(() => sample("sample"), 1000);
		const intervalMs = STREAM_SECONDS <= 0 ? 0 : (STREAM_SECONDS * 1000) / STREAM_CHUNKS;
		for (let index = 0; index < STREAM_CHUNKS; index += 1) {
			chat.appendToLast(`chunk-${index} `);
			if (intervalMs > 0) await sleep(intervalMs);
		}
		chat.endStreaming();
		await sleep(100);
		sample("end");
	} finally {
		if (sampleTimer) clearInterval(sampleTimer);
		scheduler.dispose();
		root.dispose();
	}

	const rssValues = samples.map((entry) => entry.rssBytes);
	return {
		chunks: STREAM_CHUNKS,
		durationSeconds: STREAM_SECONDS,
		samples,
		finalRssBytes: rssValues.at(-1),
		peakRssBytes: Math.max(...rssValues),
		renderCount: renderDurations.length,
		renderP50Ms: percentile(renderDurations, 50),
		renderP95Ms: percentile(renderDurations, 95),
	};
}

function buildMarkdown({ cold, frame, streaming }) {
	const coldPass = cold.coldStartMs < 200;
	const idlePass = cold.idleRssBytes === undefined ? false : cold.idleRssBytes < 150 * 1024 * 1024;
	const framePass = frame.p95Ms < 16.7;
	const frameAcceptable = frame.p95Ms < 33.3;
	const streamingPass = streaming.peakRssBytes < 300 * 1024 * 1024;
	const missLines = [];
	if (!coldPass) missLines.push(`- P1: cold start measured ${formatMs(cold.coldStartMs)} from process spawn to first ANSI frame. The original budget is post-Pi-boot, so follow-up should split Pi boot from sumo-tui renderer boot.`);
	if (!idlePass) missLines.push(`- P0: idle RSS ${cold.idleRssBytes === undefined ? "unavailable" : formatMiB(cold.idleRssBytes)} exceeds the 150 MiB budget.`);
	if (!frameAcceptable) missLines.push(`- P0: frame p95 ${formatMs(frame.p95Ms)} misses even the 30fps acceptable ceiling.`);
	else if (!framePass) missLines.push(`- P1: frame p95 ${formatMs(frame.p95Ms)} misses the 60fps target but stays within the 30fps acceptable ceiling.`);
	if (!streamingPass) missLines.push(`- P0: streaming peak RSS ${formatMiB(streaming.peakRssBytes)} exceeds the 300 MiB long-session budget.`);
	if (missLines.length === 0) missLines.push("- No P0/P1 budget misses in this run.");

	const sampleRows = streaming.samples
		.filter((_, index) => index === 0 || index === streaming.samples.length - 1 || index % 10 === 0)
		.map((entry) => `| ${(entry.elapsedMs / 1000).toFixed(1)}s | ${entry.label} | ${formatMiB(entry.rssBytes)} |`)
		.join("\n");

	return `# Sumo TUI Performance Measurements

Generated by \`node scripts/measure-sumo-tui.mjs\` on ${new Date().toISOString()}.

## Environment

- Platform: ${process.platform} ${process.arch}
- Node: ${process.version}
- Worktree: \`${ROOT}\`
- Stream load: ${streaming.chunks} chunks over ${streaming.durationSeconds}s
- Frame scheduler loop: ${frame.count} fake retained renders

## Budgets vs measured

| Metric | Budget | Measured | Status | Notes |
|---|---:|---:|---|---|
| Cold start to first ANSI frame | < 200ms post-Pi-boot | ${formatMs(cold.coldStartMs)} | ${passFail(coldPass)} | Measured from \`./bin/sumocode.sh\` process spawn, so includes Pi startup. |
| RSS at idle after ${(IDLE_STEADY_MS / 1000).toFixed(1)}s | < 150 MiB | ${cold.idleRssBytes === undefined ? "unavailable" : formatMiB(cold.idleRssBytes)} | ${passFail(idlePass)} | Child process RSS sampled with \`ps\` from the PTY-spawned app. |
| Frame render p50 | 16.7ms for 60fps | ${formatMs(frame.p50Ms)} | ${passFail(frame.p50Ms < 16.7)} | Synthetic retained render + diff path. |
| Frame render p95 | 16.7ms target / 33.3ms acceptable | ${formatMs(frame.p95Ms)} | ${framePass ? "PASS" : frameAcceptable ? "WARN" : "MISS"} | Max ${formatMs(frame.maxMs)}. |
| RSS after streaming ${streaming.chunks} chunks | < 300 MiB | ${formatMiB(streaming.finalRssBytes)} final / ${formatMiB(streaming.peakRssBytes)} peak | ${passFail(streamingPass)} | In-process retained ChatPager streaming simulation. |
| Streaming render p95 | 16.7ms target / 33.3ms acceptable | ${formatMs(streaming.renderP95Ms)} | ${streaming.renderP95Ms < 16.7 ? "PASS" : streaming.renderP95Ms < 33.3 ? "WARN" : "MISS"} | ${streaming.renderCount} coalesced streaming renders. |

## P0/P1 misses

${missLines.join("\n")}

## Streaming RSS samples

| Elapsed | Label | RSS |
|---:|---|---:|
${sampleRows}

## Recommendations

1. Split cold-start timing into Pi boot, extension binding, and first sumo-tui retained frame. The current cold-start number intentionally measures the daily-driver command path, not just renderer boot.
2. Keep the ChatPager virtualization cap at 200 rendered messages; the streaming RSS sample should remain far below the 300 MiB long-session ceiling.
3. If frame p95 regresses above 16.7ms, profile Yoga layout and \`CellBuffer.clone()\` first — they are exercised on every retained frame.
`;
}

async function main() {
	console.log("[sumo-tui bench] cold start + idle RSS...");
	const cold = await measureColdStartAndIdle();
	console.log(`[sumo-tui bench] cold start ${formatMs(cold.coldStartMs)}, idle RSS ${cold.idleRssBytes === undefined ? "unavailable" : formatMiB(cold.idleRssBytes)}`);

	console.log(`[sumo-tui bench] frame scheduler (${FRAME_COUNT} renders)...`);
	const frame = await measureFrameScheduler();
	console.log(`[sumo-tui bench] frame p50 ${formatMs(frame.p50Ms)}, p95 ${formatMs(frame.p95Ms)}`);

	console.log(`[sumo-tui bench] streaming RSS (${STREAM_CHUNKS} chunks over ${STREAM_SECONDS}s)...`);
	const streaming = await measureStreamingRss();
	console.log(`[sumo-tui bench] streaming RSS final ${formatMiB(streaming.finalRssBytes)}, peak ${formatMiB(streaming.peakRssBytes)}`);

	await mkdir(dirname(OUT_PATH), { recursive: true });
	await writeFile(OUT_PATH, buildMarkdown({ cold, frame, streaming }), "utf8");
	console.log(`[sumo-tui bench] wrote ${OUT_PATH}`);
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
