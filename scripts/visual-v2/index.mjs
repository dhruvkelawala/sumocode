#!/usr/bin/env node
import { copyFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { captureComponentScenario } from "./component-capture.mjs";
import { captureRuntimeScenario } from "./runtime-capture.mjs";
import { replayAnsi } from "./ansi-replay.mjs";
import { renderTerminalSnapshot } from "./terminal-dom-renderer.mjs";
import { compareCropPair } from "./image-compare.mjs";
import { assertScenarioTargetsExist, loadScenarioRegistry } from "./scenario-registry.mjs";
import { outDir } from "./paths.mjs";
import { resetDir, writeFile, writeJson } from "./fs-utils.mjs";
import { writeReviewPack } from "./review-pack.mjs";

const args = parseArgs(process.argv.slice(2));
const mode = args.mode ?? "review";
if (!["review", "ci"].includes(mode)) {
	console.error(`Usage: pnpm visual:review [--scenario id] [--lane component|runtime]\n       pnpm visual:ci [--scenario id] [--lane component|runtime]`);
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
		: await captureRuntimeScenario(scenario);
	writeFile(resolve(rawOut, "runtime-output.ansi"), capture.bytes);
	writeJson(resolve(rawOut, "capture-metadata.json"), capture.metadata ?? {});

	const snapshot = await replayAnsi(capture.bytes, scenario.dimensions);
	writeJson(resolve(rawOut, "terminal-snapshot.json"), snapshotForJson(snapshot));
	const targetFull = resolve(scenarioOut, "target-full.png");
	copyFileSync(scenario.bibleTargetPath, targetFull);
	const runtimeFull = resolve(scenarioOut, "runtime-full.png");
	const runtimeRender = await renderTerminalSnapshot(snapshot, runtimeFull, {
		deviceScaleFactor: scenario.dimensions.deviceScaleFactor,
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
		});
		const result = cropResult(crop, comparison);
		cropResults.push({
			id: crop.id,
			status: crop.status,
			threshold: crop.threshold,
			result,
			targetImage: crop.targetImage,
			goldenExists: crop.goldenExists,
			comparison,
			artifacts: outPaths,
		});
	}

	return {
		id: scenario.id,
		lane: scenario.lane,
		status: scenario.status,
		result: scenarioResult(cropResults),
		dimensions: scenario.dimensions,
		bibleTarget: scenario.bibleTarget,
		capture: capture.metadata,
		render: runtimeRender.metrics,
		artifacts: {
			targetFull,
			runtimeFull,
		},
		crops: cropResults,
	};
}

function cropResult(crop, comparison) {
	const biblePassed = comparison.bible.passed;
	const hasGolden = comparison.golden !== null;
	const goldenPassed = comparison.golden?.passed ?? true;
	// Required crops are regression gates. Once an approved runtime golden exists,
	// CI should fail on drift from that golden, while Bible drift remains review
	// evidence until the design target and implementation converge exactly.
	if (crop.status === "required") {
		if (hasGolden) return goldenPassed ? (biblePassed ? "passed" : "review-diff") : "failed";
		return biblePassed ? "passed" : "failed";
	}
	if (!biblePassed || !goldenPassed) return "review-diff";
	return "passed";
}

function scenarioResult(crops) {
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
