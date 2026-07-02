/**
 * Styled cell grid — per-cell char + fg + bg + weight for deterministic
 * color/typography verification without PNG.
 *
 * Bible source: HTML spans with CSS classes → resolved hex via token map.
 * Runtime source: xterm cell snapshot → already has per-cell hex.
 *
 * Produces a unified StyledCell[][] that can be diffed cell-for-cell.
 */

import { readFileSync } from "node:fs";

// ── Token resolution ──────────────────────────────────────────────

/** Bible CSS class → resolved runtime-equivalent hex. */
const FG_CLASS_MAP = {
	"fg-accent":   "#D97706",
	"fg-fg":       "#F5E6C8",
	"fg-dim":      "#8B7A63",
	"fg-divider":  "#5A4D3C",
	"fg-comment":  "#6F5D46",
	"fg-idle":     "#22C55E",  // Bible uses --state-idle (#7FB069); runtime token is #22C55E.
	                            // TODO: reconcile once runtime palette is final.
	"fg-think":    "#E8B339",
	"fg-tool":     "#5B9BD5",
	"fg-approve":  "#C1443E",
	"fg-learn":    "#8E7AB5",
	"fg-string":   "#7FB069",
	"fg-number":   "#E8B339",
	"fg-keyword":  "#D97706",
	"fg-fn":       "#E8B339",
};

const BG_CLASS_MAP = {
	"bg-recess":   "#120D0A",
	"bg-surface":  "#1E1914",  // --surface is #241D17 in tokens.css but sidebar uses #1E1914
	"bg-lifted":   "#3D3024",
};

const DEFAULT_FG = "#F5E6C8";
const DEFAULT_BG = "#1A1511";

/**
 * Known intentional color differences between Bible mockup and runtime.
 * These pairs are treated as equivalent during diff.
 */
const EQUIVALENT_PAIRS = [
	// idle state: Bible tokens.css has #7FB069, runtime CATHEDRAL_TOKENS uses #22C55E
	{ bible: "#7FB069", runtime: "#22C55E", reason: "state-idle palette difference" },
];

function colorsEquivalent(a, b) {
	if (!a || !b) return a === b;
	const la = a.toLowerCase();
	const lb = b.toLowerCase();
	if (la === lb) return true;
	for (const pair of EQUIVALENT_PAIRS) {
		if ((la === pair.bible.toLowerCase() && lb === pair.runtime.toLowerCase()) ||
		    (la === pair.runtime.toLowerCase() && lb === pair.bible.toLowerCase())) {
			return true;
		}
	}
	return false;
}

// ── Bible HTML → StyledCell[][] ───────────────────────────────────

