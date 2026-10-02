import { resolve } from "node:path";
import { build } from "esbuild";
import { assertNoProductionDependencyLeakage, bundleJavaScriptText, moduleSpecifiers } from "./production-boundaries.mjs";

export const STEERING_ACK_OUTPUT = "steering-ack.effect.mjs";

// A single reviewed local edge, not an Effect-package external allowance. Keeping
// it out of the main bundle prevents esbuild hoisting external Effect imports.
export const steeringAckBoundary = {
	name: "visible-steering-lazy-boundary",
	setup(builder) {
		builder.onResolve({ filter: /^\.\/steering-ack-effect\.js$/ }, (args) => {
			if (args.kind !== "dynamic-import" || !args.importer.endsWith("/src/subagents/backend-pane.ts")) {
				throw new Error("steering acknowledgement implementation must remain a backend-owned dynamic import");
			}
			return { path: `./${STEERING_ACK_OUTPUT}`, external: true };
		});
	},
};

export async function buildSteeringAckBundle(root, outDir) {
	const result = await build({
		absWorkingDir: root,
		entryPoints: ["src/subagents/steering-ack-effect.ts"],
		outfile: resolve(outDir, STEERING_ACK_OUTPUT),
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
