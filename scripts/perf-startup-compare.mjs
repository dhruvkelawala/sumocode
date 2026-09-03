#!/usr/bin/env node
import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, open, readFile, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { cpus, platform, arch, tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { spawn as spawnPty } from "node-pty";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_SAMPLES = 15;
const DEFAULT_FIXTURE_COUNT = 1_800;
const SAMPLE_TIMEOUT_MS = 30_000;
const MIN_DIRECTIONAL_SAMPLES = 3;
const FLAGS = Object.freeze(["--offline", "--no-extensions", "--no-session"]);
const REQUIRED_EVENTS = Object.freeze([
	"process_preload_start",
	"host_import_ready",
	"rpc_child_ready",
	"terminal_index_start",
	"terminal_index_ready",
	"editor_ready",
	"hydration_committed",
	"command_ready",
]);
const METRICS = Object.freeze([
	{ name: "launcherMs", label: "launcher", group: "attributed" },
	{ name: "hostImportMs", label: "host import", group: "attributed" },
	{ name: "rpcChildReadyMs", label: "RPC child ready", group: "attributed" },
	{ name: "terminalIndexReadyMs", label: "terminal index ready", group: "targeted" },
	{ name: "editorReadyMs", label: "editor ready", group: "aggregate" },
	{ name: "hydrationCommittedMs", label: "hydration committed", group: "aggregate" },
	{ name: "commandReadyMs", label: "command ready", group: "aggregate" },
	{ name: "editorToCommandGapMs", label: "editor-to-command gap", group: "aggregate" },
]);
const execFileAsync = promisify(execFile);

function usage() {
	return `Usage: pnpm perf:startup:compare -- --base <ref> [options]\n\nOptions:\n  --candidate <ref>       candidate revision (default: HEAD)\n  --samples <count>       samples per arm (default: ${DEFAULT_SAMPLES})\n  --fixture-count <count> settled terminal records (default: ${DEFAULT_FIXTURE_COUNT})\n  --out <dir>             report directory (default: private temporary directory)\n  --keep-fixture          retain generated fixture state; worktrees are always removed\n  -h, --help              show this help\n`;
}

function positiveInteger(value, flag) {
	if (!/^\d+$/.test(value ?? "")) throw new Error(`${flag} requires a positive integer`);
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${flag} requires a positive integer`);
	return parsed;
}

/** Parse the public comparison CLI without consulting repository or operator state. */
export function startupCompareOptions(argv) {
	const options = { candidateRef: "HEAD", samples: DEFAULT_SAMPLES, fixtureCount: DEFAULT_FIXTURE_COUNT, keepFixture: false };
	for (let index = argv[0] === "--" ? 1 : 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "-h" || arg === "--help") return { ...options, help: true };
		if (arg === "--keep-fixture") {
			options.keepFixture = true;
			continue;
		}
		const value = argv[index + 1];
		if (["--base", "--candidate", "--samples", "--fixture-count", "--out"].includes(arg) && value === undefined) throw new Error(`${arg} requires a value`);
		switch (arg) {
			case "--base": options.baseRef = value; index += 1; break;
			case "--candidate": options.candidateRef = value; index += 1; break;
			case "--samples": options.samples = positiveInteger(value, arg); index += 1; break;
			case "--fixture-count": options.fixtureCount = positiveInteger(value, arg); index += 1; break;
			case "--out": options.outDir = resolve(value); index += 1; break;
			default: throw new Error(`unknown option: ${arg}`);
		}
	}
	if (!options.baseRef) throw new Error("--base is required");
	return options;
}

function pathInside(parent, child) {
	const rel = relative(resolve(parent), resolve(child));
	return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== "..");
}

async function assertOutOutsideCheckout(callerRoot, outDir) {
	// Create the user-requested report directory first, then compare real paths:
	// a --out that is (or points through a symlink at) the checkout must fail
	// before any report write can dirty it.
	await mkdir(outDir, { recursive: true });
	const [callerReal, outReal] = await Promise.all([realpath(callerRoot), realpath(outDir)]);
	if (pathInside(callerReal, outReal)) throw new Error("--out must be outside the compared checkout");
}

async function runGit(cwd, args) {
	const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
	return stdout.trim();
}

async function resolveRevision(callerRoot, ref) {
	const sha = await runGit(callerRoot, ["rev-parse", "--verify", `${ref}^{commit}`]);
	if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`git did not resolve ${ref} to an exact commit`);
	return sha;
}

async function assertClean(path) {
	if (await runGit(path, ["status", "--porcelain", "--untracked-files=all"])) throw new Error("startup comparison requires clean source checkouts");
}

async function runCleanupSteps(steps, message) {
	const failures = [];
	for (const step of steps) {
		try { await step(); } catch (error) { failures.push(error); }
	}
	if (failures.length > 0) throw new AggregateError(failures, message);
}

async function prepareWorktrees({ callerRoot, campaignDir, baselineSha, candidateSha }) {
	const baselineDir = join(campaignDir, "baseline");
	const candidateDir = join(campaignDir, "candidate");
	const added = [];
	const links = [];
	try {
		for (const [path, sha] of [[baselineDir, baselineSha], [candidateDir, candidateSha]]) {
			await runGit(callerRoot, ["worktree", "add", "--detach", path, sha]);
			added.push(path);
		}
		const dependencies = await realpath(join(callerRoot, "node_modules"));
		for (const path of added) {
			const link = join(path, "node_modules");
			await symlink(dependencies, link, "dir");
			links.push(link);
		}
	} catch (error) {
		const setupCleanup = [
			...links.splice(0).reverse().map((link) => () => unlink(link)),
			...added.splice(0).reverse().map((path) => () => runGit(callerRoot, ["worktree", "remove", "--force", path])),
		];
		try { await runCleanupSteps(setupCleanup, "startup comparison setup cleanup failed"); }
		catch (cleanupError) { throw new AggregateError([error, cleanupError], "startup comparison setup and cleanup failed"); }
		throw error;
	}
	return {
		baselineDir,
		candidateDir,
		unlinkDependencies: () => runCleanupSteps(
			links.splice(0).reverse().map((link) => () => unlink(link)),
			"failed to unlink comparison dependencies",
		),
		cleanup: () => runCleanupSteps(
			added.splice(0).reverse().map((path) => () => runGit(callerRoot, ["worktree", "remove", "--force", path])),
			"failed to remove detached comparison worktrees",
		),
	};
}

async function privateDirectory(path) {
	await mkdir(path, { recursive: true, mode: 0o700 });
	await chmod(path, 0o700);
}

async function writePrivate(path, contents) {
	await writeFile(path, contents, { mode: 0o600 });
	await chmod(path, 0o600);
}

/** Rebuild one deterministic, operator-free terminal store before each timed launch. */
async function resetFixture(agentDir, recordCount) {
	await rm(agentDir, { recursive: true, force: true });
	const store = join(agentDir, "state", "sumocode-terminals");
	await Promise.all([
		privateDirectory(store),
		privateDirectory(join(agentDir, "sumocode-state")),
		privateDirectory(join(agentDir, "config")),
		privateDirectory(join(agentDir, "home")),
		privateDirectory(join(agentDir, "tmp")),
		privateDirectory(join(agentDir, "project")),
	]);
	for (let index = 0; index < recordCount; index += 1) {
		const suffix = String(index).padStart(6, "0");
		const id = `term-fixture-${suffix}`;
		const createdAt = 1_700_000_000_000 + index;
		const directory = join(store, `${id}-${createdAt}`);
		const logFile = join(directory, "output.log");
		await privateDirectory(directory);
		await Promise.all([
			writePrivate(logFile, "fixture output\n"),
			writePrivate(join(directory, "meta.json"), `${JSON.stringify({
				schemaVersion: 4,
				revision: 1,
				id,
				ownerSessionId: "fixture-owner",
				command: "printf fixture",
				cwd: "/fixture",
				title: "fixture terminal",
				status: "completed",
				completionPolicy: "passive",
				createdAt,
				updatedAt: createdAt + 1,
				settledAt: createdAt + 1,
				exitCode: 0,
				deliveryState: "delivered",
				completionId: `fixture-completion-${suffix}`,
				logFile,
			})}\n`),
		]);
	}
}

async function readEvents(path) {
	try {
		return (await readFile(path, "utf8")).split("\n").filter(Boolean).flatMap((line) => {
			try {
				const event = JSON.parse(line);
				// oxlint-disable-next-line anti-slop/no-runtime-typeof -- parsed diagnostics JSONL boundary
				return event && typeof event === "object" ? [event] : [];
			} catch {
				return [];
			}
		});
	} catch {
		return [];
	}
}

function defaultSampleEnvironment(checkout, agentDir, diagFile) {
	// oxlint-disable-next-line anti-slop/no-runtime-typeof -- ProcessEnv values are string | undefined at the child-process boundary
	const env = Object.fromEntries(Object.entries(process.env).filter(([, value]) => typeof value === "string"));
	for (const key of Object.keys(env)) {
		if (key.startsWith("SUMOCODE_") || key.startsWith("SUMO_TUI")) delete env[key];
	}
	return {
		...env,
		HOME: join(agentDir, "home"),
		XDG_CONFIG_HOME: join(agentDir, "config"),
		PI_CODING_AGENT_DIR: agentDir,
		SUMOCODE_STATE_DIR: join(agentDir, "sumocode-state"),
		SUMOCODE_CONFIG_DIR: join(agentDir, "config"),
		SUMO_TUI_DIAG_FILE: diagFile,
		SUMOCODE_PUBLIC_STARTUP_DIAGNOSTICS: "1",
		SUMOCODE_HOST_BUNDLE: "0",
		SUMOCODE_EXTENSION_BUNDLE: "0",
		SUMO_TUI_DEBUG: "0",
		NODE_COMPILE_CACHE: join(agentDir, "compile-cache"),
		NODE_OPTIONS: `--require "${join(ROOT, "scripts", "startup-diagnostics-preload.cjs")}"`,
		PI_BIN: join(checkout, "node_modules", ".bin", "pi"),
		TMPDIR: join(agentDir, "tmp"),
		TERM: "xterm-256color",
	};
}

function signalPtyTree(child, signal) {
	if (process.platform !== "win32" && Number.isInteger(child.pid)) process.kill(-child.pid, signal);
	else child.kill(signal);
}

function ptyTreeAlive(child, leaderExited) {
	if (process.platform === "win32" || !Number.isInteger(child.pid)) return !leaderExited;
	try { process.kill(-child.pid, 0); return true; } catch { return false; }
}

async function waitForTreeExit(isAlive, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	while (isAlive() && Date.now() < deadline) await new Promise((resolveWait) => setTimeout(resolveWait, 20));
}

async function runSampleProcess({ checkout, agentDir, diagFile }, boundaries = {}) {
	const spawnPtyFn = boundaries.spawnPty ?? spawnPty;
	const child = spawnPtyFn(join(checkout, "bin", "sumocode.sh"), [...FLAGS], {
		name: "xterm-256color",
		cols: 100,
		rows: 30,
		cwd: join(agentDir, "project"),
		env: defaultSampleEnvironment(checkout, agentDir, diagFile),
	});
	let exited = false;
	let exitCode;
	let signal;
	child.onExit((event) => {
		exited = true;
		exitCode = event.exitCode;
		signal = event.signal;
	});
	const signalTree = boundaries.signalTree ?? signalPtyTree;
	const treeAlive = () => (boundaries.treeAlive ?? ptyTreeAlive)(child, exited);
	const deadline = Date.now() + SAMPLE_TIMEOUT_MS;
	let events = [];
	while (!exited && Date.now() < deadline) {
		events = await readEvents(diagFile);
		if (REQUIRED_EVENTS.every((name) => events.some((event) => event.event === name))) break;
		await new Promise((resolveWait) => setTimeout(resolveWait, 20));
	}
	// One final read closes the race between the child's last diagnostic append
	// and node-pty's exit callback. Snapshot natural exit only after that await,
	// immediately before the harness begins its own bounded shutdown.
	events = await readEvents(diagFile);
	let exitedBeforeShutdown = exited;
	const treeAliveBeforeShutdown = treeAlive();
	const observedAllEvents = REQUIRED_EVENTS.every((name) => events.some((event) => event.event === name));
	if (treeAliveBeforeShutdown) {
		try { signalTree(child, "SIGINT"); } catch (error) {
			// ESRCH here means the tree vanished before any harness signal could
			// land: a natural exit, never attributable to an orderly shutdown.
			if (error?.code === "ESRCH") exitedBeforeShutdown = true;
		}
		await waitForTreeExit(treeAlive, 750);
	}
	if (treeAlive()) {
		try { signalTree(child, "SIGTERM"); } catch {}
		await waitForTreeExit(treeAlive, 250);
	}
	if (treeAlive()) {
		try { signalTree(child, "SIGKILL"); } catch {}
		await waitForTreeExit(treeAlive, 250);
	}
	const failure = treeAlive()
		? "shutdown-failed"
		: !treeAliveBeforeShutdown || exitedBeforeShutdown
			? "process-failed"
			: observedAllEvents ? undefined : "missing-events";
	return { ok: failure === undefined, failure, events, exitCode, signal };
}

function eventTimestamp(event) {
	// oxlint-disable-next-line anti-slop/no-runtime-typeof -- timestamp validation on untrusted diagnostics JSONL
	return typeof event?.ts === "number" && Number.isFinite(event.ts) ? event.ts : undefined;
}

/** Convert raw local diagnostics to the only sample shape allowed into public reports. */
function publicSample(raw, index, startWallMs) {
	const events = Array.isArray(raw?.events) ? raw.events : [];
	const byName = new Map();
	for (const event of events) {
		if (!REQUIRED_EVENTS.includes(event?.event)) continue;
		if (event.event === "process_preload_start" && event.role !== "host") continue;
		if (!byName.has(event.event)) byName.set(event.event, event);
	}
	const missingEvents = REQUIRED_EVENTS.filter((name) => eventTimestamp(byName.get(name)) === undefined);
	if (raw?.failure === "shutdown-failed") return { index, ok: false, failure: "shutdown-failed", missingEvents };
	if (raw?.failure === "process-failed") return { index, ok: false, failure: "process-failed", missingEvents };
	if (missingEvents.length > 0) return { index, ok: false, failure: "missing-events", missingEvents };
	if (raw?.ok !== true) return { index, ok: false, failure: "process-failed", missingEvents };
	if (byName.get("host_import_ready")?.mode !== "source") return { index, ok: false, failure: "mode-mismatch", missingEvents: [] };
	const hostStart = eventTimestamp(byName.get("process_preload_start"));
	const hostImport = eventTimestamp(byName.get("host_import_ready"));
	const rpcChild = eventTimestamp(byName.get("rpc_child_ready"));
	const terminalIndexStart = eventTimestamp(byName.get("terminal_index_start"));
	const terminalIndex = eventTimestamp(byName.get("terminal_index_ready"));
	// The ready mark carries the store's own high-resolution scan duration;
	// prefer it over integer wall-clock subtraction, which quantizes
	// sub-millisecond scans to 0/1ms.
	const scanDurationMs = byName.get("terminal_index_ready")?.durationMs;
	const editor = eventTimestamp(byName.get("editor_ready"));
	const hydration = eventTimestamp(byName.get("hydration_committed"));
	const command = eventTimestamp(byName.get("command_ready"));
	return {
		index,
		ok: true,
		phases: {
			launcherMs: hostStart - startWallMs,
			hostImportMs: Math.max(0, hostImport - hostStart),
			rpcChildReadyMs: rpcChild - startWallMs,
			// oxlint-disable-next-line anti-slop/no-runtime-typeof -- parsed diagnostics JSONL boundary: durationMs is validated before use.
			terminalIndexReadyMs: typeof scanDurationMs === "number" && Number.isFinite(scanDurationMs) && scanDurationMs >= 0
				? round(scanDurationMs)
				: Math.max(0, terminalIndex - terminalIndexStart),
			editorReadyMs: editor - startWallMs,
			hydrationCommittedMs: hydration - startWallMs,
			commandReadyMs: command - startWallMs,
			editorToCommandGapMs: Math.max(0, command - editor),
		},
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

function statistics(samples, metric) {
	const values = samples.flatMap((sample) => sample.ok ? [sample.phases[metric]] : []);
	const center = median(values);
	const mad = center === null ? null : median(values.map((value) => Math.abs(value - center)));
	return {
		samples: values.map(round),
		failures: samples.length - values.length,
		medianMs: center === null ? null : round(center),
		spread: { kind: "mad", madMs: mad === null ? null : round(mad) },
		intervalMs: center === null || mad === null ? null : [round(center - mad), round(center + mad)],
	};
}

function metricComparison(definition, baselineSamples, candidateSamples) {
	const baseline = statistics(baselineSamples, definition.name);
	const candidate = statistics(candidateSamples, definition.name);
	let verdict = "inconclusive";
	if (
		baseline.failures === 0
		&& candidate.failures === 0
		&& baseline.samples.length >= MIN_DIRECTIONAL_SAMPLES
		&& candidate.samples.length >= MIN_DIRECTIONAL_SAMPLES
		&& baseline.intervalMs
		&& candidate.intervalMs
	) {
		if (candidate.intervalMs[1] < baseline.intervalMs[0]) verdict = "improved";
		else if (candidate.intervalMs[0] > baseline.intervalMs[1]) verdict = "regressed";
	}
	const deltaMs = baseline.medianMs === null || candidate.medianMs === null ? null : round(candidate.medianMs - baseline.medianMs);
	const deltaPercent = deltaMs === null || baseline.medianMs === 0 ? null : round(deltaMs / baseline.medianMs * 100);
	return { ...definition, baseline, candidate, deltaMs, deltaPercent, verdict };
}

function overallVerdict(metrics) {
	if (metrics.some((metric) => metric.baseline.failures > 0 || metric.candidate.failures > 0)) {
		return { verdict: "INCONCLUSIVE", reason: "one or more samples failed" };
	}
	if (metrics.some((metric) => metric.baseline.samples.length < MIN_DIRECTIONAL_SAMPLES || metric.candidate.samples.length < MIN_DIRECTIONAL_SAMPLES)) {
		return { verdict: "INCONCLUSIVE", reason: `fewer than ${MIN_DIRECTIONAL_SAMPLES} successful samples per arm` };
	}
	if (metrics.every((metric) => metric.verdict === "improved")) return { verdict: "IMPROVED", reason: "all measured intervals moved lower" };
	if (metrics.every((metric) => metric.verdict === "regressed")) return { verdict: "REGRESSED", reason: "all measured intervals moved higher" };
	return { verdict: "INCONCLUSIVE", reason: "phase signals conflict or intervals overlap" };
}

function formatNumber(value, suffix = "ms") {
	return value === null ? "—" : `${value}${suffix}`;
}

function markdown(report) {
	const fixtureNote = report.fixture.retained
		? report.fixture.reason === "live-process"
			? "retained because a live benchmark process prevented safe cleanup"
			: "retained by explicit request"
		: "deleted after collection";
	const section = (title, group, description) => {
		const rows = report.metrics.filter((metric) => metric.group === group).map((metric) =>
			`| ${metric.label} | ${formatNumber(metric.baseline.medianMs)} | ${formatNumber(metric.candidate.medianMs)} | ${formatNumber(metric.deltaMs)} | ${formatNumber(metric.deltaPercent, "%")} | ${metric.baseline.spread.madMs ?? "—"}ms | ${metric.candidate.spread.madMs ?? "—"}ms | ${metric.baseline.failures}/${metric.candidate.failures} | ${metric.verdict} |`);
		return `## ${title}\n\n${description}\n\n| Metric | Baseline | Candidate | Delta | Delta % | Baseline MAD | Candidate MAD | Failures B/C | Verdict |\n| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |\n${rows.join("\n")}\n`;
	};
	return `# SumoCode startup comparison\n\n- baseline: \`${report.baselineSha}\`\n- candidate: \`${report.candidateSha}\`\n- samples per arm: ${report.samplesPerArm}\n- fixture records: ${report.fixture.recordCount} (${fixtureNote})\n- execution: alternating baseline/candidate arms\n- mode: host source, extension source\n\n${section("Targeted phases", "targeted", "Terminal index readiness is the Plan 093-targeted signal. It does not by itself establish faster aggregate startup.")}\n${section("Attributed startup phases", "attributed", "Launcher, host import, and RPC child readiness localize startup movement without claiming end-to-end improvement.")}\n${section("Aggregate startup", "aggregate", "Editor and command readiness are user-facing aggregate milestones; hydration is the committed-state boundary between them.")}\nOverall startup: **${report.overall.verdict}** — ${report.overall.reason}.\n\nVerdicts require at least ${MIN_DIRECTIONAL_SAMPLES} successful samples per arm, non-overlapping median ± MAD intervals, and zero failed samples. Smaller runs, any overlap, missing event, failed sample, or conflicting phase direction make the overall result inconclusive.\n`;
}

