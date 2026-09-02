import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
	runStartupComparison,
	startupCompareOptions,
} from "./perf-startup-compare.mjs";

const roots = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(label) {
	const root = await mkdtemp(join(tmpdir(), label));
	roots.push(root);
	return root;
}

function diagnostics(startWallMs, arm, index, options = {}) {
	const offset = arm === "baseline" ? 100 : 80;
	const events = [
		{ event: "process_preload_start", role: "host", ts: startWallMs + (arm === "baseline" ? 5 : 3), cwd: "/Users/operator/private" },
		{ event: "host_import_ready", mode: "source", ts: startWallMs + offset },
		{ event: "rpc_child_ready", ts: startWallMs + offset + 10 },
		{ event: "terminal_index_start", ts: startWallMs + offset + 12 },
		{ event: "terminal_index_ready", ts: startWallMs + offset + (arm === "baseline" ? 20 : 18) },
		{ event: "editor_ready", ts: startWallMs + offset + 30 },
		{ event: "hydration_committed", ts: startWallMs + offset + 40 },
		{ event: "command_ready", ts: startWallMs + offset + (arm === "baseline" ? 50 : 48) },
		{ event: "keyboard_input", hex: "736563726574" },
		{ event: "runtime_start", cwd: "/Users/operator/project", provider: "private/provider" },
	];
	if (options.missingCommand) events.splice(events.findIndex((event) => event.event === "command_ready"), 1);
	return events.map((event) => ({ ...event, sampleSecret: `prompt-${arm}-${index}` }));
}

async function harness(options = {}) {
	const root = await temporaryRoot("sumocode-startup-compare-test-");
	const callerRoot = join(root, "caller");
	const baselineDir = join(root, "baseline");
	const candidateDir = join(root, "candidate");
	const outDir = join(root, "report");
	await Promise.all([mkdir(callerRoot), mkdir(baselineDir), mkdir(candidateDir)]);
	const execution = [];
	let fixtureAgentDir;
	const cleanChecks = [];
	let cleanedWorktrees = false;
	const report = await runStartupComparison({
		callerRoot,
		baseRef: "base-ref",
		candidateRef: "candidate-ref",
		samples: options.samples ?? 2,
		fixtureCount: options.fixtureCount ?? 3,
		outDir,
		keepFixture: options.keepFixture ?? false,
	}, {
		resolveRevision: async (ref) => ref === "base-ref" ? "a".repeat(40) : "b".repeat(40),
		assertClean: async (path) => { cleanChecks.push(path); },
		prepareWorktrees: async () => ({
			baselineDir,
			candidateDir,
			cleanup: async () => { cleanedWorktrees = true; },
		}),
		runSample: async ({ arm, index, startWallMs, agentDir }) => {
			fixtureAgentDir = agentDir;
			execution.push(`${arm}:${index}`);
			const store = join(agentDir, "state", "sumocode-terminals");
			const records = await readdir(store);
			expect(records).toHaveLength(options.fixtureCount ?? 3);
			const firstMeta = JSON.parse(await readFile(join(store, records[0], "meta.json"), "utf8"));
			expect(firstMeta).toMatchObject({
				ownerSessionId: "fixture-owner",
				command: "printf fixture",
				title: "fixture terminal",
			});
			return {
				ok: true,
				events: diagnostics(startWallMs, arm, index, options.failCandidate && arm === "candidate" && index === 1
					? { missingCommand: true }
					: undefined),
				stderr: "provider private/provider in /Users/operator/.pi",
				output: "operator prompt and session-secret",
			};
		},
		machineMetadata: () => ({ platform: "test", arch: "test", nodeVersion: "v-test", cpuCount: 1 }),
		now: () => new Date("2026-01-01T00:00:00.000Z"),
	});
	return { report, root, callerRoot, outDir, execution, cleanChecks, cleanedWorktrees, fixtureAgentDir };
}

