import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveExecutableProvenance } from "./executable-provenance.js";

describe("resolveExecutableProvenance", () => {
	it("preserves explicit and parent-selected executable provenance", () => {
		expect(resolveExecutableProvenance({
			pi: "/explicit/pi",
			sumocode: "sumocode-dev",
			env: { PI_BIN: "/parent/pi", SUMOCODE_LAUNCHER: "/parent/sumocode" },
		})).toEqual({ pi: "/explicit/pi", sumocode: "sumocode-dev" });
		expect(resolveExecutableProvenance({
			env: { PI_BIN: " ./tools/pi ", SUMOCODE_LAUNCHER: " ./bin/sumocode.sh " },
		})).toEqual({ pi: resolve("./tools/pi"), sumocode: resolve("./bin/sumocode.sh") });
	});

	it("retains command names and falls back only for blank provenance", () => {
		expect(resolveExecutableProvenance({
			env: { PI_BIN: "pi-dev", SUMOCODE_LAUNCHER: "sumocode-dev" },
		})).toEqual({ pi: "pi-dev", sumocode: "sumocode-dev" });
		expect(resolveExecutableProvenance({
			pi: " ",
			sumocode: " ",
			env: { PI_BIN: " ", SUMOCODE_LAUNCHER: "" },
		})).toEqual({ pi: "pi", sumocode: "sumocode" });
	});

	it("reads the environment for each resolution call", () => {
		const env = { PI_BIN: "/first/pi", SUMOCODE_LAUNCHER: "/first/sumocode" };
		expect(resolveExecutableProvenance({ env }).pi).toBe("/first/pi");
		env.PI_BIN = "/second/pi";
		expect(resolveExecutableProvenance({ env }).pi).toBe("/second/pi");
	});
});
