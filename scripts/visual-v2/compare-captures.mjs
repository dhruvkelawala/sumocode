#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import { loadScenarioRegistry } from "./scenario-registry.mjs";
import { cropStyledGrid, diffStyledGrids, runtimeStyledGrid, styledDiffToText } from "./styled-cell-grid.mjs";
import { ensureDir, readJson, resetDir, writeFile, writeJson } from "./fs-utils.mjs";
import { repoRoot } from "./paths.mjs";

/**
 * Known-mechanical equivalence declarations for main-vs-RPC-candidate
 * comparison (plan 024 parity gate). Each region is narrow — a specific
 * row/col rectangle plus a content pattern the target/runtime row text must
 * still match — so it only suppresses the exact class of difference it
 * documents, never a blanket row/scenario suppression. Coordinates are
 * absolute (full-grid, 0-indexed), matching `terminal-snapshot.json` cell
 * coordinates; `cropEquivalentRegions` translates them into a crop's local
 * coordinate space.
 *
 * These are declared here (not in `styled-cell-grid.mjs`'s `EQUIVALENT_PAIRS`)
 * because that table suppresses Bible-mockup-vs-runtime color differences —
 * a different comparison (Bible target vs one runtime capture). This table
 * suppresses main-baseline-vs-candidate-capture differences that are known
 * to be mechanical/non-content: random session ids, live timestamps,
 * blink-phase cursor cells, capture-environment working-dir/branch text, and
 * harness-determinism constants. See `plans/024-EVIDENCE.md` for the
 * one-line justification of each entry restated for human review.
 */
