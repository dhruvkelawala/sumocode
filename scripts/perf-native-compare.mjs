#!/usr/bin/env node
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { cpus, platform, arch, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import xterm from "@xterm/headless";
import { spawn as spawnPty } from "node-pty";
import { readNativeArtifactIdentity } from "./lib/native-artifact.mjs";
import { resetFixture } from "./perf-startup-compare.mjs";

const DEFAULT_SAMPLES = 15;
const DEFAULT_BASELINE_RECORD = join(resolve(dirname(fileURLToPath(import.meta.url)), ".."), "docs/perf/adoption-baseline.json");
const SAMPLE_TIMEOUT_MS = 30_000;
const FLAGS = Object.freeze(["--offline", "--no-extensions", "--no-session", "--approve"]);
const REQUIRED_EVENTS = Object.freeze(["terminal_index_ready", "editor_ready", "hydration_committed", "command_ready"]);
const EDIT_SENTINEL = "native-perf-edit-sentinel";
const execFileAsync = promisify(execFile);

function usage() {
	return `Usage: node scripts/perf-native-compare.mjs --baseline <archive> --candidate <archive> [options]\n\nOptions:\n  --baseline <dir>       clean native archive used as the fixed baseline\n  --candidate <dir>      clean native archive being evaluated\n  --fixture-count <n>    settled terminal records (default: 0)\n  --out <dir>            new report files (default: private temporary directory)\n  -h, --help             show this help\n\nEvery comparison collects exactly ${DEFAULT_SAMPLES} samples per artifact.\n`;
}

function positiveInteger(value, flag) {
	if (!/^\d+$/.test(value ?? "")) throw new Error(`${flag} requires a positive integer`);
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${flag} requires a positive integer`);
	return parsed;
}

export function nativeCompareOptions(argv) {
	const options = { fixtureCount: 0 };
	for (let index = argv[0] === "--" ? 1 : 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "-h" || arg === "--help") return { ...options, help: true };
		const value = argv[index + 1];
		if (["--baseline", "--candidate", "--fixture-count", "--out"].includes(arg) && value === undefined) throw new Error(`${arg} requires a value`);
		switch (arg) {
			case "--baseline": options.baselineDir = resolve(value); index += 1; break;
			case "--candidate": options.candidateDir = resolve(value); index += 1; break;
			case "--fixture-count": options.fixtureCount = value === "0" ? 0 : positiveInteger(value, arg); index += 1; break;
			case "--out": options.outDir = resolve(value); index += 1; break;
			default: throw new Error(`unknown option: ${arg}`);
		}
	}
	if (!options.help && !options.baselineDir) throw new Error("--baseline is required");
	if (!options.help && !options.candidateDir) throw new Error("--candidate is required");
	return options;
}

async function readEvents(path) {
	try {
		return (await readFile(path, "utf8")).split("\n").filter(Boolean).flatMap((line) => {
			try {
				const value = JSON.parse(line);
				// oxlint-disable-next-line anti-slop/no-runtime-typeof -- parsed diagnostics JSONL boundary
				return value && typeof value === "object" ? [value] : [];
			} catch { return []; }
		});
	} catch { return []; }
}

function isolatedEnv(agentDir, diagFile) {
	const env = {};
	for (const key of ["PATH", "LANG", "LC_ALL", "TZ", "SHELL"]) {
		// oxlint-disable-next-line anti-slop/no-runtime-typeof -- ProcessEnv child-process boundary
		if (typeof process.env[key] === "string") env[key] = process.env[key];
	}
	return {
		...env,
		HOME: join(agentDir, "home"),
		PI_CODING_AGENT_DIR: agentDir,
		SUMOCODE_STATE_DIR: join(agentDir, "sumocode-state"),
		SUMOCODE_CONFIG_DIR: join(agentDir, "config"),
		SUMO_TUI_DIAG_FILE: diagFile,
		SUMOCODE_PUBLIC_STARTUP_DIAGNOSTICS: "1",
		SUMO_TUI_DEBUG: "0",
		PI_BIN: "",
		TMPDIR: join(agentDir, "tmp"),
		TERM: "xterm-256color",
	};
}

function signalTree(child, signal) {
	try { process.kill(-child.pid, signal); }
	catch (error) { if (error?.code !== "ESRCH") throw error; }
}

function treeAlive(pid) {
	try { process.kill(-pid, 0); return true; }
	catch { return false; }
}

async function waitForTreeExit(pid, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	while (treeAlive(pid) && Date.now() < deadline) await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
}

async function editorProbe(output) {
	const terminal = new xterm.Terminal({ cols: 100, rows: 30, allowProposedApi: true, scrollback: 0 });
	try {
		await new Promise((resolveWrite) => terminal.write(output, resolveWrite));
		const buffer = terminal.buffer.active;
		const line = buffer.getLine(buffer.cursorY)?.translateToString(true) ?? "";
		const sentinelStart = line.indexOf(EDIT_SENTINEL);
		return sentinelStart >= 0 && buffer.cursorX >= sentinelStart + EDIT_SENTINEL.length;
	} finally { terminal.dispose(); }
}

function sampleFailure({ childPid, exitedBeforeShutdown, aliveBeforeShutdown, missingEvents, fixtureMatches, snapshotCount, editorResponsive, editorTs, commandTs }) {
	if (treeAlive(childPid)) return "shutdown-failed";
	if (exitedBeforeShutdown || !aliveBeforeShutdown) return "process-failed";
	if (missingEvents.length > 0) return `missing-events:${missingEvents.join(",")}`;
	if (!fixtureMatches) return `fixture-mismatch:${String(snapshotCount)}`;
	if (!editorResponsive) return "editor-probe-failed";
	if (!Number.isFinite(editorTs) || !Number.isFinite(commandTs)) return "invalid-timestamp";
	if (commandTs < editorTs) return "event-order";
	return "invalid-sample";
}

async function runSampleProcess({ artifact, agentDir, diagFile, fixtureCount, index }) {
	await resetFixture(agentDir, fixtureCount);
	const startedAt = Date.now();
	const child = spawnPty(join(artifact.artifactDir, "bin/sumocode"), [...FLAGS], {
		name: "xterm-256color", cols: 100, rows: 30, cwd: join(agentDir, "project"), env: isolatedEnv(agentDir, diagFile),
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
			if (await editorProbe(output)) { editorResponsive = true; break; }
			await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
		}
	}
	const exitedBeforeShutdown = exited;
	const aliveBeforeShutdown = treeAlive(child.pid);
	if (aliveBeforeShutdown) signalTree(child, "SIGINT");
	await waitForTreeExit(child.pid, 750);
	if (treeAlive(child.pid)) signalTree(child, "SIGTERM");
	await waitForTreeExit(child.pid, 250);
	if (treeAlive(child.pid)) signalTree(child, "SIGKILL");
	await waitForTreeExit(child.pid, 250);

	const terminalReady = byName.get("terminal_index_ready");
	const editorTs = byName.get("editor_ready")?.ts;
	const commandTs = byName.get("command_ready")?.ts;
	const fixtureMatches = terminalReady?.snapshotCount === fixtureCount;
	const ok = aliveBeforeShutdown && !exitedBeforeShutdown && !treeAlive(child.pid)
		&& missingEvents.length === 0 && fixtureMatches && editorResponsive
		&& Number.isFinite(editorTs) && Number.isFinite(commandTs) && commandTs >= editorTs;
	return ok
		? {
				index, ok: true,
				editorReadyMs: editorTs - startedAt,
				commandReadyMs: commandTs - startedAt,
				editorToCommandGapMs: commandTs - editorTs,
				terminalIndexMs: terminalReady.durationMs,
			}
		: {
				index,
				ok: false,
				failure: sampleFailure({
					childPid: child.pid,
					exitedBeforeShutdown,
					aliveBeforeShutdown,
					missingEvents,
					fixtureMatches,
					snapshotCount: terminalReady?.snapshotCount,
					editorResponsive,
					editorTs,
					commandTs,
				}),
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
	const values = samples.flatMap((sample) => sample.ok && Number.isFinite(sample[field]) ? [sample[field]] : []);
	const center = median(values);
	const mad = center === null ? null : median(values.map((value) => Math.abs(value - center)));
	return { medianMs: center === null ? null : round(center), madMs: mad === null ? null : round(mad), values: values.map(round) };
}

function summarizeArm(samples) {
	return {
		failures: samples.filter((sample) => !sample.ok).length,
		editorReady: stats(samples, "editorReadyMs"),
		commandReady: stats(samples, "commandReadyMs"),
		editorToCommandGap: stats(samples, "editorToCommandGapMs"),
		terminalIndex: stats(samples, "terminalIndexMs"),
		samples,
	};
}

/** Deterministic native adoption policy; wall-clock collection stays outside this function. */
export function evaluateNativeGate(report) {
	const baseline = summarizeArm(report.arms.baseline.samples);
	const candidate = summarizeArm(report.arms.candidate.samples);
	const collectionComplete = report.samplesPerArm === DEFAULT_SAMPLES
		&& report.arms.baseline.samples.length === DEFAULT_SAMPLES
		&& report.arms.candidate.samples.length === DEFAULT_SAMPLES
		&& baseline.failures === 0 && candidate.failures === 0
		&& [baseline, candidate].every((arm) => [arm.editorReady, arm.commandReady, arm.editorToCommandGap]
			.every((metric) => metric.values.length === DEFAULT_SAMPLES && Number.isFinite(metric.medianMs)));
	const failedChecks = [];
	if (!collectionComplete) failedChecks.push("collection");
	const editorLimitMs = baseline.editorReady.medianMs === null || baseline.editorReady.madMs === null
		? null : round(baseline.editorReady.medianMs + baseline.editorReady.madMs);
	if (collectionComplete && candidate.editorReady.medianMs > editorLimitMs) failedChecks.push("editor-ready");
	if (collectionComplete && candidate.commandReady.medianMs > baseline.commandReady.medianMs) failedChecks.push("command-ready");
	if (collectionComplete && candidate.editorToCommandGap.medianMs > baseline.editorToCommandGap.medianMs) failedChecks.push("editor-to-command-gap");
	return {
		verdict: failedChecks.length === 0 ? "passed" : "failed",
		failedChecks,
		limits: {
			editorReadyMs: editorLimitMs,
			commandReadyMs: baseline.commandReady.medianMs,
			editorToCommandGapMs: baseline.editorToCommandGap.medianMs,
		},
		observed: {
			editorReadyMs: candidate.editorReady.medianMs,
			commandReadyMs: candidate.commandReady.medianMs,
			editorToCommandGapMs: candidate.editorToCommandGap.medianMs,
		},
	};
}

function reportIdentity(identity) {
	return { sourceCommit: identity.sourceCommit, sourceClean: identity.sourceClean, artifactSha256: identity.artifactSha256 };
}

function markdown(report) {
	const row = (name) => {
		const arm = report.arms[name];
		return `| ${name} | \`${report.artifacts[name].sourceCommit.slice(0, 12)}\` | \`${report.artifacts[name].artifactSha256.slice(0, 12)}\` | ${arm.editorReady.medianMs} ± ${arm.editorReady.madMs} | ${arm.commandReady.medianMs} ± ${arm.commandReady.madMs} | ${arm.editorToCommandGap.medianMs} ± ${arm.editorToCommandGap.madMs} | ${arm.failures} |`;
	};
	return `# Native startup regression comparison\n\n- samples per artifact: ${report.samplesPerArm}\n- fixture records: ${report.fixtureCount}\n- execution: alternating baseline/candidate artifacts under one isolated fixture environment\n- platform: ${report.machine.platform}-${report.machine.arch}\n\n| arm | source | artifact | editor-ready median ± MAD | command-ready median ± MAD | editor→command median ± MAD | failures |\n| --- | --- | --- | ---: | ---: | ---: | ---: |\n${row("baseline")}\n${row("candidate")}\n\nGate: **${report.gate.verdict.toUpperCase()}**${report.gate.failedChecks.length > 0 ? ` — ${report.gate.failedChecks.join(", ")}` : ""}.\n`;
}

