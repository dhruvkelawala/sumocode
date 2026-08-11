import { copyFile, mkdir, rename, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";
import {
	createHostInputManifest,
	hostInputManifestsMatch,
	hostOutputsHash,
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
	write: false,
};

async function atomicWrite(path, contents) {
	const temporaryPath = `${path}.${process.pid}.tmp`;
	await writeFile(temporaryPath, contents);
	await rename(temporaryPath, path);
}

async function atomicCopy(source, destination) {
	const temporaryPath = `${destination}.${process.pid}.tmp`;
	await copyFile(source, temporaryPath);
	await rename(temporaryPath, destination);
}

await mkdir(outDir, { recursive: true });
await mkdir(resolve(outDir, "assets"), { recursive: true });

// Build entirely in memory, verify the dependency graph did not change while
// esbuild was reading it, and only then publish. The manifest is invalidated
// first and re-published last, so it is the single commit point: a concurrent
// launch either sees the old valid manifest+artifact or, during publish, an
// invalid manifest that forces the safe source fallback — never a torn or
// rejected artifact behind a fresh manifest.
const probe = await build(buildOptions);
const beforeBuild = await createHostInputManifest(root, Object.keys(probe.metafile.inputs));
await atomicWrite(manifestPath, `${JSON.stringify({ version: 0, inputs: [], hash: "build-in-progress" }, null, 2)}\n`);

const result = await build(buildOptions);
const inputManifest = await createHostInputManifest(root, Object.keys(result.metafile.inputs));
if (!hostInputManifestsMatch(beforeBuild, inputManifest)) {
	throw new Error("Host bundle inputs changed during build; retry from a stable checkout");
}

// Atomically publish the validated bundle and sourcemap from memory.
for (const file of result.outputFiles) {
	await atomicWrite(file.path, file.contents);
}
await atomicCopy(resolve(root, "src/assets/sumo-face.ans"), resolve(outDir, "assets/sumo-face.ans"));
// host.ts resolves this plain-JS pre-spawn helper relative to its own
// import.meta.url. Keep the helper beside the bundle so createRequire() has
// the same runtime resolution it has from src/sumo-tui/rpc/host.ts.
await atomicCopy(resolve(root, "src/sumo-tui/rpc/spawn-child.mjs"), resolve(outDir, "spawn-child.mjs"));

// The manifest commit point: it records both the input graph hash and a hash of
// this build's published outputs, so runtime rejects stale inputs AND a bundle
// belonging to a different concurrent build. Written last, after every output.
const outputsHash = await hostOutputsHash(root);
await atomicWrite(manifestPath, `${JSON.stringify({ ...inputManifest, outputsHash }, null, 2)}\n`);

const { size } = await stat(bundlePath);
console.log(`[sumocode] host bundle: ${bundlePath} (${size} bytes)`);
console.log("[sumocode] host bundle build succeeded");
