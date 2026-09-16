import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { evaluateNativeGate, nativeCompareOptions, runNativeComparison } from "./perf-native-compare.mjs";

const roots = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function arm(editor, command, gap, options = {}) {
	return {
		samples: Array.from({ length: options.count ?? 15 }, (_, index) => options.failure && index === 0
			? { index, ok: false, failure: "missing-events:command_ready" }
			: { index, ok: true, editorReadyMs: editor, commandReadyMs: command, editorToCommandGapMs: gap }),
	};
}

function report({ baseline = arm(100, 200, 100), candidate = arm(105, 200, 95) } = {}) {
	return { samplesPerArm: 15, arms: { baseline, candidate } };
}

describe("native artifact comparison", () => {
	it("requires two explicit artifacts and fixes collection at 15 samples per arm", () => {
		expect(nativeCompareOptions(["--baseline", "/a", "--candidate", "/b"])).toMatchObject({
			baselineDir: "/a",
			candidateDir: "/b",
			fixtureCount: 0,
		});
		expect(() => nativeCompareOptions(["--baseline", "/a"])).toThrow("--candidate is required");
		expect(() => nativeCompareOptions(["--baseline", "/a", "--candidate", "/b", "--samples", "5"])).toThrow("unknown option");
	});

	it("records exact source/artifact identities and alternating raw timings", async () => {
		const outDir = await mkdtemp(join(tmpdir(), "sumocode-native-compare-report-"));
		roots.push(outDir);
		const seen = [];
		const identities = {
			"/baseline": { artifactDir: "/baseline", sourceCommit: "a".repeat(40), sourceClean: true, artifactSha256: "1".repeat(64) },
			"/candidate": { artifactDir: "/candidate", sourceCommit: "b".repeat(40), sourceClean: true, artifactSha256: "2".repeat(64) },
		};
		const result = await runNativeComparison({ baselineDir: "/baseline", candidateDir: "/candidate", fixtureCount: 0, outDir }, {
			readBaselineIdentity: async () => ({ sourceCommit: "a".repeat(40) }),
			readArtifact: async (path) => identities[path],
			runSample: async ({ arm: name, index, agentDir }) => {
				seen.push({ name, index, agentDir });
				return { index, ok: true, editorReadyMs: 100, commandReadyMs: 200, editorToCommandGapMs: name === "baseline" ? 100 : 99 };
			},
			machineMetadata: async () => ({ platform: "test", arch: "test", cpu: "test", bun: "test" }),
		});

		expect(result.artifacts).toEqual({
			baseline: { sourceCommit: "a".repeat(40), sourceClean: true, artifactSha256: "1".repeat(64) },
			candidate: { sourceCommit: "b".repeat(40), sourceClean: true, artifactSha256: "2".repeat(64) },
		});
		expect(result.arms.baseline.samples).toHaveLength(15);
		expect(result.arms.candidate.samples).toHaveLength(15);
		expect(seen.slice(0, 4).map(({ name }) => name)).toEqual(["baseline", "candidate", "candidate", "baseline"]);
		expect(new Set(seen.map(({ agentDir }) => agentDir)).size).toBe(1);
		expect(JSON.parse(await readFile(join(outDir, "results.json"), "utf8"))).toMatchObject({ gate: { verdict: "passed" } });
		expect((await readdir(outDir)).filter((name) => name.endsWith(".jsonl"))).toEqual([]);
	});

	it("retains failed-sample diagnostics and reports harness errors visibly", async () => {
		const outDir = await mkdtemp(join(tmpdir(), "sumocode-native-failed-samples-"));
		roots.push(outDir);
		const report = await runNativeComparison({ baselineDir: "/a", candidateDir: "/b", fixtureCount: 0, outDir }, {
			readBaselineIdentity: async () => ({ sourceCommit: "a".repeat(40) }),
			readArtifact: async (path) => ({
				artifactDir: path,
				sourceCommit: path === "/a" ? "a".repeat(40) : "b".repeat(40),
				sourceClean: true,
				artifactSha256: path === "/a" ? "1".repeat(64) : "2".repeat(64),
			}),
			runSample: async ({ diagFile }) => {
				await writeFile(diagFile, "failure evidence\n");
				throw new Error("spawn failed");
			},
			machineMetadata: async () => ({ platform: "test", arch: "test", cpu: "test", bun: "test" }),
		});
		expect(report.gate.failedChecks).toContain("collection");
		expect(report.arms.baseline.samples[0]).toMatchObject({ ok: false, failure: "harness-error" });
		expect(await readFile(join(outDir, "00-baseline.jsonl"), "utf8")).toBe("failure evidence\n");
	});

	it("rejects one artifact presented as both arms", async () => {
		const outDir = await mkdtemp(join(tmpdir(), "sumocode-native-same-artifact-"));
		roots.push(outDir);
		await expect(runNativeComparison({ baselineDir: "/a", candidateDir: "/b", fixtureCount: 0, outDir }, {
			readBaselineIdentity: async () => ({ sourceCommit: "a".repeat(40) }),
			readArtifact: async () => ({ artifactDir: "/same", sourceCommit: "a".repeat(40), sourceClean: true, artifactSha256: "1".repeat(64) }),
		})).rejects.toThrow("distinct native artifacts");
	});

	it("rejects a wrong-source artifact in the pinned baseline arm", async () => {
		const outDir = await mkdtemp(join(tmpdir(), "sumocode-native-wrong-baseline-"));
		roots.push(outDir);
		await expect(runNativeComparison({ baselineDir: "/a", candidateDir: "/b", fixtureCount: 0, outDir }, {
			readBaselineIdentity: async () => ({ sourceCommit: "c".repeat(40) }),
			readArtifact: async (path) => ({
				artifactDir: path,
				sourceCommit: path === "/a" ? "a".repeat(40) : "b".repeat(40),
				sourceClean: true,
				artifactSha256: path === "/a" ? "1".repeat(64) : "2".repeat(64),
			}),
		})).rejects.toThrow("does not match the pinned baseline source");
	});

	it("refuses to overwrite caller report artifacts", async () => {
		const root = await mkdtemp(join(tmpdir(), "sumocode-native-perf-test-"));
		roots.push(root);
		for (const name of ["results.json", "report.md"]) {
			const outDir = join(root, name.replace(".", "-"));
			await mkdir(outDir);
			const artifact = join(outDir, name);
			await writeFile(artifact, "caller-owned");
			await expect(runNativeComparison({ baselineDir: "/a", candidateDir: "/b", outDir, fixtureCount: 0 })).rejects.toThrow(`already contains ${name}`);
			expect(await readFile(artifact, "utf8")).toBe("caller-owned");
		}
	});
});

