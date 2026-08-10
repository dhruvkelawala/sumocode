import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { build } from "esbuild";
import { EXTENSION_ASSETS, extensionInputsHash } from "./lib/extension-bundle.mjs";

const root = resolve(import.meta.dirname, "..");
const outDir = resolve(root, "dist/extension");
const bundlePath = resolve(outDir, "sumocode-extension.bundle.mjs");

// Pi installs git packages without running a consumer-side build hook. Keep the
// bundle committed beside its source so consumers receive both at one commit;
// the default test suite enforces that this output is fresh by comparing this
// sidecar's hash with the source and copied-asset inputs.
await mkdir(outDir, { recursive: true });
await build({
	absWorkingDir: root,
	entryPoints: ["src/extension.ts"],
	outfile: bundlePath,
	bundle: true,
	format: "esm",
	platform: "node",
	target: "node22",
	packages: "external",
	sourcemap: true,
});

for (const asset of EXTENSION_ASSETS) {
	const destination = resolve(outDir, asset.output);
	await mkdir(dirname(destination), { recursive: true });
	await copyFile(resolve(root, asset.source), destination);
}

const inputsHash = await extensionInputsHash(root);
await writeFile(resolve(outDir, ".inputs-hash"), `${inputsHash}\n`);

console.log(`[sumocode] extension bundle: ${bundlePath}`);
console.log(`[sumocode] extension inputs hash: ${inputsHash}`);
console.log("[sumocode] extension bundle build succeeded");
