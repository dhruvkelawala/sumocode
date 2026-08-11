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
};

async function writeManifest(manifest) {
	const temporaryManifestPath = `${manifestPath}.${process.pid}.tmp`;
	await writeFile(temporaryManifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
	await rename(temporaryManifestPath, manifestPath);
}

// Pi installs git packages without running a consumer-side build hook. Keep the
// bundle committed beside its source so consumers receive both at one commit;
// the default test suite enforces that this output is fresh by comparing the
// recorded input graph and copied assets against the committed sidecars.
await mkdir(outDir, { recursive: true });

// Discover the exact dependency graph, snapshot it, then build once more and
// verify inputs did not change while esbuild was reading them. Marking the old
// manifest invalid before the writing build means an interrupted or racy build
// can only fall back to source, never bless mixed-checkout output.
const probe = await build({ ...buildOptions, write: false });
const beforeBuild = await createExtensionInputManifest(root, Object.keys(probe.metafile.inputs));
await writeManifest({ version: 0, inputs: [], hash: "build-in-progress" });
const result = await build(buildOptions);
const inputManifest = await createExtensionInputManifest(root, Object.keys(result.metafile.inputs));
if (!extensionInputManifestsMatch(beforeBuild, inputManifest)) {
	throw new Error("Extension bundle inputs changed during build; retry from a stable checkout");
}

for (const asset of EXTENSION_ASSETS) {
	const destination = resolve(outDir, asset.output);
	await mkdir(dirname(destination), { recursive: true });
	await copyFile(resolve(root, asset.source), destination);
}

const outputsHash = await extensionOutputsHash(root);
await Promise.all([
	writeManifest(inputManifest),
	writeFile(resolve(outDir, ".outputs-hash"), `${outputsHash}\n`),
]);

console.log(`[sumocode] extension bundle: ${bundlePath}`);
console.log(`[sumocode] extension inputs: ${inputManifest.inputs.length} files (${inputManifest.hash.slice(0, 12)})`);
console.log(`[sumocode] extension outputs hash: ${outputsHash}`);
console.log("[sumocode] extension bundle build succeeded");
