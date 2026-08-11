import { copyFile, mkdir, rename, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";
import { createHostInputManifest, HOST_INPUT_MANIFEST_OUTPUT } from "./lib/host-bundle.mjs";

const root = resolve(import.meta.dirname, "..");
const outDir = resolve(root, "dist/host");
const bundlePath = resolve(outDir, "sumo-rpc-host.bundle.mjs");

await mkdir(outDir, { recursive: true });
const result = await build({
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
});

const assetDir = resolve(outDir, "assets");
await mkdir(assetDir, { recursive: true });
await copyFile(resolve(root, "src/assets/sumo-face.ans"), resolve(assetDir, "sumo-face.ans"));

// host.ts resolves this plain-JS pre-spawn helper relative to its own
// import.meta.url. Keep the helper beside the bundle so createRequire() has
// the same runtime resolution it has from src/sumo-tui/rpc/host.ts.
await copyFile(resolve(root, "src/sumo-tui/rpc/spawn-child.mjs"), resolve(outDir, "spawn-child.mjs"));

// Persist esbuild's exact project input graph plus build/config/copied inputs.
// Runtime re-hashes this recorded set, so modified, renamed, and deleted source
// files all invalidate an otherwise newer surviving artifact.
const inputManifest = await createHostInputManifest(root, Object.keys(result.metafile.inputs));
const manifestPath = resolve(outDir, HOST_INPUT_MANIFEST_OUTPUT);
const temporaryManifestPath = `${manifestPath}.${process.pid}.tmp`;
await writeFile(temporaryManifestPath, `${JSON.stringify(inputManifest, null, 2)}\n`);
await rename(temporaryManifestPath, manifestPath);

const { size } = await stat(bundlePath);
console.log(`[sumocode] host bundle: ${bundlePath} (${size} bytes)`);
console.log("[sumocode] host bundle build succeeded");
