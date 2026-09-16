#!/usr/bin/env node
import { spawn, execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { cpus, platform, arch } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";
import { readNativeArtifactIdentity } from "./lib/native-artifact.mjs";
import { measureHostImport } from "./perf-startup.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_BASELINE = join(ROOT, "docs/perf/adoption-baseline.json");
const SAMPLES = 15;
const EVAL_START = "sumocode_extension_eval_start";
const EVAL_END = "sumocode_extension_eval_end";
const execFileAsync = promisify(execFile);

function usage() {
	return `Usage: node scripts/perf-adoption-budget.mjs --native <archive> [options]\n\nOptions:\n  --native <dir>      native archive built from the current clean source commit\n  --baseline <file>   reviewed baseline and ceilings (default: docs/perf/adoption-baseline.json)\n  --out <dir>         new report directory (required)\n  -h, --help          show this help\n\nThe command never rewrites the reviewed baseline.\n`;
}

export function adoptionBudgetOptions(argv) {
	const options = { baselinePath: DEFAULT_BASELINE };
	for (let index = argv[0] === "--" ? 1 : 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "-h" || arg === "--help") return { ...options, help: true };
		const value = argv[index + 1];
		if (["--native", "--baseline", "--out"].includes(arg) && value === undefined) throw new Error(`${arg} requires a value`);
		switch (arg) {
			case "--native": options.nativeDir = resolve(value); index += 1; break;
			case "--baseline": options.baselinePath = resolve(value); index += 1; break;
			case "--out": options.outDir = resolve(value); index += 1; break;
			default: throw new Error(`unknown option: ${arg}`);
		}
	}
	if (!options.help && !options.nativeDir) throw new Error("--native is required");
	if (!options.help && !options.outDir) throw new Error("--out is required");
	return options;
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

function timingMeasurement(samples) {
	const values = samples.flatMap((sample) => sample.ok && Number.isFinite(sample.durationMs) ? [sample.durationMs] : []);
	const center = median(values);
	const mad = center === null ? null : median(values.map((value) => Math.abs(value - center)));
	return {
		kind: "timing",
		samples: samples.map((sample) => sample.ok ? round(sample.durationMs) : { failure: sample.failure ?? "process-failed" }),
		failures: samples.length - values.length,
		medianMs: center === null ? null : round(center),
		madMs: mad === null ? null : round(mad),
	};
}

function sizeMeasurement(value) {
	return { kind: "size", value };
}

export function evaluateAdoptionBudget(report, policy) {
	const failedChecks = [];
	for (const [name, budget] of Object.entries(policy.budgets ?? {})) {
		const observed = report.measurements[name];
		if (!observed || !Number.isFinite(budget?.max)) {
			failedChecks.push(`${name}:policy`);
			continue;
		}
		if (observed.kind === "timing") {
			if (observed.samples.length !== SAMPLES || observed.failures !== 0 || !Number.isFinite(observed.medianMs)) {
				failedChecks.push(`${name}:collection`);
				continue;
			}
			if (observed.medianMs > budget.max) failedChecks.push(`${name}:budget`);
		} else if (observed.kind === "size") {
			if (!Number.isFinite(observed.value)) failedChecks.push(`${name}:collection`);
			else if (observed.value > budget.max) failedChecks.push(`${name}:budget`);
		} else failedChecks.push(`${name}:collection`);
	}
	for (const name of Object.keys(report.measurements)) {
		if (!Object.hasOwn(policy.budgets ?? {}, name)) failedChecks.push(`${name}:policy`);
	}
	return { verdict: failedChecks.length === 0 ? "passed" : "failed", failedChecks };
}

export function instrumentExtensionBundle(source) {
	return `globalThis.__sumocodeStartupMark?.(${JSON.stringify(EVAL_START)});\n${source}\nglobalThis.__sumocodeStartupMark?.(${JSON.stringify(EVAL_END)});\n`;
}

async function sourceIdentity() {
	const sourceCommit = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" })).stdout.trim();
	const status = (await execFileAsync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: ROOT, encoding: "utf8" })).stdout.trim();
	return { sourceCommit, sourceClean: status.length === 0 };
}

