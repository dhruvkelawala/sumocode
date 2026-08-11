import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

interface ChildSpawnPlan {
	readonly command: string;
	readonly args: readonly string[];
	readonly env: NodeJS.ProcessEnv;
}

const require = createRequire(import.meta.url);
const { buildChildSpawnPlan } = require("./spawn-child.mjs") as {
	buildChildSpawnPlan(env: NodeJS.ProcessEnv, argv: readonly string[], defaultPiBin?: string): ChildSpawnPlan | undefined;
};

describe("RPC host child spawn fallback", () => {
	it("uses an explicit default binary with the complete RPC argument contract", () => {
		const result = buildChildSpawnPlan({ SUMOCODE_ROOT_DIR: "/repo/sumocode" }, ["--offline"], "pi");
		expect(result).toMatchObject({
			command: "pi",
			env: { SUMOCODE_RPC_CHILD: "1", SUMO_TUI: "0" },
		});
		expect(result?.args.slice(0, 3)).toEqual(["--mode", "rpc", "-e"]);
		expect(result?.args[3]).toMatch(/\/repo\/sumocode\/src\/extension(?:-entry)?\.ts$/);
		expect(result?.args[4]).toBe("--offline");
	});

	it("returns no plan when neither PI_BIN nor a default is available", () => {
		expect(buildChildSpawnPlan({}, [])).toBeUndefined();
	});
});
