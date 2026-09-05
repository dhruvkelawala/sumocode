import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { createChildEvidenceContext, spawnSupervisedProcess } from "../harness-supervisor.js";

it("uses the focused harness lifecycle", async () => {
	const evidenceDir = createChildEvidenceContext([process.execPath, "focused-probe"]).evidenceDir;
	const root = resolve(evidenceDir, "../../..");
	const marker = join(root, "evidence-retained.json");
	// Earlier tests may have retained this shared run; the probe must leave it unchanged.
	const markerBefore = existsSync(marker) ? readFileSync(marker) : undefined;
	const supervised = spawnSupervisedProcess(process.execPath, ["-e", "setInterval(() => {}, 1_000)"], {
		stdio: ["ignore", "ignore", "pipe"],
	});
	supervised.child.once("exit", () => {
		if (!supervised.shouldCaptureExitFailure(false)) return;
		void supervised.captureFailure();
	});
	await supervised.terminate();

	expect(existsSync(evidenceDir)).toBe(true);
	expect(existsSync(marker) ? readFileSync(marker) : undefined).toEqual(markerBefore);
	expect(process.env.TMPDIR).toBe(join(root, "tmp"));
});
