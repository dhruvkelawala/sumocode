import { resolve } from "node:path";
import { build } from "esbuild";
import { assertNoProductionDependencyLeakage, bundleJavaScriptText, moduleSpecifiers } from "./production-boundaries.mjs";

export const STEERING_ACK_OUTPUT = "steering-ack.effect.mjs";
export const MANIFEST_OUTPUT = "manifest.effect.mjs";

// A single reviewed local edge, not an Effect-package external allowance. Keeping
// it out of the main bundle prevents esbuild hoisting external Effect imports.
export const steeringAckBoundary = {
	name: "visible-steering-lazy-boundary",
	setup(builder) {
		builder.onResolve({ filter: /^\.\/manifest-effect\.js$/ }, (args) => {
			if (args.kind !== "dynamic-import" || !args.importer.endsWith("/src/subagents/manifest.ts")) {
				throw new Error("manifest implementation must remain a collector-owned dynamic import");
			}
			return { path: `./${MANIFEST_OUTPUT}`, external: true };
		});
		builder.onResolve({ filter: /^\.\/steering-ack-effect\.js$/ }, (args) => {
			if (args.kind !== "dynamic-import" || !args.importer.endsWith("/src/subagents/backend-pane.ts")) {
				throw new Error("steering acknowledgement implementation must remain a backend-owned dynamic import");
			}
			return { path: `./${STEERING_ACK_OUTPUT}`, external: true };
		});
	},
};

export function buildSteeringAckBundle(root, outDir) {
	return buildLazyBundle(root, outDir, "src/subagents/steering-ack-effect.ts", STEERING_ACK_OUTPUT);
}

export function buildManifestBundle(root, outDir) {
	return buildLazyBundle(root, outDir, "src/subagents/manifest-effect.ts", MANIFEST_OUTPUT);
}

async function buildLazyBundle(root, outDir, entry, output) {
	const result = await build({
		absWorkingDir: root,
		entryPoints: [entry],
		outfile: resolve(outDir, output),
		bundle: true,
		format: "esm",
		platform: "node",
		target: "node22",
		metafile: true,
		write: false,
	});
	const text = bundleJavaScriptText(result.outputFiles);
	assertNoProductionDependencyLeakage(result.metafile, `lazy ${output} bundle`, text);
	if (moduleSpecifiers(text).some((path) => !path.startsWith("node:"))) {
		throw new Error(`lazy ${output} bundle retains a non-Node import`);
	}
	return result;
}
