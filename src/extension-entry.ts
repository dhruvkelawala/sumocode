import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { importExtensionEntry } from "./extension-entry-loader.js";

const INPUT_MANIFEST_VERSION = 1;
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = join(root, "src", "extension.ts");
const bundlePath = join(root, "dist", "extension", "sumocode-extension.bundle.mjs");
const inputManifestPath = join(root, "dist", "extension", ".inputs.json");
const outputsHashPath = join(root, "dist", "extension", ".outputs-hash");
const extensionOutputs = [
	"sumocode-extension.bundle.mjs",
	"sumocode-extension.bundle.mjs.map",
	"assets/sumo-face.ans",
	"bounded-terminal-runner.mjs",
];

interface ExtensionInputManifest {
	version: number;
	inputs: string[];
	hash: string;
}

function normalizeHashPath(path: string): string {
	return path.replaceAll("\\", "/");
}

function contentHash(base: string, files: readonly string[]): string {
	const hash = createHash("sha256");
	for (const path of files) {
		hash.update(normalizeHashPath(relative(base, path)));
		hash.update("\0");
		hash.update(readFileSync(path));
		hash.update("\0");
	}
	return hash.digest("hex");
}

// Re-hash exactly the recorded input set (esbuild's dependency graph plus the
// recipe and copied assets). Modified, renamed, and deleted inputs all change
// the recomputed hash, so a stale or mixed-checkout bundle is rejected.
function inputManifestIsFresh(manifest: ExtensionInputManifest): boolean {
	if (
		manifest.version !== INPUT_MANIFEST_VERSION
		|| !Array.isArray(manifest.inputs)
		|| manifest.inputs.length === 0
		|| typeof manifest.hash !== "string"
	) return false;
	const inputs = manifest.inputs;
	if (inputs.some((input) => typeof input !== "string") || new Set(inputs).size !== inputs.length) return false;
	if ([...inputs].sort().some((input, index) => input !== inputs[index])) return false;
	const files: string[] = [];
	for (const input of inputs) {
		if (input.length === 0 || isAbsolute(input)) return false;
		const absolute = resolve(root, input);
		const path = normalizeHashPath(relative(root, absolute));
		if (path === ".." || path.startsWith("../") || isAbsolute(path) || path !== normalizeHashPath(input)) return false;
		files.push(absolute);
	}
	return contentHash(root, files) === manifest.hash;
}

function extensionOutputsHash(): string {
	const outDir = dirname(bundlePath);
	return contentHash(outDir, extensionOutputs.map((output) => resolve(outDir, output)));
}

function hasFreshBundle(): boolean {
	if (!existsSync(bundlePath) || !existsSync(inputManifestPath) || !existsSync(outputsHashPath)) return false;
	try {
		const manifest = JSON.parse(readFileSync(inputManifestPath, "utf8")) as ExtensionInputManifest;
		return inputManifestIsFresh(manifest)
			&& readFileSync(outputsHashPath, "utf8").trim() === extensionOutputsHash();
	} catch {
		return false;
	}
}

// Pi's outer Jiti compiles this lexical source import, preserving its .js→.ts
// resolution, peer aliases, and shared module singletons. A nested Jiti would
// lose those loader aliases. The peer-only forced-source integration case locks
// this contract with neither local node_modules nor pnpm-lock.yaml available.
const importSourceThroughPiJiti = () => import("./extension.js");

const extensionModule = await importExtensionEntry({
	bundlePath,
	sourcePath,
	useBundle: process.env.SUMOCODE_EXTENSION_BUNDLE !== "0" && hasFreshBundle(),
	bundleImporter: (path) => import(pathToFileURL(path).href),
	sourceImporter: importSourceThroughPiJiti,
	onBundleFailure: () => {
		console.warn("[sumocode] extension bundle failed to import — using source");
	},
});

export default extensionModule.default;
