#!/usr/bin/env node
import { copyFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { captureComponentScenario } from "./component-capture.mjs";
import { captureFixtureScenario } from "./fixture-capture.mjs";
import { captureRuntimeScenario, findRejection } from "./runtime-capture.mjs";
import { replayAnsi } from "./ansi-replay.mjs";
import { renderTerminalSnapshot } from "./terminal-dom-renderer.mjs";
import { compareCropPair } from "./image-compare.mjs";
import { assertScenarioTargetsExist, loadScenarioRegistry } from "./scenario-registry.mjs";
import { outDir } from "./paths.mjs";
import { resetDir, writeFile, writeJson } from "./fs-utils.mjs";
import { writeReviewPack } from "./review-pack.mjs";
import { auditGeometry, auditToText } from "./geometry-audit.mjs";
import { parseBibleStyledGrid, runtimeStyledGrid, cropStyledGrid, diffStyledGrids, styledDiffToText } from "./styled-cell-grid.mjs";
import { evaluateFinalCellAssertions, finalCellContractToText } from "./final-cell-contract.mjs";

const args = parseArgs(process.argv.slice(2));
const mode = args.mode ?? "review";
if (!["review", "ci"].includes(mode)) {
	console.error(`Usage: pnpm visual:review [--scenario id] [--lane component|runtime|fixture]\n       pnpm visual:ci [--scenario id] [--lane component|runtime|fixture]`);
	process.exit(1);
}

const registry = loadScenarioRegistry();
const scenarios = registry.listScenarios({ id: args.scenario, lane: args.lane });
if (scenarios.length === 0) {
	console.error(`No V2 visual scenarios matched ${JSON.stringify({ scenario: args.scenario, lane: args.lane })}`);
	process.exit(1);
}
assertScenarioTargetsExist(scenarios);
resetDir(outDir);

const results = {
	version: 1,
	mode,
	commit: gitRev(),
	generatedAt: new Date().toISOString(),
	scenarios: [],
};

let hardFailures = 0;
let requiredFailures = 0;

console.log(`[visual-v2] ${mode} ${scenarios.length} scenario(s)`);
for (const scenario of scenarios) {
	process.stdout.write(`  ${scenario.id.padEnd(32)} `);
	const started = Date.now();
	try {
		const scenarioResult = await runScenario(scenario);
		results.scenarios.push(scenarioResult);
		if (scenarioResult.result === "failed") {
			hardFailures += 1;
			requiredFailures += scenarioResult.crops.filter((crop) => crop.result === "failed" && crop.status === "required").length;
			console.log(`FAIL (${elapsed(started)})`);
		} else {
			console.log(`${scenarioResult.result} (${elapsed(started)})`);
		}
	} catch (error) {
		hardFailures += 1;
		results.scenarios.push(failedScenarioResult(scenario, error));
		console.log(`FAIL (${elapsed(started)})`);
		console.error(`      ${error.message}`);
	}
}

const pack = writeReviewPack(results);
console.log("");
console.log(`[visual-v2] review pack: ${pack.indexPath}`);
console.log(`[visual-v2] results: ${pack.resultsPath}`);

if (hardFailures > 0 || requiredFailures > 0) process.exit(1);

async function runScenario(scenario) {
	const scenarioOut = resolve(outDir, scenario.id);
	const rawOut = resolve(scenarioOut, "raw");
	const capture = scenario.lane === "component"
		? await captureComponentScenario(scenario)
		: scenario.lane === "fixture"
			? await captureFixtureScenario(scenario)
			: await captureRuntimeScenario(scenario);
	writeFile(resolve(rawOut, "runtime-output.ansi"), capture.bytes);
	const captureMetadata = {
		...(capture.metadata ?? {}),
		scenarioContract: scenarioContractForMetadata(scenario),
	};
	writeJson(resolve(rawOut, "capture-metadata.json"), captureMetadata);

	const snapshot = await replayAnsi(capture.bytes, scenario.dimensions);
	writeJson(resolve(rawOut, "terminal-snapshot.json"), snapshotForJson(snapshot));
	const finalScreenRejection = findRejection(snapshot.plainText, scenario.rejectIfFinalScreenMatches ?? []);
	if (finalScreenRejection) {
		writeJson(resolve(rawOut, "final-screen-rejection.json"), finalScreenRejection);
	}
	const finalCellContract = evaluateFinalCellAssertions(snapshot, scenario.finalCellAssertions ?? []);
	const finalCellArtifact = resolve(rawOut, "final-cell-contract.txt");
	writeFile(finalCellArtifact, finalCellContractToText(finalCellContract));
	writeJson(resolve(rawOut, "final-cell-contract.json"), finalCellContract);

	const geometrySpec = scenario.geometrySpec ?? null;
	const audit = auditGeometry(snapshot, geometrySpec);
	writeJson(resolve(rawOut, "geometry-audit.json"), { passed: audit.passed, summary: audit.summary, mismatches: audit.mismatches });
	writeFile(resolve(rawOut, "geometry-audit.txt"), auditToText(audit));

	// Styled cell-level Bible diff (char + fg + bg — no PNG)
	// Bible HTML lives one level up from the renders/ PNG.
	const bibleHtmlPath = scenario.bibleTargetPath
		.replace(/\.png$/, ".html")
		.replace(/[\/]renders[\/]/, "/");
	let cellDiff = null;
	const runtimeGrid = runtimeStyledGrid(snapshot);
	try {
		const bibleGrid = parseBibleStyledGrid(bibleHtmlPath);
		cellDiff = diffStyledGrids(bibleGrid, runtimeGrid);
		writeFile(resolve(rawOut, "styled-cell-diff.txt"), styledDiffToText(cellDiff));
		if (!cellDiff.passed) {
			writeJson(resolve(rawOut, "styled-cell-diff.json"), {
				passed: false,
				diffRows: cellDiff.rowDiffs.length,
				totalRows: cellDiff.totalRows,
				rowDiffs: cellDiff.rowDiffs.slice(0, 30),
			});
		}
	} catch {
		// Bible HTML may not exist for all scenarios (component-only, etc.)
	}

	const targetFull = resolve(scenarioOut, "target-full.png");
	copyFileSync(scenario.bibleTargetPath, targetFull);
	const runtimeFull = resolve(scenarioOut, "runtime-full.png");
	const runtimeRender = await renderTerminalSnapshot(snapshot, runtimeFull, {
		deviceScaleFactor: scenario.dimensions.deviceScaleFactor,
		glyphBaselineShiftPx: scenario.lane === "runtime" ? 1 : 0,
	});

	const cropResults = [];
	for (const crop of scenario.crops) {
		const cropOut = resolve(scenarioOut, "crops");
		const outPaths = {
			target: resolve(cropOut, `${crop.id}-target.png`),
			runtime: resolve(cropOut, `${crop.id}-runtime.png`),
			bibleDiff: resolve(cropOut, `${crop.id}-bible-diff.png`),
			golden: crop.goldenExists ? resolve(cropOut, `${crop.id}-golden.png`) : undefined,
			goldenDiff: crop.goldenExists ? resolve(cropOut, `${crop.id}-golden-diff.png`) : undefined,
		};
		const comparison = await compareCropPair({
			targetPath: crop.targetPath,
			runtimePath: runtimeFull,
			goldenPath: crop.goldenExists ? crop.goldenPath : undefined,
			targetCrop: crop.targetCrop,
			runtimeCrop: crop.runtimeCrop,
			threshold: crop.threshold,
			outPaths,
			dimensions: scenario.dimensions,
			targetDimensions: crop.targetDimensions,
			runtimeDimensions: crop.runtimeDimensions,
		});
		const styledCellDiff = cropStyledCellDiff(crop, runtimeGrid, rawOut);
		const result = cropResult(crop, comparison);
		cropResults.push({
			id: crop.id,
			status: crop.status,
			threshold: crop.threshold,
			result,
			targetImage: crop.targetImage,
			goldenExists: crop.goldenExists,
			comparison,
			styledCellDiff,
			artifacts: outPaths,
		});
	}

	return {
		id: scenario.id,
		lane: scenario.lane,
		status: scenario.status,
		result: scenarioResult(cropResults, finalScreenRejection, finalCellContract),
		dimensions: scenario.dimensions,
		bibleTarget: scenario.bibleTarget,
		capture: captureMetadata,
		finalScreenRejection,
		finalCellContract: {
			passed: finalCellContract.passed,
			count: finalCellContract.count,
			mismatchCount: finalCellContract.mismatches.length,
			mismatches: finalCellContract.mismatches,
			artifact: finalCellArtifact,
		},
		render: runtimeRender.metrics,
		geometryAudit: { passed: audit.passed, summary: audit.summary, mismatchCount: audit.mismatches.length },
		cellDiff: cellDiff ? { passed: cellDiff.passed, diffRows: cellDiff.rowDiffs?.length ?? 0 } : null,
		artifacts: {
			targetFull,
			runtimeFull,
		},
		crops: cropResults,
	};
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
		finalCellAssertions: scenario.finalCellAssertions ?? null,
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

function cropStyledCellDiff(crop, runtimeGrid, rawOut) {
	try {
		const targetHtmlPath = crop.targetPath
			.replace(/\.png$/, ".html")
			.replace(/[\/]renders[\/]/, "/");
		const targetGrid = parseBibleStyledGrid(targetHtmlPath);
		const diff = diffStyledGrids(
			cropStyledGrid(targetGrid, crop.targetCrop),
			cropStyledGrid(runtimeGrid, crop.runtimeCrop),
		);
		const artifact = resolve(rawOut, `styled-cell-diff-${crop.id}.txt`);
		writeFile(artifact, styledDiffToText(diff));
		return { passed: diff.passed, diffRows: diff.rowDiffs?.length ?? 0, artifact };
	} catch {
		return null;
	}
}

function cropResult(crop, comparison) {
	const biblePassed = comparison.bible.passed;
	const hasGolden = comparison.golden !== null;
	const goldenPassed = comparison.golden?.passed ?? true;
	// Required crops are regression gates. Once an approved runtime golden exists,
	// CI should fail on drift from that golden, while Bible drift remains review
	// evidence until the design target and implementation converge exactly. Before
	// golden promotion, required crops gate directly against the Bible target.
	if (crop.status === "required") {
		if (hasGolden) return goldenPassed ? (biblePassed ? "passed" : "review-diff") : "failed";
		return biblePassed ? "passed" : "failed";
	}
	if (!biblePassed || !goldenPassed) return "review-diff";
	return "passed";
}

function scenarioResult(crops, finalScreenRejection = null, finalCellContract = null) {
	if (finalScreenRejection) return "failed";
	if (finalCellContract && !finalCellContract.passed) return "failed";
	if (crops.some((crop) => crop.result === "failed")) return "failed";
	if (crops.some((crop) => crop.result === "review-diff")) return "review";
	return "passed";
}

function failedScenarioResult(scenario, error) {
	let targetFull;
	try {
		targetFull = resolve(outDir, scenario.id, "target-full.png");
		copyFileSync(scenario.bibleTargetPath, targetFull);
	} catch {
		targetFull = undefined;
	}
	return {
		id: scenario.id,
		lane: scenario.lane,
		status: scenario.status,
		result: "failed",
		dimensions: scenario.dimensions,
		bibleTarget: scenario.bibleTarget,
		error: error?.stack ?? String(error),
		artifacts: { targetFull },
		crops: [],
	};
}

function snapshotForJson(snapshot) {
	return {
		cols: snapshot.cols,
		rows: snapshot.rows,
		cursor: snapshot.cursor,
		plainText: snapshot.plainText,
		cells: snapshot.cells,
	};
}

function parseArgs(argv) {
	const parsed = { mode: argv[0]?.startsWith("--") ? "review" : argv.shift() };
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--") continue;
		if (arg === "--scenario") parsed.scenario = argv[++index];
		else if (arg === "--lane") parsed.lane = argv[++index];
		else throw new Error(`Unknown visual-v2 argument: ${arg}`);
	}
	return parsed;
}

function gitRev() {
	const result = spawnSync("git", ["rev-parse", "--short=12", "HEAD"], { encoding: "utf8" });
	return result.status === 0 ? result.stdout.trim() : "unknown";
}

function elapsed(started) {
	return `${((Date.now() - started) / 1000).toFixed(1)}s`;
}
