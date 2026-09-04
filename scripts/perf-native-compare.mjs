#!/usr/bin/env node
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { cpus, platform, arch, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import xterm from "@xterm/headless";
import { spawn as spawnPty } from "node-pty";
import { resetFixture } from "./perf-startup-compare.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_SAMPLES = 15;
const SAMPLE_TIMEOUT_MS = 30_000;
const EDITOR_IMPROVEMENT_GATE_MS = 250;
const FLAGS = Object.freeze(["--offline", "--no-extensions", "--no-session", "--approve"]);
const REQUIRED_EVENTS = Object.freeze(["terminal_index_ready", "editor_ready", "hydration_committed", "command_ready"]);
const EDIT_SENTINEL = "native-perf-edit-sentinel";
const execFileAsync = promisify(execFile);

function usage() {
	return `Usage: node scripts/perf-native-compare.mjs [options]\n\nOptions:\n  --samples <count>       samples per arm (default: ${DEFAULT_SAMPLES})\n  --fixture-count <count> settled terminal records (default: 0)\n  --out <dir>             report directory (default: private temporary directory)\n  -h, --help              show this help\n`;
}

function positiveInteger(value, flag) {
	if (!/^\d+$/.test(value ?? "")) throw new Error(`${flag} requires a positive integer`);
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${flag} requires a positive integer`);
	return parsed;
}

export function nativeCompareOptions(argv) {
	const options = { samples: DEFAULT_SAMPLES, fixtureCount: 0 };
	for (let index = argv[0] === "--" ? 1 : 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "-h" || arg === "--help") return { ...options, help: true };
		const value = argv[index + 1];
		if (["--samples", "--fixture-count", "--out"].includes(arg) && value === undefined) throw new Error(`${arg} requires a value`);
		switch (arg) {
			case "--samples": options.samples = positiveInteger(value, arg); index += 1; break;
			case "--fixture-count": options.fixtureCount = value === "0" ? 0 : positiveInteger(value, arg); index += 1; break;
			case "--out": options.outDir = resolve(value); index += 1; break;
			default: throw new Error(`unknown option: ${arg}`);
		}
	}
	return options;
}

function nativeArchive() {
	const pkg = JSON.parse(requireText(join(ROOT, "package.json")));
	const tag = `${process.platform === "darwin" ? "macos" : process.platform}-${process.arch}`;
	return join(ROOT, "dist/native", `sumocode-${pkg.version}-${tag}`);
}

function requireText(path) {
	// This startup-only read stays synchronous so option/build failures surface
	// before any fixture or PTY process is created.
	return readFileSync(path, "utf8");
}

async function readEvents(path) {
	try {
		return (await readFile(path, "utf8")).split("\n").filter(Boolean).flatMap((line) => {
			try {
				const value = JSON.parse(line);
				// oxlint-disable-next-line anti-slop/no-runtime-typeof -- parsed diagnostics JSONL boundary
				return value && typeof value === "object" ? [value] : [];
			} catch {
				return [];
			}
		});
	} catch {
		return [];
	}
}

function isolatedEnv(agentDir, diagFile, arm) {
	const env = {};
	for (const key of ["PATH", "LANG", "LC_ALL", "TZ", "SHELL"]) {
		// oxlint-disable-next-line anti-slop/no-runtime-typeof -- ProcessEnv child-process boundary
		if (typeof process.env[key] === "string") env[key] = process.env[key];
	}
	Object.assign(env, {
		HOME: join(agentDir, "home"),
		PI_CODING_AGENT_DIR: agentDir,
		SUMOCODE_STATE_DIR: join(agentDir, "sumocode-state"),
		SUMOCODE_CONFIG_DIR: join(agentDir, "config"),
		SUMO_TUI_DIAG_FILE: diagFile,
		SUMOCODE_PUBLIC_STARTUP_DIAGNOSTICS: "1",
		SUMO_TUI_DEBUG: "0",
		TMPDIR: join(agentDir, "tmp"),
		TERM: "xterm-256color",
	});
	if (arm === "native") {
		env.PI_BIN = "";
	} else {
		env.PI_BIN = join(ROOT, "node_modules/.bin/pi");
		env.NODE_COMPILE_CACHE = join(agentDir, "compile-cache");
		env.NODE_OPTIONS = `--require "${join(ROOT, "scripts/startup-diagnostics-preload.cjs")}"`;
		env.SUMOCODE_HOST_BUNDLE = arm === "node-bundle" ? "1" : "0";
		env.SUMOCODE_EXTENSION_BUNDLE = arm === "node-bundle" ? "1" : "0";
	}
	return env;
}

function armCommand(arm) {
	return arm === "native" ? join(nativeArchive(), "bin/sumocode") : join(ROOT, "bin/sumocode.sh");
}

function signalTree(child, signal) {
	try {
		process.kill(-child.pid, signal);
	} catch (error) {
		if (error?.code !== "ESRCH") throw error;
	}
}

function treeAlive(pid) {
	try {
		process.kill(-pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitForTreeExit(pid, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	while (treeAlive(pid) && Date.now() < deadline) await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
}

async function replay(output) {
	const terminal = new xterm.Terminal({ cols: 100, rows: 30, allowProposedApi: true, scrollback: 0 });
	await new Promise((resolveWrite) => terminal.write(output, resolveWrite));
	return terminal;
}

async function editorProbe(output) {
	const terminal = await replay(output);
	try {
		const buffer = terminal.buffer.active;
		const cursorY = buffer.cursorY;
		const cursorX = buffer.cursorX;
		const line = buffer.getLine(cursorY)?.translateToString(true) ?? "";
		const sentinelStart = line.indexOf(EDIT_SENTINEL);
		return sentinelStart >= 0 && cursorX >= sentinelStart + EDIT_SENTINEL.length;
	} finally {
		terminal.dispose();
	}
}

async function runSample({ arm, agentDir, diagFile, fixtureCount, index }) {
	await resetFixture(agentDir, fixtureCount);
	const startedAt = Date.now();
	const child = spawnPty(armCommand(arm), [...FLAGS], {
		name: "xterm-256color",
		cols: 100,
		rows: 30,
		cwd: join(agentDir, "project"),
		env: isolatedEnv(agentDir, diagFile, arm),
	});
	let output = "";
	let exited = false;
	child.onData((data) => {
		output += data;
		if (output.length > 1_000_000) output = output.slice(-500_000);
	});
	child.onExit(() => { exited = true; });

	const deadline = Date.now() + SAMPLE_TIMEOUT_MS;
	let events = [];
	while (!exited && Date.now() < deadline) {
		events = await readEvents(diagFile);
		if (REQUIRED_EVENTS.every((name) => events.some((event) => event.event === name))) break;
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
	}
	const byName = new Map(events.map((event) => [event.event, event]));
	const missingEvents = REQUIRED_EVENTS.filter((name) => !byName.has(name));
	let editorResponsive = false;
	if (!exited && missingEvents.length === 0) {
		child.write(EDIT_SENTINEL);
		const editDeadline = Date.now() + 3_000;
		while (!exited && Date.now() < editDeadline) {
			if (await editorProbe(output)) {
				editorResponsive = true;
				break;
			}
			await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
		}
	}
	// Snapshot natural exit immediately before harness shutdown. The exit
	// callback will (correctly) fire after SIGINT and must not retroactively
	// classify a clean sample as process-failed.
	const exitedBeforeShutdown = exited;
	const aliveBeforeShutdown = treeAlive(child.pid);
	if (aliveBeforeShutdown) signalTree(child, "SIGINT");
	await waitForTreeExit(child.pid, 750);
	if (treeAlive(child.pid)) signalTree(child, "SIGTERM");
	await waitForTreeExit(child.pid, 250);
	if (treeAlive(child.pid)) signalTree(child, "SIGKILL");
	await waitForTreeExit(child.pid, 250);

	const terminalReady = byName.get("terminal_index_ready");
	const fixtureMatches = terminalReady?.snapshotCount === fixtureCount;
	const editorTs = byName.get("editor_ready")?.ts;
	const commandTs = byName.get("command_ready")?.ts;
	const ok = aliveBeforeShutdown
		&& !exitedBeforeShutdown
		&& !treeAlive(child.pid)
		&& missingEvents.length === 0
		&& fixtureMatches
		&& editorResponsive
		&& Number.isFinite(editorTs)
		&& Number.isFinite(commandTs);
	return ok
		? {
			index, arm, ok: true,
			editorReadyMs: editorTs - startedAt,
			commandReadyMs: commandTs - startedAt,
			terminalIndexMs: terminalReady.durationMs,
		}
		: {
			index, arm, ok: false,
			failure: treeAlive(child.pid) ? "shutdown-failed"
				: exitedBeforeShutdown || !aliveBeforeShutdown ? "process-failed"
					: missingEvents.length > 0 ? `missing-events:${missingEvents.join(",")}`
						: !fixtureMatches ? `fixture-mismatch:${String(terminalReady?.snapshotCount)}`
							: !editorResponsive ? "editor-probe-failed" : "invalid-timestamp",
		};
}

function round(value) {
	return Math.round(value * 100) / 100;
}

function median(values) {
	if (values.length === 0) return null;
	const sorted = [...values].sort((left, right) => left - right);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function stats(samples, field) {
	const values = samples.flatMap((sample) => sample.ok ? [sample[field]] : []);
	const center = median(values);
	const mad = center === null ? null : median(values.map((value) => Math.abs(value - center)));
	return {
		medianMs: center === null ? null : round(center),
		madMs: mad === null ? null : round(mad),
		failures: samples.length - values.length,
		values: values.map(round),
	};
}

export function evaluateNativeGate(report) {
	const baseline = report.arms["node-bundle"];
	const native = report.arms.native;
	const failures = Object.values(report.arms).reduce((count, arm) => count + arm.failures, 0);
	const mediansValid = [
		baseline.commandReady.medianMs,
		native.commandReady.medianMs,
		baseline.editorReady.medianMs,
		native.editorReady.medianMs,
	].every(Number.isFinite);
	const editorImprovementMs = mediansValid ? baseline.editorReady.medianMs - native.editorReady.medianMs : 0;
	const commandRegressionMs = mediansValid ? native.commandReady.medianMs - baseline.commandReady.medianMs : 0;
	const improved = mediansValid
		&& failures === 0
		&& editorImprovementMs >= EDITOR_IMPROVEMENT_GATE_MS
		&& commandRegressionMs <= 0;
	return {
		verdict: improved ? "improved" : "failed",
		editorImprovementMs: round(editorImprovementMs),
		commandRegressionMs: round(commandRegressionMs),
		zeroFailures: failures === 0,
		reason: improved
			? `native editor-ready improved ${round(editorImprovementMs)}ms vs Node bundles; command-ready changed ${round(commandRegressionMs)}ms`
			: `requires >=${EDITOR_IMPROVEMENT_GATE_MS}ms editor improvement, no command regression, and zero failures; observed editor ${round(editorImprovementMs)}ms, command ${round(commandRegressionMs)}ms, failures ${failures}`,
	};
}

async function gitSha() {
	return (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" })).stdout.trim();
}

async function bunVersion() {
	const candidate = process.env.BUN_BIN ?? "bun";
	return (await execFileAsync(candidate, ["--version"], { encoding: "utf8" })).stdout.trim();
}

function markdown(report) {
	const rows = ["dev-source", "node-bundle", "native"].map((name) => {
		const arm = report.arms[name];
		return `| ${name} | ${arm.commandReady.medianMs} ± ${arm.commandReady.madMs} | ${arm.editorReady.medianMs} ± ${arm.editorReady.madMs} | ${arm.failures} |`;
	}).join("\n");
	return `# Native startup comparison\n\n- commit: \`${report.commit}\`\n- platform: ${report.machine.platform}-${report.machine.arch}\n- CPU: ${report.machine.cpu}\n- Bun: ${report.machine.bun}\n- fixture records: ${report.fixtureCount}\n- samples per arm: ${report.samplesPerArm}\n- execution: sequential, alternating dev source / Node bundle / native artifacts\n\n| arm | command-ready median ± MAD (ms) | editor-ready median ± MAD (ms) | failures |\n| --- | ---: | ---: | ---: |\n${rows}\n\nGate: **${report.gate.verdict}** — ${report.gate.reason}.\n`;
}

export async function runNativeComparison(options) {
	const archive = nativeArchive();
	for (const path of [
		join(archive, "bin/sumocode"),
		join(ROOT, "dist/host/sumo-rpc-host.bundle.mjs"),
		join(ROOT, "dist/extension/sumocode-extension.bundle.mjs"),
	]) {
		try { await chmod(path, 0o755); } catch { throw new Error(`required artifact missing: ${path}; run pnpm build:bundles && pnpm build:native`); }
	}
	const outDir = options.outDir ?? await mkdtemp(join(tmpdir(), `sumocode-native-perf-${options.fixtureCount}-`));
	await mkdir(outDir, { recursive: true, mode: 0o700 });
	const agentDir = join(outDir, "fixture-agent");
	const raw = { "dev-source": [], "node-bundle": [], native: [] };
	const armOrders = [
		["dev-source", "node-bundle", "native"],
		["native", "node-bundle", "dev-source"],
	];
	try {
		for (let index = 0; index < options.samples; index += 1) {
			for (const arm of armOrders[index % armOrders.length]) {
				const diagFile = join(outDir, `${String(index).padStart(2, "0")}-${arm}.jsonl`);
				const sample = await runSample({ arm, agentDir, diagFile, fixtureCount: options.fixtureCount, index });
				raw[arm].push(sample);
				console.error(`[native perf] fixture=${options.fixtureCount} sample=${index + 1}/${options.samples} arm=${arm} ${sample.ok ? "ok" : sample.failure}`);
			}
		}
		const arms = Object.fromEntries(Object.entries(raw).map(([name, samples]) => [name, {
			failures: samples.filter((sample) => !sample.ok).length,
			editorReady: stats(samples, "editorReadyMs"),
			commandReady: stats(samples, "commandReadyMs"),
			terminalIndex: stats(samples, "terminalIndexMs"),
			samples,
		}]));
		const report = {
			commit: await gitSha(),
			generatedAt: new Date().toISOString(),
			fixtureCount: options.fixtureCount,
			samplesPerArm: options.samples,
			machine: {
				platform: platform(), arch: arch(),
				cpu: `${cpus()[0]?.model ?? "unknown"} × ${cpus().length}`,
				node: process.version,
				bun: await bunVersion(),
			},
			arms,
		};
		report.gate = evaluateNativeGate(report);
		await writeFile(join(outDir, "results.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
		await writeFile(join(outDir, "report.md"), markdown(report), { mode: 0o600 });
		console.error(`[native perf] artifacts: ${outDir}`);
		return report;
	} finally {
		await rm(agentDir, { recursive: true, force: true });
	}
}

export async function main(argv = process.argv.slice(2)) {
	const options = nativeCompareOptions(argv);
	if (options.help) {
		console.log(usage());
		return undefined;
	}
	const report = await runNativeComparison(options);
	console.log(markdown(report));
	if (report.gate.verdict !== "improved") throw new Error(report.gate.reason);
	return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch((error) => {
		console.error(`[native perf] failed: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	});
}