async function buildSourceBundle(entryPoint) {
	const result = await build({
		absWorkingDir: ROOT,
		entryPoints: [entryPoint],
		bundle: true,
		format: "esm",
		platform: "node",
		target: "node22",
		external: ["@earendil-works/*", "typebox"],
		write: false,
		logLevel: "silent",
	});
	return result.outputFiles[0].text;
}

async function privateDirectory(path) {
	await mkdir(path, { recursive: true, mode: 0o700 });
}

function evaluationEnvironment(agentDir, diagFile, root, native) {
	const env = {};
	for (const key of ["PATH", "LANG", "LC_ALL", "TZ", "SHELL"]) {
		// oxlint-disable-next-line anti-slop/no-runtime-typeof -- ProcessEnv child-process boundary
		if (typeof process.env[key] === "string") env[key] = process.env[key];
	}
	Object.assign(env, {
		HOME: join(agentDir, "home"),
		PI_CODING_AGENT_DIR: agentDir,
		SUMOCODE_STATE_DIR: join(agentDir, "state"),
		SUMOCODE_CONFIG_DIR: join(agentDir, "config"),
		SUMOCODE_ROOT_DIR: root,
		SUMOCODE_RPC_CHILD: "1",
		SUMO_TUI: "0",
		SUMO_TUI_DIAG_FILE: diagFile,
		SUMOCODE_PUBLIC_STARTUP_DIAGNOSTICS: "1",
		TMPDIR: join(agentDir, "tmp"),
		TERM: "xterm-256color",
	});
	if (!native) env.NODE_OPTIONS = `--require "${join(ROOT, "scripts/startup-diagnostics-preload.cjs")}"`;
	return env;
}

function signalChildTree(child, signal) {
	try {
		if (process.platform !== "win32" && Number.isInteger(child.pid)) process.kill(-child.pid, signal);
		else child.kill(signal);
	} catch (error) {
		if (error?.code !== "ESRCH") throw error;
	}
}

async function waitForChildExit(child, timeoutMs) {
	if (child.exitCode !== null || child.signalCode !== null) return true;
	return new Promise((resolveExit) => {
		let settled = false;
		const finish = (exited) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			child.removeListener("exit", onExit);
			resolveExit(exited);
		};
		const onExit = () => finish(true);
		const timer = setTimeout(() => finish(child.exitCode !== null || child.signalCode !== null), timeoutMs);
		child.once("exit", onExit);
	});
}

async function stopChild(child) {
	if (child.exitCode !== null || child.signalCode !== null) return true;
	signalChildTree(child, "SIGTERM");
	if (await waitForChildExit(child, 500)) return true;
	signalChildTree(child, "SIGKILL");
	return waitForChildExit(child, 500);
}