async function prepareReportDirectory(outDir, fixtureCount) {
	const target = outDir ?? await mkdtemp(join(tmpdir(), `sumocode-native-regression-${fixtureCount}-`));
	await mkdir(target, { recursive: true, mode: 0o700 });
	const entries = new Set(await readdir(target));
	for (const name of ["results.json", "report.md"]) {
		if (entries.has(name)) throw new Error(`--out already contains ${name}; refusing to overwrite it`);
	}
	return target;
}

async function defaultMachineMetadata() {
	const bun = (await execFileAsync(process.env.BUN_BIN ?? "bun", ["--version"], { encoding: "utf8" })).stdout.trim();
	return { platform: platform(), arch: arch(), cpu: `${cpus()[0]?.model ?? "unknown"} × ${cpus().length}`, bun };
}

async function readBaselineIdentity() {
	let policy;
	try { policy = JSON.parse(await readFile(DEFAULT_BASELINE_RECORD, "utf8")); }
	catch (error) { throw new Error(`failed to read pinned baseline record: ${error instanceof Error ? error.message : String(error)}`); }
	if (!/^[0-9a-f]{40}$/.test(policy.baseline?.sourceCommit ?? "")) throw new Error("pinned baseline record is invalid");
	return { sourceCommit: policy.baseline.sourceCommit };
}