describe("native regression verdict", () => {
	it("passes only within the baseline MAD editor allowance with no command or gap increase", () => {
		const variedBaseline = arm(100, 200, 100);
		for (let index = 0; index < 7; index += 1) variedBaseline.samples[index].editorReadyMs = 90;
		for (let index = 8; index < 15; index += 1) variedBaseline.samples[index].editorReadyMs = 110;
		expect(evaluateNativeGate(report({ baseline: variedBaseline, candidate: arm(110, 200, 100) })).verdict).toBe("passed");
		expect(evaluateNativeGate(report({ baseline: variedBaseline, candidate: arm(111, 200, 100) })).verdict).toBe("failed");
		expect(evaluateNativeGate(report({ candidate: arm(100, 201, 100) })).failedChecks).toContain("command-ready");
		expect(evaluateNativeGate(report({ candidate: arm(100, 200, 101) })).failedChecks).toContain("editor-to-command-gap");
	});

	it("fails visibly on missing, failed, or incomplete samples", () => {
		expect(evaluateNativeGate(report({ candidate: arm(100, 200, 100, { failure: true }) }))).toMatchObject({
			verdict: "failed",
			failedChecks: expect.arrayContaining(["collection"]),
		});
		expect(evaluateNativeGate(report({ candidate: arm(100, 200, 100, { count: 14 }) })).failedChecks).toContain("collection");
		const missingMetric = arm(100, 200, 100);
		delete missingMetric.samples[0].commandReadyMs;
		expect(evaluateNativeGate(report({ candidate: missingMetric })).failedChecks).toContain("collection");
	});
});
