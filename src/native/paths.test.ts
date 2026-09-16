import { describe, expect, it } from "vitest";
import { ASSET_DIR_OVERRIDE_ENV_KEY, isNativeRuntime, resolveAsset, resolveNativeDir } from "./paths.js";

describe("native paths seam", () => {
	it("reports a non-native runtime when SUMOCODE_NATIVE_DIR is unset or blank", () => {
		expect(resolveNativeDir({})).toBeNull();
		expect(resolveNativeDir({ SUMOCODE_NATIVE_DIR: "" })).toBeNull();
		expect(resolveNativeDir({ SUMOCODE_NATIVE_DIR: "   " })).toBeNull();
		expect(isNativeRuntime({})).toBe(false);
	});

	it("reports the native dir verbatim when set", () => {
		expect(resolveNativeDir({ SUMOCODE_NATIVE_DIR: "/opt/sumocode" })).toBe("/opt/sumocode");
		expect(resolveNativeDir({ SUMOCODE_NATIVE_DIR: "/opt/sumocode " })).toBe("/opt/sumocode");
		expect(isNativeRuntime({ SUMOCODE_NATIVE_DIR: "/opt/sumocode" })).toBe(true);
	});

	it("resolves assets from the override dir before the native dir", () => {
		const env = {
			SUMOCODE_NATIVE_DIR: "/opt/sumocode",
			[ASSET_DIR_OVERRIDE_ENV_KEY]: "/tmp/assets",
		};
		expect(resolveAsset("sumo-face.ans", () => "/dev/source/sumo-face.ans", env)).toBe("/tmp/assets/sumo-face.ans");
	});

	it("resolves assets under share/ of the native dir", () => {
		const env = { SUMOCODE_NATIVE_DIR: "/opt/sumocode" };
		expect(resolveAsset("sumo-face.ans", () => "/dev/source/assets/sumo-face.ans", env)).toBe("/opt/sumocode/share/sumo-face.ans");
	});

	it("falls back to the dev path off the native runtime, supporting lazy thunks", () => {
		expect(resolveAsset("sumo-face.ans", () => "/dev/source/sumo-face.ans", {})).toBe("/dev/source/sumo-face.ans");
		let called = 0;
		expect(resolveAsset("sumo-face.ans", () => {
			called += 1;
			return "/dev/thunk/sumo-face.ans";
		}, {})).toBe("/dev/thunk/sumo-face.ans");
		expect(called).toBe(1);
		// The thunk never runs when native resolution wins.
		resolveAsset("sumo-face.ans", () => {
			called += 1;
			return "/dev/thunk/sumo-face.ans";
		}, { SUMOCODE_NATIVE_DIR: "/opt/sumocode" });
		expect(called).toBe(1);
	});
});
