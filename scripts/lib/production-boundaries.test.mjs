import { describe, expect, it } from "vitest";
import { assertNoEffectInEagerClosure, assertNoProductionDependencyLeakage, bundleJavaScriptText } from "./production-boundaries.mjs";

function nativeMetafile(preflightImport) {
	return {
		inputs: {
			"src/native/main.ts": {
				imports: [
					{ path: "src/native/preflight.ts", kind: "import-statement" },
					{ path: "src/sumo-tui/rpc/host.ts", kind: "dynamic-import" },
				],
			},
			"src/native/preflight.ts": { imports: preflightImport ? [preflightImport] : [] },
			"src/sumo-tui/rpc/host.ts": {
				imports: [{ path: "node_modules/effect/dist/Effect.js", kind: "import-statement" }],
			},
			"node_modules/effect/dist/Effect.js": { imports: [] },
		},
	};
}

describe("production artifact dependency boundary", () => {
	it("scans JavaScript outputs without treating source maps as artifacts", () => {
		expect(bundleJavaScriptText([
			{ path: "dist/bundle.js", text: 'import "effect/Effect";' },
			{ path: "dist/bundle.js.map", text: 'import "msgpackr";' },
		])).toBe('import "effect/Effect";');
	});

	it("accepts ordinary production inputs", () => {
		expect(() => assertNoProductionDependencyLeakage({
			inputs: { "node_modules/effect/dist/Effect.js": { imports: [] } },
			outputs: { "dist/bundle.js": { imports: [] } },
		}, "host bundle")).not.toThrow();
	});

	it.each([
		["bundled input", {
			inputs: { "node_modules/.pnpm/fast-check@4/node_modules/fast-check/lib/index.js": { imports: [] } },
			outputs: {},
		}, ""],
		["external output import", {
			inputs: {},
			outputs: { "dist/bundle.js": { imports: [{ path: "msgpackr", external: true }] } },
		}, ""],
		["surviving output import", { inputs: {}, outputs: {} }, 'import "fast-check";'],
	])("rejects a forbidden package from a %s", (_case, metafile, outputText) => {
		expect(() => assertNoProductionDependencyLeakage(
			metafile,
			"host bundle",
			outputText,
		)).toThrow("host bundle includes forbidden production package");
	});
});

describe("native eager/pre-adoption closure", () => {
	it("allows Effect only behind the intentionally lazy host edge", () => {
		expect(() => assertNoEffectInEagerClosure(
			nativeMetafile(),
			"src/native/main.ts",
			"native launcher",
		)).not.toThrow();
	});

	it.each(["effect/Effect", "@effect/platform-node/NodeRuntime"])(
		"rejects %s when imported by an eager pre-adoption module",
		(specifier) => {
			expect(() => assertNoEffectInEagerClosure(
				nativeMetafile({ path: specifier, kind: "import-statement", external: true }),
				"src/native/main.ts",
				"native launcher",
			)).toThrow(`native launcher eager closure includes forbidden package via src/native/main.ts -> src/native/preflight.ts -> ${specifier}`);
		},
	);

});
