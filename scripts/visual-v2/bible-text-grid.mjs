/**
 * Parse a Bible HTML scene into a plain-text cell grid.
 *
 * Bible scenes use `<pre class="grid">` rows inside a `<div data-render-rect class="term scene">`.
 * This parser strips HTML tags, decodes entities, and produces the same
 * `{ rows, cols, lines[] }` shape as a terminal snapshot's plainText —
 * so the geometry audit can diff them cell-for-cell without any PNG.
 */

import { readFileSync } from "node:fs";

const HTML_TAG = /<[^>]*>/g;
const HTML_ENTITY = /&(amp|lt|gt|quot|#39|#x27|nbsp);/g;
const ENTITY_MAP = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", "#x27": "'", nbsp: " " };

function decodeEntities(text) {
	return text.replace(HTML_ENTITY, (_, entity) => ENTITY_MAP[entity] ?? _);
}

function stripTags(html) {
	return decodeEntities(html.replace(HTML_TAG, ""));
}

/**
 * Extract the grid rows from a Bible HTML file.
 * Returns { cols, rows, lines: string[] } where each line is padded to cols.
 */
export function parseBibleHtml(htmlPath) {
	const html = readFileSync(htmlPath, "utf8");

	// Extract term-cols and term-rows from style
	const colsMatch = html.match(/--term-cols:\s*(\d+)/);
	const rowsMatch = html.match(/--term-rows:\s*(\d+)/);
	const cols = colsMatch ? parseInt(colsMatch[1], 10) : 160;
	const rows = rowsMatch ? parseInt(rowsMatch[1], 10) : 45;

	// Extract the scene container
	const sceneMatch = html.match(/<div[^>]*data-render-rect[^>]*class="term[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/);
	if (!sceneMatch) throw new Error(`Could not find <div data-render-rect class="term scene"> in ${htmlPath}`);
	const sceneHtml = sceneMatch[1];

	// Extract all <pre class="grid"> blocks and the middle chat column
	const gridPattern = /<pre class="grid"[^>]*>([\s\S]*?)<\/pre>/g;
	const middleMatch = sceneHtml.match(/<div class="middle">([\s\S]*?)<\/div>\s*<div class="gutter-col"><\/div>/);
	
	const rawLines = [];
	
	// Process the scene in order: grid rows before middle, middle content, grid rows after
	// The CSS grid-row assignments tell us the order
	const gridBlocks = [...sceneHtml.matchAll(/<pre class="grid"[^>]*?(?:style="grid-row:\s*(\d+);?")?[^>]*>([\s\S]*?)<\/pre>/g)];
	
	// Separate top-level grids (with grid-row) from chat column grids
	const topLevelGrids = [];
	const chatGrids = [];
	
	if (middleMatch) {
		const middleStart = sceneHtml.indexOf(middleMatch[0]);
		const middleEnd = middleStart + middleMatch[0].length;
		
		for (const block of gridBlocks) {
			const blockPos = sceneHtml.indexOf(block[0]);
			if (blockPos >= middleStart && blockPos < middleEnd) {
				chatGrids.push(block);
			} else {
				topLevelGrids.push(block);
			}
		}
	} else {
		topLevelGrids.push(...gridBlocks);
	}

	// Sort top-level by grid-row
	topLevelGrids.sort((a, b) => {
		const rowA = a[1] ? parseInt(a[1], 10) : 0;
		const rowB = b[1] ? parseInt(b[1], 10) : 0;
		return rowA - rowB;
	});

	// Build ordered line list
	// Grid rows 1-3 come before middle, then chat, then remaining grid rows
	const beforeMiddle = topLevelGrids.filter(g => g[1] && parseInt(g[1], 10) <= 3);
	const afterMiddle = topLevelGrids.filter(g => g[1] && parseInt(g[1], 10) > 3);

	for (const grid of beforeMiddle) {
		const text = stripTags(grid[2] ?? grid[0]);
		for (const line of text.split("\n")) {
			rawLines.push(line);
		}
	}

	for (const grid of chatGrids) {
		const text = stripTags(grid[2] ?? grid[0]);
		for (const line of text.split("\n")) {
			rawLines.push(line);
		}
	}

	for (const grid of afterMiddle) {
		const text = stripTags(grid[2] ?? grid[0]);
		for (const line of text.split("\n")) {
			rawLines.push(line);
		}
	}

	// Pad/truncate each line to cols
	const lines = [];
	for (let i = 0; i < rows; i++) {
		const raw = rawLines[i] ?? "";
		if (raw.length >= cols) {
			lines.push(raw.slice(0, cols));
		} else {
			lines.push(raw + " ".repeat(cols - raw.length));
		}
	}

	return { cols, rows, lines };
}

/**
 * Build a side-by-side text diff of two cell grids.
 * Returns { passed, diffs[], text } where diffs lists rows with mismatches.
 */
export function diffCellGrids(target, runtime, options = {}) {
	const cols = target.cols;
	const rows = Math.max(target.lines.length, runtime.lines.length);
	const diffs = [];

	for (let r = 0; r < rows; r++) {
		const tLine = target.lines[r] ?? " ".repeat(cols);
		const rLine = runtime.lines[r] ?? " ".repeat(cols);
		
		if (tLine !== rLine) {
			// Find first and last differing column
			let firstDiff = -1;
			let lastDiff = -1;
			const maxLen = Math.max(tLine.length, rLine.length);
			for (let c = 0; c < maxLen; c++) {
				if ((tLine[c] ?? " ") !== (rLine[c] ?? " ")) {
					if (firstDiff === -1) firstDiff = c;
					lastDiff = c;
				}
			}
			diffs.push({
				row: r,
				firstDiff,
				lastDiff,
				target: tLine.slice(0, 80),
				runtime: rLine.slice(0, 80),
			});
		}
	}

	const passed = diffs.length === 0;
	const lines = [];
	lines.push(passed
		? `Cell grid comparison: MATCH (${rows} rows, ${cols} cols)`
		: `Cell grid comparison: ${diffs.length} row(s) differ out of ${rows}`);
	lines.push("");

	if (diffs.length > 0) {
		for (const d of diffs) {
			lines.push(`row ${String(d.row).padStart(3)}  cols ${d.firstDiff}-${d.lastDiff}`);
			lines.push(`  target:  ${JSON.stringify(d.target)}`);
			lines.push(`  runtime: ${JSON.stringify(d.runtime)}`);
			lines.push("");
		}
	}

	return { passed, diffs, text: lines.join("\n") };
}
