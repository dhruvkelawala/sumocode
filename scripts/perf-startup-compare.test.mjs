import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import { link, mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
	defaultSampleEnvironment,
	main,
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
		{ event: "terminal_index_ready", durationMs: arm === "baseline" ? 8.5 : 6.5, ts: startWallMs + offset + (arm === "baseline" ? 20 : 18) },
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
	const fixtureMetadata = { baseline: [], candidate: [] };
	let fixtureAgentDir;
	const cleanChecks = [];
	let cleanedWorktrees = false;
	const dependencies = {
		resolveRevision: async (ref) => ref === "base-ref" ? "a".repeat(40) : "b".repeat(40),
		assertClean: async (path) => { cleanChecks.push(path); },
		prepareWorktrees: async () => ({
			baselineDir,
			candidateDir,
			cleanup: async () => {
				cleanedWorktrees = true;
				if (options.cleanupFails) throw new Error("worktree cleanup failed");
			},
		}),
		runSample: async ({ arm, index, startWallMs, agentDir }) => {
			if (options.failAllSpawns) throw new Error("posix_spawnp failed");
			fixtureAgentDir = agentDir;
			execution.push(`${arm}:${index}`);
			const store = join(agentDir, "state", "sumocode-terminals");
			const records = await readdir(store);
			expect(records).toHaveLength(options.fixtureCount ?? 3);
			const firstMetadata = await readFile(join(store, records[0], "meta.json"), "utf8");
			fixtureMetadata[arm].push(firstMetadata);
			const firstMeta = JSON.parse(firstMetadata);
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
	};
	const comparisonOptions = {
		callerRoot,
		baseRef: "base-ref",
		candidateRef: "candidate-ref",
		samples: options.samples ?? 2,
		fixtureCount: options.fixtureCount ?? 3,
		outDir,
		keepFixture: options.keepFixture ?? false,
	};
	const report = options.publicCli
		? await main([
			"--base", comparisonOptions.baseRef,
			"--candidate", comparisonOptions.candidateRef,
			"--samples", String(comparisonOptions.samples),
			"--fixture-count", String(comparisonOptions.fixtureCount),
			"--out", outDir,
		], dependencies)
		: await runStartupComparison(comparisonOptions, dependencies);
	return { report, root, callerRoot, outDir, execution, fixtureMetadata, cleanChecks, cleanedWorktrees, fixtureAgentDir };
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
				SUMOCODE_PUBLIC_STARTUP_DIAGNOSTICS: "1",
				NODE_OPTIONS: `--require "${resolve("scripts/startup-diagnostics-preload.cjs")}"`,
			},
		});
		const event = JSON.parse((await readFile(diag, "utf8")).trim().split("\n")[0]);
		expect(event).toEqual(expect.objectContaining({ event: "process_preload_start", role: "host" }));
		expect(event).not.toHaveProperty("cwd");
		expect(event).not.toHaveProperty("argv");
	});

	it("defaults to 15 samples and an approximately 1,800-record disposable fixture", () => {
		expect(startupCompareOptions(["--base", "HEAD~1"])).toMatchObject({
			baseRef: "HEAD~1",
			samples: 15,
			fixtureCount: 1_800,
			keepFixture: false,
		});
	});

	it("rejects oversized sample counts instead of accepting Infinity", () => {
		expect(() => startupCompareOptions(["--base", "HEAD", "--samples", "9".repeat(400)]))
			.toThrow("--samples requires a positive integer");
	});

	it("strips inherited Herdr and launcher state from sample environments", () => {
		const env = defaultSampleEnvironment("/checkout", "/agent", "/agent/startup.jsonl", {
			HERDR_ENV: "1",
			HERDR_SOCKET_PATH: "/operator/herdr.sock",
			HERDR_PANE_ID: "w1:p1",
			SUMOCODE_RPC_CHILD: "1",
			SUMO_TUI_DEBUG: "1",
			PATH: "/usr/bin",
		});
		expect(env.HERDR_ENV).toBeUndefined();
		expect(env.HERDR_SOCKET_PATH).toBeUndefined();
		expect(env.HERDR_PANE_ID).toBeUndefined();
		expect(env.SUMOCODE_RPC_CHILD).toBeUndefined();
		expect(env.SUMO_TUI_DEBUG).toBe("0");
		expect(env.SUMO_TUI_DIAG_FILE).toBe("/agent/startup.jsonl");
		expect(env.SUMOCODE_STATE_DIR).toBe(join("/agent", "sumocode-state"));
		expect(env.PATH).toBe("/usr/bin");
		expect(env.PI_CODING_AGENT_DIR).toBe("/agent");
	});

	it("compares exact revisions in alternating order and emits only public-safe report data", async () => {
		const result = await harness({ failCandidate: true, publicCli: true });
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
		expect(result.fixtureMetadata.baseline).toEqual(result.fixtureMetadata.candidate);
		expect(report.arms.baseline.samples).toHaveLength(2);
		expect(report.arms.baseline.samples[0].phases).toMatchObject({ hostImportMs: 95, terminalIndexReadyMs: 8.5 });
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
		expect(result.cleanChecks).toEqual([resolve("."), join(result.root, "baseline"), join(result.root, "candidate"), resolve(".")]);
		expect(await stat(result.fixtureAgentDir).catch(() => undefined)).toBeUndefined();
	});

	it("fails the comparison when detached worktree cleanup fails", async () => {
		await expect(harness({ cleanupFails: true, samples: 1, fixtureCount: 1 }))
			.rejects.toThrow("startup comparison cleanup failed");
	});

	it("rejects --out that resolves inside the compared checkout", async () => {
		const root = await temporaryRoot("sumocode-startup-out-symlink-");
		const callerRoot = join(root, "caller");
		const inside = join(callerRoot, "docs");
		const outLink = join(root, "report-link");
		await mkdir(inside, { recursive: true });
		await symlink(inside, outLink);
		const notCreated = join(callerRoot, "docs", "perf-results");
		await expect(runStartupComparison({
			callerRoot,
			baseRef: "base",
			samples: 1,
			fixtureCount: 1,
			outDir: notCreated,
		}, {
			resolveRevision: async () => "a".repeat(40),
			assertClean: async () => undefined,
			prepareWorktrees: async () => ({ baselineDir: join(root, "b"), candidateDir: join(root, "c"), cleanup: async () => undefined }),
		})).rejects.toThrow("--out must be outside the compared checkout");
		await expect(stat(notCreated).catch(() => undefined)).resolves.toBeUndefined();
		await expect(runStartupComparison({
			callerRoot,
			baseRef: "base",
			samples: 1,
			fixtureCount: 1,
			outDir: outLink,
		}, {
			resolveRevision: async () => "a".repeat(40),
			assertClean: async () => undefined,
			prepareWorktrees: async () => ({ baselineDir: join(root, "baseline"), candidateDir: join(root, "candidate"), cleanup: async () => undefined }),
		})).rejects.toThrow("--out must be outside the compared checkout");
	});

	it("refuses to write reports through a pre-existing symlink", async () => {
		const root = await temporaryRoot("sumocode-startup-report-symlink-");
		const callerRoot = join(root, "caller");
		const outDir = join(root, "out");
		const victim = join(root, "victim.txt");
		await mkdir(callerRoot, { recursive: true });
		await mkdir(outDir, { recursive: true });
		await writeFile(victim, "do not truncate\n");
		await symlink(victim, join(outDir, "startup-compare.json"));
		await expect(runStartupComparison({
			callerRoot,
			baseRef: "base",
			samples: 1,
			fixtureCount: 1,
			outDir,
		}, {
			resolveRevision: async () => "a".repeat(40),
			assertClean: async () => undefined,
			prepareWorktrees: async () => ({ baselineDir: join(root, "b"), candidateDir: join(root, "c"), cleanup: async () => undefined }),
			runSample: async () => {
				throw new Error("no process");
			},
		})).rejects.toThrow("refusing to write through symlink");
		expect(await readFile(victim, "utf8")).toBe("do not truncate\n");
	});

	it("refuses to write reports through a hard-linked tracked file", async () => {
		const root = await temporaryRoot("sumocode-startup-report-hardlink-");
		const callerRoot = join(root, "caller");
		const outDir = join(root, "out");
		const victim = join(root, "victim.txt");
		await mkdir(callerRoot, { recursive: true });
		await mkdir(outDir, { recursive: true });
		await writeFile(victim, "ORIGINAL\n");
		await link(victim, join(outDir, "startup-compare.json"));
		await expect(runStartupComparison({
			callerRoot,
			baseRef: "base",
			samples: 1,
			fixtureCount: 1,
			outDir,
		}, {
			resolveRevision: async () => "a".repeat(40),
			assertClean: async () => undefined,
			prepareWorktrees: async () => ({ baselineDir: join(root, "b"), candidateDir: join(root, "c"), cleanup: async () => undefined }),
			runSample: async () => {
				throw new Error("no process");
			},
		})).rejects.toThrow("refusing to overwrite multi-linked file");
		expect(await readFile(victim, "utf8")).toBe("ORIGINAL\n");
	});

	it("retains worktrees and reports the audit error when a revision dirties its checkout", async () => {
		const root = await temporaryRoot("sumocode-startup-audit-failure-");
		const callerRoot = join(root, "caller");
		const baselineDir = join(root, "baseline");
		const candidateDir = join(root, "candidate");
		const outDir = await temporaryRoot("sumocode-startup-audit-failure-report-");
		await Promise.all([mkdir(baselineDir), mkdir(candidateDir), mkdir(callerRoot)]);
		let cleanupCalled = false;
		let retainedCampaign;
		const report = await runStartupComparison({
			callerRoot,
			baseRef: "base",
			candidateRef: "candidate",
			samples: 1,
			fixtureCount: 1,
			outDir,
		}, {
			resolveRevision: async (ref) => ref === "base" ? "5".repeat(40) : "6".repeat(40),
			assertClean: async (path) => {
				if (path === candidateDir) throw new Error("startup comparison requires clean source checkouts");
			},
			prepareWorktrees: async () => ({
				baselineDir,
				candidateDir,
				cleanup: async () => { cleanupCalled = true; },
			}),
			runSample: async ({ arm, startWallMs }) => ({ ok: true, events: diagnostics(startWallMs, arm, 0) }),
			machineMetadata: () => ({ platform: "test", arch: "test", nodeVersion: "v-test", cpuCount: 1 }),
			onFixtureRetained: (path) => {
				retainedCampaign = path;
				roots.push(path);
			},
		}).catch((error) => ({ auditError: error }));

		expect(report.auditError).toBeDefined();
		expect(report.auditError.message).toBe("startup comparison requires clean source checkouts");
		expect(cleanupCalled).toBe(false);
		expect(retainedCampaign).toEqual(expect.any(String));
		expect(await readFile(join(outDir, "startup-compare.json"), "utf8")).toContain("audit-failure");
	});

	it("retains the campaign when worktree setup fails", async () => {
		const root = await temporaryRoot("sumocode-startup-setup-failure-");
		const callerRoot = join(root, "caller");
		const outDir = await temporaryRoot("sumocode-startup-setup-failure-report-");
		await mkdir(callerRoot, { recursive: true });
		let retainedCampaign;
		await expect(runStartupComparison({
			callerRoot,
			baseRef: "base",
			samples: 1,
			fixtureCount: 1,
			outDir,
		}, {
			resolveRevision: async () => "a".repeat(40),
			assertClean: async () => undefined,
			prepareWorktrees: async () => {
				throw new Error("worktree add failed");
			},
			onFixtureRetained: (path) => {
				retainedCampaign = path;
				roots.push(path);
			},
		})).rejects.toThrow("worktree add failed");
		expect(retainedCampaign).toEqual(expect.any(String));
		await expect(stat(retainedCampaign)).resolves.toBeTruthy();
	});

	it("reports a dirty caller checkout as the primary failure, not cleanup", async () => {
		const root = await temporaryRoot("sumocode-startup-dirty-caller-");
		const callerRoot = join(root, "caller");
		const outDir = await temporaryRoot("sumocode-startup-dirty-caller-report-");
		await mkdir(callerRoot, { recursive: true });
		await expect(runStartupComparison({
			callerRoot,
			baseRef: "base",
			samples: 1,
			fixtureCount: 1,
			outDir,
		}, {
			resolveRevision: async () => "a".repeat(40),
			assertClean: async (path) => {
				if (path === callerRoot) throw new Error("startup comparison requires clean source checkouts");
			},
			prepareWorktrees: async () => ({ baselineDir: join(root, "b"), candidateDir: join(root, "c"), cleanup: async () => undefined }),
		})).rejects.toThrow("startup comparison requires clean source checkouts");
	});

	it("validates the default TMPDIR report root without creating it", async () => {
		const insideTmp = resolve("tmp-inside-the-checkout");
		const previousTmpDir = process.env.TMPDIR;
		process.env.TMPDIR = insideTmp;
		try {
			await expect(main(["--base", "base"], {
				resolveRevision: async () => "a".repeat(40),
				assertClean: async () => undefined,
				prepareWorktrees: async () => ({ baselineDir: join(insideTmp, "b"), candidateDir: join(insideTmp, "c"), cleanup: async () => undefined }),
				runSample: async () => {
					throw new Error("must not run");
				},
			})).rejects.toThrow("--out must be outside the compared checkout");
		} finally {
			if (previousTmpDir === undefined) delete process.env.TMPDIR;
			else process.env.TMPDIR = previousTmpDir;
		}
		await expect(stat(insideTmp).catch(() => undefined)).resolves.toBeUndefined();
	});

	it("validates the campaign TMPDIR root without creating it inside the checkout", async () => {
		const root = await temporaryRoot("sumocode-startup-campaign-tmpdir-");
		const callerRoot = join(root, "caller");
		const outDir = join(root, "report");
		await mkdir(callerRoot, { recursive: true });
		const previousTmpDir = process.env.TMPDIR;
		process.env.TMPDIR = join(callerRoot, "tmp-inside");
		try {
			await expect(runStartupComparison({
				callerRoot,
				baseRef: "base",
				samples: 1,
				fixtureCount: 1,
				outDir,
			}, {
				resolveRevision: async () => "a".repeat(40),
				assertClean: async () => undefined,
				prepareWorktrees: async () => ({ baselineDir: join(root, "b"), candidateDir: join(root, "c"), cleanup: async () => undefined }),
				runSample: async () => {
					throw new Error("must not run");
				},
			})).rejects.toThrow("--out must be outside the compared checkout");
		} finally {
			if (previousTmpDir === undefined) delete process.env.TMPDIR;
			else process.env.TMPDIR = previousTmpDir;
		}
		expect(await readdir(callerRoot)).toEqual([]);
	});

	it("rejects the public CLI when neither arm collects a successful sample", async () => {
		await expect(harness({ publicCli: true, failAllSpawns: true, samples: 1, fixtureCount: 1 }))
			.rejects.toThrow("startup comparison collection failed");
	});

	it("reports an OS-level natural exit before the PTY callback as failed", async () => {
		const root = await temporaryRoot("sumocode-startup-process-failure-");
		const baselineDir = join(root, "baseline");
		const candidateDir = join(root, "candidate");
		const outDir = await temporaryRoot("sumocode-startup-process-failure-report-");
		await Promise.all([mkdir(baselineDir), mkdir(candidateDir)]);
		const report = await runStartupComparison({
			callerRoot: root,
			baseRef: "base",
			candidateRef: "candidate",
			samples: 1,
			fixtureCount: 1,
			outDir,
		}, {
			resolveRevision: async (ref) => ref === "base" ? "e".repeat(40) : "f".repeat(40),
			assertClean: async () => undefined,
			prepareWorktrees: async () => ({ baselineDir, candidateDir, cleanup: async () => undefined }),
			spawnSamplePty: (_command, _args, options) => {
				const events = diagnostics(Date.now(), "baseline", 0);
				writeFileSync(options.env.SUMO_TUI_DIAG_FILE, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
				return { onExit: () => undefined, kill: () => undefined };
			},
			sampleTreeAlive: () => false,
			machineMetadata: () => ({ platform: "test", arch: "test", nodeVersion: "v-test", cpuCount: 1 }),
		});

		expect(report.arms.baseline.samples[0]).toMatchObject({ ok: false, failure: "process-failed" });
		expect(report.arms.candidate.samples[0]).toMatchObject({ ok: false, failure: "process-failed" });
	});

	it("reports ESRCH during harness SIGINT as a failed process, not a pass", async () => {
		const root = await temporaryRoot("sumocode-startup-esrch-");
		const baselineDir = join(root, "baseline");
		const candidateDir = join(root, "candidate");
		const outDir = await temporaryRoot("sumocode-startup-esrch-report-");
		await Promise.all([mkdir(baselineDir), mkdir(candidateDir)]);
		let alive = true;
		const report = await runStartupComparison({
			callerRoot: root,
			baseRef: "base",
			candidateRef: "candidate",
			samples: 1,
			fixtureCount: 1,
			outDir,
		}, {
			resolveRevision: async (ref) => ref === "base" ? "3".repeat(40) : "4".repeat(40),
			assertClean: async () => undefined,
			prepareWorktrees: async () => ({ baselineDir, candidateDir, cleanup: async () => undefined }),
			spawnSamplePty: (_command, _args, options) => {
				const events = diagnostics(Date.now(), "baseline", 0);
				writeFileSync(options.env.SUMO_TUI_DIAG_FILE, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
				return { onExit: () => undefined, kill: () => undefined };
			},
			sampleTreeAlive: () => alive,
			signalSampleTree: () => {
				alive = false;
				const error = new Error("ESRCH");
				error.code = "ESRCH";
				throw error;
			},
			machineMetadata: () => ({ platform: "test", arch: "test", nodeVersion: "v-test", cpuCount: 1 }),
		});
		expect(report.arms.baseline.samples[0]).toMatchObject({ ok: false, failure: "process-failed" });
		expect(report.arms.candidate.samples[0]).toMatchObject({ ok: false, failure: "process-failed" });
	});

	it("retains the campaign and stops when the PTY tree survives every signal", async () => {
		const root = await temporaryRoot("sumocode-startup-shutdown-failure-");
		const baselineDir = join(root, "baseline");
		const candidateDir = join(root, "candidate");
		const outDir = await temporaryRoot("sumocode-startup-shutdown-failure-report-");
		await Promise.all([mkdir(baselineDir), mkdir(candidateDir)]);
		let spawnCount = 0;
		let cleanupCalled = false;
		let retainedCampaign;
		const report = await runStartupComparison({
			callerRoot: root,
			baseRef: "base",
			candidateRef: "candidate",
			samples: 2,
			fixtureCount: 1,
			outDir,
		}, {
			resolveRevision: async (ref) => ref === "base" ? "1".repeat(40) : "2".repeat(40),
			assertClean: async () => undefined,
			prepareWorktrees: async () => ({
				baselineDir,
				candidateDir,
				cleanup: async () => { cleanupCalled = true; },
			}),
			spawnSamplePty: (_command, _args, options) => {
				spawnCount += 1;
				const events = diagnostics(Date.now(), "baseline", 0);
				writeFileSync(options.env.SUMO_TUI_DIAG_FILE, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
				return { onExit: () => undefined, kill: () => undefined };
			},
			machineMetadata: () => ({ platform: "test", arch: "test", nodeVersion: "v-test", cpuCount: 1 }),
			onFixtureRetained: (path) => {
				retainedCampaign = path;
				roots.push(path);
			},
		});

		expect(report.arms.baseline.samples[0]).toMatchObject({ ok: false, failure: "shutdown-failed" });
		expect(report.arms.candidate.samples).toEqual([]);
		expect(report.fixture.retained).toBe(true);
		expect(report.fixture.reason).toBe("live-process");
		expect(spawnCount).toBe(1);
		expect(cleanupCalled).toBe(false);
		expect(retainedCampaign).toEqual(expect.any(String));
		expect(report.collection.succeeded).toBe(false);
		expect(await readFile(join(outDir, "startup-compare.md"), "utf8")).not.toContain("retained by explicit request");
	});

	it("smoke-compares two distinct exact local revisions in detached worktrees", async () => {
		const root = await temporaryRoot("sumocode-startup-revision-smoke-");
		const callerRoot = join(root, "repo");
		const outDir = await temporaryRoot("sumocode-startup-revision-report-");
		await mkdir(join(callerRoot, "node_modules"), { recursive: true });
		await execFileAsync("git", ["init", "-q"], { cwd: callerRoot });
		await writeFile(join(callerRoot, "revision.txt"), "baseline\n");
		await execFileAsync("git", ["add", "revision.txt"], { cwd: callerRoot });
		await execFileAsync("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "baseline"], { cwd: callerRoot });
		const { stdout: baselineStdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: callerRoot });
		const baselineSha = baselineStdout.trim();
		await writeFile(join(callerRoot, "revision.txt"), "candidate\n");
		await execFileAsync("git", ["add", "revision.txt"], { cwd: callerRoot });
		await execFileAsync("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "candidate"], { cwd: callerRoot });

		const report = await runStartupComparison({
			callerRoot,
			baseRef: baselineSha,
			candidateRef: "HEAD",
			samples: 1,
			fixtureCount: 1,
			outDir,
		}, {
			runSample: async ({ arm, index, startWallMs }) => ({ ok: true, events: diagnostics(startWallMs, arm, index) }),
			machineMetadata: () => ({ platform: "test", arch: "test", nodeVersion: "v-test", cpuCount: 1 }),
		});

		expect(report.baselineSha).toBe(baselineSha);
		expect(report.candidateSha).not.toBe(baselineSha);
		expect(report.arms.baseline.samples[0].ok).toBe(true);
		expect(report.arms.candidate.samples[0].ok).toBe(true);
		expect((await execFileAsync("git", ["status", "--porcelain"], { cwd: callerRoot })).stdout).toBe("");
	});

	it("keeps single-sample smoke results inconclusive and explains the sample floor", async () => {
		const { report, outDir } = await harness({ samples: 1, fixtureCount: 1 });
		expect(report.metrics.every((metric) => metric.verdict === "inconclusive")).toBe(true);
		expect(report.overall).toEqual({
			verdict: "INCONCLUSIVE",
			reason: "fewer than 3 successful samples per arm",
		});
		expect(await readFile(join(outDir, "startup-compare.md"), "utf8")).toContain("at least 3 successful samples per arm");
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
