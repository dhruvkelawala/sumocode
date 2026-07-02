#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import { loadScenarioRegistry } from "./scenario-registry.mjs";
import { cropStyledGrid, diffStyledGrids, runtimeStyledGrid, styledDiffToText } from "./styled-cell-grid.mjs";
import { ensureDir, readJson, resetDir, writeFile, writeJson } from "./fs-utils.mjs";
import { repoRoot } from "./paths.mjs";

const args = parseArgs(process.argv.slice(2));
const baselineRoot = resolvePathArg(args.baselineRoot, "baseline-root");
const candidateRoot = resolvePathArg(args.candidateRoot, "candidate-root");
const outputRoot = resolve(args.outputRoot ?? resolve(repoRoot, "docs", "visual", "out", "parity-main-rpc"));
const registry = loadScenarioRegistry();
const scenarios = registry.listScenarios({ id: args.scenario, lane: args.lane });

if (scenarios.length === 0) {
	console.error(`No scenarios matched ${JSON.stringify({ scenario: args.scenario, lane: args.lane })}`);
	process.exit(1);
}

resetDir(outputRoot);

const results = {
	version: 1,
	generatedAt: new Date().toISOString(),
	baselineRoot,
	candidateRoot,
	scenarios: [],
};

let failures = 0;
console.log(`[visual-v2] compare ${scenarios.length} scenario(s)`);
for (const scenario of scenarios) {
	process.stdout.write(`  ${scenario.id.padEnd(32)} `);
	try {
		const result = compareScenario(scenario);
		results.scenarios.push(result);
		if (result.result === "failed") failures += 1;
		console.log(result.result.toUpperCase());
	} catch (error) {
		failures += 1;
		results.scenarios.push({
			id: scenario.id,
			lane: scenario.lane,
			result: "failed",
			error: error?.stack ?? String(error),
		});
		console.log("FAIL");
		console.error(`      ${error.message}`);
	}
}

writeJson(resolve(outputRoot, "results.json"), results);
writeFile(resolve(outputRoot, "summary.md"), summaryMarkdown(results));
console.log(`[visual-v2] comparison results: ${resolve(outputRoot, "results.json")}`);
if (failures > 0) process.exit(1);

function compareScenario(scenario) {
	const scenarioOut = resolve(outputRoot, scenario.id);
	const rawOut = resolve(scenarioOut, "raw");
	const contractValidation = validateCaptureContracts(scenario, baselineRoot, candidateRoot);
	writeFile(resolve(rawOut, "contract-validation.txt"), contractValidationToText(contractValidation));
	if (!contractValidation.passed) {
		return {
			id: scenario.id,
			lane: scenario.lane,
			result: "failed",
			contractValidation: {
				passed: false,
				artifact: resolve(rawOut, "contract-validation.txt"),
				mismatches: contractValidation.mismatches,
			},
			crops: [],
		};
	}
	const baselineSnapshot = readSnapshot(baselineRoot, scenario.id);
	const candidateSnapshot = readSnapshot(candidateRoot, scenario.id);
	const baselineGrid = runtimeStyledGrid(baselineSnapshot);
	const candidateGrid = runtimeStyledGrid(candidateSnapshot);
	const fullDiff = diffStyledGrids(baselineGrid, candidateGrid);
	writeFile(resolve(rawOut, "styled-cell-diff.txt"), styledDiffToText(fullDiff));
	writeFile(resolve(rawOut, "geometry-audit.txt"), geometrySummary(baselineRoot, candidateRoot, scenario.id));

	const crops = scenario.crops.map((crop) => compareCrop(scenario, crop, baselineGrid, candidateGrid, scenarioOut));
	const failed = !fullDiff.passed || crops.some((crop) => crop.result === "failed");
	return {
		id: scenario.id,
		lane: scenario.lane,
		result: failed ? "failed" : "passed",
		cellDiff: {
			passed: fullDiff.passed,
			diffRows: fullDiff.rowDiffs.length,
			artifact: resolve(rawOut, "styled-cell-diff.txt"),
		},
		geometryAudit: {
			artifact: resolve(rawOut, "geometry-audit.txt"),
		},
		contractValidation: {
			passed: true,
			artifact: resolve(rawOut, "contract-validation.txt"),
			mismatches: [],
		},
		crops,
	};
}

