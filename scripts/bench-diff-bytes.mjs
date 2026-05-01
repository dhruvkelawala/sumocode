#!/usr/bin/env node
/**
 * Reproducible benchmark for #172 — measures stdout bytes emitted per frame
 * under realistic SumoCode scenarios. Compares the OLD path (full-row
 * repaint, always emit `\x1b[?2026h … \x1b[?2026l` wrapper, always re-emit
 * cursor) against the NEW path (column-range diff + lazy frame-start +
 * cursor cache) on the same input frames.
 *
 * Run: `node scripts/bench-diff-bytes.mjs`
 *
 * No-op tick measurements use the actual `TerminalSessionOwner` lazy
 * frame-start. Per-frame measurements use the diff layer directly to keep
 * the comparison apples-to-apples between paths.
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createJiti } from "@mariozechner/jiti";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SCRIPT_DIR, "..", "src", "sumo-tui");

const jiti = createJiti(import.meta.url, { moduleCache: false, tryNative: false });
const { CellBuffer } = await jiti.import(resolve(ROOT, "render/buffer.ts"));
const { diffFrames } = await jiti.import(resolve(ROOT, "render/diff.ts"));
const { cellRowToAnsi } = await jiti.import(resolve(ROOT, "render/ansi-writer.ts"));
const { TerminalSessionOwner } = await jiti.import(resolve(ROOT, "runtime/terminal-controller.ts"));

class StubOut {
	constructor() { this.bytes = 0; this.calls = 0; }
	get isTTY() { return true; }
	write(data) { this.bytes += Buffer.byteLength(data, "utf8"); this.calls += 1; return true; }
}

function frame(rows, cols, lines) {
	const buf = new CellBuffer(rows, cols);
	for (let r = 0; r < lines.length; r += 1) buf.paintRow(r, lines[r]);
	return buf;
}

function bytesOldPath(prev, next, cursor) {
	// OLD path: full-row repaint of every changed row, always emit `?2026h`
	// wrapper, always re-emit cursor. Mirrors the writeFramePatches behaviour
	// before #172.
	const { rows, cols } = next.getDimensions();
	let output = "\x1b[?2026h";
	for (let row = 0; row < rows; row += 1) {
		let changed = false;
		for (let col = 0; col < cols; col += 1) {
			const a = prev.getCell(row, col);
			const b = next.getCell(row, col);
			if (a.char !== b.char || a.fg !== b.fg || a.bg !== b.bg) { changed = true; break; }
		}
		if (changed) output += `\x1b[${row + 1};1H${cellRowToAnsi(next, row)}\x1b[K`;
	}
	if (cursor) output += `\x1b[${cursor.row + 1};${cursor.col + 1}H\x1b[?25h`;
	output += "\x1b[?2026l";
	return Buffer.byteLength(output, "utf8");
}

function bytesNewPath(prev, next, cursor, prevCursor = null) {
	// NEW path: real `TerminalSessionOwner.writeFramePatches` with the same
	// `lastEmittedCursor` cache it uses in production.
	const stub = new StubOut();
	const term = new TerminalSessionOwner({ output: stub });
	if (prevCursor) {
		// Seed the cache (one prior frame). The seed write is excluded from
		// the measurement.
		term.writeFramePatches([], prevCursor);
		stub.bytes = 0;
		stub.calls = 0;
	}
	const patches = diffFrames(prev, next);
	term.writeFramePatches(patches, cursor);
	return stub.bytes;
}

function row(label, oldB, newB) {
	const delta = oldB === 0 ? "—" : `${(((oldB - newB) / oldB) * 100).toFixed(1)}%`;
	const arrow = newB < oldB ? "↓" : newB > oldB ? "↑" : "=";
	console.log(`  ${label.padEnd(48)} ${String(oldB).padStart(7)}B  →  ${String(newB).padStart(7)}B  ${arrow} ${delta}`);
}

console.log("\n=== Single-cell change in a 200-col row (cursor blink class) ===");
{
	const cols = 200;
	const filled = " ".repeat(50) + "│" + " ".repeat(149);
	const blinked = " ".repeat(50) + "█" + " ".repeat(149);
	const prev = frame(1, cols, [filled]);
	const next = frame(1, cols, [blinked]);
	const cursor = { row: 0, col: 51 };
	row("blink one cell", bytesOldPath(prev, next, cursor), bytesNewPath(prev, next, cursor, cursor));
}

console.log("\n=== Streaming append: 1 char at end of 200-col row ===");
{
	const cols = 200;
	const a = "Hello world. " + " ".repeat(187);
	const b = "Hello world.! " + " ".repeat(186);
	const prev = frame(1, cols, [a]);
	const next = frame(1, cols, [b]);
	const cursor = { row: 0, col: 13 };
	row("append at col 13", bytesOldPath(prev, next, cursor), bytesNewPath(prev, next, cursor, cursor));
}

console.log("\n=== Streaming append: 10 chars at end of 200-col row ===");
{
	const cols = 200;
	const a = "abcdef" + " ".repeat(194);
	const b = "abcdefghijklmnop" + " ".repeat(184);
	const prev = frame(1, cols, [a]);
	const next = frame(1, cols, [b]);
	const cursor = { row: 0, col: 16 };
	row("10 chars appended", bytesOldPath(prev, next, cursor), bytesNewPath(prev, next, cursor, cursor));
}

console.log("\n=== Idle frame (no diff, cursor unchanged) ===");
{
	const buf = frame(40, 200, Array(40).fill(" ".repeat(200)));
	const cursor = { row: 5, col: 10 };
	row("idle tick", bytesOldPath(buf, buf, cursor), bytesNewPath(buf, buf, cursor, cursor));
}

console.log("\n=== Idle frame x10 (cursor unchanged each tick) ===");
{
	const buf = frame(40, 200, Array(40).fill(" ".repeat(200)));
	const cursor = { row: 5, col: 10 };
	let oldTotal = 0;
	for (let i = 0; i < 10; i += 1) oldTotal += bytesOldPath(buf, buf, cursor);
	const stub = new StubOut();
	const term = new TerminalSessionOwner({ output: stub });
	for (let i = 0; i < 10; i += 1) {
		term.writeFramePatches(diffFrames(buf, buf), cursor);
	}
	row("10 idle ticks", oldTotal, stub.bytes);
}

console.log("\n=== Cursor blink only (cursor toggles col, no patches) ===");
{
	const buf = frame(40, 200, Array(40).fill(" ".repeat(200)));
	const oldB = bytesOldPath(buf, buf, { row: 5, col: 11 });
	const newB = bytesNewPath(buf, buf, { row: 5, col: 11 }, { row: 5, col: 10 });
	row("cursor moves 1 col", oldB, newB);
}

console.log("\n=== Single full-row change in a 40-row × 200-col frame ===");
{
	const cols = 200;
	const rows = 40;
	const before = Array(rows).fill(" ".repeat(cols));
	const after = before.slice();
	after[20] = "Replaced row content. " + " ".repeat(cols - 22);
	const prev = frame(rows, cols, before);
	const next = frame(rows, cols, after);
	const cursor = { row: 5, col: 10 };
	row("one row replaced", bytesOldPath(prev, next, cursor), bytesNewPath(prev, next, cursor, cursor));
}

console.log("\n=== Streaming chunk: 5 mid-row chars + cursor moves ===");
{
	const cols = 200;
	const rows = 40;
	const before = Array(rows).fill(" ".repeat(cols));
	before[10] = "Stream output: hello" + " ".repeat(cols - 20);
	const after = before.slice();
	after[10] = "Stream output: hello world!" + " ".repeat(cols - 27);
	const prev = frame(rows, cols, before);
	const next = frame(rows, cols, after);
	row("streaming chunk", bytesOldPath(prev, next, { row: 10, col: 27 }), bytesNewPath(prev, next, { row: 10, col: 27 }, { row: 10, col: 20 }));
}

console.log("");
