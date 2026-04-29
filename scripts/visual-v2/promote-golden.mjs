#!/usr/bin/env node
import { copyFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { approvedRuntimeDir, outDir, scenarioManifestPath } from "./paths.mjs";
import { ensureDir, readJson, writeJson } from "./fs-utils.mjs";

const args = parseArgs(process.argv.slice(2));
if (!args.scenario || !args.crop) {
	console.error("Usage: pnpm visual:promote --scenario <id> --crop <id> [--status approved|required]");
	process.exit(1);
}
const status = args.status ?? "approved";
if (!["approved", "required"].includes(status)) throw new Error(`Invalid promotion status: ${status}`);

const runtimeCrop = resolve(outDir, args.scenario, "crops", `${args.crop}-runtime.png`);
if (!existsSync(runtimeCrop)) {
	throw new Error(`Runtime crop does not exist. Run pnpm visual:review first: ${runtimeCrop}`);
}

const destination = resolve(approvedRuntimeDir, args.scenario, `${args.crop}.png`);
ensureDir(resolve(approvedRuntimeDir, args.scenario));
copyFileSync(runtimeCrop, destination);
updateManifestStatus(args.scenario, args.crop, status);

console.log(`[visual-v2] promoted ${args.scenario}/${args.crop} -> ${destination}`);
console.log(`[visual-v2] status: ${status}`);

function updateManifestStatus(scenarioId, cropId, status) {
	const manifest = readJson(scenarioManifestPath);
	const scenario = manifest.scenarios.find((entry) => entry.id === scenarioId);
	if (!scenario) throw new Error(`Scenario not found in manifest: ${scenarioId}`);
	const crop = scenario.crops.find((entry) => entry.id === cropId);
	if (!crop) throw new Error(`Crop not found in scenario ${scenarioId}: ${cropId}`);
	crop.status = status;
	writeJson(scenarioManifestPath, manifest);
}

function parseArgs(argv) {
	const parsed = {};
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--") continue;
		if (arg === "--scenario") parsed.scenario = argv[++index];
		else if (arg === "--crop") parsed.crop = argv[++index];
		else if (arg === "--status") parsed.status = argv[++index];
		else throw new Error(`Unknown visual:promote argument: ${arg}`);
	}
	return parsed;
}
