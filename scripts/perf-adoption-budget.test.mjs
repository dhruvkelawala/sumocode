import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	evaluateAdoptionBudget,
	instrumentExtensionBundle,
	runAdoptionBudget,
} from "./perf-adoption-budget.mjs";

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

describe("adoption performance budget", () => {
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