function compareCrop(scenario, crop, baselineGrid, candidateGrid, scenarioOut) {
	const cropOut = resolve(scenarioOut, "crops");
	const cellDiff = diffStyledGrids(
		cropStyledGrid(baselineGrid, crop.runtimeCrop),
		cropStyledGrid(candidateGrid, crop.runtimeCrop),
	);
	const styledArtifact = resolve(scenarioOut, "raw", `styled-cell-diff-${crop.id}.txt`);
	writeFile(styledArtifact, styledDiffToText(cellDiff));

	const baselinePngPath = resolve(baselineRoot, scenario.id, "crops", `${crop.id}-runtime.png`);
	const candidatePngPath = resolve(candidateRoot, scenario.id, "crops", `${crop.id}-runtime.png`);
	const png = comparePngFiles(baselinePngPath, candidatePngPath, resolve(cropOut, `${crop.id}-diff.png`), crop.threshold);
	return {
		id: crop.id,
		status: crop.status,
		result: cellDiff.passed && png.passed ? "passed" : "failed",
		styledCellDiff: {
			passed: cellDiff.passed,
			diffRows: cellDiff.rowDiffs.length,
			artifact: styledArtifact,
		},
		png,
		artifacts: {
			baseline: baselinePngPath,
			candidate: candidatePngPath,
			diff: resolve(cropOut, `${crop.id}-diff.png`),
		},
	};
}

function readSnapshot(root, scenarioId) {
	const path = resolve(root, scenarioId, "raw", "terminal-snapshot.json");
	if (!existsSync(path)) throw new Error(`Missing terminal snapshot: ${path}`);
	return readJson(path);
}

function readCaptureMetadata(root, scenarioId) {
	const path = resolve(root, scenarioId, "raw", "capture-metadata.json");
	if (!existsSync(path)) throw new Error(`Missing capture metadata: ${path}`);
	return readJson(path);
}

function validateCaptureContracts(scenario, baselineRoot, candidateRoot) {
	const expected = scenarioContractForMetadata(scenario);
	const baseline = captureContractFromMetadata("baseline", scenario, expected, readCaptureMetadata(baselineRoot, scenario.id));
	const candidate = captureContractFromMetadata("candidate", scenario, expected, readCaptureMetadata(candidateRoot, scenario.id));
	const mismatches = [...baseline.mismatches, ...candidate.mismatches];
	const warnings = [...baseline.warnings, ...candidate.warnings];
	if (baseline.contract && candidate.contract && stableJson(baseline.contract) !== stableJson(candidate.contract)) {
		mismatches.push({ root: "baseline/candidate", reason: "capture roots were produced from different scenario contracts" });
	}
	return { passed: mismatches.length === 0, mismatches, warnings };
}

function captureContractFromMetadata(root, scenario, expected, metadata) {
	if (metadata.scenarioContract) {
		if (stableJson(metadata.scenarioContract) === stableJson(expected)) {
			return { contract: metadata.scenarioContract, mismatches: [], warnings: [] };
		}
		return {
			contract: metadata.scenarioContract,
			mismatches: [{ root, reason: "scenario contract differs from current manifest", expected, actual: metadata.scenarioContract }],
			warnings: [],
		};
	}

	const legacyMismatches = legacyMetadataMismatches(scenario, expected, metadata);
	if (legacyMismatches.length > 0) {
		return {
			contract: null,
			mismatches: legacyMismatches.map((reason) => ({ root, reason })),
			warnings: [],
		};
	}

	return {
		contract: expected,
		mismatches: [],
		warnings: [{
			root,
			reason: "legacy capture metadata accepted after checking command, args, dimensions, and runtime input count",
		}],
	};
}

