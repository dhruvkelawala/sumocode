import { copyFile, mkdir, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { build } from "esbuild";

const root = resolve(import.meta.dirname, "..");
const outDir = resolve(root, "dist/host");
const bundlePath = resolve(outDir, "sumo-rpc-host.bundle.mjs");

await mkdir(outDir, { recursive: true });
await build({
	absWorkingDir: root,
	entryPoints: ["src/sumo-tui/rpc/host.ts"],
	outfile: bundlePath,
	bundle: true,
	format: "esm",
	platform: "node",
	target: "node22",
	packages: "external",
	sourcemap: true,
});

const assetDir = resolve(outDir, "assets");
await mkdir(assetDir, { recursive: true });
await copyFile(resolve(root, "src/assets/sumo-face.ans"), resolve(assetDir, "sumo-face.ans"));

// host.ts resolves this plain-JS pre-spawn helper relative to its own
// import.meta.url. Keep the helper beside the bundle so createRequire() has
// the same runtime resolution it has from src/sumo-tui/rpc/host.ts.
await copyFile(resolve(root, "src/sumo-tui/rpc/spawn-child.mjs"), resolve(outDir, "spawn-child.mjs"));

const { size } = await stat(bundlePath);
console.log(`[sumocode] host bundle: ${bundlePath} (${size} bytes)`);
console.log("[sumocode] host bundle build succeeded");