export async function runNativeComparison(options, dependencies = {}) {
	const outDir = await prepareReportDirectory(options.outDir, options.fixtureCount);
	const readArtifact = dependencies.readArtifact ?? readNativeArtifactIdentity;
	const [baselineArtifact, candidateArtifact, pinnedBaseline] = await Promise.all([
		readArtifact(options.baselineDir),
		readArtifact(options.candidateDir),
		(dependencies.readBaselineIdentity ?? readBaselineIdentity)(),
	]);
	if (baselineArtifact.sourceCommit !== pinnedBaseline.sourceCommit) {
		throw new Error("baseline artifact does not match the pinned baseline source");
	}
	if (baselineArtifact.artifactSha256 === candidateArtifact.artifactSha256) {
		throw new Error("comparison requires two distinct native artifacts");
	}
	const machine = await (dependencies.machineMetadata ?? defaultMachineMetadata)();
	const agentDir = await mkdtemp(join(tmpdir(), "sumocode-native-regression-agent-"));
	const raw = { baseline: [], candidate: [] };
	const runSample = dependencies.runSample ?? runSampleProcess;
	try {
		for (let index = 0; index < DEFAULT_SAMPLES; index += 1) {
			const order = index % 2 === 0 ? ["baseline", "candidate"] : ["candidate", "baseline"];
			for (const arm of order) {
				const diagFile = join(outDir, `${String(index).padStart(2, "0")}-${arm}.jsonl`);
				const artifact = arm === "baseline" ? baselineArtifact : candidateArtifact;
				let sample;
				try {
					sample = await runSample({ arm, artifact, agentDir, diagFile, fixtureCount: options.fixtureCount, index });
				} catch (error) {
					sample = { index, ok: false, failure: "harness-error" };
					console.error(`[native regression] sample=${index + 1}/${DEFAULT_SAMPLES} arm=${arm} harness error: ${error instanceof Error ? error.message : String(error)}`);
				}
				raw[arm].push(sample);
				if (sample.ok) await rm(diagFile, { force: true });
				console.error(`[native regression] sample=${index + 1}/${DEFAULT_SAMPLES} arm=${arm} ${sample.ok ? "ok" : sample.failure}`);
			}
		}
		const report = {
			schemaVersion: 1,
			generatedAt: new Date().toISOString(),
			fixtureCount: options.fixtureCount,
			samplesPerArm: DEFAULT_SAMPLES,
			flags: [...FLAGS],
			artifacts: { baseline: reportIdentity(baselineArtifact), candidate: reportIdentity(candidateArtifact) },
			machine,
			arms: { baseline: summarizeArm(raw.baseline), candidate: summarizeArm(raw.candidate) },
		};
		report.gate = evaluateNativeGate({
			samplesPerArm: report.samplesPerArm,
			arms: { baseline: { samples: raw.baseline }, candidate: { samples: raw.candidate } },
		});
		await writeFile(join(outDir, "results.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600, flag: "wx" });
		await writeFile(join(outDir, "report.md"), markdown(report), { mode: 0o600, flag: "wx" });
		console.error(`[native regression] artifacts: ${outDir}`);
		return report;
	} finally {
		await rm(agentDir, { recursive: true, force: true });
	}
}

export async function main(argv = process.argv.slice(2)) {
	const options = nativeCompareOptions(argv);
	if (options.help) { console.log(usage()); return undefined; }
	const report = await runNativeComparison(options);
	console.log(markdown(report));
	if (report.gate.verdict !== "passed") throw new Error(`native startup regression: ${report.gate.failedChecks.join(", ")}`);
	return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch((error) => {
		console.error(`[native regression] failed: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	});
}
