import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { createChildEvidenceContext } from "../harness-supervisor.js";

it("uses the focused harness lifecycle", () => {
	const evidenceDir = createChildEvidenceContext([process.execPath, "focused-probe"]).evidenceDir;
	const root = resolve(evidenceDir, "../../..");
	expect(existsSync(evidenceDir)).toBe(true);
	expect(process.env.TMPDIR).toBe(join(root, "tmp"));
});
