import { describe, expect, it } from "vitest";
import { parseNewSplitOutput } from "./cmux-split.js";

describe("cmux-split", () => {
	it("parseNewSplitOutput extracts surface and workspace refs", () => {
		expect(parseNewSplitOutput("OK surface:2 workspace:1\n")).toEqual({
			surfaceRef: "surface:2",
			workspaceRef: "workspace:1",
		});
	});

	it("parseNewSplitOutput returns undefined refs for empty stdout", () => {
		expect(parseNewSplitOutput("")).toEqual({});
	});
});