function executionSchedule(samples) {
	const schedule = [];
	for (let index = 0; index < samples; index += 1) {
		const pair = index % 2 === 0 ? ["baseline", "candidate"] : ["candidate", "baseline"];
		for (const arm of pair) schedule.push({ arm, index });
	}
	return schedule;
}

// O_NOFOLLOW is undefined on Windows, where the flag is unsupported.
const REPORT_OPEN_FLAGS = fsConstants.O_NOFOLLOW === undefined
	? fsConstants.O_WRONLY | fsConstants.O_CREAT
	: fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_NOFOLLOW;

/** Report writes must never follow a pre-existing symlink at the leaf. */
async function writeReportFile(path, contents) {
	if ((await lstat(path).catch(() => undefined))?.isSymbolicLink()) throw new Error(`refusing to write through symlink: ${path}`);
	// Open WITHOUT truncating, then verify the exact inode before any write:
	// O_NOFOLLOW keeps symlinks out at the syscall boundary, and the nlink
	// check refuses hard links to other files (e.g. tracked checkout files)
	// on the same opened handle, closing the lstat/write TOCTOU window.
	const handle = await open(path, REPORT_OPEN_FLAGS, 0o600);
	try {
		if ((await handle.stat()).nlink > 1) throw new Error(`refusing to overwrite multi-linked file: ${path}`);
		await handle.truncate(0);
		await handle.writeFile(contents);
	} finally { await handle.close(); }
}

