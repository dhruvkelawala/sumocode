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
const renderSamples = [];
const renderStats = [];
for (const event of events) {
  counts.set(event.event, (counts.get(event.event) ?? 0) + 1);
  if (event.event === "slow_frame") slow.push(event);
  if (event.event === "render_error" || event.event === "invariant_violation") errors.push(event);
  if (event.event === "render_sample") renderSamples.push(event);
  if (event.event === "render_stats") renderStats.push(event);
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

if (renderStats.length > 0) {
  // Aggregate per-target render durations + IO + counters across all flushed windows.
  const totals = new Map();
  const ioTotals = new Map();
  let getBranchCalls = 0;
  let usageHits = 0;
  let usageMisses = 0;
  let branchHits = 0;
  let branchMisses = 0;
  let piEvents = 0;
  let keystrokes = 0;
  let keystrokeBytes = 0;
  const keystrokeLat = { count: 0, totalMs: 0, maxMs: 0 };
  let totalWindowsMs = 0;
  for (const stat of renderStats) {
    totalWindowsMs += stat.windowMs ?? 0;
    getBranchCalls += stat.getBranchCalls ?? 0;
    usageHits += stat.sessionCacheHits ?? 0;
    usageMisses += stat.sessionCacheMisses ?? 0;
    branchHits += stat.branchCacheHits ?? 0;
    branchMisses += stat.branchCacheMisses ?? 0;
    piEvents += stat.piEvents ?? 0;
    keystrokes += stat.keystrokes ?? 0;
    keystrokeBytes += stat.keystrokeBytes ?? 0;
    if (stat.keystrokeLatency) {
      keystrokeLat.count += stat.keystrokeLatency.count ?? 0;
      keystrokeLat.totalMs += stat.keystrokeLatency.totalMs ?? 0;
      keystrokeLat.maxMs = Math.max(keystrokeLat.maxMs, stat.keystrokeLatency.maxMs ?? 0);
    }
    for (const [target, bucket] of Object.entries(stat.targets ?? {})) {
      const acc = totals.get(target) ?? { count: 0, totalMs: 0, maxMs: 0 };
      acc.count += bucket.count ?? 0;
      acc.totalMs += bucket.totalMs ?? 0;
      acc.maxMs = Math.max(acc.maxMs, bucket.maxMs ?? 0);
      totals.set(target, acc);
    }
    for (const [stream, bucket] of Object.entries(stat.io ?? {})) {
      const acc = ioTotals.get(stream) ?? { writes: 0, bytes: 0, writeMs: 0, maxWriteMs: 0, maxBytes: 0 };
      acc.writes += bucket.writes ?? 0;
      acc.bytes += bucket.bytes ?? 0;
      acc.writeMs += bucket.writeMs ?? 0;
      acc.maxWriteMs = Math.max(acc.maxWriteMs, bucket.maxWriteMs ?? 0);
      acc.maxBytes = Math.max(acc.maxBytes, bucket.maxBytes ?? 0);
      ioTotals.set(stream, acc);
    }
  }
  const totalSeconds = totalWindowsMs / 1000;
  console.log(`\nRender hot paths (across ${renderStats.length} windows / ~${totalSeconds.toFixed(1)}s):`);
  console.log(`  ${"target".padEnd(28)} ${"count".padStart(7)} ${"avg/ms".padStart(8)} ${"max/ms".padStart(8)} ${"total/ms".padStart(10)} ${"renders/s".padStart(10)}`);
  const sorted = [...totals.entries()].sort((a, b) => b[1].totalMs - a[1].totalMs);
  for (const [target, bucket] of sorted) {
    const avg = bucket.count > 0 ? bucket.totalMs / bucket.count : 0;
    const rps = totalSeconds > 0 ? bucket.count / totalSeconds : 0;
    console.log(
      `  ${target.padEnd(28)} ${String(bucket.count).padStart(7)} ${avg.toFixed(2).padStart(8)} ${bucket.maxMs.toFixed(2).padStart(8)} ${bucket.totalMs.toFixed(1).padStart(10)} ${rps.toFixed(1).padStart(10)}`,
    );
  }
  const grandTotalRenderMs = sorted.reduce((acc, [, bucket]) => acc + bucket.totalMs, 0);
  const renderShare = totalWindowsMs > 0 ? (grandTotalRenderMs / totalWindowsMs) * 100 : 0;
  console.log(`  ${"".padEnd(28)} ${"".padStart(7)} ${"".padStart(8)} ${"".padStart(8)} ${grandTotalRenderMs.toFixed(1).padStart(10)} (${renderShare.toFixed(1)}% of wall)`);

  if (ioTotals.size > 0) {
    console.log(`\nstdout/stderr writes (per stream, totals across the trace):`);
    console.log(`  ${"stream".padEnd(8)} ${"writes".padStart(8)} ${"bytes".padStart(10)} ${"avgB".padStart(7)} ${"maxB".padStart(8)} ${"writeMs".padStart(10)} ${"avg/ms".padStart(8)} ${"max/ms".padStart(8)} ${"writes/s".padStart(10)} ${"bytes/s".padStart(10)}`);
    for (const [stream, bucket] of ioTotals) {
      const avgMs = bucket.writes > 0 ? bucket.writeMs / bucket.writes : 0;
      const avgB = bucket.writes > 0 ? bucket.bytes / bucket.writes : 0;
      const wps = totalSeconds > 0 ? bucket.writes / totalSeconds : 0;
      const bps = totalSeconds > 0 ? bucket.bytes / totalSeconds : 0;
      console.log(
        `  ${stream.padEnd(8)} ${String(bucket.writes).padStart(8)} ${String(bucket.bytes).padStart(10)} ${avgB.toFixed(0).padStart(7)} ${String(bucket.maxBytes).padStart(8)} ${bucket.writeMs.toFixed(1).padStart(10)} ${avgMs.toFixed(2).padStart(8)} ${bucket.maxWriteMs.toFixed(2).padStart(8)} ${wps.toFixed(1).padStart(10)} ${bps.toFixed(0).padStart(10)}`,
      );
    }
    const stdoutBucket = ioTotals.get("stdout");
    if (stdoutBucket) {
      const stdoutShare = totalWindowsMs > 0 ? (stdoutBucket.writeMs / totalWindowsMs) * 100 : 0;
      console.log(`  stdout share of wall-clock: ${stdoutShare.toFixed(1)}%`);
    }
  }

  if (keystrokes > 0) {
    const kps = totalSeconds > 0 ? keystrokes / totalSeconds : 0;
    console.log(`\nKeystrokes: ${keystrokes} (${keystrokeBytes} bytes) → ${kps.toFixed(1)}/s`);
    if (keystrokeLat.count > 0) {
      const avgLat = keystrokeLat.totalMs / keystrokeLat.count;
      console.log(`  keystroke→paint latency: avg=${avgLat.toFixed(1)}ms  max=${keystrokeLat.maxMs.toFixed(1)}ms  (${keystrokeLat.count} samples)`);
    }
  }

  const usageTotal = usageHits + usageMisses;
  const usageHitRate = usageTotal > 0 ? ((usageHits / usageTotal) * 100).toFixed(1) : "n/a";
  const branchTotal = branchHits + branchMisses;
  const branchHitRate = branchTotal > 0 ? ((branchHits / branchTotal) * 100).toFixed(1) : "n/a";
  console.log(`\nSession usage cache: ${usageHits} hits / ${usageMisses} misses (${usageHitRate}% hit)`);
  console.log(`Git branch cache:    ${branchHits} hits / ${branchMisses} misses (${branchHitRate}% hit)`);
  console.log(`getBranch() raw calls: ${getBranchCalls}  |  pi events: ${piEvents}`);
}

if (renderSamples.length > 0) {
  // Top 20 slowest individual renders.
  const sorted = [...renderSamples].sort((a, b) => (b.durationMs ?? 0) - (a.durationMs ?? 0));
  console.log(`\nSlowest individual renders (top ${Math.min(20, sorted.length)} of ${renderSamples.length}):`);
  for (const event of sorted.slice(0, 20)) {
    console.log(`  ${String(event.durationMs).padStart(6)}ms  ${event.target.padEnd(28)} w=${event.width} lines=${event.lines}`);
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
