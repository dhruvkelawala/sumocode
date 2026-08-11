import { copyFile, mkdir, rename, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";
import {
	createHostInputManifest,
	hostInputManifestsMatch,
	HOST_INPUT_MANIFEST_OUTPUT,
} from "./lib/host-bundle.mjs";

const root = resolve(import.meta.dirname, "..");
const outDir = resolve(root, "dist/host");
const bundlePath = resolve(outDir, "sumo-rpc-host.bundle.mjs");
const manifestPath = resolve(outDir, HOST_INPUT_MANIFEST_OUTPUT);
const buildOptions = {
	absWorkingDir: root,
	entryPoints: ["src/sumo-tui/rpc/host.ts"],
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

await mkdir(outDir, { recursive: true });

// Discover the exact graph, snapshot it, then build once more and verify the
// graph and bytes did not change while esbuild was reading them. Mark the old
// artifact invalid before the writing build so an interrupted/racy build can
// only fall back to source, never bless mixed-checkout output.
const probe = await build({ ...buildOptions, write: false });
const beforeBuild = await createHostInputManifest(root, Object.keys(probe.metafile.inputs));
await writeManifest({ version: 0, inputs: [], hash: "build-in-progress" });
const result = await build(buildOptions);
const inputManifest = await createHostInputManifest(root, Object.keys(result.metafile.inputs));
if (!hostInputManifestsMatch(beforeBuild, inputManifest)) {
	throw new Error("Host bundle inputs changed during build; retry from a stable checkout");
}

const assetDir = resolve(outDir, "assets");
await mkdir(assetDir, { recursive: true });
await copyFile(resolve(root, "src/assets/sumo-face.ans"), resolve(assetDir, "sumo-face.ans"));

// host.ts resolves this plain-JS pre-spawn helper relative to its own
// import.meta.url. Keep the helper beside the bundle so createRequire() has
// the same runtime resolution it has from src/sumo-tui/rpc/host.ts.
await copyFile(resolve(root, "src/sumo-tui/rpc/spawn-child.mjs"), resolve(outDir, "spawn-child.mjs"));

// Runtime re-hashes this recorded set, so modified, renamed, and deleted source
// files all invalidate an otherwise newer surviving artifact.
await writeManifest(inputManifest);

const { size } = await stat(bundlePath);
console.log(`[sumocode] host bundle: ${bundlePath} (${size} bytes)`);
console.log("[sumocode] host bundle build succeeded");