const TAG_OPEN = /<span\s+class="([^"]*)"(?:\s+style="([^"]*)")?>/g;
const TAG_CLOSE = /<\/span>/g;
const ALL_TAGS = /<\/?[^>]+>/g;
const HTML_ENTITY = /&(amp|lt|gt|quot|#39|#x27|nbsp);/g;
const ENTITY_MAP = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", "#x27": "'", nbsp: " " };

function decodeEntity(_, e) { return ENTITY_MAP[e] ?? _; }

function bgFromStyle(style) {
	if (style.includes("background: var(--surface-recess)")) return "#120D0A";
	if (style.includes("background: var(--surface)")) return "#241D17";
	if (style.includes("background: var(--surface-lifted)")) return "#3D3024";
	if (style.includes("background: var(--accent)")) return "#D97706";
	return null;
}

function parentBgFromAttrs(attrs) {
	if (/\bbg-recess\b/.test(attrs)) return "#120D0A";
	if (/\bbg-surface\b/.test(attrs)) return "#241D17";
	if (/\bbg-lifted\b/.test(attrs)) return "#3D3024";
	return bgFromStyle(attrs) ?? DEFAULT_BG;
}

/**
 * Parse a single Bible HTML line (contents of a <pre class="grid">)
 * into an array of StyledCells.
 */
function parseBibleLine(html, parentBg = DEFAULT_BG) {
	const cells = [];
	let fg = DEFAULT_FG;
	let bg = parentBg;
	let bold = false;
	let dim = false;
	const fgStack = [fg];
	const bgStack = [bg];
	const boldStack = [false];

	// Walk character by character, tracking open/close spans
	let pos = 0;
	while (pos < html.length) {
		// Check for opening tag
		TAG_OPEN.lastIndex = pos;
		const openMatch = TAG_OPEN.exec(html);
		if (openMatch && openMatch.index === pos) {
			const classes = openMatch[1].split(/\s+/);
			const style = openMatch[2] ?? "";
			let newFg = fg;
			let newBg = bg;
			let newBold = bold;
			for (const cls of classes) {
				if (FG_CLASS_MAP[cls]) newFg = FG_CLASS_MAP[cls];
				if (BG_CLASS_MAP[cls]) newBg = BG_CLASS_MAP[cls];
				if (cls === "box-fill") newBg = bgFromStyle(style) ?? "#120D0A";
				if (cls === "cursor") { newBg = "#D97706"; newFg = DEFAULT_BG; }
			}
			if (style.includes("background: var(--accent)")) newBg = "#D97706";
			if (style.includes("color: var(--background)")) newFg = DEFAULT_BG;
			fgStack.push(newFg);
			bgStack.push(newBg);
			boldStack.push(newBold);
			fg = newFg;
			bg = newBg;
			bold = newBold;
			pos = openMatch.index + openMatch[0].length;
			continue;
		}

		// Check for closing tag
		TAG_CLOSE.lastIndex = pos;
		const closeMatch = TAG_CLOSE.exec(html);
		if (closeMatch && closeMatch.index === pos) {
			fgStack.pop();
			bgStack.pop();
			boldStack.pop();
			fg = fgStack[fgStack.length - 1] ?? DEFAULT_FG;
			bg = bgStack[bgStack.length - 1] ?? parentBg;
			bold = boldStack[boldStack.length - 1] ?? false;
			pos = closeMatch.index + closeMatch[0].length;
			continue;
		}

		// Check for any other tag (skip it)
		ALL_TAGS.lastIndex = pos;
		const anyTag = ALL_TAGS.exec(html);
		if (anyTag && anyTag.index === pos) {
			pos = anyTag.index + anyTag[0].length;
			continue;
		}

		// Check for entity
		HTML_ENTITY.lastIndex = pos;
		const entMatch = HTML_ENTITY.exec(html);
		if (entMatch && entMatch.index === pos) {
			const decoded = ENTITY_MAP[entMatch[1]] ?? entMatch[0];
			cells.push({ char: decoded, fg, bg, bold, dim });
			pos = entMatch.index + entMatch[0].length;
			continue;
		}

		// Regular character
		cells.push({ char: html[pos], fg, bg, bold, dim });
		pos++;
	}

	return cells;
}

function parseGridContent(content, parentBg = DEFAULT_BG) {
	return content.split("\n").map((line) => parseBibleLine(line, parentBg));
}

function emptyStyledGrid(cols, rows) {
	const grid = [];
	for (let row = 0; row < rows; row++) {
		grid.push(Array.from({ length: cols }, () => ({ char: " ", fg: DEFAULT_FG, bg: DEFAULT_BG, bold: false, dim: false })));
	}
	return grid;
}

function writeCells(target, startRow, startCol, sourceRows) {
	for (let row = 0; row < sourceRows.length; row++) {
		const targetRow = target[startRow + row];
		if (!targetRow) continue;
		const source = sourceRows[row] ?? [];
		for (let col = 0; col < source.length; col++) {
			if (startCol + col >= 0 && startCol + col < targetRow.length) targetRow[startCol + col] = source[col];
		}
	}
}

const PRE_GRID_PATTERN = /<pre class="grid"([^>]*)>([\s\S]*?)<\/pre>/g;

function extractPreGridRows(html, parentBg = DEFAULT_BG) {
	return [...html.matchAll(PRE_GRID_PATTERN)].flatMap((match) => parseGridContent(match[2], parentBgFromAttrs(match[1]) ?? parentBg));
}

function parseScenePaletteOverlayGrid(html, cols, rows) {
	const grid = emptyStyledGrid(cols, rows);
	const gridRowStarts = new Map([
		[1, 0],
		[2, 1],
		[3, 2],
		[5, 37],
		[6, 38],
		[7, 41],
		[8, 42],
		[9, 43],
		[10, 44],
	]);

	for (const match of html.matchAll(PRE_GRID_PATTERN)) {
		const attrs = match[1] ?? "";
		const gridRow = attrs.match(/grid-row:\s*(\d+)/)?.[1];
		if (!gridRow) continue;
		const startRow = gridRowStarts.get(Number(gridRow));
		if (startRow === undefined) continue;
		writeCells(grid, startRow, 0, parseGridContent(match[2], parentBgFromAttrs(attrs)));
	}

	const chatMatch = html.match(/<div class="chat-col">([\s\S]*?)<\/div>\s*<div class="gutter-col">/);
	if (chatMatch) {
		let row = 3;
		for (const match of chatMatch[1].matchAll(PRE_GRID_PATTERN)) {
			const parsed = parseGridContent(match[2], parentBgFromAttrs(match[1] ?? ""));
			writeCells(grid, row, 0, parsed);
			row += parsed.length;
		}
	}

	const sidebarMatch = html.match(/<div class="sidebar-col">([\s\S]*?)<\/div>\s*<\/div>/);
	if (sidebarMatch) {
		const sidebarRows = extractPreGridRows(sidebarMatch[1], DEFAULT_BG);
		writeCells(grid, 3, 130, sidebarRows);
	}

	const modalMatch = html.match(/<div class="modal-overlay"[\s\S]*?<pre class="grid"([^>]*)>([\s\S]*?)<\/pre><\/div>/);
	if (modalMatch) {
		const modalRows = parseGridContent(modalMatch[2], parentBgFromAttrs(modalMatch[1] ?? "") || "#3D3024");
		const modalWidth = Math.max(0, ...modalRows.map((row) => row.length));
		const top = Math.max(0, Math.floor((rows - modalRows.length) / 2));
		const left = Math.max(0, Math.floor((cols - modalWidth) / 2));
		writeCells(grid, top, left, modalRows);
	}

	return { cols, rows, grid };
}

/**
 * Parse a full Bible HTML file into a StyledCell[][] grid.
 */
export function parseBibleStyledGrid(htmlPath) {
	const html = readFileSync(htmlPath, "utf8");

	const colsMatch = html.match(/--term-cols:\s*(\d+)/);
	const rowsMatch = html.match(/--term-rows:\s*(\d+)/);
	const cols = colsMatch ? parseInt(colsMatch[1], 10) : 160;
	const rows = rowsMatch ? parseInt(rowsMatch[1], 10) : 45;

	if (htmlPath.endsWith("scene-palette-overlay.html")) {
		return parseScenePaletteOverlayGrid(html, cols, rows);
	}

	// Extract grid blocks in document order
	const gridPattern = /<pre class="[^"]*\bgrid\b[^"]*"[^>]*>([\s\S]*?)<\/pre>/g;
	// Find the opening tag, then capture everything from there to the end of the
	// enclosing .stage div. The scene container depth varies across bible pages.
	const openIdx = html.indexOf('data-render-rect');
	if (openIdx === -1) throw new Error(`No data-render-rect in ${htmlPath}`);
	const contentStart = html.indexOf('>', openIdx) + 1;
	const bodyEnd = html.indexOf('</body>');
	const sceneContent = html.slice(contentStart, bodyEnd === -1 ? undefined : bodyEnd);
	const sceneMatch = [null, sceneContent];

	const allGrids = [...sceneMatch[1].matchAll(gridPattern)];
	const rawRows = [];
	for (const grid of allGrids) {
		const content = grid[1];
		// Detect parent bg from inline style (box-fill backgrounds)
		const parentBg = parentBgFromAttrs(grid[0]);
		// Split on literal newlines inside <pre> — each is a terminal row
		const lines = content.split("\n");
		for (const line of lines) {
			rawRows.push(parseBibleLine(line, parentBg));
		}
	}

	// Pad/truncate to exact grid dimensions
	const grid = [];
	for (let r = 0; r < rows; r++) {
		const srcRow = rawRows[r] ?? [];
		const row = [];
		for (let c = 0; c < cols; c++) {
			row.push(srcRow[c] ?? { char: " ", fg: DEFAULT_FG, bg: DEFAULT_BG, bold: false, dim: false });
		}
		grid.push(row);
	}
	return { cols, rows, grid };
}

// ── Runtime snapshot → StyledCell[][] ─────────────────────────────

/**
 * Convert an xterm cell snapshot into the same StyledCell[][] shape.
 */
export function runtimeStyledGrid(snapshot) {
	const grid = [];
	for (const row of snapshot.cells) {
		const outRow = [];
		for (const cell of row) {
			outRow.push({
				char: cell.char || " ",
				fg: (cell.fg || DEFAULT_FG).toLowerCase(),
				bg: (cell.bg || DEFAULT_BG).toLowerCase(),
				bold: Boolean(cell.bold),
				dim: Boolean(cell.dim),
			});
		}
		grid.push(outRow);
	}
	return { cols: snapshot.cols, rows: snapshot.rows, grid };
}

export function cropStyledGrid(source, crop) {
	if (!crop || crop.kind === "full") return source;
	const grid = [];
	for (let row = 0; row < crop.rows; row++) {
		const srcRow = source.grid[crop.y + row] ?? [];
		const outRow = [];
		for (let col = 0; col < crop.cols; col++) {
			outRow.push(srcRow[crop.x + col] ?? { char: " ", fg: DEFAULT_FG, bg: DEFAULT_BG, bold: false, dim: false });
		}
		grid.push(outRow);
	}
	return { cols: crop.cols, rows: crop.rows, grid };
}

// ── Diff ──────────────────────────────────────────────────────────

/**
 * Diff two styled cell grids. Returns per-row diffs with cell-level detail.
 */
export function diffStyledGrids(target, runtime, options = {}) {
	const ignoreColors = options.ignoreColors ?? false;
	const rows = Math.max(target.grid.length, runtime.grid.length);
	const cols = Math.max(target.cols, runtime.cols);
	const rowDiffs = [];

	for (let r = 0; r < rows; r++) {
		const tRow = target.grid[r] ?? [];
		const rRow = runtime.grid[r] ?? [];
		const cellDiffs = [];

		for (let c = 0; c < cols; c++) {
			const t = tRow[c] ?? { char: " ", fg: DEFAULT_FG, bg: DEFAULT_BG };
			const rc = rRow[c] ?? { char: " ", fg: DEFAULT_FG, bg: DEFAULT_BG };

			const charMatch = t.char === rc.char;
			const fgMatch = ignoreColors || colorsEquivalent(t.fg, rc.fg);
			const bgMatch = ignoreColors || colorsEquivalent(t.bg, rc.bg);

			if (!charMatch || !fgMatch || !bgMatch) {
				cellDiffs.push({
					col: c,
					char: charMatch ? null : { target: t.char, runtime: rc.char },
					fg: fgMatch ? null : { target: t.fg, runtime: rc.fg },
					bg: bgMatch ? null : { target: t.bg, runtime: rc.bg },
				});
			}
		}

		if (cellDiffs.length > 0) {
			rowDiffs.push({
				row: r,
				diffCount: cellDiffs.length,
				cells: cellDiffs.slice(0, 10), // cap detail per row
				targetText: tRow.map(c => c.char).join("").slice(0, 80),
				runtimeText: rRow.map(c => c.char).join("").slice(0, 80),
			});
		}
	}

	const passed = rowDiffs.length === 0;
	return { passed, rowDiffs, totalRows: rows, totalCols: cols };
}

/**
 * Format styled grid diff as readable text.
 */
export function styledDiffToText(diff) {
	const lines = [];
	lines.push(diff.passed
		? `Styled cell diff: MATCH (${diff.totalRows}×${diff.totalCols})`
		: `Styled cell diff: ${diff.rowDiffs.length} row(s) differ out of ${diff.totalRows}`);
	lines.push("");

	for (const rd of diff.rowDiffs.slice(0, 30)) {
		lines.push(`row ${String(rd.row).padStart(3)}  (${rd.diffCount} cell diffs)`);
		lines.push(`  target:  ${JSON.stringify(rd.targetText)}`);
		lines.push(`  runtime: ${JSON.stringify(rd.runtimeText)}`);
		for (const cd of rd.cells) {
			const parts = [];
			if (cd.char) parts.push(`char: ${JSON.stringify(cd.char.target)}→${JSON.stringify(cd.char.runtime)}`);
			if (cd.fg) parts.push(`fg: ${cd.fg.target}→${cd.fg.runtime}`);
			if (cd.bg) parts.push(`bg: ${cd.bg.target}→${cd.bg.runtime}`);
			lines.push(`    col ${String(cd.col).padStart(3)}: ${parts.join("  ")}`);
		}
		lines.push("");
	}

	if (diff.rowDiffs.length > 30) {
		lines.push(`  ... and ${diff.rowDiffs.length - 30} more rows`);
	}

	return lines.join("\n");
}
