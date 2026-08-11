import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

async function inputStatSignature(root, inputs) {
	const parts = [];
	for (const input of inputs) {
		const info = await stat(resolve(root, input));
		parts.push(`${input}:${info.mtimeMs}:${info.size}`);
	}
	return parts.join("|");
}

export const EXTENSION_INPUT_MANIFEST_OUTPUT = ".inputs.json";
export const EXTENSION_INPUT_MANIFEST_VERSION = 1;

export const EXTENSION_ASSETS = [
	{ source: "src/assets/sumo-face.ans", output: "assets/sumo-face.ans" },
	{ source: "src/background-tasks/bounded-terminal-runner.mjs", output: "bounded-terminal-runner.mjs" },
];

export const EXTENSION_RUNTIME_OUTPUTS = [
	"sumocode-extension.bundle.mjs",
	"sumocode-extension.bundle.mjs.map",
	...EXTENSION_ASSETS.map(({ output }) => output),
];

export const EXTENSION_RECIPE_INPUTS = [
	"scripts/build-extension.mjs",
	"scripts/lib/extension-bundle.mjs",
	"tsconfig.json",
	// package.json ships in npm/pnpm tarballs and pins the exact esbuild version.
	"package.json",
];

export function normalizeHashPath(path) {
	return path.replaceAll("\\", "/");
}

function rootRelative(root, input) {
	const absolute = resolve(root, input);
	const path = normalizeHashPath(relative(root, absolute));
	if (path === ".." || path.startsWith("../") || isAbsolute(path)) {
		throw new Error(`Extension bundle input escapes package root: ${input}`);
	}
	return path;
}

/**
 * Derive the freshness input set from esbuild's actual dependency graph rather
 * than a broad src/ walk, so host-only production files that never reach the
 * extension artifact do not force regeneration or reject a valid bundle. The
 * recipe and copied assets are added because they change the output without
 * appearing in the entry's import graph.
 */
export function extensionInputFilesFromGraph(root, bundledInputs) {
	const inputs = new Set([...EXTENSION_RECIPE_INPUTS, ...EXTENSION_ASSETS.map(({ source }) => source)]);
	for (const input of bundledInputs) {
		const normalized = normalizeHashPath(input);
		if (normalized.startsWith("node_modules/") || normalized.includes("/node_modules/")) continue;
		inputs.add(rootRelative(root, input));
	}
	return [...inputs].sort();
}

async function contentHash(base, files) {
	const hash = createHash("sha256");
	for (const path of files) {
		hash.update(normalizeHashPath(relative(base, path)));
		hash.update("\0");
		hash.update(await readFile(path));
		hash.update("\0");
	}
	return hash.digest("hex");
}

export async function extensionInputsHashFromManifest(root, inputs) {
	const hash = createHash("sha256");
	for (const input of inputs) {
		if (typeof input !== "string" || input.length === 0 || isAbsolute(input)) {
			throw new Error("Invalid extension bundle input path");
		}
		const path = rootRelative(root, input);
		if (path !== normalizeHashPath(input)) throw new Error(`Non-canonical extension bundle input: ${input}`);
		hash.update(path);
		hash.update("\0");
		hash.update(await readFile(resolve(root, input)));
		hash.update("\0");
	}
	return hash.digest("hex");
}

export async function createExtensionInputManifest(root, bundledInputs) {
	const inputs = extensionInputFilesFromGraph(root, bundledInputs);
	return {
		version: EXTENSION_INPUT_MANIFEST_VERSION,
		inputs,
		hash: await extensionInputsHashFromManifest(root, inputs),
	};
}

export function extensionInputManifestsMatch(before, after) {
	return before.version === EXTENSION_INPUT_MANIFEST_VERSION
		&& after.version === EXTENSION_INPUT_MANIFEST_VERSION
		&& before.hash === after.hash
		&& before.inputs.length === after.inputs.length
		&& before.inputs.every((input, index) => input === after.inputs[index]);
}

export async function extensionInputManifestIsFresh(root, manifest) {
	if (
		typeof manifest !== "object"
		|| manifest === null
		|| manifest.version !== EXTENSION_INPUT_MANIFEST_VERSION
		|| !Array.isArray(manifest.inputs)
		|| typeof manifest.hash !== "string"
	) return false;
	const inputs = manifest.inputs;
	if (inputs.length === 0 || inputs.some((input) => typeof input !== "string") || new Set(inputs).size !== inputs.length) return false;
	if ([...inputs].sort().some((input, index) => input !== inputs[index])) return false;
	try {
		// Guard the whole scan against a concurrent save/pull/checkout: capture a
		// stat signature (mtime+size per input) before and after hashing. A change
		// at any point during the scan alters the signature, rejecting the bundle
		// in favour of the source fallback (the safe direction on any ambiguity).
		const before = await inputStatSignature(root, inputs);
		if (await extensionInputsHashFromManifest(root, inputs) !== manifest.hash) return false;
		const after = await inputStatSignature(root, inputs);
		return before === after;
	} catch {
		return false;
	}
}

export async function extensionOutputsHash(root) {
	const outDir = resolve(root, "dist/extension");
	return contentHash(outDir, EXTENSION_RUNTIME_OUTPUTS.map((output) => resolve(outDir, output)));
}
