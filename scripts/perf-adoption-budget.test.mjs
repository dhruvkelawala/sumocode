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
		baseline: { sourceCommit: "a".repeat(40), samples: 15 },
		budgets: Object.fromEntries(Object.entries(measurements()).map(([name, measurement]) => [name, {
			baseline: measurement.kind === "timing" ? measurement.medianMs : measurement.value,
			max: measurement.kind === "timing" ? measurement.medianMs + 5 : measurement.value + 100,
		}])),
	};
}

describe("adoption performance budget", () => {
	it("commits a complete reviewed pre-adoption record", async () => {
		const committed = JSON.parse(await readFile(new URL("../docs/perf/adoption-baseline.json", import.meta.url), "utf8"));
		expect(committed).toMatchObject({
			schemaVersion: 1,
			baseline: {
				sourceCommit: expect.stringMatching(/^[0-9a-f]{40}$/),
				samples: 15,
			},
		});
		for (const [name, budget] of Object.entries(committed.budgets)) {
			expect(budget.max, name).toBeGreaterThanOrEqual(budget.baseline);
			const observation = committed.baseline.measurements[name];
			if (name.endsWith("-ms")) expect(observation.samples, name).toHaveLength(15);
			else expect(observation, name).toBe(budget.baseline);
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
		expect(evaluateAdoptionBudget({}, policy()).verdict).toBe("failed");
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
			machineMetadata: async () => ({ platform: "test", arch: "test", node: "test", bun: "test" }),
		});
		expect(report.gate.failedChecks).toContain("source-host-import-ms:policy");
		expect(await readFile(join(reportDir, "report.md"), "utf8")).toContain("| source-host-import-ms | — | — | 100ms |");
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
			machineMetadata: async () => ({ platform: "test", arch: "test", node: "test", bun: "test" }),
		});
		expect(report).toMatchObject({
			source: { sourceCommit: "b".repeat(40), sourceClean: true },
			nativeArtifact: { sourceCommit: "b".repeat(40), artifactSha256: "2".repeat(64) },
			gate: { verdict: "passed" },
		});
		expect(JSON.parse(await readFile(join(reportDir, "results.json"), "utf8"))).not.toHaveProperty("nativeArtifact.artifactDir");
	});
});