async function evaluationSample({ command, bundlePath, root, native, workDir, index }) {
	const agentDir = join(workDir, `agent-${native ? "native" : "source"}-${index}`);
	await rm(agentDir, { recursive: true, force: true });
	await Promise.all(["home", "state", "config", "tmp", "project"].map((name) => privateDirectory(join(agentDir, name))));
	const diagFile = join(agentDir, "startup.jsonl");
	await writeFile(diagFile, "", { mode: 0o600 });
	const child = spawn(command, ["--mode", "rpc", "-e", bundlePath, "--offline", "--no-session", "--no-extensions"], {
		cwd: join(agentDir, "project"),
		env: evaluationEnvironment(agentDir, diagFile, root, native),
		stdio: ["pipe", "pipe", "ignore"],
		detached: process.platform !== "win32",
	});
	let stdout = "";
	let settled = false;
	const result = await new Promise((resolveSample) => {
		const settle = async (sample) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			const reaped = await stopChild(child);
			resolveSample(reaped ? sample : { ok: false, failure: "shutdown-failed" });
		};
		const inspect = async () => {
			const events = (await readFile(diagFile, "utf8").catch(() => "")).split("\n").filter(Boolean).flatMap((line) => {
				try { return [JSON.parse(line)]; } catch { return []; }
			});
			const start = events.find((event) => event.event === EVAL_START)?.ts;
			const end = events.find((event) => event.event === EVAL_END)?.ts;
			const responseReady = stdout.split("\n").some((line) => {
				try {
					const response = JSON.parse(line);
					return response?.type === "response" && response.id === "budget-probe" && response.command === "get_state" && response.success === true;
				} catch { return false; }
			});
			if (Number.isFinite(start) && Number.isFinite(end) && end >= start && responseReady) {
				await settle({ ok: true, durationMs: end - start });
			}
		};
		const timer = setTimeout(() => settle({ ok: false, failure: "timeout" }), 30_000);
		child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); void inspect(); });
		child.on("error", () => settle({ ok: false, failure: "process-failed" }));
		child.on("exit", () => settle({ ok: false, failure: "process-failed" }));
		child.stdin.write(`${JSON.stringify({ type: "get_state", id: "budget-probe" })}\n`);
	});
	return result;
}

async function evaluateBundle(command, bundlePath, root, native, workDir) {
	const samples = [];
	for (let index = 0; index < SAMPLES; index += 1) {
		const sample = await evaluationSample({ command, bundlePath, root, native, workDir, index });
		samples.push(sample);
		console.error(`[adoption budget] ${native ? "native" : "source"} ${bundlePath.endsWith("rpc.mjs") ? "rpc" : "classic"} ${index + 1}/${SAMPLES} ${sample.ok ? "ok" : sample.failure}`);
	}
	return timingMeasurement(samples);
}

async function defaultCollectMeasurements(nativeArtifact) {
	await mkdir(join(ROOT, ".local"), { recursive: true });
	const workDir = await mkdtemp(join(ROOT, ".local/perf-adoption-"));
	try {
		const sourceClassic = await buildSourceBundle("src/extension.ts");
		const sourceRpc = await buildSourceBundle("src/rpc-child-extension.ts");
		const nativeClassicPath = join(nativeArtifact.artifactDir, "extension/sumocode-extension.bundle.mjs");
		const nativeRpcPath = join(nativeArtifact.artifactDir, "extension/sumocode-rpc-extension.bundle.mjs");
		const bundles = {
			"source-classic": { source: sourceClassic, command: join(ROOT, "node_modules/.bin/pi"), root: ROOT, native: false },
			"source-rpc": { source: sourceRpc, command: join(ROOT, "node_modules/.bin/pi"), root: ROOT, native: false },
			"native-classic": { source: await readFile(nativeClassicPath, "utf8"), command: join(nativeArtifact.artifactDir, "bin/sumocode-pi"), root: nativeArtifact.artifactDir, native: true },
			"native-rpc": { source: await readFile(nativeRpcPath, "utf8"), command: join(nativeArtifact.artifactDir, "bin/sumocode-pi"), root: nativeArtifact.artifactDir, native: true },
		};
		const measurements = {};
		const hostImport = await measureHostImport(SAMPLES);
		measurements["source-host-import-ms"] = timingMeasurement(hostImport.samples.map((sample) => sample.ok === false
			? { ok: false, failure: "process-failed" }
			: { ok: true, durationMs: sample.durationMs }));
		for (const [name, bundle] of Object.entries(bundles)) {
			const path = join(workDir, `${name.endsWith("rpc") ? "rpc" : "classic"}.mjs`);
			await writeFile(path, instrumentExtensionBundle(bundle.source));
			measurements[`${name}-extension-bytes`] = sizeMeasurement(Buffer.byteLength(bundle.source));
			measurements[`${name}-extension-eval-ms`] = await evaluateBundle(bundle.command, path, bundle.root, bundle.native, workDir);
		}
		return measurements;
	} finally { await rm(workDir, { recursive: true, force: true }); }
}

