#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn as spawnPty } from "node-pty";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const OUT_PATH = join(ROOT, "docs", "perf", "startup.json");
const SUMMARY_PATH = join(ROOT, "docs", "perf", "startup.md");
const RUNS = Math.max(1, Number.parseInt(process.env.SUMOCODE_STARTUP_PERF_RUNS ?? "5", 10));
const TIMEOUT_MS = Math.max(1000, Number.parseInt(process.env.SUMOCODE_STARTUP_PERF_TIMEOUT_MS ?? "15000", 10));

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
	const durations = samples.map((sample) => sample.durationMs);
	return { label, samples, avgMiddleMs: round(middleAverage(durations)), minMs: round(Math.min(...durations)), maxMs: round(Math.max(...durations)) };
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
					setTimeout(() => child.kill("SIGKILL"), 750).unref?.();
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
	const durations = samples.map((sample) => sample.durationMs);
	return { label: "first-frame", samples, avgMiddleMs: round(middleAverage(durations)), minMs: round(Math.min(...durations)), maxMs: round(Math.max(...durations)) };
}

function markdown(report) {
	const rows = report.measurements.map((measurement) => `| ${measurement.label} | ${measurement.avgMiddleMs}ms | ${measurement.minMs}ms | ${measurement.maxMs}ms | ${measurement.samples.length} |`);
	return `# SumoCode startup perf snapshot\n\nReport-only startup measurements for the current checkout. These numbers are intentionally not CI gates; use them to compare phase-by-phase deltas.\n\n- commit: \`${report.commit}\`\n- runs: ${report.runs}\n- generated: ${report.generatedAt}\n\n| Measurement | Avg middle runs | Min | Max | Runs |\n| --- | ---: | ---: | ---: | ---: |\n${rows.join("\n")}\n`;
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
		await measureProcess("print-mode", join(ROOT, "bin", "sumocode.sh"), ["--offline", "--no-extensions", "--no-session", "--print", "hello"]),
		await measureFirstFrame(),
	];
	const report = { generatedAt: new Date().toISOString(), commit, runs: RUNS, measurements };
	await mkdir(dirname(OUT_PATH), { recursive: true });
	await writeFile(OUT_PATH, `${JSON.stringify(report, null, 2)}\n`);
	await writeFile(SUMMARY_PATH, markdown(report));
	console.log(markdown(report));
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
