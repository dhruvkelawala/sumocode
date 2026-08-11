import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

export const HOST_INPUT_MANIFEST_VERSION = 1;
export const HOST_INPUT_MANIFEST_OUTPUT = ".inputs.json";

export const HOST_EXTRA_INPUTS = [
	"scripts/build-host.mjs",
	"scripts/lib/host-bundle.mjs",
	"tsconfig.json",
	"package.json",
	"pnpm-lock.yaml",
	"src/assets/sumo-face.ans",
	"src/sumo-tui/rpc/spawn-child.mjs",
	// Loaded by the chrome-cache worker via a string path (host.ts), so esbuild
	// never records it in the graph. Track it explicitly so changing or deleting
	// it invalidates the bundle and forces the matching source fallback instead
	// of running an old bundled worker client against a mismatched protocol.
	"src/sumo-tui/rpc/chrome-cache.ts",
];

export function normalizeHostInputPath(path) {
	return path.replaceAll("\\", "/");
}

export function hostInputFiles(root, bundledInputs) {
	const inputs = new Set(HOST_EXTRA_INPUTS);
	for (const input of bundledInputs) {
		const absolute = resolve(root, input);
		const path = normalizeHostInputPath(relative(root, absolute));
		if (path === ".." || path.startsWith("../") || isAbsolute(path)) {
			throw new Error(`Host bundle input escapes package root: ${input}`);
		}
		inputs.add(path);
	}
	return [...inputs].sort();
}

export async function hostInputsHash(root, inputs) {
	const hash = createHash("sha256");
	for (const input of inputs) {
		if (typeof input !== "string" || input.length === 0 || isAbsolute(input)) {
			throw new Error("Invalid host bundle input path");
		}
		const absolute = resolve(root, input);
		const path = normalizeHostInputPath(relative(root, absolute));
		if (path === ".." || path.startsWith("../") || isAbsolute(path) || path !== normalizeHostInputPath(input)) {
			throw new Error(`Host bundle input escapes package root: ${input}`);
		}
		hash.update(path);
		hash.update("\0");
		hash.update(await readFile(absolute));
		hash.update("\0");
	}
	return hash.digest("hex");
}

export async function createHostInputManifest(root, bundledInputs) {
	const inputs = hostInputFiles(root, bundledInputs);
	return {
		version: HOST_INPUT_MANIFEST_VERSION,
		inputs,
		hash: await hostInputsHash(root, inputs),
	};
}

export function hostInputManifestsMatch(before, after) {
	return before.version === HOST_INPUT_MANIFEST_VERSION
		&& after.version === HOST_INPUT_MANIFEST_VERSION
		&& before.hash === after.hash
		&& before.inputs.length === after.inputs.length
		&& before.inputs.every((input, index) => input === after.inputs[index]);
}

export async function hostInputManifestIsFresh(root, manifest) {
	if (
		typeof manifest !== "object"
		|| manifest === null
		|| manifest.version !== HOST_INPUT_MANIFEST_VERSION
		|| !Array.isArray(manifest.inputs)
		|| typeof manifest.hash !== "string"
	) return false;
	const inputs = manifest.inputs;
	if (inputs.length === 0 || inputs.some((input) => typeof input !== "string") || new Set(inputs).size !== inputs.length) return false;
	if ([...inputs].sort().some((input, index) => input !== inputs[index])) return false;
	try {
		// Recheck the inputs across two full scans: a source file changing mid-scan
		// (concurrent save/pull/checkout) can otherwise produce a hash that still
		// matches the old manifest. Requiring two identical scans that both match
		// the manifest rejects a bundle that is stale relative to the live checkout,
		// falling back to source — the safe direction on any ambiguity.
		const first = await hostInputsHash(root, inputs);
		if (first !== manifest.hash) return false;
		const second = await hostInputsHash(root, inputs);
		return second === manifest.hash;
	} catch {
		return false;
	}
}