async function prepareOut(path) {
	await mkdir(path, { recursive: true, mode: 0o700 });
	const entries = new Set(await readdir(path));
	for (const name of ["results.json", "report.md"]) {
		if (entries.has(name)) throw new Error(`--out already contains ${name}; refusing to overwrite it`);
	}
}

async function defaultMachineMetadata() {
	const bun = (await execFileAsync(process.env.BUN_BIN ?? "bun", ["--version"], { encoding: "utf8" })).stdout.trim();
	return { platform: platform(), arch: arch(), node: process.version, bun, cpu: `${cpus()[0]?.model ?? "unknown"} × ${cpus().length}` };
}

function markdown(report, policy) {
	const rows = Object.entries(report.measurements).map(([name, measurement]) => {
		const observed = measurement.kind === "timing" ? `${measurement.medianMs}ms` : `${measurement.value} bytes`;
		return `| ${name} | ${policy.budgets[name].baseline} | ${policy.budgets[name].max} | ${observed} |`;
	});
	return `# Effect adoption performance budget\n\n- source: \`${report.source.sourceCommit}\` (clean: ${report.source.sourceClean})\n- native artifact: \`${report.nativeArtifact.artifactSha256}\` from \`${report.nativeArtifact.sourceCommit}\`\n- samples per timing measurement: ${SAMPLES}\n\n| measurement | baseline | reviewed max | observed |\n| --- | ---: | ---: | ---: |\n${rows.join("\n")}\n\nGate: **${report.gate.verdict.toUpperCase()}**${report.gate.failedChecks.length ? ` — ${report.gate.failedChecks.join(", ")}` : ""}.\n`;
}

export async function runAdoptionBudget(options, dependencies = {}) {
	await prepareOut(options.outDir);
	const [policy, source, nativeArtifact] = await Promise.all([
		readFile(options.baselinePath, "utf8").then(JSON.parse),
		(dependencies.readSourceIdentity ?? sourceIdentity)(),
		(dependencies.readArtifact ?? readNativeArtifactIdentity)(options.nativeDir),
	]);
	if (policy.schemaVersion !== 1 || policy.baseline?.samples !== SAMPLES) throw new Error("adoption baseline policy is invalid");
	if (!source.sourceClean) throw new Error("adoption budget requires a clean source checkout");
	if (source.sourceCommit !== nativeArtifact.sourceCommit) throw new Error("source checkout and native artifact commits differ");
	const measurements = await (dependencies.collectMeasurements ?? defaultCollectMeasurements)(nativeArtifact);
	const report = {
		schemaVersion: 1,
		generatedAt: new Date().toISOString(),
		source,
		nativeArtifact: { sourceCommit: nativeArtifact.sourceCommit, sourceClean: nativeArtifact.sourceClean, artifactSha256: nativeArtifact.artifactSha256 },
		machine: await (dependencies.machineMetadata ?? defaultMachineMetadata)(),
		measurements,
	};
	report.gate = evaluateAdoptionBudget(report, policy);
	await writeFile(join(options.outDir, "results.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600, flag: "wx" });
	await writeFile(join(options.outDir, "report.md"), markdown(report, policy), { mode: 0o600, flag: "wx" });
	return report;
}

export async function main(argv = process.argv.slice(2)) {
	const options = adoptionBudgetOptions(argv);
	if (options.help) { console.log(usage()); return undefined; }
	const report = await runAdoptionBudget(options);
	console.log((await readFile(join(options.outDir, "report.md"), "utf8")));
	if (report.gate.verdict !== "passed") throw new Error(`adoption performance budget failed: ${report.gate.failedChecks.join(", ")}`);
	return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch((error) => {
		console.error(`[adoption budget] failed: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	});
}
