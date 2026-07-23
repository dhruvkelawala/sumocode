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

const DEFAULT_FG = "#F5E6C8";
const DEFAULT_BG = "#1A1511";

const CSS_VAR_DEFAULTS = {
	"--background": DEFAULT_BG,
	"--surface": "#241D17",
	"--surface-recess": "#120D0A",
	"--surface-lifted": "#3D3024",
	"--divider": "#5A4D3C",
	"--foreground": DEFAULT_FG,
	"--foreground-dim": "#8B7A63",
	"--accent": "#D97706",
	"--state-idle": "#7FB069",
	"--state-thinking": "#E8B339",
	"--state-tool": "#5B9BD5",
	"--state-approval": "#C1443E",
	"--state-learning": "#8E7AB5",
	"--syntax-keyword": "#D97706",
	"--syntax-string": "#7FB069",
	"--syntax-number": "#E8B339",
	"--syntax-comment": "#6F5D46",
	"--syntax-function": "#E8B339",
	"--tool-ledger-surface": "#120D0A",
	"--tool-ledger-border": "#5A4D3C",
	"--tool-ledger-label": "#D97706",
	"--tool-ledger-target": DEFAULT_FG,
	"--tool-ledger-body": DEFAULT_FG,
	"--tool-ledger-muted": "#8B7A63",
	"--code-surface": "#120D0A",
	"--code-border": "#5A4D3C",
	"--code-foreground": DEFAULT_FG,
	"--code-gutter": "#8B7A63",
	"--code-comment": "#6F5D46",
	"--code-keyword": "#D97706",
	"--code-string": "#7FB069",
	"--code-number": "#E8B339",
	"--code-function": "#E8B339",
};

let activeCssVars = { ...CSS_VAR_DEFAULTS };

/** Bible CSS class → CSS variable token (or direct runtime-equivalent hex). */
const FG_CLASS_MAP = {
	"fg-accent": "--accent",
	"fg-fg": "--foreground",
	"fg-dim": "--foreground-dim",
	"fg-divider": "--divider",
	"fg-comment": "--syntax-comment",
	"fg-idle": "--state-idle",
	"fg-think": "--state-thinking",
	"fg-tool": "--state-tool",
	"fg-approve": "--state-approval",
	"fg-learn": "--state-learning",
	"fg-string": "--syntax-string",
	"fg-number": "--syntax-number",
	"fg-keyword": "--syntax-keyword",
	"fg-fn": "--syntax-function",
	"fg-tool-border": "--tool-ledger-border",
	"fg-tool-label": "--tool-ledger-label",
	"fg-tool-target": "--tool-ledger-target",
	"fg-tool-body": "--tool-ledger-body",
	"fg-tool-muted": "--tool-ledger-muted",
	"fg-code-border": "--code-border",
	"fg-code": "--code-foreground",
	"fg-code-gutter": "--code-gutter",
	"fg-code-comment": "--code-comment",
	"fg-code-keyword": "--code-keyword",
	"fg-code-string": "--code-string",
	"fg-code-number": "--code-number",
	"fg-code-function": "--code-function",
};

const BG_CLASS_MAP = {
	"bg-recess": "--surface-recess",
	"bg-surface": "#1E1914",  // --surface is #241D17 in tokens.css but sidebar uses #1E1914
	"bg-lifted": "--surface-lifted",
};

