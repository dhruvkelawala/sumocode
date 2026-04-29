#!/usr/bin/env node
// T1: Real-runtime VHS matrix runner. Walks docs/visual/real-runtime/*.tape and
// pipes each through `vhs`, printing one-line status per tape.
//
// All tapes here drive the ACTUAL ./bin/sumocode.sh (or equivalent) — no demo
// extensions. This is the canonical pre-merge UX check.
//
// Output PNGs go to docs/visual/out/real-runtime/.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tapeDir = resolve(repoRoot, "docs", "visual", "real-runtime");
const outDir = resolve(repoRoot, "docs", "visual", "out", "real-runtime");

if (!existsSync(tapeDir)) {
	console.error(`No tape directory at ${tapeDir}`);
	process.exit(1);
}

mkdirSync(outDir, { recursive: true });

const tapes = readdirSync(tapeDir)
	.filter((name) => name.endsWith(".tape"))
	.sort();

if (tapes.length === 0) {
	console.error(`No .tape files found in ${tapeDir}`);
	process.exit(1);
}

console.log(`[visual-real-runtime] rendering ${tapes.length} tape(s)`);
console.log("");

let failed = 0;
const start = Date.now();
for (const tape of tapes) {
	const fullPath = resolve(tapeDir, tape);
	process.stdout.write(`  ${tape.padEnd(40)} `);
	const tapeStart = Date.now();
	const result = spawnSync("vhs", [fullPath], {
		cwd: repoRoot,
		stdio: ["ignore", "pipe", "pipe"],
		env: process.env,
	});
	const elapsed = ((Date.now() - tapeStart) / 1000).toFixed(1);
	if (result.status === 0) {
		console.log(`ok  (${elapsed}s)`);
	} else {
		failed++;
		console.log(`FAIL (${elapsed}s)`);
		const stderr = result.stderr?.toString() ?? "";
		if (stderr.trim()) {
			console.error(
				stderr
					.split("\n")
					.slice(0, 12)
					.map((l) => `      ${l}`)
					.join("\n"),
			);
		}
	}
}

const totalElapsed = ((Date.now() - start) / 1000).toFixed(1);
console.log("");
if (failed > 0) {
	console.error(`${failed}/${tapes.length} tape(s) failed (${totalElapsed}s)`);
	process.exit(1);
}

console.log(`All ${tapes.length} tape(s) rendered in ${totalElapsed}s`);
console.log(`Outputs: docs/visual/out/real-runtime/`);
