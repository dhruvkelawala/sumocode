import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	evaluateAdoptionBudget,
	evaluateBundle,
	evaluationSample,
	instrumentExtensionBundle,
	runAdoptionBudget,
} from "./perf-adoption-budget.mjs";
import { ptyTreeAlive, waitForTreeExit } from "./perf-startup-compare.mjs";

const roots = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const timing = (medianMs, count = 15, failures = 0) => ({
	kind: "timing",
	samples: Array.from({ length: count }, () => medianMs),
	failures,
	medianMs,
	madMs: 0,
});
const size = (value) => ({ kind: "size", value });

function measurements() {
	return {
		"source-host-import-ms": timing(100),
		"source-classic-extension-bytes": size(1_000),
		"source-classic-extension-eval-ms": timing(20),
		"source-rpc-extension-bytes": size(800),
		"source-rpc-extension-eval-ms": timing(15),
		"native-classic-extension-bytes": size(1_200),
		"native-classic-extension-eval-ms": timing(12),
		"native-rpc-extension-bytes": size(900),
		"native-rpc-extension-eval-ms": timing(10),
	};
}

function policy() {
	return {
		schemaVersion: 1,
		status: "reviewed",
		baseline: {
			sourceCommit: "a".repeat(40),
			samples: 15,
			machine: { platform: "test", arch: "test", node: "test", bun: "test", cpu: "test" },
		},
		budgets: Object.fromEntries(Object.entries(measurements()).map(([name, measurement]) => [name, {
			baseline: measurement.kind === "timing" ? measurement.medianMs : measurement.value,
			max: measurement.kind === "timing" ? measurement.medianMs + 5 : measurement.value + 100,
		}])),
	};
}

