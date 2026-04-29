import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { approvedRuntimeDir, bibleRenderDir, scenarioManifestPath } from "./paths.mjs";
import { readJson } from "./fs-utils.mjs";

const STATUSES = new Set(["review", "approved", "required"]);
const LANES = new Set(["component", "runtime"]);

export function loadScenarioRegistry(options = {}) {
	const manifestPath = options.manifestPath ?? scenarioManifestPath;
	const manifest = readJson(manifestPath);
	validateManifest(manifest, manifestPath);
	const defaults = {
		threshold: 0.02,
		deviceScaleFactor: 2,
		fontSize: 13,
		lineHeight: 1.4,
		...(manifest.defaults ?? {}),
	};
	const crops = manifest.crops ?? {};
	const scenarios = manifest.scenarios.map((scenario) => normalizeScenario(scenario, defaults, crops));
	return {
		version: manifest.version,
		defaults,
		crops,
		scenarios,
		listScenarios(filter = {}) {
			return scenarios.filter((scenario) => {
				if (filter.id && scenario.id !== filter.id) return false;
				if (filter.lane && scenario.lane !== filter.lane) return false;
				return true;
			});
		},
		getScenario(id) {
			const found = scenarios.find((scenario) => scenario.id === id);
			if (!found) throw new Error(`Unknown visual scenario: ${id}`);
			return found;
		},
	};
}

function validateManifest(manifest, manifestPath) {
	if (!manifest || typeof manifest !== "object") throw new Error(`Invalid manifest at ${manifestPath}`);
	if (manifest.version !== 1) throw new Error(`Unsupported visual scenario manifest version: ${manifest.version}`);
	if (!manifest.crops || typeof manifest.crops !== "object") throw new Error("Scenario manifest must define crops");
	if (!Array.isArray(manifest.scenarios) || manifest.scenarios.length === 0) throw new Error("Scenario manifest must define scenarios");
	const ids = new Set();
	for (const scenario of manifest.scenarios) {
		if (!scenario.id || typeof scenario.id !== "string") throw new Error("Every scenario needs a string id");
		if (ids.has(scenario.id)) throw new Error(`Duplicate scenario id: ${scenario.id}`);
		ids.add(scenario.id);
		if (!LANES.has(scenario.lane)) throw new Error(`Scenario ${scenario.id} has invalid lane: ${scenario.lane}`);
		if (!STATUSES.has(scenario.status)) throw new Error(`Scenario ${scenario.id} has invalid status: ${scenario.status}`);
		if (!scenario.bibleTarget || typeof scenario.bibleTarget !== "string") throw new Error(`Scenario ${scenario.id} needs bibleTarget`);
		if (!scenario.dimensions || !Number.isInteger(scenario.dimensions.cols)) throw new Error(`Scenario ${scenario.id} needs integer dimensions.cols`);
		if (!Array.isArray(scenario.crops) || scenario.crops.length === 0) throw new Error(`Scenario ${scenario.id} needs crop definitions`);
		for (const crop of scenario.crops) {
			if (!crop.id || typeof crop.id !== "string") throw new Error(`Scenario ${scenario.id} has crop without id`);
			const targetCrop = crop.targetCrop ?? crop.id;
			const runtimeCrop = crop.runtimeCrop ?? crop.id;
			if (targetCrop !== "full" && !manifest.crops[targetCrop]) throw new Error(`Scenario ${scenario.id} references unknown target crop: ${targetCrop}`);
			if (runtimeCrop !== "full" && !manifest.crops[runtimeCrop]) throw new Error(`Scenario ${scenario.id} references unknown runtime crop: ${runtimeCrop}`);
		}
	}
}

function normalizeScenario(scenario, defaults, crops) {
	const targetPath = resolve(bibleRenderDir, scenario.bibleTarget);
	const dimensions = {
		rows: scenario.dimensions.rows,
		...scenario.dimensions,
		deviceScaleFactor: scenario.dimensions.deviceScaleFactor ?? defaults.deviceScaleFactor,
	};
	const normalized = {
		...scenario,
		threshold: scenario.threshold ?? defaults.threshold,
		dimensions,
		bibleTargetPath: targetPath,
		crops: scenario.crops.map((crop) => normalizeCropRef(crop, scenario, crops, defaults)),
	};
	return normalized;
}

function normalizeCropRef(crop, scenario, crops, defaults) {
	const targetImage = crop.targetImage ?? scenario.bibleTarget;
	const targetPath = resolve(bibleRenderDir, targetImage);
	const goldenPath = resolve(approvedRuntimeDir, scenario.id, `${crop.id}.png`);
	return {
		id: crop.id,
		status: crop.status ?? scenario.status,
		threshold: crop.threshold ?? scenario.threshold ?? defaults.threshold,
		targetImage,
		targetPath,
		targetCropId: crop.targetCrop ?? crop.id,
		runtimeCropId: crop.runtimeCrop ?? crop.id,
		targetCrop: resolveCrop(crop.targetCrop ?? crop.id, crops),
		runtimeCrop: resolveCrop(crop.runtimeCrop ?? crop.id, crops),
		goldenPath,
		goldenExists: existsSync(goldenPath),
	};
}

function resolveCrop(id, crops) {
	if (id === "full") return { kind: "full" };
	return crops[id];
}

export function assertScenarioTargetsExist(scenarios) {
	const missing = [];
	for (const scenario of scenarios) {
		if (!existsSync(scenario.bibleTargetPath)) missing.push(scenario.bibleTargetPath);
		for (const crop of scenario.crops) {
			if (!existsSync(crop.targetPath)) missing.push(crop.targetPath);
			if (crop.status === "required" && !existsSync(crop.goldenPath)) missing.push(crop.goldenPath);
		}
	}
	if (missing.length > 0) {
		throw new Error(`Missing visual parity asset(s):\n${[...new Set(missing)].map((path) => `  ${path}`).join("\n")}`);
	}
}
