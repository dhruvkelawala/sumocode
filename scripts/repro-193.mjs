#!/usr/bin/env node
/**
 * Reproducer for issue #193: fresh prompt from splash does not transition to active state.
 * Run with: node scripts/repro-193.mjs
 *
 * Spawns sumocode in a PTY with SUMO_TUI_DIAG_FILE set, sends a message,
 * waits for a response, then dumps the raw PTY output and diagnostics so we
 * can see exactly what Pi events fired and what state the TUI ended up in.
 */

import { spawn } from "node-pty";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ANSI_PATTERN = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)|_[^\x07]*(?:\x07|\x1b\\))/g;
function stripAnsi(s) { return s.replace(ANSI_PATTERN, ""); }

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

const diagFile = join(tmpdir(), `sumocode-repro-193-${Date.now()}.jsonl`);
const agentDir = mkdtempSync(join(tmpdir(), "sumocode-repro-193-agent-"));
writeFileSync(diagFile, "");

console.log(`Diag file: ${diagFile}`);
console.log(`Agent dir: ${agentDir}`);
console.log("Spawning sumocode...\n");

const cwd = resolve(".");
const child = spawn(
  process.env.PI_BIN ?? "pi",
  ["--offline", "--no-extensions", "-e", "./src/extension.ts", "--no-session"],
  {
    name: "xterm-256color",
    cols: 160,
    rows: 45,
    cwd,
    env: {
      ...process.env,
      PI_OFFLINE: "1",
      PI_CODING_AGENT_DIR: agentDir,
      TERM: "xterm-256color",
      SUMO_TUI: "1",
      SUMO_TUI_DIAG_FILE: diagFile,
      // Ensure we're using this checkout's extension
    },
  }
);

let output = "";
child.onData((data) => { output += data; });

function waitFor(pattern, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    const check = setInterval(() => {
      if ((typeof pattern === "string" ? output.includes(pattern) : pattern.test(output))) {
        clearInterval(check);
        clearTimeout(timer);
        resolve(output);
      }
    }, 100);
    const timer = setTimeout(() => {
      clearInterval(check);
      reject(new Error(`Timed out waiting for ${String(pattern)}\nLast output:\n${output.slice(-2000)}`));
    }, timeoutMs);
  });
}

async function run() {
  // Wait for splash (SGR mouse enable = runtime started)
  await waitFor("\x1b[?1000h\x1b[?1002h\x1b[?1006h", 20_000);
  console.log("✓ Splash visible (SGR mouse enabled)");

  // Wait a bit to ensure everything is rendered
  await delay(1500);

  // Check for DIVINE INVOCATION in output (splash editor label)
  const hasSplashLabel = stripAnsi(output).includes("DIVINE INVOCATION");
  console.log(`  Splash editor label visible: ${hasSplashLabel}`);

  // Send a first message
  console.log("\nSending first message: 'hello world'");
  child.write("hello world\r");

  // Wait for assistant response to start
  await delay(8_000);

  console.log("\n--- PTY output (last 3000 chars, stripped) ---");
  const stripped = stripAnsi(output);
  console.log(stripped.slice(-3000));

  // Only check the last ~2000 stripped chars (the final rendered frame)
  const finalFrame = stripped.slice(-2000);
  console.log("\n--- Final frame state checks ---");
  console.log(`DIVINE INVOCATION present: ${finalFrame.includes("DIVINE INVOCATION")}`);
  console.log(`AWAITING PROMPT present:   ${finalFrame.includes("AWAITING PROMPT")}`);
  console.log(`Meow meow present:         ${finalFrame.includes("Meow meow")}`);
  console.log(`Active footer visible:     ${finalFrame.includes("READY") || finalFrame.includes("sumocode")}`);
  console.log(`Active editor border:      ${finalFrame.includes("│ >")}`);

  // Dump diagnostics
  console.log("\n--- Diagnostics events ---");
  if (existsSync(diagFile)) {
    const lines = readFileSync(diagFile, "utf8").split("\n").filter(Boolean);
    const events = lines.flatMap(l => { try { return [JSON.parse(l)]; } catch { return []; } });
    // Show all Pi event records
    const piEvents = events.filter(e => e.event === "pi_event");
    console.log(`Pi events fired (${piEvents.length}):`);
    for (const e of piEvents) {
      console.log(`  ${e.name}`);
    }
    // Show render stats
    const cacheEvents = events.filter(e => ["render_stats"].includes(e.event));
    if (cacheEvents.length > 0) {
      const last = cacheEvents[cacheEvents.length - 1];
      console.log(`\nLast render_stats:`, JSON.stringify(last, null, 2));
    }
    // Show all events summary
    const counts = new Map();
    for (const e of events) counts.set(e.event, (counts.get(e.event) ?? 0) + 1);
    console.log(`\nAll event counts:`);
    for (const [name, count] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(count).padStart(5)}  ${name}`);
    }

    // Show all cache-related events in order
    const cacheRelated = events.filter(e => e.event.startsWith("session_cache") || e.event === "pi_event");
    console.log(`\nCache + Pi event sequence (${cacheRelated.length} events):`);
    for (const e of cacheRelated) {
      const extra = e.event === "pi_event" ? `  [${e.name}]` : `  ${JSON.stringify(Object.fromEntries(Object.entries(e).filter(([k]) => !['ts','event'].includes(k))))}`;
      console.log(`  ${e.event}${extra}`);
    }
  } else {
    console.log("(no diag file found)");
  }

  child.kill("SIGTERM");
  process.exit(0);
}

run().catch(err => {
  console.error("Error:", err.message);
  child.kill("SIGTERM");
  process.exit(1);
});
