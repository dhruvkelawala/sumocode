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

export const HOST_INPUT_MANIFEST_VERSION = 2;
export const HOST_INPUT_MANIFEST_OUTPUT = ".inputs.json";

// Every file build-host publishes. The manifest records a hash over this exact
// set so it describes its OWN artifact: if two concurrent builders interleave
// renames, the manifest one publishes will not match the other's on-disk bytes,
// and the launch rejects the mismatched bundle instead of executing it.
export const HOST_BUNDLE_OUTPUTS = [
	"sumo-rpc-host.bundle.mjs",
	"sumo-rpc-host.bundle.mjs.map",
	"assets/sumo-face.ans",
	"spawn-child.mjs",
];

export async function hostOutputsHash(root) {
	const outDir = resolve(root, "dist/host");
	const hash = createHash("sha256");
	for (const output of HOST_BUNDLE_OUTPUTS) {
		hash.update(output);
		hash.update("\0");
		hash.update(await readFile(resolve(outDir, output)));
		hash.update("\0");
	}
	return hash.digest("hex");
}

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
		// oxlint-disable-next-line anti-slop/no-runtime-typeof -- validating untrusted bundle manifest/input data
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
		// oxlint-disable-next-line anti-slop/no-runtime-typeof -- validating untrusted bundle manifest/input data
		typeof manifest !== "object"
		|| manifest === null
		|| manifest.version !== HOST_INPUT_MANIFEST_VERSION
		|| !Array.isArray(manifest.inputs)
		// oxlint-disable-next-line anti-slop/no-runtime-typeof -- validating untrusted bundle manifest/input data
		|| typeof manifest.hash !== "string"
	) return false;
	const inputs = manifest.inputs;
	// oxlint-disable-next-line anti-slop/no-runtime-typeof -- validating untrusted bundle manifest/input data
	if (inputs.length === 0 || inputs.some((input) => typeof input !== "string") || new Set(inputs).size !== inputs.length) return false;
	if ([...inputs].sort().some((input, index) => input !== inputs[index])) return false;
	try {
		// Guard the whole scan against a concurrent save/pull/checkout: capture a
		// stat signature (mtime+size per input) before and after hashing. If the
		// hash matches the manifest but any input changed at any point during the
		// scan, the signatures differ and the bundle is rejected in favour of the
		// source fallback — the safe direction on any ambiguity.
		const before = await inputStatSignature(root, inputs);
		if (await hostInputsHash(root, inputs) !== manifest.hash) return false;
		const after = await inputStatSignature(root, inputs);
		return before === after;
	} catch {
		return false;
	}
}
