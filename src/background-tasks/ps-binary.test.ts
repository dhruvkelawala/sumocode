import { expect, it } from "vitest";
import { resolvePsBinary } from "./ps-binary.js";

it("keeps the system ps default and accepts only an explicit absolute test binary", () => {
	expect(resolvePsBinary({ PATH: "/untrusted/bin" })).toBe("/bin/ps");
	expect(resolvePsBinary({ SUMOCODE_TEST_PS_BIN: "/owned path/ps" })).toBe("/owned path/ps");
	for (const binary of ["", "ps", "./ps"]) {
		expect(() => resolvePsBinary({ SUMOCODE_TEST_PS_BIN: binary })).toThrow("must be absolute");
	}
});