function legacyMetadataMismatches(scenario, expected, metadata) {
	if (scenario.lane !== "runtime" || !expected.runtime) return ["missing scenarioContract metadata"];
	const mismatches = [];
	if (metadata.command !== expected.runtime.command) {
		mismatches.push(`legacy metadata command differs from current manifest: ${JSON.stringify(metadata.command)} !== ${JSON.stringify(expected.runtime.command)}`);
	}
	if (stableJson(metadata.args ?? []) !== stableJson(expected.runtime.args)) {
		mismatches.push(`legacy metadata args differ from current manifest: ${stableJson(metadata.args ?? [])} !== ${stableJson(expected.runtime.args)}`);
	}
	if (metadata.cols !== expected.dimensions.cols || metadata.rows !== expected.dimensions.rows) {
		mismatches.push(`legacy metadata dimensions differ from current manifest: ${metadata.cols}x${metadata.rows} !== ${expected.dimensions.cols}x${expected.dimensions.rows}`);
	}
	const expectedInputCount = expected.runtime.inputs.length;
	if (metadata.inputCount !== expectedInputCount) {
		mismatches.push(`legacy metadata inputCount differs from current manifest: ${metadata.inputCount} !== ${expectedInputCount}`);
	}
	return mismatches;
}

function contractValidationToText(validation) {
	if (validation.passed) {
		const lines = ["Scenario contract validation: MATCH"];
		for (const warning of validation.warnings ?? []) {
			lines.push(`- ${warning.root}: ${warning.reason}`);
		}
		lines.push("");
		return lines.join("\n");
	}
	const lines = ["Scenario contract validation: FAILED", ""];
	for (const mismatch of validation.mismatches) {
		lines.push(`- ${mismatch.root}: ${mismatch.reason}`);
		if (mismatch.expected) lines.push(`  expected: ${stableJson(mismatch.expected)}`);
		if (mismatch.actual) lines.push(`  actual:   ${stableJson(mismatch.actual)}`);
	}
	lines.push("");
	return lines.join("\n");
}

function scenarioContractForMetadata(scenario) {
	return {
		id: scenario.id,
		lane: scenario.lane,
		dimensions: {
			cols: scenario.dimensions.cols,
			rows: scenario.dimensions.rows,
		},
		runtime: scenario.runtime ? {
			command: scenario.runtime.command,
			args: scenario.runtime.args ?? [],
			env: sortedRecord(scenario.runtime.env ?? {}),
			inputs: scenario.runtime.inputs ?? [],
		} : null,
		fixture: scenario.fixture ?? null,
		crops: scenario.crops.map((crop) => ({
			id: crop.id,
			status: crop.status,
			threshold: crop.threshold,
			targetImage: crop.targetImage,
			targetCropId: crop.targetCropId,
			runtimeCropId: crop.runtimeCropId,
			targetDimensions: crop.targetDimensions ?? null,
			runtimeDimensions: crop.runtimeDimensions ?? null,
		})),
	};
}

function sortedRecord(record) {
	return Object.fromEntries(Object.entries(record).sort(([left], [right]) => left.localeCompare(right)));
}

