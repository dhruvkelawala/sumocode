import { resolve } from "node:path";
import { build } from "esbuild";
import { assertNoProductionDependencyLeakage, bundleJavaScriptText, moduleSpecifiers } from "./production-boundaries.mjs";

export const STEERING_ACK_OUTPUT = "steering-ack.effect.mjs";
export const HEADLESS_CLEANUP_OUTPUT = "headless-cleanup.effect.mjs";

// Only reviewed backend-owned edges, never Effect-package externals. Keeping
// both out of the main bundle prevents esbuild hoisting external Effect imports.
export const steeringAckBoundary = {
	name: "visible-steering-lazy-boundary",
	setup(builder) {
		builder.onResolve({ filter: /^\.\/(steering-ack|headless-cleanup)-effect\.js$/ }, (args) => {
			const headless = args.path === "./headless-cleanup-effect.js";
			const owner = headless ? "backend-pi.ts" : "backend-pane.ts";
			if (args.kind !== "dynamic-import" || !args.importer.endsWith(`/src/subagents/${owner}`)) {
				throw new Error("lifecycle implementation must remain a backend-owned dynamic import");
			}
			return { path: `./${headless ? HEADLESS_CLEANUP_OUTPUT : STEERING_ACK_OUTPUT}`, external: true };
		});
	},
};

export async function buildSteeringAckBundle(root, outDir) {
	const result = await build({
		absWorkingDir: root,
		entryPoints: {
			"steering-ack.effect": "src/subagents/steering-ack-effect.ts",
			"headless-cleanup.effect": "src/subagents/headless-cleanup-effect.ts",
		},
		outdir: resolve(outDir),
		outExtension: { ".js": ".mjs" },
		bundle: true,
		format: "esm",
		platform: "node",
		target: "node22",
		metafile: true,
		write: false,
	});
	const text = bundleJavaScriptText(result.outputFiles);
	assertNoProductionDependencyLeakage(result.metafile, "lazy steering acknowledgement bundle", text);
	if (moduleSpecifiers(text).some((path) => !path.startsWith("node:"))) {
		throw new Error("lazy steering acknowledgement bundle retains a non-Node import");
	}
	return result;
}
