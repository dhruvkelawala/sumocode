#!/usr/bin/env node
import fs from "node:fs";

const file = process.argv[2] ?? process.env.SUMO_TUI_DIAG_FILE ?? "/tmp/sumocode-manual.jsonl";
if (!fs.existsSync(file)) {
  console.error(`[diag-summary] No diagnostics file found: ${file}`);
  process.exit(1);
}

const events = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).flatMap((line) => {
  try { return [JSON.parse(line)]; } catch { return []; }
});

const counts = new Map();
const slow = [];
const errors = [];
for (const event of events) {
  counts.set(event.event, (counts.get(event.event) ?? 0) + 1);
  if (event.event === "slow_frame") slow.push(event);
  if (event.event === "render_error" || event.event === "invariant_violation") errors.push(event);
}

console.log(`Diagnostics: ${file}`);
console.log(`Events: ${events.length}`);
console.log("\nEvent counts:");
for (const [name, count] of [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
  console.log(`  ${String(count).padStart(5)}  ${name}`);
}

if (slow.length > 0) {
  console.log("\nSlow frames:");
  for (const event of slow.slice(-20)) {
    console.log(`  ${event.durationMs}ms  ${event.path ?? "unknown"}  ${event.width ?? "?"}x${event.height ?? "?"}`);
  }
}

if (errors.length > 0) {
  console.log("\nErrors/invariants:");
  for (const event of errors.slice(-20)) console.log(`  ${JSON.stringify(event)}`);
}

const lastSelection = [...events].reverse().find((event) => event.event === "selection_finish" || event.event === "selection_copy_success");
if (lastSelection) {
  console.log("\nLast selection:");
  console.log(`  ${JSON.stringify(lastSelection)}`);
}

const highlights = events.filter((event) => event.event === "selection_highlight");
if (highlights.length > 0) {
  console.log(`\nSelection highlights: ${highlights.length}`);
  for (const event of highlights.slice(-5)) {
    console.log(`  semantic=${event.semantic} rows=${event.rowsTouched}/${event.totalRows} cells=${event.cellsInverted}`);
    for (const sample of event.sampleRows ?? []) {
      const ranges = (sample.ranges ?? []).map(([a, b]) => `${a}-${b}`).join(", ");
      console.log(`    row ${sample.row}: ${ranges || "(empty)"}`);
    }
  }
}
