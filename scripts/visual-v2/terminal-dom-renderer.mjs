import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { bibleFontPath, bibleTokensCss, outDir, runcatFontPath } from "./paths.mjs";
import { writeFile } from "./fs-utils.mjs";

export async function renderTerminalSnapshot(snapshot, outputPng, options = {}) {
	const htmlPath = outputPng.replace(/\.png$/, ".html");
	const html = terminalSnapshotHtml(snapshot, options);
	writeFile(htmlPath, html);

	const chromiumExecutablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
	const browser = await chromium.launch({
		headless: true,
		...(chromiumExecutablePath ? { executablePath: chromiumExecutablePath } : {}),
	});
	try {
		const page = await browser.newPage({
			viewport: { width: 2200, height: 2200 },
			deviceScaleFactor: options.deviceScaleFactor ?? 2,
		});
	await page.goto(pathToFileURL(htmlPath).href, { waitUntil: "networkidle" });
		await page.evaluate(() => document.fonts.ready);
		await page.waitForTimeout(80);
		const rect = await page.$("[data-render-rect]");
		if (!rect) throw new Error("Rendered terminal page is missing [data-render-rect]");
		await rect.screenshot({ path: outputPng, omitBackground: false });
		const metrics = await page.evaluate(() => {
			const term = document.querySelector("[data-render-rect]");
			const probe = document.createElement("span");
			probe.textContent = "M";
			probe.style.position = "absolute";
			probe.style.visibility = "hidden";
			probe.style.font = getComputedStyle(term).font;
			document.body.appendChild(probe);
			const probeRect = probe.getBoundingClientRect();
			const termRect = term.getBoundingClientRect();
			probe.remove();
			return {
				cellWidthPx: probeRect.width,
				cellHeightPx: Number.parseFloat(getComputedStyle(term).getPropertyValue("--cell-h")),
				termWidthPx: termRect.width,
				termHeightPx: termRect.height,
			};
		});
		return { pngPath: outputPng, htmlPath, metrics };
	} finally {
		await browser.close();
	}
}

export function terminalSnapshotHtml(snapshot, options = {}) {
	const tokens = readFileSync(bibleTokensCss, "utf8");
	const fontUrl = pathToFileURL(bibleFontPath).href;
	const runcatFontUrl = pathToFileURL(runcatFontPath).href;
	const glyphBaselineShiftPx = Number(options.glyphBaselineShiftPx ?? 0);
	const rows = snapshot.cells.map((row) => `<div class="row" style="background:${rowBackground(row)}">${renderRow(row)}</div>`).join("\n");
	return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Visual V2 terminal render</title>
<style>
${tokens}
@font-face {
  font-family: 'JetBrains Mono';
  font-style: normal;
  font-weight: 400;
  font-display: block;
  src: url('${fontUrl}') format('woff2');
}
@font-face {
  font-family: 'RunCat';
  font-style: normal;
  font-weight: 400;
  font-display: block;
  src: url('${runcatFontUrl}') format('truetype');
  unicode-range: U+E900-E904;
}
.term {
  font-family: 'RunCat', 'JetBrains Mono', ui-monospace, Menlo, monospace;
}
html, body { min-height: 100%; }
.stage { min-height: auto; align-items: flex-start; justify-content: flex-start; padding: 0; }
.v2-cell-run {
  display: inline-block;
  height: var(--cell-h);
  line-height: var(--cell-h);
  white-space: pre;
  vertical-align: top;
  transform: translateY(${glyphBaselineShiftPx}px);
  /* Force exact cell-count width so narrow glyphs (e.g. NARROW NO-BREAK
     SPACE used by sidebar tracked() headers) cannot collapse a run
     below its terminal cell footprint. */
  text-align: left;
  letter-spacing: 0;
  flex-shrink: 0;
}
</style>
</head>
<body>
<div class="stage">
  <div data-render-rect class="term" style="--term-cols: ${snapshot.cols}; --term-rows: ${snapshot.rows};">
${rows}
  </div>
</div>
</body>
</html>`;
}

function rowBackground(row) {
	return row[0]?.bg ?? "#1A1511";
}

function renderRow(row) {
	let html = "";
	let run = [];
	let style = null;
	function flush() {
		if (run.length === 0) return;
		const widthCss = `width: ${run.length}ch; min-width: ${run.length}ch`;
		html += `<span class="v2-cell-run" style="${styleToCss(style)};${widthCss}">${escapeHtml(run.join(""))}</span>`;
		run = [];
	}
	for (const cell of row) {
		if (cell.width === 0 || cell.char === "") continue;
		const nextStyle = styleKey(cell);
		if (style !== null && nextStyle !== style) flush();
		style = nextStyle;
		run.push(cell.char || " ");
	}
	flush();
	return html;
}

function styleKey(cell) {
	return JSON.stringify({ fg: cell.fg, bg: cell.bg, bold: cell.bold, dim: cell.dim, italic: cell.italic, underline: cell.underline, inverse: cell.inverse });
}

function styleToCss(styleJson) {
	const style = JSON.parse(styleJson);
	let fg = style.fg;
	let bg = style.bg;
	if (style.inverse) [fg, bg] = [bg, fg];
	const declarations = [`color: ${fg}`, `background: ${bg}`];
	if (style.bold) declarations.push("font-weight: 700");
	if (style.italic) declarations.push("font-style: italic");
	if (style.underline) declarations.push("text-decoration: underline");
	if (style.dim) declarations.push("opacity: 0.72");
	return declarations.join(";");
}

function escapeHtml(value) {
	return String(value)
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");
}
