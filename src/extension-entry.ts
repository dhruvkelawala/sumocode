import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { canonicalizeExtensionPath, importExtensionEntry, sourceExtensionFile } from "./extension-entry-loader.js";

const INPUT_MANIFEST_VERSION = 2;
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const launcherRoot = process.env.SUMOCODE_ROOT_DIR;
const launcherOwned = launcherRoot !== undefined
	&& canonicalizeExtensionPath(root) === canonicalizeExtensionPath(launcherRoot);
const sourceFile = sourceExtensionFile(process.env.SUMOCODE_RPC_CHILD === "1", launcherOwned);
const sourcePath = join(root, "src", sourceFile);
const bundlePath = join(root, "dist", "extension", "sumocode-extension.bundle.mjs");
const inputManifestPath = join(root, "dist", "extension", ".inputs.json");
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
	outputsHash: string;
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
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- predicate over untrusted manifest JSON fields; the typeof check is the sanctioned parse.
function isString(value: unknown): value is string {
	return typeof value === "string";
}

function inputManifestIsFresh(manifest: ExtensionInputManifest): boolean {
	if (
		manifest.version !== INPUT_MANIFEST_VERSION
		|| !Array.isArray(manifest.inputs)
		|| manifest.inputs.length === 0
		|| !isString(manifest.hash)
	) return false;
	const inputs = manifest.inputs;
	if (inputs.some((input) => !isString(input)) || new Set(inputs).size !== inputs.length) return false;
	if ([...inputs].sort().some((input, index) => input !== inputs[index])) return false;
	const files: string[] = [];
	for (const input of inputs) {
		if (input.length === 0 || isAbsolute(input)) return false;
		const absolute = resolve(root, input);
		const path = normalizeHashPath(relative(root, absolute));
		if (path === ".." || path.startsWith("../") || isAbsolute(path) || path !== normalizeHashPath(input)) return false;
		files.push(absolute);
	}
	// Guard the whole scan against a concurrent save/pull/checkout: capture a
	// stat signature (mtime+size per file) before and after hashing. A change at
	// any point during the scan alters the signature, rejecting the bundle in
	// favour of the source fallback (the safe direction on any ambiguity).
	const signature = (): string => files.map((file) => {
		const info = statSync(file);
		return `${file}:${info.mtimeMs}:${info.size}`;
	}).join("|");
	const before = signature();
	if (contentHash(root, files) !== manifest.hash) return false;
	return signature() === before;
}

function extensionOutputsHash(): string {
	const outDir = dirname(bundlePath);
	return contentHash(outDir, extensionOutputs.map((output) => resolve(outDir, output)));
}

function hasFreshBundle(): boolean {
	if (!existsSync(bundlePath) || !existsSync(inputManifestPath)) return false;
	try {
		// SAFETY: the manifest is JSON produced by the extension build; malformed
		// files throw below and fall back to the source bundle path.
		const manifest = JSON.parse(readFileSync(inputManifestPath, "utf8")) as ExtensionInputManifest;
		// The output digest lives INSIDE the input manifest, so a partial update
		// (merge/cherry-pick) cannot leave a matching manifest beside a stale
		// bundle: both the source graph and the published bytes are one unit.
		return inputManifestIsFresh(manifest)
			&& isString(manifest.outputsHash)
			&& manifest.outputsHash === extensionOutputsHash();
	} catch {
		return false;
	}
}

// Pi's outer Jiti compiles this lexical source import, preserving its .js→.ts
// resolution, peer aliases, and shared module singletons. A nested Jiti would
// lose those loader aliases. The peer-only forced-source integration case locks
// this contract with neither local node_modules nor pnpm-lock.yaml available.
const importSourceThroughPiJiti = () => sourceFile === "rpc-child-extension.ts"
	? import("./rpc-child-extension.js")
	: import("./extension.js");

const extensionModule = await importExtensionEntry({
	bundlePath,
	sourcePath,
	useBundle: process.env.SUMOCODE_EXTENSION_BUNDLE !== "0" && hasFreshBundle(),
	bundleImporter: (path) => import(pathToFileURL(path).href),
	// A source edit or rebuild landing in the check/import window makes this
	// false, so the shim discards the stale bundle and uses source instead.
	revalidate: () => hasFreshBundle(),
	sourceImporter: importSourceThroughPiJiti,
	onBundleFailure: () => {
		console.warn("[sumocode] extension bundle failed to import — using source");
	},
});

export default extensionModule.default;
