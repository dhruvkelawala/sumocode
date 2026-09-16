import { describe, expect, it } from "vitest";
import { assertEagerClosureExcludesPackages } from "./production-boundaries.mjs";

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

describe("native eager/pre-adoption closure", () => {
	it("allows Effect only behind the intentionally lazy host edge", () => {
		expect(() => assertEagerClosureExcludesPackages(
			nativeMetafile(),
			"src/native/main.ts",
			["effect"],
			"native launcher",
		)).not.toThrow();
	});

	it("rejects a forbidden package imported by an eager pre-adoption module", () => {
		expect(() => assertEagerClosureExcludesPackages(
			nativeMetafile({ path: "effect/Effect", kind: "import-statement", external: true }),
			"src/native/main.ts",
			["effect"],
			"native launcher",
		)).toThrow("native launcher eager closure includes forbidden package effect via src/native/main.ts -> src/native/preflight.ts -> effect/Effect");
	});
});