const KNOWN_EQUIVALENT_REGIONS = {
	"splash-runtime": [
		{
			// Cursor caret cell inside the splash placeholder text — fg/bg swap
			// is the blink-phase indicator; which phase lands in a given capture
			// is timing-dependent, not a content difference.
			rows: [32, 32],
			cols: [54, 54],
			targetPattern: /Ask anything/,
			runtimePattern: /Ask anything/,
			reason: "cursor-blink-phase cell (splash placeholder caret)",
		},
		{
			// main-is-stale: candidate matches ratified splash canon
			// (Bible 03-splash.html + src/cathedral/input-frame.ts
			// INPUT_FRAME_HINT_AWAITING); main's older chrome still renders the
			// legacy `unknown · off` status, which this scenario's own
			// rejectIfFinalScreenMatches contract lists as an error marker.
			// Adjudicated earlier in this track (plans/README.md); expires when
			// main absorbs integrate/track-d. Pattern-locked on BOTH sides —
			// if either side renders any third string, the mask does not apply
			// and the gate fails again.
			rows: [34, 34],
			cols: [53, 67],
			targetPattern: /╰─ unknown · off/,
			runtimePattern: /╰─ AWAITING PROMPT/,
			reason: "main-is-stale: splash hint row (candidate matches ratified canon AWAITING PROMPT; expires when main absorbs integrate/track-d)",
		},
		{
			// main-is-stale: candidate renders the ratified splash version line
			// (Bible 03-splash.html + src/footer.ts SPLASH_VERSION_LINE); main's
			// baseline capture is missing the row entirely. Adjudicated earlier
			// in this track (plans/README.md); expires when main absorbs
			// integrate/track-d. Pattern-locked on BOTH sides: baseline row must
			// be blank AND candidate row must be the exact canon version line.
			rows: [43, 43],
			cols: [56, 103],
			targetPattern: /^\s*$/,
			runtimePattern: /SUMOCODE V0\.3\.0 · CATHEDRAL · 160 × 45 MONOSPACE/,
			reason: "main-is-stale: splash version line (candidate matches ratified canon SPLASH_VERSION_LINE; expires when main absorbs integrate/track-d)",
		},
	],
	"active-landscape-runtime": [
		{
			// Top-bar session-id: random per process, only the 8 hex chars change.
			rows: [0, 0],
			cols: [21, 22],
			targetPattern: /•\s+[0-9a-f]{8}\s+║/,
			runtimePattern: /•\s+[0-9a-f]{8}\s+║/,
			reason: "session-id chars in top bar (random per run)",
		},
		{
			// Chat frame top border timestamp: "HH:MM", only minutes vary here.
			rows: [6, 6],
			cols: [123, 124],
			targetPattern: /\d{2}:\d{2}\s+─┐/,
			runtimePattern: /\d{2}:\d{2}\s+─┐/,
			reason: "timestamp minutes in message box border",
		},
		{
			// Working-indicator spark glyph: cycles through an animation frame
			// set: timing-dependent, which frame lands in a given capture varies.
			rows: [36, 36],
			cols: [1, 1],
			targetPattern: /Working…/,
			runtimePattern: /Working…/,
			reason: "working-indicator animation-phase glyph (timing-dependent)",
		},
		{
			// Input caret cell: same fg/bg swap phase-dependent cell as splash.
			rows: [39, 39],
			cols: [4, 4],
			targetPattern: /│ >/,
			runtimePattern: /│ >/,
			reason: "cursor-blink-phase cell (input caret)",
		},
		{
			// Hint row cwd/branch segment. On landscape the sidebar is visible,
			// so by design (AGENTS.md: "Project/branch live in the sidebar when
			// visible") the candidate's hint row omits this text entirely while
			// main's older chrome still rendered it in the hint row. Static
			// "CTRL+/ · COMMANDS" segment (cols 143+) is NOT covered by this
			// region and remains compared.
			rows: [41, 41],
			cols: [1, 130],
			targetPattern: /CTRL\+\/ · COMMANDS/,
			runtimePattern: /CTRL\+\/ · COMMANDS/,
			reason: "hint-row cwd/branch segment (capture-environment working dir; sidebar-visible layout omits it by design)",
		},
		{
			// Sidebar cwd/branch lines mirror the same capture-environment
			// working-dir/branch variability as the hint row, just rendered in
			// the sidebar column instead when the sidebar is visible.
			rows: [10, 11],
			cols: [130, 159],
			reason: "sidebar cwd/branch segment (capture-environment working dir)",
		},
		{
			// D4 deterministic harness constants: candidate freezes
			// 42k/200k · $0.42 by design (SUMOCODE_HARNESS visual-capture
			// determinism guard in shell-adapter.ts); main shows whatever the
			// live, non-harness-aware session state happened to be
			// (14/128k · $0.00 in the captured baseline).
			rows: [14, 18],
			cols: [130, 159],
			reason: "D4 deterministic constants: sidebar token/cost gauge (harness determinism vs main's live session state)",
		},
		{
			rows: [43, 43],
			cols: [143, 158],
			targetPattern: /MEDITATING/,
			runtimePattern: /MEDITATING/,
			reason: "D4 deterministic constants: footer token/cost cell range (harness determinism vs main's live session state)",
		},
		{
			// MCP connector roster + its background wash. The candidate's RPC
			// shell (src/sumo-tui/rpc/shell-adapter.ts) added a
			// SUMOCODE_HARNESS-gated PLACEHOLDER_MCP roster (github/stitch/
			// context7/chrome-dev, fixed) specifically so visual captures don't
			// leak the live per-machine ~/.pi/agent/mcp.json roster (see
			// src/mcp-config-reader.ts, src/sidebar.ts PLACEHOLDER_MCP). Main's
			// sidebar code path predates this guard and the clean baseline
			// capture environment simply had no MCP config configured, so main
			// shows blank rows here. Same root cause as the D4 constants class:
			// candidate freezes a deterministic placeholder, main is
			// capture-environment-dependent.
			rows: [24, 34],
			cols: [130, 159],
			reason: "MCP roster placeholder (harness determinism vs main's pre-placeholder/live sidebar state)",
		},
	],
	"active-portrait-runtime": [
		{
			rows: [1, 1],
			cols: [21, 22],
			targetPattern: /•\s+[0-9a-f]{8}\s+║/,
			runtimePattern: /•\s+[0-9a-f]{8}\s+║/,
			reason: "session-id chars in top bar (random per run)",
		},
		{
			rows: [8, 8],
			cols: [55, 56],
			targetPattern: /\d{2}:\d{2}\s+─┐/,
			runtimePattern: /\d{2}:\d{2}\s+─┐/,
			reason: "timestamp minutes in message box border",
		},
		{
			rows: [94, 94],
			cols: [4, 4],
			targetPattern: /│ >/,
			runtimePattern: /│ >/,
			reason: "cursor-blink-phase cell (input caret)",
		},
		{
			// Portrait hides the sidebar, so the hint row DOES carry cwd/branch
			// text in both captures; only the variable segment is masked, the
			// static "CTRL+/ · COMMANDS" text stays compared.
			rows: [96, 96],
			cols: [1, 34],
			targetPattern: /CTRL\+\/ · COMMANDS/,
			runtimePattern: /CTRL\+\/ · COMMANDS/,
			reason: "hint-row cwd/branch segment (capture-environment working dir)",
		},
		{
			rows: [98, 98],
			cols: [43, 58],
			targetPattern: /MEDITATING/,
			runtimePattern: /MEDITATING/,
			reason: "D4 deterministic constants: footer token/cost cell range (harness determinism vs main's live session state)",
		},
	],
};

