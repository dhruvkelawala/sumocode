import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { createChildEvidenceContext, spawnSupervisedProcess } from "../harness-supervisor.js";

it("uses the focused harness lifecycle", async () => {
	const evidenceDir = createChildEvidenceContext([process.execPath, "focused-probe"]).evidenceDir;
	const root = resolve(evidenceDir, "../../..");
	const supervised = spawnSupervisedProcess(process.execPath, ["-e", "setInterval(() => {}, 1_000)"], {
		stdio: ["ignore", "ignore", "pipe"],
	});
	supervised.child.once("exit", () => {
		if (!supervised.shouldCaptureExitFailure(false)) return;
		void supervised.captureFailure();
	});
	await supervised.terminate();

	expect(existsSync(evidenceDir)).toBe(true);
	expect(existsSync(join(root, "evidence-retained.json"))).toBe(false);
	expect(process.env.TMPDIR).toBe(join(root, "tmp"));
});
