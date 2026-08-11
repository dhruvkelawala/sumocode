import { copyFile, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { build } from "esbuild";
import {
	createExtensionInputManifest,
	EXTENSION_ASSETS,
	EXTENSION_INPUT_MANIFEST_OUTPUT,
	extensionInputManifestsMatch,
	extensionOutputsHash,
} from "./lib/extension-bundle.mjs";

const root = resolve(import.meta.dirname, "..");
const outDir = resolve(root, "dist/extension");
const bundlePath = resolve(outDir, "sumocode-extension.bundle.mjs");
const manifestPath = resolve(outDir, EXTENSION_INPUT_MANIFEST_OUTPUT);
const buildOptions = {
	absWorkingDir: root,
	entryPoints: ["src/extension.ts"],
	outfile: bundlePath,
	bundle: true,
	format: "esm",
	platform: "node",
	target: "node22",
	packages: "external",
	sourcemap: true,
	metafile: true,
	write: false,
};

async function atomicWrite(path, contents) {
	const temporaryPath = `${path}.${process.pid}.tmp`;
	await writeFile(temporaryPath, contents);
	await rename(temporaryPath, path);
}

async function atomicCopy(source, destination) {
	await mkdir(dirname(destination), { recursive: true });
	const temporaryPath = `${destination}.${process.pid}.tmp`;
	await copyFile(source, temporaryPath);
	await rename(temporaryPath, destination);
}

// Pi installs git packages without running a consumer-side build hook. Keep the
// bundle committed beside its source so consumers receive both at one commit;
// the default test suite enforces that this output is fresh by comparing the
// recorded input graph and copied assets against the committed sidecars.
await mkdir(outDir, { recursive: true });

// Build entirely in memory, verify the dependency graph did not change while
// esbuild was reading it, and only then publish. The manifest is invalidated
// first and re-published last, so it is the single commit point: a concurrent
// launch either sees the old valid manifest+artifact or, during publish, an
// invalid manifest that forces the safe source fallback — never a torn or
// rejected artifact behind a fresh manifest.
const probe = await build(buildOptions);
const beforeBuild = await createExtensionInputManifest(root, Object.keys(probe.metafile.inputs));
await atomicWrite(manifestPath, `${JSON.stringify({ version: 0, inputs: [], hash: "build-in-progress" }, null, 2)}\n`);

const result = await build(buildOptions);
const inputManifest = await createExtensionInputManifest(root, Object.keys(result.metafile.inputs));
if (!extensionInputManifestsMatch(beforeBuild, inputManifest)) {
	throw new Error("Extension bundle inputs changed during build; retry from a stable checkout");
}

// Atomically publish the validated bundle and sourcemap from memory, then the
// copied assets, before recomputing the output hash over the published bytes.
for (const file of result.outputFiles) {
	await atomicWrite(file.path, file.contents);
}
for (const asset of EXTENSION_ASSETS) {
	await atomicCopy(resolve(root, asset.source), resolve(outDir, asset.output));
}

// The manifest commit point, written last: it binds the input graph hash and a
// hash of this build's published outputs into ONE unit, so a partial update
// cannot leave a matching manifest beside a stale bundle. Runtime rejects both
// stale inputs and a mismatched artifact.
const outputsHash = await extensionOutputsHash(root);
await atomicWrite(manifestPath, `${JSON.stringify({ ...inputManifest, outputsHash }, null, 2)}\n`);

console.log(`[sumocode] extension bundle: ${bundlePath}`);
console.log(`[sumocode] extension inputs: ${inputManifest.inputs.length} files (${inputManifest.hash.slice(0, 12)})`);
console.log(`[sumocode] extension outputs hash: ${outputsHash}`);
console.log("[sumocode] extension bundle build succeeded");