function cropEquivalentRegions(scenarioId, crop) {
	const regions = KNOWN_EQUIVALENT_REGIONS[scenarioId] ?? [];
	const runtimeCrop = crop.runtimeCrop;
	if (!runtimeCrop || runtimeCrop.kind === "full") return regions;
	const cropRowLo = runtimeCrop.y;
	const cropRowHi = runtimeCrop.y + runtimeCrop.rows - 1;
	const cropColLo = runtimeCrop.x;
	const cropColHi = runtimeCrop.x + runtimeCrop.cols - 1;
	const translated = [];
	for (const region of regions) {
		const rowLo = Math.max(region.rows[0], cropRowLo);
		const rowHi = Math.min(region.rows[1], cropRowHi);
		const colLo = Math.max(region.cols[0], cropColLo);
		const colHi = Math.min(region.cols[1], cropColHi);
		if (rowLo > rowHi || colLo > colHi) continue; // region doesn't intersect this crop
		translated.push({
			...region,
			rows: [rowLo - cropRowLo, rowHi - cropRowLo],
			cols: [colLo - cropColLo, colHi - cropColLo],
		});
	}
	return translated;
}

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
	const fullDiff = diffStyledGrids(baselineGrid, candidateGrid, {
		equivalentRegions: KNOWN_EQUIVALENT_REGIONS[scenario.id] ?? [],
	});
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
	const equivalentRegions = cropEquivalentRegions(scenario.id, crop);
	const cellDiff = diffStyledGrids(
		cropStyledGrid(baselineGrid, crop.runtimeCrop),
		cropStyledGrid(candidateGrid, crop.runtimeCrop),
		{ equivalentRegions },
	);
	const styledArtifact = resolve(scenarioOut, "raw", `styled-cell-diff-${crop.id}.txt`);
	writeFile(styledArtifact, styledDiffToText(cellDiff));

	const baselinePngPath = resolve(baselineRoot, scenario.id, "crops", `${crop.id}-runtime.png`);
	const candidatePngPath = resolve(candidateRoot, scenario.id, "crops", `${crop.id}-runtime.png`);
	const png = comparePngFiles(
		baselinePngPath,
		candidatePngPath,
		resolve(cropOut, `${crop.id}-diff.png`),
		crop.threshold,
		{ equivalentRegions, cropCellDimensions: crop.runtimeCrop && crop.runtimeCrop.kind !== "full" ? { cols: crop.runtimeCrop.cols, rows: crop.runtimeCrop.rows } : null },
	);
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

/**
 * Blank a declared-equivalent cell region to an identical neutral color in
 * both images before pixel diffing. This carries the SAME narrow, declared
 * equivalence used by the styled-cell-diff gate through to the PNG gate that
 * covers the same crop — it does not add a new equivalence system, and it
 * only touches the exact rectangle a declared region names (converted from
 * cell coordinates to pixel coordinates via the crop's own cols/rows). Cell
 * ranges without a corresponding pixel-mappable `cropCellDimensions` (e.g.
 * full-scenario diffs with no single crop grid) are left untouched.
 */
function applyPixelMask(png, region, cellDimensions) {
	if (!cellDimensions) return;
	const cellWidth = png.width / cellDimensions.cols;
	const cellHeight = png.height / cellDimensions.rows;
	const x0 = Math.max(0, Math.floor(region.cols[0] * cellWidth));
	const x1 = Math.min(png.width, Math.ceil((region.cols[1] + 1) * cellWidth));
	const y0 = Math.max(0, Math.floor(region.rows[0] * cellHeight));
	const y1 = Math.min(png.height, Math.ceil((region.rows[1] + 1) * cellHeight));
	for (let y = y0; y < y1; y += 1) {
		for (let x = x0; x < x1; x += 1) {
			const index = (y * png.width + x) * 4;
			png.data[index] = 26;
			png.data[index + 1] = 21;
			png.data[index + 2] = 17;
			png.data[index + 3] = 255;
		}
	}
}

function comparePngFiles(baselinePath, candidatePath, diffPath, threshold, options = {}) {
	if (!existsSync(baselinePath)) throw new Error(`Missing baseline crop: ${baselinePath}`);
	if (!existsSync(candidatePath)) throw new Error(`Missing candidate crop: ${candidatePath}`);
	const baseline = PNG.sync.read(readFileSync(baselinePath));
	const candidate = PNG.sync.read(readFileSync(candidatePath));
	const equivalentRegions = options.equivalentRegions ?? [];
	const cropCellDimensions = options.cropCellDimensions ?? null;
	if (cropCellDimensions) {
		for (const region of equivalentRegions) {
			applyPixelMask(baseline, region, cropCellDimensions);
			applyPixelMask(candidate, region, cropCellDimensions);
		}
	}
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
