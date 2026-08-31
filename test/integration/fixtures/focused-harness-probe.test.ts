import { existsSync } from "node:fs";
import { expect, it } from "vitest";
import { createChildEvidenceContext } from "../harness-supervisor.js";

it("uses the focused harness lifecycle", () => {
	const evidenceDir = createChildEvidenceContext([process.execPath, "focused-probe"]).evidenceDir;
	expect(existsSync(evidenceDir)).toBe(true);
});
