#!/usr/bin/env node
// Visual harness runner. Walks docs/visual/*.tape and pipes each through `vhs`,
// printing a one-line status per tape. Outputs PNGs to docs/visual/out/.

import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tapeDir = resolve(repoRoot, "docs", "visual");
const outDir = resolve(tapeDir, "out");

mkdirSync(outDir, { recursive: true });

const tapes = readdirSync(tapeDir)
	.filter((name) => name.endsWith(".tape"))
	.sort();

if (tapes.length === 0) {
	console.error("No .tape files found in docs/visual/.");
	process.exit(1);
}

let failed = 0;
for (const tape of tapes) {
	const fullPath = resolve(tapeDir, tape);
	process.stdout.write(`[visual] ${tape} ... `);
	const result = spawnSync("vhs", [fullPath], {
		cwd: repoRoot,
		stdio: ["ignore", "pipe", "pipe"],
		env: process.env,
	});
	if (result.status === 0) {
		console.log("ok");
	} else {
		failed++;
		console.log("FAIL");
		const stderr = result.stderr?.toString() ?? "";
		if (stderr.trim()) console.error(stderr.split("\n").slice(0, 12).join("\n"));
	}
}

if (failed > 0) {
	console.error(`\n${failed}/${tapes.length} tape(s) failed`);
	process.exit(1);
}

console.log(`\nAll ${tapes.length} tape(s) rendered into docs/visual/out/`);
