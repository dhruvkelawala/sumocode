// Runs a full project typecheck with --extendedDiagnostics and fails when the
// type instantiation count exceeds the recorded baseline by more than the budget
// factor. Plan 118 Wave 0.6: Effect is type-heavy, so this makes a type-check
// blow-up a reviewed change rather than a silent CI slowdown.
//
//   node scripts/check-tsc-budget.mjs            # enforce against docs/perf/typecheck.json
//   node scripts/check-tsc-budget.mjs --record   # rewrite the baseline from this run
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const baselinePath = resolve(root, "docs/perf/typecheck.json");
const record = process.argv.includes("--record");

// Force a full (non-incremental) pass: an incremental run reports only the files
// it re-checked, so its instantiation count is not comparable to the baseline.
const run = spawnSync("pnpm", ["exec", "tsc", "--noEmit", "--incremental", "false", "--extendedDiagnostics"], {
	cwd: root,
	encoding: "utf8",
	stdio: ["ignore", "pipe", "inherit"],
});
process.stdout.write(run.stdout);
if (run.status !== 0) process.exit(run.status ?? 1);

function metric(name) {
	const match = run.stdout.match(new RegExp(`^${name}:\\s+([\\d.]+)`, "m"));
	if (!match) {
		console.error(`[tsc-budget] could not find "${name}" in --extendedDiagnostics output`);
		process.exit(1);
	}
	return Number(match[1]);
}

const observed = {
	files: metric("Files"),
	instantiations: metric("Instantiations"),
	checkTimeSeconds: metric("Check time"),
	totalTimeSeconds: metric("Total time"),
	memoryUsedKb: metric("Memory used"),
};

if (record) {
	const previous = readBaseline();
	const next = {
		...previous,
		budgetFactor: previous?.budgetFactor ?? 2,
		recordedAt: new Date().toISOString().slice(0, 10),
		typescript: JSON.parse(readFileSync(resolve(root, "node_modules/typescript/package.json"), "utf8")).version,
		...observed,
	};
	writeFileSync(baselinePath, `${JSON.stringify(next, null, 2)}\n`);
	console.log(`[tsc-budget] baseline recorded to ${baselinePath}`);
	process.exit(0);
}

const baseline = readBaseline();
if (!baseline) {
	console.error(`[tsc-budget] no baseline at ${baselinePath}; run with --record first`);
	process.exit(1);
}
const limit = Math.round(baseline.instantiations * baseline.budgetFactor);
const ratio = (observed.instantiations / baseline.instantiations).toFixed(2);
console.log(
	`[tsc-budget] instantiations ${observed.instantiations} vs baseline ${baseline.instantiations} (x${ratio}); limit ${limit}`,
);
if (observed.instantiations > limit) {
	console.error(
		`[tsc-budget] instantiations exceed ${baseline.budgetFactor}x the recorded baseline. ` +
			"If this is intended (for example an Effect-heavy slice), re-record with --record in the same PR and explain the jump.",
	);
	process.exit(1);
}

function readBaseline() {
	try {
		return JSON.parse(readFileSync(baselinePath, "utf8"));
	} catch {
		return undefined;
	}
}