function extractCssVars(html) {
	const vars = { ...CSS_VAR_DEFAULTS };
	for (const match of html.matchAll(/(--[a-zA-Z0-9-]+)\s*:\s*(#[0-9a-fA-F]{6})/g)) {
		vars[match[1]] = match[2];
	}
	return vars;
}

function resolveCssVar(name) {
	const value = activeCssVars[name] ?? CSS_VAR_DEFAULTS[name];
	// Cathedral's Bible `--state-idle` is intentionally not the runtime token;
	// keep that legacy equivalence, but honor explicit per-theme overrides.
	if (name === "--state-idle" && value?.toLowerCase() === CSS_VAR_DEFAULTS["--state-idle"].toLowerCase()) return "#22C55E";
	return value ?? null;
}

function resolveToken(value) {
	if (!value) return null;
	if (value.startsWith("--")) return resolveCssVar(value);
	return value;
}

function resolveClassColor(map, cls) {
	return resolveToken(map[cls]);
}

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

function colorFromStyle(style) {
	const varMatch = style.match(/(?:^|;)\s*color:\s*var\((--[a-zA-Z0-9-]+)\)/);
	if (varMatch) return resolveCssVar(varMatch[1]);
	const hexMatch = style.match(/(?:^|;)\s*color:\s*(#[0-9a-fA-F]{6})/);
	if (hexMatch) return hexMatch[1];
	return null;
}

function bgFromStyle(style) {
	const varMatch = style.match(/background:\s*var\((--[a-zA-Z0-9-]+)\)/);
	if (varMatch) return resolveCssVar(varMatch[1]);
	const hexMatch = style.match(/background:\s*(#[0-9a-fA-F]{6})/);
	if (hexMatch) return hexMatch[1];
	return null;
}

function parentBgFromAttrs(attrs) {
	if (/\bbg-recess\b/.test(attrs)) return resolveCssVar("--surface-recess");
	if (/\bbg-surface\b/.test(attrs)) return resolveCssVar("--surface");
	if (/\bbg-lifted\b/.test(attrs)) return resolveCssVar("--surface-lifted");
	return bgFromStyle(attrs) ?? resolveCssVar("--background") ?? DEFAULT_BG;
}

/**
 * Parse a single Bible HTML line (contents of a <pre class="grid">)
 * into an array of StyledCells.
 */
function parseBibleLine(html, parentBg = resolveCssVar("--background") ?? DEFAULT_BG) {
	const cells = [];
	let fg = resolveCssVar("--foreground") ?? DEFAULT_FG;
	let bg = parentBg;
	let bold = false;
	let dim = false;
	const fgStack = [fg];
	const bgStack = [bg];
	const boldStack = [false];
	const dimStack = [false];

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
				const fgColor = resolveClassColor(FG_CLASS_MAP, cls);
				const bgColor = resolveClassColor(BG_CLASS_MAP, cls);
				if (fgColor) newFg = fgColor;
				if (bgColor) newBg = bgColor;
				if (cls === "box-fill") newBg = bgFromStyle(style) ?? resolveCssVar("--surface-recess") ?? "#120D0A";
				if (cls === "cursor") { newBg = resolveCssVar("--accent") ?? "#D97706"; newFg = resolveCssVar("--background") ?? DEFAULT_BG; }
			}
			newFg = colorFromStyle(style) ?? newFg;
			newBg = bgFromStyle(style) ?? newBg;
			if (/font-weight:\s*(?:700|bold)/.test(style)) newBold = true;
			const newDim = /opacity:\s*0?\.(?:[0-8]\d*)/.test(style) ? true : dim;
			if (style.includes("background: var(--accent)")) newBg = resolveCssVar("--accent") ?? "#D97706";
			if (style.includes("color: var(--background)")) newFg = resolveCssVar("--background") ?? DEFAULT_BG;
			fgStack.push(newFg);
			bgStack.push(newBg);
			boldStack.push(newBold);
			dimStack.push(newDim);
			fg = newFg;
			bg = newBg;
			bold = newBold;
			dim = newDim;
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
			dimStack.pop();
			fg = fgStack[fgStack.length - 1] ?? DEFAULT_FG;
			bg = bgStack[bgStack.length - 1] ?? parentBg;
			bold = boldStack[boldStack.length - 1] ?? false;
			dim = dimStack[dimStack.length - 1] ?? false;
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
	const fg = resolveCssVar("--foreground") ?? DEFAULT_FG;
	const bg = resolveCssVar("--background") ?? DEFAULT_BG;
	for (let row = 0; row < rows; row++) {
		grid.push(Array.from({ length: cols }, () => ({ char: " ", fg, bg, bold: false, dim: false })));
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

function sceneGridRowStarts(rows) {
	const middleRows = rows - 11;
	return new Map([
		[1, 0],
		[2, 1],
		[3, 2],
		[4, 3],
		[5, 3 + middleRows],
		[6, 4 + middleRows],
		[7, 7 + middleRows],
		[8, 8 + middleRows],
		[9, 9 + middleRows],
		[10, 10 + middleRows],
	]);
}

function parseMiddleColumns(html, cols) {
	const match = html.match(/grid-template-columns:\s*([^;]+);/);
	const widths = match ? [...match[1].matchAll(/(\d+)ch/g)].map((entry) => Number(entry[1])) : [];
	const chatCols = widths[0] ?? cols;
	const gutterCols = widths[1] ?? 0;
	const sidebarCols = widths[2] ?? 0;
	return {
		chatCols,
		sidebarStart: sidebarCols > 0 ? chatCols + gutterCols : null,
	};
}

function writeCellsClipped(target, startRow, startCol, sourceRows, maxRows) {
	writeCells(target, startRow, startCol, sourceRows.slice(0, Math.max(0, maxRows)));
}

function parseSceneGrid(html, cols, rows) {
	const grid = emptyStyledGrid(cols, rows);
	const rowStarts = sceneGridRowStarts(rows);
	const middleRows = rows - 11;
	const { sidebarStart } = parseMiddleColumns(html, cols);

	const chatMatch = html.match(/<div class="chat-col">([\s\S]*?)<\/div>\s*<div class="gutter-col">/);
	if (chatMatch) {
		let row = rowStarts.get(4) ?? 3;
		const maxRow = row + middleRows;
		for (const match of chatMatch[1].matchAll(PRE_GRID_PATTERN)) {
			if (row >= maxRow) break;
			const parsed = parseGridContent(match[2], parentBgFromAttrs(match[1] ?? ""));
			writeCellsClipped(grid, row, 0, parsed, maxRow - row);
			row += parsed.length;
		}
	}

	const sidebarMatch = html.match(/<div class="sidebar-col">([\s\S]*?)<\/div>/);
	if (sidebarMatch && sidebarStart !== null) {
		const sidebarRows = extractPreGridRows(sidebarMatch[1], resolveCssVar("--background") ?? DEFAULT_BG);
		writeCellsClipped(grid, rowStarts.get(4) ?? 3, sidebarStart, sidebarRows, middleRows);
	}

	for (const match of html.matchAll(PRE_GRID_PATTERN)) {
		const attrs = match[1] ?? "";
		const gridRow = attrs.match(/grid-row:\s*(\d+)/)?.[1];
		if (!gridRow) continue;
		const startRow = rowStarts.get(Number(gridRow));
		if (startRow === undefined) continue;
		writeCells(grid, startRow, 0, parseGridContent(match[2], parentBgFromAttrs(attrs)));
	}

	return { cols, rows, grid };
}

function parseScenePaletteOverlayGrid(html, cols, rows) {
	const grid = emptyStyledGrid(cols, rows);
	const gridRowStarts = sceneGridRowStarts(rows);

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
		const sidebarRows = extractPreGridRows(sidebarMatch[1], resolveCssVar("--background") ?? DEFAULT_BG);
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
	activeCssVars = extractCssVars(html);

	const colsMatch = html.match(/--term-cols:\s*(\d+)/);
	const rowsMatch = html.match(/--term-rows:\s*(\d+)/);
	const cols = colsMatch ? parseInt(colsMatch[1], 10) : 160;
	const rows = rowsMatch ? parseInt(rowsMatch[1], 10) : 45;

	if (html.includes('class="modal-overlay"')) {
		return parseScenePaletteOverlayGrid(html, cols, rows);
	}

	if (/\bclass="[^"]*\bterm\b[^"]*\bscene\b/.test(html) && html.includes('class="middle"')) {
		return parseSceneGrid(html, cols, rows);
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
			row.push(srcRow[c] ?? { char: " ", fg: resolveCssVar("--foreground") ?? DEFAULT_FG, bg: resolveCssVar("--background") ?? DEFAULT_BG, bold: false, dim: false });
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
			outRow.push(srcRow[crop.x + col] ?? { char: " ", fg: resolveCssVar("--foreground") ?? DEFAULT_FG, bg: resolveCssVar("--background") ?? DEFAULT_BG, bold: false, dim: false });
		}
		grid.push(outRow);
	}
	return { cols: crop.cols, rows: crop.rows, grid };
}

// ── Diff ──────────────────────────────────────────────────────────

/**
 * A narrow, declared region of the grid where target/runtime cells are known
 * to legitimately differ for a mechanical (non-content) reason — e.g. a
 * random session id, a live timestamp, a blink-phase cursor cell, or a
 * capture-environment-dependent segment. Regions are rectangular (row/col
 * ranges, inclusive) and MUST supply `targetPattern`/`runtimePattern` regexes
 * that the target/runtime cell TEXT for the affected row (within the region's
 * column span) must match. This is the over-masking guard: a region only
 * suppresses a diff when the surrounding text still looks like the expected
 * shape, so an unrelated content change landing in the same rectangle still
 * fails instead of being silently swallowed.
 *
 * @typedef {object} EquivalentRegion
 * @property {[number, number]} rows inclusive [lo, hi] row range
 * @property {[number, number]} cols inclusive [lo, hi] col range
 * @property {RegExp} [targetPattern] must match the target row's text (full row) for the region to apply
 * @property {RegExp} [runtimePattern] must match the runtime row's text (full row) for the region to apply
 * @property {string} reason human-readable justification
 */

function cellInRegion(region, row, col) {
	return row >= region.rows[0] && row <= region.rows[1] && col >= region.cols[0] && col <= region.cols[1];
}

function regionApplies(region, targetRowText, runtimeRowText) {
	if (region.targetPattern && !region.targetPattern.test(targetRowText)) return false;
	if (region.runtimePattern && !region.runtimePattern.test(runtimeRowText)) return false;
	return true;
}

function findApplicableRegion(regions, row, col, targetRowText, runtimeRowText) {
	for (const region of regions) {
		if (!cellInRegion(region, row, col)) continue;
		if (regionApplies(region, targetRowText, runtimeRowText)) return region;
	}
	return null;
}

/**
 * Diff two styled cell grids. Returns per-row diffs with cell-level detail.
 */
export function diffStyledGrids(target, runtime, options = {}) {
	const ignoreColors = options.ignoreColors ?? false;
	const equivalentRegions = options.equivalentRegions ?? [];
	const rows = Math.max(target.grid.length, runtime.grid.length);
	const cols = Math.max(target.cols, runtime.cols);
	const rowDiffs = [];
	const suppressedByRegion = new Map();

	for (let r = 0; r < rows; r++) {
		const tRow = target.grid[r] ?? [];
		const rRow = runtime.grid[r] ?? [];
		const cellDiffs = [];
		const targetRowText = tRow.map((c) => c.char).join("");
		const runtimeRowText = rRow.map((c) => c.char).join("");

		for (let c = 0; c < cols; c++) {
			const t = tRow[c] ?? { char: " ", fg: DEFAULT_FG, bg: DEFAULT_BG };
			const rc = rRow[c] ?? { char: " ", fg: DEFAULT_FG, bg: DEFAULT_BG };

			const charMatch = t.char === rc.char;
			const fgMatch = ignoreColors || colorsEquivalent(t.fg, rc.fg);
			const bgMatch = ignoreColors || colorsEquivalent(t.bg, rc.bg);

			if (!charMatch || !fgMatch || !bgMatch) {
				const region = equivalentRegions.length > 0
					? findApplicableRegion(equivalentRegions, r, c, targetRowText, runtimeRowText)
					: null;
				if (region) {
					const key = region.reason;
					suppressedByRegion.set(key, (suppressedByRegion.get(key) ?? 0) + 1);
					continue;
				}
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
	return {
		passed,
		rowDiffs,
		totalRows: rows,
		totalCols: cols,
		suppressed: [...suppressedByRegion.entries()].map(([reason, count]) => ({ reason, count })),
	};
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

	if (diff.suppressed && diff.suppressed.length > 0) {
		lines.push("Suppressed by declared equivalence (narrow, pattern-guarded):");
		for (const s of diff.suppressed) {
			lines.push(`  - ${s.reason}: ${s.count} cell(s)`);
		}
		lines.push("");
	}

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