async function withTermIgnoringDescendant(run) {
	const workDir = await mkdtemp(join(tmpdir(), "sumocode-adoption-descendant-"));
	roots.push(workDir);
	const command = join(workDir, "pi-fixture.cjs");
	const launches = join(workDir, "launches.jsonl");
	await writeFile(command, `#!${process.execPath}
const { fork } = require("node:child_process");
const fs = require("node:fs");
if (process.argv[2] === "descendant") {
	process.on("SIGTERM", () => fs.writeFileSync(${JSON.stringify(join(workDir, "descendant-term"))}, "ignored"));
	setInterval(() => {}, 1000);
	process.send("ready");
} else {
	process.on("SIGTERM", () => process.exit(0));
	const child = fork(__filename, ["descendant"], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
	child.once("message", () => {
		fs.appendFileSync(${JSON.stringify(launches)}, JSON.stringify({ pid: process.pid, descendant: child.pid }) + "\\n");
		fs.writeFileSync(process.env.SUMO_TUI_DIAG_FILE, [
			{ event: "sumocode_extension_eval_start", ts: 100 },
			{ event: "sumocode_extension_eval_end", ts: 110 },
		].map(JSON.stringify).join("\\n") + "\\n");
		console.log(JSON.stringify({ type: "response", id: "budget-probe", command: "get_state", success: true }));
	});
	process.stdin.resume();
}
`);
	await chmod(command, 0o700);
	try { await run({ command, workDir, launches }); }
	finally {
		const children = (await readFile(launches, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map(JSON.parse);
		for (const child of children) {
			try { process.kill(-child.pid, "SIGKILL"); }
			catch (error) { expect(error?.code).toBe("ESRCH"); }
			await waitForTreeExit(() => ptyTreeAlive(child, true), 1_000);
			expect(ptyTreeAlive(child, true)).toBe(false);
		}
	}
}

describe("adoption performance budget", () => {
	it.skipIf(process.platform === "win32")("reaps a TERM-ignoring descendant even after its leader exits on TERM", async () => {
		await withTermIgnoringDescendant(async ({ command, workDir, launches }) => {
			const sample = await evaluationSample({ command, bundlePath: "fixture.mjs", root: workDir, native: true, workDir, index: 0 });
			expect(sample).toEqual({ ok: true, durationMs: 10 });
			expect(await readFile(join(workDir, "descendant-term"), "utf8")).toBe("ignored");
			const child = JSON.parse((await readFile(launches, "utf8")).trim());
			expect(ptyTreeAlive(child, true)).toBe(false);
			expect(() => process.kill(child.descendant, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
		});
	});

	it.skipIf(process.platform === "win32")("aborts evaluation collection and retains evidence when group emptiness is unproven", async () => {
		await withTermIgnoringDescendant(async ({ command, workDir, launches }) => {
			await expect(evaluateBundle(command, "fixture.mjs", workDir, true, workDir, { treeAlive: () => true }))
				.rejects.toThrow(`evidence retained: ${workDir}`);
			const children = (await readFile(launches, "utf8")).trim().split("\n").map(JSON.parse);
			expect(children).toHaveLength(1);
			expect(JSON.parse(await readFile(join(workDir, "shutdown-failure.json"), "utf8")))
				.toMatchObject({ ok: false, failure: "shutdown-failed", index: 0, processGroupId: children[0].pid });
			expect(await readFile(join(workDir, "agent-native-0/startup.jsonl"), "utf8")).toContain("sumocode_extension_eval_end");
		});
	});

	it("treats only ESRCH as proof that a process group is empty", () => {
		const kill = vi.spyOn(process, "kill");
		try {
			for (const code of ["EPERM", "EIO", "ESRCH"]) {
				kill.mockImplementation(() => { throw Object.assign(new Error(code), { code }); });
				expect(ptyTreeAlive({ pid: 12345 }, true)).toBe(code !== "ESRCH");
			}
		} finally { kill.mockRestore(); }
	});

	it("requires explicit review and complete new evidence before accepting the integration baseline", async () => {
		const committed = JSON.parse(await readFile(new URL("../docs/perf/adoption-baseline.json", import.meta.url), "utf8"));
		expect(committed).toMatchObject({
			schemaVersion: 1,
			baseline: {
				integrationBase: "97897ae98c052e5defde6f40e0da18ffe39a001f",
				sourceCommit: expect.stringMatching(/^[0-9a-f]{40}$/),
				samples: 15,
			},
		});
		if (committed.status === "pending") {
			expect(committed.baseline.measurements).toEqual({});
			expect(committed.budgets).toEqual({});
			expect(evaluateAdoptionBudget({ measurements: measurements() }, committed).verdict).toBe("failed");
			return;
		}
		expect(committed.status).toBe("reviewed");
		for (const name of Object.keys(measurements())) {
			const budget = committed.budgets[name];
			expect(budget.max, name).toBeGreaterThanOrEqual(budget.baseline);
			const observation = committed.baseline.measurements[name];
			if (name.endsWith("-ms")) {
				expect(observation.samples, name).toHaveLength(15);
				expect(observation.samples.every(Number.isFinite), name).toBe(true);
				expect(observation.failures, name).toBe(0);
				expect(observation.medianMs, name).toBe(budget.baseline);
			} else expect(observation.kind === "size" ? observation.value : observation, name).toBe(budget.baseline);
		}
	});

	it("passes complete observations within every reviewed ceiling", () => {
		expect(evaluateAdoptionBudget({ measurements: measurements() }, policy())).toEqual({ verdict: "passed", failedChecks: [] });
	});

	it("fails size, evaluation, host-import, and incomplete collections visibly", () => {
		const observed = measurements();
		observed["source-host-import-ms"] = timing(106);
		observed["source-rpc-extension-eval-ms"] = timing(15, 14);
		observed["native-classic-extension-bytes"] = size(1_301);
		expect(evaluateAdoptionBudget({ measurements: observed }, policy())).toEqual({
			verdict: "failed",
			failedChecks: [
				"source-host-import-ms:budget",
				"source-rpc-extension-eval-ms:collection",
				"native-classic-extension-bytes:budget",
			],
		});
		expect(evaluateAdoptionBudget({}, policy()).failedChecks).toContain("source-host-import-ms:collection");
	});

	it("rejects absent budgets and non-finite raw timing samples", () => {
		expect(evaluateAdoptionBudget({}, { status: "reviewed", budgets: {} }).verdict).toBe("failed");
		const observed = measurements();
		observed["source-host-import-ms"].samples[0] = null;
		expect(evaluateAdoptionBudget({ measurements: observed }, policy()).failedChecks).toContain("source-host-import-ms:collection");
		observed["source-host-import-ms"] = size(1);
		expect(evaluateAdoptionBudget({ measurements: observed }, policy()).failedChecks).toContain("source-host-import-ms:collection");
	});

	it("wraps bundle evaluation marks around the emitted module body", () => {
		const source = instrumentExtensionBundle("export default function extension() {}\n");
		expect(source.indexOf('"sumocode_extension_eval_start"')).toBeLessThan(source.indexOf("export default"));
		expect(source.indexOf('"sumocode_extension_eval_end"')).toBeGreaterThan(source.indexOf("export default"));
	});

	it("reports a missing reviewed budget as a policy failure", async () => {
		const outDir = await mkdtemp(join(tmpdir(), "sumocode-adoption-missing-policy-"));
		roots.push(outDir);
		const baseline = policy();
		delete baseline.budgets["source-host-import-ms"];
		const reportDir = join(outDir, "report");
		const report = await runAdoptionBudget({ nativeDir: "/native", outDir: reportDir }, {
			readBaseline: async () => baseline,
			readSourceIdentity: async () => ({ sourceCommit: "b".repeat(40), sourceClean: true }),
			readArtifact: async () => ({ artifactDir: "/native", sourceCommit: "b".repeat(40), sourceClean: true, artifactSha256: "2".repeat(64) }),
			collectMeasurements: async () => measurements(),
			machineMetadata: async () => ({ platform: "test", arch: "test", node: "test", bun: "test", cpu: "test" }),
		});
		expect(report.gate.failedChecks).toContain("source-host-import-ms:policy");
		expect(await readFile(join(reportDir, "report.md"), "utf8")).toContain("| source-host-import-ms | — | — | 100ms |");
	});

	it("rejects a different measurement machine before collection", async () => {
		const outDir = await mkdtemp(join(tmpdir(), "sumocode-adoption-machine-"));
		roots.push(outDir);
		await expect(runAdoptionBudget({ nativeDir: "/native", outDir }, {
			readBaseline: async () => policy(),
			readSourceIdentity: async () => ({ sourceCommit: "b".repeat(40), sourceClean: true }),
			readArtifact: async () => ({ artifactDir: "/native", sourceCommit: "b".repeat(40), sourceClean: true, artifactSha256: "2".repeat(64) }),
			machineMetadata: async () => ({ platform: "other", arch: "test", node: "test", bun: "test", cpu: "test" }),
			collectMeasurements: async () => { throw new Error("must not collect"); },
		})).rejects.toThrow("machine mismatch: platform");
	});

	it("collects unreviewed evidence without accepting or rewriting budgets", async () => {
		const outDir = await mkdtemp(join(tmpdir(), "sumocode-adoption-collect-"));
		roots.push(outDir);
		const baseline = { ...policy(), status: "pending", budgets: {} };
		const before = JSON.stringify(baseline);
		const dependencies = {
			readBaseline: async () => baseline,
			readSourceIdentity: async () => ({ sourceCommit: "b".repeat(40), sourceClean: true }),
			readArtifact: async () => ({ artifactDir: "/native", sourceCommit: "b".repeat(40), sourceClean: true, artifactSha256: "2".repeat(64) }),
			machineMetadata: async () => ({ platform: "other" }),
			collectMeasurements: async () => measurements(),
		};
		await expect(runAdoptionBudget({ nativeDir: "/native", outDir }, dependencies)).rejects.toThrow("pending quiet-machine");
		const report = await runAdoptionBudget({ nativeDir: "/native", outDir, collectOnly: true }, dependencies);
		expect(report.gate.verdict).toBe("unreviewed");
		expect(JSON.stringify(baseline)).toBe(before);
		const failedDir = join(outDir, "failed");
		const failed = await runAdoptionBudget({ nativeDir: "/native", outDir: failedDir, collectOnly: true }, {
			...dependencies,
			collectMeasurements: async () => ({ "source-host-import-ms": timing(100, 14) }),
		});
		expect(failed.gate.verdict).toBe("failed");
	});

	it("records source and native identities without a baseline write path", async () => {
		const outDir = await mkdtemp(join(tmpdir(), "sumocode-adoption-budget-"));
		roots.push(outDir);
		const baseline = policy();
		const reportDir = join(outDir, "report");
		const observed = measurements();
		const report = await runAdoptionBudget({ nativeDir: "/native", outDir: reportDir }, {
			readBaseline: async () => baseline,
			readSourceIdentity: async () => ({ sourceCommit: "b".repeat(40), sourceClean: true }),
			readArtifact: async () => ({ artifactDir: "/native", sourceCommit: "b".repeat(40), sourceClean: true, artifactSha256: "2".repeat(64) }),
			collectMeasurements: async () => observed,
			machineMetadata: async () => ({ platform: "test", arch: "test", node: "test", bun: "test", cpu: "test" }),
		});
		expect(report).toMatchObject({
			source: { sourceCommit: "b".repeat(40), sourceClean: true },
			nativeArtifact: { sourceCommit: "b".repeat(40), artifactSha256: "2".repeat(64) },
			gate: { verdict: "passed" },
		});
		expect(JSON.parse(await readFile(join(reportDir, "results.json"), "utf8"))).not.toHaveProperty("nativeArtifact.artifactDir");
	});
});