/**
 * Compare two exact revisions. This owns fixture, worktree, sampling, privacy,
 * statistics, verdict, report, and cleanup policy; injected dependencies are
 * process/filesystem boundaries used by tests.
 */
export async function runStartupComparison(options, dependencies = {}) {
	const callerRoot = resolve(options.callerRoot ?? ROOT);
	const outDir = resolve(options.outDir);
	await assertOutOutsideCheckout(callerRoot, outDir);
	const campaignDir = await mkdtemp(join(tmpdir(), "sumocode-startup-compare-"));
	const resolveRef = dependencies.resolveRevision ?? ((ref) => resolveRevision(callerRoot, ref));
	const assertCheckoutClean = dependencies.assertClean ?? assertClean;
	const makeWorktrees = dependencies.prepareWorktrees ?? prepareWorktrees;
	const sampleRunner = dependencies.runSample ?? ((sample) => runSampleProcess(sample, {
		spawnPty: dependencies.spawnSamplePty,
		signalTree: dependencies.signalSampleTree,
		treeAlive: dependencies.sampleTreeAlive,
	}));
	const machineMetadata = dependencies.machineMetadata ?? (() => ({ platform: platform(), arch: arch(), nodeVersion: process.version, cpuCount: cpus().length }));
	const now = dependencies.now ?? (() => new Date());
	let worktrees;
	let dependenciesUnlinked = false;
	let retainedForLiveProcess = false;
	let retainedForAuditFailure = false;
	let auditError;
	try {
		await assertCheckoutClean(callerRoot);
		const [baselineSha, candidateSha] = await Promise.all([resolveRef(options.baseRef), resolveRef(options.candidateRef ?? "HEAD")]);
		worktrees = await makeWorktrees({ callerRoot, campaignDir, baselineSha, candidateSha });
		const armSamples = { baseline: [], candidate: [] };
		const schedule = executionSchedule(options.samples);
		const executedOrder = [];
		for (const { arm, index } of schedule) {
			executedOrder.push(arm);
			const checkout = arm === "baseline" ? worktrees.baselineDir : worktrees.candidateDir;
			// One absolute path makes every generated meta.json byte-identical;
			// resetFixture rebuilds it before each timed launch.
			const agentDir = join(campaignDir, "agent");
			await resetFixture(agentDir, options.fixtureCount);
			const diagFile = join(agentDir, "startup.jsonl");
			await writePrivate(diagFile, "");
			const startWallMs = Date.now();
			let raw;
			try {
				raw = await sampleRunner({ arm, index, checkout, agentDir, diagFile, startWallMs, flags: FLAGS });
			} catch {
				raw = { ok: false, failure: "process-failed", events: [] };
			}
			const sample = publicSample(raw, index, startWallMs);
			armSamples[arm].push(sample);
			// Never mutate the shared fixture or launch another process while an
			// owned PTY may still be alive.
			if (sample.failure === "shutdown-failed") {
				retainedForLiveProcess = true;
				break;
			}
		}
		if (!retainedForLiveProcess) {
			await worktrees.unlinkDependencies?.();
			dependenciesUnlinked = true;
			// A revision that dirtied its own detached checkout must not have that
			// evidence force-removed: retain the worktrees. The audit error is
			// rethrown after the reports are safely written.
			try {
				await assertCheckoutClean(worktrees.baselineDir);
				await assertCheckoutClean(worktrees.candidateDir);
			} catch (error) {
				retainedForAuditFailure = true;
				auditError = error;
			}
		}
		const metrics = METRICS.map((definition) => metricComparison(definition, armSamples.baseline, armSamples.candidate));
		const successfulSamples = {
			baseline: armSamples.baseline.filter((sample) => sample.ok).length,
			candidate: armSamples.candidate.filter((sample) => sample.ok).length,
		};
		const shutdownFailures = armSamples.baseline.concat(armSamples.candidate)
			.filter((sample) => sample.failure === "shutdown-failed").length;
		const report = {
			schemaVersion: 1,
			generatedAt: now().toISOString(),
			baselineSha,
			candidateSha,
			samplesPerArm: options.samples,
			fixture: {
				recordCount: options.fixtureCount,
				retained: options.keepFixture === true || retainedForLiveProcess || retainedForAuditFailure,
				reason: retainedForLiveProcess ? "live-process" : retainedForAuditFailure ? "audit-failure" : options.keepFixture === true ? "explicit" : undefined,
			},
			runtime: machineMetadata(),
			flags: [...FLAGS],
			bundleMode: { host: "source", extension: "source" },
			executionOrder: executedOrder,
			collection: {
				succeeded: successfulSamples.baseline > 0 && successfulSamples.candidate > 0 && shutdownFailures === 0,
				successfulSamples,
				shutdownFailures,
			},
			arms: {
				baseline: { sha: baselineSha, samples: armSamples.baseline },
				candidate: { sha: candidateSha, samples: armSamples.candidate },
			},
			metrics,
			overall: overallVerdict(metrics),
		};
		await mkdir(outDir, { recursive: true });
		await writeReportFile(join(outDir, "startup-compare.json"), `${JSON.stringify(report, null, 2)}\n`);
		await writeReportFile(join(outDir, "startup-compare.md"), markdown(report));
		if (auditError) throw auditError;
		return report;
	} finally {
		const cleanupSteps = [];
		if (retainedForLiveProcess || retainedForAuditFailure) {
			cleanupSteps.push(async () => { dependencies.onFixtureRetained?.(campaignDir); });
		} else {
			if (!dependenciesUnlinked && worktrees?.unlinkDependencies) cleanupSteps.push(() => worktrees.unlinkDependencies());
			if (worktrees?.cleanup) cleanupSteps.push(() => worktrees.cleanup());
			if (options.keepFixture === true) cleanupSteps.push(async () => { dependencies.onFixtureRetained?.(campaignDir); });
			else cleanupSteps.push(() => rm(campaignDir, { recursive: true, force: true }));
		}
		cleanupSteps.push(() => assertCheckoutClean(callerRoot));
		await runCleanupSteps(cleanupSteps, "startup comparison cleanup failed");
	}
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
	const options = startupCompareOptions(argv);
	if (options.help) {
		console.log(usage());
		return undefined;
	}
	const outDir = options.outDir ?? await mkdtemp(join(tmpdir(), "sumocode-startup-report-"));
	const report = await runStartupComparison({ ...options, callerRoot: ROOT, outDir }, {
		...dependencies,
		onFixtureRetained: dependencies.onFixtureRetained ?? ((path) => console.error(`fixture retained: ${path}`)),
	});
	console.error(`startup comparison reports written to: ${outDir}`);
	if (!report.collection.succeeded) throw new Error("startup comparison collection failed; inspect the written report");
	console.log(markdown(report));
	return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch((error) => {
		console.error(`startup comparison failed: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	});
}