describe("startup comparison CLI", () => {
	it("marks the host process at preload with a public role discriminator", async () => {
		const root = await temporaryRoot("sumocode-startup-preload-test-");
		const entry = join(root, "sumo-rpc-host.js");
		const diag = join(root, "diag.jsonl");
		await writeFile(entry, "");
		await execFileAsync(process.execPath, [entry], {
			env: {
				...process.env,
				SUMO_TUI_DIAG_FILE: diag,
				NODE_OPTIONS: `--require "${resolve("scripts/startup-diagnostics-preload.cjs")}"`,
			},
		});
		const event = JSON.parse((await readFile(diag, "utf8")).trim().split("\n")[0]);
		expect(event).toMatchObject({ event: "process_preload_start", role: "host" });
	});

	it("defaults to 15 samples and an approximately 1,800-record disposable fixture", () => {
		expect(startupCompareOptions(["--base", "HEAD~1"])).toMatchObject({
			baseRef: "HEAD~1",
			samples: 15,
			fixtureCount: 1_800,
			keepFixture: false,
		});
	});

	it("compares exact revisions in alternating order and emits only public-safe report data", async () => {
		const result = await harness({ failCandidate: true });
		const { report } = result;

		expect(result.execution).toEqual(["baseline:0", "candidate:0", "candidate:1", "baseline:1"]);
		expect(report).toMatchObject({
			baselineSha: "a".repeat(40),
			candidateSha: "b".repeat(40),
			samplesPerArm: 2,
			fixture: { recordCount: 3, retained: false },
			flags: ["--offline", "--no-extensions", "--no-session"],
			bundleMode: { host: "source", extension: "source" },
			runtime: { platform: "test", arch: "test", nodeVersion: "v-test", cpuCount: 1 },
		});
		expect(report.executionOrder).toEqual(["baseline", "candidate", "candidate", "baseline"]);
		expect(report.arms.baseline.samples).toHaveLength(2);
		expect(report.arms.baseline.samples[0].phases).toMatchObject({ hostImportMs: 95, terminalIndexReadyMs: 8 });
		expect(report.arms.candidate.samples).toHaveLength(2);
		expect(report.arms.candidate.samples[1]).toMatchObject({
			ok: false,
			failure: "missing-events",
			missingEvents: ["command_ready"],
		});
		expect(report.metrics.find((metric) => metric.name === "commandReadyMs")).toMatchObject({
			baseline: { failures: 0 },
			candidate: { failures: 1 },
			verdict: "inconclusive",
		});

		const json = await readFile(join(result.outDir, "startup-compare.json"), "utf8");
		const markdown = await readFile(join(result.outDir, "startup-compare.md"), "utf8");
		for (const secret of ["/Users/", "operator prompt", "private/provider", "session-secret", "keyboard_input", "runtime_start", "sampleSecret"]) {
			expect(`${json}\n${markdown}`).not.toContain(secret);
		}
		expect(markdown).toContain("Targeted phases");
		expect(markdown).toContain("Aggregate startup");
		expect(markdown).toContain("Overall startup: **INCONCLUSIVE**");
		expect(result.cleanedWorktrees).toBe(true);
		expect(result.cleanChecks).toEqual([result.callerRoot, join(result.root, "baseline"), join(result.root, "candidate"), result.callerRoot]);
		expect(await stat(result.fixtureAgentDir).catch(() => undefined)).toBeUndefined();
	});

	it("requires non-overlapping evidence in one direction for an overall claim", async () => {
		const improved = await harness({ samples: 3, fixtureCount: 1 });
		expect(improved.report.metrics.every((metric) => metric.verdict === "improved")).toBe(true);
		expect(improved.report.overall.verdict).toBe("IMPROVED");

		const root = await temporaryRoot("sumocode-startup-conflict-test-");
		const callerRoot = join(root, "caller");
		const baselineDir = join(root, "baseline");
		const candidateDir = join(root, "candidate");
		await Promise.all([mkdir(callerRoot), mkdir(baselineDir), mkdir(candidateDir)]);
		const outDir = join(root, "report");
		const conflicted = await runStartupComparison({ callerRoot, baseRef: "base", samples: 3, fixtureCount: 1, outDir }, {
			resolveRevision: async (ref) => ref === "base" ? "c".repeat(40) : "d".repeat(40),
			assertClean: async () => undefined,
			prepareWorktrees: async () => ({ baselineDir, candidateDir, cleanup: async () => undefined }),
			runSample: async ({ arm, index, startWallMs }) => {
				const events = diagnostics(startWallMs, arm, index);
				if (arm === "candidate") {
					for (const event of events) {
						if (["hydration_committed", "command_ready"].includes(event.event)) event.ts += 60;
					}
				}
				return { ok: true, events };
			},
			machineMetadata: () => ({ platform: "test", arch: "test", nodeVersion: "v-test", cpuCount: 1 }),
			now: () => new Date("2026-01-01T00:00:00.000Z"),
		});
		expect(conflicted.metrics).toEqual(expect.arrayContaining([
			expect.objectContaining({ name: "terminalIndexReadyMs", verdict: "improved" }),
			expect.objectContaining({ name: "commandReadyMs", verdict: "regressed" }),
		]));
		expect(conflicted.overall).toMatchObject({ verdict: "INCONCLUSIVE", reason: "phase signals conflict or intervals overlap" });
	});
});