function stableJson(value) {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.entries(value)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

function geometrySummary(baseline, candidate, scenarioId) {
	const baselineText = readOptional(resolve(baseline, scenarioId, "raw", "geometry-audit.txt"));
	const candidateText = readOptional(resolve(candidate, scenarioId, "raw", "geometry-audit.txt"));
	return [
		"# Main baseline geometry audit",
		baselineText.trim() || "(missing)",
		"",
		"# Candidate geometry audit",
		candidateText.trim() || "(missing)",
		"",
	].join("\n");
}

function comparePngFiles(baselinePath, candidatePath, diffPath, threshold) {
	if (!existsSync(baselinePath)) throw new Error(`Missing baseline crop: ${baselinePath}`);
	if (!existsSync(candidatePath)) throw new Error(`Missing candidate crop: ${candidatePath}`);
	const baseline = PNG.sync.read(readFileSync(baselinePath));
	const candidate = PNG.sync.read(readFileSync(candidatePath));
	const width = Math.max(baseline.width, candidate.width);
	const height = Math.max(baseline.height, candidate.height);
	const paddedBaseline = padPng(baseline, width, height);
	const paddedCandidate = padPng(candidate, width, height);
	const diff = new PNG({ width, height });
	const diffPixels = pixelmatch(paddedBaseline.data, paddedCandidate.data, diff.data, width, height, {
		threshold: 0.1,
		includeAA: false,
		aaColor: [232, 179, 57],
		diffColor: [193, 68, 62],
	});
	ensureDir(dirname(diffPath));
	writeFile(diffPath, PNG.sync.write(diff));
	const totalPixels = width * height;
	const diffRatio = totalPixels === 0 ? 0 : diffPixels / totalPixels;
	return {
		width,
		height,
		diffPixels,
		totalPixels,
		diffRatio,
		threshold,
		passed: diffRatio <= threshold,
		dimensionMismatch: baseline.width !== candidate.width || baseline.height !== candidate.height,
	};
}

function padPng(source, width, height) {
	if (source.width === width && source.height === height) return source;
	const out = new PNG({ width, height });
	for (let index = 0; index < out.data.length; index += 4) {
		out.data[index] = 26;
		out.data[index + 1] = 21;
		out.data[index + 2] = 17;
		out.data[index + 3] = 255;
	}
	for (let y = 0; y < source.height; y += 1) {
		for (let x = 0; x < source.width; x += 1) {
			const sourceIndex = (y * source.width + x) * 4;
			const targetIndex = (y * width + x) * 4;
			out.data[targetIndex] = source.data[sourceIndex];
			out.data[targetIndex + 1] = source.data[sourceIndex + 1];
			out.data[targetIndex + 2] = source.data[sourceIndex + 2];
			out.data[targetIndex + 3] = source.data[sourceIndex + 3];
		}
	}
	return out;
}

function readOptional(path) {
	return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function summaryMarkdown(results) {
	const failedScenarios = results.scenarios.filter((scenario) => scenario.result === "failed").length;
	const cropCount = results.scenarios.reduce((total, scenario) => total + (scenario.crops?.length ?? 0), 0);
	const failedCrops = results.scenarios.reduce(
		(total, scenario) => total + (scenario.crops?.filter((crop) => crop.result === "failed").length ?? 0),
		0,
	);
	const lines = [
		"# Main vs RPC Visual Comparison",
		"",
		`- Generated: ${results.generatedAt}`,
		`- Baseline root: \`${results.baselineRoot}\``,
		`- Candidate root: \`${results.candidateRoot}\``,
		`- Scenarios: ${results.scenarios.length}`,
		`- Failed scenarios: ${failedScenarios}`,
		`- Crops: ${cropCount}`,
		`- Failed crops: ${failedCrops}`,
		"",
		"| Scenario | Lane | Result | Cell diff rows | Failed crops |",
		"|---|---|---|---:|---:|",
	];
	for (const scenario of results.scenarios) {
		const failed = scenario.crops?.filter((crop) => crop.result === "failed").length ?? 0;
		lines.push(`| ${scenario.id} | ${scenario.lane} | ${scenario.result} | ${scenario.cellDiff?.diffRows ?? "n/a"} | ${failed} |`);
	}
	lines.push("");
	return `${lines.join("\n")}\n`;
}

function parseArgs(argv) {
	const parsed = {};
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--") continue;
		if (arg === "--baseline-root") parsed.baselineRoot = argv[++index];
		else if (arg === "--candidate-root") parsed.candidateRoot = argv[++index];
		else if (arg === "--out") parsed.outputRoot = argv[++index];
		else if (arg === "--scenario") parsed.scenario = argv[++index];
		else if (arg === "--lane") parsed.lane = argv[++index];
		else throw new Error(`Unknown visual-v2 compare argument: ${arg}`);
	}
	return parsed;
}

function resolvePathArg(value, name) {
	if (!value) {
		console.error(`Usage: pnpm visual:compare -- --baseline-root <main-out> --candidate-root <branch-out> [--scenario id] [--lane runtime] [--out path]`);
		process.exit(2);
	}
	return resolve(value);
}
